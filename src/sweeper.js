import { claimTick, sweepOnce } from "./sweep.js";

export const INTERVAL_MS = 15 * 60_000;
// Lets the MCP handshake finish before the first tick reads transcripts.
const START_DELAY_MS = 10_000;
// Timers drift; a tick a little early must still win the claim.
const SLACK_MS = 60_000;

/**
 * The background sweeper of a long-lived process (the MCP server): a tick shortly after start,
 * then every `intervalMs`. Ticks never overlap, and across processes one tick per interval runs.
 * Errors go to `log`; the timers never keep the process alive. Returns `stop`.
 */
export function startSweeper(db, { summarize = null, intervalMs = INTERVAL_MS, startDelayMs = START_DELAY_MS, log = console.error, sweep = sweepOnce } = {}) {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      if (!claimTick(db, intervalMs - SLACK_MS)) return;
      const { s } = await sweep(db, { summarize });
      if (s?.failed) log(`agent-kb sweep: ${s.failed} failed${s.error ? ` (last error: ${s.error})` : ""}`);
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
