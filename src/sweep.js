import crypto from "node:crypto";
import fs from "node:fs";
import { acquireLock, getDoc, releaseLock, renewLock, upsertDoc } from "./store.js";
import { SOURCE_TYPE, configDirs, listTranscripts, readDelta } from "./adapters/claude-code.js";
import { backfillTier0 } from "./backfill.js";
import { desktopDir, desktopTitles, withDesktopTitles } from "./adapters/claude-desktop.js";
import { NOTHING, summaryInput } from "./summarize.js";

export const IDLE_MS = 20 * 60_000;
const LOCK = "summarize";
// Each call renews the lock first, and one call ends well inside the TTL (claude CLI 5 min, API 5 min).
const LOCK_TTL_MS = 10 * 60_000;
// A slice with less conversation than this is not worth a model call; it waits until the session grows.
const MIN_SLICE_CHARS = 500;
// A session idle this long is finished: its last short slice is summarized instead of waiting forever.
const FINAL_MS = 6 * 3_600_000;
// A finished session's tail shorter than this ("ok", "thanks") is not worth a call; the cursor just moves.
const TRIVIAL_CHARS = 50;
// A longer delta is cut into several slices, each kept whole by the model input clip.
const MAX_SLICE_CHARS = 50_000;
// A file that failed this many runs in a row, each in a run where another call succeeded, waits a week.
const MAX_FAILURES = 3;
const BACKOFF_MS = 7 * 86_400_000;
// Any failed file waits this long before its next try (an outage, or a bad slice while nothing else succeeds).
const RETRY_MS = 3_600_000;
// The first sweep after opt-in reaches back this far; older history is `agent-kb summarize`.
const FIRST_SWEEP_MS = 86_400_000;

// `sweep --ended` retries a held lock this often, for up to one lock TTL.
const ENDED_WAIT = { everyMs: 5_000, maxMs: LOCK_TTL_MS };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const chunkPath = (file, n) => `${file}#w${n}`;

/** Size and mtime as numbers; the inode as exact text, read as a BigInt (NTFS inodes pass 2^53). */
export function fileStat(file) {
  const b = fs.statSync(file, { bigint: true });
  return { size: Number(b.size), mtimeMs: Number(b.mtimeNs) / 1e6, ino: b.ino.toString() };
}

/**
 * Summarizes the unsummarized bytes of each idle transcript, newest first. Each slice becomes its
 * own doc (`<file>#w1`, `#w2` …) beside the tier-0 row; `cursors` records the bytes done, so no
 * byte is summarized twice. Active files (written in the last `idleMs`) wait. A failed slice
 * keeps its cursor and is retried after an hour. One process at a time (lock in the store).
 *
 * `summarize` is null for an estimate: nothing is called or written; `slices` and `inputChars` give the cost.
 */
