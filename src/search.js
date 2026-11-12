const DAY_MS = 86_400_000;

export const DEFAULTS = { limit: 10, pool: 50, rrfK: 60, halfLifeDays: 90, perTypeCap: 3, titleBoost: 1.25 };

const tokens = (raw) => String(raw).split(/\s+/).map((t) => t.replaceAll('"', "")).filter(Boolean);

/**
 * User text → FTS5 MATCH expression. Every token becomes a quoted phrase, so FTS
 * operators (AND, NOT, *) are literal. The tokenizer still splits punctuation
 * (PROJ-123 → "proj 123"); search() adds a verbatim check for those tokens.
 * Tokens are implicitly ANDed.
 */
export function ftsQuery(raw) {
  return tokens(raw).map((t) => `"${t}"`).join(" ");
}

/**
 * Hybrid search: FTS5 bm25 pool, fused with recency by reciprocal rank (RRF),
 * boosted when the title matches, episodic docs decayed by age. Up to
 * `perTypeCap` hits per source_type first; remaining slots back-filled by score.
 */
export function search(db, raw, opts = {}, now = Date.now()) {
  const given = Object.fromEntries(Object.entries(opts).filter(([, v]) => v !== undefined));
  const o = { ...DEFAULTS, ...given };
  const match = ftsQuery(raw);
  if (!match) return [];
  const verbatim = tokens(raw).filter((t) => /[^\p{L}\p{N}_]/u.test(t)).map((t) => t.toLowerCase());

  const pool = db
    .prepare(
      `SELECT d.source_path, d.source_type, d.tier, d.title, d.content, d.event_ts, d.indexed_ts, d.resume_cmd,
              snippet(chunks_fts, 1, '«', '»', '…', 18) AS snippet,
              bm25(chunks_fts, 1.0, 0.0) < 0 AS title_hit
       FROM chunks_fts JOIN documents d ON d.id = chunks_fts.rowid
       WHERE chunks_fts MATCH ?
       ORDER BY bm25(chunks_fts, 2.0, 1.0)
       LIMIT ?`,
    )
    .all(match, o.pool)
    .filter((r) => {
      if (!verbatim.length) return true;
      const hay = `${r.title ?? ""}\n${r.content}`.toLowerCase();
      return verbatim.every((t) => hay.includes(t));
    })
    .map((r, i) => ({ ...r, rFts: i + 1, ts: r.event_ts ?? r.indexed_ts }));

  [...pool].sort((a, b) => b.ts - a.ts).forEach((r, i) => (r.rRec = i + 1));

  for (const r of pool) {
    const ageDays = Math.max(0, (now - r.ts) / DAY_MS);
    const decay = r.tier === "episodic" ? o.halfLifeDays / (o.halfLifeDays + ageDays) : 1;
    const boost = r.title_hit ? o.titleBoost : 1;
    r.score = (1 / (o.rrfK + r.rFts) + 1 / (o.rrfK + r.rRec)) * decay * boost;
  }

  const ranked = pool.sort((a, b) => b.score - a.score);
  const perType = new Map();
  const diverse = [];
  const rest = [];
  for (const r of ranked) {
    const n = perType.get(r.source_type) ?? 0;
    if (n < o.perTypeCap) {
      perType.set(r.source_type, n + 1);
      diverse.push(r);
    } else rest.push(r);
  }
  return [...diverse, ...rest].slice(0, o.limit);
}
