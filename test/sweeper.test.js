import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { openStore, getDoc, acquireLock, releaseLock } from "../src/store.js";
import { addDaily, claimTick, dailyUsed, dropAliases, summarizeIdle, sweepOnce } from "../src/sweep.js";
import { listTranscripts } from "../src/adapters/claude-code.js";
import { backfillTier0 } from "../src/backfill.js";
import { search } from "../src/search.js";
import { startSweeper } from "../src/sweeper.js";
import { sessionEnd } from "../src/hooks.js";

// a developer's own vault must never receive fixture notes
delete process.env.AGENT_KB_VAULT;
delete process.env.AGENT_KB_VAULT_FOLDER;

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "agent-kb-tick-"));
const MIN = 60_000;
const NO_DESKTOP = path.join(os.tmpdir(), "agent-kb-no-desktop");
const line = (o) => JSON.stringify(o) + "\n";

/** A config dir with one short session last written `ageMs` ago. */
function config(ageMs) {
  const cfg = tmp();
  const dir = path.join(cfg, "projects", "-w");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "s1.jsonl");
  const rec = (type, content) => ({ type, sessionId: "s1", cwd: "/w", timestamp: "2026-11-01T10:00:00Z", message: { content } });
  fs.writeFileSync(file, line(rec("user", "rename loadConfig and keep an alias")) + line(rec("assistant", [{ type: "text", text: "Done, alias kept for one release." }])));
  const t = new Date(Date.now() - ageMs);
  fs.utimesSync(file, t, t);
  return { cfg, file };
}
const fake = () => {
  const calls = [];
  return Object.assign(async (input) => (calls.push(input), "## KNOWLEDGE\n- alias kept"), { calls });
};

test("one tick per gap across processes", () => {
  // Arrange
  const file = path.join(tmp(), "kb.sqlite");
  const db = openStore(file);
  const db2 = openStore(file);

  // Act + Assert
  assert.equal(claimTick(db, 14 * MIN, 1_000_000_000), true);
  assert.equal(claimTick(db2, 14 * MIN, 1_000_000_000 + MIN), false, "another process inside the gap");
  assert.equal(claimTick(db2, 14 * MIN, 1_000_000_000 + 14 * MIN), true);
});

/** A sweep that stays pending until `finish()`, counting calls. */
function pendingSweep(result = { s: null }) {
  const waiting = [];
  let calls = 0;
  const sweep = () => (calls++, new Promise((r) => waiting.push(r)));
  return Object.assign(sweep, { calls: () => calls, finish: () => waiting.splice(0).forEach((r) => r(result)) });
}

test("a tick that outlasts the interval is not started twice in one process", async () => {
  // Arrange: a 1-min interval leaves no claim gap, so only the in-process guard stops the overlap
  const sweep = pendingSweep();
  const s = startSweeper(openStore(path.join(tmp(), "kb.sqlite")), { sweep, intervalMs: MIN, startDelayMs: 1e9 });

  // Act
  const first = s.tick();
  const second = s.tick();
  sweep.finish();
  await Promise.all([first, second]);
  const third = s.tick();
  sweep.finish();
  await third;
  s.stop();

  // Assert
  assert.equal(sweep.calls(), 2, "the overlapping tick was skipped; the next one ran");
});

test("a second process skips the tick another process just ran; errors are logged, not thrown", async () => {
  // Arrange
  const file = path.join(tmp(), "kb.sqlite");
  const db = openStore(file);
  const sweep = pendingSweep({ s: { failed: 2, error: "rate limited" } });
  const logs = [];
  const a = startSweeper(db, { sweep, startDelayMs: 1e9, log: (m) => logs.push(m) });
  const b = startSweeper(openStore(file), { sweep, startDelayMs: 1e9 });
  const failing = startSweeper(openStore(path.join(tmp(), "kb.sqlite")), { sweep: async () => { throw new Error("boom"); }, startDelayMs: 1e9, log: (m) => logs.push(m) });

  // Act
  const ticks = [a.tick(), b.tick()];
  sweep.finish();
  await Promise.all(ticks);
  await failing.tick();
  [a, b, failing].forEach((s) => s.stop());

  // Assert
  assert.equal(sweep.calls(), 1);
  assert.deepEqual(logs, ["agent-kb sweep: 2 failed (last error: rate limited)", "agent-kb sweep: boom"]);
});

