#!/usr/bin/env node
// Starts a clean copy of the plugin the way Claude Code does (`node hooks/launch.cjs`, first-start npm ci),
// then checks the MCP handshake and the tool list. Exits 1 on any failure.
import { spawn } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const plugin = mkdtempSync(path.join(tmpdir(), "agent kb smoke ")); // a space, as in Windows user paths
const home = mkdtempSync(path.join(tmpdir(), "agent-kb-smoke-home-"));
for (const f of ["package.json", "package-lock.json", "hooks", "bin", "src"]) cpSync(path.join(root, f), path.join(plugin, f), { recursive: true });
const expected = JSON.parse(readFileSync(path.join(root, "manifest.json"), "utf8")).tools.map((t) => t.name).sort();

const srv = spawn(process.execPath, [path.join(plugin, "hooks", "launch.cjs")], {
  env: { ...process.env, AGENT_KB_HOME: home, AGENT_KB_SWEEP: "off", CLAUDE_PLUGIN_OPTION_SUMMARIZER: "off" },
  stdio: ["pipe", "pipe", "pipe"],
});
let buf = "";
let err = "";
const waiting = new Map();
srv.stderr.on("data", (d) => (err += d));
const exited = new Promise((res) => srv.on("exit", (c) => res(c)));
srv.stdout.on("data", (d) => {
  buf += d;
  for (let i; (i = buf.indexOf("\n")) >= 0; buf = buf.slice(i + 1)) {
    const line = buf.slice(0, i);
    let m;
    try {
      m = JSON.parse(line);
    } catch {
      throw new Error(`non-JSON on the server's stdout: ${line}`);
    }
    waiting.get(m.id)?.(m);
  }
});
let id = 0;
const call = (method, params) =>
  new Promise((res, rej) => {
    const n = ++id;
    const t = setTimeout(() => rej(new Error(`${method}: no answer in 5 min`)), 300_000);
    waiting.set(n, (m) => (clearTimeout(t), res(m)));
    exited.then((c) => rej(new Error(`${method}: the launcher exited with ${c}`)));
    srv.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: n, method, params }) + "\n");
  });

let code = 1;
try {
  const init = await call("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "smoke", version: "0" } });
  srv.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  const tools = (await call("tools/list", {})).result.tools.map((t) => t.name).sort();
  if (init.result?.serverInfo?.name !== "agent-kb") throw new Error(`unexpected initialize reply: ${JSON.stringify(init)}`);
  if (JSON.stringify(tools) !== JSON.stringify(expected)) throw new Error(`tools ${tools} != manifest ${expected}`);
  if (/ExperimentalWarning/.test(err)) throw new Error("the server printed node's ExperimentalWarning");
  console.log(`smoke ok: ${tools.join(" ")}`);
  code = 0;
} catch (e) {
  console.error(`smoke failed: ${e.message}\n--- server stderr ---\n${err.slice(-3000)}`);
} finally {
  srv.kill();
  rmSync(plugin, { recursive: true, force: true, maxRetries: 5 });
  rmSync(home, { recursive: true, force: true, maxRetries: 5 });
}
process.exit(code);
