import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getDoc, openStore } from "../src/store.js";
import { hasEntries, journalDocs, mergeDaily, parseJournal, sessionId, today, writeDaily } from "../src/journal.js";
import { dailyDir } from "../src/obsidian.js";
import { listTranscripts } from "../src/adapters/claude-code.js";
import { summarizeIdle, sweepSince } from "../src/sweep.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "agent-kb-jr-"));
const line = (o) => JSON.stringify(o) + "\n";
const HOUR = 3_600_000;
const pad = "x".repeat(600);
const user = (text) => ({ type: "user", sessionId: "s1", cwd: "/w", timestamp: "2026-11-01T10:00:00Z", message: { content: text } });
const agent = (text) => ({ type: "assistant", sessionId: "s1", message: { content: [{ type: "text", text }] } });

function session(cfg, id = "ab99053b-60f0-497d-9383-90e00a72abce") {
  const dir = path.join(cfg, "projects", "-w");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${id}.jsonl`);
  fs.writeFileSync(file, [user(pad), agent("ok " + pad)].map(line).join(""));
  const old = new Date(Date.now() - 2 * HOUR);
  fs.utimesSync(file, old, old);
  return file;
}

test("parseJournal takes the four journal lines out of a summary and leaves the doc text alone", () => {
  // Arrange
  const summary = "## KNOWLEDGE\n- claim gates fail closed\n\nDAILY: [ticket] CH-53411 claim gate merged.\nLEARNED: flock ships with macOS neither ; Tempo wants 3.75h not 1h30m\nSEARCHED: why the hook stopped ; how to backfill\nFRICTION: [agent] used a bare model name ; [tool] GitHub PR search 422s\nDAILY: SKIP\n";

  // Act
  const { text, entries } = parseJournal(summary);
  const empty = parseJournal("## DECISIONS\n- kept as written");

  // Assert
  assert.equal(text, "## KNOWLEDGE\n- claim gates fail closed\n");
  assert.deepEqual(entries.daily, ["[ticket] CH-53411 claim gate merged."]);
  assert.deepEqual(entries.learned, ["flock ships with macOS neither", "Tempo wants 3.75h not 1h30m"]);
  assert.deepEqual(entries.searched, ["why the hook stopped", "how to backfill"]);
  assert.deepEqual(entries.friction, ["[agent] used a bare model name", "[tool] GitHub PR search 422s"]);
  assert.equal(empty.text, "## DECISIONS\n- kept as written", "a summary with no journal lines is stored byte for byte");
  assert.deepEqual(empty.entries.daily, []);
});

test("mergeDaily appends under the headings the template writes, links tickets, unions the front matter", () => {
  // Arrange
  const text = `---\ndate: 2026-11-16\nshape:\nenergy:\ntickets: [CH-40780]\n---\n\n## What I did\n<!-- prefix each item -->\n- [learning] hand-written line\n\n## What I learned / figured out\n\n## Friction — what slowed me down\n\n## What I searched / asked for today\n\n`;
  const entries = { daily: ["[ticket] CH-53411 merged"], learned: [], friction: ["[agent] assumed the account"], searched: ["how the hook fires"] };

  // Act
  const once = mergeDaily(text, { entries, session: "ab99053b" });
  const twice = mergeDaily(once.text, { entries, session: "ab99053b" });
  const next = mergeDaily(once.text, { entries: { ...entries, daily: [] }, session: "ab99053b", slice: 2 });

  // Assert
  assert.match(once.text, /## What I did\n<!-- prefix each item -->\n- \[learning\] hand-written line\n- \[ticket\] \[\[CH-53411\]\] merged \(auto-draft, session `ab99053b`\)\n/, "appended in the section, hand-written line kept");
  assert.match(once.text, /^tickets: \[CH-40780, CH-53411\]$/m, "front matter union, order kept");
  assert.deepEqual(once.appended, ["daily", "friction", "searched"]);
  assert.deepEqual(twice.appended, [], "a rerun appends nothing");
  assert.equal(twice.text, once.text);
  assert.match(next.text, /\(auto-draft, session `ab99053b` w2\)/, "a later slice gets its own marker");
});

