import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { summarizerFromEnv } from "../src/summarize.js";

const root = path.resolve(import.meta.dirname, "..");
const read = (f) => readFileSync(path.join(root, f), "utf8");
const json = (f) => JSON.parse(read(f));
const posix = { skip: process.platform === "win32" && "run.sh needs a POSIX shell" };

/** A PATH holding only a fake `node` that prints `version` for --version, else its argv. */
function fakeNodeDir(version) {
  const dir = mkdtempSync(path.join(tmpdir(), "kb-node-"));
  if (version) {
    writeFileSync(path.join(dir, "node"), `#!/bin/sh\n[ "$1" = --version ] && echo ${version} && exit 0\necho "ran:$*"\necho "env:$AGENT_KB_SUMMARIZER|$AGENT_KB_SOURCES"\n`);
    chmodSync(path.join(dir, "node"), 0o755);
  }
  return dir;
}
function runInstalled(version, args, env = {}) {
  return plugin({ installed: true, version }).go(args, env);
}
function run(version, args, env = {}) {
  const r = spawnSync("/bin/sh", [path.join(root, "hooks/run.sh"), ...args], { env: { PATH: fakeNodeDir(version), ...env }, encoding: "utf8" });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

test("hook exits 0 with a one-line hint when node is missing", posix, () => {
  // Arrange / Act
  const r = run(null, ["hook", "session-end"]);
  // Assert
  assert.equal(r.code, 0);
  assert.match(r.err, /^agent-kb: node not found\. .*22\.16/);
  assert.equal(r.err.trim().split("\n").length, 1);
  assert.equal(r.out, "");
});

test("hook exits 0 with a hint on node 22.15 (no FTS5) and runs nothing", posix, () => {
  // Arrange / Act
  const r = run("v22.15.1", ["hook", "session-end"]);
  // Assert
  assert.equal(r.code, 0);
  assert.match(r.err, /v22\.15\.1 is too old/);
  assert.doesNotMatch(r.out, /ran:/);
});

test("server mode exits 1 on old node so Claude Code shows the failure", posix, () => {
  // Arrange / Act
  const r = run("v20.18.0", ["server"]);
  // Assert
  assert.equal(r.code, 1);
  assert.match(r.err, /too old/);
});

test("node 22.16, 22.20 and 24 pass the guard", posix, () => {
  for (const v of ["v22.16.0", "v22.20.1", "v24.22.1"]) {
    // Arrange / Act
    const r = runInstalled(v, ["check"]);
    // Assert
    assert.equal(r.code, 0, v);
    assert.equal(r.out.trim(), `agent-kb: node ${v} ok`);
  }
});

test("cli mode execs node on bin/agent-kb.js with the arguments", posix, () => {
  // Arrange / Act
  const r = runInstalled("v24.22.1", ["cli", "backfill"]);
  // Assert
  assert.match(r.out, /ran:--disable-warning=ExperimentalWarning .*\/hooks\/\.\.\/bin\/agent-kb\.js backfill/);
});

test("plugin options map to AGENT_KB_* and an explicit AGENT_KB_* wins", posix, () => {
  // Arrange
  const env = { CLAUDE_PLUGIN_OPTION_SUMMARIZER: "claude", CLAUDE_PLUGIN_OPTION_SOURCES: "claude-cowork", AGENT_KB_SOURCES: "claude-code" };
  // Act
  const r = runInstalled("v24.22.1", ["cli", "stats"], env);
  // Assert
  assert.match(r.out, /env:claude\|claude-code/);
});

test("an unresolved ${user_config.*} placeholder is not exported", posix, () => {
  // Arrange / Act
  const r = runInstalled("v24.22.1", ["cli", "stats"], { CLAUDE_PLUGIN_OPTION_SUMMARIZER: "${user_config.summarizer}" });
  // Assert
  assert.match(r.out, /env:\|/);
});

test("plugin, marketplace, mcpb and package agree on name and version", () => {
  // Arrange
  const pkg = json("package.json");
  // Act / Assert
  assert.equal(json(".claude-plugin/plugin.json").name, "agent-kb");
  assert.equal(json(".claude-plugin/marketplace.json").plugins[0].name, json(".claude-plugin/plugin.json").name);
  for (const f of [".claude-plugin/plugin.json", "manifest.json"]) assert.equal(json(f).version, pkg.version, f);
  assert.equal(json("manifest.json").compatibility.runtimes.node, `>=${pkg.engines.node.replace(">=", "")}`);
});

test("every plugin option is passed to the MCP server, and the mcpb env uses the same keys", () => {
  // Arrange
  const keys = Object.keys(json(".claude-plugin/plugin.json").userConfig).sort();
  const mcpEnv = json(".mcp.json").mcpServers["agent-kb"].env;
  const mcpbEnv = json("manifest.json").server.mcp_config.env;
  // Act
  const fromMcp = Object.values(mcpEnv).map((v) => v.match(/^\$\{user_config\.(\w+)\}$/)[1]).sort();
  const fromMcpb = Object.values(mcpbEnv).map((v) => v.match(/^\$\{user_config\.(\w+)\}$/)[1]).sort();
  // Assert
  assert.deepEqual(fromMcp, keys);
  assert.deepEqual(fromMcpb, keys);
  assert.deepEqual(Object.keys(json("manifest.json").user_config).sort(), keys);
  assert.equal(json("manifest.json").user_config.api_key.sensitive, true);
  assert.equal(json(".claude-plugin/plugin.json").userConfig.api_key.sensitive, true);
});

test("hooks go through the node guard, not bare node", () => {
  // Arrange
  const hooks = json("hooks/hooks.json").hooks;
  // Act
  const commands = Object.values(hooks).flatMap((e) => e.flatMap((g) => g.hooks.map((h) => h.command)));
  // Assert
  assert.ok(commands.length > 0);
  for (const c of commands) assert.match(c, /^sh "\$\{CLAUDE_PLUGIN_ROOT\}\/hooks\/run\.sh" hook /);
});

test("the first-run disclosure is the same text in the README, the setup command and the mcpb", () => {
  // Arrange
  const text = read("docs/DISCLOSURE.md").trim();
  // Act / Assert
  assert.ok(read("README.md").includes(text), "README");
  assert.ok(read("commands/agent-kb-setup.md").includes(text), "commands/agent-kb-setup.md");
  assert.equal(json("manifest.json").long_description, text);
});

test("the summarizer stays off unless chosen (Principle 4)", () => {
  // Arrange / Act
  const defaults = [json(".claude-plugin/plugin.json").userConfig.summarizer.default, json("manifest.json").user_config.summarizer.default];
  // Assert
  assert.deepEqual(defaults, ["off", "off"]);
});

/** A copy of run.sh in its own plugin root, with fake node and npm on PATH. */
function plugin({ npmOk = true, installed = false, npmScript, version = "v24.22.1" } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "kb-plugin-"));
  mkdirSync(path.join(dir, "hooks"));
  copyFileSync(path.join(root, "hooks/run.sh"), path.join(dir, "hooks/run.sh"));
  if (installed) {
    mkdirSync(path.join(dir, "node_modules"));
    writeFileSync(path.join(dir, "node_modules/.agent-kb-ok"), "");
  }
  const bin = fakeNodeDir(version);
  writeFileSync(path.join(bin, "npm"), `#!/bin/sh\n${npmScript ?? (npmOk ? "mkdir -p node_modules" : "exit 1")}\n`);
  chmodSync(path.join(bin, "npm"), 0o755);
  const pathVar = `${bin}:/bin:/usr/bin`;
  const go = (args, env = {}) => {
    const r = spawnSync("/bin/sh", [path.join(dir, "hooks/run.sh"), ...args], { env: { PATH: pathVar, ...env }, encoding: "utf8" });
    return { code: r.status, out: r.stdout, err: r.stderr };
  };
  return { dir, go, path: pathVar, marker: path.join(dir, "node_modules/.agent-kb-ok") };
}

