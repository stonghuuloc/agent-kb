import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { openStore, getDoc, upsertDoc } from "../src/store.js";
import { search } from "../src/search.js";
import { cwdOfResume, resumeCmd } from "../src/adapters/claude-code.js";
import { isGenerated, obsidianConfig, syncIn, syncObsidian, syncOut } from "../src/obsidian.js";
import { sweepOnce } from "../src/sweep.js";

// a developer's own vault must never receive fixture notes
delete process.env.AGENT_KB_VAULT;
delete process.env.AGENT_KB_VAULT_FOLDER;

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "agent-kb-obs-"));
const CLI = path.join(import.meta.dirname, "..", "bin", "agent-kb.js");
const DAY = Date.parse("2026-11-01T10:00:00Z");

function setup() {
  const vault = tmp();
  const cfg = obsidianConfig({ AGENT_KB_VAULT: vault });
  return { db: openStore(":memory:"), vault, cfg };
}

function session(db, id, { title = "Fix login", cwd = "/work/app", prompts = "fix the flaky login test", ts = DAY, summaries = [] } = {}) {
  const file = `/home/u/.claude/projects/-work-app/${id}.jsonl`;
  const resume = resumeCmd({ sessionId: id, cwd }, "/home/u/.claude", "/home/u");
  upsertDoc(db, { source_path: file, source_type: "claude-code", tier: "episodic", title, content: prompts, event_ts: ts, resume_cmd: resume });
  summaries.forEach((s, i) =>
    upsertDoc(db, { source_path: `${file}#w${i + 1}`, source_type: "claude-code", tier: "episodic", title: `${title} (#w${i + 1})`, content: s, event_ts: ts + i, resume_cmd: resume }),
  );
  return file;
}

const notes = (cfg, sub) => fs.readdirSync(path.join(cfg.out, sub)).sort();
const read = (cfg, rel) => fs.readFileSync(path.join(cfg.out, rel), "utf8");
const write = (file, text) => (fs.mkdirSync(path.dirname(file), { recursive: true }), fs.writeFileSync(file, text));

test("config: unset is off; folder defaults to agent-kb; a folder outside the vault or a missing vault throws", () => {
  // Arrange
  const vault = tmp();

  // Act
  const off = obsidianConfig({});
  const dflt = obsidianConfig({ AGENT_KB_VAULT: vault });
  const nested = obsidianConfig({ AGENT_KB_VAULT: vault, AGENT_KB_VAULT_FOLDER: "Notes/kb" });

  // Assert
  assert.equal(off, null);
  assert.equal(dflt.out, path.join(vault, "agent-kb"));
  assert.equal(dflt.folder, "agent-kb");
  assert.equal(nested.folder, "Notes/kb");
  assert.throws(() => obsidianConfig({ AGENT_KB_VAULT: vault, AGENT_KB_VAULT_FOLDER: "../x" }), /inside the vault/);
  assert.throws(() => obsidianConfig({ AGENT_KB_VAULT: vault, AGENT_KB_VAULT_FOLDER: "/etc" }), /inside the vault/);
  assert.throws(() => obsidianConfig({ AGENT_KB_VAULT: vault, AGENT_KB_VAULT_FOLDER: "." }), /inside the vault/);
  assert.throws(() => obsidianConfig({ AGENT_KB_VAULT: path.join(vault, "nope") }), /not a directory/);
});

test("cwdOfResume reads back what resumeCmd wrote, quoted or not", () => {
  // Arrange
  const plain = resumeCmd({ sessionId: "s1", cwd: "/work/app" }, "/home/u/.claude", "/home/u");
  const spaced = resumeCmd({ sessionId: "s1", cwd: "/work/my app's dir" }, "/home/u/.claude", "/home/u");

  // Act / Assert
  assert.equal(cwdOfResume(plain), "/work/app");
  assert.equal(cwdOfResume(spaced), "/work/my app's dir");
  assert.equal(cwdOfResume("claude --resume s1"), null);
  assert.equal(cwdOfResume(null), null);
});

