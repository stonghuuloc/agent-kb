import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { redact } from "./redact.js";

export const TIERS = ["episodic", "semantic", "procedural"];

// Each entry runs once, in order; PRAGMA user_version records how many ran.
const MIGRATIONS = [
  `CREATE TABLE documents (
     id          INTEGER PRIMARY KEY,
     source_path TEXT NOT NULL UNIQUE,
     source_type TEXT NOT NULL,
     tier        TEXT NOT NULL CHECK (tier IN ('episodic','semantic','procedural')),
     title       TEXT,
     content     TEXT NOT NULL,
     event_ts    INTEGER,
     indexed_ts  INTEGER NOT NULL,
     resume_cmd  TEXT
   );
   CREATE INDEX documents_type ON documents(source_type);
   CREATE VIRTUAL TABLE chunks_fts USING fts5(
     title, content, content='documents', content_rowid='id', tokenize='porter unicode61'
   );
   CREATE TRIGGER documents_ai AFTER INSERT ON documents BEGIN
     INSERT INTO chunks_fts(rowid, title, content) VALUES (new.id, new.title, new.content);
   END;
   CREATE TRIGGER documents_ad AFTER DELETE ON documents BEGIN
     INSERT INTO chunks_fts(chunks_fts, rowid, title, content) VALUES ('delete', old.id, old.title, old.content);
   END;
   CREATE TRIGGER documents_au AFTER UPDATE ON documents BEGIN
     INSERT INTO chunks_fts(chunks_fts, rowid, title, content) VALUES ('delete', old.id, old.title, old.content);
     INSERT INTO chunks_fts(rowid, title, content) VALUES (new.id, new.title, new.content);
   END;`,
  // Tier-0 scan per transcript: unchanged files (same size and mtime) are not re-indexed.
  // Not the summary offset; that is `cursors` (phase 3b).
  `CREATE TABLE scans (
     source_path TEXT PRIMARY KEY,
     size        INTEGER NOT NULL,
     mtime_ms    INTEGER NOT NULL
   );`,
  // Summaries: bytes of each transcript already summarized, how many chunk docs (#w1, #w2 …) exist,
  // failed calls since the last success (a file that keeps failing backs off), and the file's inode,
  // so a transcript replaced at the same path is read again from the start.
  // locks: one sweeper at a time across processes. meta: small settings (the sweep window).
  // transcript_gone: the host app deleted the file.
  `CREATE TABLE cursors (
     source_path TEXT PRIMARY KEY,
     offset      INTEGER NOT NULL,
     chunks      INTEGER NOT NULL,
     failures    INTEGER NOT NULL DEFAULT 0,
     failed_ts   INTEGER NOT NULL DEFAULT 0,
     ino         INTEGER NOT NULL DEFAULT 0
   );
   CREATE TABLE meta (
     key   TEXT PRIMARY KEY,
     value INTEGER NOT NULL
   );
   CREATE TABLE locks (
     name       TEXT PRIMARY KEY,
     owner      TEXT NOT NULL,
     expires_ms INTEGER NOT NULL
   );
   ALTER TABLE documents ADD COLUMN transcript_gone INTEGER NOT NULL DEFAULT 0;`,
];

/**
 * Case- and Latin-diacritic-insensitive form, like unicode61's folding. Other marks
 * (Indic vowel signs) are kept so verbatim checks can still tell words apart. NFD, not
 * NFKD: unicode61 does no compatibility decomposition, so ™ and Ⓐ must stay symbols.
 * COMPAT: letter variants unicode61 case-folds together (µ = μ, ſ = s).
 */
export const COMPAT = { ς: "σ", ſ: "s", µ: "μ", ϐ: "β", ϵ: "ε", ϑ: "θ", ϰ: "κ", ϖ: "π", ϱ: "ρ", ϕ: "φ" };

export const fold = (s) =>
  String(s)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[ςſµϐϵϑϰϖϱϕ]/gu, (c) => COMPAT[c]);

/** How many index tokens unicode61 makes of `s`; >1 means FTS would match its split form. */
export function tokenCount(db, s) {
  try {
    db.prepare("INSERT INTO temp.kb_tok(t) VALUES (?)").run(s);
    return db.prepare("SELECT count(*) AS n FROM temp.kb_tok_v").get().n;
  } finally {
    db.exec("DELETE FROM temp.kb_tok");
  }
}

