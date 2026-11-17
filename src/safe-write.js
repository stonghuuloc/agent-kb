import fs from "node:fs";
import path from "node:path";

/**
 * Rewrites a note another writer may change at the same time, without losing that writer's save. The file is
 * read through one handle; the new text goes to a temp file; just before the swap the file is checked again,
 * and if it changed since the read the merge is redone from the new text. The swap never replaces a file it has
 * not checked: the note is moved aside, checked again there, and the temp file is hard-linked into its place,
 * which fails instead of replacing a note another writer put there meanwhile (by rename or by create). A note
 * that did not exist is created the same exclusive way.
 *
 * `merge(text)` gets the current text (null when there is no file) and returns the new text, or null to leave
 * the file alone. Returns "written", "unchanged" or "conflict" (it kept changing for `tries` rounds).
 * Test seams: `beforeSwap` runs between the temp write and the re-check, `beforeRename` between the re-check and
 * the move aside, `afterMove` between the move and the link, `afterRename` right after the link.
 */
export function replaceIfUnchanged(file, merge, { tries = 3, beforeSwap = null, beforeRename = null, afterMove = null, afterRename = null } = {}) {
  recoverAsides(file);
  // set when a writer saved into the old note in place while it was being swapped out: its text, and what we wrote
  let carry = null;
  for (let i = 0; i < tries || (carry && i < tries * 2); i++) {
    const seen = readWithSig(file);
    let base = seen.text;
    if (carry) {
      // nobody wrote since our swap: merge onto the saved text. Someone did: theirs stays, the save goes beside it.
      if (seen.text === carry.wrote) base = carry.text;
      else keepCopy(file, carry.text);
    }
    const fromCarry = carry !== null && base === carry.text;
    carry = null;
    let next = merge(base);
    if (next === null) {
      if (!fromCarry) return "unchanged";
      next = base ?? ""; // the saved text as it was
    }
    const id = `${process.pid}-${Date.now()}-${++seq}`; // unique per swap; carries its start time for recovery
    const tmp = `${file}.agent-kb-${id}.tmp`;
    const aside = `${file}.agent-kb-${id}.old`;
    let held;
    let moved = false;
    try {
      fs.writeFileSync(tmp, next);
      beforeSwap?.(i);
      if (seen.sig === null) {
        // no note, or another process has it aside mid-swap: wait for that swap instead of starting a new note
        recoverAsides(file);
        if (asides(file).length) {
          pause(20);
          continue;
        }
        // no file at all: link it in exclusively. (An empty file has a sig and is swapped below.)
        if (publish(tmp, file, next)) return "written";
        continue;
      }
      // the old note stays open through the swap: a writer saving into it in place is seen afterwards
      held = openIfPresent(file);
      if (held === undefined || sigFromStat(fs.fstatSync(held, { bigint: true })) !== seen.sig) continue;
      if (process.platform === "win32") {
        // Windows will not move a file this process holds open: the in-place check reads the aside by path there
        fs.closeSync(held);
        held = undefined;
      }
      beforeRename?.(i);
      try {
        live.add(aside);
        fs.renameSync(file, aside);
      } catch (e) {
        // gone meanwhile, or held open by a writer (EBUSY anywhere, EPERM/EACCES on Windows): read again
        if (e.code === "ENOENT" || e.code === "EBUSY" || (process.platform === "win32" && (e.code === "EPERM" || e.code === "EACCES"))) continue;
        throw e;
      }
      moved = true;
      // replaced by another writer's rename, or saved into, after the check: put theirs back and merge again
      if (sigOf(aside) !== seen.sig) continue;
      afterMove?.(i);
      if (!publish(tmp, file, next)) {
        // another writer created the note while it was aside: theirs stands, ours is kept beside it unless it is
        // the same text, and the merge is redone on theirs
        moved = false;
        putBack(aside, file);
        continue;
      }
      afterRename?.(i);
      let saved = null;
      if (held === undefined) {
        if (sigOf(aside) !== seen.sig) saved = fs.readFileSync(aside, "utf8");
        fs.rmSync(aside, { force: true });
      } else {
        // unlinked first, then checked through the handle: a save that lands during the unlink is still seen
        fs.rmSync(aside, { force: true });
        if (sigFromStat(fs.fstatSync(held, { bigint: true })) !== seen.sig) saved = fs.readFileSync(held, "utf8");
      }
      moved = false;
      if (saved === null) return "written";
      // saved in place between the check and the swap: merge that text again, over the note just written
      carry = { text: saved || null, wrote: next };
    } finally {
      if (held !== undefined) fs.closeSync(held);
      fs.rmSync(tmp, { force: true });
      try {
        if (moved) putBack(aside, file);
      } finally {
        live.delete(aside);
      }
    }
  }
  if (carry) keepCopy(file, carry.text);
  return "conflict";
}

