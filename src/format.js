export function formatHits(hits) {
  if (!hits.length) return "No matches.";
  return hits
    .map((h) => {
      const when = new Date(h.ts).toISOString().slice(0, 10);
      const head = `── [${h.tier}/${h.source_type}] ${h.title ?? h.source_path} (${when})\n   path: ${h.source_path}`;
      const resume = h.transcript_gone ? "\n   resume: transcript deleted by the host app" : h.resume_cmd ? `\n   resume: ${h.resume_cmd}` : "";
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
