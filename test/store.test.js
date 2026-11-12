import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { getDoc, openStore, stats, upsertDoc } from "../src/store.js";
import { dataDir } from "../src/paths.js";

const doc = (over = {}) => ({
  source_path: "claude-code:/p/a.jsonl",
  source_type: "session",
  tier: "episodic",
  title: "First",
  content: "alpha beta",
  event_ts: 1_000,
  ...over,
});

test("empty store migrates, reports zero docs and answers lookups", () => {
  // Arrange
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-kb-"));
  const file = path.join(dir, "nested", "kb.sqlite");

  // Act
  const db = openStore(file);

  // Assert
  assert.equal(stats(db).total, 0);
  assert.equal(getDoc(db, "nope"), null);
  assert.equal(new DatabaseSync(file).prepare("PRAGMA user_version").get().user_version, 1);
});

test("reopening an existing store does not re-run migrations", () => {
  // Arrange
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "agent-kb-")), "kb.sqlite");
  upsertDoc(openStore(file), doc());

  // Act
  const db = openStore(file);

  // Assert
  assert.equal(stats(db).total, 1);
});

test("store newer than the code refuses to open instead of corrupting it", () => {
  // Arrange
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "agent-kb-")), "kb.sqlite");
  new DatabaseSync(file).exec("PRAGMA user_version = 99");

  // Act + Assert
  assert.throws(() => openStore(file), /newer than this agent-kb/);
});

test("upsert replaces by source_path and keeps FTS in sync", () => {
  // Arrange
  const db = openStore(":memory:");
  upsertDoc(db, doc());

  // Act
  upsertDoc(db, doc({ content: "gamma delta", title: "Second" }));

  // Assert
  assert.equal(stats(db).total, 1);
  assert.equal(getDoc(db, "claude-code:/p/a.jsonl").title, "Second");
  const fts = (q) => db.prepare("SELECT COUNT(*) AS n FROM chunks_fts WHERE chunks_fts MATCH ?").get(q).n;
  assert.equal(fts("alpha"), 0);
  assert.equal(fts("gamma"), 1);
});

test("unknown tier is rejected", () => {
  // Arrange
  const db = openStore(":memory:");

  // Act + Assert
  assert.throws(() => upsertDoc(db, doc({ tier: "misc" })), /unknown tier/);
});

test("data dir follows AGENT_KB_HOME, then OS convention", () => {
  // Arrange
  const home = "/home/u";

  // Act + Assert
  assert.equal(dataDir({ AGENT_KB_HOME: "/x" }, "linux", home), "/x");
  assert.equal(dataDir({}, "linux", home), "/home/u/.local/share/agent-kb");
  assert.equal(dataDir({ XDG_DATA_HOME: "/d" }, "linux", home), "/d/agent-kb");
  assert.equal(dataDir({}, "darwin", home), "/home/u/Library/Application Support/agent-kb");
});

test("concurrent first opens of one fresh store all succeed and migrate once", async () => {
  // Arrange
  const { spawn } = await import("node:child_process");
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "agent-kb-")), "kb.sqlite");
  const storeUrl = new URL("../src/store.js", import.meta.url).href;
  const script = `import(${JSON.stringify(storeUrl)}).then(m => m.openStore(${JSON.stringify(file)}))`;
  const run = () =>
    new Promise((resolve) => {
      const p = spawn(process.execPath, ["--input-type=module", "-e", script]);
      let err = "";
      p.stderr.on("data", (d) => (err += d));
      p.on("close", (code) => resolve({ code, err }));
    });

  // Act
  const results = await Promise.all(Array.from({ length: 8 }, run));

  // Assert
  assert.deepEqual(results.filter((r) => r.code !== 0).map((r) => r.err.split("\n").find((l) => /Error/.test(l))), []);
  assert.equal(new DatabaseSync(file).prepare("PRAGMA user_version").get().user_version, 1);
});

test("CLI validates usage before touching the data dir; newer schema exits 3 with a message", async () => {
  // Arrange
  const { spawnSync } = await import("node:child_process");
  const home = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "agent-kb-")), "kb");
  const cli = new URL("../bin/agent-kb.js", import.meta.url).pathname;
  const run = (...a) => spawnSync(process.execPath, [cli, ...a], { env: { ...process.env, AGENT_KB_HOME: home }, encoding: "utf8" });

  // Act
  const bare = run();
  const badN = run("search", "x", "-n", "2.5");
  const dirAfterBadUsage = fs.existsSync(home);
  fs.mkdirSync(home, { recursive: true });
  new DatabaseSync(path.join(home, "kb.sqlite")).exec("PRAGMA user_version = 99");
  const tooNew = run("stats");

  // Assert
  assert.equal(bare.status, 2);
  assert.equal(badN.status, 2);
  assert.equal(dirAfterBadUsage, false);
  assert.equal(tooNew.status, 3);
  assert.match(tooNew.stderr, /newer than this agent-kb/);
  assert.doesNotMatch(tooNew.stderr, /at .*store\.js/);
});
