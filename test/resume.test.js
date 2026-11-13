import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { openStore, upsertDoc } from "../src/store.js";
import { createServer } from "../src/mcp.js";
import { findResume, forkCommand, handoffPrompt, parseResume, sessionContext } from "../src/resume.js";
import { sessionStart } from "../src/hooks.js";
import { shellInit } from "../src/shell.js";
import { search } from "../src/search.js";

const CLI = path.resolve("bin/agent-kb.js");
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "agent-kb-resume-"));
const T = Date.UTC(2026, 10, 1);

function seed(db, over = {}) {
  upsertDoc(db, {
    source_path: "/c/projects/-w-app/s1.jsonl",
    source_type: "claude-code",
    tier: "episodic",
    title: "Fix flaky login",
    content: "login flaky clock skew",
    event_ts: T,
    resume_cmd: "cd /w/app && claude --resume s1",
    ...over,
  });
}

test("parseResume reads cwd and prefix of our own resume commands only", () => {
  // Arrange
  const own = String.raw`cd '/w/it'\''s' && CLAUDE_CONFIG_DIR=/p claude --resume s1`;

  // Act
  const r = parseResume(own);
  const bad = ["cd /x && touch /tmp/pwned; claude --resume 1", "claude --resume 1 && id", "https://claude.ai/chat/x", null].map(parseResume);

  // Assert
  assert.equal(r.cwd, "/w/it's");
  assert.equal(r.prefix, String.raw`cd '/w/it'\''s' && CLAUDE_CONFIG_DIR=/p `);
  assert.deepEqual(bad, [null, null, null, null]);
});

