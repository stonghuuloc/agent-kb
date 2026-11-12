import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openStore, getDoc } from "../src/store.js";
import { listTranscripts } from "../src/adapters/claude-code.js";
import { desktopDir, desktopTitles, withDesktopTitles } from "../src/adapters/claude-desktop.js";
import { backfillTier0 } from "../src/backfill.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "agent-kb-desk-"));
const line = (o) => JSON.stringify(o) + "\n";

/** A Desktop dir holding Code-tab metadata files at `claude-code-sessions/<account>/<org>/`. */
function desktop(files) {
  const dir = tmp();
  const org = path.join(dir, "claude-code-sessions", "acct", "org");
  fs.mkdirSync(org, { recursive: true });
  for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(org, name), typeof body === "string" ? body : JSON.stringify(body));
  return dir;
}

/** A CLI config dir with one transcript of session `id` (no ai-title, as the Code tab writes it). */
function cli(id) {
  const cfg = tmp();
  const dir = path.join(cfg, "projects", "-w");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${id}.jsonl`);
  fs.writeFileSync(file, line({ type: "user", sessionId: id, cwd: "/w", entrypoint: "claude-desktop", timestamp: "2026-11-01T10:00:00Z", message: { content: "fix the flaky upload test" } }));
  return { cfg, file };
}

test("the Desktop data dir per OS, and the override", () => {
  // Arrange
  const home = "/h";

  // Act + Assert
  assert.equal(desktopDir({}, "darwin", home), path.join(home, "Library", "Application Support", "Claude"));
  assert.equal(desktopDir({ APPDATA: "/ad" }, "win32", home), path.join("/ad", "Claude"));
  assert.equal(desktopDir({}, "linux", home), path.join(home, ".config", "Claude"));
  assert.equal(desktopDir({ XDG_CONFIG_HOME: "/x" }, "linux", home), path.join("/x", "Claude"));
  assert.equal(desktopDir({ AGENT_KB_DESKTOP_DIR: "/d" }, "darwin", home), path.resolve("/d"));
});

test("Desktop titles are read by CLI session id; bad, untitled and stray files are skipped", () => {
  // Arrange
  const dir = desktop({
    "local_a.json": { sessionId: "local_a", cliSessionId: "cli-a", title: "  Fix flaky upload test ", cwd: "/w" },
    "local_b.json": { sessionId: "local_b", cliSessionId: "cli-b", cwd: "/w" },
    "local_c.json": { sessionId: "local_c", title: "no cli session yet" },
    "local_d.json": "{ half-writ",
    "scheduled-tasks.json": { cliSessionId: "cli-x", title: "not a session" },
  });
  fs.writeFileSync(path.join(dir, "claude-code-sessions", "local_e.json"), JSON.stringify({ cliSessionId: "cli-e", title: "too shallow" }));

  // Act
  const titles = desktopTitles(dir);

  // Assert
  assert.deepEqual([...titles], [["cli-a", "Fix flaky upload test"]]);
  assert.equal(desktopTitles(path.join(dir, "missing")).size, 0, "no Desktop installed");
});

test("a Code-tab session is indexed under its Desktop title, and re-indexed when renamed", async () => {
  // Arrange
  const id = crypto.randomUUID();
  const { cfg, file } = cli(id);
  const dir = desktop({ [`local_${id}.json`]: { cliSessionId: id, title: "Upload test triage" } });
  const db = openStore(path.join(tmp(), "kb.sqlite"));
  const list = () => withDesktopTitles(listTranscripts([cfg]), desktopTitles(dir));

  // Act
  const first = await backfillTier0(db, list());
  const again = await backfillTier0(db, list());
  fs.writeFileSync(path.join(dir, "claude-code-sessions", "acct", "org", `local_${id}.json`), JSON.stringify({ cliSessionId: id, title: "Upload test fixed" }));
  const renamed = await backfillTier0(db, list());

  // Assert
  assert.equal(first.indexed, 1);
  assert.equal(again.unchanged, 1);
  assert.equal(renamed.indexed, 1);
  assert.equal(getDoc(db, file).title, "Upload test fixed");
  assert.match(getDoc(db, file).content, /flaky upload/);
});

test("a Desktop title holding a secret is stored redacted and does not re-index every run", async () => {
  // Arrange
  const id = crypto.randomUUID();
  const { cfg, file } = cli(id);
  const token = "ghp_" + crypto.randomBytes(27).toString("base64url").replace(/[-_]/g, "x").slice(0, 36);
  const dir = desktop({ [`local_${id}.json`]: { cliSessionId: id, title: `rotate ${token}` } });
  const db = openStore(path.join(tmp(), "kb.sqlite"));
  const list = () => withDesktopTitles(listTranscripts([cfg]), desktopTitles(dir));

  // Act
  await backfillTier0(db, list());
  const again = await backfillTier0(db, list());

  // Assert
  assert.ok(!getDoc(db, file).title.includes(token));
  assert.equal(again.unchanged, 1);
});

test("a transcript with no Desktop metadata keeps its own title", async () => {
  // Arrange
  const { cfg, file } = cli(crypto.randomUUID());
  const db = openStore(path.join(tmp(), "kb.sqlite"));

  // Act
  await backfillTier0(db, withDesktopTitles(listTranscripts([cfg]), desktopTitles(desktop({}))));

  // Assert
  assert.equal(getDoc(db, file).title, "fix the flaky upload test");
});
