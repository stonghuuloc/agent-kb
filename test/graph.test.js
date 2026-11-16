import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getDoc, openStore, upsertDoc } from "../src/store.js";
import { buildGraph, extract, graphConfig, graphPath, graphStats, patterns, queryGraph, relFor, resolveEntity } from "../src/graph.js";
import { exportConcepts, GEN_END, GEN_START, humanPart } from "../src/concepts.js";
import { distillFriction, frictionItems, MARKER_END, MARKER_START, proposalsPath, readProposals } from "../src/distill.js";
import { Judges, heuristicJudge } from "../src/judge.js";
import { scanChangedConflicts } from "../src/judge.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "agent-kb-gr-"));
const now = Date.parse("2026-11-16T12:00:00Z");

function doc(db, over = {}) {
  upsertDoc(db, { source_path: "/p/x.md", source_type: "session_learning", tier: "semantic", title: "x", content: "x", event_ts: now, resume_cmd: null, ...over });
}

function seeded(db) {
  doc(db, { source_path: "jira:CH-58201", source_type: "jira_ticket", tier: "episodic", title: "CH-58201 claim gate", content: "endorsement claim gate" });
  doc(db, { source_path: "pr:acme/Policies#3628", source_type: "pr_body", tier: "episodic", title: "Policies#3628", content: "fixes CH-58201, see acme/Policies#3628" });
  doc(db, { source_path: "/w/Backend/Services/Policies/docs/claim.md", source_type: "arch_doc", tier: "semantic", title: "claim", content: "CH-58201 lives in the Policies service" });
  doc(db, { source_path: "/p/session.md", source_type: "session_learning", tier: "semantic", title: "s", content: "worked CH-58201 with acme/Policies#3628" });
}

test("extraction reads tickets, PRs and the doc's own entity, and weights self-mentions", () => {
  // Arrange
  const db = openStore(path.join(tmp(), "kb.sqlite"));
  const pats = patterns(db, { keys: ["CH", "AC"] });
  const text = { source_path: "jira:CH-58201", content: "CH-58201 and CH-58201 again, also AC-1 which is noise" };

  // Act
  const found = extract(text, pats);

  // Assert
  assert.equal(found.get("ticket:CH-58201"), 5, "3 for being the ticket itself, plus 2 mentions");
  assert.equal(found.has("ticket:AC-1"), false, "admin projects are noise");
  assert.equal(relFor("ticket:CH-1", "pr:acme/Policies#1"), "implemented_by");
  assert.equal(relFor("repo:Policies", "ticket:CH-1"), "touches");
  assert.equal(relFor("repo:Policies", "confluence:CH/1234"), "repo_doc");
});

test("with nothing configured or learned no ticket or PR matches, and a bare repo mention takes the configured org", () => {
  // Arrange
  const db = openStore(path.join(tmp(), "kb.sqlite"));
  const text = { source_path: "/p/x.md", content: "build-12 and v-3 and Policies#7" };
  const learnedDb = openStore(path.join(tmp(), "kb.sqlite"));
  doc(learnedDb, { source_path: "pr:acme/Policies#1", source_type: "pr_body", tier: "episodic" });
  doc(learnedDb, { source_path: "pr:acme/docs#1", source_type: "pr_body", tier: "episodic" });
  doc(learnedDb, { source_path: "pr:other/docs#2", source_type: "pr_body", tier: "episodic" });
  const twoOwners = { source_path: "/p/z.md", content: "acme/docs#5 other/docs#6" };
  const spelled = { source_path: "/p/y.md", content: "Policies#7, ACME/Policies#8, Backend/Policies#9" };

  // Act
  const empty = extract(text, patterns(db, graphConfig({})));
  const configured = extract(text, patterns(db, graphConfig({ AGENT_KB_REPOS: "Policies", AGENT_KB_GH_ORG: "acme" })));
  const learned = extract(spelled, patterns(learnedDb, graphConfig({})));
  const shared = extract(twoOwners, patterns(learnedDb, graphConfig({})));

  // Assert
  assert.equal(empty.size, 0);
  assert.equal(configured.get("pr:acme/Policies#7"), 1);
  assert.deepEqual([...learned.keys()].sort(), ["pr:acme/Policies#7", "pr:acme/Policies#8", "pr:acme/Policies#9"], "learned owner, canonical case, a path segment is not an owner");
  assert.deepEqual([...shared.keys()].sort(), ["pr:acme/docs#5", "pr:other/docs#6"], "two orgs with one repo name keep their own owner");
});