test("findResume returns the best match that has a command, and says what to do otherwise", () => {
  // Arrange
  const db = openStore(":memory:");
  const chatUrl = "https://claude.ai/chat/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
  seed(db, { source_path: "/c/projects/-w-app/gone.jsonl", title: "gone", content: "deleted" });
  db.prepare("UPDATE documents SET transcript_gone = 1 WHERE source_path LIKE '%gone.jsonl'").run();
  upsertDoc(db, { source_path: chatUrl, source_type: "claude-chat", tier: "episodic", title: "chat", content: "pagination", event_ts: T, resume_cmd: chatUrl });
  upsertDoc(db, { source_path: "/c/cow.jsonl", source_type: "claude-cowork", tier: "episodic", title: "cowork", content: "roadmap", event_ts: T });
  upsertDoc(db, { source_path: "/c/projects/-w-evil/e.jsonl", source_type: "claude-code", tier: "episodic", title: "evil", content: "tampered", event_ts: T, resume_cmd: "cd /x && touch /tmp/pwned; claude --resume e" });
  seed(db, { source_path: "/c/projects/-w-app/live.jsonl", title: "live", content: "login ok", resume_cmd: "cd /w/app && claude --resume live" });
  seed(db, { source_path: "/c/projects/-w-app/older.jsonl", title: "older", content: "login ok too", event_ts: T - 200 * 86_400_000, resume_cmd: "cd /w/app && claude --resume older" });

  // Act
  const live = findResume(db, "login", T);
  const gone = findResume(db, "deleted");
  const chat = findResume(db, "pagination");
  const cowork = findResume(db, "roadmap");
  const evil = findResume(db, "tampered");
  const none = findResume(db, "zzzz");

  // Assert
  assert.equal(live.cmd, "cd /w/app && claude --resume live");
  assert.match(gone.why, /transcript deleted by the host app; `agent-kb fork`/);
  assert.equal(gone.cmd, undefined);
  assert.match(chat.why, /open it in the browser: https:\/\/claude\.ai\/chat\//);
  assert.match(cowork.why, /Claude Desktop \(Cowork\)/);
  assert.equal(evil.cmd, undefined);
  assert.match(evil.why, /no session to resume/);
  assert.equal(none, null);
});

test("findResume skips a better-ranked hit that has no command", () => {
  // Arrange
  const db = openStore(":memory:");
  seed(db, { source_path: "/c/projects/-w-app/gone.jsonl", title: "login login login", content: "login" });
  db.prepare("UPDATE documents SET transcript_gone = 1 WHERE source_path LIKE '%gone.jsonl'").run();
  seed(db, { source_path: "/c/projects/-w-app/live.jsonl", title: "other", content: "login once", resume_cmd: "cd /w/app && claude --resume live" });

  // Act
  const r = findResume(db, "login", T);

  // Assert
  assert.equal(r.cmd, "cd /w/app && claude --resume live");
});

test("findResume resolves a summary-only hit to its session's current command", () => {
  // Arrange
  const db = openStore(":memory:");
  seed(db, { content: "unrelated" });
  seed(db, { source_path: "/c/projects/-w-app/s1.jsonl#w1", title: null, content: "quokka migration", resume_cmd: null }); // copied before the session had a command

  // Act
  const r = findResume(db, "quokka", T);

  // Assert
  assert.equal(r.hit.source_path, "/c/projects/-w-app/s1.jsonl#w1");
  assert.equal(r.cmd, "cd /w/app && claude --resume s1");
});

test("fork --to claude warns when the session's resume command cannot be parsed, instead of dropping its folder silently", () => {
  // Arrange
  const db = openStore(":memory:");
  const stored = String.raw`cd '/work/a\b' && claude --resume s1`;
  seed(db, { resume_cmd: stored });
  const hit = search(db, "login")[0];
  const dbOk = openStore(":memory:");
  seed(dbOk);

  // Act
  const ok = forkCommand(dbOk, search(dbOk, "login")[0], "p", tmp());
  const bad = forkCommand(db, hit, "p", tmp());

  // Assert
  assert.equal(ok.warning, null);
  assert.match(bad.cmd, /^claude "/);
  assert.match(bad.warning, /cannot reuse the session's folder/);
  assert.ok(bad.warning.includes(stored));
});

test("handoff prompt carries notes, transcript path and the re-check warning, with secrets redacted", () => {
  // Arrange
  const db = openStore(":memory:");
  const secret = "ghp_" + "aB3dE5gH7jK9mN1pQ3sT5vW7yZ9bD1fH3jK5";
  seed(db);
  seed(db, { source_path: "/c/projects/-w-app/s1.jsonl#w1", title: null, content: "DECISIONS\n- keep alias" });
  db.prepare("UPDATE documents SET content = ? WHERE source_path LIKE '%#w1'").run(`DECISIONS\n- keep alias\nGITHUB_TOKEN=${secret}`); // a row written before redaction rules improved
  const hit = search(db, "login")[0];

  // Act
  const p = handoffPrompt(db, hit);

  // Assert
  assert.match(p, /Re-check live state before acting/);
  assert.match(p, /Transcript: \/c\/projects\/-w-app\/s1\.jsonl/);
  assert.match(p, /Folder: \/w\/app/);
  assert.match(p, /keep alias/);
  assert.doesNotMatch(p, new RegExp(secret));
});

test("redaction leaves doc paths whole in the prompt and the session context, and still hides secrets in titles", () => {
  // Arrange
  const db = openStore(":memory:");
  const secret = "ghp_" + "aB3dE5gH7jK9mN1pQ3sT5vW7yZ9bD1fH3jK5";
  const file = "/c/projects/-w-app/70492f87-84c9-435b-abf8-142510837123-Xk9Qz2Lm8Rt4Vb6Nc1.jsonl";
  seed(db, { source_path: file, title: "t" });
  db.prepare("UPDATE documents SET title = ? WHERE source_path = ?").run(`deploy GITHUB_TOKEN=${secret}`, file);

  // Act
  const prompt = handoffPrompt(db, search(db, "login")[0]);
  const ctx = sessionContext(db, { cwd: "/w/app" });

  // Assert
  assert.ok(prompt.includes(`Transcript: ${file}`), "prompt keeps the transcript path");
  assert.ok(ctx.includes(`\n  ${file}`), "context keeps the doc path");
  assert.doesNotMatch(prompt + ctx, new RegExp(secret));
});

test("a resume command with a backslash inside quotes is not runnable (fish reads backslash-quote as an escape)", () => {
  // Arrange
  const evil = String.raw`cd '/tmp/x\'\'' ; touch /tmp/PWN ; echo '\''' && claude --resume abc`;

  // Act
  const r = parseResume(evil);

  // Assert
  assert.equal(r, null);
});

test("handoff prompt falls back to the user's prompts when there is no summary", () => {
  // Arrange
  const db = openStore(":memory:");
  seed(db);

  // Act
  const p = handoffPrompt(db, search(db, "login")[0]);

  // Assert
  assert.match(p, /No summary yet/);
  assert.match(p, /clock skew/);
});

test("fork --to claude starts claude in the session's folder with the prompt, kept out of the printed command", { skip: process.platform === "win32" }, () => {
  // Arrange
  const db = openStore(":memory:");
  const cwd = path.join(tmp(), "it's a dir");
  fs.mkdirSync(cwd);
  seed(db, { resume_cmd: `cd '${cwd.replaceAll("'", "'\\''")}' && claude --resume s1` });
  const hit = search(db, "login")[0];
  const prompt = handoffPrompt(db, hit);
  const bin = tmp();
  fs.writeFileSync(path.join(bin, "claude"), '#!/bin/sh\npwd -P\nprintf %s "$1"\n', { mode: 0o755 });

  // Act
  const { file, cmd } = forkCommand(db, hit, prompt, tmp());
  const r = spawnSync("sh", ["-c", cmd], { encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });

  // Assert
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.ok(!cmd.includes("Re-check"), "prompt text is not on the command line");
  assert.equal(r.stdout, `${fs.realpathSync(cwd)}\n${prompt}`);
});

test("session context lists this folder's other sessions, newest first, within 5 docs and 2K chars", () => {
  // Arrange
  const db = openStore(":memory:");
  for (let i = 0; i < 8; i++) {
    seed(db, { source_path: `/c/projects/-w-app/s${i}.jsonl`, title: `Session ${i}`, content: `prompt ${i} ${"x".repeat(500)}`, event_ts: T + i * 1000 });
  }
  seed(db, { source_path: "/c/projects/-w-app/s7.jsonl#w1", title: null, content: "## DECISIONS\n- chose sqlite over files", event_ts: T + 7000 });
  seed(db, { source_path: "/c/projects/-w-other/o.jsonl", title: "Other folder", content: "other" });
  const current = "/c/projects/-w-app/s6.jsonl";

  // Act
  const out = sessionContext(db, { cwd: "/w/app", transcript: current });

  // Assert
  assert.ok(out.length <= 2000);
  assert.equal(out.split("\n- ").length - 1, 5);
  assert.match(out, /Session 7 \(2026-11-01\): chose sqlite over files\n {2}\/c\/projects\/-w-app\/s7\.jsonl/);
  assert.doesNotMatch(out, /Other folder|s6\.jsonl/);
  assert.ok(out.indexOf("Session 7") < out.indexOf("Session 5"));
});

test("session context stays under 2K chars with long titles, and is empty for an unknown folder", () => {
  // Arrange
  const db = openStore(":memory:");
  for (let i = 0; i < 5; i++) seed(db, { source_path: `/c/projects/-w-app/s${i}.jsonl`, title: "T".repeat(600), content: "y".repeat(900), event_ts: T + i });

  // Act
  const big = sessionContext(db, { cwd: "/w/app" });
  const none = sessionContext(db, { cwd: "/nowhere" });

  // Assert
  assert.ok(big.length > 0 && big.length <= 2000);
  assert.equal(none, "");
});

test("SessionStart hook prints the host's additionalContext JSON; off, child, no kb and bad input print nothing", () => {
  // Arrange
  const file = path.join(tmp(), "kb.sqlite");
  const seeded = openStore(file);
  seed(seeded);
  seeded.close();
  const input = JSON.stringify({ hook_event_name: "SessionStart", cwd: "/w/app", transcript_path: "/c/projects/-w-app/new.jsonl" });
  const open = () => openStore(file);
  const boom = () => {
    throw new Error("schema too new");
  };

  // Act
  const on = JSON.parse(sessionStart(input, { env: {}, open }));
  const quiet = [
    sessionStart(input, { env: { AGENT_KB_CONTEXT: "off" }, open }),
    sessionStart(input, { env: { AGENT_KB_CHILD: "1" }, open }),
    sessionStart(input, { env: {}, open: () => null }),
    sessionStart("not json", { env: {}, open }),
    sessionStart(input, { env: {}, open: boom }),
    sessionStart(JSON.stringify({ cwd: "/nowhere" }), { env: {}, open }),
  ];

  // Assert
  assert.equal(on.hookSpecificOutput.hookEventName, "SessionStart");
  assert.match(on.hookSpecificOutput.additionalContext, /Fix flaky login/);
  assert.deepEqual(quiet, ["", "", "", "", "", ""]);
});

test("CLI: resume prints only the command on stdout; fork prints the prompt; hook session-start never fails", () => {
  // Arrange
  const home = tmp();
  const env = { ...process.env, AGENT_KB_HOME: home };
  const db = openStore(path.join(home, "kb.sqlite"));
  seed(db);
  db.close();
  const run = (args, input) => spawnSync(process.execPath, [CLI, ...args], { env, input, encoding: "utf8" });

  // Act
  const resume = run(["resume", "flaky", "login"]);
  const miss = run(["resume", "zzzz"]);
  const fork = run(["fork", "login"]);
  const forkClaude = run(["fork", "login", "--to", "claude"]);
  const hook = run(["hook", "session-start"], JSON.stringify({ cwd: "/w/app" }));
  const hookBad = run(["hook", "session-start"], "garbage");
  const usage = run(["resume"]);

  // Assert
  assert.equal(resume.stdout, "cd /w/app && claude --resume s1\n");
  assert.match(resume.stderr, /Fix flaky login/);
  assert.deepEqual([miss.status, usage.status], [1, 2]);
  assert.match(fork.stdout, /Re-check live state/);
  assert.match(forkClaude.stdout, /^cd \/w\/app && claude "\$\(cat .*handoff\.md\)"\n$/);
  assert.match(JSON.parse(hook.stdout).hookSpecificOutput.additionalContext, /Fix flaky login/);
  assert.deepEqual([hook.status, hookBad.status, hookBad.stdout], [0, 0, ""]);
});

test("kbr asks before running: y runs the resume command, anything else does not", { skip: spawnSync("zsh", ["-c", "true"]).error !== undefined }, () => {
  // Arrange
  const bin = tmp();
  const out = path.join(bin, "ran");
  fs.writeFileSync(path.join(bin, "agent-kb"), `#!/bin/sh\necho "touch ${out}"\n`, { mode: 0o755 });
  const run = (shell, answer) => {
    fs.rmSync(out, { force: true });
    spawnSync(shell, ["-c", `${shellInit(shell)}\nkbr login`], { input: answer, encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
    return fs.existsSync(out);
  };

  // Act
  const got = ["zsh", "bash"].flatMap((sh) => ["y\n", "\n", "no\n"].map((a) => run(sh, a)));

  // Assert
  assert.deepEqual(got, [true, false, false, true, false, false]);
});

test("shell-init prints a function per shell and rejects others", () => {
  // Arrange
  const r = (s) => spawnSync(process.execPath, [CLI, "shell-init", s], { encoding: "utf8" });

  // Act
  const [zsh, bash, fish, bad] = ["zsh", "bash", "fish", "tcsh"].map(r);

  // Assert
  assert.match(zsh.stdout, /^kbr\(\)/);
  assert.match(bash.stdout, /^kbr\(\)/);
  assert.match(fish.stdout, /^function kbr/);
  assert.equal(bad.status, 2);
});

test("kb_resume and kb_fork over MCP", async () => {
  // Arrange
  const db = openStore(":memory:");
  seed(db);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createServer(db).connect(a);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(b);

  // Act
  const resume = await client.callTool({ name: "kb_resume", arguments: { query: "flaky" } });
  const fork = await client.callTool({ name: "kb_fork", arguments: { query: "flaky" } });
  const forkClaude = await client.callTool({ name: "kb_fork", arguments: { query: "flaky", to: "claude" } });
  const miss = await client.callTool({ name: "kb_resume", arguments: { query: "zzzz" } });

  // Assert
  assert.match(resume.content[0].text, /resume: cd \/w\/app && claude --resume s1/);
  assert.match(fork.content[0].text, /Re-check live state/);
  assert.doesNotMatch(fork.content[0].text, /start:/);
  assert.match(forkClaude.content[0].text, /start: cd \/w\/app && claude "\$\(cat /);
  assert.equal(miss.content[0].text, "No matches.");
});