test("writeDaily creates the day from the template, then only adds what is missing", () => {
  // Arrange
  const dir = path.join(tmp(), "daily");
  const day = "2026-11-16";
  const entries = { daily: ["[ticket] CH-53411 merged"], learned: [], friction: [], searched: [] };

  // Act
  const first = writeDaily(dir, { day, entries, session: "ab99053b" });
  const second = writeDaily(dir, { day, entries, session: "ab99053b" });
  const bare = writeDaily(dir, { day, entries: { daily: [], learned: [], friction: [], searched: [] }, session: "ab99053b" });
  const note = fs.readFileSync(path.join(dir, `${day}.md`), "utf8");

  // Assert
  assert.equal(first, "appended: daily");
  assert.equal(second, "already has this session");
  assert.equal(bare, "no journal lines");
  assert.match(note, /^---\ndate: 2026-11-16\nshape:\nenergy:\ntickets: \[CH-53411\]\n---\n/, "template plus the ticket it saw");
  for (const h of ["## What I did", "## What I learned / figured out", "## Friction — what slowed me down", "## What I searched / asked for today"]) assert.ok(note.includes(h), h);
  assert.equal(fs.readdirSync(dir).length, 1, "no temp file left behind");
});

test("journalDocs accumulates learned facts and friction across slices, without duplicates", () => {
  // Arrange
  const db = openStore(path.join(tmp(), "kb.sqlite"));
  const base = "/p/ab99053b.jsonl";
  const first = parseJournal("LEARNED: A ; B\nFRICTION: [agent] X\n").entries;
  const second = parseJournal("LEARNED: B ; C\nFRICTION: [agent] Y\n").entries;

  // Act
  journalDocs(db, base, first, { title: "T", event_ts: 1 });
  journalDocs(db, base, second, { title: "T", event_ts: 2 });
  const learned = getDoc(db, `${base}#journal-learned`);
  const friction = getDoc(db, `${base}#journal-friction`);

  // Assert
  assert.equal(learned.source_type, "session_learning");
  assert.equal(learned.tier, "semantic");
  assert.equal(learned.content, "- A\n- B\n- C\n");
  assert.equal(friction.source_type, "session_friction");
  assert.equal(friction.tier, "procedural");
  assert.equal(friction.content, "- [agent] X\n- [agent] Y\n");
});

test("a sweep stores the doc without its journal lines and writes them into the day's note", async () => {
  // Arrange
  const db = openStore(path.join(tmp(), "kb.sqlite"));
  const cfg = tmp();
  const daily = path.join(tmp(), "vault", "daily");
  const file = session(cfg);
  const reply = "## KNOWLEDGE\n- claim gates fail closed\n\nDAILY: [ticket] CH-53411 merged.\nFRICTION: [agent] assumed the account\n";
  const summarize = async () => reply;

  // Act
  const r = await summarizeIdle(db, listTranscripts([cfg]), summarize, { since: sweepSince(db), daily, now: Date.now() });
  const note = fs.readFileSync(path.join(daily, `${today()}.md`), "utf8");

  // Assert
  assert.equal(r.summarized, 1);
  assert.equal(getDoc(db, `${file}#w1`).content, "## KNOWLEDGE\n- claim gates fail closed\n", "journal lines are not in the doc body");
  assert.match(note, /- \[ticket\] \[\[CH-53411\]\] merged\. \(auto-draft, session `ab99053b`\)/);
  assert.match(note, /- \[agent\] assumed the account \(auto-draft, session `ab99053b`\)/);
  assert.equal(getDoc(db, `${file}#journal-friction`).content, "- [agent] assumed the account\n");
  assert.deepEqual(journalDocs(db, file, parseJournal(reply).entries).length, 0, "a rerun adds no doc");
  assert.ok(hasEntries(parseJournal(reply).entries));
});