test("out: a session becomes a note with frontmatter, prompts, summaries and links to its project and day", () => {
  // Arrange
  const { db, cfg } = setup();
  session(db, "s1", { summaries: ["## DECISIONS\n- keep the alias"] });

  // Act
  const c = syncOut(db, cfg);

  // Assert
  assert.deepEqual(c, { written: 3, unchanged: 0, edited: 0, missing: 0, failed: 0 });
  assert.deepEqual(notes(cfg, "sessions"), ["2026-11-01 Fix login.md"]);
  const note = read(cfg, "sessions/2026-11-01 Fix login.md");
  assert.match(note, /^---\ngenerator: agent-kb\nagent_kb_hash: [0-9a-f]{64}\n/);
  assert.match(note, /\ndate: 2026-11-01\n/);
  assert.match(note, /\nharness: claude-code\n/);
  assert.match(note, /\nproject: "app"\n/);
  assert.match(note, /\ncwd: "\/work\/app"\n/);
  assert.match(note, /\nresume: "cd \/work\/app && claude --resume s1"\n/);
  assert.match(note, /\nsource_path: "\/home\/u\/.claude\/projects\/-work-app\/s1.jsonl"\n/);
  assert.match(note, /\ntags: \[agent-kb, claude-code\]\n/);
  assert.match(note, /\[\[agent-kb\/projects\/app\|app\]\] · \[\[agent-kb\/daily\/2026-11-01\|2026-11-01\]\]/);
  assert.match(note, /## Prompts\n\nfix the flaky login test/);
  assert.match(note, /## Summary #w1 \(2026-11-01\)\n\n## DECISIONS\n- keep the alias/);
  const daily = read(cfg, "daily/2026-11-01.md");
  assert.match(daily, /generator: agent-kb/);
  assert.match(daily, /- \[\[agent-kb\/sessions\/2026-11-01 Fix login\|Fix login\]\] — claude-code/);
  assert.match(read(cfg, "projects/app.md"), /\[\[agent-kb\/sessions\/2026-11-01 Fix login\|Fix login\]\]/);
});

test("out: a second sync writes 0 files", () => {
  // Arrange
  const { db, cfg } = setup();
  session(db, "s1", { summaries: ["a"] });
  session(db, "s2", { title: "Other", ts: DAY + 86_400_000 });
  syncOut(db, cfg);
  const before = fs.readdirSync(cfg.out, { recursive: true }).map((f) => [f, fs.statSync(path.join(cfg.out, f)).mtimeMs]);

  // Act
  const c = syncOut(db, cfg);

  // Assert
  assert.equal(c.written, 0);
  assert.equal(c.unchanged, 5); // 2 sessions, 2 days, 1 project
  const after = fs.readdirSync(cfg.out, { recursive: true }).map((f) => [f, fs.statSync(path.join(cfg.out, f)).mtimeMs]);
  assert.deepEqual(after, before);
});

test("out: a changed doc rewrites its note and the index notes that list it, nothing else", () => {
  // Arrange
  const { db, cfg } = setup();
  session(db, "s1");
  session(db, "s2", { title: "Other", ts: DAY + 86_400_000, cwd: "/work/other" });
  syncOut(db, cfg);

  // Act
  session(db, "s1", { summaries: ["new summary"] });
  const c = syncOut(db, cfg);

  // Assert
  assert.equal(c.written, 1);
  assert.match(read(cfg, "sessions/2026-11-01 Fix login.md"), /new summary/);
});

test("out: a renamed session or a later last-activity day updates its note in place, no second file", () => {
  // Arrange
  const { db, cfg } = setup();
  session(db, "s1");
  syncOut(db, cfg);

  // Act
  session(db, "s1", { title: "Renamed", ts: DAY + 3 * 86_400_000 });
  syncOut(db, cfg);

  // Assert
  assert.deepEqual(notes(cfg, "sessions"), ["2026-11-01 Fix login.md"]);
  const note = read(cfg, "sessions/2026-11-01 Fix login.md");
  assert.match(note, /# Renamed/);
  assert.match(note, /\ndate: 2026-11-04\n/);
  assert.deepEqual(notes(cfg, "daily"), ["2026-11-01.md", "2026-11-04.md"]);
});

test("out: a note the user edited is not overwritten, even when the doc changed; it is counted", () => {
  // Arrange
  const { db, cfg } = setup();
  session(db, "s1");
  syncOut(db, cfg);
  const rel = "sessions/2026-11-01 Fix login.md";
  const mine = read(cfg, rel).replace("tags: [agent-kb, claude-code]", "tags: [agent-kb, claude-code, mine]") + "\nMy own thoughts.\n";
  fs.writeFileSync(path.join(cfg.out, rel), mine);
  session(db, "s1", { summaries: ["agent-kb has news"] });

  // Act
  const c = syncOut(db, cfg);

  // Assert
  assert.equal(c.edited, 1);
  assert.equal(read(cfg, rel), mine);
});

test("out: a frontmatter-only edit counts as an edit", () => {
  // Arrange
  const { db, cfg } = setup();
  session(db, "s1");
  syncOut(db, cfg);
  const rel = "sessions/2026-11-01 Fix login.md";
  const mine = read(cfg, rel).replace("tags: [agent-kb, claude-code]", "tags: [mine]");
  fs.writeFileSync(path.join(cfg.out, rel), mine);
  session(db, "s1", { prompts: "changed prompt" });

  // Act
  const c = syncOut(db, cfg);

  // Assert
  assert.equal(c.edited, 1);
  assert.equal(read(cfg, rel), mine);
});

test("out: a user's own file at the wanted name is never taken; the note gets a suffix", () => {
  // Arrange
  const { db, cfg } = setup();
  const own = path.join(cfg.out, "sessions", "2026-11-01 Fix login.md");
  write(own, "# mine\n");
  session(db, "s1");

  // Act
  const c = syncOut(db, cfg);

  // Assert
  assert.equal(c.written, 3);
  assert.equal(fs.readFileSync(own, "utf8"), "# mine\n");
  assert.deepEqual(notes(cfg, "sessions"), ["2026-11-01 Fix login (2).md", "2026-11-01 Fix login.md"]);
});

test("out: two sessions with one date and title get two notes", () => {
  // Arrange
  const { db, cfg } = setup();
  session(db, "s1");
  session(db, "s2");

  // Act
  syncOut(db, cfg);

  // Assert
  assert.deepEqual(notes(cfg, "sessions"), ["2026-11-01 Fix login (2).md", "2026-11-01 Fix login.md"]);
  assert.match(read(cfg, "daily/2026-11-01.md"), /Fix login \(2\)/);
});

test("out: a note the user deleted or moved is not recreated", () => {
  // Arrange
  const { db, cfg } = setup();
  session(db, "s1");
  syncOut(db, cfg);
  const rel = "sessions/2026-11-01 Fix login.md";
  fs.renameSync(path.join(cfg.out, rel), path.join(cfg.vault, "moved.md"));

  // Act
  const c = syncOut(db, cfg);

  // Assert
  assert.equal(c.missing, 1);
  assert.equal(c.written, 0);
  assert.equal(fs.existsSync(path.join(cfg.out, rel)), false);
});

test("out: a title with path, link and control characters becomes one safe file name", () => {
  // Arrange
  const { db, cfg } = setup();
  session(db, "s1", { title: "../../etc/passwd: [[x]] #tag | a\nb?" });

  // Act
  syncOut(db, cfg);

  // Assert
  const [name] = notes(cfg, "sessions");
  assert.match(name, /^2026-11-01 [^/\\:*?"<>|#^[\]\n]+\.md$/);
  assert.deepEqual(fs.readdirSync(cfg.vault), ["agent-kb"]);
});

test("out: a session without a working dir has no project link and no project note", () => {
  // Arrange
  const { db, cfg } = setup();
  upsertDoc(db, { source_path: "https://claude.ai/chat/c1#saved", source_type: "claude-chat", tier: "episodic", title: "Chat note", content: "a chat", event_ts: DAY });

  // Act
  syncOut(db, cfg);

  // Assert
  assert.equal(fs.existsSync(path.join(cfg.out, "projects")), false);
  const note = read(cfg, "sessions/2026-11-01 Chat note.md");
  assert.doesNotMatch(note, /\nproject:/);
  assert.doesNotMatch(note, /projects\//);
  assert.match(note, /\[\[agent-kb\/daily\/2026-11-01\|2026-11-01\]\]/);
});

test("out: a row stored under older redaction rules is redacted again; a long source path is left as it is", () => {
  // Arrange
  const { db, cfg } = setup();
  const secret = "ghp_" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8";
  const long = "/Users/u/Library/Application Support/Claude/local-agent-mode-sessions/90bd4bcc-dce6-4612-a1f2-0123456789ab/.claude/projects/-sessions-x/90bd4bcc-dce6-4612-a1f2-0123456789ab.jsonl";
  const resume = `cd /w && claude --resume ${secret}`;
  const row = db.prepare("INSERT INTO documents (source_path, source_type, tier, title, content, event_ts, indexed_ts, resume_cmd) VALUES (?, 'claude-code', 'episodic', ?, ?, ?, 0, ?)");
  row.run(long, `Fix ${secret}`, `deploy with ${secret} now`, DAY, resume);

  // Act
  syncOut(db, cfg);

  // Assert
  for (const f of fs.readdirSync(cfg.out, { recursive: true })) {
    const p = path.join(cfg.out, f);
    if (fs.statSync(p).isFile()) assert.ok(!fs.readFileSync(p, "utf8").includes(secret.slice(0, 16)), f);
  }
  assert.ok(!notes(cfg, "sessions")[0].includes("ghp_"));
  const note = read(cfg, `sessions/${notes(cfg, "sessions")[0]}`);
  assert.ok(note.includes(`source_path: ${JSON.stringify(long)}`));
  assert.doesNotMatch(note, /\nresume:/);
});

test("out: unchanged inputs skip the render: a doc edited behind the store's back is not re-read", () => {
  // Arrange
  const { db, cfg } = setup();
  session(db, "s1");
  syncOut(db, cfg);
  db.prepare("UPDATE documents SET content = 'sneaky' WHERE source_path LIKE '%s1.jsonl'").run();

  // Act
  const same = syncOut(db, cfg);
  session(db, "s1", { prompts: "legit change" });
  const changed = syncOut(db, cfg);

  // Assert
  assert.equal(same.written, 0);
  assert.equal(same.unchanged, 3);
  assert.equal(changed.written, 1);
  assert.doesNotMatch(read(cfg, "sessions/2026-11-01 Fix login.md"), /sneaky/);
});

test("out: a day or project note whose sessions all moved on is rewritten without them", () => {
  // Arrange
  const { db, cfg } = setup();
  session(db, "s1");
  syncOut(db, cfg);

  // Act
  session(db, "s1", { title: "Renamed", ts: DAY + 3 * 86_400_000 });
  syncOut(db, cfg);

  // Assert
  assert.doesNotMatch(read(cfg, "daily/2026-11-01.md"), /Fix login|Renamed/);
  assert.match(read(cfg, "daily/2026-11-04.md"), /Renamed/);
});

test("out: a frozen file name that today's rules read as a secret is replaced, links included", () => {
  // Arrange
  const { db, cfg } = setup();
  session(db, "s1");
  syncOut(db, cfg);
  const secret = "ghp_" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8";
  const old = path.join(cfg.out, "sessions", "2026-11-01 Fix login.md");
  const frozen = path.join(cfg.out, "sessions", `2026-11-01 Fix ${secret}.md`);
  fs.renameSync(old, frozen);
  db.prepare("UPDATE obsidian_notes SET rel_path = ? WHERE key LIKE 's:%'").run(`sessions/2026-11-01 Fix ${secret}.md`);

  // Act
  const c = syncOut(db, cfg);

  // Assert
  assert.equal(c.written, 1); // the session note under its new name; the index notes already link that path
  assert.equal(fs.existsSync(frozen), false);
  assert.deepEqual(notes(cfg, "sessions"), ["2026-11-01 Fix login.md"]);
  for (const f of fs.readdirSync(cfg.out, { recursive: true })) {
    const p = path.join(cfg.out, f);
    if (fs.statSync(p).isFile()) assert.ok(!fs.readFileSync(p, "utf8").includes("ghp_"), f);
  }
});

test("out: a title that only becomes an assignment after file-name cleanup is redacted in its final form and stays stable", () => {
  // Arrange
  const { db, cfg } = setup();
  session(db, "s1", { title: "set password#=Qx7vT9zzK2 now" });

  // Act
  syncOut(db, cfg);
  const again = syncOut(db, cfg);

  // Assert
  assert.equal(again.written, 0);
  for (const f of fs.readdirSync(cfg.out, { recursive: true })) {
    const p = path.join(cfg.out, f);
    assert.ok(!f.includes("Qx7vT9zzK2"), f);
    if (fs.statSync(p).isFile()) assert.ok(!fs.readFileSync(p, "utf8").includes("Qx7vT9zzK2"), f);
  }
});

test("sync: a lock lost mid-sync stops the run with an error", () => {
  // Arrange
  const { db, cfg } = setup();
  for (let i = 0; i < 120; i++) session(db, `s${i}`, { title: `T${i}` });
  db.exec("CREATE TRIGGER steal AFTER INSERT ON obsidian_notes WHEN (SELECT count(*) FROM obsidian_notes) = 50 BEGIN UPDATE locks SET owner = 'other' WHERE name = 'obsidian'; END");

  // Act / Assert
  assert.throws(() => syncObsidian(db, cfg), /lost the obsidian lock/);
});

test("in: a sibling folder that differs from the output folder only in case is indexed where the disk tells them apart", (t) => {
  // Arrange
  const { db, vault, cfg } = setup();
  fs.mkdirSync(cfg.out);
  fs.mkdirSync(path.join(vault, "Agent-KB"), { recursive: true });
  if (fs.statSync(cfg.out).ino === fs.statSync(path.join(vault, "Agent-KB")).ino) return t.skip("case-insensitive disk: one folder");
  write(path.join(vault, "Agent-KB", "mine.md"), "my own note");

  // Act
  const c = syncIn(db, cfg);

  // Assert
  assert.equal(c.indexed, 1);
});

test("out: the sweep syncs the vault when AGENT_KB_VAULT is set, and reports a bad vault without throwing", async () => {
  // Arrange
  const vault = tmp();
  const db = openStore(":memory:");
  session(db, "s1");
  const empty = tmp();
  const base = { dirs: [empty], desktop: empty, sources: new Set() };

  // Act
  const ok = await sweepOnce(db, { ...base, env: { AGENT_KB_VAULT: vault } });
  const bad = await sweepOnce(db, { ...base, env: { AGENT_KB_VAULT: path.join(vault, "nope") } });
  const off = await sweepOnce(db, { ...base, env: {} });

  // Assert
  assert.equal(ok.obsidian.out.written, 3);
  assert.equal(fs.existsSync(path.join(vault, "agent-kb", "sessions", "2026-11-01 Fix login.md")), true);
  assert.match(bad.obsidian.error, /not a directory/);
  assert.equal(off.obsidian, null);
});

test("in: vault notes become semantic obsidian docs, searchable, with a heading title", () => {
  // Arrange
  const { db, vault, cfg } = setup();
  write(path.join(vault, "Ideas", "plan.md"), "---\ntags: [x]\n---\n# Quarterly plan\n\nship the zebra feature\n");
  write(path.join(vault, "plain.md"), "no heading, mentions marmalade\n");

  // Act
  const c = syncIn(db, cfg);

  // Assert
  assert.equal(c.indexed, 2);
  const d = getDoc(db, path.join(vault, "Ideas", "plan.md"));
  assert.equal(d.source_type, "obsidian");
  assert.equal(d.tier, "semantic");
  assert.equal(d.title, "Quarterly plan");
  assert.doesNotMatch(d.content, /tags:/);
  assert.equal(getDoc(db, path.join(vault, "plain.md")).title, "plain");
  assert.equal(search(db, "marmalade")[0].source_type, "obsidian");
});

test("in: the output folder is excluded", () => {
  // Arrange
  const { db, vault, cfg } = setup();
  session(db, "s1");
  syncOut(db, cfg);
  write(path.join(vault, "mine.md"), "my own note\n");

  // Act
  const c = syncIn(db, cfg);

  // Assert
  assert.equal(c.indexed, 1);
  assert.equal(db.prepare("SELECT count(*) AS n FROM documents WHERE source_type = 'obsidian'").get().n, 1);
});

test("in: a generated note the user moved out of the folder is still excluded, by its frontmatter", () => {
  // Arrange
  const { db, vault, cfg } = setup();
  session(db, "s1", { prompts: "unique-session-prompt-zzz" });
  syncOut(db, cfg);
  fs.mkdirSync(path.join(vault, "Archive"));
  fs.renameSync(path.join(cfg.out, "sessions", "2026-11-01 Fix login.md"), path.join(vault, "Archive", "kept.md"));
  write(path.join(vault, "mine.md"), "my own note\n");

  // Act
  const c = syncIn(db, cfg);

  // Assert
  assert.equal(c.indexed, 1);
  assert.equal(c.excluded, 1);
  assert.equal(getDoc(db, path.join(vault, "Archive", "kept.md")), null);
  assert.deepEqual(search(db, "unique-session-prompt-zzz").map((h) => h.source_type), ["claude-code"]);
});

test("in: a note that turns into agent-kb output loses its doc", () => {
  // Arrange
  const { db, vault, cfg } = setup();
  const f = path.join(vault, "n.md");
  write(f, "plain note\n");
  syncIn(db, cfg);
  assert.ok(getDoc(db, f));

  // Act
  write(f, "---\ngenerator: agent-kb\n---\nplain note\n");
  fs.utimesSync(f, new Date(), new Date(Date.now() + 5000));
  const c = syncIn(db, cfg);

  // Assert
  assert.equal(c.excluded, 1);
  assert.equal(getDoc(db, f), null);
});

test("isGenerated: frontmatter only, CRLF and quotes accepted, body mentions ignored", () => {
  // Act / Assert
  assert.equal(isGenerated("---\ngenerator: agent-kb\n---\nx"), true);
  assert.equal(isGenerated("---\r\ntags: [a]\r\ngenerator: \"agent-kb\"\r\n---\r\nx"), true);
  assert.equal(isGenerated("﻿---\ngenerator: Agent-KB # ours\n---\nx"), true);
  assert.equal(isGenerated("---\ngenerator: other\n---\nx"), false);
  assert.equal(isGenerated("---\ngenerator: agent-kb-fork\n---\nx"), false);
  assert.equal(isGenerated("# title\n\n---\ngenerator: agent-kb\n---\n"), false);
  assert.equal(isGenerated("text mentions generator: agent-kb\n"), false);
});

test("in: .obsidian, .trash, other dot-folders, symlinks, non-markdown and files over 1 MB are skipped", () => {
  // Arrange
  const { db, vault, cfg } = setup();
  write(path.join(vault, ".obsidian", "workspace.md"), "x");
  write(path.join(vault, ".trash", "old.md"), "x");
  write(path.join(vault, ".git", "n.md"), "x");
  write(path.join(vault, "big.md"), "x".repeat((1 << 20) + 1));
  write(path.join(vault, "img.png"), "x");
  const outside = tmp();
  write(path.join(outside, "secret.md"), "outside the vault");
  fs.symlinkSync(path.join(outside, "secret.md"), path.join(vault, "link.md"));
  fs.symlinkSync(outside, path.join(vault, "linkdir"));
  write(path.join(vault, "ok.md"), "fine");

  // Act
  const c = syncIn(db, cfg);

  // Assert
  assert.equal(c.indexed, 1);
  assert.equal(c.skipped, 1);
  assert.deepEqual(db.prepare("SELECT source_path FROM documents").all().map((r) => path.basename(r.source_path)), ["ok.md"]);
});

test("in: incremental by size and mtime; a changed note is read again", () => {
  // Arrange
  const { db, vault, cfg } = setup();
  const f = path.join(vault, "a.md");
  write(f, "first version aardvark");
  syncIn(db, cfg);

  // Act
  const same = syncIn(db, cfg);
  write(f, "second version, longer, platypus");
  const changed = syncIn(db, cfg);

  // Assert
  assert.deepEqual([same.indexed, same.unchanged], [0, 1]);
  assert.deepEqual([changed.indexed, changed.unchanged], [1, 0]);
  assert.equal(search(db, "aardvark").length, 0);
  assert.equal(search(db, "platypus").length, 1);
});

test("in: a deleted or moved note loses its doc and scan; a note in the same folder stays", () => {
  // Arrange
  const { db, vault, cfg } = setup();
  write(path.join(vault, "gone.md"), "soon deleted wombat");
  write(path.join(vault, "stay.md"), "stays");
  syncIn(db, cfg);

  // Act
  fs.renameSync(path.join(vault, "gone.md"), path.join(vault, "moved.md"));
  const c = syncIn(db, cfg);

  // Assert
  assert.equal(c.removed, 1);
  assert.equal(getDoc(db, path.join(vault, "gone.md")), null);
  assert.ok(getDoc(db, path.join(vault, "moved.md")));
  assert.equal(db.prepare("SELECT count(*) AS n FROM scans WHERE source_path = ?").get(path.join(vault, "gone.md")).n, 0);
});

test("in: a note that grew past 1 MB loses its doc", () => {
  // Arrange
  const { db, vault, cfg } = setup();
  const f = path.join(vault, "grows.md");
  write(f, "small");
  syncIn(db, cfg);

  // Act
  write(f, "x".repeat((1 << 20) + 1));
  const c = syncIn(db, cfg);

  // Assert
  assert.equal(c.removed, 1);
  assert.equal(getDoc(db, f), null);
});

test("in: a vault that cannot be listed completely removes nothing", { skip: process.getuid?.() === 0 }, () => {
  // Arrange
  const { db, vault, cfg } = setup();
  write(path.join(vault, "locked", "a.md"), "inside");
  write(path.join(vault, "b.md"), "outside");
  syncIn(db, cfg);
  fs.chmodSync(path.join(vault, "locked"), 0);

  // Act
  const c = syncIn(db, cfg);
  fs.chmodSync(path.join(vault, "locked"), 0o755);

  // Assert
  assert.equal(c.failed, 1);
  assert.equal(c.removed, 0);
  assert.ok(getDoc(db, path.join(vault, "locked", "a.md")));
});

test("in: docs of another vault are left alone", () => {
  // Arrange
  const { db, cfg } = setup();
  upsertDoc(db, { source_path: "/other/vault/n.md", source_type: "obsidian", tier: "semantic", title: "n", content: "other vault" });

  // Act
  const c = syncIn(db, cfg);

  // Assert
  assert.equal(c.removed, 0);
  assert.ok(getDoc(db, "/other/vault/n.md"));
});

test("in: secrets in a vault note are redacted before storage, search and kb_get", () => {
  // Arrange
  const { db, vault, cfg } = setup();
  const secret = "ghp_" + "Zy9X8w7V6u5T4s3R2q1P0o9N8m7L6k5J4i3H";
  write(path.join(vault, "creds.md"), `# Deploy notes\n\ntoken ${secret}\nDB_PASSWORD=hunter2hunter2\nrollout friday\n`);

  // Act
  syncIn(db, cfg);

  // Assert
  const d = getDoc(db, path.join(vault, "creds.md"));
  assert.ok(!d.content.includes(secret));
  assert.ok(!d.content.includes("hunter2hunter2"));
  assert.match(d.content, /rollout friday/);
  assert.equal(search(db, secret).length, 0);
});

test("in: a secret cut by the 32K clip leaves no fragment, because redaction runs before clipping", () => {
  // Arrange
  const { db, vault, cfg } = setup();
  const secret = "ghp_" + "Zy9X8w7V6u5T4s3R2q1P0o9N8m7L6k5J4i3H";
  write(path.join(vault, "long.md"), `# Long\n\n${"a ".repeat(11_989)}${secret} ${"b ".repeat(10_000)}\n`);

  // Act
  syncIn(db, cfg);

  // Assert
  const d = getDoc(db, path.join(vault, "long.md"));
  assert.ok(d.content.length < 33_000);
  assert.ok(!d.content.includes(secret.slice(0, 12)));
});

test("sync: out then in; the second run changes nothing, and agent-kb's own notes never come back as docs", () => {
  // Arrange
  const { db, vault, cfg } = setup();
  session(db, "s1", { summaries: ["decided: keep alias"] });
  write(path.join(vault, "mine.md"), "# Mine\n\nmy note");

  // Act
  const first = syncObsidian(db, cfg);
  const second = syncObsidian(db, cfg);

  // Assert
  assert.equal(first.out.written, 3);
  assert.equal(first.in.indexed, 1);
  assert.equal(second.out.written, 0);
  assert.deepEqual([second.in.indexed, second.in.unchanged], [0, 1]);
  assert.equal(db.prepare("SELECT count(*) AS n FROM documents WHERE source_type = 'obsidian'").get().n, 1);
});

test("sync: a held lock skips the run", () => {
  // Arrange
  const { db, cfg } = setup();
  db.prepare("INSERT INTO locks (name, owner, expires_ms) VALUES ('obsidian', 'other', ?)").run(Date.now() + 60_000);

  // Act
  const r = syncObsidian(db, cfg);

  // Assert
  assert.deepEqual(r, { locked: true });
});

test("cli: obsidian sync needs AGENT_KB_VAULT, validates usage, and writes the notes", () => {
  // Arrange
  const home = tmp();
  const vault = tmp();
  const claude = tmp();
  const dir = path.join(claude, "projects", "-w");
  fs.mkdirSync(dir, { recursive: true });
  const rec = (type, content) => JSON.stringify({ type, sessionId: "s1", cwd: "/w", timestamp: "2026-11-01T10:00:00Z", message: { content } }) + "\n";
  fs.writeFileSync(path.join(dir, "s1.jsonl"), rec("user", "rename loadConfig") + rec("assistant", [{ type: "text", text: "done" }]));
  const env = { ...process.env, AGENT_KB_HOME: home, AGENT_KB_CLAUDE_DIRS: claude, AGENT_KB_DESKTOP_DIR: tmp() };
  delete env.AGENT_KB_VAULT;
  delete env.AGENT_KB_VAULT_FOLDER;
  const run = (args, e = env) => spawnSync(process.execPath, [CLI, ...args], { env: e, encoding: "utf8" });

  // Act
  const noVault = run(["obsidian", "sync"]);
  const badArg = run(["obsidian"], { ...env, AGENT_KB_VAULT: vault });
  const badVault = run(["obsidian", "sync"], { ...env, AGENT_KB_VAULT: path.join(vault, "nope") });
  const bf = run(["backfill"]);
  const first = run(["obsidian", "sync"], { ...env, AGENT_KB_VAULT: vault, AGENT_KB_VAULT_FOLDER: "Notes/kb" });
  const second = run(["obsidian", "sync"], { ...env, AGENT_KB_VAULT: vault, AGENT_KB_VAULT_FOLDER: "Notes/kb" });

  // Assert
  assert.equal(noVault.status, 2);
  assert.match(noVault.stderr, /AGENT_KB_VAULT/);
  assert.equal(badArg.status, 2);
  assert.equal(badVault.status, 2);
  assert.equal(bf.status, 0, bf.stderr);
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /out: 3 written/);
  assert.match(second.stdout, /out: 0 written, 3 unchanged/);
  assert.deepEqual(fs.readdirSync(path.join(vault, "Notes", "kb", "sessions")), ["2026-11-01 rename loadConfig.md"]);
});
