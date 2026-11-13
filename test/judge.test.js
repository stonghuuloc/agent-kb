import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { getDoc, openStore, upsertDoc } from "../src/store.js";
import { listTranscripts } from "../src/adapters/claude-code.js";
import { backfillTier0 } from "../src/backfill.js";
import { summarizeIdle, summarizePinned } from "../src/sweep.js";
import { createServer } from "../src/mcp.js";
import { AUC_GATE, auc, dismiss, evaluate, listJudgments, logJudgment, pin, setTruth } from "../src/eval.js";
import { Judges, claudeJudge, heuristicJudge, judgeConfig, parseJudgment, scanConflicts } from "../src/judge.js";

const CLI = fileURLToPath(new URL("../bin/agent-kb.js", import.meta.url));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "agent-kb-jg-"));
const HOUR = 3_600_000;
const pad = "x".repeat(600);
const line = (o) => JSON.stringify(o) + "\n";
const user = (text) => ({ type: "user", sessionId: "s1", cwd: "/w", timestamp: "2026-11-01T10:00:00Z", message: { content: text } });
const agent = (text) => ({ type: "assistant", sessionId: "s1", message: { content: [{ type: "text", text }] } });

function session(cfg, id, records) {
  const dir = path.join(cfg, "projects", "-w");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${id}.jsonl`);
  fs.writeFileSync(file, records.map(line).join(""));
  fs.utimesSync(file, new Date(Date.now() - 2 * HOUR), new Date(Date.now() - 2 * HOUR));
  return file;
}

function fake(reply = "## KNOWLEDGE\n- note") {
  const calls = [];
  return Object.assign(async (input) => (calls.push(input), reply), { calls });
}

/** Judgments of `point`/`backend` that put its gate at AUC 1 over 30 labels. */
function openGate(db, point, backend = "heuristic") {
  for (let i = 0; i < 30; i++) {
    const id = logJudgment(db, { point, docs: [`seed${i}`], backend, score: i % 2 ? 0.9 : 0.1, label: "x" });
    setTruth(db, id, i % 2 ? "yes" : "no");
  }
}

const judgesWith = (db, points, fn, backend = "heuristic") => new Judges(db, new Set(points), backend, async (point, input) => fn(point, input));
const rows = (pos, neg) => [...pos.map((score) => ({ score, positive: true })), ...neg.map((score) => ({ score, positive: false }))];

async function idleSlice(db, cfg) {
  const file = session(cfg, "s1", [user(`fix login ${pad}`), agent("done")]);
  const t = listTranscripts([cfg]);
  await backfillTier0(db, t);
  return { file, t };
}

test("AUC matches hand-computed fixtures: separation, inversion, mixed, ties, one class", () => {
  // Arrange
  // mixed: pos [.8,.4] vs neg [.6,.2] wins 3 of 4 pairs; ties: pos [.5,.9] vs neg [.5,.1] = (0.5+1+1+1)/4
  const cases = [
    [rows([0.9, 0.8], [0.2, 0.1]), 1],
    [rows([0.2, 0.1], [0.9, 0.8]), 0],
    [rows([0.8, 0.4], [0.6, 0.2]), 0.75],
    [rows([0.5, 0.9], [0.5, 0.1]), 0.875],
    [rows([0.5, 0.5, 0.5], [0.5, 0.5]), 0.5],
    [rows([0.3, 0.7, 0.7], [0.3, 0.7]), 7 / 12], // pos .3: tie, loss; each pos .7: win, tie
  ];

  // Act
  const got = cases.map(([r]) => auc(r));

  // Assert
  got.forEach((g, i) => assert.ok(Math.abs(g - cases[i][1]) < 1e-12, `case ${i}: ${g} != ${cases[i][1]}`));
  assert.equal(auc(rows([0.9, 0.1], [])), null);
  assert.equal(auc(rows([], [0.9, 0.1])), null);
  assert.equal(auc([]), null);
});

test("a point stays off below 30 labels, below 8 of one answer, and below AUC 0.85, and says why", () => {
  // Arrange
  const db = openStore(":memory:");
  const label = (point, n, yes, scoreOf) => {
    for (let i = 0; i < n; i++) {
      const id = logJudgment(db, { point, docs: [`${point}${i}`], backend: "heuristic", score: scoreOf(i < yes), label: "x" });
      setTruth(db, id, i < yes ? "yes" : "no");
    }
  };
  label("triage", 29, 15, (y) => (y ? 0.9 : 0.1)); // perfect, one label short
  label("conflict", 30, 25, (y) => (y ? 0.9 : 0.1)); // perfect, only 5 "no"
  label("kind", 30, 15, (y) => (y ? 0.9 : 0.1)); // perfect, enough
  for (let i = 0; i < 3; i++) db.prepare("UPDATE judgments SET score = 0.95 WHERE point = 'kind' AND truth = 'no' AND id = (SELECT id FROM judgments WHERE point = 'kind' AND truth = 'no' AND score = 0.1 LIMIT 1)").run(); // 3 of 15 "no" outrank every "yes": AUC 0.8

  // Act
  const v = Object.fromEntries(evaluate(db).map((r) => [r.point, r]));

  // Assert
  assert.equal(v.triage.enabled, false);
  assert.match(v.triage.reason, /needs 30 labelled judgments, has 29/);
  assert.equal(v.conflict.enabled, false);
  assert.match(v.conflict.reason, /needs 8 of each answer, has 25 yes \/ 5 no/);
  assert.ok(Math.abs(v.kind.auc - 0.8) < 1e-12);
  assert.equal(v.kind.enabled, false);
  assert.match(v.kind.reason, /AUC 0\.800 is below 0\.85/);
  assert.equal(AUC_GATE, 0.85);
});

test("a point turns on at 30 labels with both answers and AUC 0.9, per backend", () => {
  // Arrange
  const db = openStore(":memory:");
  openGate(db, "triage", "heuristic");
  for (let i = 0; i < 5; i++) logJudgment(db, { point: "triage", docs: ["u"], backend: "claude", score: 0.5, label: "keep" });

  // Act
  const v = evaluate(db);

  // Assert
  const h = v.find((r) => r.backend === "heuristic");
  assert.deepEqual([h.enabled, h.auc, h.n, h.pos, h.neg], [true, 1, 30, 15, 15]);
  const c = v.find((r) => r.backend === "claude");
  assert.deepEqual([c.enabled, c.n, c.logged], [false, 0, 5]);
  assert.match(c.reason, /has 0/);
});

test("triage skips only with its gate open: the model is not called, nothing is deleted or overwritten", async () => {
  // Arrange
  const cfg = tmp();
  const db = openStore(":memory:");
  const { file, t } = await idleSlice(db, cfg);
  const before = { ...getDoc(db, file) };
  openGate(db, "triage");
  const judges = judgesWith(db, ["triage"], () => ({ score: 0.1, label: "skip", reason: "chatter" }));
  const s = fake();

  // Act
  const r = await summarizeIdle(db, t, s, { judges });

  // Assert
  assert.equal(s.calls.length, 0);
  assert.deepEqual([r.skipped, r.summarized, r.slices], [1, 0, 1], "a skipped slice still counts against --limit");
  assert.deepEqual({ ...getDoc(db, file) }, before, "the tier-0 doc is untouched");
  assert.equal(db.prepare("SELECT count(*) AS n FROM documents").get().n, 1);
  assert.equal(db.prepare("SELECT offset FROM cursors").get().offset, fs.statSync(file).size);
  const j = listJudgments(db, { point: "triage", open: true })[0];
  assert.deepEqual([j.acted, j.label, j.docs, j.slice_start, j.slice_end], [1, "skip", [file], 0, fs.statSync(file).size]);
});

test("with the gate closed triage only logs: the slice is summarized as if judging were off", async () => {
  // Arrange
  const cfg = tmp();
  const db = openStore(":memory:");
  const { file, t } = await idleSlice(db, cfg);
  const judges = judgesWith(db, ["triage"], () => ({ score: 0.1, label: "skip", reason: "chatter" }));
  const s = fake();

  // Act
  const r = await summarizeIdle(db, t, s, { judges });

  // Assert
  assert.equal(s.calls.length, 1);
  assert.deepEqual([r.skipped, r.summarized], [0, 1]);
  assert.ok(getDoc(db, `${file}#w1`));
  const j = listJudgments(db, { point: "triage" });
  assert.deepEqual([j.length, j[0].acted, j[0].label], [1, 0, "skip"]);
});

