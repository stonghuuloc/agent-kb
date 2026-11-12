import crypto from "node:crypto";
import fs from "node:fs";
import { acquireLock, getDoc, releaseLock, renewLock, upsertDoc } from "./store.js";
import { SOURCE_TYPE, readDelta } from "./adapters/claude-code.js";
import { NOTHING, summaryInput } from "./summarize.js";

export const IDLE_MS = 20 * 60_000;
const LOCK = "summarize";
// Each call renews the lock first, and one call ends well inside the TTL (claude CLI 5 min, API ~6 min).
const LOCK_TTL_MS = 10 * 60_000;
// A slice with less conversation than this is not worth a model call; it waits until the session grows.
const MIN_SLICE_CHARS = 500;
// A longer delta is cut into several slices, each kept whole by the model input clip.
const MAX_SLICE_CHARS = 50_000;
// A file that failed this many runs in a row, each in a run where another call succeeded, waits a week.
const MAX_FAILURES = 3;
const BACKOFF_MS = 7 * 86_400_000;
// Any failed file waits this long before its next try (an outage, or a bad slice while nothing else succeeds).
const RETRY_MS = 3_600_000;
// The first sweep after opt-in reaches back this far; older history is `agent-kb summarize`.
const FIRST_SWEEP_MS = 86_400_000;

const chunkPath = (file, n) => `${file}#w${n}`;

/**
 * Summarizes the unsummarized bytes of each idle transcript, newest first. Each slice becomes its
 * own doc (`<file>#w1`, `#w2` …) beside the tier-0 row; `cursors` records the bytes done, so no
 * byte is summarized twice. Active files (written in the last `idleMs`) wait. A failed slice
 * keeps its cursor and is retried after an hour. One process at a time (lock in the store).
 *
 * `summarize` is null for an estimate: nothing is called or written; `slices` and `inputChars` give the cost.
 */
export async function summarizeIdle(db, transcripts, summarize, opts = {}) {
  const { now = Date.now(), idleMs = IDLE_MS, since = 0, limit = Infinity } = opts;
  const counts = {
    summarized: 0, nothing: 0, small: 0, active: 0, done: 0, old: 0, backoff: 0, failed: 0,
    slices: 0, inputChars: 0, locked: false, error: null,
  };
  const owner = crypto.randomUUID();
  if (summarize && !acquireLock(db, LOCK, owner, LOCK_TTL_MS, now)) return { ...counts, locked: true };
  const getCursor = db.prepare("SELECT offset, chunks, failures, failed_ts FROM cursors WHERE source_path = ?");
  const setCursor = db.prepare(
    `INSERT INTO cursors (source_path, offset, chunks, failures, failed_ts) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(source_path) DO UPDATE SET offset = excluded.offset, chunks = excluded.chunks,
       failures = excluded.failures, failed_ts = excluded.failed_ts`,
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
        files.push({ file: t.file, st: fs.statSync(t.file), cur: getCursor.get(t.file) ?? { offset: 0, chunks: 0, failures: 0, failed_ts: 0 } });
      } catch {
        counts.failed++;
      }
    }
    // newest first; a file that failed last time goes after the rest, so it cannot block them
    files.sort((a, b) => (a.cur.failed_ts > 0) - (b.cur.failed_ts > 0) || b.st.mtimeMs - a.st.mtimeMs);
    let failedInARow = 0;
    run: for (const { file, st, cur } of files) {
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
          if (delta.end === offset || chars < MIN_SLICE_CHARS) {
            counts.small++;
            break;
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
            setCursor.run(file, delta.end, chunks + (keep ? 1 : 0), 0, 0);
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
          if (summarize) failedFiles.push({ file, offset, chunks, failures });
          if (++failedInARow >= MAX_FAILURES) break run; // no key, no CLI, rate limit: stop instead of failing every file
          break;
        }
      }
    }
    // A failure counts against a file only when another call in this run worked; an outage counts against
    // none. Either way the file moves to the back of the next run.
    for (const f of failedFiles) {
      const ok = guarded(f.file, f.offset, f.chunks, () =>
        setCursor.run(f.file, f.offset, f.chunks, f.failures + (succeeded ? 1 : 0), now),
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
  const row = db.prepare("SELECT value FROM meta WHERE key = 'sweep_since'").get();
  if (row) return row.value;
  const since = now - FIRST_SWEEP_MS;
  db.prepare("INSERT INTO meta (key, value) VALUES ('sweep_since', ?)").run(since);
  return since;
}

/**
 * Flags docs whose transcript the host app deleted (`transcript_gone`), and clears the flag when
 * the file is back (an unmounted drive). Summaries stay searchable either way.
 */
export function markGone(db) {
  const rows = db.prepare("SELECT id, source_path, transcript_gone FROM documents WHERE source_type = ?").all(SOURCE_TYPE);
  const set = db.prepare("UPDATE documents SET transcript_gone = ? WHERE id = ?");
  let gone = 0;
  for (const r of rows) {
    const g = fs.existsSync(r.source_path.replace(/#w\d+$/, "")) ? 0 : 1;
    if (g !== r.transcript_gone) set.run(g, r.id);
    gone += g;
  }
  return gone;
}
