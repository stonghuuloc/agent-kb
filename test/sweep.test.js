import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openStore, getDoc, acquireLock } from "../src/store.js";
import { listTranscripts, readDelta } from "../src/adapters/claude-code.js";
import { backfillTier0 } from "../src/backfill.js";
import { markGone, summarizeIdle, sweepSince } from "../src/sweep.js";
import { search } from "../src/search.js";
import { formatHits } from "../src/format.js";
import { anthropicApi, claudeCli, summarizerFromEnv, NOTHING } from "../src/summarize.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "agent-kb-sw-"));
const line = (o) => JSON.stringify(o) + "\n";
const HOUR = 3_600_000;
const pad = "x".repeat(600); // enough conversation for one slice to be worth a call

const user = (text, ts = "2026-11-01T10:00:00Z") => ({ type: "user", sessionId: "s1", cwd: "/w", timestamp: ts, message: { content: text } });
const agent = (text) => ({ type: "assistant", sessionId: "s1", message: { content: [{ type: "text", text }, { type: "tool_use", name: "Bash", input: {} }] } });

/** A transcript last written `ageMs` ago. */
function session(cfg, id, records, ageMs = 2 * HOUR) {
  const dir = path.join(cfg, "projects", "-w");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${id}.jsonl`);
  fs.writeFileSync(file, records.map(line).join(""));
  age(file, ageMs);
  return file;
}
const age = (file, ms) => fs.utimesSync(file, new Date(Date.now() - ms), new Date(Date.now() - ms));

/** A summarizer that records its inputs. */
function fake(reply = (input) => `## KNOWLEDGE\n- note ${input.length}`) {
  const calls = [];
  const fn = async (input) => {
    calls.push(input);
    return typeof reply === "function" ? reply(input) : reply;
  };
  return Object.assign(fn, { calls });
}

test("a delta holds prompts and replies after `start`, and stops before a half-written line", () => {
  // Arrange
  const file = session(tmp(), "s1", [user("first"), agent("answer one")]);
  const firstEnd = fs.statSync(file).size;
  fs.appendFileSync(file, line(user("second", "2026-11-02T10:00:00Z")) + line({ ...agent("side"), isSidechain: true }) + '{"type":"user","mess');

  // Act
  const all = readDelta(file);
  const tail = readDelta(file, firstEnd);

  // Assert
  assert.deepEqual(all.turns.map((t) => t.text), ["first", "answer one", "second"]);
  assert.deepEqual(tail.turns, [{ role: "user", text: "second" }]);
  assert.equal(tail.end, fs.statSync(file).size - '{"type":"user","mess'.length);
  assert.equal(tail.lastActivity, Date.parse("2026-11-02T10:00:00Z"));
});

