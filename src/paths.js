import os from "node:os";
import path from "node:path";

/** Data dir: $AGENT_KB_HOME, else the OS convention. */
export function dataDir(env = process.env, platform = process.platform, home = os.homedir()) {
  if (env.AGENT_KB_HOME) return env.AGENT_KB_HOME;
  if (platform === "darwin") return path.join(home, "Library", "Application Support", "agent-kb");
  if (platform === "win32") return path.join(env.LOCALAPPDATA || path.join(home, "AppData", "Local"), "agent-kb");
  return path.join(env.XDG_DATA_HOME || path.join(home, ".local", "share"), "agent-kb");
}

export function dbPath(env = process.env) {
  return path.join(dataDir(env), "kb.sqlite");
}
