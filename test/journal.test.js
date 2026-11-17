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

test("mergeDaily keeps two sessions that share the 8-char marker apart, and still dedupes untagged lines", () => {
  // Arrange
  const text = `## What I did\n\n## What I learned / figured out\n\n## Friction — what slowed me down\n\n## What I searched / asked for today\n\n`;
  const daily = (line) => ({ daily: [line], learned: [], friction: [], searched: [] });
  const a = { session: "abcd1234", source: "abcd1234-0000-4000-8000-000000000001.jsonl" };
  const b = { session: "abcd1234", source: "abcd1234-0000-4000-8000-000000000002.jsonl" };

  // Act
  const first = mergeDaily(text, { entries: daily("[ticket] CH-1 first"), ...a });
  const second = mergeDaily(first.text, { entries: daily("[ticket] CH-2 second"), ...b });
  const again = mergeDaily(second.text, { entries: daily("[ticket] CH-2 second"), ...b });
  const legacy = mergeDaily(`## What I did\n- [ticket] old (auto-draft, session \`abcd1234\`)\n`, { entries: daily("[ticket] CH-3 third"), ...b });

  // Assert
  assert.match(first.text, /CH-1\]\] first \(auto-draft, session `abcd1234`\) %%agent-kb abcd1234-0000-4000-8000-000000000001%%\n/);
  assert.match(second.text, /CH-2\]\] second .*000000000002%%\n/, "the second session's line is written, not skipped");
  assert.deepEqual(again.appended, [], "a re-delivery of the same session appends nothing");
  assert.deepEqual(legacy.appended, [], "a line with the marker and no tag (older notes) dedupes when no other session shares it");
  const sharedLegacy = mergeDaily(`## What I did\n- [ticket] old (auto-draft, session \`abcd1234\`)\n`, { entries: daily("[ticket] CH-3 third"), ...b, shared: true });
  assert.deepEqual(sharedLegacy.appended, [], "when another known session shares the marker the untagged line may be ours: not written");
  assert.deepEqual(sharedLegacy.ambiguous, ["daily"], "nor taken as delivered: reported as ambiguous");
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

test("writeDaily keeps a save written into the note in place between its last check and the swap", { skip: process.platform === "win32" && "Windows cannot rename over a file held open" }, () => {
  // Arrange
  const dir = path.join(tmp(), "daily");
  const day = "2026-11-18";
  const file = path.join(dir, `${day}.md`);
  const entries = { daily: ["[ticket] CH-2 shipped"], learned: [], friction: [], searched: [] };
  writeDaily(dir, { day, entries: { ...entries, daily: ["[ticket] CH-1 started"] }, session: "s0" });
  const saveInPlace = (i) => i === 0 && fs.appendFileSync(file, "\nmy line, saved after the check\n"); // same inode, like an editor's save

  // Act
  const status = writeDaily(dir, { day, entries, session: "s1" }, { beforeRename: saveInPlace });
  const note = fs.readFileSync(file, "utf8");

  // Assert
  assert.equal(status, "appended: daily");
  assert.match(note, /my line, saved after the check/, "the in-place save is merged back");
  assert.match(note, /CH-2\]\] shipped/);
  assert.equal((note.match(/CH-2\]\] shipped/g) ?? []).length, 1, "the entries are written once");
  assert.equal(fs.readdirSync(dir).filter((f) => f.endsWith(".tmp")).length, 0);
});

