# agent-kb — parity with the current kb

Target: **agent-kb alone does everything the current kb does today**, on both install routes
(Claude Code plugin and the Desktop `.mcpb`), with no Python and no LaunchAgents.
Today's kb = `~/.claude/scripts/kb-*.py`, `~/.claude/hooks/{session-start,user-prompt}-kb-inject.py`,
`~/.claude/hooks/session-end.sh`, `~/.claude/kb/` (markers + curated notes), `~/.claude/kb.sqlite`
(318 MB, 25k docs) and two LaunchAgents (daily backfill 10:00, bi-weekly transcript prune).

Rule for every slice: it ships with a check that fails on the old code, and the Python script it
replaces is **frozen in the same commit** (left runnable, no edits) and deleted one release later.
A slice is not done until its behaviour is visible through `kb_query` or the vault, not only in tests.

## What the current kb does

| Component | Behaviour | Cadence |
|---|---|---|
| `kb-index.py` | indexes workspace `CLAUDE.md` / `AGENTS.md` / `README.md` / `docs/*.md` / `.claude/{skills,commands,agents}` per repo; `~/.claude/{CLAUDE.md,skills,commands,agents,plans,references,scheduled-tasks,hooks}`; `~/.claude/projects/*/memory/*.md`; vault `daily/ news/ worklog-drafts/ templates/ Welcome.md`; concept notes' human section only. sha256-skip, 512 KB cap | every SessionEnd, plus 10:00 |
| `kb-graph.py` | entity/edge tables over `documents` (regex + `source_path` parsing): ticket, PR, repo, confluence page; `build`/`query`/`stats`/`path` | 24 h (worker-gated) |
| `kb-concept-export.py` | renders `concepts/{tickets,repos}/<label>.md` with a `kb:generated` fenced region rebuilt each run and a human `## Notes` section that survives and is the only part indexed back | 24 h |
| `kb-session-end-worker.py` | Haiku summary per session (8 doc sections), journal lines `DAILY/LEARNED/SEARCHED/FRICTION`, appends them into `second-brain/daily/<today>.md` (4 headings, `[ticket]`/`[agent]` prefixes, `[[TICKET]]` links, per-session dedupe suffix, `tickets:` front matter union); writes `session_learning` and `session_friction` docs; runs index → jira/confluence incremental → graph → concept export → distill → conflicts | every SessionEnd |
| `kb-precompact-worker.py` | snapshots and summarizes the transcript window compaction discards (own `source_path` per window) | every PreCompact |
| `kb-hermes-*` | same capture for Hermes (omp) sessions out of `~/.hermes/state.db`, plus a sweeper for sessions whose hook never fired | hook + sweep |
| `kb-conflicts-scan.py` | Haiku judge: newer authored doc vs its FTS neighbours → `kb_conflicts` (proposed/confirmed/dismissed); the inject hooks demote the loser and label it ⚠ | 6 h |
| `kb-learn-distill.py` | distils `session_friction` docs into one-line rules, rewrites a managed block in `~/.claude/learned-proposals.md` | 24 h |
| `kb-jira-backfill.py` | tickets from session refs + `git log` + JQL (assignee/reporter, 365 d) | daily incremental (3 d window) |
| `kb-github-backfill.py` | PRs authored by Loc in the org + reviews, inline comments, conversation | daily incremental |
| `kb-confluence-backfill.py` | pages of selected spaces, full body → `confluence_page` | daily incremental |
| `kb-backfill-transcripts.py` | Haiku summaries for history (tier 1), idempotent | on demand |
| `kb-prune-transcripts.sh` | deletes `.jsonl` older than 90 d that already have a summary; 13-day cooldown | weekly LaunchAgent |
| `kb-query.sh` / `kb-resume.py` | RRF search (k=60) + tier weight + 90-day episodic decay + per-type cap + conflict demotion; resume/fork commands | on demand |
| `session-start-kb-inject.py` | once per session, cwd-relevant recall | SessionStart |
| `user-prompt-kb-inject.py` | per prompt, ≤4 prompt-relevant hits, trust directive | UserPromptSubmit |

Document types in use: `session_summary`, `session_learning`, `session_friction`, `session_precompact`,
`session_skip`, `memory`, `curated`, `concept_note`, `daily_note`, `worklog_draft`, `news`, `template`,
`vault_doc`, `claude_md`, `agents_md`, `readme`, `arch_doc`, `plan`, `reference`, `custom_skill`,
`custom_command`, `custom_agent`, `scheduled_task`, `hook`, `jira_ticket`, `pr_body`, `confluence_page`.
Tier: procedural (rules/workflows), semantic (durable facts), episodic (time-bound, age-decayed).

