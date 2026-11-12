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
