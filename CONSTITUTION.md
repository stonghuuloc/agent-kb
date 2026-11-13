# agent-kb Constitution

What agent-kb will and won't build. Every spec or plan reads this first and cites a principle by
number, or states the deviation. `docs/PLAN.md` holds the roadmap and the measured details; this
file holds the rules that roadmap must keep.

## Principles

1. **Local-first.** The knowledge base is one SQLite file in the user data dir. No account, no
   sync service, no server agent-kb operates.
2. **Redaction before every write and every model call.** Secrets are removed by deterministic
   rules (patterns + entropy), never by a model. No write path skips `upsertDoc`'s redaction.
   If redaction throws, the write throws and nothing is stored.
3. **The only data that leaves the machine** is redacted transcript text, sent to the model
   provider the user configured. Anything new that leaves it is a deviation and needs a first-run
   disclosure.
4. **Summaries are opt-in and spend is explicit.** No model call without `AGENT_KB_SUMMARIZER`
   set; a bulk run prints its estimate and needs `--yes`. Backfill is offered, never silent.
5. **Hooks accelerate, sweeps guarantee.** Capture depends on what changed on disk, never on a
   session ending. A hook is a fast path; a session it misses is still caught by the next sweep.
   (The sweeper timer and SessionEnd hook land with PR #7.)
6. **Never summarize the same bytes twice.** Every summary advances a per-transcript cursor;
   `sweep` and `summarize` share it (the SessionEnd hook will, with PR #7). Tier-0 backfill uses scans, not cursors.
7. **Fail without loss.** A failed call keeps its cursor; a call that outlived its lock writes
   nothing; one process sweeps at a time. Losing extra text is acceptable, leaking a secret or
   double-writing is not.
8. **Models never decide anything destructive.** Redaction, deletion and overwrites are rule-based.
   An optional model judge switches on only at AUC ≥ 0.85 on the user's own corrections.
9. **The kb never ingests its own output as user writing.** Notes agent-kb writes carry
   `generator: agent-kb` and are excluded from the Obsidian-in index.
10. **Shipped means tested.** Each adapter has a fixture test and a live check on a real machine;
    an untested adapter does not ship.

## Boundaries

- In scope: capture, redaction, summarization and search of agent sessions the user's own
  machine can read (transcript files, Claude's data export, `kb_save`); resume commands; Obsidian
  out and in.
- Out of scope: scraping internal claude.ai APIs with a session cookie; reading Desktop's web
  cache; fetching export links headless (the signed-in browser opens them); importing
  `users.json` or other PII with no kb value.
- Forbidden patterns:
  - Native dependencies. Storage is built-in `node:sqlite`; runtime is Node ≥ 22.13.
  - Floating dependency versions (`^`, `~`) in `package.json`.
  - fs watchers as the source of truth (polling `stat` is; a watcher may only mark files dirty).
  - A command touching the data dir before its usage is validated; a newer schema is refused
    (exit 3), never migrated down.
  - Real-format secrets committed in fixtures; tests generate them at run time.

## Non-functional baseline

- A sweep tick costs one `stat` per transcript; only changed, idle files are read.
- Redaction is linear time; the test caps adversarial input at 500 ms per 200 KB.
- A model input is at most 60K chars after redaction; a slice is at most 50K chars.
- The sweeper's timers never keep the host process alive, and a tick never overlaps itself (PR #7).

## Domain vocabulary

- **Transcript** = one session file on disk (or one chat in an export). **Session** = the
  conversation it records.
- **Doc** = one row in `documents`, keyed by `source_path`. A transcript has one tier-0 doc and
  zero or more slice docs.
- **Slice** = the part of a transcript summarized in one model call; its doc is `<path>#wN`.
- **Cursor** = byte offset up to which a transcript is summarized. **Scan** = size + mtime at the
  last tier-0 index; it is not a cursor.
- **Tier 0 / tier 1** = indexing without / with a model call. Not the same as a doc's **kind**
  (`episodic` / `semantic` / `procedural`, stored in the `tier` column).
- **Sweep** = one pass over all adapters. **Tick** = one timer-started sweep, claimed across
  processes (PR #7).
- **Idle** = no growth for 20 min. **Finished** = idle for 6 h.
- **Adapter** = the reader for one host's storage: `claude-code` today; `claude-desktop-code`,
  `claude-cowork` and `claude-chat` are on the phase-4 branches.
- **Gone** = the host deleted the transcript; its docs stay searchable with `transcript_gone` set.