test("a judge that throws leaves the slice to be summarized and logs nothing", async () => {
  // Arrange
  const cfg = tmp();
  const db = openStore(":memory:");
  const { file, t } = await idleSlice(db, cfg);
  openGate(db, "triage");
  const judges = judgesWith(db, ["triage", "kind"], () => {
    throw new Error("judge down");
  });
  const s = fake();

  // Act
  const r = await summarizeIdle(db, t, s, { judges });

  // Assert
  assert.deepEqual([r.summarized, r.skipped, r.failed], [1, 0, 0]);
  assert.equal(getDoc(db, `${file}#w1`).tier, "episodic");
  assert.equal(listJudgments(db, { point: "triage" }).filter((j) => j.docs[0] === file).length, 0);
});

test("pin answers yes on the skipped slice, and the next sweep summarizes exactly that slice once", async () => {
  // Arrange
  const cfg = tmp();
  const db = openStore(":memory:");
  const { file, t } = await idleSlice(db, cfg);
  openGate(db, "triage");
  const judges = judgesWith(db, ["triage"], () => ({ score: 0.1, label: "skip", reason: "chatter" }));
  await summarizeIdle(db, t, fake(), { judges });
  const s = fake("## DECISIONS\n- brought back");

  // Act
  const { ids, queued } = pin(db, `${file}#w3`);
  const first = await summarizePinned(db, s);
  const second = await summarizePinned(db, s);

  // Assert
  assert.equal(ids.length, 1);
  assert.deepEqual(queued, ids);
  assert.deepEqual([first.summarized, first.lost, second.summarized], [1, 0, 0]);
  assert.equal(s.calls.length, 1);
  assert.match(s.calls[0], /fix login/);
  assert.equal(getDoc(db, `${file}#w1`).content, "## DECISIONS\n- brought back");
  assert.equal(db.prepare("SELECT chunks FROM cursors").get().chunks, 1);
  assert.equal(db.prepare("SELECT truth, redone FROM judgments WHERE acted = 1").get().truth, "yes");
  assert.deepEqual(pin(db, file), { ids: [], queued: [] }, "nothing left to pin");
});

