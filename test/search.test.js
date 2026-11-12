import { test } from "node:test";
import assert from "node:assert/strict";
import { openStore, upsertDoc } from "../src/store.js";
import { ftsQuery, search } from "../src/search.js";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 12);

function seed(docs) {
  const db = openStore(":memory:");
  for (const d of docs) upsertDoc(db, { source_type: "session", tier: "episodic", ...d }, NOW);
  return db;
}

test("punctuated tokens and FTS operators are matched literally", () => {
  // Arrange
  const db = seed([
    { source_path: "a", content: "fixed PROJ-123 in auth.py", event_ts: NOW },
    { source_path: "b", content: "PROJ 123 unrelated", event_ts: NOW },
  ]);

  // Act
  const hits = search(db, "PROJ-123 auth.py", {}, NOW);

  // Assert
  assert.deepEqual(hits.map((h) => h.source_path), ["a"]);
  assert.equal(ftsQuery('NOT a" OR'), '"NOT" "a" "OR"');
  assert.deepEqual(search(db, '  "" ', {}, NOW), []);
});

test("all words must match", () => {
  // Arrange
  const db = seed([
    { source_path: "both", content: "redis cache eviction", event_ts: NOW },
    { source_path: "one", content: "redis cluster", event_ts: NOW },
  ]);

  // Act
  const hits = search(db, "redis eviction", {}, NOW);

  // Assert
  assert.deepEqual(hits.map((h) => h.source_path), ["both"]);
});

test("with equal relevance, the recent session outranks the old one", () => {
  // Arrange
  const db = seed([
    { source_path: "old", content: "webhook retry policy", event_ts: NOW - 400 * DAY },
    { source_path: "new", content: "webhook retry policy", event_ts: NOW - 1 * DAY },
  ]);

  // Act
  const hits = search(db, "webhook retry", {}, NOW);

  // Assert
  assert.deepEqual(hits.map((h) => h.source_path), ["new", "old"]);
});

test("age decay applies to episodic docs only", () => {
  // Arrange
  const db = seed([
    { source_path: "note", tier: "semantic", source_type: "note", content: "deploy checklist", event_ts: NOW - 400 * DAY },
    { source_path: "sess", tier: "episodic", content: "deploy checklist", event_ts: NOW - 400 * DAY },
  ]);

  // Act
  const [a, b] = search(db, "deploy checklist", {}, NOW);

  // Assert
  assert.equal(a.source_path, "note");
  assert.ok(a.score > b.score * 4, `semantic ${a.score} vs decayed episodic ${b.score}`);
});

test("at most perTypeCap hits per source_type, then limit", () => {
  // Arrange
  const docs = Array.from({ length: 6 }, (_, i) => ({ source_path: `s${i}`, content: "migration", event_ts: NOW - i * DAY }));
  docs.push({ source_path: "n0", source_type: "note", tier: "semantic", content: "migration", event_ts: NOW });
  const db = seed(docs);

  // Act
  const capped = search(db, "migration", { perTypeCap: 2 }, NOW);
  const limited = search(db, "migration", { limit: 1 }, NOW);

  // Assert
  assert.equal(capped.filter((h) => h.source_type === "session").length, 2);
  assert.ok(capped.some((h) => h.source_type === "note"));
  assert.equal(limited.length, 1);
});

test("title matches outrank body-only matches", () => {
  // Arrange
  const db = seed([
    { source_path: "body", title: "misc", content: "we talked about kafka once", event_ts: NOW },
    { source_path: "title", title: "kafka consumer lag", content: "lag fix", event_ts: NOW },
  ]);

  // Act
  const hits = search(db, "kafka", {}, NOW);

  // Assert
  assert.equal(hits[0].source_path, "title");
});