test("the sweeper logs new judge failures and pinned failures once, not on every tick", async () => {
  // Arrange
  const db = openStore(path.join(tmp(), "kb.sqlite"));
  const judges = { errors: 0, lastError: null, refresh() {} };
  const results = [{ pinned: { failed: 1, error: "pin broke" } }, {}, {}];
  const sweep = async () => {
    const r = results.shift();
    if (results.length === 1) Object.assign(judges, { errors: 2, lastError: "not json" });
    return r;
  };
  const logs = [];
  const sw = startSweeper(db, { sweep, judges, intervalMs: 0, startDelayMs: 1e9, log: (m) => logs.push(m) });

  // Act
  await sw.tick();
  await sw.tick();
  await sw.tick();
  sw.stop();

  // Assert
  assert.deepEqual(logs, ["agent-kb sweep: pinned slice failed (pin broke)", "agent-kb sweep: 2 judge failures (last error: not json)"]);
});

test("an index-only tick does not consume the claim of a server that summarizes", async () => {
  // Arrange
  const file = path.join(tmp(), "kb.sqlite");
  const indexOnly = pendingSweep();
  const summarizing = pendingSweep();
  const a = startSweeper(openStore(file), { sweep: indexOnly, startDelayMs: 1e9 });
  const b = startSweeper(openStore(file), { sweep: summarizing, summarize: fake(), startDelayMs: 1e9 });

  // Act
  const first = a.tick();
  indexOnly.finish();
  await first;
  const second = b.tick();
  summarizing.finish();
  await second;
  [a, b].forEach((s) => s.stop());

  // Assert
  assert.equal(indexOnly.calls(), 1);
  assert.equal(summarizing.calls(), 1, "the summarizing server still ran its tick");
});

test("an ended session is summarized at once; the timer waits for it to go idle", async () => {
  // Arrange
  const { cfg, file } = config(2 * MIN);
  const db = openStore(path.join(tmp(), "kb.sqlite"));
  const summarize = fake();

  // Act
  const tick = await sweepOnce(db, { summarize, dirs: [cfg], desktop: NO_DESKTOP });
  const ended = await sweepOnce(db, { summarize, ended: file, dirs: [cfg], desktop: NO_DESKTOP });

  // Assert
  assert.equal(tick.s.active, 1);
  assert.equal(ended.s.summarized, 1, "a short ended session counts as finished");
  assert.equal(summarize.calls.length, 1);
  assert.match(getDoc(db, `${file}#w1`).content, /alias kept/);
});

test("an ended path outside the config dirs is neither indexed nor summarized", async () => {
  // Arrange
  const { cfg } = config(2 * MIN);
  const other = config(2 * MIN);
  const db = openStore(path.join(tmp(), "kb.sqlite"));
  const summarize = fake();

  // Act
  const r = await sweepOnce(db, { summarize, ended: other.file, dirs: [cfg], desktop: NO_DESKTOP });

  // Assert
  assert.equal(r.t0.indexed, 0);
  assert.equal(summarize.calls.length, 0);
  assert.equal(getDoc(db, other.file), null);
});