test("an in-place save that cannot be merged because another writer changed the note is kept as a conflict copy", { skip: process.platform === "win32" && "Windows cannot rename over a file held open" }, () => {
  // Arrange
  const dir = path.join(tmp(), "daily");
  const day = "2026-11-19";
  const file = path.join(dir, `${day}.md`);
  const entries = { daily: ["[ticket] CH-2 shipped"], learned: [], friction: [], searched: [] };
  writeDaily(dir, { day, entries: { ...entries, daily: ["[ticket] CH-1 started"] }, session: "s0" });
  const editor = fs.openSync(file, "r+"); // a writer that opened the note before the swap
  const saveInPlace = (i) => i === 0 && fs.writeSync(editor, "\nmy line, saved in place\n", fs.fstatSync(editor).size);
  const otherWriter = (i) => i === 0 && fs.appendFileSync(file, "\nanother writer's entry\n"); // into the note just swapped in

  // Act
  writeDaily(dir, { day, entries, session: "s1" }, { afterMove: saveInPlace, afterRename: otherWriter });
  fs.closeSync(editor);
  const note = fs.readFileSync(file, "utf8");
  const copies = fs.readdirSync(dir).filter((f) => f.includes("(conflict "));

  // Assert
  assert.match(note, /another writer's entry/, "the other writer's text is not overwritten");
  assert.match(note, /CH-2\]\] shipped/);
  assert.equal(copies.length, 1);
  assert.match(fs.readFileSync(path.join(dir, copies[0]), "utf8"), /my line, saved in place/, "the in-place save is kept beside it");
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

test("a new note whose write fails partway is removed, and an empty leftover note is rebuilt from the template", (t) => {
  // Arrange
  const dir = path.join(tmp(), "daily");
  const entries = { daily: ["[ticket] CH-6 done"], learned: [], friction: [], searched: [] };
  const real = fs.writeFileSync;
  const full = t.mock.method(fs, "writeFileSync", (target, ...rest) => {
    if (typeof target === "number" || String(target).endsWith(".tmp")) throw Object.assign(new Error("no space left on device"), { code: "ENOSPC" });
    return real(target, ...rest);
  });

  // Act
  const failed = (() => {
    try {
      writeDaily(dir, { day: "2026-11-19", entries, session: "s1" });
    } catch (e) {
      return e.code;
    }
  })();
  full.mock.restore();
  fs.writeFileSync(path.join(dir, "2026-11-20.md"), ""); // a write killed right after the create
  writeDaily(dir, { day: "2026-11-20", entries, session: "s1" });

  // Assert
  assert.equal(failed, "ENOSPC");
  assert.equal(fs.existsSync(path.join(dir, "2026-11-19.md")), false, "no empty or cut-off note is left");
  assert.match(fs.readFileSync(path.join(dir, "2026-11-20.md"), "utf8"), /^---\ndate: 2026-11-20/, "the empty note gets the template");
});

test("a swap the OS refuses for a moment is retried and reported; a lasting permission error is reported as itself", { skip: process.platform === "win32" }, (t) => {
  // Arrange
  const dir = path.join(tmp(), "daily");
  const entries = (n) => ({ daily: [`[ticket] CH-${n} x`], learned: [], friction: [], searched: [] });
  writeDaily(dir, { day: "2026-11-21", entries: entries(7), session: "s0" });
  const rename = t.mock.method(fs, "renameSync", () => {
    throw Object.assign(new Error("resource busy"), { code: "EBUSY" });
  });

  // Act
  const busy = (() => {
    try {
      writeDaily(dir, { day: "2026-11-21", entries: entries(8), session: "s1" });
    } catch (e) {
      return e.message;
    }
  })();
  const busyCalls = rename.mock.callCount();
  rename.mock.mockImplementation(() => {
    throw Object.assign(new Error("permission denied"), { code: "EACCES" });
  });
  const denied = (() => {
    try {
      writeDaily(dir, { day: "2026-11-21", entries: entries(9), session: "s2" });
    } catch (e) {
      return e.code;
    }
  })();

  // Assert
  assert.equal(busyCalls, 3, "EBUSY is retried each round");
  assert.match(busy, /kept changing/);
  assert.equal(denied, "EACCES", "not hidden behind a conflict");
});

test("writeDaily never replaces a note another writer swapped in by rename after the last check", () => {
  // Arrange
  const dir = path.join(tmp(), "daily");
  const day = "2026-11-21";
  const file = path.join(dir, `${day}.md`);
  const entries = { daily: ["[ticket] CH-2 shipped"], learned: [], friction: [], searched: [] };
  writeDaily(dir, { day, entries: { ...entries, daily: ["[ticket] CH-1 started"] }, session: "s0" });
  const atomicSave = (i) => {
    if (i !== 0) return;
    const theirs = `${file}.editor-tmp`;
    fs.writeFileSync(theirs, fs.readFileSync(file, "utf8") + "\nsaved by rename after the check\n");
    fs.renameSync(theirs, file); // an editor's atomic save: a new inode at the path
  };
  const createInGap = (i) => i === 0 && fs.writeFileSync(file, "## What I did\n- created while the note was aside\n");

  // Act
  const renamed = writeDaily(dir, { day, entries, session: "s1" }, { beforeRename: atomicSave });
  const afterRename = fs.readFileSync(file, "utf8");
  const created = writeDaily(dir, { day, entries: { ...entries, daily: ["[ticket] CH-3 next"] }, session: "s2" }, { afterMove: createInGap });
  const afterCreate = fs.readFileSync(file, "utf8");

  // Assert
  assert.equal(renamed, "appended: daily");
  assert.match(afterRename, /saved by rename after the check/, "the renamed-in save survives");
  assert.match(afterRename, /CH-2\]\] shipped/, "and the entries are merged onto it");
  assert.equal(created, "appended: daily");
  assert.match(afterCreate, /created while the note was aside/, "a note created during the move is not replaced");
  assert.match(afterCreate, /CH-3\]\] next/);
  assert.equal(fs.readdirSync(dir).filter((f) => f.includes("agent-kb-")).length, 0, "no temp or aside file left");
});

