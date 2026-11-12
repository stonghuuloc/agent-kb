# agent-kb — plan

Status: draft. Phases ship in order; each ends with a usable, tested increment.

## Architecture

```
agent-kb plugin
├─ MCP server  (per-session in Claude Code; long-lived in Claude Desktop)
│   ├─ tools: kb_query · kb_get · kb_resume · kb_fork · kb_note
│   └─ sweeper loop (every 15 min, single-instance lock across processes)
│        ├─ adapters list transcripts whose size/mtime changed
│        ├─ idle ≥ 20 min → redact → summarize the DELTA since last cursor
│        └─ write session doc (+ resume_cmd) → FTS index → optional Obsidian note
├─ hooks  (Claude Code + Desktop Code tab)
│   ├─ SessionStart → inject relevant context; kick a throttled sweep
│   ├─ Stop         → mark transcript dirty (no model call)
│   └─ SessionEnd   → summarize now (fast path only)
└─ adapters: claude-code · claude-desktop-code · claude-cowork · (later) codex · opencode · omp
```

Claude Desktop sessions are never "closed", so capture cannot depend on SessionEnd.
The MCP server process lives as long as the app, which makes it the natural home for the sweeper.

## Data model

SQLite, one file in the user data dir (`$XDG_DATA_HOME/agent-kb/kb.sqlite`, macOS
`~/Library/Application Support/agent-kb/kb.sqlite`).

| table | purpose |
|---|---|
| `documents` | one row per note: `source_path` (unique), `source_type`, `tier` (episodic / semantic / procedural), `event_ts`, `content`, `resume_cmd` |
| `chunks_fts` | FTS5 over `content`, kept in sync by triggers |
| `cursors` | per-transcript byte offset + last summarized ts (incremental summaries) |
| `judgments` | (phase 7) every judge call + the user's later correction |

## Phases

### 1. Core store + search
- [ ] Schema + migrations; data dir resolution per OS.
- [ ] `kb_query` (FTS5 bm25 fused with recency, episodic decay) and `kb_get` over MCP (stdio).
- [ ] CLI: `agent-kb search|get|stats`.
- Done when: an empty install answers queries; fixture docs rank as expected in tests.

### 2. Redaction
- [ ] Rule set: common token formats (cloud keys, GitHub/Slack/Stripe tokens, JWTs, private keys), `KEY=value` env lines, high-entropy strings.
- [ ] Runs before any model call and before any disk write of transcript-derived text.
- [ ] Fixture suite of positive and negative cases; never model-decided.
- Done when: fixture suite passes; a transcript with planted secrets produces a summary without them.

### 3. Summarizer + sweeper
- [ ] Summarizer backends: `claude` CLI (`claude -p` with a small model) or an Anthropic API key. Fixed note format: DECISIONS / KNOWLEDGE / FILES / OPEN.
- [ ] Sweeper: idle threshold, delta-only via `cursors`, chunk long sessions (`#w2`, `#w3` …), lock so two app instances don't double-summarize.
- [ ] Skip/stub tiny sessions without a model call.
- Done when: a session left open for days is summarized in chunks without ever ending; a killed session is still captured.

### 4. Adapters
- [ ] `claude-code`: `<config>/projects/**/<session>.jsonl`, honouring `CLAUDE_CONFIG_DIR`.
- [ ] `claude-desktop-code`: session metadata (`cliSessionId`, `cwd`, `title`, `lastActivityAt`, `isArchived`) joined to the CLI transcript.
- [ ] `claude-cowork`: Desktop local agent sessions.
- [ ] Each adapter yields `{transcript, cwd, started, last_activity, resume_cmd}`; adapters are auto-detected, individually toggleable.
- Done when: each adapter has a fixture test and a live check on a real machine. Untested adapters are not shipped.

### 5. Resume / fork
- [ ] `resume_cmd` per session (e.g. `cd <cwd> && claude --resume <id>`, with the right config dir).
- [ ] `kb_resume` / `kb_fork` MCP tools + CLI `agent-kb resume|fork <query>`; fork seeds the target harness with a handoff prompt (summary + transcript path + "re-check live state").
- [ ] Optional shell integration snippet (zsh/bash/fish).

### 6. Install UX + Obsidian
- [ ] Claude Code: plugin manifest + marketplace entry; `/agent-kb-setup` command asks the same questions as the Desktop form.
- [ ] Claude Desktop: `.mcpb` extension with `user_config` — vault directory picker, source toggles, summarizer choice, API key (sensitive → OS keychain).
- [ ] Obsidian out: session notes + daily journal into `<vault>/<folder>/` with frontmatter and `[[links]]`.
- [ ] Obsidian in: index vault markdown as `semantic` docs.
- [ ] First-run disclosure: what is read, what is sent to the model provider, where files are written.

### 7. Judge + replay gate (v1.1)
- [ ] One `judge` interface; backends `heuristic` (default), `claude`, `jev` (optional, own key).
- [ ] Judge points: capture triage (worth keeping?), conflict scan (do two notes contradict?), kind tagging.
- [ ] Log each judgment and the user's later correction (pin a skipped session, dismiss a conflict).
- [ ] `agent-kb eval` reports AUC per judge point; a point auto-enables only at AUC ≥ 0.85 on the user's own labels.
- Never: redaction, deletion or anything destructive decided by a model.

## Open questions
- Codex / OpenCode / omp adapters: ship only once a maintainer can live-test each.
- Remote capture sources with APIs (cloud agent platforms): separate optional adapters, keys via the install form.