test("the SessionEnd hook starts a detached sweep only when summaries are on", () => {
  // Arrange
  const spawned = [];
  const spawn = (cmd, args, opts) => (spawned.push({ cmd, args, opts }), { on() {}, unref() {} });
  const input = JSON.stringify({ session_id: "s1", transcript_path: "/c/projects/-w/s1.jsonl", reason: "exit" });
  const on = { AGENT_KB_SUMMARIZER: "claude" };

  // Act
  const results = [
    sessionEnd(input, { env: {}, spawn }),
    sessionEnd(input, { env: { ...on, AGENT_KB_CHILD: "1" }, spawn }),
    sessionEnd(input, { env: { ...on, AGENT_KB_SWEEP: "off" }, spawn }),
    sessionEnd("not json", { env: on, spawn }),
    sessionEnd(JSON.stringify({ transcript_path: "rel/s1.jsonl" }), { env: on, spawn }),
    sessionEnd(input, { env: on, spawn: () => { throw new Error("EAGAIN"); } }),
    sessionEnd(input, { env: on, spawn }),
  ];

  // Assert
  assert.deepEqual(results, [false, false, false, false, false, false, true]);
  assert.equal(spawned.length, 1);
  assert.deepEqual(spawned[0].args.slice(1), ["sweep", "--ended", "/c/projects/-w/s1.jsonl"]);
  assert.match(spawned[0].args[0], /bin[\\/]agent-kb\.js$/);
  assert.equal(spawned[0].opts.detached, true);
});

test("an ended session waits for a lock another sweep holds, up to its limit", async () => {
  // Arrange
  const { cfg, file } = config(2 * MIN);
  const db = openStore(path.join(tmp(), "kb.sqlite"));
  const summarize = fake();
  acquireLock(db, "summarize", "other", 10 * MIN);
  let sleeps = 0;
  const releaseWhileAsleep = async () => (sleeps++, releaseLock(db, "summarize", "other"));
  const held = config(2 * MIN);
  const db2 = openStore(path.join(tmp(), "kb.sqlite"));
  acquireLock(db2, "summarize", "other", 10 * MIN);

  // Act
  const waited = await sweepOnce(db, { summarize, ended: file, dirs: [cfg], desktop: NO_DESKTOP, wait: { everyMs: 0, maxMs: 60_000, sleep: releaseWhileAsleep } });
  const gaveUp = await sweepOnce(db2, { summarize, ended: held.file, dirs: [held.cfg], desktop: NO_DESKTOP, wait: { everyMs: 10, maxMs: 50 } });

  // Assert
  assert.equal(sleeps, 1, "the first try found the lock held");
  assert.equal(waited.s.summarized, 1);
  assert.equal(gaveUp.s.locked, true);
  assert.equal(summarize.calls.length, 1);
});

test("an ended path that matches no transcript does not wait for the lock", async () => {
  // Arrange
  const { cfg } = config(2 * MIN);
  const db = openStore(path.join(tmp(), "kb.sqlite"));
  acquireLock(db, "summarize", "other", 10 * MIN);
  let sleeps = 0;

  // Act
  const r = await sweepOnce(db, { summarize: fake(), ended: "/nowhere/s.jsonl", dirs: [cfg], desktop: NO_DESKTOP, wait: { everyMs: 0, maxMs: 60_000, sleep: async () => sleeps++ } });

  // Assert
  assert.equal(sleeps, 0);
  assert.equal(r.s, null);
});

test("the CLI hook always exits 0; sweep rejects malformed --ended", () => {
  // Arrange
  const cli = path.join(import.meta.dirname, "..", "bin", "agent-kb.js");
  const env = { ...process.env, AGENT_KB_HOME: tmp(), AGENT_KB_CLAUDE_DIRS: tmp(), AGENT_KB_DESKTOP_DIR: tmp(), AGENT_KB_SUMMARIZER: "claude" };
  const run = (args, input = "") => spawnSync(process.execPath, [cli, ...args], { env, input }).status;

  // Act + Assert
  assert.equal(run(["hook", "session-end"], "not json"), 0);
  assert.equal(run(["hook", "session-end"], JSON.stringify({ transcript_path: "/nowhere/s.jsonl" })), 0);
  assert.equal(run(["hook", "unknown"]), 0);
  assert.equal(run(["sweep", "--ended"]), 2);
  assert.equal(run(["sweep", "--ended", ""]), 2, "an empty --ended must not sweep every transcript");
  assert.equal(run(["sweep", "--other", "x"]), 2);
  const typo = { ...env, AGENT_KB_SOURCES: "claude-cod" };
  assert.equal(spawnSync(process.execPath, [cli, "sources"], { env: typo }).status, 2);
  assert.equal(spawnSync(process.execPath, [cli, "search", "x"], { env: typo }).status, 0, "search reads no local source");
  const server = spawnSync(process.execPath, [path.join(import.meta.dirname, "..", "src", "server.js")], { env: typo, input: "", encoding: "utf8" });
  assert.match(server.stderr, /no background sweeps\. AGENT_KB_SOURCES: unknown source claude-cod/);
});

