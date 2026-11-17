import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openStore, upsertDoc } from "../src/store.js";
import { CONFLICT_PENALTY, search, TIER_BONUS } from "../src/search.js";
import { formatHits } from "../src/format.js";
import { projectKey, promptRecall, promptTerms, readAliases } from "../src/recall.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "agent-kb-rc-"));
const DAY = 86_400_000;
const now = Date.parse("2026-11-16T12:00:00Z");

function doc(db, over = {}) {
  upsertDoc(db, {
    source_path: "/p/x.md",
    source_type: "claude_md",
    tier: "semantic",
    title: "x",
    content: "x",
    event_ts: now,
    resume_cmd: null,
    ...over,
  });
}

test("promptTerms drops stopwords, short words and repeats, and stops at eight", () => {
  // Arrange
  const prompt = "can you help me with the claim validation gate for CH-53411 please, and the claim validation flow again too many words here to count";

  // Act
  const terms = promptTerms(prompt);

  // Assert
  assert.deepEqual(terms, ["claim", "validation", "gate", "ch-53411", "flow", "many", "words", "count"]);
  assert.deepEqual(promptTerms("yes please"), []);
});

test("prompt recall stays silent on a thin prompt and injects hits with the trust directive", () => {
  // Arrange
  const db = openStore(path.join(tmp(), "kb.sqlite"));
  doc(db, { source_path: "/p/policies.md", source_type: "agents_md", title: "Policies service", content: "the endorsement claim gate fails closed when claims are unreadable", tier: "semantic" });
  doc(db, { source_path: "/p/other.md", title: "Unrelated", content: "how to bake sourdough bread at home" });

  // Act
  const thin = promptRecall(db, "yes please", { env: {} });
  const hit = promptRecall(db, "why does the endorsement claim gate fail closed", { env: {}, now });
  const off = promptRecall(db, "why does the endorsement claim gate fail closed", { env: { AGENT_KB_PROMPT: "off" }, now });

  // Assert
  assert.equal(thin, "");
  assert.equal(off, "");
  assert.match(hit, /agent-kb recall for this prompt\. This is memory, not live state/);
  assert.match(hit, /\[agents_md\] Policies service \(/);
  assert.doesNotMatch(hit, /sourdough/);
});

test("recall takes one hit per source type and drops a type it is told to ignore", () => {
  // Arrange
  const db = openStore(path.join(tmp(), "kb.sqlite"));
  for (const n of [1, 2]) doc(db, { source_path: `/p/notes${n}.md`, source_type: "memory", title: `note ${n}`, content: "endorsement claim gate unreadable fails closed", tier: "procedural" });
  doc(db, { source_path: "/p/wiki.md", source_type: "confluence_page", title: "Confluence page", content: "endorsement claim gate unreadable fails closed", tier: "semantic" });

  // Act
  const kept = promptRecall(db, "endorsement claim gate fails closed unreadable", { env: {}, now });
  const all = promptRecall(db, "endorsement claim gate fails closed unreadable", { env: { AGENT_KB_PROMPT_EXCLUDE_TYPES: "" }, now });

  // Assert
  assert.equal((kept.match(/^\- \[/gm) ?? []).length, 1, "one memory note, no second of the same type");
  assert.doesNotMatch(kept, /confluence_page/);
  assert.match(all, /confluence_page/, "the exclusion is configurable");
});

test("another project's memory is dropped, the session's own project comes first", () => {
  // Arrange
  const db = openStore(path.join(tmp(), "kb.sqlite"));
  doc(db, { source_path: "/p/foreign.md", source_type: "session_learning", tier: "semantic", title: "foreign", content: "claim gate verdict rollback semantics", resume_cmd: "cd /w/other-project && claude --resume f1" });
  doc(db, { source_path: "/p/mine.md", source_type: "session_friction", tier: "procedural", title: "mine", content: "claim gate verdict rollback semantics", resume_cmd: "cd /w/cov-WorkSpace && claude --resume m1" });

  // Act
  const withCwd = promptRecall(db, "claim gate verdict rollback semantics", { cwd: "/w/cov-WorkSpace", env: {}, now });
  const noCwd = promptRecall(db, "claim gate verdict rollback semantics", { env: {}, now });

  // Assert
  assert.doesNotMatch(withCwd, /foreign/, "the other project's note never reaches the prompt");
  assert.match(withCwd, /\[session_friction\] mine/);
  assert.match(noCwd, /foreign/, "without a cwd there is no project to compare, so nothing is dropped");
});

test("sorting puts the own-project hit first even when the other scores higher", () => {
  // Arrange
  const db = openStore(path.join(tmp(), "kb.sqlite"));
  doc(db, { source_path: "/p/title-hit.md", source_type: "session_learning", tier: "semantic", title: "claim gate verdict rollback", content: "…", resume_cmd: "cd /w/other && claude --resume o1" });
  doc(db, { source_path: "/p/own.md", source_type: "session_friction", tier: "procedural", title: "own note", content: "the claim gate verdict rollback happened once", resume_cmd: "cd /w/mine && claude --resume n1" });

  // Act
  const out = promptRecall(db, "claim gate verdict rollback", { cwd: "/w/mine", env: {}, now });

  // Assert
  assert.match(out, /\[session_friction\] own note/, "own project survives the foreign drop and comes first");
});

test("a conflict flag demotes the older note, names the newer one and shows the ⚠ line", () => {
  // Arrange
  const db = openStore(path.join(tmp(), "kb.sqlite"));
  doc(db, { source_path: "/p/old.md", source_type: "session_learning", tier: "episodic", title: "use postgres", content: "the billing store is postgres", event_ts: now - 30 * DAY });
  doc(db, { source_path: "/p/new.md", source_type: "session_learning", tier: "episodic", title: "use mongo", content: "the billing store is mongo now", event_ts: now - DAY });
  db.prepare("INSERT INTO judgments (point, docs, backend, score, label, ts) VALUES ('conflict', ?, 'heuristic', 0.9, 'contradict', ?)").run(JSON.stringify(["/p/new.md", "/p/old.md"]), now - 1000);

  // Act
  const hits = search(db, "billing store", { limit: 5 }, now);
  const old = hits.find((h) => h.source_path === "/p/old.md");
  const fresh = hits.find((h) => h.source_path === "/p/new.md");
  const shaped = formatHits([old]);

  // Assert
  assert.deepEqual(old.conflict, { status: "proposed", path: "/p/new.md", title: "use mongo" });
  assert.equal(old.score, (1 / (60 + old.rFts) + 1 / (60 + old.rRec)) * (90 / (90 + 30)) * CONFLICT_PENALTY.proposed, "episodic decay, then the conflict penalty");
  assert.equal(fresh.conflict, undefined, "the note that wins is not flagged");
  assert.match(shaped, /⚠ proposed: possibly superseded by use mongo/);
});

test("a dismissed conflict stops demoting, and a tier bonus is applied on top of the RRF score", () => {
  // Arrange
  const db = openStore(path.join(tmp(), "kb.sqlite"));
  doc(db, { source_path: "/p/rule.md", source_type: "claude_md", tier: "procedural", title: "rule", content: "always run the sqlite probe first" });
  doc(db, { source_path: "/p/old2.md", source_type: "session_learning", tier: "semantic", title: "old", content: "the sqlite probe was mentioned", event_ts: now - 2 * DAY });
  const id = db.prepare("INSERT INTO judgments (point, docs, backend, score, label, ts, truth) VALUES ('conflict', ?, 'heuristic', 0.9, 'contradict', ?, 'no')").run(JSON.stringify(["/p/old2.md", "/p/rule.md"]), now - 1000).lastInsertRowid;

  // Act
  const hits = search(db, "sqlite probe", { limit: 5 }, now);
  const rule = hits.find((h) => h.source_path === "/p/rule.md");
  const old = hits.find((h) => h.source_path === "/p/old2.md");

  // Assert
  assert.equal(id > 0, true);
  assert.equal(rule.score, 1 / (60 + rule.rFts) + 1 / (60 + rule.rRec) + TIER_BONUS.procedural, "procedural bonus added once");
  assert.equal(old.conflict, undefined, "truth = no means dismissed: no flag, no penalty");
});

test("the alias table folds two folders onto one project", () => {
  // Arrange
  const file = path.join(tmp(), "aliases.json");
  fs.writeFileSync(file, JSON.stringify({ "mantica-design-system": "mantica", _comment: "ignored" }));

  // Act
  const aliases = readAliases(file);

  // Assert
  assert.equal(projectKey("/w/mantica-design-system", aliases), "mantica");
  assert.equal(projectKey("/w/Mantica", aliases), "mantica");
  assert.equal(projectKey("", aliases), "");
  assert.deepEqual(readAliases(path.join(tmp(), "nope.json")), {}, "a missing table degrades to no folding");
});

test("the UserPromptSubmit hook emits one JSON block, or nothing, and never a created kb", async () => {
  // Arrange
  const { userPrompt } = await import("../src/hooks.js");
  const db = openStore(path.join(tmp(), "kb.sqlite"));
  doc(db, { source_path: "/p/gate.md", source_type: "agents_md", tier: "semantic", title: "claim gate", content: "the claim gate fails closed when claims are unreadable", event_ts: now });
  const open = () => db;

  // Act
  const ok = JSON.parse(userPrompt(JSON.stringify({ prompt: "why does the claim gate fail closed", cwd: "/w/x" }), { env: {}, open }));
  const thin = userPrompt(JSON.stringify({ prompt: "yes" }), { env: {}, open });
  const off = userPrompt(JSON.stringify({ prompt: "why does the claim gate fail closed" }), { env: { AGENT_KB_PROMPT: "off" }, open });
  const noDb = userPrompt(JSON.stringify({ prompt: "why does the claim gate fail closed" }), { env: {}, open: () => null });
  const bad = userPrompt("not json", { env: {}, open });

  // Assert
  assert.equal(ok.hookSpecificOutput.hookEventName, "UserPromptSubmit");
  assert.match(ok.hookSpecificOutput.additionalContext, /claim gate/);
  assert.deepEqual([thin, off, noDb, bad], ["", "", "", ""]);
});