test("the hook does nothing on a half-installed tree and runs once the marker exists", posix, () => {
  // Arrange
  const half = plugin();
  mkdirSync(path.join(half.dir, "node_modules/@modelcontextprotocol"), { recursive: true });
  const done = plugin({ installed: true });
  // Act
  const a = half.go(["hook", "session-end"]);
  const b = done.go(["hook", "session-end"]);
  // Assert
  assert.equal(a.out, "");
  assert.match(b.out, /ran:.*agent-kb\.js hook session-end/);
});

test("the API key reaches the SDK only as AGENT_KB_API_KEY, never as ANTHROPIC_API_KEY", async () => {
  // Arrange
  let sent;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    sent = new Headers(init.headers).get("authorization");
    return new Response(JSON.stringify({ id: "m", type: "message", role: "assistant", model: "m", content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } }), { headers: { "content-type": "application/json" } });
  };
  try {
    // Act
    await summarizerFromEnv({ AGENT_KB_SUMMARIZER: "api", AGENT_KB_API_KEY: "form-key" })("hi");
  } finally {
    globalThis.fetch = realFetch;
  }
  // Assert
  assert.equal(sent, "Bearer form-key");
  for (const f of [read("hooks/run.sh"), read(".mcp.json"), read("manifest.json")]) assert.doesNotMatch(f, /ANTHROPIC_API_KEY/);
});

