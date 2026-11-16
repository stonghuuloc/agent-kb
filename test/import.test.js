import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { getDoc, openStore, upsertDoc } from "../src/store.js";
import { importKb, oldKbExists, tierOf } from "../src/import-kb.js";
import { pruneCandidates, pruneTranscripts } from "../src/prune.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "agent-kb-im-"));
const DAY = 86_400_000;
const now = Date.parse("2026-11-16T12:00:00Z");

/** A stand-in for ~/.claude/kb.sqlite: the columns this import reads, and a conflicts table. */
/** The sweep's record that every byte of `file` was summarized. */
function summarizedTo(db, file, offset = fs.statSync(file).size, ino = fs.statSync(file, { bigint: true }).ino.toString()) {
  db.prepare("INSERT OR REPLACE INTO cursors (source_path, offset, chunks, failures, failed_ts, ino) VALUES (?, ?, 1, 0, 0, ?)").run(file, offset, ino);
}

function oldKb(file, docs, conflicts = []) {
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE documents (id INTEGER PRIMARY KEY, source_path TEXT UNIQUE NOT NULL, source_type TEXT NOT NULL,
             kind TEXT, last_indexed INTEGER NOT NULL, content_hash TEXT, content TEXT, tier TEXT, event_ts INTEGER);
           CREATE TABLE kb_conflicts (loser_path TEXT, winner_path TEXT, relation TEXT, status TEXT);`);
  const put = db.prepare("INSERT INTO documents (source_path, source_type, kind, last_indexed, content, tier, event_ts) VALUES (?,?,?,?,?,?,?)");
  for (const d of docs) put.run(d.source_path, d.source_type, d.kind ?? null, d.ts ?? now - 10 * DAY, d.content, d.tier ?? null, d.ts ?? null);
  const c = db.prepare("INSERT INTO kb_conflicts (loser_path, winner_path, relation, status) VALUES (?,?,?,?)");
  for (const x of conflicts) c.run(x.loser, x.winner, x.relation ?? "contradicts", x.status ?? "proposed");
  db.close();
  return file;
}

test("the import copies documents with titles, tiers and times, and skips what is already here", () => {
  // Arrange
  const dir = tmp();
  const file = oldKb(path.join(dir, "old.sqlite"), [
    { source_path: "/p/session.jsonl", source_type: "session_summary", content: "## KNOWLEDGE\n- claim gates fail closed", ts: now - DAY },
    { source_path: "/p/memory/feedback_x.md", source_type: "memory", content: "---\nname: x\n---\n# Lesson\n\ncheck first" },
    { source_path: "/p/daily/2026-11-01.md", source_type: "daily_note", content: "# 2026-11-01\n\n- did things", tier: "episodic" },
    { source_path: "/p/old-ticket", source_type: "jira_ticket", content: "CH-58201 claim gate", ts: now - 40 * DAY },
  ]);
  const db = openStore(path.join(dir, "kb.sqlite"));
  upsertDoc(db, { source_path: "/p/session.jsonl", source_type: "claude-code", tier: "episodic", title: "mine", content: "newer", event_ts: now, resume_cmd: null });

  // Act
  const c = importKb(db, file);
  const session = getDoc(db, "/p/session.jsonl");

  // Assert
  assert.equal(c.docs, 3);
  assert.equal(c.skipped, 1, "the transcript this store already summarized is left alone");
  assert.equal(session.content, "newer");
  assert.equal(getDoc(db, "/p/memory/feedback_x.md").tier, "procedural");
  assert.equal(getDoc(db, "/p/memory/feedback_x.md").title, "Lesson");
  assert.equal(getDoc(db, "/p/daily/2026-11-01.md").tier, "episodic");
  assert.equal(getDoc(db, "/p/old-ticket").source_type, "jira_ticket");
  assert.equal(tierOf("confluence_page"), "semantic");
  assert.equal(tierOf("session_summary"), "episodic");
  assert.equal(tierOf("hook"), "procedural");
});

test("the import brings the old conflict flags across, because they are what demotes a stale note", () => {
  // Arrange
  const dir = tmp();
  const file = oldKb(path.join(dir, "old.sqlite"), [], [
    { loser: "/p/old.md", winner: "/p/new.md" },
    { loser: "/p/x.md", winner: "/p/y.md", status: "dismissed" },
  ]);
  const db = openStore(path.join(dir, "kb.sqlite"));

  // Act
  const c = importKb(db, file);
  const rows = db.prepare("SELECT docs, truth, backend FROM judgments WHERE point = 'conflict'").all();

  // Assert
  assert.equal(c.conflicts, 1, "a dismissed flag is not a flag");
  assert.equal(rows.length, 1);
  assert.deepEqual(JSON.parse(rows[0].docs), ["/p/new.md", "/p/old.md"], "the pair is stored sorted, like the judge stores it");
  assert.equal(rows[0].truth, "yes", "imported means confirmed, so the penalty is the harsh one");
});

test("an old store with no conflicts table still imports its documents", () => {
  // Arrange
  const dir = tmp();
  const file = path.join(dir, "bare.sqlite");
  const old = new DatabaseSync(file);
  old.exec(`CREATE TABLE documents (id INTEGER PRIMARY KEY, source_path TEXT UNIQUE NOT NULL, source_type TEXT NOT NULL,
              kind TEXT, last_indexed INTEGER NOT NULL, content_hash TEXT, content TEXT, tier TEXT, event_ts INTEGER);`);
  old.prepare("INSERT INTO documents (source_path, source_type, last_indexed, content) VALUES (?,?,?,?)").run("/p/a.md", "memory", now, "# A\n\nbody");
  old.close();
  const db = openStore(path.join(dir, "kb.sqlite"));

  // Act
  const c = importKb(db, file);

  // Assert
  assert.equal(c.docs, 1);
  assert.equal(c.conflicts, 0);
  assert.equal(oldKbExists(file), true);
  assert.equal(oldKbExists(path.join(dir, "nope.sqlite")), false);
});

function transcript(dir, name, { ageDays = 200, size = 100 } = {}) {
  const file = path.join(dir, "projects", "-w", name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "x".repeat(size));
  const old = new Date(now - ageDays * DAY);
  fs.utimesSync(file, old, old);
  return file;
}

test("prune only takes transcripts that already have a summary and are past the retention window", () => {
  // Arrange
  const root = tmp();
  const db = openStore(path.join(tmp(), "kb.sqlite"));
  const summarized = transcript(root, "old.jsonl");
  const recent = transcript(root, "recent.jsonl", { ageDays: 5 });
  const unsummarized = transcript(root, "never.jsonl");
  upsertDoc(db, { source_path: summarized, source_type: "claude-code", tier: "episodic", title: "old", content: "prompt", event_ts: now - 200 * DAY, resume_cmd: null });
  upsertDoc(db, { source_path: `${summarized}#w1`, source_type: "claude-code", tier: "episodic", title: "old (#w1)", content: "note", event_ts: now - 200 * DAY, resume_cmd: null });
  upsertDoc(db, { source_path: recent, source_type: "claude-code", tier: "episodic", title: "recent", content: "prompt", event_ts: now - 5 * DAY, resume_cmd: null });
  upsertDoc(db, { source_path: unsummarized, source_type: "claude-code", tier: "episodic", title: "never", content: "prompt", event_ts: now - 200 * DAY, resume_cmd: null });
  summarizedTo(db, summarized);

  // Act
  const candidates = pruneCandidates(db, { roots: [root], now });
  const dry = pruneTranscripts(db, { roots: [root], now });
  const done = pruneTranscripts(db, { roots: [root], now: now + 1000, confirm: true });

  // Assert
  assert.deepEqual(candidates.map((c) => path.basename(c.file)), ["old.jsonl"]);
  assert.equal(dry.deleted, 0);
  assert.equal(done.deleted, 1);
  assert.equal(fs.existsSync(summarized), false);
  assert.equal(getDoc(db, summarized), null, "its docs go with it");
  assert.equal(getDoc(db, `${summarized}#w1`), null);
  assert.equal(fs.existsSync(recent), true, "inside the retention window");
  assert.equal(fs.existsSync(unsummarized), true, "no summary means it is the only copy");
});

