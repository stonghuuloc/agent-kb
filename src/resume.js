import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getDoc } from "./store.js";
import { redact } from "./redact.js";
import { search } from "./search.js";
import { clip } from "./text.js";
import { resumeHint } from "./format.js";
import { COWORK, TRANSCRIPT_TYPES, shellQuote } from "./adapters/claude-code.js";

const NOTES_MAX = 16_000;
const CONTEXT_MAX = 2_000;
const CONTEXT_DOCS = 5;

const base = (sourcePath) => sourcePath.replace(/#w\d+$/, "");
const red = (t) => redact(t).text;
const day = (ts) => new Date(ts).toISOString().slice(0, 10);
const isUrl = (cmd) => /^https:\/\//.test(cmd);

// One shellQuote() word: bare, or single-quoted with '\'' for a quote.
// no backslash inside quotes: fish reads \' there as an escape, POSIX shells do not
const WORD = String.raw`(?:[\w@%+=:,./-]+|'(?:[^'\\]|'\\'')*')`;
const RESUME = new RegExp(String.raw`^((?:cd (${WORD}) && )?(?:CLAUDE_CONFIG_DIR=${WORD} )?)claude --resume ${WORD}$`);
const unquote = (w) => (w.startsWith("'") ? w.slice(1, -1).replaceAll("'\\''", "'") : w);

/** `cd <cwd> && [CLAUDE_CONFIG_DIR=… ]claude --resume <id>` → its cwd and the prefix before `claude`; null for anything else. */
export function parseResume(cmd) {
  const m = typeof cmd === "string" && RESUME.exec(cmd);
  return m ? { prefix: m[1], cwd: m[2] ? unquote(m[2]) : null } : null;
}

// strict shape only: shell integration evals what this returns
const runnable = (h) => !h.transcript_gone && parseResume(h.resume_cmd) !== null;

/**
 * Best match that a shell can resume: `{ hit, cmd }`. When none of the hits is resumable, `{ hit, why }`
 * says what to do with the top hit instead; `null` when nothing matches.
 */
export function findResume(db, query, now = Date.now()) {
  const hits = search(db, query, {}, now);
  if (!hits.length) return null;
  const hit = hits.find(runnable);
  if (hit) return { hit, cmd: hit.resume_cmd };
  const top = hits[0];
  const why = top.transcript_gone
    ? `${resumeHint(top)}; \`agent-kb fork\` starts a new session from its notes`
    : isUrl(top.resume_cmd)
      ? `open it in the browser: ${top.resume_cmd}`
      : top.source_type === COWORK
        ? resumeHint(top)
        : `no session to resume; \`agent-kb get ${top.source_path}\` shows the note`;
  return { hit: top, why };
}

export const describeHit = (h) => `${h.title ?? h.source_path} (${day(h.ts)})\n   path: ${h.source_path}`;

/** The doc a hit belongs to and its summary slices (`#wN`, in order). */
function session(db, hit) {
  const doc = getDoc(db, base(hit.source_path)) ?? getDoc(db, hit.source_path);
  const prefix = `${doc.source_path}#w`;
  const slices = db
    .prepare("SELECT source_path, content, event_ts FROM documents WHERE substr(source_path, 1, length(?)) = ?")
    .all(prefix, prefix)
    .map((r) => ({ ...r, n: Number(r.source_path.slice(prefix.length)) }))
    .filter((r) => Number.isInteger(r.n))
    .sort((a, b) => a.n - b.n);
  return { doc, slices };
}

/** Handoff prompt for a new session: the doc's notes, where its transcript is, and a re-check warning. Titles and notes are redacted; paths are left whole. */
export function handoffPrompt(db, hit) {
  const { doc, slices } = session(db, hit);
  const cwd = parseResume(doc.resume_cmd)?.cwd;
  const transcript = TRANSCRIPT_TYPES.includes(doc.source_type);
  const lines = [
    "Continue from a past session. Re-check live state before acting: files, branches, tickets and running services may have changed since these notes were written. Treat the notes as history, not as current truth.",
    "",
    `Session: ${red(doc.title ?? doc.source_path)} (${day(doc.event_ts ?? doc.indexed_ts)}, ${doc.source_type})`,
  ];
  if (cwd) lines.push(`Folder: ${cwd}`);
  if (transcript) lines.push(`Transcript: ${doc.source_path}${doc.transcript_gone ? " (deleted by the host app)" : ""}`);
  else lines.push(`Source: ${doc.resume_cmd ?? doc.source_path}`);
  const notes = slices.length
    ? `Summary notes:\n\n${slices.map((s) => `### Part ${s.n} (${day(s.event_ts)})\n${s.content}`).join("\n\n")}`
    : transcript
      ? `No summary yet. The user's own prompts in that session:\n\n${doc.content}`
      : `Notes:\n\n${doc.content}`;
  lines.push("", red(clip(notes, NOTES_MAX)));
  return lines.join("\n");
}

/**
 * `--to claude`: writes the prompt to a private temp file and returns a command that starts `claude`
 * in the session's folder (and config dir) with it. The printed command holds the file path, not the prompt.
 */
export function forkCommand(db, hit, prompt, tmp = os.tmpdir()) {
  const { doc } = session(db, hit);
  const dir = fs.mkdtempSync(path.join(tmp, "agent-kb-fork-"));
  const file = path.join(dir, "handoff.md");
  fs.writeFileSync(file, prompt, { mode: 0o600 });
  const prefix = parseResume(doc.resume_cmd)?.prefix ?? "";
  return { file, cmd: `${prefix}claude "$(cat ${shellQuote(file)})"` };
}

/** First line worth showing: no markup, no section headings or bullets. */
function oneLine(text) {
  for (const raw of text.split("\n")) {
    if (/^\s*#/.test(raw) || /^\s*[A-Z][A-Z /]*:?\s*$/.test(raw)) continue;
    const l = raw.replace(/<[^>]+>/g, " ").replace(/^\s*([-*]|\d+\.)\s+/, "").replace(/\s+/g, " ").trim();
    if (l) return l.length > 140 ? `${l.slice(0, 139)}…` : l;
  }
  return "";
}

/** Claude Code's folder name for a cwd under `<config>/projects/`. */
export const projectDir = (cwd) => cwd.replace(/[^a-zA-Z0-9]/g, "-");

/**
 * SessionStart context: the latest sessions recorded for this folder (newest summary line each),
 * title + one line + doc path, at most 2K chars. `transcript` (the current session) is left out.
 */
export function sessionContext(db, { cwd, transcript }) {
  const parent = typeof transcript === "string" ? path.basename(path.dirname(transcript)) : null;
  const dir = parent && path.basename(path.dirname(path.dirname(transcript))) === "projects" ? parent : cwd ? projectDir(cwd) : null;
  if (!dir) return "";
  const rows = db
    .prepare(
      `SELECT source_path, title, substr(content, 1, 2000) AS head, coalesce(event_ts, indexed_ts) AS ts
       FROM documents WHERE instr(source_path, ?) > 0 ORDER BY ts DESC LIMIT 500`,
    )
    .all(`${path.sep}projects${path.sep}${dir}${path.sep}`);
  const sessions = new Map();
  for (const r of rows) {
    const b = base(r.source_path);
    if (b === transcript) continue;
    const s = sessions.get(b) ?? { path: b, ts: r.ts, line: "" };
    if (r.source_path === b) s.title = r.title;
    if (!s.line || (r.source_path !== b && !s.summary)) {
      const line = oneLine(r.head);
      if (line) Object.assign(s, { line, summary: r.source_path !== b });
    }
    sessions.set(b, s);
  }
  const head = "agent-kb: recent sessions in this folder. Notes are history: re-check live state before relying on them. Full notes: kb_get <path>.";
  let out = head;
  let n = 0;
  for (const s of sessions.values()) {
    if (n === CONTEXT_DOCS) break;
    const entry = `\n- ${red(s.title ?? path.basename(s.path))} (${day(s.ts)})${s.line ? `: ${red(s.line)}` : ""}\n  ${s.path}`;
    if (out.length + entry.length > CONTEXT_MAX) break;
    out += entry;
    n++;
  }
  return n ? out : "";
}
