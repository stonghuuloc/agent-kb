#!/usr/bin/env node
import path from "node:path";
import { dbPath } from "../src/paths.js";
import { getDoc, openStore, SchemaTooNewError, stats } from "../src/store.js";
import { search } from "../src/search.js";
import { formatHits } from "../src/format.js";
import { backfillTier0 } from "../src/backfill.js";
import { configDirs, listTranscripts } from "../src/adapters/claude-code.js";
import { SOURCES, allTranscripts, coworkTranscripts, desktopDir, desktopTitles, enabledSources } from "../src/adapters/claude-desktop.js";
import { dropAliases, summarizeIdle, sweepOnce } from "../src/sweep.js";
import { summarizerFromEnv } from "../src/summarize.js";
import { sessionEnd } from "../src/hooks.js";
import { importExport, readExport } from "../src/adapters/claude-chat.js";
import { HEURISTIC, Judges, judgeConfig } from "../src/judge.js";
import { POINTS, dismiss, evaluate, listJudgments, pin, setTruth } from "../src/eval.js";

const USAGE = `usage:
  agent-kb search <words…> [-n N]
  agent-kb get <path>
  agent-kb stats
  agent-kb sources
  agent-kb backfill
  agent-kb sweep [--ended <transcript>]
  agent-kb summarize [--since <N>d | --since all] [--limit N] [--yes]
  agent-kb import <member-manifest-*.json | conversations-NNN.zip | memories-NNN.zip | folder>
  agent-kb judgments [triage|conflict|kind] [--open] [-n N]
  agent-kb pin <transcript or slice path>
  agent-kb dismiss <conflict-id>
  agent-kb label <judgment-id> yes|no
  agent-kb eval

Sources are auto-detected; AGENT_KB_SOURCES=claude-code,claude-cowork (comma list) reads only those.
Summaries need AGENT_KB_SUMMARIZER=claude (your claude CLI) or =api (ANTHROPIC_API_KEY).
summarize shows an estimate; --yes runs it. --limit caps slices (up to 50K chars each); with AGENT_KB_JUDGE_BACKEND=claude each slice can add judge calls.
import reads a Claude data export (Settings → Privacy → Export data); re-running it adds only what changed.
Judging is off unless AGENT_KB_JUDGE=triage,conflict,kind (or all) is set; the backend is heuristic (no model) unless
AGENT_KB_JUDGE_BACKEND=claude (needs AGENT_KB_SUMMARIZER; gates are per model). A point only logs until its AUC on your corrections passes the gate (agent-kb eval).
label answers the question the judge asked: triage = was the slice worth a summary, conflict = do the notes contradict, kind = is the tag right.
pin = a skipped session was worth keeping; the next sweep summarizes the skipped slices. dismiss = the flagged notes do not contradict.
sweep --ended summarizes one ended session now, without the 20-minute idle wait (the SessionEnd hook).`;

const fail = () => {
  console.error(USAGE);
  process.exit(2);
};

/** `--since 30d` (default) or `--since all`, `--limit N`, `--yes`; null when malformed. */
function parseSummarize(a) {
  const o = { sinceDays: 30, limit: Infinity, yes: false };
  for (let i = 0; i < a.length; i++) {
    if (a[i] === "--yes") o.yes = true;
    else if (a[i] === "--since" && a[i + 1] === "all") (o.sinceDays = null), i++;
    else if (a[i] === "--since" && /^\d+d$/.test(a[i + 1] ?? "")) (o.sinceDays = parseInt(a[++i], 10));
    else if (a[i] === "--limit" && /^[1-9]\d*$/.test(a[i + 1] ?? "") && Number.isSafeInteger(Number(a[i + 1]))) o.limit = Number(a[++i]);
    else return null;
  }
  return o;
}

const [cmd, ...args] = process.argv.slice(2);
if (cmd === "hook") {
  // Hooks read the host's JSON on stdin and always exit 0: a hook must never break the session.
  let raw = "";
  try {
    for await (const c of process.stdin) raw += c;
    if (args[0] === "session-end") sessionEnd(raw);
  } catch {}
  process.exit(0);
}
let opts;
let limit;
if (cmd === "search") {
  const i = args.indexOf("-n");
  if (i >= 0) {
    limit = Number(args.splice(i, 2)[1]);
    if (!Number.isInteger(limit) || limit < 1) fail();
  }
  if (!args.length) fail();
} else if (cmd === "get") {
  if (args.length !== 1) fail();
} else if (cmd === "summarize") {
  opts = parseSummarize(args) ?? fail();
} else if (cmd === "import") {
  if (args.length !== 1) fail();
} else if (cmd === "judgments") {
  const a = [...args];
  const i = a.indexOf("-n");
  if (i >= 0) {
    limit = Number(a.splice(i, 2)[1]);
    if (!Number.isInteger(limit) || limit < 1) fail();
  }
  const o = a.indexOf("--open");
  if (o >= 0) (a.splice(o, 1), (opts = { open: true }));
  if (a.length > 1 || (a.length && !POINTS.includes(a[0]))) fail();
} else if (cmd === "pin" || cmd === "dismiss") {
  if (args.length !== 1) fail();
} else if (cmd === "label") {
  if (args.length !== 2 || !/^[1-9]\d*$/.test(args[0]) || !["yes", "no"].includes(args[1])) fail();
} else if (cmd === "sweep") {
  if (args.length && (args.length !== 2 || args[0] !== "--ended" || !args[1])) fail();
} else if (!["stats", "backfill", "sources", "eval"].includes(cmd) || args.length) fail();