test("a pinned slice whose transcript changed is given up, not rebuilt from other bytes", async () => {
  // Arrange
  const cfg = tmp();
  const db = openStore(":memory:");
  const { file, t } = await idleSlice(db, cfg);
  openGate(db, "triage");
  await summarizeIdle(db, t, fake(), { judges: judgesWith(db, ["triage"], () => ({ score: 0.1, label: "skip", reason: "" })) });
  pin(db, file);
  fs.writeFileSync(file, line(user("a different, much shorter file")));
  const s = fake();

  // Act
  const r = await summarizePinned(db, s);

  // Assert
  assert.deepEqual([r.lost, r.summarized, s.calls.length], [1, 0, 0]);
  assert.equal(getDoc(db, `${file}#w1`), null);
});

test("a pinned slice rewritten with the same length is given up: its bytes no longer match the skip", async () => {
  // Arrange
  const cfg = tmp();
  const db = openStore(":memory:");
  const { file, t } = await idleSlice(db, cfg);
  openGate(db, "triage");
  await summarizeIdle(db, t, fake(), { judges: judgesWith(db, ["triage"], () => ({ score: 0.1, label: "skip", reason: "" })) });
  pin(db, file);
  const text = fs.readFileSync(file, "utf8");
  fs.writeFileSync(file, text.replace("fix login", "fix lagin"));
  const s = fake();

  // Act
  const r = await summarizePinned(db, s);

  // Assert
  assert.equal(fs.statSync(file).size, Buffer.byteLength(text));
  assert.deepEqual([r.lost, r.summarized, s.calls.length], [1, 0, 0]);
});

test("pin labels a skip judged while the gate was closed, but queues only acted skips", async () => {
  // Arrange
  const cfg = tmp();
  const db = openStore(":memory:");
  const { file, t } = await idleSlice(db, cfg);
  await summarizeIdle(db, t, fake(), { judges: judgesWith(db, ["triage"], () => ({ score: 0.1, label: "skip", reason: "" })) });

  // Act
  const { ids, queued } = pin(db, file);

  // Assert
  assert.equal(ids.length, 1);
  assert.deepEqual(queued, []);
  assert.equal(listJudgments(db, { point: "triage" })[0].truth, "yes");
});

test("a pinned slice is rebuilt exactly even after the session grew", async () => {
  // Arrange
  const cfg = tmp();
  const db = openStore(":memory:");
  const { file, t } = await idleSlice(db, cfg);
  openGate(db, "triage");
  await summarizeIdle(db, t, fake(), { judges: judgesWith(db, ["triage"], () => ({ score: 0.1, label: "skip", reason: "" })) });
  pin(db, file);
  fs.appendFileSync(file, line(user("a later question")) + line(agent("a later answer")));
  const s = fake();

  // Act
  const r = await summarizePinned(db, s);

  // Assert
  assert.deepEqual([r.summarized, r.lost], [1, 0]);
  assert.match(s.calls[0], /fix login/);
  assert.doesNotMatch(s.calls[0], /later question/);
});

