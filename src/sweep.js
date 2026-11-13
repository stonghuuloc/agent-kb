import crypto from "node:crypto";
import fs from "node:fs";
import { acquireLock, getDoc, releaseLock, renewLock, upsertDoc } from "./store.js";
import { SOURCE_TYPE, TRANSCRIPT_TYPES, configDirs, readDelta } from "./adapters/claude-code.js";
import { backfillTier0 } from "./backfill.js";
import { allTranscripts, desktopDir, enabledSources } from "./adapters/claude-desktop.js";
import { NOTHING, summaryInput } from "./summarize.js";
import { scanConflicts, tagKind } from "./judge.js";

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

/** sha256 of bytes [start, end) of `file`: offsets alone miss a same-length rewrite. */
export function sliceHash(file, start, end) {
  const buf = Buffer.alloc(end - start);
  const fd = fs.openSync(file, "r");
  try {
    fs.readSync(fd, buf, 0, buf.length, start);
  } finally {
    fs.closeSync(fd);
  }
  return crypto.createHash("sha256").update(buf).digest("hex");
}
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
  const { now = Date.now(), idleMs = IDLE_MS, finalMs = FINAL_MS, since = 0, limit = Infinity, judges = null } = opts;
  const counts = {
    summarized: 0, nothing: 0, skipped: 0, small: 0, active: 0, done: 0, old: 0, backoff: 0, failed: 0,
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
        files.push({ file: t.file, type: t.sourceType ?? SOURCE_TYPE, st: fileStat(t.file), cur: getCursor.get(t.file) ?? { offset: 0, chunks: 0, failures: 0, failed_ts: 0, ino: "" } });
      } catch {
        counts.failed++;
      }
    }
    // newest first; a file that failed last time goes after the rest, so it cannot block them
    files.sort((a, b) => (a.cur.failed_ts > 0) - (b.cur.failed_ts > 0) || b.st.mtimeMs - a.st.mtimeMs);
    let failedInARow = 0;
    run: for (const { file, type, st, cur } of files) {
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
          // triage may skip the call, never delete: the cursor moves like NOTHING, and `pin` can bring the slice back
          const tri = judges?.has("triage") ? await judges.run("triage", { text: input }) : null;
          if (tri && judges.acts("triage") && tri.label === "skip") {
            const skipped = guarded(file, offset, chunks, () => {
              judges.log("triage", [file], tri, { acted: true, sliceStart: offset, sliceEnd: delta.end, sliceHash: sliceHash(file, offset, delta.end) });
              setCursor.run(file, delta.end, chunks, 0, 0, st.ino);
            });
            if (!skipped) {
              counts.locked = true;
              break run;
            }
            counts.skipped++;
            offset = delta.end;
            continue;
          }
          const note = (await summarize(input)).trim();
          const keep = note && note !== NOTHING;
          if (keep && judges?.has("kind") && !renewLock(db, LOCK, owner, LOCK_TTL_MS)) {
            counts.locked = true;
            break run;
          }
          const kind = keep ? await tagKind(judges, note) : null;
          const wrote = guarded(file, offset, chunks, () => {
            if (keep) {
              const base = getDoc(db, file);
              upsertDoc(db, {
                source_path: chunkPath(file, chunks + 1),
                source_type: type,
                tier: kind.tier,
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
          if (tri) judges.log("triage", [file], tri, { sliceStart: offset, sliceEnd: delta.end });
          if (keep) {
            chunks++;
            counts.summarized++;
            if (kind.judgment) judges.log("kind", [chunkPath(file, chunks)], kind.judgment, { acted: judges.acts("kind") });
            await scanConflicts(db, judges, chunkPath(file, chunks)).catch(() => {}); // flags only; never fails the slice
          } else counts.nothing++;
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
 * Summarizes the slices triage skipped and the user then said were worth keeping (`pin`, `label … yes`).
 * Each becomes the next `#wN` doc; the cursor offset stays where it is. A slice whose bytes changed since
 * (the transcript was replaced: offsets or slice hash differ) cannot be rebuilt and is given up. One lock, like `summarizeIdle`.
 */
export async function summarizePinned(db, summarize, now = Date.now()) {
  const counts = { summarized: 0, nothing: 0, lost: 0, failed: 0, locked: false, backoff: false, error: null };
  const queue = () => db.prepare("SELECT id, docs, slice_start, slice_end, slice_hash, failures FROM judgments WHERE point = 'triage' AND acted = 1 AND truth = 'yes' AND redone = 0 ORDER BY id").all();
  if (!summarize || !queue().length) return counts;
  const failedAt = db.prepare("SELECT value FROM meta WHERE key = 'pinned_failed_ts'").get()?.value ?? 0;
  if (now - failedAt < RETRY_MS) return { ...counts, backoff: true };
  const owner = crypto.randomUUID();
  if (!acquireLock(db, LOCK, owner, LOCK_TTL_MS, now)) return { ...counts, locked: true };
  let failedInARow = 0;
  try {
    const pending = queue(); // read under the lock: another process may have finished a pin since
    const done = db.prepare("UPDATE judgments SET redone = 1 WHERE id = ?");
    for (const j of pending) {
      const file = JSON.parse(j.docs)[0];
      try {
        // bounded at the skipped slice's end: a session that grew since still yields exactly that slice
        const delta = fs.existsSync(file) ? readDelta(file, j.slice_start, MAX_SLICE_CHARS, MIN_SLICE_CHARS, j.slice_end) : null;
        const cursor = db.prepare("SELECT chunks FROM cursors WHERE source_path = ?").get(file);
        if (!delta || delta.end !== j.slice_end || !cursor || (j.slice_hash && sliceHash(file, j.slice_start, j.slice_end) !== j.slice_hash)) {
          done.run(j.id);
          counts.lost++;
          continue;
        }
        const note = (await summarize(summaryInput(delta.turns))).trim();
        db.exec("BEGIN IMMEDIATE");
        try {
          const c = db.prepare("SELECT chunks FROM cursors WHERE source_path = ?").get(file);
          if (!renewLock(db, LOCK, owner, LOCK_TTL_MS)) {
            db.exec("ROLLBACK");
            counts.locked = true;
            break;
          }
          if (!c) {
            done.run(j.id);
            counts.lost++;
          } else if (note && note !== NOTHING) {
            const base = getDoc(db, file);
            upsertDoc(db, {
              source_path: chunkPath(file, c.chunks + 1),
              source_type: base?.source_type ?? SOURCE_TYPE,
              tier: "episodic",
              title: `${base?.title ?? file} (#w${c.chunks + 1})`,
              content: note,
              event_ts: delta.lastActivity ?? base?.event_ts ?? null,
              resume_cmd: base?.resume_cmd ?? null,
            });
            db.prepare("UPDATE cursors SET chunks = ? WHERE source_path = ?").run(c.chunks + 1, file);
            done.run(j.id);
            counts.summarized++;
            failedInARow = 0;
          } else {
            done.run(j.id);
            counts.nothing++;
            failedInARow = 0;
          }
          db.exec("COMMIT");
        } catch (e) {
          if (db.isTransaction) db.exec("ROLLBACK");
          throw e;
        }
      } catch (e) {
        // a model or read error: retry in an hour; a slice that fails 3 times is given up, so it cannot block the pins after it
        counts.failed++;
        counts.error = String(e?.message ?? e).slice(0, 300);
        db.prepare("INSERT INTO meta (key, value) VALUES ('pinned_failed_ts', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(now);
        db.prepare("UPDATE judgments SET failures = failures + 1 WHERE id = ?").run(j.id);
        if (j.failures + 1 >= MAX_FAILURES) {
          done.run(j.id);
          counts.lost++;
        }
        if (++failedInARow >= MAX_FAILURES) break; // an outage, not one bad slice
      }
    }
  } finally {
    releaseLock(db, LOCK, owner);
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
  const rows = db.prepare("SELECT id, source_path, transcript_gone FROM documents WHERE source_type IN (SELECT value FROM json_each(?))").all(JSON.stringify(TRANSCRIPT_TYPES));
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
export async function sweepOnce(db, { summarize = null, ended = null, dirs = configDirs(), desktop = desktopDir(), sources = enabledSources(), wait = ENDED_WAIT, judges = null } = {}) {
  judges?.refresh();
  const all = allTranscripts(dirs, desktop, sources);
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
  const opts = { since: sweepSince(db), judges, ...(ended && { idleMs: 0, finalMs: 0 }) };
  const work = summarize && !(ended && !transcripts.length);
  let s = work ? await summarizeIdle(db, transcripts, summarize, opts) : null;
  // an ended session waits its turn: several sessions closing at once, or a tick mid-run, hold the lock
  for (const until = Date.now() + wait.maxMs; ended && s?.locked && Date.now() < until; ) {
    await (wait.sleep ?? sleep)(wait.everyMs);
    s = await summarizeIdle(db, transcripts, summarize, opts);
  }
  const pinned = summarize && !ended ? await summarizePinned(db, summarize) : null;
  return { t0, gone, s, pinned };
}

/**
 * Claims the next tick across processes: true for at most one caller per `gapMs`. Every open
 * session runs its own MCP server, and only one of them should sweep. `key` keeps index-only
 * ticks from consuming the claim of a server that summarizes.
 */
export function claimTick(db, gapMs, now = Date.now(), key = "last_tick") {
  const r = db
    .prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value WHERE meta.value <= ?")
    .run(key, now, now - gapMs);
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
 * Its tier-0 row and scan go: the listed path has its own. Of the two sets of summaries and cursors,
 * the one that got further through the transcript is kept under the listed path. Returns the paths folded.
 */
export function dropAliases(db, transcripts) {
  const listed = new Set(transcripts.filter((t) => !t.unreadable).map((t) => t.file));
  const known = db
    .prepare("SELECT source_path FROM documents WHERE source_type IN (SELECT value FROM json_each(?)) UNION SELECT source_path FROM cursors UNION SELECT source_path FROM scans")
    .all(JSON.stringify(TRANSCRIPT_TYPES))
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
    cursor: db.prepare("SELECT offset FROM cursors WHERE source_path = ?"),
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
      // keep the summaries of whichever path got further; a tie keeps the listed path's
      const mine = q.cursor.get(target);
      const theirs = q.cursor.get(alias);
      if (mine && (!theirs || mine.offset >= theirs.offset)) {
        q.delChunks.run(prefix, prefix);
        q.delCursor.run(alias);
      } else {
        const own = `${target}#w`;
        q.delChunks.run(own, own);
        q.delCursor.run(target);
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