test("a second prune waits out the cooldown", () => {
  // Arrange
  const root = tmp();
  const db = openStore(path.join(tmp(), "kb.sqlite"));
  const file = transcript(root, "old.jsonl");
  upsertDoc(db, { source_path: file, source_type: "claude-code", tier: "episodic", title: "old", content: "prompt", event_ts: now - 200 * DAY, resume_cmd: null });
  upsertDoc(db, { source_path: `${file}#w1`, source_type: "claude-code", tier: "episodic", title: "old", content: "note", event_ts: now - 200 * DAY, resume_cmd: null });
  summarizedTo(db, file);
  const first = pruneTranscripts(db, { roots: [root], now, confirm: true });
  const second = transcript(root, "old2.jsonl");
  upsertDoc(db, { source_path: second, source_type: "claude-code", tier: "episodic", title: "old2", content: "prompt", event_ts: now - 200 * DAY, resume_cmd: null });
  upsertDoc(db, { source_path: `${second}#w1`, source_type: "claude-code", tier: "episodic", title: "old2", content: "note", event_ts: now - 200 * DAY, resume_cmd: null });
  summarizedTo(db, second);

  // Act
  const tooSoon = pruneTranscripts(db, { roots: [root], now: now + DAY, confirm: true });
  const survived = fs.existsSync(second); // the later run is allowed to delete it
  const later = pruneTranscripts(db, { roots: [root], now: now + 14 * DAY, confirm: true });

  // Assert
  assert.equal(first.deleted, 1);
  assert.equal(tooSoon.cooldown, true);
  assert.equal(survived, true, "inside the cooldown nothing is deleted");
  assert.equal(later.deleted, 1);
  assert.equal(fs.existsSync(second), false);
});