test("a pin whose transcript or cursor is gone is given up, and does not block the next pin", async () => {
  // Arrange
  const cfg = tmp();
  const db = openStore(":memory:");
  const a = await idleSlice(db, cfg);
  const second = session(cfg, "s2", [user(`other work ${pad}`), agent("ok")]);
  const t2 = listTranscripts([cfg]);
  await backfillTier0(db, t2);
  openGate(db, "triage");
  await summarizeIdle(db, t2, fake(), { judges: judgesWith(db, ["triage"], () => ({ score: 0.1, label: "skip", reason: "" })) });
  pin(db, a.file);
  pin(db, second);
  fs.unlinkSync(a.file);
  const s = fake();

  // Act
  const r = await summarizePinned(db, s);
  db.prepare("DELETE FROM cursors WHERE source_path = ?").run(second);
  const again = await summarizePinned(db, s);

  // Assert
  assert.deepEqual([r.lost, r.summarized, r.failed], [1, 1, 0]);
  assert.deepEqual([again.lost, again.summarized], [0, 0]);
  assert.equal(db.prepare("SELECT count(*) AS n FROM judgments WHERE redone = 0 AND acted = 1").get().n, 0);
});

test("a pin whose cursor row is gone (folded alias) is given up and the next pin still runs", async () => {
  // Arrange
  const cfg = tmp();
  const db = openStore(":memory:");
  const a = await idleSlice(db, cfg);
  const second = session(cfg, "s2", [user(`other work ${pad}`), agent("ok")]);
  await backfillTier0(db, listTranscripts([cfg]));
  openGate(db, "triage");
  await summarizeIdle(db, listTranscripts([cfg]), fake(), { judges: judgesWith(db, ["triage"], () => ({ score: 0.1, label: "skip", reason: "" })) });
  pin(db, a.file);
  pin(db, second);
  db.prepare("DELETE FROM cursors WHERE source_path = ?").run(a.file);

  const s = fake();

  // Act
  const r = await summarizePinned(db, s);

  // Assert
  assert.deepEqual([r.lost, r.summarized, r.locked], [1, 1, false]);
  assert.equal(s.calls.length, 1, "no model call is spent on the orphaned slice");
});

test("a pin that always errors is given up after 3 tries and never blocks a later pin", async () => {
  // Arrange
  const cfg = tmp();
  const db = openStore(":memory:");
  const a = await idleSlice(db, cfg);
  const b = session(cfg, "s2", [user(`other work ${pad}`), agent("ok")]);
  const t = listTranscripts([cfg]);
  await backfillTier0(db, t);
  openGate(db, "triage");
  await summarizeIdle(db, t, fake(), { judges: judgesWith(db, ["triage"], () => ({ score: 0.1, label: "skip", reason: "" })) });
  pin(db, a.file);
  pin(db, b);
  const picky = async (input) => {
    if (/fix login/.test(input)) throw new Error("always fails");
    return "## KNOWLEDGE\n- ok";
  };
  const now = Date.now();

  // Act
  const r1 = await summarizePinned(db, picky, now);
  const r2 = await summarizePinned(db, picky, now + 2 * HOUR);
  const r3 = await summarizePinned(db, picky, now + 4 * HOUR);

  // Assert
  assert.deepEqual([r1.summarized, r1.failed, r1.lost], [1, 1, 0], "B is processed past the failing A");
  assert.deepEqual([r2.failed, r3.failed, r3.lost], [1, 1, 1]);
  assert.equal(db.prepare("SELECT count(*) AS n FROM judgments WHERE acted = 1 AND redone = 0").get().n, 0);
});

test("failures with a NOTHING between them are not a run: a later readable pin is still processed", async () => {
  // Arrange
  const cfg = tmp();
  const db = openStore(":memory:");
  const names = ["bad1", "none1", "bad2", "none2", "bad3", "good"];
  const files = names.map((n, i) => {
    const f = session(cfg, n, [user(`${n} work ${pad}`), agent("ok")]);
    const at = new Date(Date.now() - 2 * HOUR - i * 60_000); // newest first = this order
    fs.utimesSync(f, at, at);
    return f;
  });
  const t = listTranscripts([cfg]);
  await backfillTier0(db, t);
  openGate(db, "triage");
  await summarizeIdle(db, t, fake(), { judges: judgesWith(db, ["triage"], () => ({ score: 0.1, label: "skip", reason: "" })) });
  for (const f of files) pin(db, f);
  const reply = async (input) => {
    if (/bad\d work/.test(input)) throw new Error("fails");
    return /none\d work/.test(input) ? "NOTHING" : "## KNOWLEDGE\n- kept";
  };

  // Act
  const r = await summarizePinned(db, reply);

  // Assert
  assert.deepEqual([r.failed, r.nothing, r.summarized], [3, 2, 1]);
});

