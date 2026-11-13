import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openStore, getDoc } from "../src/store.js";
import { listTranscripts } from "../src/adapters/claude-code.js";
import { allTranscripts, coworkTranscripts, desktopDir, desktopTitles, withDesktopTitles } from "../src/adapters/claude-desktop.js";
import { markGone, summarizeIdle } from "../src/sweep.js";
import { search } from "../src/search.js";
import { formatHits } from "../src/format.js";
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

/** A Desktop dir with one Cowork session: its metadata file and the CLI transcript inside it. */
function cowork({ meta = { title: "Plan the offsite" }, age = 7 * 3_600_000 } = {}) {
  const dir = tmp();
  const org = path.join(dir, "local-agent-mode-sessions", "acct", "org");
  const id = crypto.randomUUID();
  const projects = path.join(org, `local_${id}`, ".claude", "projects", "-sessions-x-outputs");
  fs.mkdirSync(projects, { recursive: true });
  fs.writeFileSync(path.join(org, `local_${id}.json`), typeof meta === "string" ? meta : JSON.stringify({ cliSessionId: id, ...meta }));
  fs.writeFileSync(path.join(org, `local_${id}`, "audit.jsonl"), line({ type: "user", session_id: id, message: { content: "audit copy" } }));
  const file = path.join(projects, `${id}.jsonl`);
  const rec = (type, content) => ({ type, sessionId: id, cwd: "/sessions/x", timestamp: "2026-11-01T10:00:00Z", message: { content } });
  fs.writeFileSync(file, line(rec("user", "draft an agenda for the team offsite with three sessions")) + line(rec("assistant", [{ type: "text", text: "Agenda drafted: planning, retro, roadmap." }])));
  const t = new Date(Date.now() - age);
  fs.utimesSync(file, t, t);
  return { dir, file };
}

test("Cowork transcripts are listed as claude-cowork with the Desktop title and no resume", () => {
  // Arrange
  const ok = cowork();
  const bad = cowork({ meta: "{ half" });

  // Act
  const listed = coworkTranscripts(ok.dir);
  const untitled = coworkTranscripts(bad.dir);

  // Assert
  assert.deepEqual(listed.map((t) => [t.file, t.sourceType, t.title, t.resumable]), [[ok.file, "claude-cowork", "Plan the offsite", false]]);
  assert.deepEqual(untitled.map((t) => [t.file, t.title]), [[bad.file, undefined]], "a half-written metadata file still lists the transcript");
  assert.deepEqual(coworkTranscripts(path.join(ok.dir, "missing")), []);
});

test("a Cowork session is indexed, summarized and flagged gone under claude-cowork", async () => {
  // Arrange
  const { dir, file } = cowork();
  const cfg = tmp();
  const db = openStore(path.join(tmp(), "kb.sqlite"));
  const all = allTranscripts([cfg], dir);
  const summarize = async () => "## DECISIONS\n- three sessions";

  // Act
  await backfillTier0(db, all);
  const s = await summarizeIdle(db, all, summarize);
  const shown = formatHits(search(db, "offsite agenda"));
  fs.rmSync(file);
  const gone = markGone(db);

  // Assert
  const doc = getDoc(db, file);
  assert.equal(s.summarized, 1);
  assert.deepEqual([doc.source_type, doc.title, doc.resume_cmd], ["claude-cowork", "Plan the offsite", null]);
  assert.equal(getDoc(db, `${file}#w1`).source_type, "claude-cowork");
  assert.match(shown, /resume: open it in Claude Desktop \(Cowork\)/);
  assert.equal(gone, 1);
  assert.equal(getDoc(db, `${file}#w1`).transcript_gone, 1);
});
