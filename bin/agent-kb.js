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
import { sessionEnd, sessionStart } from "../src/hooks.js";
import { describeHit, findResume, forkCommand, handoffPrompt } from "../src/resume.js";
import { SHELLS, shellInit } from "../src/shell.js";
import { importExport, readExport } from "../src/adapters/claude-chat.js";

const USAGE = `usage:
  agent-kb search <words…> [-n N]
  agent-kb get <path>
  agent-kb stats
  agent-kb sources
  agent-kb backfill
  agent-kb resume <words…>
  agent-kb fork <words…> [--to claude]
  agent-kb shell-init zsh|bash|fish
  agent-kb sweep [--ended <transcript>]
  agent-kb summarize [--since <N>d | --since all] [--limit N] [--yes]
  agent-kb import <member-manifest-*.json | conversations-NNN.zip | memories-NNN.zip | folder>

Sources are auto-detected; AGENT_KB_SOURCES=claude-code,claude-cowork (comma list) reads only those.
Summaries need AGENT_KB_SUMMARIZER=claude (your claude CLI) or =api (ANTHROPIC_API_KEY).
summarize shows an estimate; --yes runs it. --limit caps model calls (slices of up to 50K chars).
import reads a Claude data export (Settings → Privacy → Export data); re-running it adds only what changed.
resume prints the shell command for the best matching session (it never runs it); fork prints a handoff prompt, or with --to claude
a command that starts a new claude session from it. shell-init prints a kbr <words…> function that asks y/N before running the resume command.
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
    else if (args[0] === "session-start") process.stdout.write(sessionStart(raw));
  } catch {}
  process.exit(0);
}
if (cmd === "shell-init") {
  if (args.length !== 1 || !SHELLS.includes(args[0])) fail();
  console.log(shellInit(args[0]));
  process.exit(0);
}
let opts;
let limit;
let to;
if (cmd === "search") {
  const i = args.indexOf("-n");
  if (i >= 0) {
    limit = Number(args.splice(i, 2)[1]);
    if (!Number.isInteger(limit) || limit < 1) fail();
  }
  if (!args.length) fail();
} else if (cmd === "get") {
  if (args.length !== 1) fail();
} else if (cmd === "resume" || cmd === "fork") {
  const i = args.indexOf("--to");
  if (i >= 0) {
    if (cmd !== "fork" || !args[i + 1]) fail();
    to = args.splice(i, 2)[1];
  }
  if (!args.length) fail();
} else if (cmd === "summarize") {
  opts = parseSummarize(args) ?? fail();
} else if (cmd === "import") {
  if (args.length !== 1) fail();
} else if (cmd === "sweep") {
  if (args.length && (args.length !== 2 || args[0] !== "--ended" || !args[1])) fail();
} else if (!["stats", "backfill", "sources"].includes(cmd) || args.length) fail();

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

let db;
try {
  db = openStore(dbPath());
} catch (e) {
  if (!(e instanceof SchemaTooNewError)) throw e;
  console.error(e.message);
  process.exit(3);
}

if (cmd === "search") console.log(formatHits(search(db, args.join(" "), { limit })));
else if (cmd === "resume") {
  const r = findResume(db, args.join(" "));
  if (!r) (console.error("No matches."), (process.exitCode = 1));
  else {
    console.error(describeHit(r.hit));
    if (r.cmd) console.log(r.cmd);
    else (console.error(r.why), (process.exitCode = 1));
  }
} else if (cmd === "fork") {
  const hit = search(db, args.join(" "), { limit: 1 })[0];
  if (!hit) (console.error("No matches."), (process.exitCode = 1));
  else {
    const prompt = handoffPrompt(db, hit);
    console.error(describeHit(hit));
    if (to === "claude") {
      const f = forkCommand(db, hit, prompt);
      console.error(`handoff prompt: ${f.file}`);
      console.log(f.cmd);
    } else console.log(prompt);
  }
} else if (cmd === "get") {
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
  const { t0, gone, s } = await sweepOnce(db, { summarize: summarizerFromEnv(), ended, sources });
  console.log(`${t0.indexed} indexed, ${gone} transcripts gone` + (s ? `, ${formatSummary(s)}` : ", summaries off"));
  if (t0.failed || s?.failed) process.exitCode = 1;
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
    console.log(`${e.slices} slices to summarize (one model call each), ~${Math.ceil(e.inputChars / 4).toLocaleString()} input tokens. Re-run with --yes to start.`);
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
