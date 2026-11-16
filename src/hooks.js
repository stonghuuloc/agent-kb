import { spawn as nodeSpawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { dataDir, dbPath } from "./paths.js";
import { openStore } from "./store.js";
import { sessionContext } from "./resume.js";
import { promptRecall } from "./recall.js";

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

/**
 * UserPromptSubmit hook: prompt-relevant recall as the JSON a host reads as additional context, or "" when
 * the prompt is thin or nothing matches. Off with AGENT_KB_PROMPT=off, idle inside our own summarizer call,
 * and no kb file means no output (the hook never creates one). Never throws.
 */
export function userPrompt(raw, { env = process.env, open = defaultOpen } = {}) {
  if (env.AGENT_KB_CHILD || env.AGENT_KB_PROMPT === "off") return "";
  let db;
  try {
    const input = JSON.parse(raw);
    const prompt = typeof input?.prompt === "string" ? input.prompt : "";
    if (!prompt.trim()) return "";
    const cwd = typeof input?.cwd === "string" && path.isAbsolute(input.cwd) ? input.cwd : "";
    db = open();
    const additionalContext = db && promptRecall(db, prompt, { cwd, env });
    return additionalContext ? JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext } }) : "";
  } catch {
    return "";
  } finally {
    try {
      db?.close();
    } catch {}
  }
}

const defaultOpen = () => (fs.existsSync(dbPath()) ? openStore(dbPath()) : null);

const SETUP_HINT =
  "agent-kb is installed but not set up yet: summaries are off, so no notes are written. " +
  "Tell the user once, in one sentence, to run /agent-kb:agent-kb-setup to choose summaries and an Obsidian vault.";

/**
 * One-time setup hint for the SessionStart hook: the text on the first session after install, then "" forever
 * (a marker file in the data dir records that it was shown). Silent when summaries are already on, with
 * AGENT_KB_CONTEXT=off, or inside our own summarizer call. Never throws.
 */
export function setupHint({ env = process.env, marker = path.join(dataDir(env), "setup-hint-shown") } = {}) {
  if (env.AGENT_KB_CHILD || env.AGENT_KB_CONTEXT === "off" || ["claude", "api"].includes(env.AGENT_KB_SUMMARIZER)) return "";
  try {
    fs.mkdirSync(path.dirname(marker), { recursive: true });
    // wx claims the marker in one step: the loser of a race gets EEXIST, not a second hint.
    fs.writeFileSync(marker, new Date().toISOString() + "\n", { flag: "wx" });
    return SETUP_HINT;
  } catch {
    return "";
  }
}

/** SessionStart output: recent-session context plus the one-time setup hint, as one additionalContext JSON, or "". */
export function sessionStartOutput(raw, opts = {}) {
  const base = sessionStart(raw, opts);
  const hint = setupHint(opts);
  if (!hint) return base;
  const out = base ? JSON.parse(base) : { hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: "" } };
  const h = out.hookSpecificOutput;
  h.additionalContext = h.additionalContext ? `${h.additionalContext}\n\n${hint}` : hint;
  return JSON.stringify(out);
}
