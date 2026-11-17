import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Distil logged friction into proposed behavioural rules — the `learn` loop the current kb runs as
 * `kb-learn-distill.py`. It writes a managed block in a **staging** file, never into `CLAUDE.md`: the rules
 * loaded every session are hand-curated, and a model's rewrite of them is a change to the user's
 * instructions, not a note.
 */

export const MARKER_START = "<!-- learn:proposed:start -->";
export const MARKER_END = "<!-- learn:proposed:end -->";
const BLOCK = new RegExp(`${MARKER_START}[\\s\\S]*?${MARKER_END}`, "g");
const MIN_ITEMS = 3; // fewer than this is not a pattern
const CAP = 12;

export const PROMPT = `You maintain a short list of PROPOSED behavioral rules for a coding agent, distilled from logged friction (mistakes the agent made in past sessions).

The input has two parts:
  EXISTING RULES — the current proposed list (may be empty).
  NEW FRICTION — recent friction bullets, each cause-tagged [agent] [tool] [process] [knowledge].

Produce a REFINED, DEDUPED list of behavioral rules:
- Focus on [agent] mistakes — recurring ones or high-impact ones. Ignore pure [tool] noise unless it implies an agent behavior change.
- Merge near-duplicate mistakes into ONE rule. If an existing rule already covers a new mistake, keep the better-worded single version.
- Each rule = ONE line, imperative, starting with a bold **trigger** (the situation), then the action. Example: \`- **Before writing any fetcher** check libs/api for an existing one first.\`
- Drop one-off mistakes unlikely to recur. Cap at ${CAP} rules. Order by recurrence/impact.
- Output ONLY the markdown bullet list (\`- \` lines). No preamble, no closing remark.
If there is nothing worth proposing, output exactly: NONE`;

export const proposalsPath = (env = process.env, home = os.homedir()) => env.AGENT_KB_PROPOSALS || path.join(home, ".claude", "learned-proposals.md");

const HEADER = `# Learned proposals

Behavioral rules distilled from logged friction. Review them, promote the good ones into
\`CLAUDE.md\` by hand, then delete them here. Nothing in this file is loaded by an agent.

`;

/** The rules currently inside the managed block, or "". */
export function readProposals(file) {
  try {
    const m = new RegExp(`${MARKER_START}([\\s\\S]*?)${MARKER_END}`).exec(fs.readFileSync(file, "utf8"));
    return m ? m[1].replace(/^_updated .*$/m, "").trim() : "";
  } catch {
    return "";
  }
}

/** Replaces the block, or appends one; the rest of the file is untouched. */
export function writeProposals(file, rules, { items, sessions, day = new Date().toISOString().slice(0, 10) }) {
  const note = `_updated ${day} — distilled from ${items} friction items across ${sessions} sessions_`;
  const block = `${MARKER_START}\n${note}\n\n${rules.trim()}\n${MARKER_END}`;
  const current = readIfPresent(file);
  const text = current === null ? `${HEADER}${block}\n` : new RegExp(BLOCK).test(current) ? current.replace(new RegExp(BLOCK), block) : `${current.replace(/\s*$/, "")}\n\n${block}\n`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

/** The file's text, or null when there is no file: one read, nothing to race with. */
function readIfPresent(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
}

/** Friction bullets and the sessions they came from, newest first. */
export function frictionItems(db, { sinceDays = 30, max = 200, now = Date.now() } = {}) {
  const rows = db
    .prepare("SELECT source_path, content FROM documents WHERE source_type = 'session_friction' ORDER BY coalesce(event_ts, indexed_ts) DESC LIMIT ?")
    .all(max);
  const cutoff = now - sinceDays * 86_400_000;
  const out = [];
  const sessions = new Set();
  for (const r of rows) {
    const ts = db.prepare("SELECT coalesce(event_ts, indexed_ts) AS ts FROM documents WHERE source_path = ?").get(r.source_path)?.ts;
    if (ts && ts < cutoff) continue;
    for (const line of String(r.content ?? "").split("\n")) {
      const b = line.replace(/^- /, "").trim();
      if (!b) continue;
      out.push(b);
      sessions.add(r.source_path.replace(/#journal-friction$/, ""));
    }
  }
  return { items: out, sessions: sessions.size };
}

/**
 * Runs the distill. Returns what it did: `no-model` (no summarizer configured), `too-few`, `none`, or the
 * number of rules written. Only a `- ` list is accepted; anything else is dropped rather than written.
 */
export async function distillFriction(db, { summarize = null, file = proposalsPath(), env = process.env, sinceDays = 30, now = Date.now() } = {}) {
  if (!summarize) return { status: "no-model" };
  if (env.AGENT_KB_DISTILL === "off") return { status: "off" };
  const { items, sessions } = frictionItems(db, { sinceDays, now });
  if (items.length < MIN_ITEMS) return { status: "too-few", items: items.length };
  const existing = readProposals(file);
  const input = `EXISTING RULES\n${existing || "(none)"}\n\nNEW FRICTION\n${items.slice(0, 120).map((i) => `- ${i}`).join("\n")}`;
  const reply = String(await summarize(input)).trim();
  const rules = reply
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("- "))
    .slice(0, CAP)
    .join("\n");
  if (!rules) return { status: "none", items: items.length };
  writeProposals(file, rules, { items: items.length, sessions, day: new Date(now).toISOString().slice(0, 10) });
  return { status: "written", rules: rules.split("\n").length, items: items.length, sessions, file };
}
