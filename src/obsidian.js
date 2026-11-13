import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { acquireLock, releaseLock, renewLock, upsertDoc } from "./store.js";
import { redact } from "./redact.js";
import { cwdOfResume } from "./adapters/claude-code.js";
import { clip } from "./text.js";
import { MAX_CHARS } from "./backfill.js";

export const OBSIDIAN = "obsidian";
const GENERATOR = "agent-kb";
const LOCK = "obsidian";
const LOCK_TTL_MS = 10 * 60_000;
const BEAT_EVERY = 100;
const MAX_NOTE_BYTES = 1 << 20;
// no symlink follow; no blocking open on a FIFO named *.md (both flags absent on Windows)
const OPEN_FLAGS = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0);

/** The whole open file as UTF-8, read to EOF; null past `max` bytes (it may have grown since fstat). */
function readCapped(fd, size, max) {
  let buf = Buffer.alloc(Math.min(size, max) + 1);
  let n = 0;
  for (;;) {
    if (n === buf.length) {
      if (n > max) return null;
      const bigger = Buffer.alloc(Math.min(buf.length * 2, max + 1));
      buf.copy(bigger, 0, 0, n);
      buf = bigger;
    }
    const r = fs.readSync(fd, buf, n, buf.length - n, null);
    if (!r) return buf.toString("utf8", 0, n);
    n += r;
  }
}
const DEFAULT_FOLDER = "agent-kb";

/**
 * Vault config from the environment: AGENT_KB_VAULT (unset = Obsidian off) and AGENT_KB_VAULT_FOLDER
 * (output folder inside the vault, default `agent-kb`). Throws on a missing vault dir or a folder
 * that leaves the vault; the vault is never created.
 */
