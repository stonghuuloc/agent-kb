import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getDoc, openStore } from "../src/store.js";
import { indexRoots, indexSources } from "../src/indexer.js";
import { search } from "../src/search.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "agent-kb-ix-"));
const write = (file, text) => (fs.mkdirSync(path.dirname(file), { recursive: true }), fs.writeFileSync(file, text), file);

/** A fake ~/.claude plus a fake workspace with the shapes the indexer is supposed to recognise. */
function fixture() {
  const home = tmp();
  const claude = path.join(home, ".claude");
  const ws = path.join(home, "ws");
  write(path.join(claude, "CLAUDE.md"), "# Global rules\nSay it in the first line.");
  write(path.join(claude, "skills", "kb", "SKILL.md"), "---\nname: kb\ndescription: lookup\n---\n\n# kb skill\n\nQuery the kb.");
  write(path.join(claude, "commands", "distill.md"), "# distill\n\nRead the friction log.");
  write(path.join(claude, "agents", "reviewer.md"), "# Reviewer\n\nFresh context only.");
  write(path.join(claude, "plans", "p1.md"), "# Plan one\n\nSlices.");
  write(path.join(claude, "kb", "team-map.md"), "# Team map\n\nPolicies: squad A.");
  write(path.join(claude, "hooks", "inject.py"), "# hook\nprint('x')\n");
  write(path.join(claude, "hooks", "notes.txt"), "not a hook extension");
  write(path.join(claude, "projects", "-Users-x-proj", "memory", "feedback_x.md"), "---\nname: feedback_x\n---\n\n# Lesson\n\nCheck first.");
  write(path.join(claude, "projects", "-Users-x-proj", "memory", "index.json"), "{}");
  write(path.join(home, "ws", "repoA", "CLAUDE.md"), "# Repo A\n\nService rules.");
  write(path.join(home, "ws", "repoA", "README.md"), "# Repo A readme\n\nInstall.");
  write(path.join(home, "ws", "repoA", "docs", "arch", "flow.md"), "# Flow\n\nQuote → policy → premium.");
  write(path.join(home, "ws", "repoA", "docs", "arch", "deep", "nested.md"), "# Nested\n\nTwo levels under docs.");
  write(path.join(home, "ws", "repoA", ".claude", "skills", "nav", "SKILL.md"), "# nav\n\nHow to navigate.");
  write(path.join(home, "ws", "repoA", "src", "deep", "README.md"), "# should not be indexed\n\nsource tree");
  write(path.join(home, "ws", "repoA", "node_modules", "pkg", "README.md"), "# dependency readme");
  write(path.join(home, "ws", "Backend", "Services", "Policies", "CLAUDE.md"), "# Policies\n\nEndorsements.");
  write(path.join(home, "ws", "Backend", "Services", "Policies", "docs", "x.md"), "# X\n\nDoc under a nested repo.");
  write(path.join(home, "ws", "repoA", "docs", "big.md"), "x".repeat(600 * 1024));
  write(path.join(home, "ws", "repoA", "docs", "empty.md"), "");
  write(path.join(home, "ws", "repoA", "docs", "secret.md"), "DB_PASSWORD=hunter2 and more text\n");
  return { home, claude, ws };
}