test("a note a crashed process left aside goes back before the next write", () => {
  // Arrange
  const dir = path.join(tmp(), "daily");
  const day = "2026-11-22";
  const file = path.join(dir, `${day}.md`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(`${file}.agent-kb-999999999-${Date.now()}-1.old`, "## What I did\n- line from before the crash\n");
  const entries = { daily: ["[ticket] CH-7 done"], learned: [], friction: [], searched: [] };

  // Act
  writeDaily(dir, { day, entries, session: "s1" });
  const note = fs.readFileSync(file, "utf8");

  // Assert
  assert.match(note, /line from before the crash/, "the moved note is restored, not replaced by the template");
  assert.match(note, /CH-7\]\] done/);
  assert.equal(fs.readdirSync(dir).filter((f) => f.endsWith(".old")).length, 0);
});

test("a second writer that finds the note moved aside waits for the swap instead of starting a new note", () => {
  // Arrange
  const dir = path.join(tmp(), "daily");
  const day = "2026-11-23";
  const file = path.join(dir, `${day}.md`);
  const entries = (line) => ({ daily: [line], learned: [], friction: [], searched: [] });
  writeDaily(dir, { day, entries: entries("[ticket] CH-1 started"), session: "s0" });
  let second = null;
  const otherProcess = (i) => {
    if (i !== 0) return;
    try {
      second = writeDaily(dir, { day, entries: entries("[ticket] CH-3 other"), session: "s2" }, { tries: 2 });
    } catch (e) {
      second = e.message;
    }
  };

  // Act
  writeDaily(dir, { day, entries: entries("[ticket] CH-2 shipped"), session: "s1" }, { afterMove: otherProcess });
  const later = writeDaily(dir, { day, entries: entries("[ticket] CH-3 other"), session: "s2" });
  const note = fs.readFileSync(file, "utf8");

  // Assert
  assert.match(second, /kept changing/, "it does not create a note while the day's note is aside");
  assert.equal(later, "appended: daily");
  assert.match(note, /CH-1\]\] started/, "the day's earlier lines survive");
  assert.match(note, /CH-2\]\] shipped/);
  assert.match(note, /CH-3\]\] other/);
  assert.equal(fs.readdirSync(dir).filter((f) => f.includes("(conflict ") || f.includes("agent-kb-")).length, 0);
});

test("an aside left by a crash is recovered after ten minutes even if its pid is alive again", () => {
  // Arrange
  const dir = path.join(tmp(), "daily");
  const day = "2026-11-24";
  const file = path.join(dir, `${day}.md`);
  fs.mkdirSync(dir, { recursive: true });
  const aside = `${file}.agent-kb-${process.ppid}-${Date.now()}-1.old`; // a live pid that is not this process
  fs.writeFileSync(aside, "## What I did\n- line from before the crash\n");
  const fresh = writeDaily.bind(null, dir, { day, entries: { daily: ["[ticket] CH-8 done"], learned: [], friction: [], searched: [] }, session: "s1" });
  const realNow = Date.now;

  // Act
  const blocked = (() => {
    try {
      return fresh();
    } catch (e) {
      return e.message;
    }
  })();
  Date.now = () => realNow() + 11 * 60_000;
  try {
    fresh();
  } finally {
    Date.now = realNow;
  }
  const note = fs.readFileSync(file, "utf8");

  // Assert
  assert.match(blocked, /kept changing/, "a recent aside of a live process is waited for");
  assert.match(note, /line from before the crash/);
  assert.match(note, /CH-8\]\] done/);
});

test("an aside under this process's own pid that it does not hold is a crash leftover from a reused pid", () => {
  // Arrange
  const dir = path.join(tmp(), "daily");
  const day = "2026-11-25";
  const file = path.join(dir, `${day}.md`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(`${file}.agent-kb-${process.pid}-${Date.now()}-1.old`, "## What I did\n- line from before the crash\n");

  // Act
  writeDaily(dir, { day, entries: { daily: ["[ticket] CH-9 done"], learned: [], friction: [], searched: [] }, session: "s1" });
  const note = fs.readFileSync(file, "utf8");

  // Assert
  assert.match(note, /line from before the crash/);
  assert.match(note, /CH-9\]\] done/);
});

