import crypto from "node:crypto";
import { TIERS, getDoc } from "./store.js";
import { OBSIDIAN } from "./obsidian.js";
import { POINTS, logJudgment, openGates } from "./eval.js";
import { DEFAULT_MODEL, redactClip, summarizerFromEnv } from "./summarize.js";
import { redact } from "./redact.js";

/**
 * judge(point, input) → { score 0..1, label, reason }. score = confidence that the point's question is yes:
 *   triage   {text}: is this slice worth a summary?  labels keep | skip
 *   conflict {a, b}: do these two notes contradict?   labels contradict | consistent
 *   kind     {text}: is the note's kind (tag) right?  labels episodic | semantic | procedural
 * A judge only ranks, tags or flags (Principle 8); callers never delete or overwrite on its word.
 */

// triage skips below this; conflict flags at or above it
const CUT = 0.5;
export const HEURISTIC = "heuristic";
export const CLAUDE = "claude";

const clamp01 = (n) => Math.min(1, Math.max(0, n));
const words = (s) => s.toLowerCase().match(/[a-z][a-z0-9_]{3,}/g) ?? [];
const STOP = new Set("that this with from have will were been into when then than they them what which there their about would could should also just more some only does done make made like using used need needs".split(" "));

function triageHeuristic({ text }) {
  const agentTurns = (text.match(/^Agent: /gm) ?? []).length;
  const paths = new Set(text.match(/(?:\/|\.\/)?[\w.-]+\/[\w./-]*\.\w{1,5}\b/g) ?? []).size;
  const signal = (text.match(/\b(decid\w*|because|root cause|fix(?:ed)?|bug|error|implement\w*|plan|should|instead|migrat\w*|deploy\w*)\b/gi) ?? []).length;
  const score = clamp01(Math.min(text.length / 4000, 1) * 0.4 + (agentTurns >= 2 ? 0.2 : 0) + (paths >= 2 ? 0.2 : 0) + (signal >= 3 ? 0.2 : 0));
  return { score, label: score < CUT ? "skip" : "keep", reason: `${text.length} chars, ${agentTurns} agent turns, ${paths} paths, ${signal} signal words` };
}

const NEG = /\b(not|no longer|never|don't|doesn't|didn't|isn't|aren't|cannot|can't|without)\b/i;
const OPPOSITE = [["enable", "disable"], ["add", "remove"], ["use", "avoid"], ["increase", "decrease"], ["true", "false"], ["allow", "forbid"], ["keep", "drop"], ["sync", "async"]];

/** Content words of a bullet, as a set. */
const bag = (line) => new Set(words(line).filter((w) => !STOP.has(w)));

function opposed(a, b) {
  const la = a.toLowerCase();
  const lb = b.toLowerCase();
  return OPPOSITE.some(([x, y]) => (la.includes(x) && lb.includes(y) && !la.includes(y) && !lb.includes(x)) || (la.includes(y) && lb.includes(x) && !la.includes(x) && !lb.includes(y)));
}

function conflictHeuristic({ a, b }) {
  const bullets = (t) => t.split("\n").map((l) => l.replace(/^\s*[-*]\s*/, "").trim()).filter((l) => l.length > 20 && !l.startsWith("#"));
  let best = 0;
  let why = "no shared claim";
  for (const x of bullets(a)) {
    const bx = bag(x);
    for (const y of bullets(b)) {
      const by = bag(y);
      const shared = [...bx].filter((w) => by.has(w)).length;
      const overlap = shared / Math.max(1, Math.min(bx.size, by.size));
      if (shared < 4 || overlap < 0.5) continue;
      const flips = NEG.test(x) !== NEG.test(y) || opposed(x, y);
      if (flips && 0.5 + overlap / 2 > best) {
        best = 0.5 + overlap / 2;
        why = `"${x.slice(0, 80)}" vs "${y.slice(0, 80)}"`;
      }
    }
  }
  return best ? { score: clamp01(best), label: "contradict", reason: why } : { score: 0.1, label: "consistent", reason: why };
}

