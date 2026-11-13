import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

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
  const env = { CLAUDE_PLUGIN_OPTION_summarizer: "claude", CLAUDE_PLUGIN_OPTION_sources: "claude-cowork", AGENT_KB_SOURCES: "claude-code" };
  // Act
  const r = run("v24.22.1", ["cli", "stats"], env);
  // Assert
  assert.match(r.out, /env:claude\|claude-code/);
});

test("an unresolved ${user_config.*} placeholder is not exported", posix, () => {
  // Arrange / Act
  const r = run("v24.22.1", ["cli", "stats"], { CLAUDE_PLUGIN_OPTION_summarizer: "${user_config.summarizer}" });
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
