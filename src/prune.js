import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TRANSCRIPT_TYPES } from "./adapters/claude-code.js";

/**
 * Retention: delete a raw transcript once it has a summary and is older than `days`. The current kb runs
 * `kb-prune-transcripts.sh` weekly for this.
 *
 * Only files the kb has already summarized are candidates — a transcript without a doc is the only copy of
 * something never captured, so it stays. A cold-down keeps two runs apart, because the host app re-creates
 * a session file every time a session is resumed.
 */

export const DEFAULTS = { days: 90, cooldownDays: 13 };

/** Transcripts with a summary, older than `days`, as [{ file, bytes }]. Never deletes anything. */
export function pruneCandidates(db, { roots, days = DEFAULTS.days, now = Date.now() } = {}) {
  const cutoff = now - days * 86_400_000;
  // a model-written summary is a `#wN` slice or a `#journal-*` doc; the tier-0 prompt row is not one, so a
  // transcript that was only indexed keeps its file — it is the only copy of everything else in it
  const summarized = db.prepare(
    `SELECT source_path FROM documents WHERE source_type IN (SELECT value FROM json_each(?))
     AND (source_path LIKE '%#w%' OR source_path LIKE '%#journal-%')`,
  ).all(JSON.stringify(TRANSCRIPT_TYPES));
  const out = [];
  const seen = new Set();
  for (const { source_path: raw } of summarized) {
    const file = raw.replace(/#w\d+$/, "").replace(/#journal-(learned|friction)$/, "");
    if (seen.has(file)) continue;
    if (!file.endsWith(".jsonl") || (roots && !roots.some((r) => file.startsWith(r + path.sep)))) continue;
    let st;
    try {
      st = fs.statSync(file);
    } catch {
      continue;
    }
    if (st.mtimeMs >= cutoff) continue;
    seen.add(file);
    out.push({ file, bytes: st.size, mtime: Math.trunc(st.mtimeMs) });
  }
  return out.sort((a, b) => a.mtime - b.mtime);
}

/**
 * Deletes the candidates when `confirm` and the cooldown allows. Returns what it would delete either way,
 * plus `deleted`, `bytes` and `cooldown` (true when a recent run was too close).
 */
export function pruneTranscripts(db, { roots = null, days = DEFAULTS.days, cooldownDays = DEFAULTS.cooldownDays, confirm = false, now = Date.now(), env = process.env } = {}) {
  const markerFile = path.join(env.AGENT_KB_HOME || path.join(os.homedir(), "Library", "Application Support", "agent-kb"), "last-prune");
  const last = Number(db.prepare("SELECT value FROM meta WHERE key = 'pruned_at'").get()?.value ?? 0);
  const candidates = pruneCandidates(db, { roots, days, now });
  const out = { candidates: candidates.length, bytes: candidates.reduce((n, c) => n + c.bytes, 0), deleted: 0, cooldown: false, files: candidates };
  if (!confirm) return out;
  if (now - last < cooldownDays * 86_400_000) return { ...out, cooldown: true };
  for (const c of candidates) {
    try {
      fs.rmSync(c.file);
      db.prepare("DELETE FROM documents WHERE source_path = ? OR source_path LIKE ?").run(c.file, `${c.file}#%`);
      db.prepare("DELETE FROM scans WHERE source_path = ?").run(c.file);
      db.prepare("DELETE FROM cursors WHERE source_path = ?").run(c.file);
      out.deleted++;
    } catch {
      /* a file the OS will not let go: it stays a candidate, and a later run retries */
    }
  }
  db.prepare("INSERT INTO meta (key, value) VALUES ('pruned_at', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(now));
  try {
    fs.mkdirSync(path.dirname(markerFile), { recursive: true });
    fs.writeFileSync(markerFile, new Date(now).toISOString() + "\n");
  } catch {}
  return out;
}
