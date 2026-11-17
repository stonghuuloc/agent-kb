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
 *
 * Deletion takes two runs. The first moves a transcript aside to a name no lister reads and holds it there; the
 * next run (a cooldown later) deletes it only if nothing wrote to it in between. A writer that kept a handle open
 * from before the move would append to the held file, and that file goes back instead of being deleted.
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
  const cursorOf = db.prepare("SELECT offset, ino FROM cursors WHERE source_path = ?");
  const out = [];
  const seen = new Set();
  for (const { source_path: raw } of summarized) {
    const suffix = /#(w\d+|journal-(learned|friction))$/.exec(raw);
    if (!suffix) continue; // a "#w" inside a folder name is not a summary
    const file = raw.slice(0, suffix.index);
    if (seen.has(file)) continue;
    if (!file.endsWith(".jsonl") || (roots && !roots.some((r) => file.startsWith(r + path.sep)))) continue;
    let st;
    try {
      const b = fs.statSync(file, { bigint: true });
      st = { size: Number(b.size), mtimeMs: Number(b.mtimeMs), ino: b.ino.toString() };
    } catch {
      continue;
    }
    if (st.mtimeMs >= cutoff) continue;
    // every byte summarized: a failed slice leaves the cursor short, and those bytes are the only copy
    // and it is still the file the cursor describes: same size and same inode. A cursor with no inode (written
    // before inodes were recorded) proves nothing about which file it read, so that file stays.
    const cur = cursorOf.get(file);
    if (!cur || !cur.ino || cur.offset !== st.size || cur.ino !== st.ino) continue;
    seen.add(file);
    out.push({ file, bytes: st.size, mtime: st.mtimeMs, ino: st.ino });
  }
  return out.sort((a, b) => a.mtime - b.mtime);
}

