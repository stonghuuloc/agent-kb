import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { upsertDoc } from "./store.js";
import { redact } from "./redact.js";
import { clip } from "./text.js";
import { MAX_CHARS } from "./backfill.js";

/**
 * Static sources: the files a person writes once and wants their agent to find again — a repo's
 * `CLAUDE.md` and docs, skills, commands, agents, hooks, plans, memory notes and curated kb notes.
 * The current kb indexes these with `kb-index.py`; this is the same job without Python.
 *
 * A root is scanned by name and shape, not by layout: `CLAUDE.md` / `AGENTS.md` / `README.md` /
 * `CONTRIBUTING.md` at any depth near the top, `docs/**.md`, and `.claude|skills/{commands,agents}`
 * Markdown. Nothing else in a repo is read, so a monorepo costs stats, not reads.
 */

export const MAX_FILE_BYTES = 512 * 1024;
const MAX_DEPTH = 7;
// Only these folders under a repo are walked past its top: a repo's own src tree holds no knowledge docs,
// and walking 12 of them costs stats and finds nothing.
const DESCEND = new Set(["docs", "skills", "commands", "agents", "references", "plans", "kb", "hooks", "scheduled-tasks", ".claude"]);
// Source trees and their kin hold no knowledge docs; a README under src/ is a build artefact's note, not yours.
const SKIP_DESCEND = new Set(["src", "lib", "libs", "test", "tests", "__tests__", "app", "apps", "packages", "public", "assets", "static", "migrations", "scripts", "out", "tmp", "temp", "vendor", "third_party", "samples", "examples", "tools", "plugins"]);
const MAX_FILES = 4000;
const EXCLUDE = new Set(["node_modules", ".git", "dist", "build", ".next", ".turbo", "coverage", ".cache", "bin", "obj", ".venv", "target", ".svelte-kit"]);
const NAMED = new Map([
  ["claude.md", "claude_md"],
  ["agents.md", "agents_md"],
  ["readme.md", "readme"],
  ["contributing.md", "readme"],
]);
const HOOK_EXTS = new Set([".sh", ".mjs", ".js", ".py", ".cjs"]);

/** Tier per type, as the current kb assigns it (kb-migrate-tier.py). */
export const TIERS = {
  claude_md: "semantic", agents_md: "semantic", readme: "semantic", arch_doc: "semantic", reference: "semantic", curated: "semantic",
  memory: "procedural", custom_skill: "procedural", custom_command: "procedural", custom_agent: "procedural",
  hook: "procedural", plan: "procedural", scheduled_task: "procedural", template: "procedural",
};
export const TYPES = Object.keys(TIERS);

/**
 * Roots to index, from the environment: `AGENT_KB_CLAUDE_DIR` (default `~/.claude`),
 * `AGENT_KB_WORKSPACE` (optional: the folder holding your repos) and `AGENT_KB_DAILY_DIR`-style vault
 * categories are left to the Obsidian-in pass, which already reads every vault note.
 */
export function indexRoots(env = process.env, home = os.homedir()) {
  const roots = [];
  const claude = path.resolve(env.AGENT_KB_CLAUDE_DIR || path.join(home, ".claude"));
  roots.push({ dir: claude, kind: "global", rule: "claude" });
  roots.push({ dir: path.join(claude, "projects"), kind: "memory", rule: "memory" });
  if (env.AGENT_KB_WORKSPACE) roots.push({ dir: path.resolve(env.AGENT_KB_WORKSPACE), kind: "workspace", rule: "workspace" });
  return roots.filter((r) => fs.statSync(r.dir, { throwIfNoEntry: false })?.isDirectory());
}

