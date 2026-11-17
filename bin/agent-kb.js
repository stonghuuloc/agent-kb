#!/usr/bin/env node
import path from "node:path";
import { dbPath } from "../src/paths.js";
import { getDoc, openStore, SchemaTooNewError, stats } from "../src/store.js";
import { search } from "../src/search.js";
import { formatHits } from "../src/format.js";
import { backfillTier0 } from "../src/backfill.js";
import { indexRoots, indexSources } from "../src/indexer.js";
import { buildGraph, graphPath, graphStats, queryGraph } from "../src/graph.js";
import { exportConcepts } from "../src/concepts.js";
import { scanChangedConflicts } from "../src/judge.js";
import { PROMPT as DISTILL_PROMPT, distillFriction, proposalsPath, readProposals } from "../src/distill.js";
import { importKb, oldKbExists, oldKbPath } from "../src/import-kb.js";
import { pruneTranscripts } from "../src/prune.js";
import { backfillRemote } from "../src/backfill-remote.js";
import { readDotenv } from "../src/env-file.js";
import { configDirs, listTranscripts } from "../src/adapters/claude-code.js";
import { SOURCES, allTranscripts, coworkTranscripts, desktopDir, desktopTitles, enabledSources } from "../src/adapters/claude-desktop.js";
import { dropAliases, summarizeIdle, sweepOnce } from "../src/sweep.js";
import { summarizerFromEnv } from "../src/summarize.js";
import { preCompact, sessionEnd, sessionStartOutput, userPrompt } from "../src/hooks.js";
import { describeHit, findResume, forkCommand, handoffPrompt } from "../src/resume.js";
import { SHELLS, shellInit } from "../src/shell.js";
import { importExport, readExport } from "../src/adapters/claude-chat.js";
import { HEURISTIC, Judges, judgeConfig } from "../src/judge.js";
import { POINTS, dismiss, evaluate, listJudgments, pin, setTruth } from "../src/eval.js";
import { dailyDir, formatSync, obsidianConfig, syncObsidian } from "../src/obsidian.js";