/** A real config dir with one 7-hour-idle session, and a profile dir whose `projects` links to it. */
function linkedProfile() {
  const { cfg: real, file } = config(7 * 60 * MIN);
  const profile = tmp();
  fs.symlinkSync(path.join(real, "projects"), path.join(profile, "projects"));
  return { real, profile, file, alias: path.join(profile, "projects", "-w", "s1.jsonl") };
}

test("an ended session named through a linked profile dir is found under the real path", { skip: process.platform === "win32" }, async () => {
  // Arrange
  const { real, profile, file, alias } = linkedProfile();
  const db = openStore(path.join(tmp(), "kb.sqlite"));

  // Act
  const r = await sweepOnce(db, { summarize: fake(), ended: alias, dirs: [profile, real], desktop: NO_DESKTOP });

  // Assert
  assert.equal(r.s.summarized, 1);
  assert.ok(getDoc(db, `${file}#w1`));
});

test("rows filed under a linked path fold into the real one; on a tie the real path keeps its own summaries", { skip: process.platform === "win32" }, async () => {
  // Arrange: what a store looked like when both dirs were listed
  const { real, profile, file, alias } = linkedProfile();
  const db = openStore(path.join(tmp(), "kb.sqlite"));
  const old = [{ file: alias, configDir: profile }, { file, configDir: real }];
  await backfillTier0(db, old);
  await summarizeIdle(db, [old[0]], fake());
  const other = linkedProfile();
  const db2 = openStore(path.join(tmp(), "kb.sqlite"));
  const old2 = [{ file: other.alias, configDir: other.profile }, { file: other.file, configDir: other.real }];
  await backfillTier0(db2, old2);
  await summarizeIdle(db2, old2, fake());
  const gone = path.join(profile, "projects", "-w", "deleted.jsonl");
  db.prepare("INSERT INTO cursors (source_path, offset, chunks) VALUES (?, 1, 0)").run(gone);

  // Act
  const moved = dropAliases(db, listTranscripts([profile, real]));
  const dropped = dropAliases(db2, listTranscripts([other.profile, other.real]));
  const again = dropAliases(db, listTranscripts([profile, real]));

  // Assert
  const paths = (d) => d.prepare("SELECT source_path FROM documents ORDER BY 1").all().map((r) => r.source_path);
  const cursors = (d) => d.prepare("SELECT source_path FROM cursors ORDER BY 1").all().map((r) => r.source_path);
  assert.equal(moved, 1);
  assert.deepEqual(paths(db), [file, `${file}#w1`], "alias summary moved");
  assert.deepEqual(cursors(db), [gone, file].sort(), "a deleted transcript is left to markGone");
  assert.equal(db.prepare("SELECT count(*) n FROM scans WHERE source_path = ?").get(alias).n, 0);
  assert.equal(dropped, 1);
  assert.deepEqual(paths(db2), [other.file, `${other.file}#w1`], "the real path kept its own summary");
  assert.deepEqual(cursors(db2), [other.file]);
  assert.equal(again, 0);
  assert.deepEqual(search(db, "rename").map((h) => h.source_path).sort(), [file, `${file}#w1`], "no hit under the linked path");
});

