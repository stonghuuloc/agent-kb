import fs from "node:fs";
import path from "node:path";
import { upsertDoc } from "./store.js";
import { redact } from "./redact.js";
import { replaceIfUnchanged } from "./safe-write.js";

/**
 * The user's daily journal: the summarizer's DAILY/LEARNED/SEARCHED/FRICTION lines, appended under four
 * headings of `<vault>/daily/<today>.md`. Same shape the SessionEnd worker writes (headings, `[ticket]` /
 * `[agent]` prefixes, `[[TICKET]]` links, `tickets:` front matter, one dedupe marker per session), so both
 * writers can land in one note; a section already carrying this session's marker is left alone.
 */

/** Journal key → [heading it lands under, regex matching that heading line]. Order is the template's. */
const SECTIONS = {
  daily: ["## What I did", /^## What I did[^\n]*\n/m],
  learned: ["## What I learned / figured out", /^## What I learned[^\n]*\n/m],
  friction: ["## Friction — what slowed me down", /^## Friction[^\n]*\n/m],
  searched: ["## What I searched / asked for today", /^## What I searched[^\n]*\n/m],
};

/** Journal key → the doc type that keeps it searchable (the types the graph, distill and conflicts scan read). */
export const JOURNAL_DOCS = { learned: ["#journal-learned", "session_learning", "semantic"], friction: ["#journal-friction", "session_friction", "procedural"] };

const TEMPLATE = (day) =>
  `---\ndate: ${day}\nshape:\nenergy:\n---\n\n## What I did\n<!-- prefix each item: [ticket] [infra] [firefight] [learning] [meeting] -->\n\n` +
  `## What I learned / figured out\n\n## Friction — what slowed me down\n<!-- prefix with cause: [agent] [tool] [process] [knowledge] [other] -->\n\n## What I searched / asked for today\n\n`;

// Lookarounds keep an id already inside [[…]] or [text](link) from being linked twice.
const TICKET = /(?<!\[)\b([A-Z]{2,6}-\d{1,6})\b(?!\])/;
const TICKET_ANY = /\b([A-Z]{2,6}-\d{1,6})\b/;
const EMPTY = { daily: [], learned: [], friction: [], searched: [] };

/**
 * Splits a slice summary into the doc body and its journal entries. A DAILY line is one bullet; LEARNED,
 * SEARCHED and FRICTION split on ` ; `. `SKIP` and an empty body mean nothing to record.
 */
export function parseJournal(summary) {
  const entries = { daily: [], learned: [], friction: [], searched: [] };
  const kept = [];
  const source = String(summary ?? "");
  let stripped = false;
  for (const line of source.split("\n")) {
    const m = /^(DAILY|LEARNED|SEARCHED|FRICTION)\s*:\s*(.*)$/i.exec(line.trim());
    if (!m) {
      kept.push(line);
      continue;
    }
    stripped = true;
    const key = m[1].toLowerCase();
    const body = m[2].trim();
    if (!body || body.toUpperCase() === "SKIP") continue;
    if (key === "daily") entries.daily.push(body);
    else entries[key].push(...body.split(" ; ").map((p) => p.trim()).filter(Boolean));
  }
  // a summary with no journal lines is stored byte for byte: the doc keeps the model's own text
  return { text: stripped ? kept.join("\n").trim() + "\n" : source, entries };
}

export const hasEntries = (entries) => (entries ? Object.values(entries).some((v) => v?.length) : false);

/** Inserts bullets at the end of a heading's content; a missing heading is appended at the end of the note. */
function insertUnder(text, heading, headingRe, bullets) {
  const body = bullets.join("\n") + "\n";
  const m = headingRe.exec(text);
  if (!m) return text.replace(/\s*$/, "\n\n") + heading + "\n" + body + "\n";
  const start = m.index + m[0].length;
  const next = text.slice(start).search(/^## /m);
  const end = next === -1 ? text.length : start + next;
  const section = text.slice(start, end).replace(/\s*$/, "");
  return text.slice(0, start) + section + (section ? "\n" : "") + body + "\n" + text.slice(end).replace(/^\n+/, "");
}

/** Unions ticket ids into the note's `tickets:` line; only that line changes, every hand-edited field stays. */
function mergeTickets(text, ids) {
  if (!ids.length) return text;
  const m = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (!m) return text;
  let fm = m[1];
  const line = /^tickets:\s*\[(.*?)\]\s*$/m.exec(fm);
  if (line) {
    const have = line[1].split(",").map((t) => t.trim()).filter(Boolean);
    const merged = have.concat([...ids].filter((t) => !have.includes(t)).sort());
    fm = fm.slice(0, line.index) + `tickets: [${merged.join(", ")}]` + fm.slice(line.index + line[0].length);
  } else fm += `\ntickets: [${[...ids].sort().join(", ")}]`;
  return `---\n${fm}\n---\n` + text.slice(m[0].length);
}

/**
 * Appends one slice's entries to the daily note text. Returns the text plus the sections it changed;
 * an empty list means this session's slice is already in the note.
 */
export function mergeDaily(text, { entries, session, slice = 1, source = null }) {
  const marker = ` (auto-draft, session \`${session}\`${slice > 1 ? ` w${slice}` : ""})`;
  const tag = source ? ` %%agent-kb ${fullId(source)}%%` : "";
  let out = text;
  const appended = [];
  const bullets = [];
  for (const key of Object.keys(SECTIONS)) {
    const items = entries?.[key] ?? [];
    if (!items.length) continue;
    const [heading, re] = SECTIONS[key];
    bullets.push(...items);
    const m = re.exec(out);
    if (m) {
      const start = m.index + m[0].length;
      const next = out.slice(start).search(/^## /m);
      if (hasSlice(out.slice(start, next === -1 ? out.length : start + next), marker, tag)) continue;
    }
    out = insertUnder(out, heading, re, items.map((b) => `- ${b.replace(TICKET, "[[$1]]")}${marker}${tag}`));
    appended.push(key);
  }
  if (!appended.length) return { text: out, appended };
  const ids = [...new Set(bullets.flatMap((b) => [...b.matchAll(new RegExp(TICKET_ANY, "g"))].map((x) => x[1])))];
  return { text: mergeTickets(out, ids), appended };
}

/**
 * A section already holds this slice when a line carries its marker and either this session's full-id tag or
 * no tag at all (the SessionEnd worker and older lines write none, so they still dedupe on the marker). A line
 * tagged with another session's id is a different session that shares the 8-char marker.
 */
function hasSlice(section, marker, tag) {
  return section.split("\n").some((line) => {
    if (!line.includes(marker)) return false;
    const other = /%%agent-kb [^%\s]+%%/.exec(line);
    return !other || !tag || other[0] === tag.trim();
  });
}

/** The full transcript name, as an Obsidian comment-safe token. */
const fullId = (source) => path.basename(String(source)).replace(/\.[^.]+$/, "").replace(/[^\w.-]/g, "_");

/**
 * Appends a slice's entries to `<dir>/<day>.md`, creating it from the template first. Returns a status
 * string for the sweep log; a vault error is the caller's to report.
 */
export function writeDaily(dir, { day, entries, session, slice = 1, source = null }, seams = {}) {
  if (!hasEntries(entries)) return "no journal lines";
  entries = redactEntries(entries);
  const file = path.join(dir, `${day}.md`);
  fs.mkdirSync(dir, { recursive: true });
  let appended = [];
  // merged against the note as it is at the swap: a line the user saved meanwhile is kept, not overwritten
  const r = replaceIfUnchanged(
    file,
    (current) => {
      const m = mergeDaily(current ?? TEMPLATE(day), { entries, session, slice, source });
      appended = m.appended;
      return appended.length ? m.text : null;
    },
    seams,
  );
  if (r === "conflict") throw new Error(`${file} kept changing while being written; the entries are kept for the next sweep`);
  return appended.length ? `appended: ${appended.join(", ")}` : "already has this session";
}

/** Model output is redacted before it reaches a note or the pending queue; the user's own text is never touched. */
export function redactEntries(entries) {
  return Object.fromEntries(Object.entries(entries).map(([k, v]) => [k, v.map((line) => redact(line).text)]));
}

/**
 * Keeps learned facts and friction as their own docs (`<transcript>#journal-learned` / `#journal-friction`),
 * accumulating across slices so the graph, the distill run and the conflicts scan read one doc per session.
 */
export function journalDocs(db, base, entries, { title = base, resume_cmd = null, event_ts = null } = {}) {
  const written = [];
  for (const [key, [suffix, type, tier]] of Object.entries(JOURNAL_DOCS)) {
    const items = entries?.[key] ?? [];
    if (!items.length) continue;
    const source_path = `${base}${suffix}`;
    const have = (getContent(db, source_path) ?? "").split("\n").filter((l) => l.startsWith("- "));
    const fresh = items.filter((i) => !have.includes(`- ${i}`));
    if (!fresh.length) continue;
    const content = [...have, ...fresh.map((i) => `- ${i}`)].join("\n") + "\n";
    upsertDoc(db, { source_path, source_type: type, tier, title: `${title} — ${key}`, content, event_ts, resume_cmd });
    written.push(type);
  }
  return written;
}

const getContent = (db, sourcePath) => db.prepare("SELECT content FROM documents WHERE source_path = ?").get(sourcePath)?.content ?? null;

/** The 8-digit session marker the daily note and the logs use, from a transcript path. */
export const sessionId = (file) => path.basename(String(file)).replace(/\.[^.]+$/, "").slice(0, 8) || "unknown";

/** The daily note's day in local time, as the SessionEnd worker writes it. */
export const today = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
