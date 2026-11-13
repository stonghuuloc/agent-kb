import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import crypto from "node:crypto";
import { getDoc, upsertDoc } from "./store.js";
import { CHAT } from "./adapters/claude-chat.js";
import { search } from "./search.js";
import { formatHits, truncate } from "./format.js";

const CHAT_URL = /^https:\/\/claude\.ai\/chat\/[0-9a-f-]{36}$/;
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

  server.registerTool(
    "kb_save",
    {
      description:
        "Save a note about the current conversation to the user's knowledge base, when the user asks " +
        '("save this to kb") or their instructions say to. Write the note yourself: decisions, facts worth ' +
        "keeping, open questions. Secrets are removed before it is stored.",
      inputSchema: {
        title: z.string().min(1).max(200).describe("A short name for the conversation"),
        note: z.string().min(1).max(50_000).describe("The note: what was decided and learned, in a few bullets"),
        chat_url: z.string().regex(CHAT_URL).optional().describe("This chat's https://claude.ai/chat/<id> address, if known"),
      },
    },
    async ({ title, note, chat_url }) => {
      // one saved note per chat (a later save replaces it); without a URL, one per distinct note
      const sourcePath = chat_url ? `${chat_url}#saved` : `kb-save:${crypto.createHash("sha256").update(JSON.stringify([title, note])).digest("hex").slice(0, 16)}`;
      upsertDoc(db, { source_path: sourcePath, source_type: CHAT, tier: "episodic", title, content: note, event_ts: Date.now(), resume_cmd: chat_url ?? null });
      return text(`Saved to the knowledge base as ${sourcePath}`);
    },
  );

  return server;
}
