import { COWORK } from "./adapters/claude-code.js";

/** What to do to get back into a hit's session; "" when nothing applies. */
export function resumeHint(h) {
  if (h.transcript_gone) return "transcript deleted by the host app";
  if (h.resume_cmd) return h.resume_cmd;
  return h.source_type === COWORK ? "open it in Claude Desktop (Cowork)" : "";
}

export function formatHits(hits) {
  if (!hits.length) return "No matches.";
  return hits
    .map((h) => {
      const when = new Date(h.ts).toISOString().slice(0, 10);
      const head = `── [${h.tier}/${h.source_type}] ${h.title ?? h.source_path} (${when})\n   path: ${h.source_path}`;
      const hint = resumeHint(h);
      const resume = hint ? `\n   resume: ${hint}` : "";
      return `${head}\n   ${h.snippet.replace(/\s+/g, " ")}${resume}`;
    })
    .join("\n");
}

/** Cut to at most `max` UTF-16 units without splitting a surrogate pair. */
export function truncate(s, max) {
  if (s.length <= max) return s;
  const cut = /[\uD800-\uDBFF]/.test(s[max - 1]) ? max - 1 : max;
  return `${s.slice(0, cut)}\n…[truncated]`;
}
