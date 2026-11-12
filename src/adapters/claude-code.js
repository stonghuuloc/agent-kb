import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

export const SOURCE_TYPE = "claude-code";

/** Config dirs to scan: AGENT_KB_CLAUDE_DIRS (path-list), else CLAUDE_CONFIG_DIR and ~/.claude. */
export function configDirs(env = process.env, home = os.homedir()) {
  if (env.AGENT_KB_CLAUDE_DIRS) return env.AGENT_KB_CLAUDE_DIRS.split(path.delimiter).filter(Boolean);
  const dirs = [env.CLAUDE_CONFIG_DIR, path.join(home, ".claude")].filter(Boolean).map((d) => path.resolve(d));
  return [...new Set(dirs)];
}

/** Top-level session transcripts: <config>/projects/<project>/<session>.jsonl (subagent files excluded). */
export function listTranscripts(dirs) {
  const out = [];
  for (const dir of dirs) {
    const projects = path.join(dir, "projects");
    let entries;
    try {
      entries = fs.readdirSync(projects, { withFileTypes: true });
    } catch {
      continue; // config dir without sessions
    }
    for (const p of entries) {
      if (!p.isDirectory()) continue;
      for (const f of fs.readdirSync(path.join(projects, p.name), { withFileTypes: true })) {
        if (f.isFile() && f.name.endsWith(".jsonl")) out.push({ file: path.join(projects, p.name, f.name), configDir: dir });
      }
    }
  }
  return out;
}

const NOISE = /<(system-reminder|local-command-stdout|local-command-stderr|command-message)>[\s\S]*?<\/\1>/g;

/** Plain text a person typed: string content, or text blocks; never tool results or meta lines. */
function promptText(rec) {
  if (rec.type !== "user" || rec.isMeta || rec.isSidechain) return null;
  const c = rec.message?.content;
  const text = typeof c === "string" ? c : Array.isArray(c) ? c.filter((b) => b?.type === "text").map((b) => b.text).join("\n") : "";
  const clean = text.replace(NOISE, "").replace(/<\/?command-(name|args)>/g, "").trim();
  return clean || null;
}

/** Streams one transcript; returns session metadata and the user's prompts. Bad lines are skipped. */
export async function readSession(file) {
  const s = { sessionId: null, cwd: null, gitBranch: null, title: null, started: null, lastActivity: null, prompts: [] };
  const lines = readline.createInterface({ input: fs.createReadStream(file, "utf8"), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue; // a line being written right now
    }
    s.sessionId ??= rec.sessionId ?? null;
    if (rec.cwd) s.cwd = rec.cwd;
    if (rec.gitBranch) s.gitBranch = rec.gitBranch;
    if (rec.type === "ai-title" && rec.aiTitle) s.title = rec.aiTitle;
    const ts = rec.timestamp ? Date.parse(rec.timestamp) : NaN;
    if (Number.isFinite(ts)) {
      s.started = Math.min(s.started ?? ts, ts); // sidechain lines can carry earlier times
      s.lastActivity = Math.max(s.lastActivity ?? ts, ts);
    }
    const p = promptText(rec);
    if (p) s.prompts.push(p);
  }
  s.sessionId ??= path.basename(file, ".jsonl");
  return s;
}

const shellQuote = (s) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replaceAll("'", "'\\''")}'`);

/** `cd <cwd> && claude --resume <id>`, with CLAUDE_CONFIG_DIR when the session lives outside ~/.claude. */
export function resumeCmd(session, configDir, home = os.homedir()) {
  const env = path.resolve(configDir) === path.join(home, ".claude") ? "" : `CLAUDE_CONFIG_DIR=${shellQuote(configDir)} `;
  const cd = session.cwd ? `cd ${shellQuote(session.cwd)} && ` : "";
  return `${cd}${env}claude --resume ${shellQuote(session.sessionId)}`;
}
