#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { dbPath } from "./paths.js";
import { openStore, SchemaTooNewError } from "./store.js";
import { createServer } from "./mcp.js";
import { startSweeper } from "./sweeper.js";
import { summarizerFromEnv } from "./summarize.js";

let db;
try {
  db = openStore(dbPath());
} catch (e) {
  if (!(e instanceof SchemaTooNewError)) throw e;
  console.error(e.message);
  process.exit(3);
}
await createServer(db).connect(new StdioServerTransport());
// AGENT_KB_CHILD: a summarizer call of our own (claude -p); AGENT_KB_SWEEP=off: no background sweeps (timer or SessionEnd hook).
if (!process.env.AGENT_KB_CHILD && process.env.AGENT_KB_SWEEP !== "off") startSweeper(db, { summarize: summarizerFromEnv() });