## Where agent-kb stands

Already at parity: transcript capture (Claude Code, Desktop Code tab, Cowork), delta slicing with
cursors, redaction, the summarizer backends, chat-export import, `kb_save`, search with tier weight /
episodic decay / per-type cap / verbatim check, resume + fork, vault notes out (`sessions/`,
`projects/`, daily link index) and vault notes in, MCP tools `kb_query` `kb_get` `kb_resume` `kb_fork`.

Not there yet: every row of the table above except capture, search and resume.

## Slices

| # | Slice | Replaces | Acceptance check |
|---|---|---|---|
| S1 ✅ | Static-source indexer: workspace / global / memory / vault categories / curated, `kind` + content hash, `agent-kb index` | `kb-index.py` | `kb_query` answers a question whose only answer is in a service `CLAUDE.md`, a memory note, and a `daily/` note; a second run reports 0 changed |
| S2 ✅ | Retrieval parity: RRF k=60, tier bonus, episodic 90-day decay, per-type caps, conflict demotion + ⚠ label; SessionStart cwd recall and UserPromptSubmit prompt recall through the plugin hook | `kb-query.sh`, both inject hooks | a prompt naming a past ticket surfaces its summary in `additionalContext`; a doc flagged as superseded is demoted and labelled |
| S3 ✅ | Session doc + journal parity: the 8 doc sections, journal lines, `session_learning`/`session_friction` docs, daily merge writer | `kb-session-end-worker.py` (journal half) | one session end appends bullets under the 4 headings of `<vault>/daily/<today>.md`, `[[TICKET]]` linked, `tickets:` unioned, rerun appends nothing |
| S4 | Graph: `kb_entities` / `kb_doc_entities` / `kb_edges`, build from documents, `kb_graph` tool (`build/query/path/stats`) | `kb-graph.py` | `kb_graph('ticket:CH-…')` returns its PRs, repos and related tickets |
| S5 | Concept export: `concepts/{tickets,repos}` with fenced region + preserved human notes, only the human part re-indexed | `kb-concept-export.py` | a ticket worked today has a note with its PRs; text typed under `## Notes` survives the next export and is found by `kb_query` |
| S6 | Conflicts scan + learn distill: `kb_conflicts`, judge, demotion penalties, managed block in `learned-proposals.md` | `kb-conflicts-scan.py`, `kb-learn-distill.py` | a deliberately contradicted pair is proposed once and the loser is demoted at recall |
| S7 | Backfills: Jira (session refs + git log + JQL), GitHub PRs, Confluence pages, incremental windows, daily scheduler inside the plugin | 3 backfill scripts + daily LaunchAgent | after one run, `kb_query` finds a Jira ticket, a PR body and a Confluence page that were never in a session |
| S8 | Capture breadth: PreCompact window snapshots, Hermes adapter + sweep, transcript prune with retention, event-ts backfill | `kb-precompact-worker.py`, `kb-hermes-*`, `kb-prune-transcripts.sh` | a compacted session keeps the discarded window as its own doc; an omp session is captured without a hook |
| S9 | Migration + retirement: import the 25k docs of `~/.claude/kb.sqlite` into the agent-kb store, one DB, Python scripts and LaunchAgents removed, README/PLAN/DISCLOSURE updated | everything above | `kb_query` returns the same top hits for 10 sampled queries before and after the import; `~/.claude/scripts/kb-*.py` deleted |

Order is dependency order, not value order: S1 feeds S4, S4 feeds S5 and S6, S3 feeds S6.
S1 + S2 make the brain usable on their own; S3 is what the daily note needs.

## Must not be lost in the move

- 9,274 session summaries, 1,378 friction / 1,263 learning docs, 563 memory docs, 189 daily notes,
  1,886 Jira tickets, 621 PRs, 5,070 Confluence pages, 1,898 arch docs.
- The human text under `## Notes` in `concepts/`, and every hand-edited field in `daily/` notes.
- `~/.claude/kb.sqlite` stays untouched and readable until S9's import is verified, then archived.

## Out of scope

`/learn-distill`'s review step stays a human decision; `wiki/` stays agent-authored by the `wiki` skill
(agent-kb indexes it, never writes it); Mandarin vault notes are indexed but never generated.