test("the daily dir is <vault>/daily unless told otherwise, and never the output folder", () => {
  // Arrange
  const vault = tmp();
  fs.mkdirSync(path.join(vault, "agent-kb"), { recursive: true });

  // Act + Assert
  assert.equal(dailyDir({}), null);
  assert.equal(dailyDir({ AGENT_KB_VAULT: vault }), path.join(vault, "daily"));
  assert.equal(dailyDir({ AGENT_KB_VAULT: vault, AGENT_KB_DAILY_DIR: "journal" }), path.join(vault, "journal"));
  assert.equal(dailyDir({ AGENT_KB_VAULT: vault, AGENT_KB_DAILY: "off" }), null);
  assert.throws(() => dailyDir({ AGENT_KB_VAULT: vault, AGENT_KB_DAILY_DIR: "agent-kb" }), /outside the output folder/);
  assert.throws(() => dailyDir({ AGENT_KB_VAULT: vault, AGENT_KB_DAILY_DIR: "../elsewhere" }), /inside the vault/);
  assert.equal(sessionId("/p/ab99053b-60f0.jsonl"), "ab99053b");
  assert.equal(today(new Date(2026, 10, 6)), "2026-11-06");
});

test("writeDaily redacts what the model wrote, and leaves the user's own text alone", () => {
  // Arrange
  const dir = path.join(tmp(), "daily");
  const day = "2026-11-16";
  fs.mkdirSync(dir, { recursive: true });
  const mine = "my own line ghp_" + "A".repeat(36);
  fs.writeFileSync(path.join(dir, `${day}.md`), `## What I did\n- ${mine}\n`);
  const entries = { daily: ["used token ghp_" + "B".repeat(36)], learned: [], friction: [], searched: [] };

  // Act
  writeDaily(dir, { day, entries, session: "ab99053b" });
  const note = fs.readFileSync(path.join(dir, `${day}.md`), "utf8");

  // Assert
  assert.equal(note.includes("B".repeat(36)), false, "the generated secret is gone");
  assert.equal(note.includes(mine), true, "the user's text is untouched");
});

test("writeDaily merges against a save the user made mid-write, and gives up loudly if the note keeps changing", () => {
  // Arrange
  const dir = path.join(tmp(), "daily");
  const day = "2026-11-16";
  const file = path.join(dir, `${day}.md`);
  const entries = { daily: ["[ticket] CH-2 shipped"], learned: [], friction: [], searched: [] };
  writeDaily(dir, { day, entries: { ...entries, daily: ["[ticket] CH-1 started"] }, session: "s0" });

  // Act
  const status = writeDaily(dir, { day, entries, session: "s1" }, { beforeSwap: (i) => i === 0 && fs.appendFileSync(file, "\nmy own line, saved mid-write\n") });
  const note = fs.readFileSync(file, "utf8");
  const busy = () => writeDaily(dir, { day, entries: { ...entries, daily: ["[ticket] CH-3 next"] }, session: "s2" }, { beforeSwap: () => fs.appendFileSync(file, "typing\n") });

  // Assert
  assert.equal(status, "appended: daily");
  assert.match(note, /my own line, saved mid-write/, "the user's save survives");
  assert.match(note, /CH-2\]\] shipped/, "and the entries were merged into it");
  assert.throws(busy, /kept changing/);
  assert.equal(fs.readdirSync(dir).filter((f) => f.endsWith(".tmp")).length, 0, "no temp file left behind");
});

test("writeDaily does not replace a note created between its read and its write", () => {
  // Arrange
  const dir = path.join(tmp(), "daily");
  const day = "2026-11-17";
  const file = path.join(dir, `${day}.md`);
  const entries = { daily: ["[ticket] CH-4 merged"], learned: [], friction: [], searched: [] };

  // Act
  writeDaily(dir, { day, entries, session: "s1" }, { beforeSwap: (i) => i === 0 && fs.writeFileSync(file, "## What I did\n- written by hand first\n") });
  const note = fs.readFileSync(file, "utf8");

  // Assert
  assert.match(note, /written by hand first/);
  assert.match(note, /CH-4\]\] merged/);
});

test("a new daily note is created without hard links, as on exFAT or FAT", (t) => {
  // Arrange
  const dir = path.join(tmp(), "daily");
  t.mock.method(fs, "linkSync", () => {
    throw Object.assign(new Error("operation not supported"), { code: "ENOTSUP" });
  });
  const entries = { daily: ["[ticket] CH-5 done"], learned: [], friction: [], searched: [] };

  // Act
  const status = writeDaily(dir, { day: "2026-11-18", entries, session: "s1" });

  // Assert
  assert.equal(status, "appended: daily");
  assert.match(fs.readFileSync(path.join(dir, "2026-11-18.md"), "utf8"), /CH-5\]\] done/);
});
