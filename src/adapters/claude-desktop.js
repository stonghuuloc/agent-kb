import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Claude Desktop's data dir: AGENT_KB_DESKTOP_DIR, else the per-OS default. */
export function desktopDir(env = process.env, platform = process.platform, home = os.homedir()) {
  if (env.AGENT_KB_DESKTOP_DIR) return path.resolve(env.AGENT_KB_DESKTOP_DIR);
  if (platform === "darwin") return path.join(home, "Library", "Application Support", "Claude");
  if (platform === "win32") return path.join(env.APPDATA || path.join(home, "AppData", "Roaming"), "Claude");
  return path.join(env.XDG_CONFIG_HOME || path.join(home, ".config"), "Claude");
}

/**
 * Titles of Desktop Code-tab sessions by CLI session id. The Code tab writes a normal CLI transcript
 * (no title in it); its title lives in `claude-code-sessions/<account>/<org>/local_<id>.json`.
 * A missing dir means no Desktop: an empty map. Unreadable or malformed files are skipped.
 */
export function desktopTitles(dir) {
  const titles = new Map();
  const root = path.join(dir, "claude-code-sessions");
  for (const file of walk(root, 2)) {
    if (!/^local_[\w-]+\.json$/.test(path.basename(file))) continue;
    try {
      const m = JSON.parse(fs.readFileSync(file, "utf8"));
      if (typeof m?.cliSessionId === "string" && typeof m.title === "string" && m.title.trim()) titles.set(m.cliSessionId, m.title.trim());
    } catch {
      // written right now, or not ours
    }
  }
  return titles;
}

/** Files exactly `depth` dirs below `root`. */
function walk(root, depth) {
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.flatMap((e) => {
    const p = path.join(root, e.name);
    if (depth === 0) return e.isFile() ? [p] : [];
    return e.isDirectory() ? walk(p, depth - 1) : [];
  });
}

/** Adds `title` from Desktop to each transcript of a Code-tab session (file name = CLI session id). */
export function withDesktopTitles(transcripts, titles) {
  if (!titles.size) return transcripts;
  return transcripts.map((t) => {
    const title = t.unreadable ? null : titles.get(path.basename(t.file, ".jsonl"));
    return title ? { ...t, title } : t;
  });
}