test("without hard links, a create that fails partway never removes a note another writer put at the path", (t) => {
  // Arrange
  const dir = path.join(tmp(), "daily");
  const day = "2026-11-26";
  const file = path.join(dir, `${day}.md`);
  const entries = { daily: ["[ticket] CH-10 done"], learned: [], friction: [], searched: [] };
  const realWrite = fs.writeFileSync;
  t.mock.method(fs, "linkSync", () => {
    throw Object.assign(new Error("operation not supported"), { code: "ENOTSUP" }); // exFAT
  });
  t.mock.method(fs, "writeFileSync", (target, ...rest) => {
    if (typeof target !== "number") return realWrite(target, ...rest);
    realWrite(`${file}.editor`, "## What I did\n- the editor's note\n");
    fs.renameSync(`${file}.editor`, file); // an editor replaces the half-created note
    throw Object.assign(new Error("no space left on device"), { code: "ENOSPC" });
  });

  // Act
  const failed = (() => {
    try {
      writeDaily(dir, { day, entries, session: "s1" });
    } catch (e) {
      return e.code;
    }
  })();
  t.mock.restoreAll();
  const note = fs.readFileSync(file, "utf8");

  // Assert
  assert.equal(failed, "ENOSPC");
  assert.match(note, /the editor's note/, "the failed create did not remove the editor's file");
});

test("without hard links, a swap whose create fails leaves the note as it was, not as a conflict copy", (t) => {
  // Arrange
  const dir = path.join(tmp(), "daily");
  const day = "2026-11-27";
  const file = path.join(dir, `${day}.md`);
  writeDaily(dir, { day, entries: { daily: ["[ticket] CH-1 started"], learned: [], friction: [], searched: [] }, session: "s0" });
  const before = fs.readFileSync(file, "utf8");
  const realWrite = fs.writeFileSync;
  let fdWrites = 0;
  t.mock.method(fs, "linkSync", () => {
    throw Object.assign(new Error("operation not supported"), { code: "ENOTSUP" }); // exFAT
  });
  t.mock.method(fs, "writeFileSync", (target, ...rest) => {
    if (typeof target === "number" && fdWrites++ === 0) throw Object.assign(new Error("no space left on device"), { code: "ENOSPC" });
    return realWrite(target, ...rest);
  });

  // Act
  const failed = (() => {
    try {
      writeDaily(dir, { day, entries: { daily: ["[ticket] CH-2 shipped"], learned: [], friction: [], searched: [] }, session: "s1" });
    } catch (e) {
      return e.code;
    }
  })();
  t.mock.restoreAll();

  // Assert
  assert.equal(failed, "ENOSPC");
  assert.equal(fs.readFileSync(file, "utf8"), before, "the note is back as it was");
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.includes("(conflict ") || f.includes("agent-kb-")), []);
});

test("without hard links, a create another writer swapped out mid-write is not reported as written", (t) => {
  // Arrange
  const dir = path.join(tmp(), "daily");
  const day = "2026-11-28";
  const file = path.join(dir, `${day}.md`);
  const realWrite = fs.writeFileSync;
  let first = true;
  t.mock.method(fs, "linkSync", () => {
    throw Object.assign(new Error("operation not supported"), { code: "ENOTSUP" }); // exFAT
  });
  t.mock.method(fs, "writeFileSync", (target, ...rest) => {
    if (typeof target === "number" && first) {
      first = false;
      realWrite(`${file}.other`, "## What I did\n- another writer's note\n");
      fs.renameSync(`${file}.other`, file); // another writer replaced the half-created note
    }
    return realWrite(target, ...rest);
  });

  // Act
  const status = writeDaily(dir, { day, entries: { daily: ["[ticket] CH-11 done"], learned: [], friction: [], searched: [] }, session: "s1" });
  t.mock.restoreAll();
  const note = fs.readFileSync(file, "utf8");

  // Assert
  assert.equal(status, "appended: daily");
  assert.match(note, /another writer's note/, "theirs stays");
  assert.match(note, /CH-11\]\] done/, "ours is merged onto it, not lost in the unlinked file");
});

