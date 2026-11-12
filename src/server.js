#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { dbPath } from "./paths.js";
import { openStore, SchemaTooNewError } from "./store.js";
import { createServer } from "./mcp.js";

let db;
try {
  db = openStore(dbPath());
} catch (e) {
  if (!(e instanceof SchemaTooNewError)) throw e;
  console.error(e.message);
  process.exit(3);
}
await createServer(db).connect(new StdioServerTransport());
