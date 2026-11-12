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

### Sweeper semantics

Not a cron job: a timer inside the MCP server, running only while a host app is open
(on startup + every 15 min). A tick costs a `stat` per transcript; only changed, idle files are read.

```
tick
  └─ per adapter: list transcripts → stat (size, mtime)            no read, no model call
       compare with cursors (last byte offset summarized)
         ├─ size == cursor          → skip
         ├─ grew, idle < 20 min     → skip (still active)
         ├─ grew, idle ≥ 20 min     → read cursor..end → redact → summarize → cursor = end
         └─ no cursor (new file)    → summarize from 0
```

| case | behaviour |
|---|---|
| session left open for days | one chunk per idle gap (`#w1`, `#w2` …), never the whole file again |
| crashed / killed session | stops growing → caught next tick |
| app closed for days | first tick after start catches up (diff is against cursors, not time) |
| old untouched session | summarized once (backfill); afterwards size == cursor → free forever |
| old session resumed later | only the new bytes are summarized |

Polling `stat` beats fs watchers for portability (network drives, OS differences); a watcher
can be added later as a latency optimization that only marks files dirty.

### Backfill (first install)

Offered during setup, never silent: it sends redacted history to the user's model provider and spends their quota.

```
setup
  ├─ Tier 0 — automatic, no model, seconds
  │    every transcript on disk → metadata row: title / first prompt, cwd, project,
  │    dates, harness, resume_cmd + FTS over the user's own (redacted) prompts
  │    → search + resume work immediately
  └─ Tier 1 — opt-in, model, background
       "Summarize N past sessions? est. T tokens / $C   [All on disk] [Last 30 days] [Not now]"
       newest first, rate-limited (pauses while a session is active), resumable via cursors;
       each finished session upgrades its row from metadata → summary
```

- Default selection: last 30 days. Skipped → `agent-kb backfill [--since 90d]` later.
- Sessions under a size floor stay metadata-only (no model call).
- Backfill and sweeper share `cursors`, so bytes are never summarized twice.

### Retention trap

Host apps delete old transcripts on their own (Claude Code: `cleanupPeriodDays` — verify the
default before relying on it). Consequences:

- Backfill can only reach what is still on disk; tier 0 runs first so every surviving session gets a row.
- The sweeper must summarize before deletion. Summaries outlive transcripts; such sessions are
  marked `transcript_gone` and lose `resume_cmd`.
- Setup offers to raise the retention setting and states the disk cost.

### Claude Desktop surfaces

| surface | storage | capture |
|---|---|---|
| Chat | cloud only, nothing on disk | **no** — served read-only via MCP; README must say chat history is not captured |
| Code tab (local) | CLI-format transcript under `<config>/projects/`; metadata in Desktop's `claude-code-sessions/**/local_*.json` (`cliSessionId`, `cwd`, `title`, `lastActivityAt`) | yes — `claude-desktop-code` adapter |
| Cowork | Desktop's `local-agent-mode-sessions/**/audit.jsonl`, own format | yes — `claude-cowork` adapter |
| Code tab (cloud / remote) | runs on a remote VM; local `claude-code-vm/` content unverified | investigate in phase 4 |

### Chat capture (cloud-only conversations)

No local file exists, so the sweeper cannot see chats. Three supported routes feed the same pipeline:

```
new chats   → kb_save via MCP (live, Desktop)       ┐
history     → export zip → agent-kb import          ├→ redact → summarize → kb
enterprise  → compliance API adapter (optional)     ┘
resume_cmd  = https://claude.ai/chat/<conversation_id>   (opens the chat; no CLI fork)
```

| route | mechanism | coverage | notes |
|---|---|---|---|
| live write-through | `kb_save` MCP tool; invoked on request ("save this to kb") or by a Project / custom instruction | new Desktop chats (web claude.ai cannot reach local MCP) | no extra model cost — the chat model writes the summary; server still redacts |
| export import | Settings → Privacy → Export data → emailed zip (`conversations.json`); `agent-kb import <zip>`, optional watcher on the downloads folder | full history, individual plans; Team/Enterprise only if the org enables it | link expires 24 h after sending, may work once; dedup on conversation id + `updated_at` so re-imports only summarize changed chats |
| compliance API | `/v1/compliance/apps/chats` + `/messages` with an org compliance key | whole org, Enterprise admins | optional adapter |

Not shipped: scraping the internal claude.ai API with a session cookie (unofficial, brittle,
ToS risk) and reading Desktop's local web cache (partial).

To verify before building: the real `conversations.json` schema (fields, message branching) from an
actual export, and how reliably a Project instruction triggers `kb_save` (measure on ~20 chats).

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

### 3. Summarizer + sweeper + backfill
- [ ] Summarizer backends: `claude` CLI (`claude -p` with a small model) or an Anthropic API key. Fixed note format: DECISIONS / KNOWLEDGE / FILES / OPEN.
- [ ] Sweeper: idle threshold, delta-only via `cursors`, chunk long sessions (`#w2`, `#w3` …), lock so two app instances don't double-summarize.
- [ ] Skip/stub tiny sessions without a model call.
- [ ] Backfill tier 0 (metadata + prompt FTS, no model) and tier 1 (opt-in summaries, estimate shown first, resumable).
- [ ] `transcript_gone` marking when a host app deletes a transcript.
- Done when: a session left open for days is summarized in chunks without ever ending; a killed session is still captured; tier 0 makes every on-disk session searchable and resumable without a model call.

### 4. Adapters
- [ ] `claude-code`: `<config>/projects/**/<session>.jsonl`, honouring `CLAUDE_CONFIG_DIR`.
- [ ] `claude-desktop-code`: session metadata (`cliSessionId`, `cwd`, `title`, `lastActivityAt`, `isArchived`) joined to the CLI transcript.
- [ ] `claude-cowork`: Desktop local agent sessions.
- [ ] `claude-chat`: `kb_save` MCP tool + `agent-kb import <export.zip>` (see Chat capture); compliance-API adapter optional.
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