test("an idle session is summarized into #w1; an active one waits; a rerun calls nothing", async () => {
  // Arrange
  const cfg = tmp();
  const idle = session(cfg, "idle", [user(`fix login ${pad}`), agent("done")]);
  session(cfg, "busy", [user(`still going ${pad}`)], 60_000);
  const db = openStore(":memory:");
  const t = listTranscripts([cfg]);
  await backfillTier0(db, t);
  const s = fake();

  // Act
  const first = await summarizeIdle(db, t, s);
  const second = await summarizeIdle(db, t, s);

  // Assert
  assert.equal(first.summarized, 1);
  assert.equal(first.active, 1);
  assert.equal(s.calls.length, 1);
  assert.equal(second.summarized, 0);
  assert.equal(s.calls.length, 1);
  const doc = getDoc(db, `${idle}#w1`);
  assert.match(doc.content, /## KNOWLEDGE/);
  assert.match(doc.title, /\(#w1\)$/);
  assert.match(doc.resume_cmd, /claude --resume s1$/);
  assert.match(getDoc(db, idle).content, /fix login/, "tier-0 row is kept beside the summary");
});

test("a resumed session gets #w2 from its new bytes only", async () => {
  // Arrange
  const cfg = tmp();
  const file = session(cfg, "s1", [user(`old topic ${pad}`)]);
  const db = openStore(":memory:");
  const s = fake();
  await summarizeIdle(db, listTranscripts([cfg]), s);
  fs.appendFileSync(file, line(user(`new topic ${pad}`, "2026-11-03T10:00:00Z")));
  age(file, 2 * HOUR);

  // Act
  const r = await summarizeIdle(db, listTranscripts([cfg]), s);

  // Assert
  assert.equal(r.summarized, 1);
  assert.match(s.calls[1], /new topic/);
  assert.doesNotMatch(s.calls[1], /old topic/);
  assert.ok(getDoc(db, `${file}#w2`));
});

test("a small slice waits without moving the cursor; NOTHING moves it without a doc", async () => {
  // Arrange
  const cfg = tmp();
  const small = session(cfg, "small", [user("hi")]);
  const empty = session(cfg, "empty", [user(`chit chat ${pad}`)]);
  const db = openStore(":memory:");

  // Act
  const r = await summarizeIdle(db, listTranscripts([cfg]), fake(NOTHING));

  // Assert
  assert.equal(r.small, 1);
  assert.equal(r.nothing, 1);
  assert.equal(db.prepare("SELECT count(*) AS n FROM cursors WHERE source_path = ?").get(small).n, 0);
  assert.equal(db.prepare("SELECT offset FROM cursors WHERE source_path = ?").get(empty).offset, fs.statSync(empty).size);
  assert.equal(getDoc(db, `${empty}#w1`), null);
});

test("a failed call keeps the cursor for a retry; three failures in a row stop the run", async () => {
  // Arrange
  const cfg = tmp();
  for (let i = 0; i < 5; i++) session(cfg, `s${i}`, [user(`topic ${i} ${pad}`)]);
  const db = openStore(":memory:");
  const broken = fake(() => {
    throw new Error("no key");
  });

  // Act
  const r = await summarizeIdle(db, listTranscripts([cfg]), broken);

  // Assert
  assert.equal(r.failed, 3);
  assert.equal(broken.calls.length, 3);
  assert.equal(r.error, "no key");
  assert.deepEqual(db.prepare("SELECT DISTINCT offset, failures FROM cursors").all().map((r) => ({ ...r })), [{ offset: 0, failures: 0 }], "an outage counts against no file");
});

test("a long idle delta becomes several slices; no middle is skipped", async () => {
  // Arrange
  const cfg = tmp();
  const turn = (tag, n) => `${tag}-start ` + "y".repeat(n) + ` ${tag}-end`;
  const file = session(cfg, "long", [user(turn("HEAD", 45_000)), user(turn("MIDDLE", 25_000)), user(turn("TAIL", 1_000))]);
  const db = openStore(":memory:");
  const s = fake();

  // Act
  const r = await summarizeIdle(db, listTranscripts([cfg]), s);

  // Assert
  assert.equal(r.summarized, 2);
  for (const tag of ["HEAD-start", "HEAD-end"]) assert.ok(s.calls[0].includes(tag), tag);
  for (const tag of ["MIDDLE-start", "MIDDLE-end", "TAIL-start", "TAIL-end"]) assert.ok(s.calls[1].includes(tag), tag);
  assert.ok(s.calls.every((c) => !c.includes("…")), "no slice is clipped");
  assert.ok(getDoc(db, `${file}#w2`));
  assert.equal(db.prepare("SELECT offset FROM cursors").get().offset, fs.statSync(file).size);
});

test("files that keep failing wait a week, so older sessions are still summarized", async () => {
  // Arrange
  const cfg = tmp();
  for (let i = 0; i < 3; i++) session(cfg, `poison${i}`, [user(`POISON ${i} ${pad}`)], 2 * HOUR);
  const good = session(cfg, "good", [user(`fine ${pad}`)], 5 * HOUR);
  const db = openStore(":memory:");
  const s = fake((input) => {
    if (input.includes("POISON")) throw new Error("refused (cyber)");
    return "## KNOWLEDGE\n- ok";
  });
  const t = listTranscripts([cfg]);

  const at = (h) => ({ now: Date.now() + h * HOUR });
  const failures = () => db.prepare("SELECT failures FROM cursors WHERE source_path LIKE '%poison%'").all().map((r) => r.failures);

  // Act
  const first = await summarizeIdle(db, t, s, at(0));
  const second = await summarizeIdle(db, t, s, at(2));
  const counted = failures();
  const soon = await summarizeIdle(db, t, s, at(2.5));
  db.prepare("UPDATE cursors SET failures = 3 WHERE source_path LIKE '%poison%'").run();
  const days = await summarizeIdle(db, t, s, at(3 * 24));
  const weekLater = await summarizeIdle(db, t, s, at(8 * 24));

  // Assert
  assert.equal(first.failed, 3);
  assert.equal(first.summarized, 0, "nothing else succeeded, so the failures do not count yet");
  assert.equal(second.summarized, 1, "failed files go last, so the older session is summarized");
  assert.ok(getDoc(db, `${good}#w1`));
  assert.deepEqual(counted, [1, 1, 1], "counted: another call in that run worked");
  assert.equal(soon.backoff, 3, "an hour between tries");
  assert.equal(days.backoff, 3, "a week after 3 counted failures");
  assert.equal(weekLater.failed, 3, "retried after the week");
});

test("a run stops when its lock expired and another process took it", async () => {
  // Arrange
  const cfg = tmp();
  session(cfg, "a", [user(`a ${pad}`)], 2 * HOUR);
  session(cfg, "b", [user(`b ${pad}`)], 3 * HOUR);
  const db = openStore(":memory:");
  const s = fake(() => {
    db.prepare("UPDATE locks SET owner = 'other', expires_ms = ?").run(Date.now() + 60_000); // a slow call outlived the TTL
    return "## KNOWLEDGE\n- x";
  });

  // Act
  const r = await summarizeIdle(db, listTranscripts([cfg]), s);

  // Assert
  assert.equal(s.calls.length, 1);
  assert.equal(r.locked, true);
  assert.equal(db.prepare("SELECT owner FROM locks").get().owner, "other", "the new owner keeps its lock");
  assert.equal(db.prepare("SELECT count(*) AS n FROM documents").get().n, 0, "the late note is dropped");
  assert.equal(db.prepare("SELECT count(*) AS n FROM cursors").get().n, 0, "the new owner summarizes this slice");
});

test("a run whose call outlived its lock writes nothing after another process finished the file", async () => {
  // Arrange
  const cfg = tmp();
  const turn = (tag) => `${tag} ` + "q".repeat(30_000);
  const file = session(cfg, "s1", [user(turn("ONE")), user(turn("TWO")), user(turn("THREE"))]);
  const db = openStore(":memory:");
  const t = listTranscripts([cfg]);
  const b = fake((input) => `## KNOWLEDGE\n- B ${input.slice(0, 5)}`);
  const a = fake(async () => {
    db.prepare("UPDATE locks SET expires_ms = 0").run(); // A slept past the TTL
    await summarizeIdle(db, t, b); // B takes the lock, does the whole file, releases it
    return "## KNOWLEDGE\n- A late";
  });

  // Act
  const r = await summarizeIdle(db, t, a);

  // Assert
  assert.equal(r.locked, true);
  assert.equal(a.calls.length, 1);
  assert.equal(b.calls.length, 3);
  assert.deepEqual({ ...db.prepare("SELECT offset, chunks FROM cursors").get() }, { offset: fs.statSync(file).size, chunks: 3 });
  assert.match(getDoc(db, `${file}#w1`).content, /- B /);
  assert.equal(db.prepare("SELECT count(*) AS n FROM locks").get().n, 0, "A does not re-take the released lock");
});

test("the sweep window starts a day before the first sweep and then stays put", async () => {
  // Arrange
  const cfg = tmp();
  session(cfg, "recent", [user(`r ${pad}`)], 2 * HOUR);
  session(cfg, "history", [user(`h ${pad}`)], 3 * 24 * HOUR);
  const db = openStore(":memory:");
  const s = fake();

  // Act
  const first = sweepSince(db, 1_000_000_000);
  const second = sweepSince(db, 2_000_000_000);
  db.prepare("DELETE FROM meta").run();
  const r = await summarizeIdle(db, listTranscripts([cfg]), s, { since: sweepSince(db) });

  // Assert
  assert.equal(first, 1_000_000_000 - 24 * HOUR);
  assert.equal(second, first);
  assert.equal(r.summarized, 1);
  assert.equal(r.old, 1);
});

test("a short prompt before one huge line joins its slice, so the file never stalls on a small slice", async () => {
  // Arrange
  const cfg = tmp();
  const file = session(cfg, "s1", [user("short question"), user("z".repeat(70_000))]);
  const db = openStore(":memory:");
  const s = fake();

  // Act
  const r = await summarizeIdle(db, listTranscripts([cfg]), s);

  // Assert
  assert.equal(r.summarized, 1);
  assert.match(s.calls[0], /short question/);
  assert.equal(db.prepare("SELECT offset FROM cursors").get().offset, fs.statSync(file).size);
});

test("a slice that fails after an earlier success in the same run counts one failure, not the old total", async () => {
  // Arrange
  const cfg = tmp();
  const file = session(cfg, "s1", [user("a".repeat(45_000)), user("REJECT " + "b".repeat(20_000))]);
  const db = openStore(":memory:");
  db.prepare("INSERT INTO cursors (source_path, offset, chunks, failures, failed_ts) VALUES (?, 0, 0, 2, 1)").run(file);
  const s = fake((input) => {
    if (input.includes("REJECT")) throw new Error("refused");
    return "## KNOWLEDGE\n- a";
  });

  // Act
  await summarizeIdle(db, listTranscripts([cfg]), s);

  // Assert
  assert.equal(db.prepare("SELECT failures FROM cursors").get().failures, 1);
});

test("an estimate never writes a cursor, even for a file it cannot read", { skip: process.platform === "win32" || process.getuid?.() === 0 }, async () => {
  // Arrange
  const cfg = tmp();
  const file = session(cfg, "locked", [user(`a ${pad}`)]);
  fs.chmodSync(file, 0o000);
  const db = openStore(":memory:");

  // Act
  const r = await summarizeIdle(db, listTranscripts([cfg]), null);
  fs.chmodSync(file, 0o644);

  // Assert
  assert.equal(r.failed, 1);
  assert.equal(db.prepare("SELECT count(*) AS n FROM cursors").get().n, 0);
});

test("secrets are redacted before the model sees the slice", async () => {
  // Arrange
  const cfg = tmp();
  const secret = "ghp_" + "aB3dE9xK2m".repeat(4);
  session(cfg, "s1", [user(`push with ${secret} ${pad}`), agent(`used DB_PASSWORD=Zt7pQ2wLm9aB3dE9 ok`)]);
  const db = openStore(":memory:");
  const s = fake();

  // Act
  await summarizeIdle(db, listTranscripts([cfg]), s);

  // Assert
  assert.equal(s.calls.length, 1);
  assert.ok(!s.calls[0].includes(secret) && !s.calls[0].includes("Zt7pQ2wLm9"), s.calls[0].slice(0, 200));
});

test("an estimate calls nothing, writes nothing, and honours --since and --limit", async () => {
  // Arrange
  const cfg = tmp();
  session(cfg, "new1", [user(`a ${pad}`)], 2 * HOUR);
  session(cfg, "new2", [user(`b ${pad}`)], 3 * HOUR);
  session(cfg, "old", [user(`c ${pad}`)], 40 * 24 * HOUR);
  const db = openStore(":memory:");
  const t = listTranscripts([cfg]);

  // Act
  const recent = await summarizeIdle(db, t, null, { since: Date.now() - 30 * 24 * HOUR });
  const one = await summarizeIdle(db, t, null, { limit: 1 });

  // Assert
  assert.equal(recent.slices, 2);
  assert.equal(recent.old, 1);
  assert.ok(recent.inputChars > 600);
  assert.equal(one.slices, 1);
  assert.equal(db.prepare("SELECT count(*) AS n FROM cursors").get().n, 0);
  assert.equal(db.prepare("SELECT count(*) AS n FROM documents").get().n, 0);
});

test("a second summarizer waits while another process holds the lock", async () => {
  // Arrange
  const cfg = tmp();
  session(cfg, "s1", [user(`a ${pad}`)]);
  const db = openStore(":memory:");
  acquireLock(db, "summarize", "other-process", 60_000);
  const s = fake();

  // Act
  const r = await summarizeIdle(db, listTranscripts([cfg]), s);

  // Assert
  assert.equal(r.locked, true);
  assert.equal(s.calls.length, 0);
});

test("a deleted transcript flags its docs as gone, and a restored one clears the flag", async () => {
  // Arrange
  const cfg = tmp();
  const file = session(cfg, "s1", [user(`a ${pad}`)]);
  const db = openStore(":memory:");
  await backfillTier0(db, listTranscripts([cfg]));
  await summarizeIdle(db, listTranscripts([cfg]), fake());
  const saved = fs.readFileSync(file);

  // Act
  fs.rmSync(file);
  const goneCount = markGone(db);
  const flags = [getDoc(db, file).transcript_gone, getDoc(db, `${file}#w1`).transcript_gone];
  const goneHits = formatHits(search(db, "KNOWLEDGE"));
  fs.writeFileSync(file, saved);
  const backCount = markGone(db);

  // Assert
  assert.equal(goneCount, 2);
  assert.deepEqual(flags, [1, 1]);
  assert.match(goneHits, /resume: transcript deleted/);
  assert.doesNotMatch(goneHits, /claude --resume/);
  assert.equal(backCount, 0);
  assert.equal(getDoc(db, file).transcript_gone, 0);
  assert.match(getDoc(db, `${file}#w1`).content, /KNOWLEDGE/, "summaries outlive the transcript");
});

/** A stand-in `claude` that records its argv and stdin, then prints `reply`. */
function fakeClaude(reply, exit = 0) {
  const dir = tmp();
  const bin = path.join(dir, "claude");
  const log = path.join(dir, "log.json");
  fs.writeFileSync(
    bin,
    `#!/usr/bin/env node
let input = "";
process.stdin.on("data", (d) => (input += d)).on("end", () => {
  require("fs").writeFileSync(${JSON.stringify(log)}, JSON.stringify({ argv: process.argv.slice(2), input }));
  process.stdout.write(${JSON.stringify(reply)});
  process.exit(${exit});
});
`,
  );
  fs.chmodSync(bin, 0o755);
  return { bin, read: () => JSON.parse(fs.readFileSync(log, "utf8")) };
}

test("the claude CLI backend runs without tools, MCP, hooks or a session file", { skip: process.platform === "win32" }, async () => {
  // Arrange
  const c = fakeClaude(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "## OPEN\n- x" }));

  // Act
  const out = await claudeCli({ bin: c.bin, model: "m1" })("the slice");

  // Assert
  const { argv, input } = c.read();
  assert.equal(out, "## OPEN\n- x");
  assert.equal(input, "the slice");
  for (const flag of ["-p", "--no-session-persistence", "--strict-mcp-config"]) assert.ok(argv.includes(flag), flag);
  assert.equal(argv[argv.indexOf("--tools") + 1], "");
  assert.equal(argv[argv.indexOf("--setting-sources") + 1], "");
  assert.equal(argv[argv.indexOf("--model") + 1], "m1");
});

test("the claude CLI backend rejects an error result, bad output and a missing binary", { skip: process.platform === "win32" }, async () => {
  // Arrange
  const errored = fakeClaude(JSON.stringify({ subtype: "error_during_execution", is_error: true, result: "auth" }));
  const garbage = fakeClaude("not json", 1);

  // Act + Assert
  await assert.rejects(claudeCli({ bin: errored.bin })("x"), /error_during_execution/);
  await assert.rejects(claudeCli({ bin: garbage.bin })("x"), /exited 1/);
  await assert.rejects(claudeCli({ bin: path.join(tmp(), "nope") })("x"), /ENOENT/);
});

test("a hung claude CLI is cut off at the timeout", { skip: process.platform === "win32" }, async () => {
  // Arrange
  const bin = path.join(tmp(), "claude");
  fs.writeFileSync(bin, "#!/bin/sh\nsleep 30\n", { mode: 0o755 });

  // Act + Assert
  await assert.rejects(claudeCli({ bin, timeoutMs: 300 })("x"), /timed out/);
});

test("the API backend returns the text blocks and throws on a refusal", async () => {
  // Arrange
  const requests = [];
  const client = (res) => ({ messages: { create: async (r) => (requests.push(r), res) } });
  const ok = anthropicApi({ client: client({ stop_reason: "end_turn", content: [{ type: "thinking", thinking: "" }, { type: "text", text: "## FILES\n- a.js" }] }) });
  const refused = anthropicApi({ client: client({ stop_reason: "refusal", stop_details: { category: "cyber" }, content: [] }) });

  // Act
  const out = await ok("slice");

  // Assert
  assert.equal(out, "## FILES\n- a.js");
  assert.equal(requests[0].model, "claude-haiku-5-5");
  assert.deepEqual(requests[0].messages, [{ role: "user", content: "slice" }]);
  await assert.rejects(refused("slice"), /refused \(cyber\)/);
});

test("no summarizer unless AGENT_KB_SUMMARIZER names one", () => {
  // Act + Assert
  assert.equal(summarizerFromEnv({}), null);
  assert.equal(summarizerFromEnv({ AGENT_KB_SUMMARIZER: "yes" }), null);
  assert.equal(typeof summarizerFromEnv({ AGENT_KB_SUMMARIZER: "claude" }), "function");
  assert.equal(typeof summarizerFromEnv({ AGENT_KB_SUMMARIZER: "api" }), "function");
});