test("the graph links a ticket to its PR, its repo and the docs about it", () => {
  // Arrange
  const db = openStore(path.join(tmp(), "kb.sqlite"));
  seeded(db);

  // Act
  const built = buildGraph(db);
  const r = queryGraph(db, "CH-58201");
  const link = graphPath(db, "CH-58201", "repo:Policies");
  const stats = graphStats(db);

  // Assert
  assert.equal(built.entities > 0, true);
  assert.deepEqual(r.neighbours.pr.map((n) => n.label), ["acme/Policies#3628"]);
  assert.deepEqual(r.neighbours.repo.map((n) => n.label), ["Policies"]);
  assert.equal(r.docs.some((d) => d.source_path === "/p/session.md"), true, "the authored session is listed as a doc about it");
  assert.equal(link[0], "ticket:CH-58201");
  assert.equal(link.includes("repo:Policies"), true);
  assert.equal(stats.entities.some((e) => e.etype === "ticket"), true);
  assert.equal(resolveEntity(db, "CH-58201"), "ticket:CH-58201");
  assert.equal(resolveEntity(db, "nope-1"), null);
  assert.equal(resolveEntity(db, "Policies#3628"), "pr:acme/Policies#3628", "a bare repo#n finds its owned PR");
});

test("a date-bucketed doc keeps its mentions but emits no edges", () => {
  // Arrange
  const db = openStore(path.join(tmp(), "kb.sqlite"));
  doc(db, { source_path: "jira:CH-1", source_type: "jira_ticket", tier: "episodic", content: "CH-1" });
  doc(db, { source_path: "jira:CH-2", source_type: "jira_ticket", tier: "episodic", content: "CH-2" });
  doc(db, { source_path: "/v/daily/2026-11-16.md", source_type: "obsidian", tier: "semantic", content: "CH-1 and CH-2 today" });

  // Act
  buildGraph(db);

  // Assert
  assert.equal(getDoc(db, "/v/daily/2026-11-16.md").source_type, "obsidian");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM kb_edges WHERE a = 'ticket:CH-1' AND b = 'ticket:CH-2'").get().n, 0, "a journal links them by day, not by topic");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM kb_doc_entities WHERE source_path = '/v/daily/2026-11-16.md'").get().n, 2, "mentions still recorded");
});

test("concept notes render from the graph, rewrite only their generated region, and keep the human text", () => {
  // Arrange
  const vault = tmp();
  const db = openStore(path.join(tmp(), "kb.sqlite"));
  seeded(db);
  buildGraph(db);
  const ticket = path.join(vault, "concepts", "tickets", "CH-58201.md");
  const repo = path.join(vault, "concepts", "repos", "Policies.md");

  // Act
  const first = exportConcepts(db, vault);
  fs.appendFileSync(ticket, "\nMy own reading order: evaluator → rules → claims.\n");
  const second = exportConcepts(db, vault);

  // Assert
  assert.equal(first.created, 2, "one ticket worked in an authored doc, one repo");
  assert.equal(second.unchanged, 2, "nothing to rewrite until the graph changes");
  assert.match(fs.readFileSync(ticket, "utf8"), /\*\*PRs:\*\* `acme\/Policies#3628`/);
  assert.match(fs.readFileSync(ticket, "utf8"), /My own reading order: evaluator/, "hand-written text survives");
  assert.match(fs.readFileSync(repo, "utf8"), /\[\[CH-58201\]\]/);
  const human = humanPart(fs.readFileSync(ticket, "utf8"));
  assert.doesNotMatch(human, /generated/, "the generated region is not the part indexed back");
  assert.match(human, /evaluator → rules → claims/);
  assert.equal(fs.readFileSync(ticket, "utf8").includes(GEN_START), true);
  assert.equal(fs.readFileSync(ticket, "utf8").includes(GEN_END), true);
});

