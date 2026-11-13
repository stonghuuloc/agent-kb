import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { openStore, upsertDoc } from "../src/store.js";
import { createServer } from "../src/mcp.js";

async function connect(db) {
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createServer(db).connect(a);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(b);
  return client;
}

test("kb_query and kb_get round-trip over MCP", async () => {
  // Arrange
  const db = openStore(":memory:");
  upsertDoc(db, {
    source_path: "claude-code:/s/1.jsonl",
    source_type: "session",
    tier: "episodic",
    title: "Fix flaky login test",
    content: "Root cause: clock skew in token expiry",
    event_ts: Date.UTC(2026, 10, 1),
    resume_cmd: "cd /repo && claude --resume 1",
  });
  const client = await connect(db);

  // Act
  const { tools } = await client.listTools();
  const q = await client.callTool({ name: "kb_query", arguments: { query: "clock skew" } });
  const g = await client.callTool({ name: "kb_get", arguments: { path: "claude-code:/s/1.jsonl" } });
  const miss = await client.callTool({ name: "kb_get", arguments: { path: "nope" } });

  // Assert
  assert.deepEqual(tools.map((t) => t.name).sort(), ["kb_get", "kb_query", "kb_save"]);
  assert.match(q.content[0].text, /Fix flaky login test \(2026-11-01\)/);
  assert.match(q.content[0].text, /resume: cd \/repo && claude --resume 1/);
  assert.match(g.content[0].text, /clock skew in token expiry/);
  assert.equal(miss.isError, true);
});

test("empty knowledge base answers instead of failing", async () => {
  // Arrange
  const client = await connect(openStore(":memory:"));

  // Act
  const q = await client.callTool({ name: "kb_query", arguments: { query: "anything" } });

  // Assert
  assert.equal(q.content[0].text, "No matches.");
});

test("kb_get truncation never splits a surrogate pair", async () => {
  // Arrange
  const { truncate } = await import("../src/format.js");
  const s = "ab😀cd"; // 😀 = 2 UTF-16 units at index 2-3

  // Act
  const cut = truncate(s, 3);

  // Assert
  assert.equal(cut, "ab\n…[truncated]");
  assert.equal(truncate("abc", 3), "abc");
});

test("kb_save stores a redacted note, one per chat URL, and rejects a foreign URL", async () => {
  // Arrange
  const db = openStore(":memory:");
  const client = await connect(db);
  const url = "https://claude.ai/chat/0b6c1a52-3f1e-4c55-9d1a-6f0e2b7c9a10";

  // Act
  await client.callTool({ name: "kb_save", arguments: { title: "Offsite plan", note: "- agenda fixed", chat_url: url } });
  const again = await client.callTool({ name: "kb_save", arguments: { title: "Offsite plan", note: "- agenda moved to May", chat_url: url } });
  const loose = await client.callTool({ name: "kb_save", arguments: { title: "Loose note", note: "- no url" } });
  const foreign = await client.callTool({ name: "kb_save", arguments: { title: "x", note: "y", chat_url: "https://evil.example/chat/1" } });

  // Assert
  const saved = db.prepare("SELECT source_path, source_type, content, resume_cmd FROM documents ORDER BY source_path").all();
  assert.match(again.content[0].text, /#saved/);
  assert.equal(saved.length, 2);
  assert.deepEqual([saved[0].source_path, saved[0].source_type, saved[0].content, saved[0].resume_cmd], [`${url}#saved`, "claude-chat", "- agenda moved to May", url]);
  assert.match(saved[1].source_path, /^kb-save:[0-9a-f]{16}$/);
  assert.match(loose.content[0].text, /kb-save:/);
  assert.equal(foreign.isError, true);
});

test("kb_save never stores a secret", async () => {
  // Arrange
  const db = openStore(":memory:");
  const client = await connect(db);
  const token = "ghp_" + "Zq7".repeat(12);

  // Act
  await client.callTool({ name: "kb_save", arguments: { title: "Rotate token", note: `- old token ${token} revoked` } });

  // Assert
  const { content } = db.prepare("SELECT content FROM documents").get();
  assert.ok(!content.includes(token));
});

test("kb_save keeps two notes whose title and note only differ in where a line break falls", async () => {
  // Arrange
  const db = openStore(":memory:");
  const client = await connect(db);

  // Act
  await client.callTool({ name: "kb_save", arguments: { title: "Plan\nDecisions", note: "Use SQLite" } });
  await client.callTool({ name: "kb_save", arguments: { title: "Plan", note: "Decisions\nUse SQLite" } });

  // Assert
  assert.equal(db.prepare("SELECT count(*) n FROM documents").get().n, 2);
});
