#!/usr/bin/env node
import { dbPath } from "../src/paths.js";
import { getDoc, openStore, stats } from "../src/store.js";
import { search } from "../src/search.js";
import { formatHits } from "../src/mcp.js";

const USAGE = `usage:
  agent-kb search <words…> [-n N]
  agent-kb get <path>
  agent-kb stats`;

const [cmd, ...args] = process.argv.slice(2);
const db = openStore(dbPath());

switch (cmd) {
  case "search": {
    const i = args.indexOf("-n");
    const limit = i >= 0 ? Number(args.splice(i, 2)[1]) : undefined;
    if (!args.length || (limit !== undefined && !(limit > 0))) fail();
    console.log(formatHits(search(db, args.join(" "), { limit })));
    break;
  }
  case "get": {
    if (args.length !== 1) fail();
    const d = getDoc(db, args[0]);
    if (!d) {
      console.error(`No document at ${args[0]}`);
      process.exit(1);
    }
    console.log(d.content);
    break;
  }
  case "stats": {
    const s = stats(db);
    console.log(`${dbPath()}\n${s.total} documents`);
    for (const r of s.byType) console.log(`  ${String(r.n).padStart(6)}  ${r.tier}/${r.source_type}`);
    break;
  }
  default:
    fail();
}

function fail() {
  console.error(USAGE);
  process.exit(2);
}
