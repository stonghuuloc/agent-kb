import fs from "node:fs";
import { upsertDoc } from "./store.js";
import { redact } from "./redact.js";
import { SOURCE_TYPE, readSession, resumeCmd } from "./adapters/claude-code.js";

const MAX_CHARS = 32_000;

/** Head and tail of long text: a session's goal is at the start, its outcome at the end. */
function clip(text, max = MAX_CHARS) {
  if (text.length <= max) return text;
  const head = Math.floor(max * 0.75);
  return `${text.slice(0, head)}\n…\n${text.slice(text.length - (max - head))}`;
}

/** Fallback title: the first prompt without markup (<teammate-message …>), one line. */
const firstLine = (p) => p.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);

/**
 * Tier 0: every transcript on disk becomes a searchable, resumable doc of its title and the
 * user's own prompts. No model call. Unchanged files (same size and mtime) are skipped.
 */
export async function backfillTier0(db, transcripts) {
  const getScan = db.prepare("SELECT size, mtime_ms FROM scans WHERE source_path = ?");
  const setScan = db.prepare(
    `INSERT INTO scans (source_path, size, mtime_ms) VALUES (?, ?, ?)
     ON CONFLICT(source_path) DO UPDATE SET size = excluded.size, mtime_ms = excluded.mtime_ms`,
  );
  const counts = { indexed: 0, unchanged: 0, empty: 0, failed: 0 };
  for (const { file, configDir, unreadable } of transcripts) {
    if (unreadable) {
      counts.failed++;
      continue;
    }
    try {
      const st = fs.statSync(file);
      const mtime = Math.trunc(st.mtimeMs);
      const cur = getScan.get(file);
      if (cur && cur.size === st.size && cur.mtime_ms === mtime) {
        counts.unchanged++;
        continue;
      }
      const s = await readSession(file);
      if (s.prompts.length) {
        upsertDoc(db, {
          source_path: file,
          source_type: SOURCE_TYPE,
          tier: "episodic",
          title: s.title ?? firstLine(redact(s.prompts[0]).text),
          // Redact before clipping: a cut inside a secret would leave a fragment no rule recognises.
          content: clip(redact(s.prompts.join("\n\n")).text),
          event_ts: s.lastActivity ?? mtime,
          resume_cmd: resumeCmd(s, configDir),
        });
        counts.indexed++;
      } else counts.empty++;
      setScan.run(file, st.size, mtime);
    } catch {
      counts.failed++; // vanished or unreadable mid-scan; the next run retries it
    }
  }
  return counts;
}