export function openStore(file) {
  if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec("PRAGMA busy_timeout = 5000"); // before WAL: switching journal mode needs the lock too
  db.exec("PRAGMA journal_mode = WAL");
  db.function("kb_fold", { deterministic: true }, (s) => (s == null ? null : fold(s)));
  db.exec(`CREATE VIRTUAL TABLE temp.kb_tok USING fts5(t, tokenize='porter unicode61');
           CREATE VIRTUAL TABLE temp.kb_tok_v USING fts5vocab(temp, kb_tok, 'instance');`);
  migrate(db);
  return db;
}

export class SchemaTooNewError extends Error {}

function migrate(db) {
  const version = () => db.prepare("PRAGMA user_version").get().user_version;
  const check = (v) => {
    if (v > MIGRATIONS.length) {
      throw new SchemaTooNewError(`kb.sqlite schema v${v} is newer than this agent-kb (v${MIGRATIONS.length}); upgrade agent-kb`);
    }
  };
  const v0 = version();
  check(v0);
  if (v0 === MIGRATIONS.length) return;
  // IMMEDIATE takes the write lock up front; re-read inside so a concurrent opener's work is not redone.
  db.exec("BEGIN IMMEDIATE");
  try {
    const v = version();
    check(v);
    for (let i = v; i < MIGRATIONS.length; i++) db.exec(MIGRATIONS[i]);
    db.exec(`PRAGMA user_version = ${MIGRATIONS.length}`);
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

/** Insert or replace by source_path. Title and content are redacted first, and a secret-bearing resume_cmd is dropped: this is the only write path. */
export function upsertDoc(db, doc, now = Date.now()) {
  if (!TIERS.includes(doc.tier)) throw new Error(`unknown tier: ${doc.tier}`);
  const title = doc.title == null ? null : redact(doc.title).text;
  const content = redact(doc.content).text;
  // A resume command holding a secret (a cwd like /w/DB_PASSWORD=…) is dropped: redacted, it would not run.
  const resume = doc.resume_cmd != null && !Object.keys(redact(doc.resume_cmd).hits).length ? doc.resume_cmd : null;
  db.prepare(
    `INSERT INTO documents (source_path, source_type, tier, title, content, event_ts, indexed_ts, resume_cmd)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(source_path) DO UPDATE SET
       source_type = excluded.source_type, tier = excluded.tier, title = excluded.title,
       content = excluded.content, event_ts = excluded.event_ts,
       indexed_ts = excluded.indexed_ts, resume_cmd = excluded.resume_cmd, transcript_gone = 0`,
  ).run(
    doc.source_path, doc.source_type, doc.tier, title, content,
    doc.event_ts ?? null, now, resume,
  );
}

/** Takes or renews lock `name` for `owner` until now + ttlMs; false while another owner holds it. */
export function acquireLock(db, name, owner, ttlMs, now = Date.now()) {
  const r = db
    .prepare(
      `INSERT INTO locks (name, owner, expires_ms) VALUES (?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET owner = excluded.owner, expires_ms = excluded.expires_ms
       WHERE locks.owner = excluded.owner OR locks.expires_ms <= ?`,
    )
    .run(name, owner, now + ttlMs, now);
  return r.changes === 1;
}

/** Extends a lock `owner` still holds; false once it expired and was taken, or was released. Never re-takes. */
export function renewLock(db, name, owner, ttlMs, now = Date.now()) {
  return db.prepare("UPDATE locks SET expires_ms = ? WHERE name = ? AND owner = ?").run(now + ttlMs, name, owner).changes === 1;
}

export function releaseLock(db, name, owner) {
  db.prepare("DELETE FROM locks WHERE name = ? AND owner = ?").run(name, owner);
}

export function getDoc(db, sourcePath) {
  return db.prepare("SELECT * FROM documents WHERE source_path = ?").get(sourcePath) ?? null;
}

export function stats(db) {
  const byType = db
    .prepare("SELECT source_type, tier, COUNT(*) AS n FROM documents GROUP BY 1, 2 ORDER BY n DESC")
    .all()
    .map((r) => ({ ...r }));
  const total = byType.reduce((s, r) => s + r.n, 0);
  return { total, byType };
}
