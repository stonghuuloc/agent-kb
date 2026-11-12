import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

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
];

export function openStore(file) {
  if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
  migrate(db);
  return db;
}

function migrate(db) {
  const { user_version: v } = db.prepare("PRAGMA user_version").get();
  if (v > MIGRATIONS.length) {
    throw new Error(`kb.sqlite schema v${v} is newer than this agent-kb (v${MIGRATIONS.length}); upgrade agent-kb`);
  }
  for (let i = v; i < MIGRATIONS.length; i++) {
    db.exec("BEGIN");
    try {
      db.exec(MIGRATIONS[i]);
      db.exec(`PRAGMA user_version = ${i + 1}`);
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }
}

/** Insert or replace by source_path. */
export function upsertDoc(db, doc, now = Date.now()) {
  if (!TIERS.includes(doc.tier)) throw new Error(`unknown tier: ${doc.tier}`);
  db.prepare(
    `INSERT INTO documents (source_path, source_type, tier, title, content, event_ts, indexed_ts, resume_cmd)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(source_path) DO UPDATE SET
       source_type = excluded.source_type, tier = excluded.tier, title = excluded.title,
       content = excluded.content, event_ts = excluded.event_ts,
       indexed_ts = excluded.indexed_ts, resume_cmd = excluded.resume_cmd`,
  ).run(
    doc.source_path, doc.source_type, doc.tier, doc.title ?? null, doc.content,
    doc.event_ts ?? null, now, doc.resume_cmd ?? null,
  );
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