test("a model error on a pinned slice backs off for an hour instead of retrying every sweep", async () => {
  // Arrange
  const cfg = tmp();
  const db = openStore(":memory:");
  const { file, t } = await idleSlice(db, cfg);
  openGate(db, "triage");
  await summarizeIdle(db, t, fake(), { judges: judgesWith(db, ["triage"], () => ({ score: 0.1, label: "skip", reason: "" })) });
  pin(db, file);
  const down = async () => {
    throw new Error("rate limited");
  };
  const up = fake();
  const now = Date.now();

  // Act
  const first = await summarizePinned(db, down, now);
  const soon = await summarizePinned(db, up, now + 60_000);
  const later = await summarizePinned(db, up, now + 2 * HOUR);

  // Assert
  assert.deepEqual([first.failed, first.error], [1, "rate limited"]);
  assert.deepEqual([soon.backoff, up.calls.length === 1], [true, true]);
  assert.equal(later.summarized, 1);
});

test("kind tagging stores the judge's kind only with its gate open, and logs either way", async () => {
  // Arrange
  const fn = (point) => (point === "kind" ? { score: 0.9, label: "semantic", reason: "facts" } : { score: 0.9, label: "keep", reason: "" });
  const run = async (open) => {
    const cfg = tmp();
    const db = openStore(":memory:");
    const { file, t } = await idleSlice(db, cfg);
    if (open) openGate(db, "kind");
    await summarizeIdle(db, t, fake(), { judges: judgesWith(db, ["kind"], fn) });
    return { tier: getDoc(db, `${file}#w1`).tier, j: listJudgments(db, { point: "kind" }).filter((x) => x.docs[0] === `${file}#w1`) };
  };

  // Act
  const off = await run(false);
  const on = await run(true);

  // Assert
  assert.equal(off.tier, "episodic");
  assert.deepEqual([off.j[0].label, off.j[0].acted], ["semantic", 0]);
  assert.equal(on.tier, "semantic");
  assert.deepEqual([on.j[0].label, on.j[0].acted], ["semantic", 1]);
});

const noteA = "## KNOWLEDGE\n- the billing sync job should enable retries for webhook delivery failures\n";
const noteB = "## KNOWLEDGE\n- the billing sync job should disable retries for webhook delivery failures\n";

test("conflict scan flags a contradicting neighbour once, changes no note, and dismiss answers no", async () => {
  // Arrange
  const db = openStore(":memory:");
  upsertDoc(db, { source_path: "/t/a.jsonl#w1", source_type: "claude-code", tier: "episodic", title: "billing retries", content: noteA });
  upsertDoc(db, { source_path: "/t/b.jsonl#w1", source_type: "claude-code", tier: "episodic", title: "billing retries", content: noteB });
  upsertDoc(db, { source_path: "/t/c.jsonl", source_type: "claude-code", tier: "episodic", title: "billing retries", content: noteB }); // a tier-0 doc, not a note
  const judges = judgesWith(db, ["conflict"], (p, i) => heuristicJudge(p, i));
  const before = [getDoc(db, "/t/a.jsonl#w1"), getDoc(db, "/t/b.jsonl#w1")].map((d) => d.content);

  // Act
  const first = await scanConflicts(db, judges, "/t/b.jsonl#w1");
  const again = await scanConflicts(db, judges, "/t/b.jsonl#w1");

  // Assert
  assert.deepEqual([first, again], [1, 0]);
  const [j] = listJudgments(db, { point: "conflict" });
  assert.deepEqual([j.docs, j.label, j.acted, j.truth], [["/t/a.jsonl#w1", "/t/b.jsonl#w1"], "contradict", 0, null]);
  assert.deepEqual([getDoc(db, "/t/a.jsonl#w1"), getDoc(db, "/t/b.jsonl#w1")].map((d) => d.content), before);
  assert.equal(dismiss(db, j.id), true);
  assert.equal(listJudgments(db, { point: "conflict" })[0].truth, "no");
  assert.equal(dismiss(db, 999), false);
});

