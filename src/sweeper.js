import { FINAL_MS, claimTick, dailyUsed, sweepOnce } from "./sweep.js";
import { indexRoots } from "./indexer.js";

export const INTERVAL_MS = 15 * 60_000;
// Lets the MCP handshake finish before the first tick reads transcripts.
const START_DELAY_MS = 10_000;
// Timers drift; a tick a little early must still win the claim.
const SLACK_MS = 60_000;

// The timer only catches sessions whose SessionEnd/PreCompact hook never ran (a crash): idle as long as FINAL_MS.
// Each tick is capped, paced and stops at its first failure; a day has a ceiling.
// minChars: a slice under 3K chars is rarely worth a call, even from a finished session (strictMin); its hook or the session growing picks it up.
export const TICK_BUDGET = { idleMs: FINAL_MS, limit: 4, pauseMs: 60_000, maxFailures: 1, minChars: 3_000, strictMin: true };
export const DAILY_SLICES = 40;

/**
 * The background sweeper of a long-lived process (the MCP server): a tick shortly after start,
 * then every `intervalMs`. Ticks never overlap; across processes one summarizing and one index-only
 * tick per interval run.
 * Errors go to `log`; the timers never keep the process alive. Returns `stop`.
 */
export function startSweeper(db, { summarize = null, judges = null, intervalMs = INTERVAL_MS, startDelayMs = START_DELAY_MS, log = console.error, sweep = sweepOnce } = {}) {
  let running = false;
  let judgeErrors = 0;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      if (!claimTick(db, intervalMs - SLACK_MS, Date.now(), summarize ? "last_tick" : "last_index_tick")) return;
      // the day's count includes the hook runs, so a busy day leaves the timer less
      const budget = { ...TICK_BUDGET, limit: Math.max(0, Math.min(TICK_BUDGET.limit, DAILY_SLICES - dailyUsed(db))) };
      const { s, pinned, obsidian, dailyPending } = await sweep(db, { summarize, judges, index: indexRoots(), graph: true, budget });
      if (obsidian?.error) log(`agent-kb obsidian: ${obsidian.error}`);
      else if (obsidian?.out?.failed || obsidian?.in?.failed) log(`agent-kb obsidian: ${obsidian.out?.failed ?? 0} notes out and ${obsidian.in?.failed ?? 0} notes in failed`);
      if (s?.failed) log(`agent-kb sweep: ${s.failed} failed${s.error ? ` (last error: ${s.error})` : ""}`);
      if (judges && judges.errors > judgeErrors) {
        log(`agent-kb sweep: ${judges.errors - judgeErrors} judge failures (last error: ${judges.lastError})`);
        judgeErrors = judges.errors;
      }
      if (pinned?.failed) log(`agent-kb sweep: pinned slice failed (${pinned.error})`);
      if (!dailyPending?.off && dailyPending?.error) log(`agent-kb daily notes: ${dailyPending.left ?? 0} entries waiting${dailyPending.error ? ` (last error: ${dailyPending.error})` : ""}`);
    } catch (e) {
      log(`agent-kb sweep: ${e?.message ?? e}`);
    } finally {
      running = false;
    }
  };
  const first = setTimeout(tick, startDelayMs);
  const every = setInterval(tick, intervalMs);
  first.unref();
  every.unref();
  return { tick, stop: () => (clearTimeout(first), clearInterval(every)) };
}
