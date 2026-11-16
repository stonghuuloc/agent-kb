import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getDoc, openStore } from "../src/store.js";
import { adfToText, atlassianBase, backfillRemote, fetchConfluencePages, fetchGithubPrs, fetchJiraTickets, htmlToText } from "../src/backfill-remote.js";
import { readDotenv } from "../src/env-file.js";
import { search } from "../src/search.js";

const now = Date.parse("2026-11-16T12:00:00Z");
const SITE = "https://acme.atlassian.net";
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "agent-kb-br-"));

/** A fetch stand-in: matches on URL/method and returns the canned body, so no test touches a network. */
function stub(routes) {
  const calls = [];
  const impl = async (url, init = {}) => {
    calls.push(`${init.method ?? "GET"} ${url}`);
    // longest pattern first: /pulls/1/reviews must beat /pulls/1
    for (const [pattern, body] of [...routes].sort((a, b) => b[0].length - a[0].length)) {
      if (url.includes(pattern)) {
        return { ok: true, status: 200, statusText: "OK", json: async () => (typeof body === "function" ? body(url, init) : body) };
      }
    }
    return { ok: false, status: 404, statusText: "Not Found", json: async () => ({}) };
  };
  return Object.assign(impl, { calls });
}

test("GitHub search finds the PRs and folds in reviews and conversation", async () => {
  // Arrange
  const fetchImpl = stub([
    ["search/issues", { items: [{ number: 3628, title: "Claim gate", html_url: "https://github.com/acme/Policies/pull/3628", repository_url: "https://api.github.com/repos/acme/Policies", updated_at: "2026-11-15T10:00:00Z" }] }],
    ["/pulls/3628", { number: 3628, title: "Claim gate", body: "Fixes the gate", state: "closed", merged_at: "2026-11-15T12:00:00Z", merge_commit_sha: "abcdef1234567", updated_at: "2026-11-15T12:00:00Z" }],
    ["/issues/3628/comments", [{ user: { login: "rev" }, body: "looks good" }]],
    ["/pulls/3628/reviews", [{ user: { login: "ba" }, state: "APPROVED", body: "ship it" }]],
  ]);

  // Act
  const docs = await fetchGithubPrs({ fetchImpl, token: "t", account: "loc", now });

  // Assert
  assert.equal(docs.length, 1);
  assert.equal(docs[0].source_path, "pr:acme/Policies#3628");
  assert.equal(docs[0].source_type, "pr_body");
  assert.match(docs[0].content, /## Description[\s\S]*Fixes the gate/);
  assert.match(docs[0].content, /## Reviews[\s\S]*ship it/);
  assert.match(docs[0].content, /## Conversation[\s\S]*looks good/);
  assert.match(docs[0].content, /Merged 2026-11-15 as abcdef1/);
});

test("a Jira ticket becomes a document with its status line and body text", async () => {
  // Arrange
  const fetchImpl = stub([
    ["/rest/api/3/search/jql", { issues: [{ key: "CH-58201", fields: { summary: "Claim gate", status: { name: "Ready for QA" }, issuetype: { name: "Story" }, assignee: { displayName: "Loc" }, reporter: { displayName: "BA" }, labels: ["claims"], updated: "2026-11-15T09:00:00Z", description: "<p>Gate <b>fails</b> closed</p><ul><li>claims</li></ul>" } }] }],
  ]);

  // Act
  const docs = await fetchJiraTickets({ fetchImpl, email: "me@example.com", token: "pat", jql: "x", now, base: SITE });

  // Assert
  assert.equal(docs[0].source_path, "jira:CH-58201");
  assert.equal(docs[0].title, "CH-58201 Claim gate");
  assert.match(docs[0].content, /status: Ready for QA · type: Story · assignee: Loc/);
  assert.match(docs[0].content, /labels: claims/);
  assert.match(docs[0].content, /Gate fails closed\n\n- claims/);
  assert.equal(docs[0].tier, "episodic");
});

test("an ADF description and Confluence storage HTML both come through as text", async () => {
  // Arrange
  const adf = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "hello " }, { type: "text", text: "world" }] }] };
  const fetchImpl = stub([
    ["/spaces/1221230606/pages", { results: [{ id: "2732490783", title: "Release notes", version: { number: 4, createdAt: "2026-11-14T08:00:00Z" } }] }],
    ["/pages/2732490783", { id: "2732490783", title: "Release notes", body: { storage: { value: "<h2>CH-58201</h2><p>claim gate shipped</p>" } } }],
  ]);

  // Act
  const docs = await fetchConfluencePages({ fetchImpl, email: "me@example.com", token: "pat", spaces: { CH: 1221230606 }, now, base: SITE });
  const storage = await fetchConfluencePages({ fetchImpl, email: "me@example.com", token: "pat", spaces: { CH: 1221230606 }, now, base: SITE });

  // Assert
  assert.equal(adfToText(adf), "hello world\n");
  assert.equal(htmlToText("<p>a</p><p>b</p>"), "a\n\nb", "a blank line between blocks");
  assert.equal(htmlToText("<script>alert(1)</script >kept"), "kept", "a script with a space in its end tag");
  assert.equal(htmlToText("&amp;lt; stays"), "&lt; stays", "entities decode once");
  assert.equal(docs[0].source_path, "confluence:CH/2732490783");
  assert.equal(docs[0].tier, "semantic");
  assert.match(docs[0].content, /# Release notes/);
  assert.match(docs[0].content, /space: CH · version 4/);
  assert.match(docs[0].content, /claim gate shipped/);
  assert.equal(storage.length, 1);
});

