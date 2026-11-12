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

#### Export format (verified against a real export, 2026-11)

The email does not deliver data. It links to a `member-manifest-*.json` (`version: "1.0"`) whose
`data_files[]` each carry an `export_url`, `category`, `part` and `filename`. Each URL needs the
signed-in browser and may work only once.

| category zip | contents | importer use |
|---|---|---|
| `conversations-NNN` | `conversations.json`: `[{uuid, name, summary, created_at, updated_at, project_uuid, chat_messages[]}]`; message `{uuid, sender, text, content[], parent_message_uuid, created_at}` | main input |
| `memories-NNN` | `memories/<account>.json`: `conversations_memory` + `memory_files[]{path, content, updated_at}` | import as `semantic` |
| `frames-NNN` | `artifacts/<id>/artifact.json`: id, kind, versions[]{title, description, created_at} — no body | metadata rows linked to chats |
| `light_metadata-NNN` | `users.json`: name, email, phone | **ignore** (PII, no kb value) |

- `summary` is pre-written on nearly every conversation → tier 0 for chats is a real summary at zero cost; tier 1 is optional.
- Edited/regenerated messages form a tree via `parent_message_uuid` → walk the active path (latest leaf), not the flat list.
- Content blocks seen: `text`, `thinking`, `tool_use`, `tool_result`, `injected_prompt_block`, `token_budget`. Index `text`; keep tool names; drop `thinking` signatures and `token_budget`.
- `part` implies multi-part zips for large accounts → glob `<category>-*.zip`.

#### Import UX

The manifest is hostile to non-developers (email → JSON → four more links). The importer hides it:

```
agent-kb import <member-manifest-*.json | *.zip | folder>
  ├─ manifest → open each export_url in the default (signed-in) browser; never fetch it headless
  ├─ watch the downloads folder for <category>-*.zip, show "2/4 downloaded…"; timeout → "link expired? re-request"
  └─ all present → unzip to temp → tier 0 → optional tier 1
```

Desktop `.mcpb`: an "Import Claude export" action with a file picker accepting the manifest or the zips.

Still to verify: how reliably a Project instruction triggers `kb_save` (measure on ~20 chats).

## Data model

SQLite, one file in the user data dir (`$XDG_DATA_HOME/agent-kb/kb.sqlite`, macOS
`~/Library/Application Support/agent-kb/kb.sqlite`).

| table | purpose |
|---|---|
| `documents` | one row per note: `source_path` (unique), `source_type`, `tier` (episodic / semantic / procedural), `event_ts`, `content`, `resume_cmd` |
| `chunks_fts` | FTS5 over `title` + `content` (external content), kept in sync by triggers |
| `scans` | per-transcript size + mtime at the last tier-0 index; unchanged files are not re-read |
| `cursors` | (phase 3b) per-transcript byte offset + last summarized ts (incremental summaries) |
| `judgments` | (phase 7) every judge call + the user's later correction |

## Phases

### 1. Core store + search
- [x] Schema + migrations (`PRAGMA user_version`; refuses a newer schema); data dir resolution per OS.
- [x] `kb_query` (FTS5 bm25 fused with recency, episodic decay) and `kb_get` over MCP (stdio).
- [x] CLI: `agent-kb search|get|stats`.
- Runtime: Node ≥ 22.13, built-in `node:sqlite` (FTS5 included) — no native dependency.
- Done when: an empty install answers queries; fixture docs rank as expected in tests.