test("a concept note whose markers were removed is left alone, and a dry run writes nothing", () => {
  // Arrange
  const vault = tmp();
  const db = openStore(path.join(tmp(), "kb.sqlite"));
  seeded(db);
  buildGraph(db);
  exportConcepts(db, vault);
  const file = path.join(vault, "concepts", "tickets", "CH-58201.md");
  fs.writeFileSync(file, "# CH-58201\n\nhand-written, no markers\n");

  // Act
  const dry = exportConcepts(db, vault, { dryRun: true });
  const after = exportConcepts(db, vault);

  // Assert
  assert.equal(dry.updated + dry.created, 0, "a dry run writes nothing");
  assert.equal(after.skipped, 1, "no markers, no guess");
  assert.equal(fs.readFileSync(file, "utf8"), "# CH-58201\n\nhand-written, no markers\n");
});

test("distill writes a managed block, replaces it in place, and refuses to work without a model or enough friction", async () => {
  // Arrange
  const db = openStore(path.join(tmp(), "kb.sqlite"));
  const file = path.join(tmp(), "learned-proposals.md");
  for (const [i, text] of ["[agent] assumed the account again", "[agent] read the wrong token", "[tool] PR search 422s"].entries())
    doc(db, { source_path: `/p/s${i}.jsonl#journal-friction`, source_type: "session_friction", tier: "procedural", content: `- ${text}\n` });
  const summarize = async () => "Proposed rules:\n- **Before any GitHub write** read the identity note first.\n- **When blocked** stop and say so.\n";

  // Act
  const noModel = await distillFriction(db, { file, now });
  const written = await distillFriction(db, { file, summarize, now });
  const again = await distillFriction(db, { file, summarize: async () => "NONE", now });
  const kept = fs.readFileSync(file, "utf8");

  // Assert
  assert.equal(noModel.status, "no-model");
  assert.equal(written.status, "written");
  assert.equal(written.rules, 2);
  assert.match(kept, new RegExp(MARKER_START));
  assert.match(kept, /read the identity note first/);
  assert.match(kept, /_updated \d{4}-\d\d-\d\d — distilled from 3 friction items across 3 sessions_/);
  assert.equal(again.status, "none", "NONE from the model leaves the block as it was");
  assert.equal(kept.match(new RegExp(MARKER_START, "g")).length, 1, "one managed block, never two");
  assert.equal((kept.match(new RegExp(MARKER_END, "g")) ?? []).length, 1);
  assert.equal(readProposals(file).includes("read the identity note first"), true);
  assert.equal(proposalsPath({ AGENT_KB_PROPOSALS: "/x/y.md" }), "/x/y.md");
});

test("too little friction is not a pattern", async () => {
  // Arrange
  const db = openStore(path.join(tmp(), "kb.sqlite"));
  doc(db, { source_path: "/p/a.jsonl#journal-friction", source_type: "session_friction", tier: "procedural", content: "- [agent] one mistake\n" });

  // Act
  const r = await distillFriction(db, { file: path.join(tmp(), "p.md"), summarize: async () => "- x", now });
  const items = frictionItems(db, { now });

  // Assert
  assert.equal(r.status, "too-few");
  assert.deepEqual(items.items, ["[agent] one mistake"]);
  assert.equal(items.sessions, 1);
});

test("the conflicts scan walks changed authored docs and rate-limits itself", async () => {
  // Arrange
  const db = openStore(path.join(tmp(), "kb.sqlite"));
  doc(db, { source_path: "/p/a.jsonl#w1", source_type: "session_learning", tier: "semantic", title: "claim gate", content: "the endorsement claim gate fails closed when the claims payload is unreadable" });
  doc(db, { source_path: "/p/b.jsonl#journal-learned", source_type: "session_learning", tier: "semantic", title: "claim gate", content: "the endorsement claim gate does not fail closed when the claims payload is unreadable", event_ts: now + 1000 });
  const judges = new Judges(db, new Set(["conflict"]), "heuristic", heuristicJudge);

  // Act
  const first = await scanChangedConflicts(db, judges, { now, force: true });
  const second = await scanChangedConflicts(db, judges, { now: now + 1000 });

  // Assert
  assert.equal(first > 0, true, "a contradicting pair is flagged");
  assert.equal(second, 0, "inside the 6 h window nothing runs");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM judgments WHERE point = 'conflict'").get().n > 0, true);
});

