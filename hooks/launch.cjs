#!/usr/bin/env node
"use strict";
// MCP server launcher, run as `node launch.cjs` on every OS (Windows has no `sh` on PATH).
// Plain CommonJS with no newer syntax, so an old node still parses it and prints the hint.
// Node guard, CLAUDE_PLUGIN_OPTION_* → AGENT_KB_*, first-start `npm ci` under a lock, then the server.
const fs = require("fs");
const path = require("path");
const { spawn, spawnSync } = require("child_process");

const MIN = [22, 16]; // first node:sqlite with FTS5
const HINT = "agent-kb needs Node >= 22.16 (https://nodejs.org/en/download or: nvm install 22). Claude Code's native installer ships no Node.";
const OPTIONS = { SUMMARIZER: "AGENT_KB_SUMMARIZER", SOURCES: "AGENT_KB_SOURCES", VAULT_DIR: "AGENT_KB_VAULT", VAULT_FOLDER: "AGENT_KB_VAULT_FOLDER", API_KEY: "AGENT_KB_API_KEY" };
const QUIET = "--disable-warning=ExperimentalWarning"; // node:sqlite warns on every start
const WAIT_S = 120;
const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"];

function tooOld(version) {
  const m = /^v?(\d+)\.(\d+)/.exec(version);
  if (!m) return true;
  const major = Number(m[1]);
  return major < MIN[0] || (major === MIN[0] && Number(m[2]) < MIN[1]);
}

/** Plugin options reach us as CLAUDE_PLUGIN_OPTION_<KEY>; an AGENT_KB_* already set wins; an unresolved `${…}` is dropped. */
function mapOptions(env) {
  const out = Object.assign({}, env);
  for (const key of Object.keys(OPTIONS)) {
    const val = env["CLAUDE_PLUGIN_OPTION_" + key];
    if (!val || val.indexOf("${") === 0 || out[OPTIONS[key]]) continue;
    out[OPTIONS[key]] = val;
  }
  return out;
}

