#!/usr/bin/env node
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const MCPB = "@anthropic-ai/mcpb@2.1.2";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, "dist", "agent-kb.mcpb");
const stage = mkdtempSync(path.join(tmpdir(), "agent-kb-mcpb-"));
// npm's JS entry run by node, never through a shell: cmd.exe would split spaces and expand %VARS% in paths
const npmCli = [
  process.env.npm_execpath, // set by `npm run pack:mcpb`
  path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"), // Windows install
  path.join(path.dirname(process.execPath), "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"), // POSIX install
].find((f) => f && /npm-cli\.c?js$/.test(f) && existsSync(f));
if (!npmCli) throw new Error("cannot find npm's npm-cli.js; run this with `npm run pack:mcpb`");
const npm = (args, cwd) => execFileSync(process.execPath, [npmCli, ...args], { cwd, stdio: "inherit" });
try {
  for (const f of ["manifest.json", "package.json", "package-lock.json", "LICENSE", "bin", "src"]) cpSync(path.join(root, f), path.join(stage, f), { recursive: true });
  npm(["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], stage);
  npm(["exec", "--yes", `--package=${MCPB}`, "--", "mcpb", "validate", path.join(stage, "manifest.json")], stage);
  mkdirSync(path.dirname(out), { recursive: true });
  npm(["exec", "--yes", `--package=${MCPB}`, "--", "mcpb", "pack", stage, out], stage);
  console.log(`${out} ${(statSync(out).size / 1048576).toFixed(1)} MB`);
} finally {
  rmSync(stage, { recursive: true, force: true });
}