test("folding keeps the alias's summaries when the real path got less far (a failed call at offset 0)", { skip: process.platform === "win32" }, async () => {
  // Arrange
  const { real, profile, file, alias } = linkedProfile();
  const db = openStore(path.join(tmp(), "kb.sqlite"));
  await backfillTier0(db, [{ file: alias, configDir: profile }, { file, configDir: real }]);
  await summarizeIdle(db, [{ file: alias, configDir: profile }], fake());
  db.prepare("INSERT INTO cursors (source_path, offset, chunks, failures, failed_ts) VALUES (?, 0, 0, 1, 1)").run(file);

  // Act
  dropAliases(db, listTranscripts([profile, real]));

  // Assert
  const cur = db.prepare("SELECT source_path, offset FROM cursors").all();
  assert.deepEqual(cur.map((c) => c.source_path), [file]);
  assert.ok(cur[0].offset > 0, "the alias's progress moved over");
  assert.ok(getDoc(db, `${file}#w1`), "its summary moved over");
});

test("a tick logs vault notes that failed to write or index", async () => {
  // Arrange
  const logs = [];
  const sweep = async () => ({ s: null, obsidian: { locked: false, out: { failed: 2 }, in: { failed: 1 } } });
  const s = startSweeper(openStore(path.join(tmp(), "kb.sqlite")), { sweep, intervalMs: MIN, startDelayMs: 1e9, log: (m) => logs.push(m) });

  // Act
  await s.tick();
  s.stop();

  // Assert
  assert.deepEqual(logs, ["agent-kb obsidian: 2 notes out and 1 notes in failed"]);
});

/** A config dir with `n` sessions, each idle `ageMs`. */
function sessions(n, ageMs, cwd = "/w", chars = 30) {
  const cfg = tmp();
  const dir = path.join(cfg, "projects", "-w");
  fs.mkdirSync(dir, { recursive: true });
  const t = new Date(Date.now() - ageMs);
  const text = "rename loadConfig and keep an alias ".repeat(chars);
  for (let i = 0; i < n; i++) {
    const file = path.join(dir, `s${i}.jsonl`);
    const rec = (type, content) => ({ type, sessionId: `s${i}`, cwd, timestamp: "2026-11-01T10:00:00Z", message: { content } });
    fs.writeFileSync(file, line(rec("user", text)) + line(rec("assistant", [{ type: "text", text }])));
    fs.utimesSync(file, t, t);
  }
  return cfg;
}

test("a budgeted tick skips sessions idle under 6 h, caps the calls and paces them", async () => {
  // Arrange
  const young = sessions(3, 2 * 3_600_000);
  const old = sessions(3, 7 * 3_600_000);
  const budget = { idleMs: 6 * 3_600_000, limit: 2, pauseMs: 60_000, maxFailures: 1 };
  const naps = [];
  const run = (cfg, summarize) =>
    sweepOnce(openStore(path.join(tmp(), "kb.sqlite")), { summarize, dirs: [cfg], desktop: NO_DESKTOP, budget, wait: { maxMs: 0, sleep: (ms) => naps.push(ms) } });

  // Act
  const youngFake = fake();
  await run(young, youngFake);
  const oldFake = fake();
  const { s } = await run(old, oldFake);

  // Assert
  assert.equal(youngFake.calls.length, 0, "a session idle 2 h waits for its hook");
  assert.equal(oldFake.calls.length, 2, "the cap ends the tick");
  assert.equal(s.slices, 2);
  assert.deepEqual(naps, [60_000], "one 60 s gap between two calls");
});

test("a budgeted tick stops at its first failed call", async () => {
  // Arrange
  const cfg = sessions(4, 7 * 3_600_000);
  let calls = 0;
  const failing = async () => (calls++, Promise.reject(new Error("429")));

  // Act
  const { s } = await sweepOnce(openStore(path.join(tmp(), "kb.sqlite")), {
    summarize: failing, dirs: [cfg], desktop: NO_DESKTOP, wait: { maxMs: 0 },
    budget: { idleMs: 6 * 3_600_000, limit: 5, pauseMs: 0, maxFailures: 1 },
  });

  // Assert
  assert.equal(calls, 1);
  assert.equal(s.failed, 1);
});