/** npm's JS entry, run under this node: no shell, so Windows paths with spaces or %VARS% stay intact. */
function npmCli(env) {
  const near = (dir) => [path.join(dir, "node_modules", "npm", "bin", "npm-cli.js"), path.join(dir, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js")];
  const candidates = [env.npm_execpath];
  // the `npm` on PATH first, as a shell would pick it: a symlink to npm-cli.js (Homebrew, nvm) or a shim beside node_modules/npm (Windows)
  for (const dir of (env.PATH || env.Path || "").split(path.delimiter).filter(Boolean)) {
    for (const name of ["npm", "npm.cmd"]) {
      let real;
      try {
        real = fs.realpathSync(path.join(dir, name));
      } catch (e) {
        continue;
      }
      candidates.push(real);
      candidates.push.apply(candidates, near(path.dirname(real)));
    }
  }
  candidates.push.apply(candidates, near(path.dirname(process.execPath)));
  return candidates.filter((f) => f && /npm-cli\.c?js$/.test(f) && fs.existsSync(f))[0] || null;
}

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM"; // exists, owned by another user
  }
};
const readPid = (file) => {
  try {
    return Number(fs.readFileSync(file, "utf8")) || 0;
  } catch (e) {
    return 0;
  }
};
// a read, not existsSync: CodeQL reads exists-then-write on one path as a race
const present = (file) => {
  try {
    fs.readFileSync(file);
    return true;
  } catch (e) {
    return false;
  }
};
// Claude Desktop runs this file in an Electron utility process: process.execPath is the app, not node.
const electron = Boolean(process.versions.electron);
/** A real node binary for the npm step: this one outside Electron, else the first `node` on PATH. */
function nodeBin(env) {
  if (!electron) return process.execPath;
  const exe = process.platform === "win32" ? "node.exe" : "node";
  for (const dir of (env.PATH || env.Path || "").split(path.delimiter).filter(Boolean)) {
    const f = path.join(dir, exe);
    try {
      if (fs.statSync(f).isFile()) return f;
    } catch (e) {}
  }
  return null;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fail(msg) {
  process.stderr.write("agent-kb: " + msg + "\n");
  process.exit(1);
}

/** Holds `lock` (its content is the holder's pid) or returns false once `ok` appears. */
async function takeLock(lock, ok) {
  const mine = lock + "." + process.pid;
  const drop = () => fs.rmSync(mine, { force: true });
  process.on("exit", drop); // fail() exits from inside the loop
  fs.writeFileSync(mine, String(process.pid));
  try {
    for (let n = 0; ; n++) {
      try {
        fs.linkSync(mine, lock); // created with its pid in one step
        return true;
      } catch (e) {
        // EPERM/EACCES: Windows keeps a just-removed lock delete-pending while a waiter reads it
        const pending = process.platform === "win32" && (e.code === "EPERM" || e.code === "EACCES");
        if (e.code !== "EEXIST" && !pending) throw e;
      }
      if (present(ok)) return false;
      const pid = readPid(lock);
      if (pid && !alive(pid)) {
        let breaker = false;
        try {
          fs.mkdirSync(lock + ".break"); // one breaker at a time
          breaker = true;
        } catch (e) {
          if (e.code !== "EEXIST") throw e;
        }
        if (breaker) {
          // a dead holder's file cannot change until someone removes it
          if (readPid(lock) === pid) fs.rmSync(lock, { force: true });
          fs.rmdirSync(lock + ".break");
          continue;
        }
      }
      if (n >= WAIT_S) fail("could not take the install lock in 2 minutes (remove " + lock + " and " + lock + ".break if no install is running)");
      await sleep(1000);
    }
  } finally {
    drop();
    process.removeListener("exit", drop);
  }
}

/** First node >= MIN: other PATH entries, then nvm (newest first), Homebrew, /usr/local. The host's PATH can list an old node first. */
function findNode(env, home) {
  const exe = process.platform === "win32" ? "node.exe" : "node";
  const dirs = (env.PATH || env.Path || "").split(path.delimiter).filter(Boolean);
  const nvm = path.join(env.NVM_DIR || path.join(home || "", ".nvm"), "versions", "node");
  let versions = [];
  try {
    versions = fs.readdirSync(nvm).filter((v) => !tooOld(v)).sort((a, b) => {
      const [x, y] = [a, b].map((v) => v.replace(/^v/, "").split(".").map(Number));
      return y[0] - x[0] || y[1] - x[1] || y[2] - x[2];
    });
  } catch (e) {}
  const all = dirs.concat(versions.map((v) => path.join(nvm, v, "bin")), ["/opt/homebrew/bin", "/usr/local/bin"]);
  for (const dir of all) {
    const f = path.join(dir, exe);
    if (f === process.execPath) continue;
    const r = spawnSync(f, ["--version"], { encoding: "utf8", timeout: 5000, killSignal: "SIGKILL" });
    if (r.status === 0 && !tooOld(r.stdout.trim())) return f;
  }
  return null;
}

/** Runs this launcher again under `node`, same args and stdio; exits with its code. */
function reexec(node) {
  const child = spawn(node, [__filename].concat(process.argv.slice(2)), { env: Object.assign({}, process.env, { AGENT_KB_REEXEC: "1" }), stdio: "inherit" });
  for (const s of SIGNALS) process.on(s, () => child.kill(process.platform === "win32" ? undefined : s));
  child.on("error", (e) => fail("cannot start " + node + ": " + e.message));
  child.on("exit", (code, signal) => {
    if (code !== null || !signal) return process.exit(code === null ? 0 : code);
    for (const s of SIGNALS) process.removeAllListeners(s); // re-raise with the default action so the caller sees the signal
    process.kill(process.pid, signal);
  });
}

async function main() {
  if (tooOld(process.version)) {
    const node = process.env.AGENT_KB_REEXEC ? null : findNode(process.env, require("os").homedir());
    if (node) return reexec(node);
    fail("node " + process.version + " is too old. " + HINT);
  }
  const root = path.join(__dirname, "..");
  const ok = path.join(root, "node_modules", ".agent-kb-ok");
  const env = mapOptions(process.env);
  if (!present(ok)) {
    // until the server runs, a signal exits through the exit listeners, so no lock file is left behind
    let npm = null;
    const stop = () => {
      if (npm) npm.kill();
      process.exit(1);
    };
    for (const s of SIGNALS) process.on(s, stop);
    const cli = npmCli(env);
    if (!cli) fail("npm not found; cannot install agent-kb's dependencies. " + HINT);
    try {
      fs.accessSync(root, fs.constants.W_OK);
    } catch (e) {
      fail("cannot write to " + root + ", where agent-kb installs its dependencies");
    }
    const lock = path.join(root, ".install.lock");
    if (await takeLock(lock, ok)) {
      const release = () => {
        if (readPid(lock) === process.pid) fs.rmSync(lock, { force: true });
      };
      process.on("exit", release);
      if (!present(ok)) {
        const node = nodeBin(env);
        if (!node) fail("node not found on PATH; cannot install agent-kb's dependencies. " + HINT);
        npm = spawn(node, [cli, "ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: root, env, stdio: ["ignore", 2, 2] });
        const code = await new Promise((r) => npm.on("close", r));
        if (code !== 0) fail("npm ci failed");
        fs.writeFileSync(ok, "");
      }
      release();
      process.removeListener("exit", release);
    }
    for (const s of SIGNALS) process.removeListener(s, stop);
  }
  if (electron) {
    // no second process: spawning the app binary would start the app, not node
    process.emitWarning = () => {};
    Object.assign(process.env, env);
    await import(require("url").pathToFileURL(path.join(root, "src", "server.js")).href);
    return;
  }
  const server = spawn(process.execPath, [QUIET, path.join(root, "src", "server.js")].concat(process.argv.slice(2)), { env, stdio: "inherit" });
  // Windows children take no named signal but a kill (libuv: ENOSYS for SIGHUP)
  for (const s of SIGNALS) process.on(s, () => server.kill(process.platform === "win32" ? undefined : s));
  server.on("exit", (code, signal) => process.exit(code === null ? (signal ? 1 : 0) : code));
}

module.exports = { tooOld, mapOptions, findNode };
if (require.main === module) main().catch((e) => fail(e.message));
