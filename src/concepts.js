import fs from "node:fs";
import path from "node:path";
import { queryGraph } from "./graph.js";
import { replaceIfUnchanged } from "./safe-write.js";

/**
 * Concept notes: one Markdown file per Jira ticket and per repo, rendered from the graph. The current kb
 * calls this `kb-concept-export.py`.
 *
 * The contract that makes it safe to regenerate: everything between the two `kb:generated` markers is a
 * render of the database and is rewritten freely; everything after the end marker is the user's own text
 * and is never touched. Only that human part is indexed back into the kb (S5 in `docs/PARITY.md`), so the
 * brain never learns its own output.
 */

export const GEN_START = "<!-- kb:generated:start — rebuilt from the graph on every export; edits here are lost -->";
export const GEN_END = "<!-- kb:generated:end -->";
export const HUMAN = "\n## Notes\n<!-- your notes — survive regeneration and get indexed back into kb -->\n";
const SAFE = /[^A-Za-z0-9._-]/g;
// A ticket needs to appear in something the user wrote to earn a note; a mention on a listing page is not work.
const AUTHORED = new Set(["session_learning", "session_friction", "claude-code", "claude-cowork", "claude-desktop-code", "memory"]);
const SNIPPET_TYPES = ["memory", "session_learning", "session_friction"];
const MAX_RELATED = 10;
const MAX_SNIPPETS = 5;

const safeName = (label) => label.replace(SAFE, "-").replace(/^-+|-+$/g, "") || "untitled";

/** The body rendered between the markers for one entity. */
export function renderBody(db, id) {
  const r = queryGraph(db, id, { docs: 0 });
  if (!r) return null;
  const names = (kind, max) => (r.neighbours[kind] ?? []).slice(0, max).map((n) => n.label);
  const lines = [];
  if (r.etype === "ticket") {
    const repos = names("repo", 5);
    const related = names("ticket", MAX_RELATED);
    const prs = names("pr", 10);
    const conf = names("confluence", 5);
    if (repos.length) lines.push(`**Repos:** ${repos.map((x) => `[[${x}]]`).join(", ")}`);
    if (related.length) lines.push(`**Related:** ${related.map((x) => `[[${x}]]`).join(", ")}`);
    if (prs.length) lines.push(`**PRs:** ${prs.map((x) => `\`${x}\``).join(", ")}`);
    if (conf.length) lines.push(`**Docs:** ${conf.join(", ")}`);
  } else {
    const tickets = names("ticket", 15);
    const prs = names("pr", 10);
    if (tickets.length) lines.push(`**Top tickets:** ${tickets.map((x) => `[[${x}]]`).join(", ")}`);
    if (prs.length) lines.push(`**PRs:** ${prs.map((x) => `\`${x}\``).join(", ")}`);
  }
  const snippets = knowledgeSnippets(db, r.label);
  if (snippets.length) lines.push("", "## Knowledge (from kb)", ...snippets);
  return lines.join("\n");
}

/** The authored notes that mention this entity, one line each. */
function knowledgeSnippets(db, label) {
  const marks = SNIPPET_TYPES.map(() => "?").join(", ");
  let rows;
  try {
    rows = db
      .prepare(
        `SELECT DISTINCT d.source_type, d.source_path, snippet(chunks_fts, 1, '', '', '…', 30) AS snip
         FROM chunks_fts JOIN documents d ON d.id = chunks_fts.rowid
         WHERE chunks_fts MATCH ? AND d.source_type IN (${marks})
         ORDER BY rank LIMIT ?`,
      )
      .all(`"${label.replaceAll('"', '""')}"`, ...SNIPPET_TYPES, MAX_SNIPPETS * 2);
  } catch {
    return [];
  }
  const out = [];
  for (const r of rows) {
    const clean = String(r.snip ?? "").replace(/\s+/g, " ").slice(0, 250);
    if (!clean) continue;
    out.push(`- [${r.source_type}] \`${path.basename(r.source_path)}\` — ${clean}`);
    if (out.length >= MAX_SNIPPETS) break;
  }
  return out;
}

/** Tickets that appear in something the user wrote, plus every repo. */
export function selectEntities(db) {
  const marks = [...AUTHORED].map(() => "?").join(", ");
  const tickets = db
    .prepare(
      `SELECT DISTINCT e.entity_id AS id FROM kb_doc_entities e JOIN documents d ON d.source_path = e.source_path
       WHERE e.entity_id LIKE 'ticket:%' AND d.source_type IN (${marks}) ORDER BY e.entity_id`,
    )
    .all(...AUTHORED);
  const repos = db.prepare("SELECT id FROM kb_entities WHERE etype = 'repo' ORDER BY id").all();
  return [...tickets, ...repos].map((r) => r.id);
}

/**
 * Writes or refreshes the notes. Returns counts; a note the user edited outside the generated region is
 * updated in place (their section is kept verbatim), and a note without markers is left alone rather than
 * guessed at.
 */
export function exportConcepts(db, vault, { only = null, dryRun = false } = {}) {
  const counts = { created: 0, updated: 0, unchanged: 0, skipped: 0, conflict: 0 };
  const ids = only ? [only] : selectEntities(db);
  for (const id of ids) {
    const body = renderBody(db, id);
    const label = id.slice(id.indexOf(":") + 1);
    const folder = id.startsWith("repo:") ? "repos" : "tickets";
    const file = path.join(vault, "concepts", folder, `${safeName(label)}.md`);
    if (body === null) {
      counts.skipped++;
      continue;
    }
    const generated = `${GEN_START}\n${body}\n${GEN_END}`;
    counts[writeNote(file, id, label, generated, dryRun)]++;
  }
  return counts;
}

/**
 * Insert or replace the generated region; `## Notes` and everything after the end marker stays. The splice
 * is redone against the note as it is at the swap, so a save the user made meanwhile is kept.
 */
export function writeNote(file, id, label, generated, dryRun, { beforeSwap = null, beforeRename = null } = {}) {
  let state = "unchanged";
  const splice = (current) => {
    if (current === null) {
      state = "created";
      return `---\nentity: ${id}\n---\n# ${label}\n\n${generated}\n${HUMAN}`;
    }
    const start = current.indexOf(GEN_START);
    const end = current.indexOf(GEN_END);
    if (start === -1 || end === -1) return (state = "skipped"), null; // markers gone: do not guess where the user's text starts
    if (current.slice(start, end + GEN_END.length) === generated) return (state = "unchanged"), null;
    state = "updated";
    return current.slice(0, start) + generated + current.slice(end + GEN_END.length);
  };
  if (dryRun) {
    let current = null;
    try {
      current = fs.readFileSync(file, "utf8");
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
    splice(current);
    return state;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  return replaceIfUnchanged(file, splice, { beforeSwap, beforeRename }) === "conflict" ? "conflict" : state;
}

/** The part of a concept note the kb may index: everything outside the generated region. */
export function humanPart(text) {
  const start = text.indexOf(GEN_START);
  const end = text.indexOf(GEN_END);
  if (start === -1 || end === -1) return text;
  return text.slice(0, start) + text.slice(end + GEN_END.length);
}
