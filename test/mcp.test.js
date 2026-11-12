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
  assert.deepEqual(tools.map((t) => t.name).sort(), ["kb_get", "kb_query"]);
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