/** Procedural = steps or commands; semantic = facts without work done; else episodic. Confidence is the margin. */
function kindHeuristic({ text }) {
  const steps = (text.match(/^\s*(?:\d+[.)]|step \d)/gim) ?? []).length + (text.match(/`[^`\n]+`/g) ?? []).length / 3;
  const sections = Object.fromEntries([...text.matchAll(/^## (\w+)[^\n]*\n((?:- [^\n]*\n?)*)/gm)].map((m) => [m[1], m[2].split("\n").filter(Boolean).length]));
  const knowledge = sections.KNOWLEDGE ?? 0;
  const work = (sections.DECISIONS ?? 0) + (sections.FILES ?? 0) + (sections.OPEN ?? 0);
  if (steps >= 3) return { score: clamp01(0.5 + steps / 20), label: "procedural", reason: `${steps.toFixed(1)} step or command marks` };
  if (knowledge >= 2 && knowledge > work * 2) return { score: clamp01(0.5 + (knowledge - work) / 20), label: "semantic", reason: `${knowledge} knowledge bullets, ${work} others` };
  return { score: clamp01(0.5 + Math.min(work, 10) / 20), label: "episodic", reason: `${work} decision, file or open bullets` };
}

export const heuristicJudge = (point, input) => ({ triage: triageHeuristic, conflict: conflictHeuristic, kind: kindHeuristic })[point](input);

const REPLY = 'Reply with one JSON object and nothing else: {"score": <0..1>, "label": "<label>", "reason": "<one short sentence>"}.';
const PROMPTS = {
  triage: `You decide whether a slice of a coding-agent session is worth a written note in the user's knowledge base. score = probability that it holds a decision, a fact or a file change worth keeping. ${REPLY} label is "keep" or "skip".`,
  conflict: `You compare two notes from the user's knowledge base. score = probability that they contradict each other on the same subject (different topics do not contradict). ${REPLY} label is "contradict" or "consistent".`,
  kind: `You classify a note: "episodic" = what happened in one session, "semantic" = a lasting fact, "procedural" = steps to do something. score = your confidence in the label. ${REPLY} label is one of: episodic, semantic, procedural.`,
};
const modelText = (point, input) => redactClip(point === "conflict" ? `Note A:\n${input.a}\n\n---\n\nNote B:\n${input.b}` : input.text);

/** Parses a model reply into a judgment; throws on anything else, so a bad reply is never logged. */
export function parseJudgment(point, raw) {
  const m = /\{[\s\S]*\}/.exec(raw);
  let j;
  try {
    j = JSON.parse(m?.[0]);
  } catch {
    throw new Error(`judge reply is not JSON: ${String(raw).slice(0, 80)}`);
  }
  if (typeof j.score !== "number" || !Number.isFinite(j.score) || j.score < 0 || j.score > 1) throw new Error("judge score is not in 0..1");
  const reason = typeof j.reason === "string" ? redact(j.reason).text.slice(0, 200) : ""; // redact whole: a cut token escapes the rules
  if (point === "kind") {
    if (!TIERS.includes(j.label)) throw new Error(`judge label is not a kind: ${j.label}`);
    return { score: j.score, label: j.label, reason };
  }
  const [yes, no] = point === "triage" ? ["keep", "skip"] : ["contradict", "consistent"];
  return { score: j.score, label: j.score >= CUT ? yes : no, reason };
}

/** Backend `claude`: the summarizer's transport (claude CLI or API, same opt-in env), a judge prompt, redacted input. */
export function claudeJudge(env = process.env, call = {}) {
  return async (point, input) => {
    call[point] ??= summarizerFromEnv(env, PROMPTS[point]);
    return parseJudgment(point, await call[point](modelText(point, input)));
  };
}

/**
 * The config AGENT_KB_JUDGE turns on (`triage,conflict,kind` or `all`); null when unset. Every enabled point
 * logs its judgments; it acts only while its (point, backend) passes the AUC gate. A typo, `jev`, or `claude`
 * without AGENT_KB_SUMMARIZER throws. AGENT_KB_JUDGE_BACKEND = heuristic (default) | claude, logged as `claude:<model>`.
 */
export function judgeConfig(env = process.env) {
  const spec = env.AGENT_KB_JUDGE?.trim();
  if (!spec) return null;
  const points = spec === "all" ? POINTS : spec.split(",").map((p) => p.trim());
  const bad = points.find((p) => !POINTS.includes(p));
  if (bad) throw new Error(`unknown judge point "${bad}"; use ${POINTS.join(", ")} or all`);
  let backend = env.AGENT_KB_JUDGE_BACKEND || HEURISTIC;
  let judge;
  if (backend === HEURISTIC) judge = async (point, input) => heuristicJudge(point, input);
  else if (backend === CLAUDE) {
    if (!["claude", "api"].includes(env.AGENT_KB_SUMMARIZER)) throw new Error("AGENT_KB_JUDGE_BACKEND=claude needs AGENT_KB_SUMMARIZER=claude or =api");
    judge = claudeJudge(env);
    backend = `${CLAUDE}:${env.AGENT_KB_MODEL || DEFAULT_MODEL}`; // gates calibrate per model: another model's labels do not open them
  } else if (backend === "jev") throw new Error("the jev judge backend is not available: no jev endpoint is configured");
  else throw new Error(`unknown judge backend "${backend}"; use heuristic or claude`);
  return { points: new Set(points), backend, judge };
}

