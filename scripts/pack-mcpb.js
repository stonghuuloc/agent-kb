#!/usr/bin/env node
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const MCPB = "@anthropic-ai/mcpb@2.1.2";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, "dist", "agent-kb.mcpb");
const stage = mkdtempSync(path.join(tmpdir(), "agent-kb-mcpb-"));
const tools = mkdtempSync(path.join(tmpdir(), "agent-kb-mcpb-cli-"));
// npm and mcpb run as JS entries under node, never through a shell (npm exec uses one on Windows):
// cmd.exe would split spaces and expand %VARS% in paths
const npmCli = [
  process.env.npm_execpath, // set by `npm run pack:mcpb`
  path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"), // Windows install
  path.join(path.dirname(process.execPath), "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"), // POSIX install
].find((f) => f && /npm-cli\.c?js$/.test(f) && existsSync(f));
if (!npmCli) throw new Error("cannot find npm's npm-cli.js; run this with `npm run pack:mcpb`");
const node = (args, cwd) => execFileSync(process.execPath, args, { cwd, stdio: "inherit" });
const npm = (args, cwd) => node([npmCli, ...args], cwd);
try {
  for (const f of ["manifest.json", "package.json", "package-lock.json", "LICENSE", "bin", "src"]) cpSync(path.join(root, f), path.join(stage, f), { recursive: true });
  npm(["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], stage);
  npm(["install", "--prefix", tools, "--no-save", "--ignore-scripts", "--no-audit", "--no-fund", MCPB], tools);
  const pkg = path.join(tools, "node_modules", "@anthropic-ai", "mcpb");
  const { bin } = JSON.parse(readFileSync(path.join(pkg, "package.json"), "utf8"));
  const mcpb = path.join(pkg, typeof bin === "string" ? bin : bin.mcpb);
  node([mcpb, "validate", path.join(stage, "manifest.json")], stage);
  mkdirSync(path.dirname(out), { recursive: true });
  node([mcpb, "pack", stage, out], stage);
  console.log(`${out} ${(statSync(out).size / 1048576).toFixed(1)} MB`);
} finally {
  rmSync(stage, { recursive: true, force: true });
  rmSync(tools, { recursive: true, force: true });
}