export function obsidianConfig(env = process.env) {
  if (!env.AGENT_KB_VAULT) return null;
  const vault = path.resolve(env.AGENT_KB_VAULT);
  if (!fs.statSync(vault, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`AGENT_KB_VAULT is not a directory: ${vault}`);
  const out = path.resolve(vault, env.AGENT_KB_VAULT_FOLDER || DEFAULT_FOLDER);
  const rel = path.relative(vault, out);
  if (!rel || rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    throw new Error(`AGENT_KB_VAULT_FOLDER must be a folder inside the vault: ${env.AGENT_KB_VAULT_FOLDER}`);
  }
  return { vault, out, folder: rel.split(path.sep).join("/") };
}

/** Out then in, under one lock; `locked` when another process is syncing. */
export function syncObsidian(db, cfg) {
  const owner = crypto.randomUUID();
  if (!acquireLock(db, LOCK, owner, LOCK_TTL_MS)) return { locked: true };
  try {
    // a sync is synchronous but can outlast the TTL on a huge vault: renew every BEAT_EVERY items, and stop if the lock was lost
    let n = 0;
    const beat = () => {
      if (++n % BEAT_EVERY === 0 && !renewLock(db, LOCK, owner, LOCK_TTL_MS)) throw new Error("lost the obsidian lock; run the sync again");
    };
    return { locked: false, out: syncOut(db, cfg, beat), in: syncIn(db, cfg, beat) };
  } finally {
    releaseLock(db, LOCK, owner);
  }
}

// ── out ────────────────────────────────────────────────────────────────────

const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);
const yamlStr = (s) => JSON.stringify(s);
const sha = (v) => crypto.createHash("sha256").update(JSON.stringify(v)).digest("hex");
// the redaction and rendering code is part of every note's fingerprint: a changed rule or format re-renders all notes once
const CODE_FP = sha(["./redact.js", "./obsidian.js"].map((f) => fs.readFileSync(new URL(f, import.meta.url), "utf8")));
const hasHits = (s) => Object.keys(redact(s).hits).length > 0;
const baseOf = (p) => p.replace(/#w\d+$/, "");

/** A file name Obsidian and every OS accept: no path or link characters, one line, at most 80 chars. */
function safeName(s, fallback) {
  const n = String(s ?? "")
    .replace(/[\\/:*?"<>|#^[\]\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80)
    .replace(/^\.+|[. ]+$/g, "")
    .trim();
  return n || fallback;
}

/** Episodic docs grouped per session: the tier-0 doc and its `#wN` summaries. Metadata only. */
function loadSessions(db) {
  const rows = db
    .prepare("SELECT source_path, source_type, title, coalesce(event_ts, indexed_ts) AS ts, indexed_ts, resume_cmd FROM documents WHERE tier = 'episodic' ORDER BY source_path")
    .all();
  const groups = new Map();
  for (const r of rows) {
    const base = baseOf(r.source_path);
    const g = groups.get(base) ?? { base, type: r.source_type, title: null, ts: 0, resume: null, docs: [] };
    groups.set(base, g);
    const n = r.source_path === base ? 0 : Number(/#w(\d+)$/.exec(r.source_path)?.[1] ?? 0);
    g.docs.push({ path: r.source_path, n, at: r.indexed_ts });
    g.ts = Math.max(g.ts, r.ts);
    g.resume ??= r.resume_cmd;
    if (r.source_path === base) g.title = r.title;
    else g.title ??= r.title?.replace(/ \(#w\d+\)$/, "") ?? null;
  }
  for (const g of groups.values()) {
    g.docs.sort((a, b) => a.n - b.n);
    // rows stored under older redaction rules are redacted again; a resume command holding a secret is dropped, like upsertDoc does
    if (g.resume && Object.keys(redact(g.resume).hits).length) g.resume = null;
    g.title = g.title == null ? null : redact(g.title).text;
    g.cwd = cwdOfResume(g.resume);
    const project = g.cwd ? safeName(redact(safeName(path.basename(g.cwd), "")).text, "") : "";
    // the name as written (`projects/<name>.md`) must be clean too: the bearer rule reads `Authorization.md` as a value
    g.project = project && !hasHits(`projects/${project}.md`) ? project : null;
    g.day = isoDay(g.ts);
    g.label = safeName(redact(safeName(g.title, "")).text, "Untitled");
    if (hasHits(`sessions/${g.day} ${g.label}.md`)) g.label = "Untitled";
    g.fp = sha([CODE_FP, g.type, g.title, g.resume, g.cwd, g.docs.map((d) => [d.path, d.at])]);
  }
  return [...groups.values()];
}

const FM = /^---\n([\s\S]*?)\n---\n/;
const HASH_LINE = /^agent_kb_hash: [0-9a-f]{64}\n/m;

/** A note: frontmatter with `generator: agent-kb` and a hash of everything else, then the body. */
function renderNote(fields, body) {
  const fm = Object.entries(fields)
    .filter(([, v]) => v != null)
    .map(([k, v]) => `${k}: ${v}`);
  const plain = `---\ngenerator: ${GENERATOR}\n${fm.join("\n")}\n---\n${body}`;
  const hash = crypto.createHash("sha256").update(plain).digest("hex");
  return plain.replace(`generator: ${GENERATOR}\n`, `$&agent_kb_hash: ${hash}\n`);
}

/** True while the file is exactly what agent-kb wrote: its hash line matches the rest of the text. */
function untouched(text) {
  const m = FM.exec(text);
  if (!m || !/^generator: agent-kb$/m.test(m[1])) return false;
  const claimed = /^agent_kb_hash: ([0-9a-f]{64})$/m.exec(m[1])?.[1];
  return !!claimed && crypto.createHash("sha256").update(text.replace(HASH_LINE, "")).digest("hex") === claimed;
}

function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = path.join(path.dirname(file), `.agent-kb-${crypto.randomBytes(6).toString("hex")}.tmp`);
  try {
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, file);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
}

/**
 * Writes session notes `sessions/<date> <title>.md`, a daily note per day and a project note per
 * working dir, into the output folder. A note is rewritten only when its text changed and the file is
 * still as agent-kb wrote it; one the user edited (hash mismatch, or a file that was never ours) is
 * skipped and counted. A note the user deleted or moved is not recreated.
 */
export function syncOut(db, cfg, beat = () => {}) {
  const counts = { written: 0, unchanged: 0, edited: 0, missing: 0, failed: 0 };
  const scope = cfg.out;
  const sessions = loadSessions(db);
  const stored = new Map(db.prepare("SELECT key, rel_path, written, fp FROM obsidian_notes WHERE scope = ?").all(scope).map((r) => [r.key, { ...r }]));
  const taken = new Set([...stored.values()].map((r) => r.rel_path.toLowerCase()));
  const insert = db.prepare("INSERT INTO obsidian_notes (scope, key, rel_path, written, fp) VALUES (?, ?, ?, 0, '')");
  const rename = db.prepare("UPDATE obsidian_notes SET rel_path = ?, fp = '', written = 0 WHERE scope = ? AND key = ?");
  const markWritten = db.prepare("UPDATE obsidian_notes SET written = 1, fp = ? WHERE scope = ? AND key = ?");

  const pick = (want) => {
    let rel = want;
    for (let n = 2; taken.has(rel.toLowerCase()) || fs.existsSync(path.join(cfg.out, rel)); n++) rel = want.replace(/\.md$/, ` (${n}).md`);
    return rel;
  };
  // Every stored name is clean as written, collision suffix included (`password= (2).md` reads as an assignment).
  const free = (want, fallback) => {
    let rel = pick(want);
    if (hasHits(rel)) rel = pick(fallback);
    taken.add(rel.toLowerCase());
    return rel;
  };
  // A name is fixed on first sight; a user's file at the wanted name is never taken. A frozen name that
  // today's rules read as a secret (the title was stored under older rules) is replaced, its untouched file removed.
  const nameFor = (key, want, fallback) => {
    beat();
    const have = stored.get(key);
    if (have && !hasHits(have.rel_path)) return have;
    if (have) {
      const old = path.join(cfg.out, have.rel_path);
      taken.delete(have.rel_path.toLowerCase());
      try {
        if (untouched(fs.readFileSync(old, "utf8"))) fs.rmSync(old);
      } catch {}
      have.rel_path = free(want, fallback);
      (have.fp = ""), (have.written = 0);
      rename.run(have.rel_path, scope, key);
      return have;
    }
    const row = { key, rel_path: free(want, fallback), written: 0, fp: "" };
    insert.run(scope, key, row.rel_path);
    stored.set(key, row);
    return row;
  };
  const link = (rel, label) => `[[${cfg.folder}/${rel.replace(/\.md$/, "")}|${label}]]`;

  // `render` runs only when the inputs changed (fp) or the note is missing; unchanged notes cost one stat
  const put = (row, fp, render) => {
    beat();
    const file = path.join(cfg.out, row.rel_path);
    try {
      const present = fs.existsSync(file);
      if (!present && row.written) return void counts.missing++;
      if (present && row.written && row.fp === fp) return void counts.unchanged++;
      const text = render();
      let existing = null;
      try {
        existing = fs.readFileSync(file, "utf8");
      } catch (e) {
        if (e.code !== "ENOENT") throw e;
      }
      if (existing === text) {
        markWritten.run(fp, scope, row.key);
        (row.written = 1), (row.fp = fp);
        return void counts.unchanged++;
      }
      if (existing !== null && !untouched(existing)) return void counts.edited++;
      writeAtomic(file, text);
      markWritten.run(fp, scope, row.key);
      (row.written = 1), (row.fp = fp);
      counts.written++;
    } catch {
      counts.failed++;
    }
  };

  for (const g of sessions) g.row = nameFor(`s:${g.base}`, `sessions/${g.day} ${g.label}.md`, `sessions/${g.day} Untitled.md`);
  const days = new Map();
  const projects = new Map();
  for (const g of sessions) {
    (days.get(g.day) ?? days.set(g.day, []).get(g.day)).push(g);
    if (g.project) {
      const k = g.project.toLowerCase();
      (projects.get(k) ?? projects.set(k, { name: g.project, sessions: [] }).get(k)).sessions.push(g);
    }
  }
  const dayRow = new Map([...days.keys()].map((d) => [d, nameFor(`d:${d}`, `daily/${d}.md`)]));
  const projRow = new Map([...projects.keys()].map((k) => [k, nameFor(`p:${k}`, `projects/${safeName(projects.get(k).name, "project")}.md`, "projects/project.md")]));

  const getContent = db.prepare("SELECT title, content, coalesce(event_ts, indexed_ts) AS ts FROM documents WHERE source_path = ?");
  for (const g of sessions) {
    const fields = {
      date: g.day,
      harness: g.type,
      project: g.project ? yamlStr(g.project) : null,
      cwd: g.cwd ? yamlStr(g.cwd) : null,
      resume: g.resume ? yamlStr(g.resume) : null,
      source_path: yamlStr(redact(g.base).text),
      tags: `[agent-kb, ${g.type.replace(/[^\w-]/g, "-")}]`,
    };
    const nav = [g.project && link(projRow.get(g.project.toLowerCase()).rel_path, g.project), link(dayRow.get(g.day).rel_path, g.day)].filter(Boolean).join(" · ");
    put(g.row, sha([g.fp, nav]), () => {
      const parts = [`${nav}\n\n# ${g.label}\n`];
      for (const d of g.docs) {
        const doc = getContent.get(d.path);
        if (!doc) continue;
        parts.push(d.n === 0 ? `\n## Prompts\n\n${redact(doc.content).text}\n` : `\n## Summary #w${d.n} (${isoDay(doc.ts)})\n\n${redact(doc.content).text}\n`);
      }
      return renderNote(fields, parts.join(""));
    });
  }
  const list = (items) => items.sort((a, b) => a.ts - b.ts || a.row.rel_path.localeCompare(b.row.rel_path)).map((g) => `- ${link(g.row.rel_path, g.label)} — ${g.type}`).join("\n");
  const listFp = (items) => sha(items.map((g) => [g.row.rel_path, g.label, g.type, g.ts]));
  for (const [d, items] of days) {
    put(dayRow.get(d), listFp(items), () => renderNote({ date: d, tags: "[agent-kb, daily]" }, `# ${d}\n\n${list(items)}\n`));
  }
  for (const [k, p] of projects) {
    put(projRow.get(k), listFp(p.sessions), () => renderNote({ project: yamlStr(p.name), tags: "[agent-kb, project]" }, `# ${p.name}\n\n${list(p.sessions)}\n`));
  }
  // an index note whose sessions all moved on (a later day, a renamed dir) is rewritten without them
  const del = db.prepare("DELETE FROM obsidian_notes WHERE scope = ? AND key = ?");
  for (const row of stored.values()) {
    // current rows were renamed clean by nameFor; a hit left here is a stale one stored before the check
    if (hasHits(row.rel_path)) {
      try {
        const file = path.join(cfg.out, row.rel_path);
        if (untouched(fs.readFileSync(file, "utf8"))) fs.rmSync(file);
      } catch {}
      del.run(scope, row.key);
      continue;
    }
    const [kind, name] = [row.key[0], row.key.slice(2)];
    if (kind === "d" && !days.has(name)) put(row, listFp([]), () => renderNote({ date: name, tags: "[agent-kb, daily]" }, `# ${name}\n\n`));
    if (kind === "p" && !projects.has(name)) put(row, listFp([]), () => renderNote({ tags: "[agent-kb, project]" }, `# ${path.basename(row.rel_path, ".md")}\n\n`));
  }
  return counts;
}

// ── in ─────────────────────────────────────────────────────────────────────

const FRONTMATTER = /^﻿?---\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/;
const IS_OURS = /^generator:[ \t]*["']?agent-kb["']?[ \t]*(?:#.*)?\r?$/im;

/** True when the note's frontmatter says agent-kb wrote it: that holds wherever the user moved it. */
export const isGenerated = (text) => IS_OURS.test(FRONTMATTER.exec(text)?.[1] ?? "");

/**
 * Indexes the vault's Markdown as `semantic` docs, source_type `obsidian`. A note is read again only
 * when its size or mtime changed (`scans`). Left out: the output folder, any note whose frontmatter has
 * `generator: agent-kb` (Principle 9), dot-folders (`.obsidian`, `.trash`, `.git`), symlinks, files over
 * 1 MB. A note that vanished, grew past 1 MB or turned into agent-kb output loses its doc: the vault is
 * the source of truth, so unlike a deleted transcript nothing is left to keep. A vault that cannot be
 * listed completely removes nothing.
 */
export function syncIn(db, cfg, beat = () => {}) {
  const counts = { indexed: 0, unchanged: 0, excluded: 0, skipped: 0, removed: 0, failed: 0 };
  const getScan = db.prepare("SELECT size, mtime_ms FROM scans WHERE source_path = ?");
  const setScan = db.prepare(
    `INSERT INTO scans (source_path, size, mtime_ms) VALUES (?, ?, ?)
     ON CONFLICT(source_path) DO UPDATE SET size = excluded.size, mtime_ms = excluded.mtime_ms`,
  );
  const delDoc = db.prepare("DELETE FROM documents WHERE source_path = ? AND source_type = ?");
  const keepDocs = new Set();
  const keepScans = new Set();
  let complete = true;
  const outStat = fs.statSync(cfg.out, { throwIfNoEntry: false });

  const stack = [cfg.vault];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      complete = false;
      counts.failed++;
      continue;
    }
    for (const e of entries) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        // same inode, not same spelling: `Agent-KB` is the output folder on a case-insensitive disk only
        const st = outStat && abs !== cfg.out ? fs.statSync(abs, { throwIfNoEntry: false }) : null;
        const isOut = abs === cfg.out || (st && st.ino === outStat.ino && st.dev === outStat.dev);
        if (!e.name.startsWith(".") && !isOut) stack.push(abs);
        continue;
      }
      if (!e.isFile() || !/\.md$/i.test(e.name)) continue;
      beat();
      let fd;
      try {
        // one open file for the checks and the read: a path swapped after readdir (a symlink, a bigger file) is not followed
        fd = fs.openSync(abs, OPEN_FLAGS);
        const st = fs.fstatSync(fd);
        if (!st.isFile()) throw new Error("not a regular file");
        if (st.size > MAX_NOTE_BYTES) {
          counts.skipped++;
          continue;
        }
        keepScans.add(abs);
        const mtime = Math.trunc(st.mtimeMs);
        const cur = getScan.get(abs);
        if (cur && cur.size === st.size && cur.mtime_ms === mtime) {
          keepDocs.add(abs);
          counts.unchanged++;
          continue;
        }
        const text = readCapped(fd, st.size, MAX_NOTE_BYTES);
        if (text === null) {
          keepScans.delete(abs);
          counts.skipped++;
          continue;
        }
        if (isGenerated(text)) {
          delDoc.run(abs, OBSIDIAN);
          setScan.run(abs, st.size, mtime);
          counts.excluded++;
          continue;
        }
        const body = text.replace(FRONTMATTER, "").trim();
        if (!body) {
          delDoc.run(abs, OBSIDIAN);
        } else {
          upsertDoc(db, {
            source_path: abs,
            source_type: OBSIDIAN,
            tier: "semantic",
            title: /^#[ \t]+(.+?)[ \t]*#*[ \t]*$/m.exec(body)?.[1] ?? path.basename(e.name, path.extname(e.name)),
            // redact before clipping: a cut inside a secret would leave a fragment no rule recognises
            content: clip(redact(body).text, MAX_CHARS),
            event_ts: mtime,
          });
          keepDocs.add(abs);
          counts.indexed++;
        }
        setScan.run(abs, st.size, mtime);
      } catch {
        // vanished or unreadable mid-scan: keep what is stored, the next sync retries
        keepDocs.add(abs);
        keepScans.add(abs);
        counts.failed++;
      } finally {
        if (fd !== undefined) fs.closeSync(fd);
      }
    }
  }

  if (complete) {
    const prefix = cfg.vault.endsWith(path.sep) ? cfg.vault : cfg.vault + path.sep;
    const under = (p) => p.startsWith(prefix);
    for (const { source_path: p } of db.prepare("SELECT source_path FROM documents WHERE source_type = ?").all(OBSIDIAN)) {
      if (under(p) && !keepDocs.has(p)) (delDoc.run(p, OBSIDIAN), counts.removed++);
    }
    const delScan = db.prepare("DELETE FROM scans WHERE source_path = ?");
    for (const { source_path: p } of db.prepare("SELECT source_path FROM scans").all()) {
      if (under(p) && /\.md$/i.test(p) && !keepScans.has(p)) delScan.run(p);
    }
  }
  return counts;
}

export function formatSync(r) {
  if (r.locked) return "another agent-kb process is syncing the vault; try again later";
  const o = r.out;
  const i = r.in;
  return (
    `out: ${o.written} written, ${o.unchanged} unchanged, ${o.edited} edited by you (skipped), ${o.missing} deleted or moved by you (skipped), ${o.failed} failed\n` +
    `in:  ${i.indexed} indexed, ${i.unchanged} unchanged, ${i.excluded} agent-kb notes left out, ${i.skipped} over 1 MB, ${i.removed} removed, ${i.failed} failed`
  );
}
