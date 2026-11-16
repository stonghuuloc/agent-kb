import path from "node:path";

/**
 * The entity layer over the kb: tickets, PRs, repos and Confluence pages, and the edges between them.
 * The current kb calls this `kb-graph.py`. Zero model calls — entities come from regexes over doc text
 * plus `source_path` parsing, so it is cheap and repeatable.
 *
 * Why: full-text recall cannot traverse. "CH-45866 → its PRs → sibling tickets → repo" is a join, and
 * once it exists the concept notes (S5) and the conflicts scan (S6) are renders of it.
 */

// Jira project keys and repo names seen in free text. Data-derived names are unioned in at build time;
// these are the ones a doc may mention before any ticket or PR doc exists.
export const STATIC_KEYS = ["CH", "AMP", "AEU", "GMS", "INFRAD", "PPI", "MM", "PRODSUPP", "AURA"];
export const STATIC_REPOS = ["Policies", "quotation", "frontend-monorepo", "Premium", "Products", "ChannelManagement", "saas-data-migrations", "k8s-saas", "CoverHealth-Portal-member", "CoverHealth-Portal-hr", "Auth", "Users", "Reference", "ProductBuilder"];
// Admin/calendar projects are not engineering work: they appear in every daily log and become false hubs.
export const NOISE_KEYS = new Set(["AC"]);
// Date-bucketed doc types: their tickets share a day, not a topic, so they emit no pairwise edges.
export const EDGE_EXCLUDE_TYPES = new Set(["daily_note", "worklog_draft", "news", "vault_doc", "template", "obsidian"]);
// A doc naming more entities than this is a listing page: mentions stay, pairwise edges would be noise.
export const FANOUT_CAP = 10;

const REL = {
  "pr|ticket": "implemented_by",
  "repo|ticket": "touches",
  "confluence|ticket": "documented_in",
  "ticket|ticket": "related",
  "pr|repo": "in_repo",
  "pr|pr": "co_pr",
  "confluence|repo": "repo_doc",
};