test("the sweeper keeps a daily slice ceiling across ticks", async () => {
  // Arrange
  const db = openStore(path.join(tmp(), "kb.sqlite"));
  const limits = [];
  const sweep = async (d, { budget }) => (limits.push(budget.limit), addDaily(d, budget.limit), { s: { slices: budget.limit } });
  const sw = startSweeper(db, { sweep, summarize: fake(), intervalMs: 0, startDelayMs: 1e9, log: () => {} });

  // Act
  for (let i = 0; i < 12; i++) await sw.tick();
  sw.stop();

  // Assert
  assert.deepEqual(limits, [4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 0, 0]);
});

const day = (cfg, extra) => sweepOnce(openStore(path.join(tmp(), "kb.sqlite")), { dirs: [cfg], desktop: NO_DESKTOP, wait: { maxMs: 0 }, ...extra });

test("a hook run is capped, paced and counted in the day's total", async () => {
  // Arrange
  const cfg = sessions(1, 0, "/w", 3000); // one session, several slices (50K chars each)
  const file = path.join(cfg, "projects", "-w", "s0.jsonl");
  const db = openStore(path.join(tmp(), "kb.sqlite"));
  const naps = [];
  const summarize = fake();

  // Act
  const { s } = await sweepOnce(db, { summarize, dirs: [cfg], desktop: NO_DESKTOP, ended: file, wait: { maxMs: 0, sleep: (ms) => naps.push(ms) } });

  // Assert
  assert.ok(s.slices >= 1 && s.slices <= 8);
  assert.equal(summarize.calls.length, s.slices);
  assert.equal(naps.length, s.slices - 1, "a gap between calls, none before the first");
  assert.equal(dailyUsed(db), s.slices);
});

test("a metered sweep skips scratch-dir sessions; a manual sweep and AGENT_KB_SKIP_CWD= do not", async () => {
  // Arrange
  const scratch = sessions(1, 7 * 3_600_000, "/private/var/folders/x/magpie-claude-work-501");
  const budget = { idleMs: 6 * 3_600_000, limit: 5, pauseMs: 0, maxFailures: 1 };

  // Act
  const skipped = fake();
  const a = await day(scratch, { summarize: skipped, budget });
  const manual = fake();
  await day(scratch, { summarize: manual });
  const optedOut = fake();
  await day(scratch, { summarize: optedOut, budget, env: { ...process.env, AGENT_KB_SKIP_CWD: "" } });

  // Assert
  assert.equal(skipped.calls.length, 0);
  assert.equal(a.s.automated, 1);
  assert.equal(manual.calls.length, 1);
  assert.equal(optedOut.calls.length, 1);
});

test("a budgeted tick leaves a slice under minChars; the same session is summarized without the floor", async () => {
  // Arrange
  const cfg = sessions(1, 7 * 3_600_000, "/w", 30); // about 2K chars
  const budget = { idleMs: 6 * 3_600_000, limit: 5, pauseMs: 0, maxFailures: 1, minChars: 3_000, strictMin: true };
  const floor = fake();
  const free = fake();

  // Act
  await day(cfg, { summarize: floor, budget });
  await day(cfg, { summarize: free, budget: { ...budget, minChars: 500 } });

  // Assert
  assert.equal(floor.calls.length, 0);
  assert.equal(free.calls.length, 1);
});

test("a budgeted tick skips the pins after a failed idle call", async () => {
  // Arrange
  const cfg = sessions(1, 7 * 3_600_000);
  const db = openStore(path.join(tmp(), "kb.sqlite"));
  const failing = async () => Promise.reject(new Error("429"));

  // Act
  const { s, pinned } = await sweepOnce(db, { summarize: failing, dirs: [cfg], desktop: NO_DESKTOP, wait: { maxMs: 0 }, budget: { idleMs: 6 * 3_600_000, limit: 4, pauseMs: 0, maxFailures: 1 } });

  // Assert
  assert.equal(s.failed, 1);
  assert.equal(pinned, null);
});
