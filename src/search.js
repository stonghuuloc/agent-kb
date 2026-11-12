const DAY_MS = 86_400_000;

export const DEFAULTS = { limit: 10, pool: 50, rrfK: 60, halfLifeDays: 90, perTypeCap: 3 };

/**
 * User text → FTS5 MATCH expression. Every token becomes a quoted phrase, so
 * punctuation (CH-123, v1.2.3, file.py) and FTS operators (AND, NOT, *) are literal.
 * Tokens are implicitly ANDed.
 */
export function ftsQuery(raw) {
  const toks = String(raw).split(/\s+/).map((t) => t.replaceAll('"', "")).filter(Boolean);
  return toks.map((t) => `"${t}"`).join(" ");
}

/**
 * Hybrid search: FTS5 bm25 pool, fused with recency by reciprocal rank (RRF),
 * episodic docs decayed by age, at most `perTypeCap` hits per source_type.
 */
export function search(db, raw, opts = {}, now = Date.now()) {
  const o = { ...DEFAULTS, ...opts };
  const match = ftsQuery(raw);
  if (!match) return [];

  const pool = db
    .prepare(
      `SELECT d.source_path, d.source_type, d.tier, d.title, d.event_ts, d.indexed_ts, d.resume_cmd,
              snippet(chunks_fts, 1, '«', '»', '…', 18) AS snippet
       FROM chunks_fts JOIN documents d ON d.id = chunks_fts.rowid
       WHERE chunks_fts MATCH ?
       ORDER BY bm25(chunks_fts, 2.0, 1.0)
       LIMIT ?`,
    )
    .all(match, o.pool)
    .map((r, i) => ({ ...r, rFts: i + 1, ts: r.event_ts ?? r.indexed_ts }));

  [...pool].sort((a, b) => b.ts - a.ts).forEach((r, i) => (r.rRec = i + 1));

  for (const r of pool) {
    const ageDays = Math.max(0, (now - r.ts) / DAY_MS);
    const decay = r.tier === "episodic" ? o.halfLifeDays / (o.halfLifeDays + ageDays) : 1;
    r.score = (1 / (o.rrfK + r.rFts) + 1 / (o.rrfK + r.rRec)) * decay;
  }

  const perType = new Map();
  const out = [];
  for (const r of pool.sort((a, b) => b.score - a.score)) {
    const n = perType.get(r.source_type) ?? 0;
    if (n >= o.perTypeCap) continue;
    perType.set(r.source_type, n + 1);
    out.push(r);
    if (out.length >= o.limit) break;
  }
  return out;
}