test("without hard links, a failed create keeps a save another writer made into it", (t) => {
  // Arrange
  const dir = path.join(tmp(), "daily");
  const day = "2026-11-29";
  const file = path.join(dir, `${day}.md`);
  const realWrite = fs.writeFileSync;
  t.mock.method(fs, "linkSync", () => {
    throw Object.assign(new Error("operation not supported"), { code: "ENOTSUP" });
  });
  t.mock.method(fs, "writeFileSync", (target, ...rest) => {
    if (typeof target !== "number") return realWrite(target, ...rest);
    fs.appendFileSync(file, "an edit saved in place\n");
    throw Object.assign(new Error("no space left on device"), { code: "ENOSPC" });
  });

  // Act
  const failed = (() => {
    try {
      writeDaily(dir, { day, entries: { daily: ["[ticket] CH-12 done"], learned: [], friction: [], searched: [] }, session: "s1" });
    } catch (e) {
      return e.code;
    }
  })();
  t.mock.restoreAll();

  // Assert
  assert.equal(failed, "ENOSPC");
  assert.equal(fs.readFileSync(file, "utf8"), "an edit saved in place\n", "not emptied: the bytes are not ours");
});

test("without hard links, a swap whose create another writer replaced with a note holding ours leaves no conflict copy", (t) => {
  // Arrange
  const dir = path.join(tmp(), "daily");
  const day = "2026-11-30";
  const file = path.join(dir, `${day}.md`);
  writeDaily(dir, { day, entries: { daily: ["[ticket] CH-1 started"], learned: [], friction: [], searched: [] }, session: "s0" });
  const realWrite = fs.writeFileSync;
  let first = true;
  t.mock.method(fs, "linkSync", () => {
    throw Object.assign(new Error("operation not supported"), { code: "ENOTSUP" }); // exFAT
  });
  t.mock.method(fs, "writeFileSync", (target, data, ...rest) => {
    const r = realWrite(target, data, ...rest);
    if (typeof target === "number" && first) {
      first = false;
      realWrite(`${file}.other`, String(data) + "\n- another writer's line\n");
      fs.renameSync(`${file}.other`, file); // swapped out by a writer whose note holds ours and the old one
    }
    return r;
  });

  // Act
  writeDaily(dir, { day, entries: { daily: ["[ticket] CH-2 shipped"], learned: [], friction: [], searched: [] }, session: "s1" });
  t.mock.restoreAll();
  const note = fs.readFileSync(file, "utf8");

  // Assert
  assert.match(note, /another writer's line/);
  assert.match(note, /CH-1\]\] started/);
  assert.equal((note.match(/CH-2\]\] shipped/g) ?? []).length, 1);
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.includes("(conflict ")), [], "nothing would be saved by a copy");
});

test("an ambiguous untagged line keeps the slice queued and says why", () => {
  // Arrange
  const dir = path.join(tmp(), "daily");
  const day = "2026-12-01";
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${day}.md`), "## What I did\n- [ticket] old (auto-draft, session `abcd1234`)\n");
  const item = { day, entries: { daily: ["[ticket] CH-13 done"], learned: [], friction: [], searched: [] }, session: "abcd1234", source: "abcd1234-0000-4000-8000-000000000002.jsonl" };

  // Act
  const shared = (() => {
    try {
      return writeDaily(dir, { ...item, shared: true });
    } catch (e) {
      return e.code;
    }
  })();
  const alone = writeDaily(dir, item);

  // Assert
  assert.equal(shared, "AMBIGUOUS", "thrown, so the queue keeps the row and reports it");
  assert.equal(alone, "already has this session", "with no other session sharing the marker the untagged line is ours");
});

test("without hard links, a write that fails partway leaves no cut-off note behind", (t) => {
  // Arrange
  const dir = path.join(tmp(), "daily");
  const day = "2026-12-02";
  const file = path.join(dir, `${day}.md`);
  const realWrite = fs.writeFileSync;
  t.mock.method(fs, "linkSync", () => {
    throw Object.assign(new Error("operation not supported"), { code: "ENOTSUP" }); // exFAT
  });
  t.mock.method(fs, "writeFileSync", (target, data, ...rest) => {
    if (typeof target !== "number") return realWrite(target, data, ...rest);
    fs.writeSync(target, Buffer.from(data).subarray(0, 10)); // some bytes land, then the disk is full
    throw Object.assign(new Error("no space left on device"), { code: "ENOSPC" });
  });

  // Act
  const failed = (() => {
    try {
      writeDaily(dir, { day, entries: { daily: ["[ticket] CH-14 done"], learned: [], friction: [], searched: [] }, session: "s1" });
    } catch (e) {
      return e.code;
    }
  })();
  t.mock.restoreAll();

  // Assert
  assert.equal(failed, "ENOSPC");
  assert.equal(fs.readFileSync(file, "utf8"), "", "emptied: an empty note reads as no note and is rebuilt");
});
