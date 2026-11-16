import fs from "node:fs";

/**
 * Rewrites a note the user may be editing at the same time (a vault file open in Obsidian), without losing
 * their save. The file is read through one handle; the new text goes to a temp file; just before the swap the
 * file is checked again, and if it changed since the read the merge is redone from the new text. A note that
 * did not exist is created exclusively (`wx`), which fails instead of replacing one that appeared meanwhile and,
 * unlike a hard link, works on exFAT/FAT and network mounts.
 *
 * `merge(text)` gets the current text (null when there is no file) and returns the new text, or null to leave
 * the file alone. Returns "written", "unchanged" or "conflict" (it kept changing for `tries` rounds).
 * `beforeSwap` is a test seam: it runs between the temp write and the re-check.
 */
export function replaceIfUnchanged(file, merge, { tries = 3, beforeSwap = null } = {}) {
  for (let i = 0; i < tries; i++) {
    const seen = readWithSig(file);
    const next = merge(seen.text);
    if (next === null) return "unchanged";
    if (seen.sig === null) {
      // no file at all: create it exclusively. (An empty file has a sig and is replaced below.)
      beforeSwap?.(i);
      if (createExclusive(file, next)) return "written";
      continue;
    }
    const tmp = `${file}.agent-kb-${process.pid}-${i}.tmp`;
    try {
      fs.writeFileSync(tmp, next);
      beforeSwap?.(i);
      if (sigOf(file) !== seen.sig) continue;
      try {
        fs.renameSync(tmp, file);
      } catch (e) {
        // an editor holding the note open refuses the swap (EBUSY anywhere, EPERM/EACCES on Windows): try
        // again, then report a conflict. Elsewhere EPERM/EACCES is a lasting permission problem: say so.
        if (e.code === "EBUSY" || (process.platform === "win32" && (e.code === "EPERM" || e.code === "EACCES"))) continue;
        throw e;
      }
      return "written";
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  }
  return "conflict";
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