test("conflict scan judges a pair again when either text changes, even in the same millisecond, and not for a title-only write", async () => {
  // Arrange
  const db = openStore(":memory:");
  const T0 = Date.UTC(2026, 10, 1);
  const b = (content, title = "billing retries", at = T0) => upsertDoc(db, { source_path: "/t/b.jsonl#w1", source_type: "claude-code", tier: "episodic", title, content }, at);
  upsertDoc(db, { source_path: "/t/a.jsonl#w1", source_type: "claude-code", tier: "episodic", title: "billing retries", content: noteA }, T0);
  b(noteB);
  const judges = judgesWith(db, ["conflict"], (p, i) => heuristicJudge(p, i));
  const first = await scanConflicts(db, judges, "/t/b.jsonl#w1");
  dismiss(db, listJudgments(db, { point: "conflict" })[0].id);

  // Act
  b(noteB, "billing retries, renamed", Date.now() + 60_000); // a title-only write after the judgment, then a scan from the other note
  const retitled = await scanConflicts(db, judges, "/t/a.jsonl#w1");
  b(`${noteB}\n- revised`); // same indexed_ts as the judgment's inputs
  const rewritten = await scanConflicts(db, judges, "/t/b.jsonl#w1");

  // Assert
  assert.deepEqual([first, retitled, rewritten], [1, 0, 1]);
  assert.equal(listJudgments(db, { point: "conflict" }).length, 2, "the earlier flag stays as history");
  assert.equal(listJudgments(db, { point: "conflict", open: true }).length, 1);
});

test("conflict scan stays quiet for notes that agree or are off topic", async () => {
  // Arrange
  const db = openStore(":memory:");
  upsertDoc(db, { source_path: "/t/a.jsonl#w1", source_type: "claude-code", tier: "episodic", title: "billing", content: noteA });
  upsertDoc(db, { source_path: "/t/b.jsonl#w1", source_type: "claude-code", tier: "episodic", title: "billing", content: noteA.replace("should", "will") });
  upsertDoc(db, { source_path: "/t/c.jsonl#w1", source_type: "claude-code", tier: "episodic", title: "cats", content: "## KNOWLEDGE\n- the cat sleeps on the warm windowsill every afternoon\n" });
  const judges = judgesWith(db, ["conflict"], (p, i) => heuristicJudge(p, i));

  // Act
  const flagged = await scanConflicts(db, judges, "/t/b.jsonl#w1");

  // Assert
  assert.equal(flagged, 0);
  assert.equal(listJudgments(db).length, 0);
});

test("dismiss refuses a judgment that is not a conflict", () => {
  // Arrange
  const db = openStore(":memory:");
  const id = logJudgment(db, { point: "triage", docs: ["x"], backend: "heuristic", score: 0.2, label: "skip" });

  // Act + Assert
  assert.equal(dismiss(db, id), false);
  assert.equal(listJudgments(db)[0].truth, null);
});

test("heuristic judges separate rich slices from chatter, and tag procedures and facts", () => {
  // Arrange
  const rich = `User: fix the login bug in src/auth/login.js and src/auth/token.js\n\nAgent: root cause is a clock skew error, I will fix it because the plan says so\n\nUser: ok\n\nAgent: ${"detail ".repeat(600)}`;
  const chatter = `User: ${"thanks ".repeat(100)}\n\nAgent: you are welcome`;
  const steps = "## KNOWLEDGE\n1. run `npm ci`\n2. run `npm test`\n3. run `npm run mcp`\n";
  const facts = "## KNOWLEDGE\n- a\n- b\n- c\n## DECISIONS\n- d\n";

  // Act
  const t = [rich, chatter].map((text) => heuristicJudge("triage", { text }));
  const k = [steps, facts, "## FILES\n- a.js\n## OPEN\n- x\n"].map((text) => heuristicJudge("kind", { text }));

  // Assert
  assert.equal(t[0].label, "keep");
  assert.equal(t[1].label, "skip");
  assert.deepEqual(k.map((x) => x.label), ["procedural", "semantic", "episodic"]);
  for (const x of [...t, ...k]) assert.ok(x.score >= 0 && x.score <= 1 && x.reason);
});

