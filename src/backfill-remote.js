import { clip } from "./text.js";
import { redact } from "./redact.js";
import { upsertDoc } from "./store.js";
import { MAX_CHARS } from "./backfill.js";

/**
 * The remote half of the kb: Jira tickets, GitHub PRs and Confluence pages the user worked on, fetched once
 * and refreshed incrementally. The current kb does this with `kb-jira-backfill.py`, `kb-github-backfill.py`
 * and `kb-confluence-backfill.py`, one document per item, so recall can answer from the ticket rather than
 * from a session that mentioned it.
 *
 * Every fetch is injectable: the tests run the whole pipeline against canned JSON, and nothing here needs a
 * network to be proven. Credentials come from the environment; the CLI can read them from a dotenv file.
 */

const UA = "agent-kb";

/** The Atlassian site the PAT is sent to. Only `https://<site>.atlassian.net`: a typo'd or planted base never gets the token. */
export function atlassianBase(raw) {
  let url;
  try {
    url = new URL(String(raw ?? ""));
  } catch {
    throw new Error("needs AGENT_KB_ATLASSIAN_BASE, e.g. https://your-site.atlassian.net");
  }
  if (url.protocol !== "https:" || !url.hostname.endsWith(".atlassian.net") || url.username || url.password || url.port)
    throw new Error(`AGENT_KB_ATLASSIAN_BASE must be https://<site>.atlassian.net, got ${url.origin}`);
  return url.origin;
}

/** `{"ENG": 123456}` (object or JSON text) → its entries, numeric ids only: an id goes into a URL path. */
function spaceEntries(spaces) {
  let parsed = spaces;
  if (typeof spaces === "string") {
    try {
      parsed = JSON.parse(spaces);
    } catch {
      throw new Error('AGENT_KB_CONFLUENCE_SPACES is not JSON, e.g. {"ENG": 123456}');
    }
  }
  const entries = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? Object.entries(parsed) : [];
  if (!entries.length) throw new Error('Confluence backfill needs AGENT_KB_CONFLUENCE_SPACES, e.g. {"ENG": 123456}');
  for (const [key, id] of entries) if (!/^\d+$/.test(String(id))) throw new Error(`bad Confluence space ${key}: ${id}`);
  return entries;
}

const ENTITIES = { nbsp: " ", lt: "<", gt: ">", quot: '"', "#39": "'", amp: "&" };
const BLOCK = /^\/?(p|div|li|h[1-6]|tr|blockquote|pre)$/;

/** Entities in one pass, never re-scanning what was inserted: `&amp;lt;` stays `&lt;`. */
function decodeEntities(text) {
  let out = "";
  let i = 0;
  for (;;) {
    const amp = text.indexOf("&", i);
    if (amp === -1) return out + text.slice(i);
    out += text.slice(i, amp);
    const semi = text.indexOf(";", amp);
    const name = semi !== -1 && semi - amp <= 5 ? text.slice(amp + 1, semi) : null;
    const rep = name === null ? undefined : ENTITIES[name];
    if (rep === undefined) {
      out += "&";
      i = amp + 1;
    } else {
      out += rep;
      i = semi + 1;
    }
  }
}

/** Drops a tag and everything up to its closing tag, then the closing tag itself. */
function dropElement(text, tag) {
  let out = text;
  for (;;) {
    const open = out.toLowerCase().indexOf(`<${tag}`);
    if (open === -1) return out;
    const close = out.toLowerCase().indexOf(`</${tag}`, open);
    if (close === -1) return out.slice(0, open);
    const end = out.indexOf(">", close);
    out = out.slice(0, open) + out.slice(end === -1 ? out.length : end + 1);
  }
}

/**
 * Plain text out of HTML: enough for storage and search, no dependency. Walks the string instead of running
 * regexes over markup — a regex that strips tags is exactly the kind that misses `</script >`.
 */
export function htmlToText(html) {
  let s = dropElement(dropElement(String(html ?? ""), "script"), "style");
  let out = "";
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== "<") {
      out += s[i];
      continue;
    }
    const close = s.indexOf(">", i);
    if (close === -1) break;
    const tag = s.slice(i + 1, close).trim().toLowerCase().split(/\s+/, 1)[0] ?? "";
    if (tag === "li") out += "\n- ";
    else if (tag === "br" || tag === "br/" || BLOCK.test(tag)) out += "\n";
    i = close;
  }
  return decodeEntities(out)
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Atlassian document-format (ADF) → text, for Jira description fields that are not rendered HTML. */
export function adfToText(node) {
  if (!node || typeof node !== "object") return "";
  if (node.type === "text") return node.text ?? "";
  const inner = (node.content ?? []).map(adfToText).join("");
  if (node.type === "paragraph" || node.type === "heading" || node.type === "listItem" || node.type === "codeBlock") return `${inner}\n`;
  if (node.type === "bulletList" || node.type === "orderedList") return `${inner}`;
  return inner;
}

const headers = (extra = {}) => ({ "user-agent": UA, accept: "application/json", ...extra });
const basic = (email, token) => `Basic ${Buffer.from(`${email}:${token}`).toString("base64")}`;