export const etype = (id) => id.split(":", 1)[0];
export const relFor = (a, b) => REL[[etype(a), etype(b)].sort().join("|")] ?? "linked";

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Regexes for the entity kinds, from the static lists plus what the kb already holds. */
export function patterns(db, { keys = STATIC_KEYS, repos = STATIC_REPOS } = {}) {
  const allKeys = new Set(keys);
  const allRepos = new Set(repos);
  for (const { source_path: sp } of db.prepare("SELECT source_path FROM documents WHERE source_type = 'jira_ticket'").all()) {
    const m = /^jira:([A-Z]{2,6})-\d+/.exec(sp);
    if (m) allKeys.add(m[1]);
  }
  for (const { source_path: sp } of db.prepare("SELECT source_path FROM documents WHERE source_type = 'pr_body'").all()) {
    const m = /^pr:CoverGo\/([^#]+)#/.exec(sp);
    if (m) allRepos.add(m[1]);
  }
  const byLen = (a, b) => b.length - a.length;
  return {
    ticket: new RegExp(`\\b(${[...allKeys].sort(byLen).map(escape).join("|")})-(\\d{1,6})\\b`, "g"),
    pr: new RegExp(`\\b(?:CoverGo/)?(${[...allRepos].sort(byLen).map(escape).join("|")})#(\\d{1,6})\\b`, "g"),
    confluence: /(?:confluence:|confluence:|wiki:|\/wiki\/spaces\/)([A-Za-z0-9]+)[:/](?:pages\/)?(\d{4,})/g,
    repos: allRepos,
  };
}

const REPO_PATH = /(?:Backend-Services-|Frontend-|Backend\/Services\/|Frontend\/|backend\/|frontend\/)([A-Za-z0-9_.-]+?)(?:$|[/-](?:src|docs|libs|apps|\.claude))/;

/** The repo a doc belongs to, from its path (structural, never free text: "Policies" is also a word). */
export function repoOf(doc, repos) {
  const cand = doc.kind ?? "";
  for (const r of repos) if (cand === r || cand.endsWith("/" + r) || cand.endsWith("-" + r)) return r;
  for (const hay of [cand, doc.source_path]) {
    const m = REPO_PATH.exec(hay ?? "");
    if (m && repos.has(m[1])) return m[1];
  }
  if (repos.has(path.basename(path.dirname(doc.source_path ?? "")))) return path.basename(path.dirname(doc.source_path));
  return null;
}

/** A doc that IS a ticket / PR / page names itself. Weighted higher than a mention. */
export function selfEntity(sourcePath) {
  const jira = /^jira:([A-Z]{2,6}-\d+)/.exec(sourcePath);
  if (jira) return `ticket:${jira[1]}`;
  const pr = /^pr:(.+#\d+)/.exec(sourcePath);
  if (pr) return `pr:${pr[1]}`;
  const conf = /^confluence:([^/]+\/\d+)/.exec(sourcePath);
  if (conf) return `confluence:${conf[1]}`;
  return null;
}

/** Entity id → mention count for one doc. */
export function extract(doc, pats) {
  const found = new Map();
  const bump = (id, n) => found.set(id, (found.get(id) ?? 0) + n);
  const self = selfEntity(doc.source_path);
  if (self) bump(self, 3);
  const text = doc.content ?? "";
  for (const m of text.matchAll(pats.ticket)) if (!NOISE_KEYS.has(m[1])) bump(`ticket:${m[1]}-${m[2]}`, 1);
  for (const m of text.matchAll(pats.pr)) bump(`pr:CoverGo/${m[1]}#${m[2]}`, 1);
  for (const m of text.matchAll(pats.confluence)) bump(`confluence:${m[1]}/${m[2]}`, 1);
  const repo = repoOf(doc, pats.repos);
  if (repo) bump(`repo:${repo}`, 2);
  return found;
}

/**
 * Rebuilds the entity tables from `documents`. Idempotent: it clears and re-derives, because a doc's
 * entities depend on its whole text, not on a delta.
 */
export function buildGraph(db, { keys = STATIC_KEYS, repos = STATIC_REPOS } = {}) {
  const pats = patterns(db, { keys, repos });
  const docs = db.prepare("SELECT source_path, source_type, content, coalesce(event_ts, indexed_ts) AS ts FROM documents").all();
  const entities = new Map();
  const mentions = new Map();
  const entities_ts = new Map();
  const edges = new Map();
  for (const doc of docs) {
    const ents = extract(doc, pats);
    if (!ents.size) continue;
    for (const [id, cnt] of ents) {
      mentions.set(`${doc.source_path}\u0000${id}`, { source_path: doc.source_path, entity_id: id, cnt });
      entities.set(id, (entities.get(id) ?? 0) + 1);
      entities_ts.set(id, Math.max(entities_ts.get(id) ?? 0, doc.ts ?? 0));
    }
    const ids = [...ents.keys()].sort();
    if (EDGE_EXCLUDE_TYPES.has(doc.source_type) || ids.length > FANOUT_CAP) continue;
    for (let i = 0; i < ids.length; i++)
      for (let j = i + 1; j < ids.length; j++) {
        const key = `${ids[i]}\u0000${ids[j]}`;
        edges.set(key, (edges.get(key) ?? 0) + Math.min(ents.get(ids[i]), ents.get(ids[j])));
      }
  }
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec("DELETE FROM kb_entities; DELETE FROM kb_doc_entities; DELETE FROM kb_edges;");
    const ent = db.prepare("INSERT INTO kb_entities (id, etype, label, ndocs, last_ts) VALUES (?, ?, ?, ?, ?)");
    for (const [id, n] of entities) ent.run(id, etype(id), id.slice(id.indexOf(":") + 1), n, entities_ts.get(id) ?? 0);
    const ment = db.prepare("INSERT OR REPLACE INTO kb_doc_entities (source_path, entity_id, cnt) VALUES (?, ?, ?)");
    for (const m of mentions.values()) ment.run(m.source_path, m.entity_id, m.cnt);
    const edge = db.prepare("INSERT OR REPLACE INTO kb_edges (a, b, rel, weight) VALUES (?, ?, ?, ?)");
    for (const [key, w] of edges) {
      const [a, b] = key.split("\u0000");
      edge.run(a, b, relFor(a, b), w);
    }
    db.exec("COMMIT");
  } catch (e) {
    if (db.isTransaction) db.exec("ROLLBACK");
    throw e;
  }
  return { docs: docs.length, entities: entities.size, mentions: mentions.size, edges: edges.size };
}

/** `CH-58201` → `ticket:CH-58201`, `Policies` → `repo:Policies`, or an exact id. Null when unknown. */
export function resolveEntity(db, ref) {
  const raw = String(ref ?? "").trim();
  if (!raw) return null;
  const has = (id) => db.prepare("SELECT 1 FROM kb_entities WHERE id = ?").get(id) !== undefined;
  if (raw.includes(":") && has(raw)) return raw;
  if (/^[A-Za-z]{2,6}-\d+$/.test(raw)) {
    const id = `ticket:${raw.toUpperCase()}`;
    if (has(id)) return id;
  }
  for (const id of [`repo:${raw}`, `pr:${raw}`, `pr:CoverGo/${raw}`]) if (has(id)) return id;
  const like = db.prepare("SELECT id FROM kb_entities WHERE id LIKE ? ORDER BY ndocs DESC LIMIT 1").get(`%${raw}%`);
  return like?.id ?? null;
}

/** One entity: its neighbours by kind (weight-desc) and the docs about it. */
export function queryGraph(db, ref, { docs = 5 } = {}) {
  const id = resolveEntity(db, ref);
  if (!id) return null;
  const row = db.prepare("SELECT id, etype, label, ndocs, last_ts FROM kb_entities WHERE id = ?").get(id);
  const around = db
    .prepare(
      `SELECT a AS other, rel, weight FROM kb_edges WHERE b = ?
       UNION ALL SELECT b AS other, rel, weight FROM kb_edges WHERE a = ?
       ORDER BY weight DESC`,
    )
    .all(id, id);
  const neighbours = {};
  for (const e of around) (neighbours[etype(e.other)] ??= []).push({ id: e.other, label: e.other.slice(e.other.indexOf(":") + 1), rel: e.rel, weight: e.weight });
  const about = db
    .prepare(
      `SELECT d.source_path, d.source_type, d.title, d.tier FROM kb_doc_entities e JOIN documents d ON d.source_path = e.source_path
       WHERE e.entity_id = ? ORDER BY e.cnt DESC, coalesce(d.event_ts, d.indexed_ts) DESC LIMIT ?`,
    )
    .all(id, docs);
  return { ...row, neighbours, docs: about };
}

/** Shortest link between two entities, up to `maxHops`; null when nothing connects them. */
export function graphPath(db, fromRef, toRef, { maxHops = 3 } = {}) {
  const from = resolveEntity(db, fromRef);
  const to = resolveEntity(db, toRef);
  if (!from || !to) return null;
  if (from === to) return [from];
  let frontier = [from];
  const prev = new Map([[from, null]]);
  for (let hop = 0; hop < maxHops && frontier.length; hop++) {
    const next = [];
    const edges = db.prepare("SELECT a, b FROM kb_edges WHERE a = ? UNION ALL SELECT a, b FROM kb_edges WHERE b = ?");
    for (const node of frontier) {
      for (const { a, b } of edges.all(node, node)) {
        const other = a === node ? b : a;
        if (prev.has(other)) continue;
        prev.set(other, node);
        if (other === to) {
          const path = [to];
          for (let n = to; prev.get(n) != null; n = prev.get(n)) path.unshift(prev.get(n));
          return path;
        }
        next.push(other);
      }
    }
    frontier = next;
  }
  return null;
}

export function graphStats(db) {
  return {
    entities: db.prepare("SELECT etype, COUNT(*) AS n FROM kb_entities GROUP BY 1 ORDER BY n DESC").all(),
    edges: db.prepare("SELECT rel, COUNT(*) AS n, SUM(weight) AS w FROM kb_edges GROUP BY 1 ORDER BY n DESC").all(),
  };
}