test("the claude judge redacts the note before the model sees it, and parses its JSON", async () => {
  // Arrange
  const token = `ghp_${"aB3dE5gH7jK9mN1pQ3sT5vW7yZ9bD1fH3jL5".slice(0, 36)}`;
  const seen = [];
  const model = async (input) => (seen.push(input), 'sure: {"score": 0.7, "label": "ignored", "reason": "ok"}');
  const judge = claudeJudge({}, { conflict: model, triage: model });

  // Act
  const c = await judge("conflict", { a: `use key ${token} here`, b: "other note" });
  const t = await judge("triage", { text: `User: ${token}` });

  // Assert
  assert.ok(seen.length === 2 && seen.every((s) => !s.includes(token)));
  assert.deepEqual([c.label, c.score, t.label], ["contradict", 0.7, "keep"]);
});

test("parseJudgment redacts the whole reason before clipping it, so a token on the 200-char edge is not kept in part", () => {
  // Arrange
  const token = `ghp_${"aB3dE5gH7jK9mN1pQ3sT5vW7yZ9bD1fH3jL5".slice(0, 36)}`;
  const raw = JSON.stringify({ score: 0.4, reason: `${"x".repeat(190)} ${token}` });

  // Act
  const j = parseJudgment("triage", raw);

  // Assert
  assert.ok(j.reason.length <= 200);
  assert.ok(!j.reason.includes(token.slice(0, 9)), j.reason.slice(185));
});

test("parseJudgment rejects replies that are not a judgment", () => {
  // Arrange
  const bad = ["no json", '{"score": 2, "label": "keep"}', '{"score": "high"}', '{"score": 0.4, "label": "bogus"}'];

  // Act + Assert
  assert.throws(() => parseJudgment("triage", bad[0]), /not JSON/);
  assert.throws(() => parseJudgment("triage", bad[1]), /0\.\.1/);
  assert.throws(() => parseJudgment("conflict", bad[2]), /0\.\.1/);
  assert.throws(() => parseJudgment("kind", bad[3]), /not a kind/);
  assert.deepEqual(parseJudgment("triage", '{"score": 0.2, "label": "keep", "reason": "x"}'), { score: 0.2, label: "skip", reason: "x" });
});

test("judging is off unless AGENT_KB_JUDGE is set; typos, jev and a claude judge without a summarizer are errors", () => {
  // Arrange
  const cfg = (env) => () => judgeConfig(env);

  // Act + Assert
  assert.equal(judgeConfig({}), null);
  assert.deepEqual([...judgeConfig({ AGENT_KB_JUDGE: "all" }).points], ["triage", "conflict", "kind"]);
  assert.equal(judgeConfig({ AGENT_KB_JUDGE: "kind" }).backend, "heuristic");
  assert.throws(cfg({ AGENT_KB_JUDGE: "triage,bogus" }), /unknown judge point "bogus"/);
  assert.throws(cfg({ AGENT_KB_JUDGE: "all", AGENT_KB_JUDGE_BACKEND: "jev" }), /jev judge backend is not available/);
  assert.throws(cfg({ AGENT_KB_JUDGE: "all", AGENT_KB_JUDGE_BACKEND: "claude" }), /needs AGENT_KB_SUMMARIZER/);
  assert.equal(judgeConfig({ AGENT_KB_JUDGE: "all", AGENT_KB_JUDGE_BACKEND: "claude", AGENT_KB_SUMMARIZER: "claude" }).backend, "claude:claude-haiku-5-5");
  assert.equal(judgeConfig({ AGENT_KB_JUDGE: "all", AGENT_KB_JUDGE_BACKEND: "claude", AGENT_KB_SUMMARIZER: "api", AGENT_KB_MODEL: "claude-sonnet-5-5" }).backend, "claude:claude-sonnet-5-5");
});

test("kb_save tags and scans like a sweep: the note is stored, the judgments are logged", async () => {
  // Arrange
  const db = openStore(":memory:");
  upsertDoc(db, { source_path: "kb-save:old", source_type: "claude-chat", tier: "episodic", title: "billing retries", content: noteA });
  openGate(db, "kind");
  const judges = judgesWith(db, ["kind", "conflict"], (p, i) => (p === "kind" ? { score: 0.9, label: "procedural", reason: "" } : heuristicJudge(p, i)));
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createServer(db, { judges }).connect(a);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(b);

  // Act
  await client.callTool({ name: "kb_save", arguments: { title: "billing retries", note: noteB } });

  // Assert
  const saved = db.prepare("SELECT source_path, tier FROM documents WHERE content = ?").get(noteB);
  assert.equal(saved.tier, "procedural");
  assert.equal(listJudgments(db, { point: "conflict" }).length, 1);
  assert.equal(listJudgments(db, { point: "kind" }).filter((j) => j.docs[0] === saved.source_path)[0].acted, 1);
});

