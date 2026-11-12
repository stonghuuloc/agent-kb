# agent-kb

Your coding-agent sessions, turned into a personal knowledge base you can search, resume and build on.

> **Status: design / pre-alpha.** Nothing is installable yet. See [docs/PLAN.md](docs/PLAN.md).

## Why

You spend hours a day with coding agents. Every decision, dead end and "oh, *that's* why"
lives in a transcript that you never open again. agent-kb collects those sessions from the
tools you already use, summarizes them locally into a searchable knowledge base, and hands
that context back to your agents — and to you, in Obsidian if you like.

## What it does (target v1)

| | |
|---|---|
| **Capture** | Watches session transcripts from Claude Code, Claude Desktop (Code tab, Cowork) and other harnesses via adapters. No "session end" required: an idle sweeper summarizes long-lived sessions in chunks. |
| **Summarize** | Each session becomes a short structured note (decisions, knowledge, files, open questions). Uses *your* model access: the `claude` CLI or your own API key. |
| **Redact** | Secrets are stripped by deterministic rules (patterns + entropy) **before** anything is sent to a model or written to disk. |
| **Search** | Local SQLite FTS5 with recency-aware ranking. Exposed to agents as an MCP server (`kb_query`, `kb_get`). |
| **Resume / fork** | Every session carries a resume command. Find a past session by what it was about, jump back into it, or fork it into a different harness with a handoff prompt. |
| **Obsidian** | Optional. Pick a vault: sessions and a daily journal are written as notes with frontmatter and `[[links]]`; your vault notes are indexed back into search. |

## Principles

- **Local-first.** Your knowledge base is a SQLite file on your machine. No account, no sync service.
- **Explicit about data flow.** The only thing that leaves your machine is redacted transcript text sent to the model provider *you* configured, for summarization. Setup says so.
- **Hooks accelerate, sweeps guarantee.** End-of-session hooks are an optimization; a sweeper catches crashed, killed and never-closed sessions.
- **Judgment is measured, not assumed.** Optional model-based triage only switches on once it beats a threshold on your own corrections.

## Install

Not yet. Planned channels:

- Claude Code plugin marketplace: `/plugin marketplace add stonghuuloc/agent-kb`
- Claude Desktop extension (`.mcpb`) with an install form for vault folder, sources and keys

## License

MIT
