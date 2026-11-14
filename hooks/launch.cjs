#!/usr/bin/env node
"use strict";
// MCP server launcher, run as `node launch.cjs` on every OS (Windows has no `sh` on PATH).
// Plain CommonJS with no newer syntax, so an old node still parses it and prints the hint.
// Node guard, CLAUDE_PLUGIN_OPTION_* → AGENT_KB_*, first-start `npm ci` under a lock, then the server.
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

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
        if (e.code !== "EEXIST" && e.code !== "EPERM" && e.code !== "EACCES") throw e;
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

async function main() {
  if (tooOld(process.version)) fail("node " + process.version + " is too old. " + HINT);
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
        npm = spawn(process.execPath, [cli, "ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: root, env, stdio: ["ignore", 2, 2] });
        const code = await new Promise((r) => npm.on("close", r));
        if (code !== 0) fail("npm ci failed");
        fs.writeFileSync(ok, "");
      }
      release();
      process.removeListener("exit", release);
    }
    for (const s of SIGNALS) process.removeListener(s, stop);
  }
  const server = spawn(process.execPath, [QUIET, path.join(root, "src", "server.js")].concat(process.argv.slice(2)), { env, stdio: "inherit" });
  // Windows children take no named signal but a kill (libuv: ENOSYS for SIGHUP)
  for (const s of SIGNALS) process.on(s, () => server.kill(process.platform === "win32" ? undefined : s));
  server.on("exit", (code, signal) => process.exit(code === null ? (signal ? 1 : 0) : code));
}

module.exports = { tooOld, mapOptions };
if (require.main === module) main().catch((e) => fail(e.message));
