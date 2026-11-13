import { spawn as nodeSpawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
