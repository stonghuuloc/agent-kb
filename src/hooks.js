import { spawn as nodeSpawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { dbPath } from "./paths.js";
import { openStore } from "./store.js";
import { sessionContext } from "./resume.js";

const CLI = fileURLToPath(new URL("../bin/agent-kb.js", import.meta.url));

/**
 * SessionEnd hook: summarize the ended session now, in a detached `agent-kb sweep --ended`, so the
 * hook returns at once and the work outlives the host app. No-op when summaries are off, inside our
 * own summarizer call, with AGENT_KB_SWEEP=off, or on input without a transcript path. Never throws: a hook must not break a session.
 */
export function sessionEnd(raw, { env = process.env, spawn = nodeSpawn } = {}) {
  if (env.AGENT_KB_CHILD || env.AGENT_KB_SWEEP === "off" || !["claude", "api"].includes(env.AGENT_KB_SUMMARIZER)) return false;
  let file;
  try {
    file = JSON.parse(raw)?.transcript_path;
  } catch {
    return false;
  }
  if (typeof file !== "string" || !path.isAbsolute(file) || !file.endsWith(".jsonl")) return false;
  try {
    const child = spawn(process.execPath, [CLI, "sweep", "--ended", file], { detached: true, stdio: "ignore", windowsHide: true, env });
    child.on("error", () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}

/**
 * SessionStart hook: the JSON a host reads as additional context (recent sessions for the session's folder,
 * at most 2K chars), or "" for nothing. Off with AGENT_KB_CONTEXT=off, idle inside our own summarizer call,
 * and no kb file means no output (the hook never creates one). Never throws.
 */
export function sessionStart(raw, { env = process.env, open = defaultOpen } = {}) {
  if (env.AGENT_KB_CHILD || env.AGENT_KB_CONTEXT === "off") return "";
  let db;
  try {
    const input = JSON.parse(raw);
    const cwd = typeof input?.cwd === "string" && path.isAbsolute(input.cwd) ? input.cwd : null;
    const transcript = typeof input?.transcript_path === "string" ? input.transcript_path : null;
    if (!cwd && !transcript) return "";
    db = open();
    const additionalContext = db && sessionContext(db, { cwd, transcript });
    return additionalContext ? JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext } }) : "";
  } catch {
    return "";
  } finally {
    try {
      db?.close();
    } catch {}
  }
}

const defaultOpen = () => (fs.existsSync(dbPath()) ? openStore(dbPath()) : null);
