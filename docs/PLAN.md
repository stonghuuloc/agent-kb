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
│   ├─ SessionStart → inject relevant context (open; the MCP server's startup tick does the sweep)
│   └─ SessionEnd   → summarize this session now, in a detached process (fast path only)
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
       each slice becomes its own doc (`<file>#w1`, `#w2` …) beside the tier-0 row,
       so a tier-0 rescan never overwrites a summary
```

- Default selection: last 30 days. Skipped → `agent-kb backfill [--since 90d]` later.
- Slices under 500 chars of conversation stay metadata-only (no model call) until the session grows.
- Backfill and sweeper share `cursors`, so bytes are never summarized twice.

### Retention trap

Host apps delete old transcripts on their own (Claude Code: `cleanupPeriodDays` — verify the
default before relying on it). Consequences:

- Backfill can only reach what is still on disk; tier 0 runs first so every surviving session gets a row.
- The sweeper must summarize before deletion. Summaries outlive transcripts; such sessions are
  marked `transcript_gone` and search shows them as deleted instead of a resume command.
  `resume_cmd` is kept, so the flag clears if the file comes back (an unmounted drive).
- Setup offers to raise the retention setting and states the disk cost.

### Claude Desktop surfaces

| surface | storage | capture |
|---|---|---|
| Chat | cloud only, nothing on disk | **no** — served read-only via MCP; README must say chat history is not captured |
| Code tab (local) | CLI-format transcript under `<config>/projects/`; metadata in Desktop's `claude-code-sessions/**/local_*.json` (`cliSessionId`, `cwd`, `title`, `lastActivityAt`) | yes — `claude-desktop-code` adapter |
| Cowork | Desktop's `local-agent-mode-sessions/**/local_<id>.json` (title) and `local_<id>/.claude/projects/*/*.jsonl` (CLI format; `audit.jsonl` beside it holds the same in SDK format) | yes — `claude-cowork` adapter |
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
- Content blocks seen: `text`, `thinking`, `tool_use`, `tool_result`, `injected_prompt_block`, `token_budget`. Index the user's `text` blocks only; thinking, tool calls and replies are not stored (the summary covers the reply side).
- `part` implies multi-part zips for large accounts → glob `<category>-*.zip`.

#### Import UX

The manifest is hostile to non-developers (email → JSON → four more links). The importer hides it:

```
agent-kb import <member-manifest-*.json | *.zip | folder>          (built)
  ├─ manifest → read the zips saved beside it; print the link of each one still missing; never fetch it headless
  └─ zips → tier 0 (no unzip to disk; claude.ai's summary, so no tier 1)

later
  ├─ manifest → open each export_url in the default (signed-in) browser
  └─ watch the downloads folder for <category>-*.zip, show "2/4 downloaded…"; timeout → "link expired? re-request"
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
- Known limits: the entropy rule needs upper + lower + digit, so lowercase-only random tokens rely on the format and `KEY=value` rules; ~2% of 32-byte base64 strings fall under its entropy bar. URL passwords holding a raw `/`, `?` or `#` are not found: RFC 3986 requires them percent-encoded, and treating them as password text erased dev URLs (`host:5173/@vite/client`). A digit-first URL password closed by the same bracket, quote or backtick that opened the URL (`(mysql://u:123)X@db)`) is read as a port. A YAML secret on the next line needs a digit or a block scalar (`|`, `>`); one after a blank line or as a list item is not found. A value with spaces, quoted or on a line of at most 128 chars, counts only when a digit touches a letter or symbol (`a9`, `2023!`) or four digits run together (`Winter 2025`), so passphrases of plain words or short numbers (`"correct horse battery"`, `"blue 42 sky"`) and non-ASCII ones (`"Pässwort 2024"`) are kept, like the labels `"Reset password"` and `"Must be at least 8 characters"`. The other way round, help text such as `"Use a1 or b2"`, `"8-64 characters"` or `"Changed on 2024-01-02"` is hidden, and an empty secret block (`password: |`) followed by a blank line hides the sibling keys at its own indent. Digits alone count as a secret under a strong name at any length (a PIN), so counts such as `secrets: 0` or `max_pass=3` are hidden too. An unquoted strong value runs to the next space, so `f(password=1234, user=1)` loses `user=1)` as well. Both lose text, never a secret. XML keys (`<password>1234</password>`) and backtick-quoted values (``password=`1234` ``) are not read by the name rules; only known token formats and long random values (entropy) are caught there. Space-separated flags are read for long names only (`--password X`); `mysql -p X` is not, because `-p` also means port or path. One YAML block of more than about a million lines overflows the regex stack: `redact` throws, so the document is not stored (the backfill counts it as failed) and nothing leaks; so does one unbroken token of several MB. Names are split on `_`, `.`, `-` and camelCase only, so a glued all-caps name (`PGPASSWORD=…`) is not recognised. A resume command that holds a secret (a cwd such as `/work/DB_PASSWORD=…`) is not stored, so that session has no resume line; the transcript path itself encodes the cwd with `=` turned into `-` and is stored as is. A multi-word value on a line over 128 chars keeps all but its first word, and ` #` always starts a comment (`password: Summer #2024!` keeps `#2024!`). A flag reads one word unless quoted (`--secret Summer 2024!` keeps `2024!`), and a first word that looks like a key (`password: x: Summer 2024!`) keeps the line.
- Done when: fixture suite passes (done); a transcript with planted secrets produces a summary without them (phase 3: the summarizer input is redacted; test `secrets are redacted before the model sees the slice`).

### 3. Summarizer + sweeper + backfill
- [x] Summarizer backends, opt-in via `AGENT_KB_SUMMARIZER=claude|api`: the user's `claude` CLI (`-p`, no tools, no MCP, no settings or hooks, `--no-session-persistence`, so a summary never becomes a transcript) or the Anthropic SDK with their key. Default model `claude-haiku-5-5`, `AGENT_KB_MODEL` overrides. Fixed note format: DECISIONS / KNOWLEDGE / FILES / OPEN, or `NOTHING`. Input is redacted before it is clipped to 60K chars.
- [x] Sweeper core (`agent-kb sweep`): idle ≥ 20 min, delta-only via `cursors` (whole lines only), one `#wN` doc per slice of at most 50K chars, so a long delta becomes several slices (one prompt or reply over 60K chars is still clipped head + tail). A lock in the store keeps two processes apart; each write renews it (never re-takes it) and checks the cursor is still where the slice started, in one transaction, so a call that outlived the lock writes nothing. A failed slice keeps its cursor and the file goes to the back of the queue for an hour; 3 failures in a row stop the run. A failure counts against a file only when another call in the same run worked, so an outage counts against none; 3 counted failures make the file wait a week. A finished session (idle 6 h) gets its last short slice summarized too. A transcript replaced at the same path (shorter, or a new inode) is read again from the start; its old `#wN` docs stay. A file rewritten in place with the same inode and no shrink is not detected (transcripts are append-only). A record over 32 MB (a tool payload) is skipped while reading. The sweep only reaches sessions changed since summaries were turned on (minus one day); history is `agent-kb summarize`.
- [x] Sweeper timer in the MCP server: a tick 10 s after start, then every 15 min. Every open session runs its own server, so a `last_tick` row lets one summarizing tick per interval run across processes (index-only servers claim `last_index_tick`, so they never starve it), and a tick never overlaps itself. `AGENT_KB_SWEEP=off` turns it off.
- [x] SessionEnd hook (`hooks/hooks.json`): starts a detached `agent-kb sweep --ended <transcript>` and returns at once; that sweep summarizes only this session, with no idle wait, and waits up to 10 min for a lock held by another sweep (several sessions closed at once). No-op when summaries are off or `AGENT_KB_SWEEP=off`. A path outside the config dirs is ignored. Our own `claude -p` call runs with `AGENT_KB_CHILD=1`, so the hook and MCP server stay idle in it. A Stop hook is not needed: the sweep reads size and mtime, so it already sees what changed. The hook goes live with the plugin manifest (phase 6).
- [ ] SessionStart: inject relevant context for the session's cwd.
- [x] Skip tiny slices without a model call; `NOTHING` advances the cursor without writing a doc.
- [x] Backfill tier 0: `agent-kb backfill` indexes each transcript's title and the user's own prompts (no model call; head + tail clipped to 32K chars). A `scans` row (size, mtime) skips unchanged files; it is not a summary offset. Measured: 5,206 transcripts, 5,194 indexed, second run all unchanged; that count was doubled by a profile dir whose `projects` links to `~/.claude/projects` (now listed once: 2,609 indexed).
- [x] Backfill tier 1: `agent-kb summarize [--since <N>d | --since all] [--limit N]` prints the slice count and input tokens; `--yes` runs it, newest first. Default: last 30 days. Resumable through `cursors`.
- [x] `transcript_gone` marking when a host app deletes a transcript (every `sweep`).
- Done when: a session left open for days is summarized in chunks without ever ending; a killed session is still captured; tier 0 makes every on-disk session searchable and resumable without a model call.

### 4. Adapters
- [x] `claude-code`: `<config>/projects/<project>/<session>.jsonl` (subagent transcripts excluded), scanning `CLAUDE_CONFIG_DIR` and `~/.claude`, or the `AGENT_KB_CLAUDE_DIRS` path list. Dirs whose `projects` is one folder on disk (a symlink) are listed once, under the dir that holds it for real, so paths do not depend on which profile's process runs. Rows indexed earlier under the linked path are folded into the real one; of the two sets of summaries, the one that got further through the transcript is kept. A session started under such a profile gets a resume command without its `CLAUDE_CONFIG_DIR`: the shared folder does not record which profile wrote it.
- [x] `claude-desktop-code`: the Code tab writes a normal CLI transcript (`entrypoint: claude-desktop`) into `~/.claude/projects`, so `claude-code` already indexes, summarizes and resumes it. Its title lives only in Desktop's `claude-code-sessions/<account>/<org>/local_<id>.json`; the adapter joins it by `cliSessionId` and the doc takes that title (re-indexed on a rename). Desktop dir: macOS `~/Library/Application Support/Claude`, Windows `%APPDATA%\Claude`, Linux `~/.config/Claude`, or `AGENT_KB_DESKTOP_DIR`. Live check (2026-11): 397 metadata files; 206 transcripts on disk, all titled from Desktop; 181 transcripts already deleted by retention (nearly all older than 30 days), and these get no row.
- [x] `claude-cowork`: Desktop keeps each session in `local-agent-mode-sessions/<account>/<org>/local_<id>.json` (title) beside `local_<id>/`. Inside, `audit.jsonl` (SDK stream format) and `.claude/projects/*/<cliSessionId>.jsonl` (CLI format) hold the same conversation (live check: 4 of 4 sessions, record counts within 2), so the adapter reads the CLI transcript with the `claude-code` reader and lists it as `claude-cowork` with the Desktop title. No resume command: Cowork runs in Desktop's VM; search says to open it in Desktop. Indexed, summarized and flagged gone like Claude Code sessions.
- [x] `claude-chat`: `agent-kb import <manifest | conversations-NNN.zip | memories-NNN.zip | folder>` reads the export with a built-in zip reader (stored or deflated entries; no zip64). Each chat becomes a doc of claude.ai's own summary plus the user's prompts on the active path (latest leaf up through `parent_message_uuid`; text blocks only), resumable by `https://claude.ai/chat/<uuid>`. Memory files and the conversations memory become `semantic` docs. A re-import skips a chat with the same `updated_at` and message count, and a memory with the same text (the conversations memory has no timestamp); a chat or memory that is empty now is removed. A folder is read at its top level, per category: its zips, else its unzipped JSON. A zip or file that cannot be read is reported and the rest imports. Given the manifest, it reads the zips saved beside it and prints the link of each one not downloaded yet; it does not open the browser or watch the downloads folder. `users.json` and artifact metadata are never read. Live check (2026-11): 45 chats, 15 memory docs; a second import reported 45 unchanged. No tier-1 summaries for chats (the summary is already there).
- [x] `kb_save` MCP tool: the chat model saves its own note (title, note, optional `chat_url`); one note per chat URL (`<url>#saved`, replaced on a later save), else one per distinct note. Redacted like every write.
- [ ] Compliance-API adapter (optional, Enterprise).
- [x] Each adapter yields transcript entries (`file`, `configDir`, `sourceType`, `title`, `resumable`); cwd, dates and the resume command come from the transcript in tier 0. Sources are auto-detected (a missing dir lists nothing) and individually toggleable: `AGENT_KB_SOURCES=claude-code,claude-desktop-code,claude-cowork` (unset = all; a typo is an error, and the MCP server then runs no background sweeps). A source turned off is not read; its docs stay. `agent-kb sources` shows each source, on or off, and what it finds.
- Done when: each adapter has a fixture test and a live check on a real machine. Untested adapters are not shipped.

### 5. Resume / fork
- [x] `resume_cmd` per session (e.g. `cd <cwd> && claude --resume <id>`, with the right config dir). Claude Code only so far.
- [ ] `kb_resume` / `kb_fork` MCP tools + CLI `agent-kb resume|fork <query>`; fork seeds the target harness with a handoff prompt (summary + transcript path + "re-check live state").
- [ ] Optional shell integration snippet (zsh/bash/fish).

### 6. Install UX + Obsidian
- [x] Claude Code: `.claude-plugin/plugin.json` + `marketplace.json` (the repo is its own marketplace; source `./`), `.mcp.json` server entry and `hooks/hooks.json`; `claude plugin validate . --strict` passes (only advice: no directory icon). `/agent-kb-setup` (`commands/`) checks Node, shows the disclosure, asks sources / summaries / vault / folder, saves the non-secret answers with `claude plugin configure agent-kb --values-stdin`, then offers tier-0 `backfill` and, only if summaries are on, a tier-1 estimate that needs a yes before `--yes`. Answers live in the plugin's own `userConfig` (Claude Code's settings; the API key in its credential store, entered in `/plugin`, never in chat): no second config file, and the data dir stays one SQLite file (Principles 1, 4). `hooks/run.sh` maps `CLAUDE_PLUGIN_OPTION_*` to `AGENT_KB_*` (an `AGENT_KB_*` already set wins). The MCP server runs `npm ci --omit=dev` into the plugin dir on its first start (3 deps, ~3-14 s; needs npm and network); the hook skips silently until that has happened. Live check: server through `run.sh` answered `initialize` from a clean copy.
- [x] Claude Desktop runs `.mcpb` servers on its built-in Node (Electron's; Desktop sets the version, the bundle cannot pin it). Measured 2026-11-13: Desktop 5.11492.2 ships Electron 45.2.1, whose binary embeds Node v24.22.1 (≥ 22.13; `node:sqlite` is built in from 22.5). Not run live: the app's `ELECTRON_RUN_AS_NODE` fuse is off, so the version comes from the binary's strings. `compatibility.runtimes.node: ">=22.13"` is set in `manifest.json`.
- [ ] Claude Code's native installer ships no Node, so a plugin that launches `node` fails with "command not found". `/agent-kb-setup` and a SessionStart hook written in shell (not Node) check `node --version`: missing or < 22.13 → one install line (the MCP server still fails to start; the hook says why). The SessionEnd hook gets the same shell guard, so it no-ops without Node instead of failing at every session end. [x] Done for `/agent-kb-setup` and SessionEnd: `hooks/run.sh` (`server | hook <name> | cli … | check`) prints one stderr line and exits 0 for hooks, 1 for the server; phase 5's SessionStart hook is one more `hooks.json` entry calling `run.sh hook session-start` (no wrapper change). Windows: `sh` is needed, so hooks and the MCP server need Git Bash; a Node-only launcher is not built. Single-file binaries (a Node single-executable app keeps `node:sqlite`) only if real installs show users without Node.
- [x] Claude Desktop: `manifest.json` (`server.type: node`, manifest 0.4) with `user_config`: vault directory picker, vault folder, sources, summarizer, API key (sensitive → OS keychain). `npm run pack:mcpb` stages the production files, runs `npm ci --omit=dev`, then `npx @anthropic-ai/mcpb@2.1.2 validate` and `pack`: 6.6 MB, 22 MB unpacked, 4,377 files; the unpacked bundle answered `initialize` and `tools/list`. Limits: sources is a comma-list text field (the only switch is `AGENT_KB_SOURCES`; per-source toggles need a src change); `AGENT_KB_VAULT` and `AGENT_KB_VAULT_FOLDER` are passed but nothing reads them until Obsidian out lands; not installed into Desktop.
- [ ] Obsidian out: session notes + daily journal into `<vault>/<folder>/` with frontmatter and `[[links]]`.
- [ ] Obsidian in: index vault markdown as `semantic` docs — **excluding agent-kb's own output**
      (its output folder + any note with `generator: agent-kb` frontmatter). Otherwise the kb
      re-ingests its own summaries as if the user wrote them and ranks them as truth.
- [ ] Every note agent-kb writes carries `generator: agent-kb` frontmatter, so the exclusion survives the user moving notes.
- [x] First-run disclosure: one text, `docs/DISCLOSURE.md`; `/agent-kb-setup`, the README and the `.mcpb` `long_description` carry it verbatim, and a test fails if any copy drifts.

### 7. Judge + replay gate (v1.1)
- [ ] One `judge` interface; backends `heuristic` (default), `claude`, `jev` (optional, own key).
- [ ] Judge points: capture triage (worth keeping?), conflict scan (do two notes contradict?), kind tagging.
- [ ] Log each judgment and the user's later correction (pin a skipped session, dismiss a conflict).
- [ ] `agent-kb eval` reports AUC per judge point; a point auto-enables only at AUC ≥ 0.85 on the user's own labels.
- Never: redaction, deletion or anything destructive decided by a model.

## Open questions
- Codex / OpenCode / omp adapters: ship only once a maintainer can live-test each.
- Remote capture sources with APIs (cloud agent platforms): separate optional adapters, keys via the install form.