async function getJson(fetchImpl, url, init) {
  const res = await fetchImpl(url, init);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return res.json();
}

// ── GitHub ──────────────────────────────────────────────────────────────────

/**
 * PRs the account authored, newest first, with reviews, conversation and inline comments folded in.
 * Discovery is one search call; each PR costs three more (its object, its comments, its reviews).
 */
export async function fetchGithubPrs({ fetchImpl = fetch, token, account, org = null, sinceDays = 30, max = 40, now = Date.now() } = {}) {
  if (!token) throw new Error("GitHub backfill needs GH_TOKEN");
  const auth = headers({ authorization: `Bearer ${token}` });
  const since = new Date(now - sinceDays * 86_400_000).toISOString().slice(0, 10);
  const q = `is:pr author:${account}${org ? ` org:${org}` : ""} updated:>=${since}`;
  const found = await getJson(fetchImpl, `https://api.github.com/search/issues?per_page=${max}&sort=updated&order=desc&q=${encodeURIComponent(q)}`, { headers: auth });
  const docs = [];
  for (const item of (found.items ?? []).slice(0, max)) {
    const [owner, repo] = item.repository_url.split("/repos/")[1].split("/");
    const base = `https://api.github.com/repos/${owner}/${repo}`;
    const [pr, comments, reviews] = await Promise.all([
      getJson(fetchImpl, `${base}/pulls/${item.number}`, { headers: auth }).catch(() => null),
      getJson(fetchImpl, `${base}/issues/${item.number}/comments?per_page=100`, { headers: auth }).catch(() => []),
      getJson(fetchImpl, `${base}/pulls/${item.number}/reviews?per_page=100`, { headers: auth }).catch(() => []),
    ]);
    const lines = [`# ${repo}#${item.number} ${pr?.title ?? item.title}`, "", item.html_url, ""];
    if (pr?.body) lines.push("## Description", pr.body.trim(), "");
    const others = reviews.filter((r) => r.body?.trim());
    if (others.length) lines.push("## Reviews", ...others.map((r) => `- ${r.user?.login ?? "?"} (${r.state}): ${r.body.trim().replace(/\s+/g, " ").slice(0, 400)}`), "");
    const talk = comments.filter((c) => c.body?.trim());
    if (talk.length) lines.push("## Conversation", ...talk.map((c) => `- ${c.user?.login ?? "?"}: ${c.body.trim().replace(/\s+/g, " ").slice(0, 400)}`), "");
    if (pr?.merged_at) lines.push(`Merged ${String(pr.merged_at).slice(0, 10)}${pr.merge_commit_sha ? ` as ${pr.merge_commit_sha.slice(0, 7)}` : ""}`);
    else if (pr?.state) lines.push(`State: ${pr.state}${pr.draft ? " (draft)" : ""}`);
    docs.push({
      source_path: `pr:${owner}/${repo}#${item.number}`,
      source_type: "pr_body",
      tier: "episodic",
      title: `${repo}#${item.number} ${pr?.title ?? item.title}`,
      content: clip(redact(lines.join("\n")).text, MAX_CHARS),
      event_ts: Date.parse(pr?.updated_at ?? item.updated_at) || now,
    });
  }
  return docs;
}

// ── Jira ────────────────────────────────────────────────────────────────────

/** One doc per ticket from a JQL query. `heroku` description: rendered HTML when available, ADF otherwise. */
export async function fetchJiraTickets({ fetchImpl = fetch, email, token, jql, max = 50, now = Date.now(), base } = {}) {
  if (!token) throw new Error("Jira backfill needs ATLASSIAN_PAT");
  if (!email) throw new Error("Jira backfill needs ATLASSIAN_EMAIL (the account the PAT belongs to)");
  base = atlassianBase(base);
  const auth = headers({ authorization: basic(email, token) });
  const search = await fetchImpl(`${base}/rest/api/3/search/jql`, {
    method: "POST",
    headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify({ jql, maxResults: Math.min(max, 100), fields: ["summary", "status", "issuetype", "updated", "description", "labels", "parent", "assignee", "reporter"] }),
  });
  if (!search.ok) throw new Error(`${search.status} ${search.statusText} for Jira search`);
  const found = await search.json();
  const docs = [];
  for (const issue of found.issues ?? []) {
    const f = issue.fields ?? {};
    const body = htmlToText(f.description && typeof f.description === "string" ? f.description : adfToText(f.description));
    const lines = [
      `# ${issue.key} ${f.summary ?? ""}`,
      "",
      `status: ${f.status?.name ?? "?"} · type: ${f.issuetype?.name ?? "?"} · assignee: ${f.assignee?.displayName ?? "unassigned"} · reporter: ${f.reporter?.displayName ?? "?"}`,
      ...(f.parent ? [`parent: ${f.parent.key} ${f.parent.fields?.summary ?? ""}`] : []),
      ...(f.labels?.length ? [`labels: ${f.labels.join(", ")}`] : []),
      `url: ${base}/browse/${issue.key}`,
      "",
      body,
    ];
    docs.push({
      source_path: `jira:${issue.key}`,
      source_type: "jira_ticket",
      tier: "episodic",
      title: `${issue.key} ${f.summary ?? ""}`.trim(),
      content: clip(redact(lines.join("\n")).text, MAX_CHARS),
      event_ts: Date.parse(f.updated) || now,
    });
  }
  return docs;
}

