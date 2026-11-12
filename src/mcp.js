import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getDoc } from "./store.js";
import { search } from "./search.js";
import { formatHits, truncate } from "./format.js";

const text = (t) => ({ content: [{ type: "text", text: t }] });

export function createServer(db) {
  const server = new McpServer({ name: "agent-kb", version: "0.1.0" });

  server.registerTool(
    "kb_query",
    {
      description:
        "Search the user's personal knowledge base of past agent sessions and notes. " +
        "Use before asking the user for context they may have discussed before. Words are ANDed.",
      inputSchema: {
        query: z.string().min(1).describe("Search words, e.g. a ticket id, file name or topic"),
        limit: z.number().int().min(1).max(50).optional().describe("Max hits, default 10"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ query, limit }) => text(formatHits(search(db, query, { limit }))),
  );

  server.registerTool(
    "kb_get",
    {
      description: "Fetch one knowledge-base document in full by the path a kb_query hit printed.",
      inputSchema: {
        path: z.string().min(1),
        max_chars: z.number().int().min(200).max(200_000).optional().describe("Truncate, default 20000"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ path, max_chars = 20_000 }) => {
      const d = getDoc(db, path);
      if (!d) return { ...text(`No document at ${path}`), isError: true };
      return text(`[${d.tier}/${d.source_type}] ${d.title ?? d.source_path}\n\n${truncate(d.content, max_chars)}`);
    },
  );

  return server;
}
