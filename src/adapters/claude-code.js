import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

export const SOURCE_TYPE = "claude-code";

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
  for (const dir of dirs) {
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
  let carry = Buffer.alloc(0);
  try {
    const block = Buffer.alloc(1 << 20);
    while (!full) {
      const n = fs.readSync(fd, block, 0, block.length, pos + carry.length);
      if (n === 0) break;
      let buf = Buffer.concat([carry, block.subarray(0, n)]);
      let nl;
      while (!full && (nl = buf.indexOf(10)) >= 0) {
        let rec = null;
        try {
          rec = JSON.parse(buf.subarray(0, nl).toString("utf8"));
        } catch {}
        if (rec && typeof rec === "object") {
          const u = promptText(rec);
          const a = replyText(rec);
          const len = (u?.length ?? 0) + (a?.length ?? 0);
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
        buf = buf.subarray(nl + 1);
        pos += nl + 1;
      }
      carry = Buffer.from(buf);
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

const shellQuote = (s) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replaceAll("'", "'\\''")}'`);

/** `cd <cwd> && claude --resume <id>`, with CLAUDE_CONFIG_DIR when the session lives outside ~/.claude. */
export function resumeCmd(session, configDir, home = os.homedir()) {
  const env = path.resolve(configDir) === path.resolve(home, ".claude") ? "" : `CLAUDE_CONFIG_DIR=${shellQuote(configDir)} `;
  const cd = session.cwd ? `cd ${shellQuote(session.cwd)} && ` : "";
  return `${cd}${env}claude --resume ${shellQuote(session.sessionId)}`;
}
