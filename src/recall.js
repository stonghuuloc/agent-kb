import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fold } from "./store.js";
import { search } from "./search.js";
import { cwdOfResume } from "./adapters/claude-code.js";

/**
 * Push recall for a prompt: what the current kb's `user-prompt-kb-inject.py` does. The user's own prompt
 * becomes a search — a hit the agent would otherwise have pulled has to be walked to, so it is put in
 * front of it at the decision moment. Read-only, no model call, never throws: a hook must not break a prompt.
 */

export const DEFAULTS = {
  limit: 2,
  maxChars: 2500,
  maxQueryTokens: 8,
  minCoverage: 2,
  // Volume alone would win the two slots: a 5k-page wiki is rarely what a prompt is about. Explicit
  // `agent-kb search` still sees everything.
  excludeTypes: ["confluence_page"],
};

const STOP = new Set(
  ("the a an and or of to in on at for from by with without into over under is are was were be been being it its " +
    "this that these those i you he she we they me my your our their as if then than so such but not no do does did " +
    "have has had can could should would will shall may might must about above after again all also any because " +
    "before both each few more most other same some than too very just now here there when where how why what which " +
    "who whom while up down out off again please help need want show tell give let us ok okay yes thanks thank")
    .split(" "),
);

/** Prompt text → search terms: lowercase words of 3+ chars, stopwords dropped, deduped, at most `max`. */
export function promptTerms(prompt, max = DEFAULTS.maxQueryTokens) {
  const out = [];
  for (const raw of String(prompt ?? "").toLowerCase().split(/[^\p{L}\p{N}_-]+/u)) {
    const t = raw.replace(/^-+|-+$/g, "");
    if (t.length < 3 || STOP.has(t) || out.includes(t)) continue;
    out.push(t);
    if (out.length >= max) break;
  }
  return out;
}

/** Canonical project key for a cwd: the folder name, folded through the alias table when there is one. */
export function projectKey(cwd, aliases = readAliases()) {
  if (!cwd) return "";
  const base = path.basename(String(cwd)).toLowerCase();
  return (aliases[base] ?? base).toLowerCase();
}

/** `~/.claude/kb/project-aliases.json` (alias → canonical), the table the current kb folds projects with. */
export function readAliases(file = path.join(os.homedir(), ".claude", "kb", "project-aliases.json")) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    const out = {};
    for (const [k, v] of Object.entries(raw)) {
      if (typeof v !== "string" || k.startsWith("_")) continue;
      out[k.toLowerCase()] = v.toLowerCase();
    }
    return out;
  } catch {
    return {};
  }
}

/** The stored text of the given docs, so coverage is measured on the note, not on the snippet. */
function contents(db, paths) {
  const out = new Map();
  if (!paths.length) return out;
  const rows = db
    .prepare(`SELECT source_path, content FROM documents WHERE source_path IN (${paths.map(() => "?").join(", ")})`)
    .all(...paths);
  for (const r of rows) out.set(r.source_path, r.content);
  return out;
}

/** Distinct prompt terms the hit's own text holds — a one-word coincidence is not a match. */
const coverage = (hit, terms) => {
  const text = fold(`${hit.title ?? ""} ${hit.content ?? ""}`);
  return terms.filter((t) => text.includes(fold(t))).length;
};

/**
 * The context block for a prompt, or "" when the prompt is too thin or nothing matches. Hits from the
 * session's own project outrank the rest, and another project's notes are dropped outright: an
 * injection that silently hands over someone else's memory is worse than none.
 */
export function promptRecall(db, prompt, { cwd = "", env = process.env, aliases = readAliases(), now = Date.now() } = {}) {
  const asked = Number(env.AGENT_KB_PROMPT_LIMIT);
  const o = { ...DEFAULTS, ...(Number.isInteger(asked) && asked > 0 ? { limit: asked } : {}) };
  if (env.AGENT_KB_PROMPT === "off") return "";
  const terms = promptTerms(prompt, o.maxQueryTokens);
  if (terms.length < 2) return ""; // "yes please" is not a question worth two slots
  const excluded = new Set(
    (env.AGENT_KB_PROMPT_EXCLUDE_TYPES ?? o.excludeTypes.join(",")).split(",").map((t) => t.trim()).filter(Boolean),
  );
  let hits;
  try {
    hits = search(db, terms.join(" "), { limit: 20, perTypeCap: 1, anyTerm: true }, now);
  } catch {
    return "";
  }
  const mine = projectKey(cwd, aliases);
  const texts = contents(db, hits.map((h) => h.source_path));
  const kept = [];
  const perType = new Map();
  for (const h of hits) {
    if (excluded.has(h.source_type)) continue;
    // one slot per type: two notes of the same kind spend both slots on the same thing. search() back-fills
    // past its cap, so the cap has to hold here too.
    if ((perType.get(h.source_type) ?? 0) >= 1) continue;
    perType.set(h.source_type, (perType.get(h.source_type) ?? 0) + 1);
    if (terms.length >= 3 && coverage({ ...h, content: texts.get(h.source_path) }, terms) < o.minCoverage) continue;
    const theirs = projectKey(cwdOfResume(h.resume_cmd), aliases);
    if (mine && theirs && theirs !== mine) continue; // another project's memory
    kept.push({ h, own: mine && theirs === mine });
  }
  if (!kept.length) return "";
  kept.sort((a, b) => (b.own ? 1 : 0) - (a.own ? 1 : 0)); // own project first; the sort is stable, so score order holds inside each group
  const head = "agent-kb recall for this prompt. This is memory, not live state: confirm any id, scope, field or date against the source before relying on it.";
  let out = head;
  let n = 0;
  for (const { h } of kept) {
    const line = `\n- [${h.source_type}] ${h.title ?? h.source_path} (${h.source_path})\n  ${String(h.snippet ?? "").replace(/\s+/g, " ").slice(0, 400)}${h.conflict ? `\n  ⚠ ${h.conflict.status}: possibly superseded by ${h.conflict.title}` : ""}`;
    if (out.length + line.length > o.maxChars) break;
    out += line;
    if (++n >= o.limit) break;
  }
  return n ? out : "";
}