### 2. Redaction
- [x] Rule set: common token formats (cloud keys, GitHub/Slack/Stripe tokens, JWTs, private keys), `KEY=value` env lines, high-entropy strings.
- [x] Runs before any disk write: `upsertDoc` redacts title and content, so no write path skips it. Phase 3 calls `redact()` before the model call too.
- [x] Fixture suite of positive and negative cases; never model-decided. Fixture secrets are generated at test time, so no real-format token is committed.
- Measured on 50 MB of real transcripts: 2.6 s total. Entropy: ~200 hits on strings under 300 chars (was ~7,900 before path/identifier filtering) plus ~4,000 base64 blobs (images, signatures). Assignment and URL-password hits are mostly real credentials. Every rule start is anchored, so time is linear: adversarial input runs in < 250 ms per MB, with or without hits.
- Known limits: the entropy rule needs upper + lower + digit, so lowercase-only random tokens rely on the format and `KEY=value` rules; ~2% of 32-byte base64 strings fall under its entropy bar. URL passwords holding a raw `/`, `?` or `#` are not found: RFC 3986 requires them percent-encoded, and treating them as password text erased dev URLs (`host:5173/@vite/client`). A digit-first URL password closed by the same bracket, quote or backtick that opened the URL (`(mysql://u:123)X@db)`) is read as a port. A YAML secret on the next line needs a digit or a block scalar (`|`, `>`); one after a blank line or as a list item is not found. A value with spaces, quoted or on a line of at most 128 chars, counts only when a digit touches a letter or symbol (`a9`, `2023!`) or four digits run together (`Winter 2025`), so passphrases of plain words or short numbers (`"correct horse battery"`, `"blue 42 sky"`) and non-ASCII ones (`"Pässwort 2024"`) are kept, like the labels `"Reset password"` and `"Must be at least 8 characters"`. The other way round, help text such as `"Use a1 or b2"`, `"8-64 characters"` or `"Changed on 2024-01-02"` is hidden, and an empty secret block (`password: |`) followed by a blank line hides the sibling keys at its own indent. Digits alone count as a secret under a strong name at any length (a PIN), so `max_pass=3` is hidden too. Both lose text, never a secret. Space-separated flags are read for long names only (`--password X`); `mysql -p X` is not, because `-p` also means port or path. One YAML block of more than about a million lines overflows the regex stack: `redact` throws, so the document is not stored (the backfill counts it as failed) and nothing leaks; so does one unbroken token of several MB. Names are split on `_`, `.`, `-` and camelCase only, so a glued all-caps name (`PGPASSWORD=…`) is not recognised. A resume command that holds a secret (a cwd such as `/work/DB_PASSWORD=…`) is not stored, so that session has no resume line; the transcript path itself encodes the cwd with `=` turned into `-` and is stored as is. A multi-word value on a line over 128 chars keeps all but its first word, and ` #` always starts a comment (`password: Summer #2024!` keeps `#2024!`). A flag reads one word unless quoted (`--secret Summer 2024!` keeps `2024!`), and a first word that looks like a key (`password: x: Summer 2024!`) keeps the line.
- Done when: fixture suite passes (done); a transcript with planted secrets produces a summary without them (verified in phase 3, once the summarizer exists).

### 3. Summarizer + sweeper + backfill
- [ ] Summarizer backends: `claude` CLI (`claude -p` with a small model) or an Anthropic API key. Fixed note format: DECISIONS / KNOWLEDGE / FILES / OPEN.
- [ ] Sweeper: idle threshold, delta-only via `cursors`, chunk long sessions (`#w2`, `#w3` …), lock so two app instances don't double-summarize.
- [ ] Skip/stub tiny sessions without a model call.
- [x] Backfill tier 0: `agent-kb backfill` indexes each transcript's title and the user's own prompts (no model call; head + tail clipped to 32K chars). A `scans` row (size, mtime) skips unchanged files; it is not a summary offset. Measured: 5,206 transcripts, 5,194 indexed, second run all unchanged.
- [ ] Backfill tier 1 (opt-in summaries, estimate shown first, resumable).
- [ ] `transcript_gone` marking when a host app deletes a transcript.
- Done when: a session left open for days is summarized in chunks without ever ending; a killed session is still captured; tier 0 makes every on-disk session searchable and resumable without a model call.

### 4. Adapters
- [x] `claude-code`: `<config>/projects/<project>/<session>.jsonl` (subagent transcripts excluded), scanning `CLAUDE_CONFIG_DIR` and `~/.claude`, or the `AGENT_KB_CLAUDE_DIRS` path list.
- [ ] `claude-desktop-code`: session metadata (`cliSessionId`, `cwd`, `title`, `lastActivityAt`, `isArchived`) joined to the CLI transcript.
- [ ] `claude-cowork`: Desktop local agent sessions.
- [ ] `claude-chat`: `kb_save` MCP tool + `agent-kb import <export.zip>` (see Chat capture); compliance-API adapter optional.
- [ ] Each adapter yields `{transcript, cwd, started, last_activity, resume_cmd}`; adapters are auto-detected, individually toggleable.
- Done when: each adapter has a fixture test and a live check on a real machine. Untested adapters are not shipped.

### 5. Resume / fork
- [x] `resume_cmd` per session (e.g. `cd <cwd> && claude --resume <id>`, with the right config dir). Claude Code only so far.
- [ ] `kb_resume` / `kb_fork` MCP tools + CLI `agent-kb resume|fork <query>`; fork seeds the target harness with a handoff prompt (summary + transcript path + "re-check live state").
- [ ] Optional shell integration snippet (zsh/bash/fish).

### 6. Install UX + Obsidian
- [ ] Claude Code: plugin manifest + marketplace entry; `/agent-kb-setup` command asks the same questions as the Desktop form.
- [ ] Verify the Node version Claude Desktop uses for `.mcpb` servers supports `node:sqlite` (≥ 22.13); else bundle a runtime.
- [ ] Claude Desktop: `.mcpb` extension with `user_config` — vault directory picker, source toggles, summarizer choice, API key (sensitive → OS keychain).
- [ ] Obsidian out: session notes + daily journal into `<vault>/<folder>/` with frontmatter and `[[links]]`.
- [ ] Obsidian in: index vault markdown as `semantic` docs — **excluding agent-kb's own output**
      (its output folder + any note with `generator: agent-kb` frontmatter). Otherwise the kb
      re-ingests its own summaries as if the user wrote them and ranks them as truth.
- [ ] Every note agent-kb writes carries `generator: agent-kb` frontmatter, so the exclusion survives the user moving notes.
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
