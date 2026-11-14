import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

export const SOURCE_TYPE = "claude-code";
// every source type whose docs are transcripts in CLI format (sweeper, gone flags, alias folding)
export const COWORK = "claude-cowork";
export const TRANSCRIPT_TYPES = [SOURCE_TYPE, COWORK];

/** Config dirs to scan: AGENT_KB_CLAUDE_DIRS (path-list), else CLAUDE_CONFIG_DIR and ~/.claude. */
export function configDirs(env = process.env, home = os.homedir()) {
  const list = env.AGENT_KB_CLAUDE_DIRS ? env.AGENT_KB_CLAUDE_DIRS.split(path.delimiter) : [env.CLAUDE_CONFIG_DIR, path.join(home, ".claude")];
  const dirs = list.filter(Boolean).map((d) => path.resolve(d));
  return [...new Set(dirs)];
}

/**
 * Top-level session transcripts: <config>/projects/<project>/<session>.jsonl (subagent files excluded).
 * A dir that exists but cannot be read is listed as `{ file: dir, unreadable: true }` so it counts as failed.
 */
export function listTranscripts(dirs) {
  const out = [];
  for (const dir of uniqueProjects(dirs)) {
    const projects = path.join(dir, "projects");
    let entries;
    try {
      entries = fs.readdirSync(projects, { withFileTypes: true });
    } catch (e) {
      if (e.code !== "ENOENT") out.push({ file: projects, configDir: dir, unreadable: true });
      continue; // ENOENT: config dir without sessions
    }
    for (const p of entries) {
      if (!p.isDirectory()) continue;
      let files;
      try {
        files = fs.readdirSync(path.join(projects, p.name), { withFileTypes: true });
      } catch (e) {
        if (e.code !== "ENOENT") out.push({ file: path.join(projects, p.name), configDir: dir, unreadable: true });
        continue; // vanished mid-scan; the next run sees it
      }
      for (const f of files) {
        if (f.isFile() && f.name.endsWith(".jsonl")) out.push({ file: path.join(projects, p.name, f.name), configDir: dir });
      }
    }
  }
  return out;
}

/**
 * Config dirs whose `projects` folders are distinct on disk. A profile dir often links its `projects`
 * to ~/.claude/projects; listing both would index (and summarize) every session twice. Of two dirs
 * sharing one folder, the one that holds it for real wins, else the first.
 */
function uniqueProjects(dirs) {
  const byReal = new Map();
  for (const dir of dirs) {
    const projects = path.join(dir, "projects");
    let real;
    let linked;
    try {
      real = fs.realpathSync(projects);
      linked = real !== path.join(fs.realpathSync(dir), "projects");
    } catch {
      real = projects; // missing or unreadable: listed as is, and reported there
      linked = false;
    }
    const seen = byReal.get(real);
    if (!seen || (seen.linked && !linked)) byReal.set(real, { dir, linked });
  }
  return [...byReal.values()].map((v) => v.dir);
}

const NOISE = /<(system-reminder|local-command-stdout|local-command-stderr|command-message|task-notification|bash-stdout|bash-stderr)>[\s\S]*?<\/\1>/g;

/** Plain text a person typed: string content, or text blocks; never tool results or meta lines. */
function promptText(rec) {
  if (rec.type !== "user" || rec.isMeta || rec.isSidechain || rec.isCompactSummary) return null;
  const c = rec.message?.content;
  const text = typeof c === "string" ? c : Array.isArray(c) ? c.filter((b) => b?.type === "text").map((b) => b.text).join("\n") : "";
  const clean = text.replace(NOISE, "").replace(/<\/?command-(name|args)>/g, "").trim();
  return clean || null;
}

/** Text the agent wrote back: assistant text blocks only (no thinking, no tool calls). */
function replyText(rec) {
  if (rec.type !== "assistant" || rec.isSidechain) return null;
  const c = rec.message?.content;
  const text = Array.isArray(c) ? c.filter((b) => b?.type === "text" && typeof b.text === "string").map((b) => b.text).join("\n") : "";
  return text.trim() || null;
}

const TURN_OVERHEAD = 9; // "Agent: " + "\n\n"
// A record past this is a tool payload (an image, a file dump), never typed text: it is skipped, not held.
const MAX_RECORD_BYTES = 32 << 20;

/**
 * The conversation written since byte `start`: user prompts and agent replies, in order.
 * Reads whole lines only; a last line without its newline is left for the next read, so
 * `end` is always a line boundary. Reads in 1 MB blocks, so memory stays bounded by the text kept.
 * Stops before the line that would take a slice of at least `minChars` past `maxChars`; that line starts the next slice.
 */
