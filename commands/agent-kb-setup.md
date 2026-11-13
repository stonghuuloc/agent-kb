---
description: Set up agent-kb: check Node, choose sources, summaries and vault, backfill the index
allowed-tools: Bash(sh *hooks/run.sh*), Bash(AGENT_KB_SUMMARIZER=* sh *hooks/run.sh*), Bash(claude plugin configure *)
---

Set up agent-kb. Ask each question in turn, wait for the answer, and do not call a model-backed step without a clear yes.

## 0. Node check

Run `sh "${CLAUDE_PLUGIN_ROOT}/hooks/run.sh" check`. If it prints a hint (Node missing or older than 22.13), show it, tell the user the MCP server cannot start until Node >= 22.13 is installed, and stop.

## 1. Disclosure

Show this text exactly, then ask the user to confirm they want to continue:

**What agent-kb reads:** the transcripts of your coding-agent sessions on this machine (Claude Code, and the Claude Desktop Code tab and Cowork), plus chats you save or import yourself.

**What leaves this machine:** nothing, unless you turn summaries on. Then redacted transcript text goes to the model provider you chose: your own `claude` CLI account, or the Anthropic API with your key. Secrets are removed by fixed rules before any write and before any model call. With summaries on, new sessions are summarized automatically (idle sweeps and the session-end hook); a bulk run over past sessions asks first and shows its estimate.

**Where files are written:** one SQLite database in the agent-kb data directory (macOS `~/Library/Application Support/agent-kb`, Linux `~/.local/share/agent-kb`, Windows `%LOCALAPPDATA%\agent-kb`). With a vault directory set, Markdown notes go to `<vault>/<folder>/`. Nothing else is written.

## 2. Questions

1. **Sources.** Which of `claude-code`, `claude-desktop-code`, `claude-cowork` to read? Default: all (empty).
2. **Summaries.** Default `off` (index only, no model call). `claude` uses their claude CLI; `api` uses the Anthropic API.
3. **Vault directory and folder.** Optional Obsidian vault path, and the folder inside it (default `agent-kb`).
4. **API key.** Only when summaries = `api`. Never ask for the key in chat: tell the user to enter it in the `/plugin` configuration dialog for agent-kb.

## 3. Save

Save the answers as plugin options (non-sensitive only). Values are single-line strings:

`echo '{"summarizer":"off","sources":"","vault_dir":"","vault_folder":"agent-kb"}' | claude plugin configure agent-kb --values-stdin`

Fill in the user's answers. Then tell them to run `/reload-plugins` so the MCP server restarts with the new options.

## 4. Backfill

Offer, never run silently:

- **Tier 0 (no model, seconds):** index every transcript on disk. On a yes run `sh "${CLAUDE_PLUGIN_ROOT}/hooks/run.sh" cli backfill`.
- **Tier 1 (only if summaries are on):** run `AGENT_KB_SUMMARIZER=<their choice> sh "${CLAUDE_PLUGIN_ROOT}/hooks/run.sh" cli summarize` with no `--yes` to print the slice count and token estimate. Show it. Run again with `--yes` only after the user approves that estimate.

End by saying search works through the `kb_query` tool.