let seq = 0;
const live = new Set(); // asides this process holds right now

/**
 * Links `tmp` in at `file`, failing (false) instead of replacing a file someone put there. Where hard links are
 * not supported (exFAT/FAT, some network mounts) the text is written through an exclusive create instead.
 */
function publish(tmp, file, text) {
  try {
    fs.linkSync(tmp, file);
    return true;
  } catch (e) {
    if (e.code === "EEXIST") return false;
    if (!["ENOTSUP", "EPERM", "EXDEV", "ENOSYS", "EOPNOTSUPP", "EMLINK"].includes(e.code)) throw e;
  }
  return createExclusive(file, text);
}

/**
 * Puts a moved-aside note back at `file` without replacing one a writer created there meanwhile; then the
 * aside's text is kept beside it as a conflict copy, unless it is the same text.
 */
function putBack(aside, file) {
  const text = fs.readFileSync(aside, "utf8");
  let back = false;
  try {
    fs.linkSync(aside, file);
    back = true;
  } catch (e) {
    if (e.code !== "EEXIST") back = createExclusive(file, text);
  }
  if (!back && fs.readFileSync(file, "utf8") !== text) keepCopy(file, text);
  fs.rmSync(aside, { force: true });
}

/** Notes moved aside for a swap, by any process: [{ file, pid, at }]. */
function asides(file) {
  const dir = path.dirname(file);
  const prefix = `${path.basename(file)}.agent-kb-`;
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return names.flatMap((n) => {
    const m = n.startsWith(prefix) && /^(\d+)-(\d+)-\d+\.old$/.exec(n.slice(prefix.length));
    return m ? [{ file: path.join(dir, n), pid: Number(m[1]), at: Number(m[2]) }] : [];
  });
}

// a swap holds a note aside for microseconds: one aside this old was left by a crash, whatever its pid says now
const STALE_MS = 10 * 60_000;

/** A note left aside by a process that died mid-swap goes back (or beside the note) before anything else. */
function recoverAsides(file) {
  for (const a of asides(file)) {
    try {
      if (live.has(a.file)) continue;
      // a dead pid, an old swap, or this pid reused after a crash: left behind
      if (a.pid !== process.pid && alive(a.pid) && Math.abs(Date.now() - a.at) < STALE_MS) continue; // abs: a clock stepped back
      putBack(a.file, file);
    } catch {}
  }
}

const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}

/** An editor's save that could not be merged: kept beside the note, never dropped. */
function keepCopy(file, text) {
  if (!text) return;
  const ext = path.extname(file);
  const stem = `${file.slice(0, file.length - ext.length)} (conflict ${Date.now()}`;
  for (let n = 1; ; n++) {
    try {
      return fs.writeFileSync(`${stem}${n > 1 ? ` ${n}` : ""})${ext}`, text, { flag: "wx" });
    } catch (e) {
      if (e.code !== "EEXIST" || n >= 20) throw e;
    }
  }
}

function openIfPresent(file) {
  try {
    return fs.openSync(file, "r");
  } catch (e) {
    if (e.code === "ENOENT") return undefined;
    throw e;
  }
}

/**
 * Creates `file` with `text` only if it does not exist: false when someone created it first. A write that
 * fails partway removes the file, so no empty or cut-off note is left behind.
 */
function createExclusive(file, text) {
  let fd;
  try {
    fd = fs.openSync(file, "wx");
  } catch (e) {
    if (e.code === "EEXIST") return false;
    throw e;
  }
  try {
    fs.writeFileSync(fd, text);
  } catch (e) {
    fs.closeSync(fd);
    fd = undefined;
    fs.rmSync(file, { force: true });
    throw e;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  return true;
}

/** Text and a size/mtime/inode signature, read through one handle; both null when there is no file. */
function readWithSig(file) {
  let fd;
  try {
    fd = fs.openSync(file, "r");
  } catch (e) {
    if (e.code === "ENOENT") return { text: null, sig: null };
    throw e;
  }
  try {
    const sig = sigFromStat(fs.fstatSync(fd, { bigint: true }));
    const text = fs.readFileSync(fd, "utf8");
    // an empty file holds nothing to keep (a write killed right after create): merge as if new, then replace it
    return { text: text === "" ? null : text, sig };
  } finally {
    fs.closeSync(fd);
  }
}

function sigOf(file) {
  let fd;
  try {
    fd = fs.openSync(file, "r");
    return sigFromStat(fs.fstatSync(fd, { bigint: true }));
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

const sigFromStat = (b) => `${b.size}:${b.mtimeNs}:${b.ino}`;
