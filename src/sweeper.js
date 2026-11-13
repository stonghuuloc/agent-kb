import { claimTick, sweepOnce } from "./sweep.js";

export const INTERVAL_MS = 15 * 60_000;
// Lets the MCP handshake finish before the first tick reads transcripts.
const START_DELAY_MS = 10_000;
// Timers drift; a tick a little early must still win the claim.
const SLACK_MS = 60_000;

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
      const { s, pinned, obsidian } = await sweep(db, { summarize, judges });
      if (obsidian?.error) log(`agent-kb obsidian: ${obsidian.error}`);
      else if (obsidian?.out?.failed || obsidian?.in?.failed) log(`agent-kb obsidian: ${obsidian.out?.failed ?? 0} notes out and ${obsidian.in?.failed ?? 0} notes in failed`);
      if (s?.failed) log(`agent-kb sweep: ${s.failed} failed${s.error ? ` (last error: ${s.error})` : ""}`);
      if (judges && judges.errors > judgeErrors) {
        log(`agent-kb sweep: ${judges.errors - judgeErrors} judge failures (last error: ${judges.lastError})`);
        judgeErrors = judges.errors;
      }
      if (pinned?.failed) log(`agent-kb sweep: pinned slice failed (${pinned.error})`);
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