const USAGE = `usage:
  agent-kb search <words…> [-n N]
  agent-kb get <path>
  agent-kb stats
  agent-kb sources
  agent-kb backfill
  agent-kb index [--dry-run]
  agent-kb graph build | stats | query <ref> | path <a> <b>
  agent-kb concepts export [--dry-run]
  agent-kb conflicts scan [--force] | list
  agent-kb distill [--dry-run] [--force]
  agent-kb prune [--confirm] [--days N]
  agent-kb import-kb [<path to the old kb.sqlite>] [--dry-run]
  agent-kb backfill-remote [--only github,jira,confluence] [--since N] [--max N] [--env <dotenv>] [--dry-run]
  agent-kb resume <words…>
  agent-kb fork <words…> [--to claude]
  agent-kb shell-init zsh|bash|fish
  agent-kb sweep [--ended <transcript>]
  agent-kb summarize [--since <N>d | --since all] [--limit N] [--yes]
  agent-kb obsidian sync
  agent-kb import <member-manifest-*.json | conversations-NNN.zip | memories-NNN.zip | folder>
  agent-kb judgments [triage|conflict|kind] [--open] [-n N]
  agent-kb pin <transcript or slice path>
  agent-kb dismiss <conflict-id>
  agent-kb label <judgment-id> yes|no
  agent-kb eval

Sources are auto-detected; AGENT_KB_SOURCES=claude-code,claude-cowork (comma list) reads only those.
Summaries need AGENT_KB_SUMMARIZER=claude (your claude CLI) or =api (AGENT_KB_API_KEY or ANTHROPIC_API_KEY).
summarize shows an estimate; --yes runs it. --limit caps slices (up to 50K chars each); with AGENT_KB_JUDGE_BACKEND=claude each slice can add judge calls.
import reads a Claude data export (Settings → Privacy → Export data); re-running it adds only what changed.
resume prints the shell command for the best matching session (it never runs it); fork prints a handoff prompt, or with --to claude
a command that starts a new claude session from it. shell-init prints a kbr <words…> function that asks y/N before running the resume command.
obsidian sync writes sessions and a daily journal into <AGENT_KB_VAULT>/<AGENT_KB_VAULT_FOLDER, default agent-kb>/ and indexes the vault's own notes; sweep does it too when AGENT_KB_VAULT is set.
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
    else if (args[0] === "session-start") process.stdout.write(sessionStartOutput(raw));
    else if (args[0] === "user-prompt") process.stdout.write(userPrompt(raw));
    else if (args[0] === "pre-compact") preCompact(raw);
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
} else if (cmd === "obsidian") {
  if (args.length !== 1 || args[0] !== "sync") fail();
} else if (cmd === "index") {
  if (args.length && args[0] !== "--dry-run") fail();
} else if (cmd === "concepts") {
  if (args[0] !== "export" || args.length > 2 || (args[1] && args[1] !== "--dry-run")) fail();
} else if (cmd === "conflicts") {
  if (!["scan", "list"].includes(args[0]) || args.length > 2 || (args[1] && args[1] !== "--force")) fail();
} else if (cmd === "distill") {
  if (args.some((a) => !["--dry-run", "--force"].includes(a))) fail();
} else if (cmd === "prune") {
  const i = args.indexOf("--days");
  const days = i >= 0 ? args[i + 1] : null;
  if (i >= 0 && !/^\d+$/.test(days ?? "")) fail();
  if (args.some((a, n) => a.startsWith("--") && a !== "--confirm" && a !== "--days" && !(i >= 0 && n === i + 1))) fail();
} else if (cmd === "import-kb") {
  if (args.filter((a) => !a.startsWith("--")).length > 1) fail();
  if (args.some((a) => a.startsWith("--") && a !== "--dry-run")) fail();
} else if (cmd === "backfill-remote") {
  const flags = ["--only", "--since", "--max", "--env"];
  for (let i = 0; i < args.length; i++) {
    if (flags.includes(args[i])) {
      if (args[++i] === undefined) fail();
    } else if (args[i] !== "--dry-run") fail();
  }
} else if (cmd === "graph") {
  const ok =
    ((args[0] === "build" || args[0] === "stats") && args.length === 1) ||
    (args[0] === "query" && args.length === 2) ||
    (args[0] === "path" && args.length === 3);
  if (!ok) fail();
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

let vault;
if (cmd === "obsidian") {
  try {
    vault = obsidianConfig();
  } catch (e) {
    console.error(e.message);
    process.exit(2);
  }
  if (!vault) {
    console.error("Set AGENT_KB_VAULT to your Obsidian vault folder (output goes to AGENT_KB_VAULT_FOLDER inside it, default agent-kb).");
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
      if (f.warning) console.error(f.warning);
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
} else if (cmd === "index") {
  const roots = indexRoots();
  if (!roots.length) console.log("no roots: set AGENT_KB_WORKSPACE (the folder holding your repos) to index them; ~/.claude is the default root");
  else if (args[0] === "--dry-run") for (const r of roots) console.log(`${r.rule.padEnd(10)} ${r.dir}`);
  else {
    const c = indexSources(db, { roots });
    console.log(`${c.indexed} indexed, ${c.unchanged} unchanged, ${c.removed} removed, ${c.skipped} skipped (empty or over 512 KB), ${c.failed} failed`);
    for (const r of roots) console.log(`  ${r.rule.padEnd(10)} ${r.dir}`);
    if (c.failed) process.exitCode = 1;
  }
} else if (cmd === "graph") {
  const [sub, a, b] = args;
  if (sub === "build") {
    const g = buildGraph(db);
    console.log(`graph built from ${g.docs} docs: ${g.entities} entities, ${g.mentions} mentions, ${g.edges} edges`);
    const cfg = obsidianConfig(process.env);
    if (cfg) {
      const c = exportConcepts(db, cfg.vault);
      console.log(`concepts: ${c.created} created, ${c.updated} updated, ${c.unchanged} unchanged, ${c.skipped} skipped (${path.join(cfg.vault, "concepts")})`);
    }
  } else if (sub === "stats") {
    const st = graphStats(db);
    for (const e of st.entities) console.log(`${e.etype.padEnd(12)} ${e.n}`);
    console.log("");
    for (const e of st.edges) console.log(`${e.rel.padEnd(15)} ${e.n} edges (weight ${e.w})`);
  } else if (sub === "query") {
    const r = queryGraph(db, a);
    if (!r) (console.error(`No entity ${a}. Build with: agent-kb graph build`), (process.exitCode = 1));
    else {
      console.log(`${r.id} — ${r.ndocs} docs`);
      for (const [kind, list] of Object.entries(r.neighbours)) console.log(`  ${kind} (${list.length}): ${list.slice(0, 12).map((n) => n.label).join(", ")}`);
      for (const d of r.docs) console.log(`  doc: ${d.source_path}`);
    }
  } else {
    const found = graphPath(db, a, b);
    if (!found) (console.error(`No link up to 3 hops between ${a} and ${b}`), (process.exitCode = 1));
    else console.log(found.join(" → "));
  }
} else if (cmd === "concepts") {
  const cfg = obsidianConfig(process.env);
  if (!cfg) (console.error("set AGENT_KB_VAULT to write concept notes"), (process.exitCode = 1));
  else {
    const c = exportConcepts(db, cfg.vault, { dryRun: args[1] === "--dry-run" });
    console.log(`${c.created} created, ${c.updated} updated, ${c.unchanged} unchanged, ${c.skipped} skipped${c.conflict ? `, ${c.conflict} kept changing while being written (retried on the next run)` : ""} (${path.join(cfg.vault, "concepts")})`);
  }
} else if (cmd === "conflicts") {
  if (args[0] === "list") {
    const rows = listJudgments(db, { point: "conflict", limit: 50 });
    if (!rows.length) console.log("no conflict flags");
    for (const r of rows) console.log(`#${r.id} ${r.truth ?? "proposed"} ${r.docs.join(" > ")} — ${r.reason ?? r.label} (agent-kb label ${r.id} yes|no)`);
  } else {
    const judges = judgeCfg && new Judges(db, judgeCfg.points, judgeCfg.backend, judgeCfg.judge);
    const n = await scanChangedConflicts(db, judges, { force: args[1] === "--force" });
    console.log(`${n} new conflict flag${n === 1 ? "" : "s"}${judges ? "" : " (conflict judging is off: set AGENT_KB_JUDGE=conflict,AGENT_KB_JUDGE_BACKEND=claude to enable)"}`);
    if (judges?.errors) {
      console.error(`judge failures: ${judges.errors} (last error: ${judges.lastError}); a later run retries them; a doc whose reply is unusable 3 runs in a row is passed over`);
      process.exitCode = 1;
    }
  }
} else if (cmd === "distill") {
  const file = proposalsPath();
  if (args.includes("--dry-run")) {
    const current = readProposals(file);
    console.log(current || "(empty block)");
  } else {
    const r = await distillFriction(db, { summarize: summarizerFromEnv(process.env, DISTILL_PROMPT), file });
    console.log(
      r.status === "written" ? `${r.rules} rules from ${r.items} friction items across ${r.sessions} sessions → ${r.file}`
        : r.status === "too-few" ? `only ${r.items} friction items; nothing distilled`
        : r.status === "none" ? "the model proposed nothing"
        : r.status === "off" ? "AGENT_KB_DISTILL=off"
        : "no summarizer configured (AGENT_KB_SUMMARIZER), so nothing was distilled",
    );
  }
} else if (cmd === "prune") {
  const i = args.indexOf("--days");
  const r = pruneTranscripts(db, { days: i >= 0 ? Number(args[i + 1]) : undefined, confirm: args.includes("--confirm") });
  console.log(
    `${r.candidates} transcripts older than ${i >= 0 ? args[i + 1] : 90} days have a summary (${(r.bytes / 1e6).toFixed(1)} MB)` +
      (r.cooldown
        ? "; another run was too recent, nothing deleted"
        : args.includes("--confirm")
          ? `; held ${r.held} until the next run; deleted ${r.deleted} held earlier (${(r.freed / 1e6).toFixed(1)} MB)` + (r.restored ? `; ${r.restored} written to while held, put back` : "") + (r.busy ? `; ${r.busy} still open in another process (or not checkable here), kept` : "")
          : "; dry run, nothing deleted (add --confirm)"),
  );
} else if (cmd === "import-kb") {
  const file = args.find((a) => !a.startsWith("--")) ?? oldKbPath();
  if (!oldKbExists(file)) (console.error(`no kb database at ${file}`), (process.exitCode = 1));
  else if (args.includes("--dry-run")) {
    const { DatabaseSync } = await import("node:sqlite");
    const o = new DatabaseSync(file, { readOnly: true });
    const n = o.prepare("SELECT COUNT(*) AS n FROM documents").get().n;
    o.close();
    console.log(`${n} documents in ${file}; run without --dry-run to import what is missing`);
  } else {
    const c = importKb(db, file);
    console.log(`${c.docs} documents imported, ${c.skipped} already here, ${c.conflicts} conflict flags, ${c.failed} failed`);
  }
} else if (cmd === "backfill-remote") {
  const get = (flag) => (args.indexOf(flag) >= 0 ? args[args.indexOf(flag) + 1] : null);
  const envFile = get("--env");
  const dotenv = envFile ? readDotenv(envFile) : {};
  const report = await backfillRemote(db, {
    env: { ...process.env, ...dotenv },
    only: get("--only") ? get("--only").split(",").map((s) => s.trim()) : null,
    sinceDays: Number(get("--since") ?? 30),
    max: Number(get("--max") ?? 40),
    dryRun: args.includes("--dry-run"),
  });
  for (const [source, r] of Object.entries(report)) {
    if (r.error || (r.skipped && !r.found)) process.exitCode = 1;
    console.log(r.error ? `${source.padEnd(11)} error: ${r.error}` : `${source.padEnd(11)} ${r.found} found, ${r.written} written${r.skipped ? `, ${r.skipped} skipped (last error: ${r.lastError})` : ""}${args.includes("--dry-run") ? " (dry run)" : ""}`);
  }
  if (Object.values(report).some((r) => r.error)) process.exitCode = 1;
} else if (cmd === "sweep") {
  const ended = args[1] ? path.resolve(args[1]) : null;
  const judges = judgeCfg && new Judges(db, judgeCfg.points, judgeCfg.backend, judgeCfg.judge);
  const { t0, index, graph, gone, s, pinned, obsidian, dailyPending } = await sweepOnce(db, { summarize: summarizerFromEnv(), ended, sources, judges, index: ended ? null : indexRoots(), graph: !ended });
  if (index) console.log(`${index.indexed} static docs indexed, ${index.removed} removed`);
  if (graph) console.log(graph.error ? `graph: ${graph.error}` : `graph: ${graph.entities} entities, ${graph.edges} edges${graph.concepts ? `, concepts ${graph.concepts.created}+${graph.concepts.updated} written` : ""}`);
  console.log(`${t0.indexed} indexed, ${gone} transcripts gone` + (s ? `, ${formatSummary(s)}` : ", summaries off"));
  if (pinned?.summarized || pinned?.nothing || pinned?.lost || pinned?.failed)
    console.log(`pinned: ${pinned.summarized} summarized, ${pinned.nothing} with nothing to keep, ${pinned.lost} lost (transcript gone or changed), ${pinned.failed} failed` + (pinned.error ? ` (last error: ${pinned.error}; retried on a later sweep)` : ""));
  if (judges?.errors) console.log(`judge failures: ${judges.errors} (last error: ${judges.lastError}); those slices ran as if judging were off`);
  if (obsidian?.error) console.error(`obsidian: ${obsidian.error}`);
  else if (obsidian) console.log(formatSync(obsidian));
  if (dailyPending?.off) console.log(`daily notes are off: ${dailyPending.left} queued entries kept until they are on again`);
  else if (dailyPending) console.log(`daily notes: ${dailyPending.delivered ?? 0} queued entries delivered, ${dailyPending.left ?? 0} still waiting${dailyPending.error ? ` (last error: ${dailyPending.error})` : ""}`);
  if (!dailyPending?.off && dailyPending?.error) process.exitCode = 1; // a row with no error is in flight in another sweep
  if (t0.failed || s?.failed || pinned?.failed || obsidian?.error || obsidian?.out?.failed || obsidian?.in?.failed) process.exitCode = 1;
} else if (cmd === "obsidian") {
  const r = syncObsidian(db, vault);
  console.log(formatSync(r));
  if (r.locked || r.out.failed || r.in.failed) process.exitCode = 1;
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
    console.error("Set AGENT_KB_SUMMARIZER=claude (uses your claude CLI) or AGENT_KB_SUMMARIZER=api (uses AGENT_KB_API_KEY or ANTHROPIC_API_KEY).");
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
    let daily = null;
    try {
      daily = dailyDir(process.env);
    } catch (e) {
      console.error(`daily notes off for this run: ${e?.message ?? e}`);
    }
    const s = await summarizeIdle(db, transcripts, summarize, { ...run, judges, daily });
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