/** A frontmatter `name:`, else the first `# heading`, else the folder (a skill is named by its folder), else the file. */
function titleOf(text, file) {
  const name = /^---\n(?:[\s\S]*?\n)?name:\s*["']?(.+?)["']?\s*$/m.exec(text.slice(0, 2000));
  const h = /^#\s+(.+)$/m.exec(text);
  const base = path.basename(file).replace(/\.[^.]+$/, "");
  const fallback = base.toLowerCase() === "skill" || base.toLowerCase() === "readme" ? path.basename(path.dirname(file)) : base;
  const raw = (name ? name[1] : h ? h[1] : fallback).replace(/^["']|["']$/g, "").trim();
  return String(raw || fallback).slice(0, 120);
}

/** The type this file is indexed as under `rule`, or null when the rule does not want it. `rel` starts at the root. */
function typeOf(rel, rule) {
  const base = rel[rel.length - 1].toLowerCase();
  const dirs = rel.slice(0, -1).map((d) => d.toLowerCase());
  const inDir = (name) => dirs.includes(name);
  if (rule === "memory") return dirs[dirs.length - 1] === "memory" && base.endsWith(".md") ? "memory" : null;
  if (rule === "claude") {
    // a named doc only at the top of ~/.claude; projects/ belongs to the memory root
    if (rel.length === 1 && NAMED.has(base)) return NAMED.get(base);
    if (inDir("scheduled-tasks") && base === "skill.md") return "scheduled_task";
    if (inDir("skills") && base === "skill.md") return "custom_skill";
    if (inDir("commands") && base.endsWith(".md")) return "custom_command";
    if (inDir("agents") && base.endsWith(".md")) return "custom_agent";
    if (inDir("plans") && base.endsWith(".md")) return "plan";
    if (inDir("references") && base.endsWith(".md")) return "reference";
    if (inDir("kb") && base.endsWith(".md")) return "curated";
    if (dirs[dirs.length - 1] === "hooks" && HOOK_EXTS.has(path.extname(base))) return "hook";
    return null;
  }
  // workspace: a named doc down to a repo root (Backend/Services/<repo>/CLAUDE.md is depth 4), a docs/ page,
  // or a repo's .claude / skills tree
  if (rel.length <= 5 && NAMED.has(base)) return NAMED.get(base);
  if (inDir("docs") && base.endsWith(".md")) return "arch_doc";
  if (inDir("skills") && base === "skill.md") return "custom_skill";
  if (inDir("commands") && base.endsWith(".md")) return "custom_command";
  if (inDir("agents") && base.endsWith(".md")) return "custom_agent";
  return null;
}

/**
 * Depth-bounded walk; `visit` gets every file the rule wants, with its path relative to the root.
 * Returns false when any directory could not be read, so a caller does not read the gap as a deletion.
 */
function walk(dir, rule, visit, rel = [], inside = false) {
  if (rel.length > MAX_DEPTH) return true;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  let whole = true;
  for (const e of entries) {
    if (e.name.startsWith(".") && e.name !== ".claude") continue;
    const here = [...rel, e.name];
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (EXCLUDE.has(e.name)) continue;
      if (rule === "claude" && rel.length === 0 && e.name === "projects") continue; // the memory root walks those
      if (rel.length >= 1 && SKIP_DESCEND.has(e.name.toLowerCase())) continue;
      // top of the root and of each repo, then only inside a knowledge tree (docs/, skills/, .claude/ …)
      const tree = inside || DESCEND.has(e.name);
      if (rel.length < 3 || tree) whole = walk(full, rule, visit, here, tree) && whole;
      continue;
    }
    if (!e.isFile()) continue;
    const type = typeOf(here, rule);
    if (type) visit(full, type);
  }
  return whole;
}

/**
 * Indexes every configured root. A file is read again only when its size or mtime changed (`scans`),
 * and a doc whose file is gone is dropped, so a deleted note stops answering. Content goes through
 * `upsertDoc`, i.e. redaction, like every other write.
 */
export function indexSources(db, { roots = indexRoots(), now = Date.now(), maxFiles = MAX_FILES } = {}) {
  const counts = { indexed: 0, unchanged: 0, removed: 0, skipped: 0, failed: 0 };
  const getScan = db.prepare("SELECT size, mtime_ms FROM scans WHERE source_path = ?");
  const setScan = db.prepare(
    `INSERT INTO scans (source_path, size, mtime_ms) VALUES (?, ?, ?)
     ON CONFLICT(source_path) DO UPDATE SET size = excluded.size, mtime_ms = excluded.mtime_ms`,
  );
  const dropScan = db.prepare("DELETE FROM scans WHERE source_path = ?");
  const dropDoc = db.prepare("DELETE FROM documents WHERE source_path = ? AND source_type IN (SELECT value FROM json_each(?))");
  const types = JSON.stringify(TYPES);
  const seen = new Set();
  const whole = new Map();
  for (const root of roots) {
    whole.set(root.dir, walk(root.dir, root.rule, (file, type) => {
      if (seen.size >= maxFiles) return;
      seen.add(file);
      // one handle for the size, the mtime and the text: a stat-then-read by path is a race
      let fd = null;
      try {
        fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
        const st = fs.fstatSync(fd);
        if (st.size === 0 || st.size > MAX_FILE_BYTES) {
          counts.skipped++;
          return;
        }
        const mtime = Math.trunc(st.mtimeMs);
        const cur = getScan.get(file);
        if (cur && cur.size === st.size && cur.mtime_ms === mtime) {
          counts.unchanged++;
          return;
        }
        const raw = fs.readFileSync(fd, "utf8");
        upsertDoc(
          db,
          {
            source_path: file,
            source_type: type,
            tier: TIERS[type],
            title: redact(titleOf(raw, file)).text,
            content: clip(redact(raw).text, MAX_CHARS),
            event_ts: mtime,
            resume_cmd: null,
          },
          now,
        );
        setScan.run(file, st.size, mtime);
        counts.indexed++;
      } catch {
        counts.failed++; // vanished or unreadable mid-scan; the next run retries it
      } finally {
        if (fd !== null) fs.closeSync(fd);
      }
    }));
  }
  // rows a pass owns under a root but did not see: the file is gone, or the rules no longer want it. Only
  // after every root was walked (a nested root's rows are not a gap for its parent), and only after a walk
  // that read every directory (an unreadable folder is a gap, not a deletion).
  const stale = db.prepare(`SELECT source_path FROM documents WHERE source_path LIKE ? AND source_type IN (SELECT value FROM json_each(?))`);
  for (const root of roots) {
    if (!whole.get(root.dir)) continue;
    for (const row of stale.all(root.dir + path.sep + "%", types)) {
      if (seen.has(row.source_path)) continue;
      dropDoc.run(row.source_path, types);
      dropScan.run(row.source_path);
      counts.removed++;
    }
  }
  return counts;
}
