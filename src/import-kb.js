import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { redact } from "./redact.js";

/**
 * Import the current kb's database (`~/.claude/kb.sqlite`) into this store. One way, read-only on the
 * source: the old file is opened `?mode=ro` and never written.
 *
 * Why it exists: 23k documents of history live there — session summaries, memory notes, Jira tickets, PRs,
 * Confluence pages — plus the conflict flags that make the `⚠` demotion work. Until this runs, agent-kb
 * answers from what it captured itself.
 */

// The current kb's tier taxonomy, for rows written before it had a tier column.
const EPISODIC = new Set(["session_summary", "session_precompact", "daily_note", "news", "worklog_draft", "pr_body", "jira_ticket", "session_skip"]);
const PROCEDURAL = new Set(["memory", "custom_skill", "custom_command", "custom_agent", "hook", "plan", "scheduled_task", "template", "session_friction"]);

export const tierOf = (sourceType, existing) => (existing || (PROCEDURAL.has(sourceType) ? "procedural" : EPISODIC.has(sourceType) ? "episodic" : "semantic"));

/** First heading after front-matter, else its `name:`/`title:`, else the first line that is not a rule, else the file name. */
export function titleOf(content, sourcePath) {
  const text = String(content ?? "");
  const fm = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  const body = fm ? text.slice(fm[0].length) : text;
  const h = /^#[ \t]+(.+)$/m.exec(body);
  if (h?.[1].trim()) return h[1].trim().slice(0, 120);
  const named = fm && /^(?:name|title):[ \t]*["']?([^"'\r\n]+?)["']?[ \t]*$/m.exec(fm[1]);
  if (named?.[1].trim()) return named[1].trim().slice(0, 120);
  const head = body.split(/\r?\n/).find((l) => l.trim() && !/^[ \t]*([-*_])(?:[ \t]*\1){2,}[ \t]*$/.test(l));
  if (head) return head.trim().slice(0, 120);
  return path.basename(sourcePath).slice(0, 120);
}

// The old store kept seconds; this one keeps milliseconds. Anything below 1e11 ms is before 1973.
const toMs = (ts) => (typeof ts === "number" && ts > 0 && ts < 1e11 ? ts * 1000 : ts);

/**
 * Copies every document (and, with `conflicts`, every non-dismissed conflict flag) into `db`.
 * Rows whose `source_path` already exists are skipped unless `replace`. Returns counts.
 */
export function importKb(db, oldPath, { replace = false, conflicts = true, now = Date.now(), limit = Infinity } = {}) {
  const old = new DatabaseSync(oldPath, { readOnly: true });
  const counts = { docs: 0, skipped: 0, repaired: 0, conflicts: 0, failed: 0 };
  const has = db.prepare("SELECT event_ts FROM documents WHERE source_path = ?");
  // a row 0.2.0 imported in seconds, with a front-matter `---` title: fix both, leave the rest of the row alone
  const fix = db.prepare("UPDATE documents SET event_ts = ?, title = CASE WHEN title = '---' THEN ? ELSE title END WHERE source_path = ?");
  const put = db.prepare(
    `INSERT INTO documents (source_path, source_type, tier, title, content, event_ts, indexed_ts, resume_cmd)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
     ON CONFLICT(source_path) DO UPDATE SET source_type = excluded.source_type, tier = excluded.tier,
       title = excluded.title, content = excluded.content, event_ts = excluded.event_ts,
       indexed_ts = max(excluded.indexed_ts, documents.indexed_ts + 1)`,
  );
  try {
    const rows = old
      .prepare("SELECT source_path, source_type, content, tier, coalesce(event_ts, last_indexed) AS ts FROM documents")
      .all();
    for (const r of rows.slice(0, limit === Infinity ? undefined : limit)) {
      if (typeof r.source_path !== "string" || typeof r.content !== "string") {
        counts.failed++;
        continue;
      }
      // a transcript doc the new store already has is newer and better: leave it
      const here = replace ? null : has.get(r.source_path);
      if (here) {
        if (typeof here.event_ts === "number" && here.event_ts > 0 && here.event_ts < 1e11) {
          try {
            fix.run(here.event_ts * 1000, titleOf(redact(r.content).text, r.source_path), r.source_path);
            counts.repaired++;
          } catch {
            counts.failed++;
          }
        } else counts.skipped++;
        continue;
      }
      try {
        // row may have been written under older redaction rules: clean it before it becomes searchable here
        const content = redact(r.content).text;
        put.run(r.source_path, r.source_type, tierOf(r.source_type, r.tier), titleOf(content, r.source_path), content, toMs(r.ts) ?? null, now);
        counts.docs++;
      } catch {
        counts.failed++;
      }
    }
  } finally {
    old.close();
  }
  if (conflicts) counts.conflicts = importConflicts(db, oldPath, now);
  return counts;
}

/** Copies the old `kb_conflicts` rows as confirmed conflict judgments, which is what demotes a stale note. */
function importConflicts(db, oldPath, now) {
  let old;
  try {
    old = new DatabaseSync(oldPath, { readOnly: true });
    const rows = old.prepare("SELECT loser_path, winner_path, relation, status FROM kb_conflicts WHERE status != 'dismissed'").all();
    const seen = db.prepare("SELECT 1 FROM judgments WHERE point = 'conflict' AND docs = ?");
    const put = db.prepare(
      "INSERT INTO judgments (point, docs, backend, score, label, reason, ts, truth, acted) VALUES ('conflict', ?, 'imported', 1.0, 'contradict', ?, ?, 'yes', 1)",
    );
    let n = 0;
    for (const r of rows) {
      const pair = [r.loser_path, r.winner_path].sort();
      if (seen.get(JSON.stringify(pair))) continue;
      put.run(JSON.stringify(pair), `imported ${r.relation ?? "contradicts"} (${r.status})`, now);
      n++;
    }
    return n;
  } catch {
    return 0; // no kb_conflicts table, or unreadable: the import still succeeded for documents
  } finally {
    try {
      old?.close();
    } catch {}
  }
}

/** Default source: the current kb's database, if it is there. */
export const oldKbPath = (env = process.env, home = os.homedir()) => env.AGENT_KB_OLD_DB || path.join(home, ".claude", "kb.sqlite");

export const oldKbExists = (file) => fs.statSync(file, { throwIfNoEntry: false })?.isFile() ?? false;