test("the backfill stores what it found, skips unchanged rows, and reports a missing credential instead of failing", async () => {
  // Arrange
  const db = openStore(path.join(tmp(), "kb.sqlite"));
  const fetchImpl = stub([
    ["search/issues", { items: [{ number: 1, title: "PR one", html_url: "u", repository_url: "https://api.github.com/repos/acme/Policies", updated_at: "2026-11-15T10:00:00Z" }] }],
    ["/pulls/1", { number: 1, title: "PR one", body: "body", state: "open", updated_at: "2026-11-15T10:00:00Z" }],
    ["/issues/1/comments", []],
    ["/pulls/1/reviews", []],
    ["/rest/api/3/search/jql", { issues: [{ key: "CH-1", fields: { summary: "Ticket", status: { name: "Open" }, updated: "2026-11-15T09:00:00Z" } }] }],
  ]);
  const env = { GH_TOKEN: "t", GH_ACCOUNT: "loc" };

  // Act
  const first = await backfillRemote(db, { env, only: ["github", "jira", "confluence"], now, fetchImpl });
  const second = await backfillRemote(db, { env, only: ["github"], now, fetchImpl });
  const dryMissing = await backfillRemote(db, { env: {}, only: ["github"], now, fetchImpl, dryRun: true });

  // Assert
  assert.deepEqual(first.github, { found: 1, written: 1 });
  assert.match(first.jira.error ?? "", /ATLASSIAN_PAT/, "a missing PAT is reported, not thrown");
  assert.match(first.confluence.error ?? "", /ATLASSIAN_PAT/);
  const withPat = await backfillRemote(db, { env: { ...env, ATLASSIAN_PAT: "pat", ATLASSIAN_EMAIL: "me@example.com", AGENT_KB_ATLASSIAN_BASE: SITE }, only: ["jira"], now, fetchImpl });
  assert.deepEqual(withPat.jira, { found: 1, written: 1 });
  assert.deepEqual(second.github, { found: 1, written: 0 }, "an unchanged PR costs no write");
  assert.match(dryMissing.github.error ?? "", /GH_TOKEN/);
  assert.equal(getDoc(db, "pr:acme/Policies#1").source_type, "pr_body");
  assert.equal(search(db, "PR one").length, 1, "the PR is searchable");
  assert.equal(search(db, "Ticket").length, 1, "and so is the ticket");
});

test("the CLI's dotenv reader takes KEY=value lines and ignores the rest", () => {
  // Arrange
  const file = path.join(tmp(), ".git.env");
  fs.writeFileSync(file, "# comment\nGH_TOKEN='abc'\nATLASSIAN_PAT=\"xyz\"\nnot a pair\n");

  // Act
  const env = readDotenv(file);

  // Assert
  assert.deepEqual(env, { GH_TOKEN: "abc", ATLASSIAN_PAT: "xyz" });
  assert.deepEqual(readDotenv(path.join(tmp(), "missing")), {});
});

test("the PAT only goes to an https *.atlassian.net site, and a space id must be a number", async () => {
  // Arrange
  const fetchImpl = stub([["/rest/api/3/search/jql", { issues: [] }]]);
  const jira = (base) => fetchJiraTickets({ fetchImpl, email: "me@example.com", token: "pat", jql: "x", now, base });

  // Act
  const ok = atlassianBase("https://acme.atlassian.net/wiki");

  // Assert
  assert.equal(ok, "https://acme.atlassian.net", "a path is dropped, the origin kept");
  const refused = (e) => e.message.startsWith("AGENT_KB_ATLASSIAN_BASE must be");
  await assert.rejects(jira("https://evil.example.com"), refused);
  await assert.rejects(jira("https://acme.atlassian.net.evil.com"), refused);
  await assert.rejects(jira("http://acme.atlassian.net"), refused);
  await assert.rejects(jira("https://u:p@acme.atlassian.net"), refused);
  await assert.rejects(jira(undefined), /AGENT_KB_ATLASSIAN_BASE/);
  await assert.rejects(fetchConfluencePages({ fetchImpl, email: "me@example.com", token: "pat", base: SITE, spaces: { CH: "1/../../x" }, now }), /bad Confluence space/);
  await assert.rejects(fetchConfluencePages({ fetchImpl, email: "me@example.com", token: "pat", base: SITE, now }), /AGENT_KB_CONFLUENCE_SPACES/);
  await assert.rejects(fetchConfluencePages({ fetchImpl, email: "me@example.com", token: "pat", base: SITE, spaces: "{bad", now }), /not JSON/);
  await assert.rejects(fetchConfluencePages({ fetchImpl, email: "me@example.com", token: "pat", base: SITE, spaces: "[1]", now }), /AGENT_KB_CONFLUENCE_SPACES/);
  const badJsonNoPat = await backfillRemote(openStore(path.join(tmp(), "kb.sqlite")), { env: { AGENT_KB_CONFLUENCE_SPACES: "{bad" }, only: ["confluence"], now, fetchImpl });
  assert.match(badJsonNoPat.confluence.error, /ATLASSIAN_PAT/, "credentials are checked before the space config");
  assert.equal(fetchImpl.calls.length, 0, "no request leaves before the checks pass");
});

test("GitHub search drops the org filter when no org is configured", async () => {
  // Arrange
  const fetchImpl = stub([["search/issues", { items: [] }]]);

  // Act
  await fetchGithubPrs({ fetchImpl, token: "t", account: "me", now });
  await fetchGithubPrs({ fetchImpl, token: "t", account: "me", org: "acme", now });

  // Assert
  assert.doesNotMatch(decodeURIComponent(fetchImpl.calls[0]), /org:/);
  assert.match(decodeURIComponent(fetchImpl.calls[1]), /org:acme/);
});