test("prune keeps a transcript with unsummarized bytes, a #w folder that is not a summary, and a look-alike's docs", () => {
  // Arrange
  const root = tmp();
  const db = openStore(path.join(tmp(), "kb.sqlite"));
  const row = (source_path) => upsertDoc(db, { source_path, source_type: "claude-code", tier: "episodic", title: "t", content: "c", event_ts: now - 200 * DAY, resume_cmd: null });
  const short = transcript(root, "short.jsonl");
  row(`${short}#w1`);
  summarizedTo(db, short, 10); // a failed slice left the cursor before the end
  const hashDir = path.join(root, "projects", "#work", "s.jsonl");
  fs.mkdirSync(path.dirname(hashDir), { recursive: true });
  fs.writeFileSync(hashDir, "x");
  fs.utimesSync(hashDir, new Date(now - 200 * DAY), new Date(now - 200 * DAY));
  row(hashDir); // tier-0 row only: its path contains "#w" but it has no summary
  summarizedTo(db, hashDir);
  const mine = transcript(root, "my_repo.jsonl");
  row(`${mine}#w1`);
  summarizedTo(db, mine);
  const lookAlike = mine.replace("my_repo", "myXrepo");
  row(`${lookAlike}#w1`);
  const replaced = transcript(root, "replaced.jsonl");
  row(`${replaced}#w1`);
  summarizedTo(db, replaced);
  db.prepare("UPDATE cursors SET ino = '1' WHERE source_path = ?").run(replaced); // the cursor saw another file
  const shrunk = transcript(root, "shrunk.jsonl");
  row(`${shrunk}#w1`);
  summarizedTo(db, shrunk, fs.statSync(shrunk).size + 10); // the cursor counted bytes this file no longer has
  const legacy = transcript(root, "legacy.jsonl");
  row(`${legacy}#w1`);
  summarizedTo(db, legacy, undefined, ""); // a cursor from before inodes were recorded

  // Act
  const candidates = pruneCandidates(db, { roots: [root], now }).map((c) => path.basename(c.file));
  pruneTranscripts(db, { roots: [root], now, confirm: true });

  // Assert
  assert.deepEqual(candidates, ["my_repo.jsonl"]);
  assert.equal(fs.existsSync(short), true, "unsummarized bytes are the only copy");
  assert.equal(fs.existsSync(hashDir), true);
  assert.notEqual(getDoc(db, `${lookAlike}#w1`), null, "_ is not a wildcard");
  assert.equal(fs.existsSync(replaced), true, "a different inode at the same path is not the summarized file");
  assert.equal(fs.existsSync(shrunk), true, "a file shorter than its cursor is not the summarized file");
  assert.equal(fs.existsSync(legacy), true, "a cursor with no inode cannot prove which file it read");
});

