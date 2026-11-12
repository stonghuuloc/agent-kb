#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { dbPath } from "./paths.js";
import { openStore } from "./store.js";
import { createServer } from "./mcp.js";

await createServer(openStore(dbPath())).connect(new StdioServerTransport());
