import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openStore, getDoc } from "../src/store.js";
import { search } from "../src/search.js";
import { configDirs, listTranscripts, readSession, resumeCmd } from "../src/adapters/claude-code.js";
import { backfillTier0 } from "../src/backfill.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "agent-kb-cc-"));
const line = (o) => JSON.stringify(o) + "\n";

/** A transcript in the shape Claude Code writes: <config>/projects/<project>/<session>.jsonl */
function writeSession(configDir, id, records, project = "-tmp-app") {
  const dir = path.join(configDir, "projects", project);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${id}.jsonl`);
  fs.writeFileSync(file, records.map(line).join(""));
  return file;
}

const user = (text, extra = {}) => ({
  type: "user",
  sessionId: "s1",
  cwd: "/work/app",
  gitBranch: "main",
  timestamp: "2026-11-01T10:00:00Z",
  message: { role: "user", content: text },
  ...extra,
});

const SESSION = [
  user("fix the flaky login test"),
  { type: "assistant", sessionId: "s1", timestamp: "2026-11-01T10:01:00Z", message: { content: [{ type: "text", text: "on it" }] } },
  user("meta line", { isMeta: true }),
  user([{ type: "tool_result", content: "tool output" }], { timestamp: "2026-11-01T10:02:00Z" }),
  user("<system-reminder>injected</system-reminder>then rotate the retry budget", { timestamp: "2026-11-01T10:03:00Z" }),
  user("sidechain prompt", { isSidechain: true }),
  { type: "ai-title", sessionId: "s1", aiTitle: "Flaky login test" },
];

test("config dirs: override list, else CLAUDE_CONFIG_DIR plus ~/.claude without duplicates", () => {
  // Act
  const override = configDirs({ AGENT_KB_CLAUDE_DIRS: ["/a", "/b"].join(path.delimiter) }, "/home/u");
  const both = configDirs({ CLAUDE_CONFIG_DIR: "/p/home" }, "/home/u");
  const same = configDirs({ CLAUDE_CONFIG_DIR: "/home/u/.claude" }, "/home/u");

  // Assert
  assert.deepEqual(override, ["/a", "/b"]);
  assert.deepEqual(both, [path.resolve("/p/home"), path.join("/home/u", ".claude")]);
  assert.deepEqual(same, [path.join("/home/u", ".claude")]);
});

test("only top-level session transcripts are listed; a dir without projects is skipped", () => {
  // Arrange
  const cfg = tmp();
  const file = writeSession(cfg, "s1", SESSION);
  fs.mkdirSync(path.join(cfg, "projects", "-tmp-app", "s1", "subagents"), { recursive: true });
  fs.writeFileSync(path.join(cfg, "projects", "-tmp-app", "s1", "subagents", "agent-1.jsonl"), "");
  fs.writeFileSync(path.join(cfg, "projects", "-tmp-app", "notes.txt"), "");

  // Act
  const found = listTranscripts([cfg, path.join(cfg, "missing")]);

  // Assert
  assert.deepEqual(found, [{ file, configDir: cfg }]);
});

test("a session keeps only what the user typed, plus its title, cwd and time span", async () => {
  // Arrange
  const file = writeSession(tmp(), "s1", SESSION);
  fs.appendFileSync(file, '{"type":"user","message":{"content":"half-writ');

  // Act
  const s = await readSession(file);

  // Assert
  assert.deepEqual(s.prompts, ["fix the flaky login test", "then rotate the retry budget"]);
  assert.equal(s.title, "Flaky login test");
  assert.equal(s.cwd, "/work/app");
  assert.equal(s.sessionId, "s1");
  assert.equal(s.started, Date.parse("2026-11-01T10:00:00Z"));
  assert.equal(s.lastActivity, Date.parse("2026-11-01T10:03:00Z"));
});

test("resume command adds CLAUDE_CONFIG_DIR only outside ~/.claude and quotes paths", () => {
  // Arrange
  const s = { sessionId: "s1", cwd: "/work/my app" };

  // Act
  const home = resumeCmd(s, "/home/u/.claude", "/home/u");
  const profile = resumeCmd(s, "/Users/u/Library/Application Support/p", "/home/u");

  // Assert
  assert.equal(home, "cd '/work/my app' && claude --resume s1");
  assert.equal(profile, "cd '/work/my app' && CLAUDE_CONFIG_DIR='/Users/u/Library/Application Support/p' claude --resume s1");
});

test("tier 0 makes sessions searchable and resumable, skips unchanged files, re-reads grown ones", async () => {
  // Arrange
  const cfg = tmp();
  const file = writeSession(cfg, "s1", SESSION);
  writeSession(cfg, "s2", [{ type: "ai-title", sessionId: "s2", aiTitle: "empty" }]);
  const db = openStore(":memory:");

  // Act
  const first = await backfillTier0(db, listTranscripts([cfg]));
  const second = await backfillTier0(db, listTranscripts([cfg]));
  fs.appendFileSync(file, line(user("also bump the timeout", { timestamp: "2026-11-02T09:00:00Z" })));
  fs.utimesSync(file, new Date(), new Date(Date.now() + 5000));
  const third = await backfillTier0(db, listTranscripts([cfg]));

  // Assert
  assert.deepEqual(first, { indexed: 1, unchanged: 0, empty: 1, failed: 0 });
  assert.deepEqual(second, { indexed: 0, unchanged: 2, empty: 0, failed: 0 });
  assert.deepEqual(third, { indexed: 1, unchanged: 1, empty: 0, failed: 0 });
  const doc = getDoc(db, file);
  assert.equal(doc.title, "Flaky login test");
  assert.equal(doc.event_ts, Date.parse("2026-11-02T09:00:00Z"));
  assert.match(doc.resume_cmd, /^cd \/work\/app && CLAUDE_CONFIG_DIR=\S+ claude --resume s1$/);
  assert.deepEqual(search(db, "timeout").map((h) => h.source_path), [file]);
});

test("a secret typed into a prompt never reaches the store", async () => {
  // Arrange
  const cfg = tmp();
  const secret = "ghp_" + "aB3dE9xK2m".repeat(4);
  const file = writeSession(cfg, "s1", [user(`use ${secret} for the push`)]);
  const db = openStore(":memory:");

  // Act
  await backfillTier0(db, listTranscripts([cfg]));

  // Assert
  const doc = getDoc(db, file);
  assert.ok(!doc.content.includes(secret) && !doc.title.includes(secret));
});

test("a session without an AI title is named by its first prompt, markup removed", async () => {
  // Arrange
  const cfg = tmp();
  const file = writeSession(cfg, "s1", [user('<teammate-message id="x">\nWave 4:   deploy the API</teammate-message>')]);
  const db = openStore(":memory:");

  // Act
  await backfillTier0(db, listTranscripts([cfg]));

  // Assert
  assert.equal(getDoc(db, file).title, "Wave 4: deploy the API");
});