// only the commands that read local sources check AGENT_KB_SOURCES; search and import do not need it
let sources;
if (["backfill", "sweep", "summarize", "sources"].includes(cmd)) {
  try {
    sources = enabledSources();
  } catch (e) {
    console.error(e.message);
    process.exit(2);
  }
}

let judgeCfg = null;
if (["sweep", "summarize"].includes(cmd)) {
  try {
    judgeCfg = judgeConfig();
  } catch (e) {
    console.error(e.message);
    process.exit(2);
  }
}

let db;
try {
  db = openStore(dbPath());
} catch (e) {
  if (!(e instanceof SchemaTooNewError)) throw e;
  console.error(e.message);
  process.exit(3);
}

if (cmd === "search") console.log(formatHits(search(db, args.join(" "), { limit })));
else if (cmd === "get") {
  const d = getDoc(db, args[0]);
  if (!d) {
    console.error(`No document at ${args[0]}`);
    process.exit(1);
  }
  console.log(d.content);
} else if (cmd === "backfill") {
  const dirs = configDirs();
  const transcripts = transcriptsFrom(dirs);
  dropAliases(db, transcripts);
  const c = await backfillTier0(db, transcripts);
  console.log(`${c.indexed} indexed, ${c.unchanged} unchanged, ${c.empty} empty, ${c.failed} failed (${[...dirs, desktopDir()].join(", ")})`);
  if (c.failed) process.exitCode = 1;
} else if (cmd === "sweep") {
  const ended = args[1] ? path.resolve(args[1]) : null;
  const judges = judgeCfg && new Judges(db, judgeCfg.points, judgeCfg.backend, judgeCfg.judge);
  const { t0, gone, s, pinned } = await sweepOnce(db, { summarize: summarizerFromEnv(), ended, sources, judges });
  console.log(`${t0.indexed} indexed, ${gone} transcripts gone` + (s ? `, ${formatSummary(s)}` : ", summaries off"));
  if (pinned?.summarized || pinned?.nothing || pinned?.lost || pinned?.failed)
    console.log(`pinned: ${pinned.summarized} summarized, ${pinned.nothing} with nothing to keep, ${pinned.lost} lost (transcript gone or changed), ${pinned.failed} failed` + (pinned.error ? ` (last error: ${pinned.error}; retried on a later sweep)` : ""));
  if (judges?.errors) console.log(`judge failures: ${judges.errors} (last error: ${judges.lastError}); those slices ran as if judging were off`);
  if (t0.failed || s?.failed || pinned?.failed) process.exitCode = 1;
} else if (cmd === "sources") {
  // What each source finds on this machine; reads names and titles only.
  const dirs = configDirs();
  const desktop = desktopDir();
  const found = {
    "claude-code": `${listTranscripts(dirs).filter((t) => !t.unreadable).length} transcripts in ${dirs.join(", ")}`,
    "claude-desktop-code": `${desktopTitles(desktop).size} titled Code-tab sessions in ${desktop}`,
    "claude-cowork": `${coworkTranscripts(desktop).length} sessions in ${desktop}`,
  };
  for (const s of SOURCES) console.log(`${s.padEnd(20)} ${sources.has(s) ? "on " : "off"}  ${found[s]}`);
  console.log(`${"claude-chat".padEnd(20)} manual  agent-kb import <export>, or the kb_save tool in a chat`);
} else if (cmd === "import") {
  let exp;
  try {
    exp = readExport(path.resolve(args[0]));
  } catch (e) {
    console.error(`Cannot read ${args[0]}: ${e.message}`);
    process.exit(1);
  }
  const c = importExport(db, exp);
  console.log(`${c.chats} chats, ${c.memories} memory files imported, ${c.unchanged} unchanged, ${c.removed} removed (empty now), ${c.empty} empty, ${c.failed} failed`);
  for (const m of exp.missing) console.error(`not downloaded yet: ${m.filename} — open its link in the browser where you are signed in to Claude, save it beside the manifest, then run import again:\n  ${m.url}`);
  for (const u of exp.unreadable) console.error(`not valid export JSON, skipped: ${u}`);
  if (c.failed || exp.missing.length || exp.unreadable.length) process.exitCode = 1;
} else if (cmd === "judgments") {
  for (const j of listJudgments(db, { point: args.find((a) => POINTS.includes(a)) ?? null, open: opts?.open, limit })) {
    const when = new Date(j.ts).toISOString().slice(0, 16).replace("T", " ");
    console.log(`#${j.id} ${when} ${j.point}/${j.backend} ${j.label} ${j.score.toFixed(2)}${j.acted ? " acted" : ""} truth=${j.truth ?? "-"}  ${j.docs.join(" | ")}${j.reason ? `\n    ${j.reason}` : ""}`);
  }
} else if (cmd === "pin") {
  const { ids, queued } = pin(db, path.resolve(args[0]));
  if (!ids.length) {
    console.error(`No unanswered triage skip for ${args[0]}`);
    process.exit(1);
  }
  const list = (xs) => xs.map((i) => `#${i}`).join(", ");
  console.log(`labelled ${ids.length} triage skip${ids.length > 1 ? "s" : ""} worth keeping (${list(ids)})`);
  if (queued.length) console.log(`queued ${queued.length} skipped slice${queued.length > 1 ? "s" : ""} (${list(queued)}); the next sweep summarizes them`);
  if (queued.length < ids.length) console.log(`${ids.length - queued.length} already summarized: the triage gate was closed when ${ids.length - queued.length > 1 ? "they were" : "it was"} judged`);
} else if (cmd === "dismiss") {
  if (!/^[1-9]\d*$/.test(args[0]) || !dismiss(db, Number(args[0]))) {
    console.error(`No conflict judgment #${args[0]}`);
    process.exit(1);
  }
  console.log(`dismissed conflict #${args[0]}`);
} else if (cmd === "label") {
  if (!setTruth(db, Number(args[0]), args[1])) {
    console.error(`No judgment #${args[0]}`);
    process.exit(1);
  }
  console.log(`judgment #${args[0]} labelled ${args[1]}`);
} else if (cmd === "eval") {
  const rows = evaluate(db);
  if (!rows.length) console.log("no judgments logged yet; set AGENT_KB_JUDGE=all and sweep, then correct them with pin, dismiss or label");
  const w = Math.max(10, ...rows.map((v) => v.backend.length));
  for (const v of rows) {
    const auc = v.auc == null ? "n/a" : v.auc.toFixed(3);
    console.log(`${v.point.padEnd(9)} ${v.backend.padEnd(w)} ${v.logged} logged, ${v.n} labelled (${v.pos} yes / ${v.neg} no)  AUC ${auc}  ${v.enabled ? "ON" : `off: ${v.reason}`}`);
  }
} else if (cmd === "summarize") {
  // Tier 1 backfill: an estimate first; model calls only with --yes.
  const summarize = summarizerFromEnv();
  if (!summarize && opts.yes) {
    console.error("Set AGENT_KB_SUMMARIZER=claude (uses your claude CLI) or AGENT_KB_SUMMARIZER=api (uses ANTHROPIC_API_KEY).");
    process.exit(2);
  }
  const transcripts = transcriptsFrom(configDirs());
  dropAliases(db, transcripts);
  const t0 = await backfillTier0(db, transcripts);
  if (t0.failed) {
    console.error(`${t0.failed} transcripts or folders could not be read; they are left out.`);
    process.exitCode = 1;
  }
  const since = opts.sinceDays == null ? 0 : Date.now() - opts.sinceDays * 86_400_000;
  const run = { since, limit: opts.limit };
  if (!opts.yes) {
    const e = await summarizeIdle(db, transcripts, null, run);
    // upper bound per slice: 1 triage, 1 kind, 3 conflict neighbours
    const perSlice = judgeCfg && judgeCfg.backend !== HEURISTIC ? [...judgeCfg.points].reduce((n, p) => n + (p === "conflict" ? 3 : 1), 0) : 0;
    const extra = perSlice ? `, plus up to ${perSlice * e.slices} judge calls` : "";
    console.log(`${e.slices} slices to summarize (one model call each${extra}), ~${Math.ceil(e.inputChars / 4).toLocaleString()} input tokens. Re-run with --yes to start.`);
  } else {
    const judges = judgeCfg && new Judges(db, judgeCfg.points, judgeCfg.backend, judgeCfg.judge);
    const s = await summarizeIdle(db, transcripts, summarize, { ...run, judges });
    console.log(formatSummary(s));
    if (judges?.errors) console.log(`judge failures: ${judges.errors} (last error: ${judges.lastError}); those slices ran as if judging were off`);
    if (s.failed || s.locked) process.exitCode = 1;
  }
} else {
  const s = stats(db);
  console.log(`${dbPath()}\n${s.total} documents`);
  for (const r of s.byType) console.log(`  ${String(r.n).padStart(6)}  ${r.tier}/${r.source_type}`);
}

/** Claude Code transcripts (Code-tab sessions titled from Desktop) and Cowork sessions. */
function transcriptsFrom(dirs) {
  return allTranscripts(dirs, desktopDir(), sources);
}

function formatSummary(s) {
  const busy = "another agent-kb process is summarizing; try again later";
  if (s.locked && !s.slices) return busy;
  const parts = [`${s.summarized} summarized`, `${s.nothing} with nothing to keep`, `${s.active} active`, `${s.failed} failed`];
  if (s.backoff) parts.push(`${s.backoff} waiting after a failure`);
  return parts.join(", ") + (s.error ? ` (last error: ${s.error})` : "") + (s.locked ? `; stopped: ${busy}` : "");
}