/** `judgeConfig` bound to a store; null when AGENT_KB_JUDGE is unset. */
export function judgesFromEnv(db, env = process.env) {
  const c = judgeConfig(env);
  return c && new Judges(db, c.points, c.backend, c.judge);
}

export class Judges {
  constructor(db, points, backend, judge) {
    Object.assign(this, { db, points, backend, judge, errors: 0, lastError: null });
    this.refresh();
  }

  /** Re-reads the gates; a long-lived server calls this before each use. */
  refresh() {
    this.gates = openGates(this.db, this.backend);
  }

  has(point) {
    return this.points.has(point);
  }

  /** True when `point` may change behaviour: enabled and its gate is open. */
  acts(point) {
    return this.points.has(point) && this.gates.has(point);
  }

  /** A judgment, or null when the judge failed: callers then do what they do with judging off. */
  async run(point, input) {
    try {
      return await this.judge(point, input);
    } catch (e) {
      this.errors++;
      this.lastError = String(e?.message ?? e).slice(0, 200);
      return null;
    }
  }

  log(point, docs, j, extra = {}) {
    return logJudgment(this.db, { point, docs, backend: this.backend, ...j, ...extra });
  }
}

// summaries and saved chat notes; never a vault file (`#wip.md`): its text is not sent to a model
const NOTE = `(d.source_type != '${OBSIDIAN}' AND (d.source_path LIKE '%#w%' OR d.source_path LIKE '%#saved' OR d.source_path LIKE 'kb-save:%'))`;
const NEIGHBOURS = 3;

/**
 * Flags notes that contradict the note at `docPath`: compares it with its top FTS neighbours and logs
 * a `contradict` judgment for each pair flagged. Flag only: nothing is changed or removed.
 */
export async function scanConflicts(db, judges, docPath) {
  if (!judges?.has("conflict")) return 0;
  const doc = getDoc(db, docPath);
  if (!doc) return 0;
  const counts = new Map();
  for (const w of words(`${doc.title ?? ""} ${doc.content}`)) if (!STOP.has(w)) counts.set(w, (counts.get(w) ?? 0) + 1);
  const terms = [...counts].sort((a, b) => b[1] - a[1] || b[0].length - a[0].length).slice(0, 8).map(([w]) => `"${w}"`);
  if (!terms.length) return 0;
  const others = db
    .prepare(
      `SELECT d.source_path, d.content FROM chunks_fts JOIN documents d ON d.id = chunks_fts.rowid
       WHERE chunks_fts MATCH ? AND d.source_path != ? AND ${NOTE}
       ORDER BY bm25(chunks_fts) LIMIT ?`,
    )
    .all(terms.join(" OR "), docPath, NEIGHBOURS);
  // keyed by the texts judged, not by time: a rewrite is judged again, a title-only save is not; older flags stay as history
  const seen = db.prepare("SELECT 1 FROM judgments WHERE point = 'conflict' AND backend = ? AND docs = ? AND docs_hash = ?");
  let flagged = 0;
  for (const o of others) {
    const pair = [docPath, o.source_path].sort();
    const texts = pair[0] === docPath ? [doc.content, o.content] : [o.content, doc.content];
    const docsHash = crypto.createHash("sha256").update(JSON.stringify(texts)).digest("hex");
    if (seen.get(judges.backend, JSON.stringify(pair), docsHash)) continue;
    const j = await judges.run("conflict", { a: doc.content, b: o.content });
    if (j?.label !== "contradict") continue;
    judges.log("conflict", pair, j, { docsHash });
    flagged++;
  }
  return flagged;
}

/** Tags `note` with a kind: returns the tier to store (the tag only when the kind gate is open) and the judgment to log. */
export async function tagKind(judges, note) {
  if (!judges?.has("kind")) return { tier: "episodic", judgment: null };
  const j = await judges.run("kind", { text: note });
  return { tier: j && judges.acts("kind") ? j.label : "episodic", judgment: j };
}
