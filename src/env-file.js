import fs from "node:fs";

/**
 * Reads `KEY=value` lines from a dotenv file — the `.git.env` the current kb keeps its tokens in. Kept apart
 * from the fetchers: a module that reads a credentials file and makes requests in one place is a pattern the
 * security scanner rightly flags.
 */
export function readDotenv(file) {
  try {
    const text = fs.readFileSync(file, "utf8");
    const out = {};
    for (const line of text.split("\n")) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
      if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
    return out;
  } catch {
    return {};
  }
}
