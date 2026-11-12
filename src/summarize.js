import { spawn } from "node:child_process";
import Anthropic from "@anthropic-ai/sdk";
import { redact } from "./redact.js";
import { clip } from "./text.js";

export const DEFAULT_MODEL = "claude-haiku-5-5";
export const NOTHING = "NOTHING";
const MAX_INPUT_CHARS = 60_000;

export const SYSTEM = `You write a short note about one slice of a coding-agent session, for the user's own knowledge base.
Use only these sections, each a "## " heading followed by "- " bullets. Leave out a section with nothing in it.
## DECISIONS: choices made, and why
## KNOWLEDGE: facts learned that will matter again
## FILES: paths created or changed, one per bullet
## OPEN: what is unfinished or still unclear
At most 15 bullets in total. No preamble, no closing line.
If the slice holds nothing worth keeping, reply with exactly: ${NOTHING}`;

/**
 * The model input for a slice: the conversation as plain text, redacted before it is clipped
 * (a cut inside a secret would leave a fragment no rule recognises), then clipped head + tail.
 */
export function summaryInput(turns) {
  const text = turns.map((t) => `${t.role === "user" ? "User" : "Agent"}: ${t.text}`).join("\n\n");
  return clip(redact(text).text, MAX_INPUT_CHARS);
}

/**
 * Backend: the user's own `claude` CLI (their subscription or key). Runs with no tools, no MCP
 * servers, no user settings or hooks, and no session file, so a summary never becomes a transcript.
 */
export function claudeCli({ model = DEFAULT_MODEL, bin = process.env.AGENT_KB_CLAUDE_BIN || "claude", timeoutMs = 300_000 } = {}) {
  const args = [
    "-p", "--model", model, "--output-format", "json", "--no-session-persistence",
    "--tools", "", "--strict-mcp-config", "--setting-sources", "", "--system-prompt", SYSTEM,
  ];
  return (input) =>
    new Promise((resolve, reject) => {
      const child = spawn(bin, args, { stdio: ["pipe", "pipe", "pipe"] });
      // own timer: spawn's `timeout` option is never cleared when the spawn fails, which pins the process
      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        setTimeout(() => child.kill("SIGKILL"), 5000).unref(); // a CLI that ignores SIGTERM
        child.stdout.destroy(); // a grandchild can hold the pipes open past the kill
        child.stderr.destroy();
        reject(new Error(`claude timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      let out = "";
      let err = "";
      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", (d) => (err += d));
      child.stdin.on("error", () => {}); // a CLI that exits early closes stdin; `close` reports why
      child.on("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
      child.on("close", (code, signal) => {
        clearTimeout(timer);
        let r;
        try {
          r = JSON.parse(out);
        } catch {
          return reject(new Error(`claude exited ${code ?? signal}: ${err.trim().slice(0, 200)}`));
        }
        if (r?.is_error || r?.subtype !== "success" || typeof r.result !== "string") {
          return reject(new Error(`claude: ${r?.subtype ?? "no result"} ${String(r?.result ?? "").slice(0, 200)}`));
        }
        resolve(r.result);
      });
      child.stdin.end(input);
    });
}

/** Backend: the Anthropic API with the user's key (ANTHROPIC_API_KEY or an `ant auth login` profile). */
export function anthropicApi({ model = DEFAULT_MODEL, client } = {}) {
  return async (input) => {
    client ??= new Anthropic({ timeout: 120_000, maxRetries: 2 }); // ends inside the sweep lock's TTL
    const res = await client.messages.create({
      model,
      max_tokens: 8000,
      system: SYSTEM,
      output_config: { effort: "low" },
      messages: [{ role: "user", content: input }],
    });
    if (res.stop_reason === "refusal") throw new Error(`refused (${res.stop_details?.category ?? "no category"})`);
    return res.content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
  };
}

/** AGENT_KB_SUMMARIZER = claude | api; unset or anything else = no model calls. AGENT_KB_MODEL overrides the model. */
export function summarizerFromEnv(env = process.env) {
  const model = env.AGENT_KB_MODEL || DEFAULT_MODEL;
  if (env.AGENT_KB_SUMMARIZER === "claude") return claudeCli({ model });
  if (env.AGENT_KB_SUMMARIZER === "api") return anthropicApi({ model });
  return null;
}