test("the indexer reads Claude's own tree, repo roots, docs trees and memory notes, and nothing else", () => {
  // Arrange
  const { home, claude, ws } = fixture();
  const db = openStore(path.join(tmp(), "kb.sqlite"));
  const roots = indexRoots({ AGENT_KB_CLAUDE_DIR: claude, AGENT_KB_WORKSPACE: ws }, home);

  // Act
  const c = indexSources(db, { roots });
  const types = Object.fromEntries(db.prepare("SELECT source_type, COUNT(*) AS n FROM documents GROUP BY 1").all().map((r) => [r.source_type, r.n]));

  // Assert
  assert.deepEqual(roots.map((r) => r.rule), ["claude", "memory", "workspace"]);
  assert.equal(c.indexed, 16);
  assert.deepEqual(types, { claude_md: 3, custom_skill: 2, custom_command: 1, custom_agent: 1, plan: 1, curated: 1, hook: 1, memory: 1, readme: 1, arch_doc: 4 });
  assert.equal(getDoc(db, path.join(ws, "repoA", "docs", "arch", "deep", "nested.md")).source_type, "arch_doc", "two levels under docs/ is still a doc");
  assert.equal(getDoc(db, path.join(ws, "Backend", "Services", "Policies", "CLAUDE.md")).tier, "semantic", "a repo nested three deep is still a repo");
  assert.equal(getDoc(db, path.join(claude, "skills", "kb", "SKILL.md")).title, "kb", "a skill is titled by its frontmatter name");
  assert.equal(getDoc(db, path.join(ws, "repoA", ".claude", "skills", "nav", "SKILL.md")).title, "nav", "else by its folder");
  assert.equal(getDoc(db, path.join(ws, "repoA", "CLAUDE.md")).title, "Repo A", "else by its first heading");
  assert.equal(getDoc(db, path.join(ws, "repoA", "src", "deep", "README.md")), null, "a repo's source tree is not walked");
  assert.equal(getDoc(db, path.join(ws, "repoA", "node_modules", "pkg", "README.md")), null, "dependencies are skipped");
  assert.equal(getDoc(db, path.join(claude, "hooks", "notes.txt")), null, "a hook needs a code extension");
  assert.equal(getDoc(db, path.join(claude, "projects", "-Users-x-proj", "memory", "index.json")), null, "memory holds Markdown only");
  assert.equal(c.skipped, 2, "the oversized and the empty file are skipped");
});

test("a second run reads nothing; a changed file is reindexed; a deleted file stops answering", () => {
  // Arrange
  const { home, claude, ws } = fixture();
  const db = openStore(path.join(tmp(), "kb.sqlite"));
  const roots = indexRoots({ AGENT_KB_CLAUDE_DIR: claude, AGENT_KB_WORKSPACE: ws }, home);
  indexSources(db, { roots });
  const doc = path.join(ws, "repoA", "docs", "arch", "flow.md");
  const gone = path.join(ws, "repoA", "docs", "arch", "deep", "nested.md");

  // Act
  const again = indexSources(db, { roots });
  fs.writeFileSync(doc, "# Flow v2\n\nThe quote is now priced by Premium.\n");
  const changed = indexSources(db, { roots });
  fs.rmSync(gone);
  const removed = indexSources(db, { roots });

  // Assert
  assert.deepEqual([again.indexed, again.removed], [0, 0], "unchanged files cost a stat, not a read");
  assert.equal(changed.indexed, 1);
  assert.match(getDoc(db, doc).content, /priced by Premium/);
  assert.equal(removed.removed, 1);
  assert.equal(getDoc(db, gone), null);
  assert.equal(search(db, "priced Premium").length, 1, "the reindexed page answers");
});

test("content is redacted on the way in, and an unknown-cased README still counts", () => {
  // Arrange
  const { home, claude, ws } = fixture();
  const db = openStore(path.join(tmp(), "kb.sqlite"));
  fs.writeFileSync(path.join(ws, "repoA", "docs", "secret.md"), "DB_PASSWORD=hunter2 and more text\n");
  fs.writeFileSync(path.join(ws, "repoA", "AGENTS.MD"), "# Upper case agents\n\nConventions.\n");

  // Act
  indexSources(db, { roots: indexRoots({ AGENT_KB_CLAUDE_DIR: claude, AGENT_KB_WORKSPACE: ws }, home) });

  // Assert
  const secret = getDoc(db, path.join(ws, "repoA", "docs", "secret.md"));
  assert.doesNotMatch(secret.content, /hunter2/);
  assert.match(secret.content, /REDACTED/);
  assert.equal(getDoc(db, path.join(ws, "repoA", "AGENTS.MD")).source_type, "agents_md");
});

test("no workspace set means ~/.claude only, and no root at all indexes nothing", () => {
  // Arrange
  const { home, claude } = fixture();
  const db = openStore(path.join(tmp(), "kb.sqlite"));

  // Act
  const roots = indexRoots({ AGENT_KB_CLAUDE_DIR: claude }, home);
  const c = indexSources(db, { roots });
  const none = indexSources(db, { roots: [] });

  // Assert
  assert.deepEqual(roots.map((r) => r.rule), ["claude", "memory"]);
  assert.equal(c.indexed, 8);
  assert.deepEqual(none, { indexed: 0, unchanged: 0, removed: 0, skipped: 0, failed: 0 });
});