test("kb_save of the same note again after a dismiss, or under a new title, does not re-tag or revive the conflict", async () => {
  // Arrange
  const db = openStore(":memory:");
  upsertDoc(db, { source_path: "kb-save:old", source_type: "claude-chat", tier: "episodic", title: "billing retries", content: noteA });
  const judges = judgesWith(db, ["kind", "conflict"], (p, i) => (p === "kind" ? { score: 0.9, label: "procedural", reason: "" } : heuristicJudge(p, i)));
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createServer(db, { judges }).connect(a);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(b);
  const url = "https://claude.ai/chat/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
  const save = () => client.callTool({ name: "kb_save", arguments: { title: "billing retries", note: noteB, chat_url: url } });
  await save();
  dismiss(db, listJudgments(db, { point: "conflict" })[0].id);

  const tier = getDoc(db, `${url}#saved`).tier;

  // Act
  const again = await save();
  const retitled = await client.callTool({ name: "kb_save", arguments: { title: "billing retry notes", note: noteB, chat_url: url } });

  // Assert
  assert.match(again.content[0].text, /Already saved/);
  assert.match(retitled.content[0].text, /Saved to the knowledge base/);
  assert.equal(getDoc(db, `${url}#saved`).title, "billing retry notes");
  assert.equal(getDoc(db, `${url}#saved`).tier, tier);
  assert.equal(listJudgments(db, { point: "conflict", open: true }).length, 0);
  assert.equal(listJudgments(db, { point: "kind" }).length, 1);
});

function cli(home, ...args) {
  return spawnSync(process.execPath, [CLI, ...args], { env: { ...process.env, AGENT_KB_HOME: home, AGENT_KB_SUMMARIZER: "", AGENT_KB_JUDGE: "" }, encoding: "utf8" });
}

test("eval, label, pin, dismiss and judgments work from the CLI, and say why a point is off", () => {
  // Arrange
  const home = tmp();
  const db = openStore(path.join(home, "kb.sqlite"));
  const t = logJudgment(db, { point: "triage", docs: ["/t/x.jsonl"], backend: "heuristic", score: 0.2, label: "skip", acted: true, sliceStart: 0, sliceEnd: 9 });
  const c = logJudgment(db, { point: "conflict", docs: ["/n/a#w1", "/n/b#w1"], backend: "heuristic", score: 0.8, label: "contradict" });
  const k = logJudgment(db, { point: "kind", docs: ["/n/a#w1"], backend: "heuristic", score: 0.6, label: "semantic" });
  db.close();

  // Act
  const evalBefore = cli(home, "eval");
  const pinned = cli(home, "pin", "/t/x.jsonl");
  const pinAgain = cli(home, "pin", "/t/x.jsonl");
  const dismissed = cli(home, "dismiss", String(c));
  const dismissKind = cli(home, "dismiss", String(k));
  const labelled = cli(home, "label", String(k), "no");
  const missing = cli(home, "label", "999", "yes");
  const open = cli(home, "judgments", "--open");
  const evalAfter = cli(home, "eval");
  const badLabel = cli(home, "label", "1", "maybe");
  const badPoint = cli(home, "judgments", "nope");

  // Assert
  assert.match(evalBefore.stdout, /triage\s+heuristic\s+1 logged, 0 labelled \(0 yes \/ 0 no\)\s+AUC n\/a\s+off: needs 30 labelled judgments, has 0/);
  assert.equal(pinned.status, 0);
  assert.match(pinned.stdout, new RegExp(`#${t}`));
  assert.equal(pinAgain.status, 1);
  assert.equal(dismissed.status, 0);
  assert.equal(dismissKind.status, 1);
  assert.equal(labelled.status, 0);
  assert.equal(missing.status, 1);
  assert.equal(open.stdout.trim(), "");
  assert.match(evalAfter.stdout, /triage\s+heuristic\s+1 logged, 1 labelled \(1 yes \/ 0 no\)/);
  assert.equal(badLabel.status, 2);
  assert.equal(badPoint.status, 2);
});

test("the CLI refuses a bad AGENT_KB_JUDGE before it opens the data dir", () => {
  // Arrange
  const home = path.join(tmp(), "not-created");

  // Act
  const r = spawnSync(process.execPath, [CLI, "sweep"], { env: { ...process.env, AGENT_KB_HOME: home, AGENT_KB_JUDGE: "nope" }, encoding: "utf8" });

  // Assert
  assert.equal(r.status, 2);
  assert.match(r.stderr, /unknown judge point "nope"/);
  assert.equal(fs.existsSync(home), false);
});
