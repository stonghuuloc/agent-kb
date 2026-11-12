#!/usr/bin/env node
import { dbPath } from "../src/paths.js";
import { getDoc, openStore, SchemaTooNewError, stats } from "../src/store.js";
import { search } from "../src/search.js";
import { formatHits } from "../src/format.js";
import { backfillTier0 } from "../src/backfill.js";
import { configDirs, listTranscripts } from "../src/adapters/claude-code.js";
import { markGone, summarizeIdle } from "../src/sweep.js";
import { summarizerFromEnv } from "../src/summarize.js";

const USAGE = `usage:
  agent-kb search <words…> [-n N]
  agent-kb get <path>
  agent-kb stats
  agent-kb backfill
  agent-kb sweep
  agent-kb summarize [--since <N>d | --since all] [--limit N] [--yes]

Summaries need AGENT_KB_SUMMARIZER=claude (your claude CLI) or =api (ANTHROPIC_API_KEY).`;

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
    else if (a[i] === "--limit" && /^[1-9]\d*$/.test(a[i + 1] ?? "")) o.limit = Number(a[++i]);
    else return null;
  }
  return o;
}

const [cmd, ...args] = process.argv.slice(2);
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
} else if (!["stats", "backfill", "sweep"].includes(cmd) || args.length) fail();

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
  const c = await backfillTier0(db, listTranscripts(dirs));
  console.log(`${c.indexed} indexed, ${c.unchanged} unchanged, ${c.empty} empty, ${c.failed} failed (${dirs.join(", ")})`);
  if (c.failed) process.exitCode = 1;
} else if (cmd === "sweep") {
  // One tick of the sweeper: index changed transcripts, flag deleted ones, summarize idle ones.
  const transcripts = listTranscripts(configDirs());
  const t0 = await backfillTier0(db, transcripts);
  const gone = markGone(db);
  const summarize = summarizerFromEnv();
  const s = summarize ? await summarizeIdle(db, transcripts, summarize) : null;
  console.log(`${t0.indexed} indexed, ${gone} transcripts gone` + (s ? `, ${formatSummary(s)}` : ", summaries off"));
  if (t0.failed || s?.failed) process.exitCode = 1;
} else if (cmd === "summarize") {
  // Tier 1 backfill: an estimate first; model calls only with --yes.
  const summarize = summarizerFromEnv();
  if (!summarize) {
    console.error("Set AGENT_KB_SUMMARIZER=claude (uses your claude CLI) or AGENT_KB_SUMMARIZER=api (uses ANTHROPIC_API_KEY).");
    process.exit(2);
  }
  const transcripts = listTranscripts(configDirs());
  await backfillTier0(db, transcripts);
  const since = opts.sinceDays == null ? 0 : Date.now() - opts.sinceDays * 86_400_000;
  const run = { since, limit: opts.limit };
  if (!opts.yes) {
    const e = await summarizeIdle(db, transcripts, null, run);
    console.log(`${e.slices} sessions to summarize, ~${Math.ceil(e.inputChars / 4).toLocaleString()} input tokens. Re-run with --yes to start.`);
  } else {
    const s = await summarizeIdle(db, transcripts, summarize, run);
    console.log(formatSummary(s));
    if (s.failed || s.locked) process.exitCode = 1;
  }
} else {
  const s = stats(db);
  console.log(`${dbPath()}\n${s.total} documents`);
  for (const r of s.byType) console.log(`  ${String(r.n).padStart(6)}  ${r.tier}/${r.source_type}`);
}

function formatSummary(s) {
  if (s.locked) return "another agent-kb process is summarizing; try again later";
  const parts = [`${s.summarized} summarized`, `${s.nothing} with nothing to keep`, `${s.active} active`, `${s.failed} failed`];
  return parts.join(", ") + (s.error ? ` (last error: ${s.error})` : "");
}