// ── Confluence ──────────────────────────────────────────────────────────────

/** Pages of the given spaces changed inside the window, body converted to text. */
export async function fetchConfluencePages({ fetchImpl = fetch, email, token, spaces, sinceDays = 30, max = 60, now = Date.now(), base } = {}) {
  if (!token) throw new Error("Confluence backfill needs ATLASSIAN_PAT");
  if (!email) throw new Error("Confluence backfill needs ATLASSIAN_EMAIL (the account the PAT belongs to)");
  base = atlassianBase(base);
  const wanted = spaceEntries(spaces);
  const auth = headers({ authorization: basic(email, token) });
  const since = new Date(now - sinceDays * 86_400_000).toISOString().slice(0, 10);
  const docs = [];
  for (const [key, id] of wanted) {
    const list = await getJson(fetchImpl, `${base}/wiki/api/v2/spaces/${id}/pages?limit=100&body-format=storage`, { headers: auth });
    for (const page of list.results ?? []) {
      if (docs.length >= max) return docs;
      const updated = page.version?.createdAt ?? page.createdAt;
      if (updated && updated.slice(0, 10) < since) continue;
      const body = await getJson(fetchImpl, `${base}/wiki/api/v2/pages/${page.id}?body-format=storage`, { headers: auth }).catch(() => null);
      const text = htmlToText(body?.body?.storage?.value ?? page.body?.storage?.value ?? "");
      const lines = [`# ${page.title}`, "", `space: ${key} · version ${page.version?.number ?? "?"}`, `url: ${base}/wiki/spaces/${key}/pages/${page.id}`, "", text];
      docs.push({
        source_path: `confluence:${key}/${page.id}`,
        source_type: "confluence_page",
        tier: "semantic",
        title: page.title ?? `page ${page.id}`,
        content: clip(redact(lines.join("\n")).text, MAX_CHARS),
        event_ts: Date.parse(updated) || now,
      });
    }
  }
  return docs;
}

// ── orchestration ───────────────────────────────────────────────────────────

/**
 * Runs the sources the environment allows and stores what came back. A source whose credentials are missing
 * is reported and skipped, not fatal: a partial backfill is still a better kb.
 */
export async function backfillRemote(db, { env = process.env, only = null, sinceDays = 30, max = 40, dryRun = false, fetchImpl = fetch, now = Date.now() } = {}) {
  const wanted = only ?? ["jira", "github", "confluence"];
  const report = {};
  const store = (docs, source) => {
    if (dryRun) return (report[source] = { found: docs.length, written: 0 });
    let written = 0;
    for (const d of docs) {
      const before = db.prepare("SELECT content FROM documents WHERE source_path = ?").get(d.source_path)?.content;
      if (before === d.content) continue;
      upsertDoc(db, { ...d, resume_cmd: null }, now);
      written++;
    }
    report[source] = { found: docs.length, written };
  };

  if (wanted.includes("github")) {
    try {
      const account = env.GH_ACCOUNT || env.AGENT_KB_GH_ACCOUNT;
      const docs = await fetchGithubPrs({ fetchImpl, token: env.GH_TOKEN, account, org: env.AGENT_KB_GH_ORG || null, sinceDays, max, now });
      store(docs, "github");
    } catch (e) {
      report.github = { error: String(e?.message ?? e).slice(0, 200) };
    }
  }
  if (wanted.includes("jira")) {
    try {
      const user = env.ATLASSIAN_EMAIL || env.AGENT_KB_ATLASSIAN_EMAIL;
      const jql = env.AGENT_KB_JIRA_JQL || `(assignee = currentUser() OR reporter = currentUser()) AND updated >= -${sinceDays}d ORDER BY updated DESC`;
      const docs = await fetchJiraTickets({ fetchImpl, email: user, token: env.ATLASSIAN_PAT, jql, max, now, base: env.AGENT_KB_ATLASSIAN_BASE });
      store(docs, "jira");
    } catch (e) {
      report.jira = { error: String(e?.message ?? e).slice(0, 200) };
    }
  }
  if (wanted.includes("confluence")) {
    try {
      const user = env.ATLASSIAN_EMAIL || env.AGENT_KB_ATLASSIAN_EMAIL;
      const spaces = env.AGENT_KB_CONFLUENCE_SPACES || null;
      const docs = await fetchConfluencePages({ fetchImpl, email: user, token: env.ATLASSIAN_PAT, spaces, sinceDays, max, now, base: env.AGENT_KB_ATLASSIAN_BASE });
      store(docs, "confluence");
    } catch (e) {
      report.confluence = { error: String(e?.message ?? e).slice(0, 200) };
    }
  }
  return report;
}