export async function summarizeIdle(db, transcripts, summarize, opts = {}) {
  const { now = Date.now(), idleMs = IDLE_MS, finalMs = FINAL_MS, since = 0, limit = Infinity } = opts;
  const counts = {
    summarized: 0, nothing: 0, small: 0, active: 0, done: 0, old: 0, backoff: 0, failed: 0,
    slices: 0, inputChars: 0, locked: false, error: null,
  };
  const owner = crypto.randomUUID();
  if (summarize && !acquireLock(db, LOCK, owner, LOCK_TTL_MS, now)) return { ...counts, locked: true };
  const getCursor = db.prepare("SELECT offset, chunks, failures, failed_ts, ino FROM cursors WHERE source_path = ?");
  const setCursor = db.prepare(
    `INSERT INTO cursors (source_path, offset, chunks, failures, failed_ts, ino) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(source_path) DO UPDATE SET offset = excluded.offset, chunks = excluded.chunks,
       failures = excluded.failures, failed_ts = excluded.failed_ts, ino = excluded.ino`,
  );
  // Writes only while this run still holds the lock and the cursor is where the slice started:
  // a call can outlive the lock (a sleeping laptop) while another process moves the cursor on.
  const guarded = (file, offset, chunks, write) => {
    db.exec("BEGIN IMMEDIATE");
    try {
      const c = getCursor.get(file) ?? { offset: 0, chunks: 0 };
      if (!renewLock(db, LOCK, owner, LOCK_TTL_MS) || c.offset !== offset || c.chunks !== chunks) {
        db.exec("ROLLBACK");
        return false;
      }
      write();
      db.exec("COMMIT");
      return true;
    } catch (e) {
      if (db.isTransaction) db.exec("ROLLBACK");
      throw e;
    }
  };
  const failedFiles = [];
  let succeeded = false;
  try {
    const files = [];
    for (const t of transcripts) {
      if (t.unreadable) continue;
      try {
        files.push({ file: t.file, st: fileStat(t.file), cur: getCursor.get(t.file) ?? { offset: 0, chunks: 0, failures: 0, failed_ts: 0, ino: "" } });
      } catch {
        counts.failed++;
      }
    }
    // newest first; a file that failed last time goes after the rest, so it cannot block them
    files.sort((a, b) => (a.cur.failed_ts > 0) - (b.cur.failed_ts > 0) || b.st.mtimeMs - a.st.mtimeMs);
    let failedInARow = 0;
    run: for (const { file, st, cur } of files) {
      if (cur.offset && (st.size < cur.offset || (cur.ino && cur.ino !== st.ino))) {
        // another file now sits at this path (shorter, or a new inode): read it from the start;
        // old #wN docs stay, numbering goes on
        if (summarize && !guarded(file, cur.offset, cur.chunks, () => setCursor.run(file, 0, cur.chunks, cur.failures, cur.failed_ts, st.ino))) {
          counts.locked = true;
          break;
        }
        cur.offset = 0;
      }
      if (st.size <= cur.offset) {
        counts.done++;
        continue;
      }
      if (st.mtimeMs < since) {
        counts.old++;
        continue;
      }
      if (now - st.mtimeMs < idleMs) {
        counts.active++;
        continue;
      }
      if (cur.failed_ts && now - cur.failed_ts < (cur.failures >= MAX_FAILURES ? BACKOFF_MS : RETRY_MS)) {
        counts.backoff++;
        continue;
      }
      let { offset, chunks, failures } = cur;
      while (offset < st.size) {
        if (counts.slices >= limit) break run;
        try {
          const delta = readDelta(file, offset, MAX_SLICE_CHARS, MIN_SLICE_CHARS);
          const chars = delta.turns.reduce((n, t) => n + t.text.length, 0);
          const finished = now - st.mtimeMs >= finalMs;
          if (delta.end === offset || (chars < MIN_SLICE_CHARS && !finished)) {
            counts.small++;
            break;
          }
          if (chars < TRIVIAL_CHARS) {
            // a finished session's tail of tool output or a word or two: nothing to summarize
            if (summarize && !guarded(file, offset, chunks, () => setCursor.run(file, delta.end, chunks, 0, 0, st.ino))) {
              counts.locked = true;
              break run;
            }
            offset = delta.end;
            continue;
          }
          const input = summaryInput(delta.turns);
          counts.inputChars += input.length;
          counts.slices++;
          if (!summarize) {
            offset = delta.end;
            continue;
          }
          if (!renewLock(db, LOCK, owner, LOCK_TTL_MS)) {
            counts.locked = true; // the lock expired and another process took it: stop, it carries on
            break run;
          }
          const note = (await summarize(input)).trim();
          const keep = note && note !== NOTHING;
          const wrote = guarded(file, offset, chunks, () => {
            if (keep) {
              const base = getDoc(db, file);
              upsertDoc(db, {
                source_path: chunkPath(file, chunks + 1),
                source_type: SOURCE_TYPE,
                tier: "episodic",
                title: `${base?.title ?? file} (#w${chunks + 1})`,
                content: note,
                event_ts: delta.lastActivity ?? Math.trunc(st.mtimeMs),
                resume_cmd: base?.resume_cmd ?? null,
              });
            }
            setCursor.run(file, delta.end, chunks + (keep ? 1 : 0), 0, 0, st.ino);
          });
          if (!wrote) {
            counts.locked = true;
            break run;
          }
          if (keep) (chunks++, counts.summarized++);
          else counts.nothing++;
          offset = delta.end;
          failures = 0;
          failedInARow = 0;
          succeeded = true;
        } catch (e) {
          // model or read error: the cursor did not move, so a later run retries this slice
          counts.failed++;
          counts.error = String(e?.message ?? e).slice(0, 300);
          if (summarize) failedFiles.push({ file, offset, chunks, failures, ino: st.ino });
          if (++failedInARow >= MAX_FAILURES) break run; // no key, no CLI, rate limit: stop instead of failing every file
          break;
        }
      }
    }
    // A failure counts against a file only when another call in this run worked; an outage counts against
    // none. Either way the file moves to the back of the next run.
    for (const f of failedFiles) {
      const ok = guarded(f.file, f.offset, f.chunks, () =>
        setCursor.run(f.file, f.offset, f.chunks, f.failures + (succeeded ? 1 : 0), now, f.ino),
      );
      if (!ok) break;
    }
  } finally {
    if (summarize) releaseLock(db, LOCK, owner);
  }
  return counts;
}