test("prune re-checks each file just before deleting it, and keeps one that changed after it was listed", () => {
  // Arrange
  const root = tmp();
  const db = openStore(path.join(tmp(), "kb.sqlite"));
  const file = transcript(root, "resumed.jsonl");
  upsertDoc(db, { source_path: `${file}#w1`, source_type: "claude-code", tier: "episodic", title: "t", content: "c", event_ts: now - 200 * DAY, resume_cmd: null });
  summarizedTo(db, file);
  const listed = pruneCandidates(db, { roots: [root], now });
  fs.appendFileSync(file, "a new turn\n"); // the session is resumed between listing and deleting
  const old = new Date(now - 200 * DAY);
  fs.utimesSync(file, old, old);

  const sameSize = transcript(root, "replaced.jsonl");
  upsertDoc(db, { source_path: `${sameSize}#w1`, source_type: "claude-code", tier: "episodic", title: "t", content: "c", event_ts: now - 200 * DAY, resume_cmd: null });
  summarizedTo(db, sameSize);
  const touched = transcript(root, "touched.jsonl");
  upsertDoc(db, { source_path: `${touched}#w1`, source_type: "claude-code", tier: "episodic", title: "t", content: "c", event_ts: now - 200 * DAY, resume_cmd: null });
  summarizedTo(db, touched);
  const listedAll = pruneCandidates(db, { roots: [root], now });
  const copy = `${sameSize}.new`;
  fs.copyFileSync(sameSize, copy);
  fs.renameSync(copy, sameSize); // same bytes and size, new inode
  fs.utimesSync(sameSize, old, old);
  const older = new Date(now - 300 * DAY);
  fs.utimesSync(touched, older, older); // only the mtime moves

  // Act
  const r = pruneTranscripts(db, { roots: [root], now, confirm: true, candidates: listed });
  const r2 = pruneTranscripts(db, { roots: [root], now: now + 30 * DAY, confirm: true, candidates: listedAll.filter((c) => c.file !== file) });

  // Assert
  assert.equal(listed.length, 1);
  assert.equal(r.deleted, 0);
  assert.equal(fs.existsSync(file), true, "the appended turn is kept");
  assert.equal(r2.deleted, 0);
  assert.equal(fs.existsSync(sameSize), true, "a new inode at the same size is another file");
  assert.equal(fs.existsSync(touched), true, "a changed mtime means it was touched after listing");
});

test("prune: a write that lands between the re-check and the delete keeps the transcript at its path", () => {
  // Arrange
  const now = Date.now();
  const root = tmp();
  const db = openStore(path.join(tmp(), "kb.sqlite"));
  const file = transcript(root, "late.jsonl");
  upsertDoc(db, { source_path: `${file}#w1`, source_type: "claude-code", tier: "episodic", title: "t", content: "c", event_ts: now - 200 * DAY, resume_cmd: null });
  summarizedTo(db, file);
  const append = (c) => fs.appendFileSync(c.file, "a turn written after the re-check\n");

  // Act
  const r = pruneTranscripts(db, { roots: [root], now, confirm: true, beforeMove: append });

  // Assert
  assert.equal(r.deleted, 0);
  assert.match(fs.readFileSync(file, "utf8"), /written after the re-check/, "the late turn is kept, at the original path");
  assert.deepEqual(fs.readdirSync(path.dirname(file)).filter((f) => f.includes("agent-kb-prune")), [], "nothing is left aside");
});