test("check and cli say the dependencies are missing instead of crashing on an import", posix, () => {
  // Arrange
  const p = plugin();
  // Act
  const check = p.go(["check"]);
  const cli = p.go(["cli", "backfill"]);
  // Assert
  for (const r of [check, cli]) {
    assert.equal(r.code, 1);
    assert.match(r.err, /dependencies are not installed yet/);
    assert.doesNotMatch(r.out, /ran:|ok/);
  }
});

/** A copy of launch.cjs in its own plugin root, with a fake npm-cli.js and a fake server, run by this node. */
const SERVER = 'import "node:sqlite";\nconsole.log(`server ran ${process.execArgv.join(" ")}|${process.env.AGENT_KB_SUMMARIZER ?? ""}|${process.env.AGENT_KB_SOURCES ?? ""}`);\n';
function launcher({ npm = "fs.mkdirSync('node_modules', { recursive: true });", installed = false, server = SERVER } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "kb-launch-"));
  mkdirSync(path.join(dir, "hooks"));
  mkdirSync(path.join(dir, "src"));
  writeFileSync(path.join(dir, "package.json"), '{ "type": "module" }');
  copyFileSync(path.join(root, "hooks/launch.cjs"), path.join(dir, "hooks/launch.cjs"));
  writeFileSync(path.join(dir, "src/server.js"), server);
  const cli = path.join(dir, "fake-npm", "npm-cli.cjs");
  mkdirSync(path.dirname(cli));
  writeFileSync(cli, `const fs = require("fs");\nconsole.log("npm says hi");\n${npm}\n`);
  if (installed) {
    mkdirSync(path.join(dir, "node_modules"));
    writeFileSync(path.join(dir, "node_modules/.agent-kb-ok"), "");
  }
  const env = (extra = {}) => ({ PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, npm_execpath: cli, ...extra });
  const args = [path.join(dir, "hooks/launch.cjs")];
  const go = (extra) => {
    const r = spawnSync(process.execPath, args, { env: env(extra), encoding: "utf8" });
    return { code: r.status, out: r.stdout, err: r.stderr };
  };
  const start = (stdio = "ignore") => spawn(process.execPath, args, { env: env(), stdio });
  return { dir, go, start, marker: path.join(dir, "node_modules/.agent-kb-ok"), lock: path.join(dir, ".install.lock") };
}
const gone = (f) => lstatSync(f, { throwIfNoEntry: false }) === undefined;

