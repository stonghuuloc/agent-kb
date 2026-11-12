import crypto from "node:crypto";
import fs from "node:fs";
import { acquireLock, getDoc, releaseLock, upsertDoc } from "./store.js";
import { SOURCE_TYPE, readDelta } from "./adapters/claude-code.js";
import { NOTHING, summaryInput } from "./summarize.js";

export const IDLE_MS = 20 * 60_000;
const LOCK = "summarize";
const LOCK_TTL_MS = 10 * 60_000;
// A slice with less conversation than this is not worth a model call; it waits until the session grows.
const MIN_SLICE_CHARS = 500;

const chunkPath = (file, n) => `${file}#w${n}`;

/**
 * Summarizes the unsummarized bytes of each idle transcript, newest first. Each slice becomes its
 * own doc (`<file>#w1`, `#w2` …) beside the tier-0 row; `cursors` records the bytes done, so no
 * byte is summarized twice. Active files (written in the last `idleMs`) wait. A failed slice
 * keeps its cursor and is retried next run. One process at a time (lock in the store).
 *
 * `summarize` is null for an estimate: nothing is called or written; `slices` and `inputChars` give the cost.
 */
export async function summarizeIdle(db, transcripts, summarize, opts = {}) {
  const { now = Date.now(), idleMs = IDLE_MS, since = 0, limit = Infinity } = opts;
  const counts = { summarized: 0, nothing: 0, small: 0, active: 0, done: 0, old: 0, failed: 0, slices: 0, inputChars: 0, locked: false, error: null };
  const owner = crypto.randomUUID();
  if (summarize && !acquireLock(db, LOCK, owner, LOCK_TTL_MS, now)) return { ...counts, locked: true };
  const getCursor = db.prepare("SELECT offset, chunks FROM cursors WHERE source_path = ?");
  const setCursor = db.prepare(
    `INSERT INTO cursors (source_path, offset, chunks, summarized_ts) VALUES (?, ?, ?, ?)
     ON CONFLICT(source_path) DO UPDATE SET offset = excluded.offset, chunks = excluded.chunks,
       summarized_ts = excluded.summarized_ts`,
  );
  try {
    const files = [];
    for (const t of transcripts) {
      if (t.unreadable) continue;
      try {
        files.push({ file: t.file, st: fs.statSync(t.file) });
      } catch {
        counts.failed++;
      }
    }
    files.sort((a, b) => b.st.mtimeMs - a.st.mtimeMs);
    let calls = 0;
    let failedInARow = 0;
    for (const { file, st } of files) {
      const cur = getCursor.get(file) ?? { offset: 0, chunks: 0 };
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
      if (calls >= limit) break;
      try {
        const delta = readDelta(file, cur.offset);
        const chars = delta.turns.reduce((n, t) => n + t.text.length, 0);
        if (delta.end === cur.offset || chars < MIN_SLICE_CHARS) {
          counts.small++;
          continue;
        }
        const input = summaryInput(delta.turns);
        counts.inputChars += input.length;
        counts.slices = ++calls;
        if (!summarize) continue;
        const note = (await summarize(input)).trim();
        let chunks = cur.chunks;
        if (note && note !== NOTHING) {
          chunks++;
          const base = getDoc(db, file);
          upsertDoc(db, {
            source_path: chunkPath(file, chunks),
            source_type: SOURCE_TYPE,
            tier: "episodic",
            title: `${base?.title ?? file} (#w${chunks})`,
            content: note,
            event_ts: delta.lastActivity ?? Math.trunc(st.mtimeMs),
            resume_cmd: base?.resume_cmd ?? null,
          });
          counts.summarized++;
        } else counts.nothing++;
        setCursor.run(file, delta.end, chunks, Date.now());
        acquireLock(db, LOCK, owner, LOCK_TTL_MS); // renew: one slice can take minutes
        failedInARow = 0;
      } catch (e) {
        counts.failed++; // model or read error; the cursor did not move, so the next run retries
        counts.error = String(e?.message ?? e).slice(0, 300);
        if (++failedInARow >= 3) break; // no key, no CLI, rate limit: stop instead of failing every file
      }
    }
  } finally {
    if (summarize) releaseLock(db, LOCK, owner);
  }
  return counts;
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