/**
 * The oldest mtime a background sweep summarizes: sessions changed since summaries were turned on
 * (the first sweep stores it), so opting in never bills the whole history. `summarize` covers the rest.
 */
export function sweepSince(db, now = Date.now()) {
  // two first sweeps may race: the first insert wins and both read it back
  db.prepare("INSERT INTO meta (key, value) VALUES ('sweep_since', ?) ON CONFLICT(key) DO NOTHING").run(now - FIRST_SWEEP_MS);
  return db.prepare("SELECT value FROM meta WHERE key = 'sweep_since'").get().value;
}

/**
 * Flags docs whose transcript the host app deleted (`transcript_gone`), and clears the flag when
 * the file is back (an unmounted drive). Summaries stay searchable either way.
 */
export function markGone(db) {
  const rows = db.prepare("SELECT id, source_path, transcript_gone FROM documents WHERE source_type = ?").all(SOURCE_TYPE);
  const set = db.prepare("UPDATE documents SET transcript_gone = ? WHERE id = ?");
  const gone = new Set();
  for (const r of rows) {
    const transcript = r.source_path.replace(/#w\d+$/, "");
    const g = fs.existsSync(transcript) ? 0 : 1;
    if (g !== r.transcript_gone) set.run(g, r.id);
    if (g) gone.add(transcript);
  }
  return gone.size; // transcripts, not docs
}

/**
 * One sweeper tick: index changed transcripts (tier 0), flag deleted ones, then summarize idle ones
 * when a summarizer is set. `ended` names one transcript whose session just ended: only it is
 * summarized, with no idle wait; a held lock is retried for up to 10 min.
 */
export async function sweepOnce(db, { summarize = null, ended = null, dirs = configDirs(), desktop = desktopDir(), wait = ENDED_WAIT } = {}) {
  const all = withDesktopTitles(listTranscripts(dirs), desktopTitles(desktop));
  // an ended session touches only its own file; a path outside the config dirs matches nothing.
  // The host may name it through a linked profile dir, which is listed under the real one.
  let transcripts = all;
  if (ended) {
    transcripts = all.filter((t) => t.file === ended);
    const r = transcripts.length ? null : realPath(ended);
    if (r) transcripts = all.filter((t) => !t.unreadable && realPath(t.file) === r);
  }
  if (!ended) dropAliases(db, all);
  const t0 = await backfillTier0(db, transcripts);
  const gone = ended ? 0 : markGone(db);
  const opts = { since: sweepSince(db), ...(ended && { idleMs: 0, finalMs: 0 }) };
  const work = summarize && !(ended && !transcripts.length);
  let s = work ? await summarizeIdle(db, transcripts, summarize, opts) : null;
  // an ended session waits its turn: several sessions closing at once, or a tick mid-run, hold the lock
  for (const until = Date.now() + wait.maxMs; ended && s?.locked && Date.now() < until; ) {
    await (wait.sleep ?? sleep)(wait.everyMs);
    s = await summarizeIdle(db, transcripts, summarize, opts);
  }
  return { t0, gone, s };
}

/**
 * Claims the next tick across processes: true for at most one caller per `gapMs`. Every open
 * session runs its own MCP server, and only one of them should sweep.
 */
export function claimTick(db, gapMs, now = Date.now()) {
  const r = db
    .prepare("INSERT INTO meta (key, value) VALUES ('last_tick', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value WHERE meta.value <= ?")
    .run(now, now - gapMs);
  return r.changes === 1;
}

const realPath = (f) => {
  try {
    return fs.realpathSync(f);
  } catch {
    return null;
  }
};

/**
 * Folds rows filed under a path that is no longer listed but is the same file as a listed one (a
 * profile dir linking its `projects` to ~/.claude/projects, indexed before such dirs were listed once).
 * Its tier-0 row and scan go: the listed path has its own. Its summaries and cursor move to the listed
 * path when that has none yet, else they go. Returns the paths folded.
 */
export function dropAliases(db, transcripts) {
  const listed = new Set(transcripts.filter((t) => !t.unreadable).map((t) => t.file));
  const known = db
    .prepare("SELECT source_path FROM documents WHERE source_type = ? UNION SELECT source_path FROM cursors UNION SELECT source_path FROM scans")
    .all(SOURCE_TYPE)
    .map((r) => r.source_path.replace(/#w\d+$/, ""));
  // unlisted and still on disk (a transcript deleted by the host is markGone's business)
  const candidates = [...new Set(known)].filter((f) => !listed.has(f)).map((f) => [f, realPath(f)]).filter(([, r]) => r);
  if (!candidates.length) return 0;
  const byReal = new Map();
  for (const f of listed) {
    const r = realPath(f);
    if (r) byReal.set(r, f);
  }
  const chunks = "substr(source_path, 1, length(?)) = ?"; // `<alias>#w…`, with no LIKE/GLOB escaping
  const q = {
    delDoc: db.prepare("DELETE FROM documents WHERE source_path = ?"),
    delScan: db.prepare("DELETE FROM scans WHERE source_path = ?"),
    hasCursor: db.prepare("SELECT 1 FROM cursors WHERE source_path = ?"),
    delChunks: db.prepare(`DELETE FROM documents WHERE ${chunks}`),
    delCursor: db.prepare("DELETE FROM cursors WHERE source_path = ?"),
    moveChunks: db.prepare(`UPDATE documents SET source_path = ? || substr(source_path, length(?) + 1) WHERE ${chunks}`),
    moveCursor: db.prepare("UPDATE cursors SET source_path = ? WHERE source_path = ?"),
  };
  let folded = 0;
  for (const [alias, r] of candidates) {
    const target = byReal.get(r);
    if (!target) continue; // a file outside the listed dirs
    const prefix = `${alias}#w`;
    db.exec("BEGIN IMMEDIATE");
    try {
      q.delDoc.run(alias);
      q.delScan.run(alias);
      if (q.hasCursor.get(target)) {
        q.delChunks.run(prefix, prefix);
        q.delCursor.run(alias);
      } else {
        q.moveChunks.run(target, alias, prefix, prefix);
        q.moveCursor.run(target, alias);
      }
      db.exec("COMMIT");
    } catch (e) {
      if (db.isTransaction) db.exec("ROLLBACK");
      throw e;
    }
    folded++;
  }
  return folded;
}
