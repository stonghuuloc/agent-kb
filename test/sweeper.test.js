import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { openStore, getDoc, acquireLock, releaseLock } from "../src/store.js";
import { claimTick, sweepOnce } from "../src/sweep.js";
import { startSweeper } from "../src/sweeper.js";
import { sessionEnd } from "../src/hooks.js";

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
});
