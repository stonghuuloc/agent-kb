#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { dbPath } from "./paths.js";
import { openStore, SchemaTooNewError } from "./store.js";
import { createServer } from "./mcp.js";
import { startSweeper } from "./sweeper.js";
import { summarizerFromEnv } from "./summarize.js";
import { enabledSources } from "./adapters/claude-desktop.js";
import { judgesFromEnv } from "./judge.js";

let db;
try {
  db = openStore(dbPath());
} catch (e) {
  if (!(e instanceof SchemaTooNewError)) throw e;
  console.error(e.message);
  process.exit(3);
}
let judges = null;
try {
  judges = judgesFromEnv(db);
} catch (e) {
  console.error(`agent-kb: no judging. ${e.message}`);
}
await createServer(db, { judges }).connect(new StdioServerTransport());
// AGENT_KB_CHILD: a summarizer call of our own (claude -p); AGENT_KB_SWEEP=off: no background sweeps (timer or SessionEnd hook).
if (!process.env.AGENT_KB_CHILD && process.env.AGENT_KB_SWEEP !== "off") {
  try {
    enabledSources(); // a typo in AGENT_KB_SOURCES: say so once, not every tick
    startSweeper(db, { summarize: summarizerFromEnv(), judges });
  } catch (e) {
    console.error(`agent-kb: no background sweeps. ${e.message}`);
  }
}
