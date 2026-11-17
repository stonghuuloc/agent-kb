import { fold, tokenCount } from "./store.js";

const DAY_MS = 86_400_000;

export const DEFAULTS = { limit: 10, pool: 50, rrfK: 60, halfLifeDays: 90, perTypeCap: 3, titleBoost: 1.25, anyTerm: false };
// Additive on the RRF score, the same band as the project bonus: a rule the user wrote outranks a fact
// learned and a fact outranks an event. Values mirror the current kb's inject hooks.
export const TIER_BONUS = { procedural: 0.05, semantic: 0.02, episodic: 0 };
// A note a conflict judgment flagged is demoted — age decay handles old, this handles wrong.
export const CONFLICT_PENALTY = { confirmed: 0.4, proposed: 0.7 };

const EDGE_PUNCT = /^[\p{Ps}\p{Pi}\p{Pf}¿¡'"`]+|[\p{Pe}\p{Pf}\p{Pi}\p{Sentence_Terminal}¡¿,;:…—–'"`，、；：]+$/gu;

const tokens = (raw) => String(raw).split(/\s+/).map((t) => t.replaceAll('"', "")).filter(Boolean);

/**
 * User text → FTS5 MATCH expression. Every token becomes a quoted phrase, so FTS
 * operators (AND, NOT, *) are literal. The tokenizer still splits some tokens
 * (PROJ-123 → "proj 123", हिंदी → "ह द") or drops punctuation (C# → "c"); search()
 * requires those tokens verbatim (case- and Latin-diacritic-insensitive).
 * Tokens are implicitly ANDed, unless `or` asks for any of them.
 */
export function ftsQuery(raw, { or = false } = {}) {
  return tokens(raw).map((t) => `"${t}"`).join(or ? " OR " : " ");
}

/**
 * Notes a conflict judgment flagged, `path -> {status, other}`, dismissed ones left out. A note with a
 * confirmed flag keeps it over a proposal. Reads only what `judge.js` logged; no model call.
 */
export function conflictFlags(db) {
  const map = new Map();
  let rows;
  try {
    rows = db.prepare("SELECT docs, truth FROM judgments WHERE point = 'conflict' AND (truth IS NULL OR truth = 'yes')").all();
  } catch {
    return map; // an older store without the judgments table
  }
  for (const r of rows) {
    let pair;
    try {
      pair = JSON.parse(r.docs);
    } catch {
      continue;
    }
    if (!Array.isArray(pair) || pair.length !== 2) continue;
    const status = r.truth === "yes" ? "confirmed" : "proposed";
    pair.forEach((path, i) => {
      const cur = map.get(path);
      if (!cur || (cur.status !== "confirmed" && status === "confirmed")) map.set(path, { status, other: pair[1 - i] });
    });
  }
  return map;
}

/** The doc a flagged note gives way to: the later of the pair, named for the ⚠ line. Null when the hit is the later one. */
function supersededBy(db, hit, otherPath) {
  const other = db.prepare("SELECT title, coalesce(event_ts, indexed_ts) AS ts FROM documents WHERE source_path = ?").get(otherPath);
  if (!other || other.ts <= hit.ts) return null;
  return { path: otherPath, title: other.title ?? otherPath };
}

/**
 * Hybrid search: FTS5 bm25 pool, fused with recency by reciprocal rank (RRF), a tier bonus, a title
 * boost, episodic docs decayed by age, notes a conflict judgment flagged demoted. Up to `perTypeCap`
 * hits per source_type first; remaining slots back-filled by score.
 */
export function search(db, raw, opts = {}, now = Date.now()) {
  const given = Object.fromEntries(Object.entries(opts).filter(([, v]) => v !== undefined));
  const o = { ...DEFAULTS, ...given };
  const match = ftsQuery(raw, { or: o.anyTerm });
  if (!match) return [];
  // Runs in SQL before LIMIT, so split-phrase decoys can't crowd verbatim hits out of the pool.
  // Split by the tokenizer (PROJ-123, हिंदी), dropped by it (™), or carrying punctuation it drops (C#, .NET, "-").
  // Edge sentence punctuation ("errors.", "(timeout)") is trimmed first so plain words keep stemming.
  // an OR query is deliberately loose: one odd token would otherwise drop every hit. Recall measures
  // coverage of the terms instead.
  const verbatim = (o.anyTerm ? [] : tokens(raw))
    .map((t) => t.replace(EDGE_PUNCT, ""))
    .filter((t) => t && (/[^\p{L}\p{N}\p{M}]/u.test(fold(t)) || tokenCount(db, t) !== 1))
    .map(fold);
  const verbatimSql = verbatim
    .map(() => "AND instr(kb_fold(coalesce(d.title, '') || char(10) || d.content), ?) > 0")
    .join(" ");

  const pool = db
    .prepare(
      `SELECT d.source_path, d.source_type, d.tier, d.title, d.event_ts, d.indexed_ts, d.resume_cmd, d.transcript_gone,
              snippet(chunks_fts, 1, '«', '»', '…', 18) AS snippet,
              bm25(chunks_fts, 1.0, 0.0) < 0 AS title_hit
       FROM chunks_fts JOIN documents d ON d.id = chunks_fts.rowid
       WHERE chunks_fts MATCH ? ${verbatimSql}
       ORDER BY bm25(chunks_fts, 2.0, 1.0)
       LIMIT ?`,
    )
    .all(match, ...verbatim, o.pool)
    .map((r, i) => ({ ...r, rFts: i + 1, ts: r.event_ts ?? r.indexed_ts }));

  [...pool].sort((a, b) => b.ts - a.ts).forEach((r, i) => (r.rRec = i + 1));

  const flags = conflictFlags(db);
  for (const r of pool) {
    const ageDays = Math.max(0, (now - r.ts) / DAY_MS);
    const decay = r.tier === "episodic" ? o.halfLifeDays / (o.halfLifeDays + ageDays) : 1;
    const boost = r.title_hit ? o.titleBoost : 1;
    let score = (1 / (o.rrfK + r.rFts) + 1 / (o.rrfK + r.rRec)) * decay * boost + (TIER_BONUS[r.tier] ?? 0);
    const flag = flags.get(r.source_path);
    const winner = flag && supersededBy(db, r, flag.other);
    if (winner) {
      score *= CONFLICT_PENALTY[flag.status];
      r.conflict = { status: flag.status, ...winner };
    }
    r.score = score;
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