test("the MCP server starts through node launch.cjs on every OS, not sh", () => {
  // Arrange
  const server = json(".mcp.json").mcpServers["agent-kb"];
  // Act / Assert
  assert.equal(server.command, "node");
  assert.deepEqual(server.args, ["${CLAUDE_PLUGIN_ROOT}/hooks/launch.cjs"]);
  // Desktop takes the script from args and logs stderr itself: no node flags there (a flag broke the start)
  assert.deepEqual(json("manifest.json").server.mcp_config.args, ["${__dirname}/src/server.js"]);
});

test("the launcher's node guard rejects 22.15 and older and accepts 22.16 on", () => {
  // Arrange
  const { tooOld } = createRequire(import.meta.url)("../hooks/launch.cjs");
  // Act
  const verdicts = ["v18.20.0", "v20.18.0", "v22.15.1", "v22.16.0", "v22.20.1", "v24.22.1", "garbage"].map(tooOld);
  // Assert
  assert.deepEqual(verdicts, [true, true, true, false, false, false, true]);
});

test("a first start installs, writes the marker and runs the server quietly; npm output stays off stdout", () => {
  // Arrange
  const p = launcher();
  // Act
  const r = p.go({ CLAUDE_PLUGIN_OPTION_SUMMARIZER: "claude", CLAUDE_PLUGIN_OPTION_SOURCES: "${user_config.sources}" });
  // Assert
  assert.equal(r.code, 0, r.err);
  assert.equal(existsSync(p.marker), true);
  assert.equal(r.out, "server ran --disable-warning=ExperimentalWarning|claude|\n");
  assert.match(r.err, /npm says hi/);
  assert.doesNotMatch(r.err, /ExperimentalWarning/);
  assert.equal(gone(p.lock), true);
});

test("a failed first-start npm ci leaves no marker and no lock, and the server never starts", () => {
  // Arrange
  const p = launcher({ npm: "process.exit(1);" });
  // Act
  const r = p.go();
  // Assert
  assert.equal(r.code, 1);
  assert.match(r.err, /npm ci failed/);
  assert.equal(r.out, "");
  assert.equal(existsSync(p.marker), false);
  assert.equal(gone(p.lock), true);
  assert.deepEqual(readdirSync(p.dir).filter((f) => f.startsWith(".install")), []);
});

test("without npm_execpath the launcher runs the npm on PATH, through its symlink (Homebrew, nvm)", posix, () => {
  // Arrange
  const p = launcher();
  const bin = mkdtempSync(path.join(tmpdir(), "kb-bin-"));
  symlinkSync(path.join(p.dir, "fake-npm", "npm-cli.cjs"), path.join(bin, "npm"));
  // Act
  const r = p.go({ npm_execpath: "", PATH: `${bin}${path.delimiter}${process.env.PATH}` });
  // Assert
  assert.equal(r.code, 0, r.err);
  assert.match(r.err, /npm says hi/);
});

test("an installed tree skips npm", () => {
  // Arrange
  const p = launcher({ installed: true, npm: "process.exit(1);" });
  // Act
  const r = p.go();
  // Assert
  assert.equal(r.code, 0, r.err);
  assert.doesNotMatch(r.err, /npm says hi/);
});

test("a lock left by a dead process is taken over", () => {
  // Arrange
  const p = launcher();
  writeFileSync(p.lock, "999999");
  // Act
  const r = p.go();
  // Assert
  assert.equal(r.code, 0, r.err);
  assert.equal(existsSync(p.marker), true);
  assert.equal(gone(p.lock), true);
});

test("a lock held by a live process is waited for, and its install is used", async () => {
  // Arrange
  const p = launcher({ npm: "process.exit(1);" });
  writeFileSync(p.lock, String(process.pid));
  // Act
  const child = p.start(["ignore", "pipe", "pipe"]);
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  await new Promise((r) => setTimeout(r, 1500));
  mkdirSync(path.join(p.dir, "node_modules"));
  writeFileSync(p.marker, "");
  const code = await new Promise((res) => child.on("close", res));
  // Assert
  assert.equal(code, 0);
  assert.match(out, /server ran/);
  assert.equal(readFileSync(p.lock, "utf8"), String(process.pid), "the holder's lock is left alone");
});