/** The candidate is still the same file, read through one handle just before it is deleted. */
function unchanged(c, file = c.file) {
  let fd;
  try {
    fd = fs.openSync(file, "r");
    const b = fs.fstatSync(fd, { bigint: true });
    return Number(b.size) === c.bytes && Number(b.mtimeMs) === c.mtime && b.ino.toString() === c.ino;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/**
 * Moves the transcript aside and checks it again there; returns the held name, or null when it was put back. A
 * writer that opens the path after the move creates a new file instead of appending to the held one; one that
 * wrote before the move is seen by the check. Whatever goes wrong after the move, the transcript goes back.
 */
function holdIfUnchanged(c, { beforeMove, afterMove } = {}) {
  if (!unchanged(c)) return null; // resumed or replaced since it was listed: not the file that was summarized
  beforeMove?.(c);
  const aside = `${c.file}.agent-kb-prune-${process.pid}-${Date.now()}`;
  fs.renameSync(c.file, aside);
  try {
    afterMove?.(c, aside);
    if (unchanged(c, aside)) return aside;
  } catch {}
  putBack(aside, c.file);
  return null;
}

// One meta row per held transcript: `prune_held:<aside>` → { file, bytes, mtime, ino, at }.
const HELD = "prune_held:";

/**
 * Deletes each transcript held for at least `cooldownDays` that nothing wrote to since it was held, then its
 * docs, scan and cursor. The file is unlinked through an open handle and checked again through it, so a write
 * that lands during the unlink is still seen. A changed file goes back to its path (or beside it) with its rows
 * kept, so the sweep summarizes only the new bytes. A failure before the unlink keeps the row for a later run;
 * one while restoring after it (disk full) loses what was written during the unlink.
 */
function releaseHeld(db, { now, cooldownDays, afterUnlink = null }) {
  const rows = db.prepare("SELECT key, value FROM meta WHERE substr(key, 1, ?) = ?").all(HELD.length, HELD);
  const drop = db.prepare("DELETE FROM meta WHERE key = ?");
  const reIno = db.prepare("UPDATE cursors SET ino = ? WHERE source_path = ?");
  const out = { deleted: 0, freed: 0, restored: 0 };
  for (const r of rows) {
    const aside = r.key.slice(HELD.length);
    const c = JSON.parse(r.value);
    if (now - c.at < cooldownDays * 86_400_000) continue;
    let fd;
    try {
      fd = fs.openSync(aside, "r");
    } catch (e) {
      if (e.code === "ENOENT") {
        forget(db, c.file); // removed by hand meanwhile
        drop.run(r.key);
      }
      continue;
    }
    try {
      if (!sameAs(fd, c)) {
        fs.closeSync(fd);
        fd = undefined;
        putBack(aside, c.file);
        out.restored++;
      } else {
        fs.unlinkSync(aside);
        afterUnlink?.(c, aside);
        if (sameAs(fd, c)) {
          forget(db, c.file);
          out.deleted++;
          out.freed += c.bytes;
        } else {
          // written during the unlink: the bytes are still reachable through our handle
          const ino = restoreFrom(fd, c.file);
          if (ino) reIno.run(ino, c.file); // same bytes plus the new ones, under a new inode
          out.restored++;
        }
      }
      drop.run(r.key);
    } catch {
      /* the OS would not let go: the row stays, and a later run retries */
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
  }
  return out;
}

function sameAs(fd, c) {
  const b = fs.fstatSync(fd, { bigint: true });
  return Number(b.size) === c.bytes && Number(b.mtimeMs) === c.mtime && b.ino.toString() === c.ino;
}

/**
 * Writes an unlinked file's bytes back at its path, or beside it when the path is taken. Returns the new inode
 * when it went back to the path. A write that fails partway removes what it created.
 */
function restoreFrom(fd, file) {
  const bytes = fs.readFileSync(fd);
  for (const [n, target] of [file, `${file}.kept-${Date.now()}`, `${file}.kept-${Date.now()}-${process.pid}`].entries()) {
    let out;
    try {
      out = fs.openSync(target, "wx");
    } catch (e) {
      if (e.code === "EEXIST") continue;
      throw e;
    }
    try {
      fs.writeFileSync(out, bytes);
      return n === 0 ? fs.fstatSync(out, { bigint: true }).ino.toString() : null;
    } catch (e) {
      fs.closeSync(out);
      out = undefined;
      fs.rmSync(target, { force: true });
      throw e;
    } finally {
      if (out !== undefined) fs.closeSync(out);
    }
  }
  throw new Error(`${file}: no free name to restore it under`);
}

/** The transcript's docs, scan and cursor: dropped only once its file is gone for good. */
function forget(db, file) {
  db.prepare("DELETE FROM documents WHERE source_path = ? OR substr(source_path, 1, length(?) + 1) = ? || '#'").run(file, file, file);
  db.prepare("DELETE FROM scans WHERE source_path = ?").run(file);
  db.prepare("DELETE FROM cursors WHERE source_path = ?").run(file);
}

/**
 * Back to its path without replacing a file a writer created there meanwhile. When the path is taken, the
 * transcript is kept beside it under a name no lister reads (`.jsonl.kept-<ts>`), so it is not summarized twice.
 */
function putBack(aside, file) {
  try {
    fs.linkSync(aside, file); // fails instead of replacing
  } catch (e) {
    if (e.code !== "EEXIST" && !fs.existsSync(file)) return fs.renameSync(aside, file); // no hard links here
    return fs.renameSync(aside, `${file}.kept-${Date.now()}`);
  }
  try {
    fs.rmSync(aside, { force: true });
  } catch {
    /* the same file under a second name nothing lists */
  }
}

/**
 * When `confirm` and the cooldown allow: deletes the transcripts an earlier run held (`deleted`, `freed` bytes,
 * `restored` when one was written to meanwhile), then holds this run's candidates (`held`). Their files and
 * docs go on the next run. Returns the candidates either way, plus `cooldown` (true when a
 * recent run was too close).
 */
export function pruneTranscripts(db, { roots = null, days = DEFAULTS.days, cooldownDays = DEFAULTS.cooldownDays, confirm = false, now = Date.now(), env = process.env, candidates: listed = null, beforeMove = null, afterMove = null, afterUnlink = null } = {}) {
  const markerFile = path.join(env.AGENT_KB_HOME || path.join(os.homedir(), "Library", "Application Support", "agent-kb"), "last-prune");
  const last = Number(db.prepare("SELECT value FROM meta WHERE key = 'pruned_at'").get()?.value ?? 0);
  const candidates = listed ?? pruneCandidates(db, { roots, days, now }); // `listed`: a test seam for a file that changes after listing
  const out = { candidates: candidates.length, bytes: candidates.reduce((n, c) => n + c.bytes, 0), held: 0, deleted: 0, freed: 0, restored: 0, cooldown: false, files: candidates };
  if (!confirm) return out;
  if (now - last < cooldownDays * 86_400_000) return { ...out, cooldown: true };
  Object.assign(out, releaseHeld(db, { now, cooldownDays, afterUnlink }));
  const hold = db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
  for (const c of candidates) {
    try {
      const aside = holdIfUnchanged(c, { beforeMove, afterMove }); // test seams around the move
      if (!aside) continue;
      hold.run(`${HELD}${aside}`, JSON.stringify({ file: c.file, bytes: c.bytes, mtime: c.mtime, ino: c.ino, at: now }));
      out.held++;
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
