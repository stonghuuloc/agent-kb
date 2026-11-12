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

test("within the limit, at most perTypeCap hits per source_type while other types can fill", () => {
  // Arrange
  const docs = Array.from({ length: 6 }, (_, i) => ({ source_path: `s${i}`, content: "migration", event_ts: NOW - i * DAY }));
  docs.push({ source_path: "n0", source_type: "note", tier: "semantic", content: "migration", event_ts: NOW });
  const db = seed(docs);

  // Act
  const capped = search(db, "migration", { perTypeCap: 2, limit: 3 }, NOW);
  const limited = search(db, "migration", { limit: 1 }, NOW);

  // Assert
  assert.equal(capped.filter((h) => h.source_type === "session").length, 2);
  assert.ok(capped.some((h) => h.source_type === "note"));
  assert.equal(limited.length, 1);
});

test("a title match outranks a slightly newer body-only match", () => {
  // Arrange
  const db = seed([
    { source_path: "body", title: "misc", content: "we talked about kafka once", event_ts: NOW - 1 * DAY },
    { source_path: "title", title: "kafka consumer lag", content: "lag fix", event_ts: NOW - 2 * DAY },
  ]);

  // Act
  const hits = search(db, "kafka", {}, NOW);

  // Assert
  assert.equal(hits[0].source_path, "title");
});

test("per-type cap back-fills when other types cannot fill the limit", () => {
  // Arrange
  const db = seed(Array.from({ length: 10 }, (_, i) => ({ source_path: `s${i}`, content: "rollout", event_ts: NOW - i * DAY })));

  // Act
  const hits = search(db, "rollout", { limit: 10 }, NOW);

  // Assert
  assert.equal(hits.length, 10);
});

test("diverse types come first, back-filled hits after", () => {
  // Arrange
  const docs = Array.from({ length: 5 }, (_, i) => ({ source_path: `s${i}`, content: "rollout", event_ts: NOW - i * DAY }));
  docs.push({ source_path: "n0", source_type: "note", tier: "semantic", content: "rollout", event_ts: NOW - 30 * DAY });
  const db = seed(docs);

  // Act
  const hits = search(db, "rollout", { limit: 6, perTypeCap: 2 }, NOW);

  // Assert
  assert.deepEqual(hits.slice(0, 3).map((h) => h.source_path).sort(), ["n0", "s0", "s1"]);
  assert.equal(hits.length, 6);
});

test("punctuated tokens must appear verbatim, not as split words", () => {
  // Arrange
  const db = seed([
    { source_path: "split", content: "PROJ 123 auth py", event_ts: NOW },
    { source_path: "exact", content: "fixed proj-123 in Auth.py", event_ts: NOW },
  ]);

  // Act
  const hits = search(db, "PROJ-123 auth.py", {}, NOW);

  // Assert
  assert.deepEqual(hits.map((h) => h.source_path), ["exact"]);
});

test("an omitted limit falls back to the default of 10", () => {
  // Arrange
  const db = seed(Array.from({ length: 12 }, (_, i) => ({ source_path: `r${i}`, content: "rollout", event_ts: NOW - i * DAY })));

  // Act
  const hits = search(db, "rollout", { limit: undefined }, NOW);

  // Assert
  assert.equal(hits.length, 10);
});

test("verbatim hits survive more split-phrase decoys than the ranking pool holds", () => {
  // Arrange
  const docs = Array.from({ length: 60 }, (_, i) => ({ source_path: `d${i}`, title: "follow up follow up", content: "follow up", event_ts: NOW }));
  docs.push({ source_path: "real", content: "long notes ... a follow-up on this ticket ...", event_ts: NOW - 30 * DAY });
  const db = seed(docs);

  // Act
  const hits = search(db, "follow-up", {}, NOW);

  // Assert
  assert.deepEqual(hits.map((h) => h.source_path), ["real"]);
});