test("three starts racing on a dead lock run npm ci once", async () => {
  // Arrange
  const p = launcher({ npm: "fs.appendFileSync('npm-count', 'run\\n'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000); fs.mkdirSync('node_modules', { recursive: true });" });
  writeFileSync(p.lock, "999999");
  const runOne = () => new Promise((res) => p.start().on("close", res));
  // Act
  const codes = await Promise.all([runOne(), runOne(), runOne()]);
  // Assert
  assert.deepEqual(codes, [0, 0, 0]);
  assert.equal(readFileSync(path.join(p.dir, "npm-count"), "utf8").trim().split("\n").length, 1);
});

test("a SIGTERM during npm ci frees the lock and the server never starts", posix, async () => {
  // Arrange
  const p = launcher({ npm: "fs.writeFileSync('npm-started', ''); setTimeout(() => fs.mkdirSync('node_modules', { recursive: true }), 2000);" });
  const child = p.start(["ignore", "pipe", "ignore"]);
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  const closed = new Promise((res) => child.on("close", res));
  for (let i = 0; i < 200 && !existsSync(path.join(p.dir, "npm-started")); i++) await new Promise((r) => setTimeout(r, 50));
  // Act
  child.kill("SIGTERM");
  const code = await closed;
  // Assert
  assert.equal(code, 1);
  assert.equal(out, "");
  assert.equal(existsSync(p.marker), false);
  assert.equal(gone(p.lock), true);
});

test("an unwritable plugin dir fails fast instead of spinning", { skip: (process.platform === "win32" || process.getuid?.() === 0) && "needs a POSIX non-root user" }, () => {
  // Arrange
  const p = launcher();
  chmodSync(p.dir, 0o555);
  // Act
  const r = p.go();
  chmodSync(p.dir, 0o755);
  // Assert
  assert.equal(r.code, 1);
  assert.match(r.err, /cannot write to/);
});

test("run.sh server hands over to launch.cjs", posix, () => {
  // Arrange / Act
  const r = runInstalled("v24.22.1", ["server"]);
  // Assert
  assert.match(r.out, /ran:.*\/hooks\/\.\.\/hooks\/launch\.cjs$/m);
});

test("the launcher exits with the server's exit code", () => {
  // Arrange
  const p = launcher({ installed: true, server: "process.exit(3);\n" });
  // Act
  const r = p.go();
  // Assert
  assert.equal(r.code, 3);
});

test("a SIGTERM to the launcher reaches the running server", posix, async () => {
  // Arrange
  const p = launcher({
    installed: true,
    server: 'import fs from "node:fs";\nprocess.on("SIGTERM", () => { fs.writeFileSync("got-term", ""); process.exit(0); });\nfs.writeFileSync("up", "");\nsetInterval(() => {}, 1000);\n',
  });
  const child = spawn(process.execPath, [path.join(p.dir, "hooks/launch.cjs")], { cwd: p.dir, env: { PATH: process.env.PATH }, stdio: "ignore" });
  const closed = new Promise((res) => child.on("close", res));
  for (let i = 0; i < 200 && !existsSync(path.join(p.dir, "up")); i++) await new Promise((r) => setTimeout(r, 50));
  // Act
  child.kill("SIGTERM");
  const code = await closed;
  // Assert
  assert.equal(existsSync(path.join(p.dir, "got-term")), true);
  assert.equal(code, 0);
});

test("a SIGTERM while waiting for the install lock leaves no lock file behind", posix, async () => {
  // Arrange
  const p = launcher();
  writeFileSync(p.lock, String(process.pid));
  const child = p.start();
  const closed = new Promise((res) => child.on("close", res));
  for (let i = 0; i < 200 && !readdirSync(p.dir).some((f) => /^\.install\.lock\.\d+$/.test(f)); i++) await new Promise((r) => setTimeout(r, 50));
  // Act
  child.kill("SIGTERM");
  const code = await closed;
  // Assert
  assert.equal(code, 1);
  assert.deepEqual(readdirSync(p.dir).filter((f) => f.startsWith(".install")), [".install.lock"]);
});
