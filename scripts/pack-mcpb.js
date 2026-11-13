#!/usr/bin/env node
import { cpSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const MCPB = "@anthropic-ai/mcpb@2.1.2";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, "dist", "agent-kb.mcpb");
const stage = mkdtempSync(path.join(tmpdir(), "agent-kb-mcpb-"));
const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, stdio: "inherit", shell: process.platform === "win32" });
try {
  for (const f of ["manifest.json", "package.json", "package-lock.json", "LICENSE", "bin", "src"]) cpSync(path.join(root, f), path.join(stage, f), { recursive: true });
  run("npm", ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], stage);
  run("npx", ["-y", MCPB, "validate", path.join(stage, "manifest.json")], stage);
  mkdirSync(path.dirname(out), { recursive: true });
  run("npx", ["-y", MCPB, "pack", stage, out], stage);
  console.log(`${out} ${(statSync(out).size / 1048576).toFixed(1)} MB`);
} finally {
  rmSync(stage, { recursive: true, force: true });
}