test("verbatim check folds case and diacritics the same way the index does", () => {
  // Arrange
  const db = seed([
    { source_path: "cafe", content: "see café-bar config", event_ts: NOW },
    { source_path: "ist", content: "İSTANBUL-1 deploy", event_ts: NOW },
  ]);

  // Act
  const plain = search(db, "cafe-bar", {}, NOW);
  const accented = search(db, "CAFÉ-BAR", {}, NOW);
  const dotted = search(db, "istanbul-1", {}, NOW);

  // Assert
  assert.deepEqual(plain.map((h) => h.source_path), ["cafe"]);
  assert.deepEqual(accented.map((h) => h.source_path), ["cafe"]);
  assert.deepEqual(dotted.map((h) => h.source_path), ["ist"]);
});

test("an NFD query finds the NFC form of the same word", () => {
  // Arrange
  const db = seed([{ source_path: "hi", content: "हिन्दी notes", event_ts: NOW }]);

  // Act
  const hits = search(db, "हिन्दी".normalize("NFD"), {}, NOW);

  // Assert
  assert.deepEqual(hits.map((h) => h.source_path), ["hi"]);
  assert.equal("content" in hits[0], false);
});

test("underscored tokens must appear verbatim too", () => {
  // Arrange
  const db = seed([
    { source_path: "split", content: "auth py", event_ts: NOW },
    { source_path: "exact", content: "renamed auth_py module", event_ts: NOW },
  ]);

  // Act
  const hits = search(db, "auth_py", {}, NOW);

  // Assert
  assert.deepEqual(hits.map((h) => h.source_path), ["exact"]);
});

test("words the tokenizer splits on combining marks must appear verbatim", () => {
  // Arrange
  const db = seed([
    { source_path: "split", content: "ह द", event_ts: NOW },
    { source_path: "exact", content: "हिंदी notes", event_ts: NOW },
  ]);

  // Act
  const hits = search(db, "हिंदी", {}, NOW);

  // Assert
  assert.deepEqual(hits.map((h) => h.source_path), ["exact"]);
});

test("Greek final sigma folds the same in query and document", () => {
  // Arrange
  const db = seed([{ source_path: "g", content: "Α.ΟΔΟΣ.Β", event_ts: NOW }]);

  // Act
  const hits = search(db, "Α.ΟΔΟΣ.", {}, NOW);

  // Assert
  assert.deepEqual(hits.map((h) => h.source_path), ["g"]);
});

test("symbols that NFKD turns into letters still get the verbatim check", () => {
  // Arrange
  const db = seed([
    { source_path: "split", content: "foo bar", event_ts: NOW },
    { source_path: "exact", content: "foo™bar", event_ts: NOW },
  ]);

  // Act
  const hits = search(db, "foo™bar", {}, NOW);

  // Assert
  assert.deepEqual(hits.map((h) => h.source_path), ["exact"]);
});

test("tokens whose punctuation the tokenizer drops must appear verbatim", () => {
  // Arrange
  const db = seed([
    { source_path: "plain", content: "the c compiler and net income, ticket 123 abc def html", event_ts: NOW },
    { source_path: "exact", content: "ported C# and .NET code for #123, abc - def", event_ts: NOW },
  ]);

  // Act
  const results = ["C#", "C#,", ".NET", "#123", "abc -", "abc ™", "abc Ⓐ", "ⓐbc"].map((q) =>
    search(db, q, {}, NOW).map((h) => h.source_path),
  );

  // Assert
  assert.deepEqual(results, [["exact"], ["exact"], ["exact"], ["exact"], ["exact"], [], [], []]);
});

test("sentence punctuation at a word's edge keeps plain stemmed matching", () => {
  // Arrange
  const db = seed([
    { source_path: "plain", content: "the login fails with timeout error during deploy", event_ts: NOW },
    { source_path: "cpp", content: "ported the C++ parser", event_ts: NOW },
  ]);

  // Act
  const queries = ["login?", "deploy,", "(timeout)", "errors.", "timeout…", "«login»", "¿login?", "`login`", "login—", "C++"];
  const results = queries.map((q) => search(db, q, {}, NOW).map((h) => h.source_path));

  // Assert
  assert.deepEqual(results, [...Array(9).fill(["plain"]), ["cpp"]]);
});
