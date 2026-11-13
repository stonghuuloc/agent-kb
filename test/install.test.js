import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
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
function run(version, args, env = {}) {
  const r = spawnSync("/bin/sh", [path.join(root, "hooks/run.sh"), ...args], { env: { PATH: fakeNodeDir(version), ...env }, encoding: "utf8" });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

test("hook exits 0 with a one-line hint when node is missing", posix, () => {
  // Arrange / Act
  const r = run(null, ["hook", "session-end"]);
  // Assert
  assert.equal(r.code, 0);
  assert.match(r.err, /^agent-kb: node not found\. .*22\.13/);
  assert.equal(r.err.trim().split("\n").length, 1);
  assert.equal(r.out, "");
});

test("hook exits 0 with a hint on node 22.12 and runs nothing", posix, () => {
  // Arrange / Act
  const r = run("v22.12.9", ["hook", "session-end"]);
  // Assert
  assert.equal(r.code, 0);
  assert.match(r.err, /v22\.12\.9 is too old/);
  assert.doesNotMatch(r.out, /ran:/);
});

test("server mode exits 1 on old node so Claude Code shows the failure", posix, () => {
  // Arrange / Act
  const r = run("v20.18.0", ["server"]);
  // Assert
  assert.equal(r.code, 1);
  assert.match(r.err, /too old/);
});

test("node 22.13, 22.20 and 24 pass the guard", posix, () => {
  for (const v of ["v22.13.0", "v22.20.1", "v24.22.1"]) {
    // Arrange / Act
    const r = run(v, ["check"]);
    // Assert
    assert.equal(r.code, 0, v);
    assert.equal(r.out.trim(), `agent-kb: node ${v} ok`);
  }
});

test("cli mode execs node on bin/agent-kb.js with the arguments", posix, () => {
  // Arrange / Act
  const r = run("v24.22.1", ["cli", "backfill"]);
  // Assert
  assert.match(r.out, new RegExp(`ran:${root}/hooks/\\.\\./bin/agent-kb\\.js backfill`));
});

test("plugin options map to AGENT_KB_* and an explicit AGENT_KB_* wins", posix, () => {
  // Arrange
  const env = { CLAUDE_PLUGIN_OPTION_SUMMARIZER: "claude", CLAUDE_PLUGIN_OPTION_SOURCES: "claude-cowork", AGENT_KB_SOURCES: "claude-code" };
  // Act
  const r = run("v24.22.1", ["cli", "stats"], env);
  // Assert
  assert.match(r.out, /env:claude\|claude-code/);
});

test("an unresolved ${user_config.*} placeholder is not exported", posix, () => {
  // Arrange / Act
  const r = run("v24.22.1", ["cli", "stats"], { CLAUDE_PLUGIN_OPTION_SUMMARIZER: "${user_config.summarizer}" });
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
function plugin({ npmOk = true, installed = false, npmScript } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "kb-plugin-"));
  mkdirSync(path.join(dir, "hooks"));
  copyFileSync(path.join(root, "hooks/run.sh"), path.join(dir, "hooks/run.sh"));
  if (installed) {
    mkdirSync(path.join(dir, "node_modules"));
    writeFileSync(path.join(dir, "node_modules/.agent-kb-ok"), "");
  }
  const bin = fakeNodeDir("v24.22.1");
  writeFileSync(path.join(bin, "npm"), `#!/bin/sh\n${npmScript ?? (npmOk ? "mkdir -p node_modules" : "exit 1")}\n`);
  chmodSync(path.join(bin, "npm"), 0o755);
  const pathVar = `${bin}:/bin:/usr/bin`;
  const go = (args) => {
    const r = spawnSync("/bin/sh", [path.join(dir, "hooks/run.sh"), ...args], { env: { PATH: pathVar }, encoding: "utf8" });
    return { code: r.status, out: r.stdout, err: r.stderr };
  };
  return { dir, go, path: pathVar, marker: path.join(dir, "node_modules/.agent-kb-ok") };
}

test("a failed first-start npm ci leaves no marker, so the next start installs again", posix, () => {
  // Arrange
  const p = plugin({ npmOk: false });
  // Act
  const r = p.go(["server"]);
  // Assert
  assert.equal(r.code, 1);
  assert.equal(existsSync(p.marker), false);
  assert.equal(existsSync(path.join(p.dir, ".install.lock")), false);
});

test("a successful first start writes the marker and runs the server", posix, () => {
  // Arrange
  const p = plugin();
  // Act
  const r = p.go(["server"]);
  // Assert
  assert.equal(r.code, 0);
  assert.equal(existsSync(p.marker), true);
  assert.match(r.out, /ran:.*src\/server\.js/);
});

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

test("a lock left by a dead process is taken over, and a failed install frees it", posix, () => {
  // Arrange
  const p = plugin();
  symlinkSync("999999", path.join(p.dir, ".install.lock"));
  const bad = plugin({ npmOk: false });
  // Act
  const r = p.go(["server"]);
  bad.go(["server"]);
  // Assert
  assert.equal(r.code, 0);
  assert.equal(existsSync(p.marker), true);
  assert.equal(lstatSync(path.join(bad.dir, ".install.lock"), { throwIfNoEntry: false }), undefined);
});

test("three starts racing on a dead lock run npm ci once", posix, async () => {
  // Arrange
  const p = plugin({ npmScript: 'echo run >> npm-count; sleep 1; mkdir -p node_modules' });
  symlinkSync("999999", path.join(p.dir, ".install.lock"));
  const runOne = () => new Promise((res) => spawn("/bin/sh", [path.join(p.dir, "hooks/run.sh"), "server"], { env: { PATH: p.path }, stdio: "ignore" }).on("close", res));
  // Act
  const codes = await Promise.all([runOne(), runOne(), runOne()]);
  // Assert
  assert.deepEqual(codes, [0, 0, 0]);
  assert.equal(readFileSync(path.join(p.dir, "npm-count"), "utf8").trim().split("\n").length, 1);
});

test("a SIGTERM during npm ci frees the lock and the server never starts", posix, async () => {
  // Arrange
  const p = plugin({ npmScript: "sleep 2; mkdir -p node_modules" });
  const child = spawn("/bin/sh", [path.join(p.dir, "hooks/run.sh"), "server"], { env: { PATH: p.path }, stdio: ["ignore", "pipe", "ignore"] });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  const closed = new Promise((res) => child.on("close", res));
  await new Promise((r) => setTimeout(r, 500));
  // Act
  child.kill("SIGTERM");
  const code = await closed;
  // Assert
  assert.equal(code, 1);
  assert.equal(out, "");
  assert.equal(existsSync(p.marker), false);
  assert.equal(lstatSync(path.join(p.dir, ".install.lock"), { throwIfNoEntry: false }), undefined);
});

test("an unwritable plugin dir fails fast instead of spinning", posix, () => {
  // Arrange
  const p = plugin();
  chmodSync(p.dir, 0o555);
  // Act
  const r = p.go(["server"]);
  chmodSync(p.dir, 0o755);
  // Assert
  assert.equal(r.code, 1);
  assert.match(r.err, /cannot create the install lock/);
});