/** Authored notes with a shared vocabulary, so each has FTS neighbours, at fixed `indexed_ts`. */
function notes(db, rows) {
  for (const [name, ts] of rows) {
    doc(db, { source_path: `/p/${name}.jsonl#w1`, source_type: "session_learning", tier: "semantic", title: name, content: `endorsement claim gate payload ${name}` });
    db.prepare("UPDATE documents SET indexed_ts = ? WHERE source_path = ?").run(ts, `/p/${name}.jsonl#w1`);
  }
}
const spyJudges = (db, seen, fail = false) =>
  new Judges(db, new Set(["conflict"]), "heuristic", async (point, input) => {
    if (fail) throw new Error("529 overloaded");
    seen.add(input.a.split(" ").at(-1));
    return heuristicJudge(point, input);
  });

test("the conflicts scan gives fresh docs half the cap and the backlog the rest", async () => {
  // Arrange
  const db = openStore(path.join(tmp(), "kb.sqlite"));
  notes(db, [["old0", now - 9000], ["old1", now - 8000]]);
  await scanChangedConflicts(db, spyJudges(db, new Set()), { now, force: true, maxDocs: 0 }); // sets the watermark only
  notes(db, [["new0", now + 1000], ["new1", now + 2000], ["new2", now + 3000]]);
  const seen = new Set();

  // Act
  await scanChangedConflicts(db, spyJudges(db, seen), { now: now + 10_000, force: true, maxDocs: 4 });

  // Assert
  assert.deepEqual([...seen].sort(), ["new1", "new2", "old0", "old1"], "two newest fresh, then two from the backlog");
});

test("a judge error stops the run and keeps the cursor, and a doc that keeps failing is passed over after 3 runs", async () => {
  // Arrange
  const db = openStore(path.join(tmp(), "kb.sqlite"));
  notes(db, [["bad", now - 9000], ["good", now - 8000]]);
  await scanChangedConflicts(db, spyJudges(db, new Set()), { now, force: true, maxDocs: 0 });
  const failOnBad = (seen) =>
    new Judges(db, new Set(["conflict"]), "heuristic", async (point, input) => {
      if (input.a.endsWith(" bad")) throw new Error("not JSON");
      seen.add(input.a.split(" ").at(-1));
      return heuristicJudge(point, input);
    });
  const meta = (k) => db.prepare("SELECT value FROM meta WHERE key = ?").get(k)?.value;
  const seen = new Set();

  // Act
  const judges = failOnBad(seen);
  await scanChangedConflicts(db, judges, { now: now + 1000, force: true, maxDocs: 2 });
  const afterOne = { cursor: meta("conflicts_cursor"), seen: seen.size, watermark: meta("conflicts_scanned_at") };
  await scanChangedConflicts(db, failOnBad(seen), { now: now + 2000, force: true, maxDocs: 2 });
  await scanChangedConflicts(db, failOnBad(seen), { now: now + 3000, force: true, maxDocs: 2 });

  // Assert
  assert.equal(judges.errors > 0, true);
  assert.equal(afterOne.cursor, undefined, "the failed doc keeps the cursor");
  assert.equal(afterOne.seen, 0, "and the run stops there");
  assert.equal(Number(afterOne.watermark), now + 1000, "the watermark moves, so the 6 h limit holds");
  assert.deepEqual([...seen], ["good"], "after the third failure the scan moves on");
  assert.equal(JSON.parse(meta("conflicts_failures"))["/p/bad.jsonl#w1"], undefined, "the passed-over doc's count is cleared");
});

test("the conflicts scan drains a backlog larger than one run's cap", async () => {
  // Arrange
  const db = openStore(path.join(tmp(), "kb.sqlite"));
  notes(db, [["n0", now - 9000], ["n1", now - 8000], ["n2", now - 7000], ["n3", now - 6000], ["n4", now - 5000]]);
  const seen = new Set();

  // Act
  for (let run = 1; run <= 3; run++) await scanChangedConflicts(db, spyJudges(db, seen), { now: now + run * 1000, force: true, maxDocs: 2 });

  // Assert
  assert.deepEqual([...seen].sort(), ["n0", "n1", "n2", "n3", "n4"], "every doc is judged within three runs of two");
});
