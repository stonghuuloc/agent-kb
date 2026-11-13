import { redact } from "./redact.js";

export const POINTS = ["triage", "conflict", "kind"];
// Principle 8: a point acts only at AUC >= 0.85 on the user's own corrections.
export const AUC_GATE = 0.85;
// 30 labels put the AUC's standard error near 0.07 at 0.85; 8 per class keeps either class from being noise.
export const MIN_LABELLED = 30;
export const MIN_PER_CLASS = 8;

/** Area under the ROC curve (Mann-Whitney U, ties count half). `rows`: [{score, positive}]. null when a class is empty. */
export function auc(rows) {
  const pos = rows.filter((r) => r.positive).length;
  const neg = rows.length - pos;
  if (!pos || !neg) return null;
  const sorted = [...rows].sort((a, b) => a.score - b.score);
  let rankSum = 0;
  for (let i = 0; i < sorted.length; ) {
    let j = i;
    while (j < sorted.length && sorted[j].score === sorted[i].score) j++;
    const avg = (i + 1 + j) / 2; // ranks i+1..j, tied scores share their mean
    for (let k = i; k < j; k++) if (sorted[k].positive) rankSum += avg;
    i = j;
  }
  return (rankSum - (pos * (pos + 1)) / 2) / (pos * neg);
}

/** One verdict per (point, backend): AUC on corrected judgments, and whether the gate is open. */
export function evaluate(db) {
  const rows = db.prepare("SELECT point, backend, score, truth FROM judgments").all();
  const groups = new Map();
  for (const r of rows) {
    const k = `${r.point}\0${r.backend}`;
    if (!groups.has(k)) groups.set(k, { point: r.point, backend: r.backend, rows: [], logged: 0 });
    const g = groups.get(k);
    g.logged++;
    if (r.truth) g.rows.push({ score: r.score, positive: r.truth === "yes" });
  }
  return [...groups.values()]
    .map(({ point, backend, rows: g, logged }) => {
      const pos = g.filter((r) => r.positive).length;
      const neg = g.length - pos;
      const a = auc(g);
      let reason = null;
      if (g.length < MIN_LABELLED) reason = `needs ${MIN_LABELLED} labelled judgments, has ${g.length}`;
      else if (pos < MIN_PER_CLASS || neg < MIN_PER_CLASS) reason = `needs ${MIN_PER_CLASS} of each answer, has ${pos} yes / ${neg} no`;
      else if (a < AUC_GATE) reason = `AUC ${a.toFixed(3)} is below ${AUC_GATE}`;
      return { point, backend, logged, n: g.length, pos, neg, auc: a, enabled: reason === null, reason };
    })
    .sort((x, y) => POINTS.indexOf(x.point) - POINTS.indexOf(y.point) || x.backend.localeCompare(y.backend));
}

/** Points that may act for `backend`; the rest only log. */
export function openGates(db, backend) {
  return new Set(evaluate(db).filter((v) => v.backend === backend && v.enabled).map((v) => v.point));
}

export function logJudgment(db, { point, docs, backend, score, label, reason = null, acted = false, sliceStart = null, sliceEnd = null, sliceHash = null, docsHash = null }, now = Date.now()) {
  const r = db
    .prepare(
      `INSERT INTO judgments (point, docs, backend, score, label, reason, ts, acted, slice_start, slice_end, slice_hash, docs_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(point, JSON.stringify(docs), backend, score, label, reason == null ? null : redact(reason).text, now, acted ? 1 : 0, sliceStart, sliceEnd, sliceHash, docsHash);
  return Number(r.lastInsertRowid);
}

/** Records the user's answer to judgment `id`; false when there is no such judgment. */
export function setTruth(db, id, truth, now = Date.now()) {
  return db.prepare("UPDATE judgments SET truth = ?, truth_ts = ? WHERE id = ?").run(truth, now, id).changes === 1;
}

/**
 * A skipped session was worth keeping: answers yes on every still-unanswered triage skip of this transcript or slice.
 * Returns the ids; `queued` are the ones whose slice was skipped (acted), so the next sweep summarizes them. The rest were summarized anyway.
 */
export function pin(db, docPath) {
  const transcript = docPath.replace(/#w\d+$/, "");
  const rows = db
    .prepare("SELECT id, docs, acted FROM judgments WHERE point = 'triage' AND label = 'skip' AND truth IS NULL")
    .all()
    .filter((r) => JSON.parse(r.docs).includes(transcript));
  for (const r of rows) setTruth(db, r.id, "yes");
  return { ids: rows.map((r) => r.id), queued: rows.filter((r) => r.acted).map((r) => r.id) };
}

/** Dismisses a conflict flag: the two notes do not contradict. */
export function dismiss(db, id) {
  const j = db.prepare("SELECT point FROM judgments WHERE id = ?").get(id);
  if (j?.point !== "conflict") return false;
  return setTruth(db, id, "no");
}

export function listJudgments(db, { point = null, open = false, limit = 50 } = {}) {
  return db
    .prepare(
      `SELECT * FROM judgments WHERE (? IS NULL OR point = ?) AND (? = 0 OR truth IS NULL)
       ORDER BY id DESC LIMIT ?`,
    )
    .all(point, point, open ? 1 : 0, limit)
    .map((r) => ({ ...r, docs: JSON.parse(r.docs) }));
}