export function readDelta(file, start = 0, maxChars = Infinity, minChars = 0) {
  const fd = fs.openSync(file, "r");
  const turns = [];
  let chars = 0;
  let full = false;
  let lastActivity = null;
  let pos = start;
  // A line longer than one block is kept as parts and joined once, so a huge record costs linear copying.
  let parts = [];
  let partsLen = 0;
  let skipping = false; // inside a record over MAX_RECORD_BYTES: count its bytes, keep none
  let readPos = start;
  try {
    const block = Buffer.alloc(1 << 20);
    while (!full) {
      const n = fs.readSync(fd, block, 0, block.length, readPos);
      if (n === 0) break;
      readPos += n;
      const chunk = block.subarray(0, n);
      let from = 0;
      let nl;
      while (!full && (nl = chunk.indexOf(10, from)) >= 0) {
        const piece = chunk.subarray(from, nl);
        const lineLen = partsLen + piece.length;
        const line = skipping ? null : parts.length ? Buffer.concat([...parts, piece]) : piece;
        parts = [];
        partsLen = 0;
        skipping = false;
        let rec = null;
        try {
          if (line) rec = JSON.parse(line.toString("utf8"));
        } catch {}
        if (rec && typeof rec === "object") {
          const u = promptText(rec);
          const a = replyText(rec);
          // the model input adds "User: " / "Agent: " and a blank line per turn; count them
          const len = (u ? u.length + TURN_OVERHEAD : 0) + (a ? a.length + TURN_OVERHEAD : 0);
          // a line that would overflow a slice of at least minChars starts the next one; else it joins and is clipped later
          if (turns.length && chars >= minChars && chars + len > maxChars) {
            full = true;
            break;
          }
          const ts = str(rec.timestamp) ? Date.parse(rec.timestamp) : NaN;
          if (Number.isFinite(ts)) lastActivity = Math.max(lastActivity ?? ts, ts);
          if (u) turns.push({ role: "user", text: u });
          if (a) turns.push({ role: "assistant", text: a });
          chars += len;
        }
        pos += lineLen + 1;
        from = nl + 1;
      }
      if (!full && from < n) {
        partsLen += n - from;
        if (partsLen > MAX_RECORD_BYTES) (skipping = true), (parts = []);
        else if (!skipping) parts.push(Buffer.from(chunk.subarray(from)));
      }
    }
  } finally {
    fs.closeSync(fd);
  }
  return { end: pos, turns, lastActivity };
}

/** Non-empty string, else null: fields of the wrong type are ignored. */
const str = (v) => (typeof v === "string" && v ? v : null);

/** Streams one transcript; returns session metadata and the user's prompts. Bad lines are skipped. */
export async function readSession(file) {
  const s = { sessionId: null, cwd: null, title: null, lastActivity: null, prompts: [] };
  const lines = readline.createInterface({ input: fs.createReadStream(file, "utf8"), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue; // a line being written right now
    }
    if (!rec || typeof rec !== "object") continue; // valid JSON, not a record (`null`, `3`)
    s.sessionId ??= str(rec.sessionId);
    s.cwd = str(rec.cwd) ?? s.cwd;
    if (rec.type === "ai-title") s.title = str(rec.aiTitle) ?? s.title;
    const ts = str(rec.timestamp) ? Date.parse(rec.timestamp) : NaN;
    if (Number.isFinite(ts)) s.lastActivity = Math.max(s.lastActivity ?? ts, ts);
    const p = promptText(rec);
    if (p) s.prompts.push(p);
  }
  s.sessionId ??= path.basename(file, ".jsonl");
  return s;
}

export const shellQuote = (s) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replaceAll("'", "'\\''")}'`);

/** The cwd a `resumeCmd` changes into; null without one. */
export function cwdOfResume(cmd) {
  const m = /^cd ('(?:[^']|'\\'')*'|[\w@%+=:,./-]+) && /.exec(cmd ?? "");
  if (!m) return null;
  return m[1].startsWith("'") ? m[1].slice(1, -1).replaceAll("'\\''", "'") : m[1];
}

/** `cd <cwd> && claude --resume <id>`, with CLAUDE_CONFIG_DIR when the session lives outside ~/.claude. */
export function resumeCmd(session, configDir, home = os.homedir()) {
  const env = path.resolve(configDir) === path.resolve(home, ".claude") ? "" : `CLAUDE_CONFIG_DIR=${shellQuote(configDir)} `;
  const cd = session.cwd ? `cd ${shellQuote(session.cwd)} && ` : "";
  return `${cd}${env}claude --resume ${shellQuote(session.sessionId)}`;
}
