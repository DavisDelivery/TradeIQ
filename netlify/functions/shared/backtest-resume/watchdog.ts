// Phase 4e-1-infra — wall-clock budget watchdog.
//
// Netlify Background Functions hard-kill at 15-min wall-clock with no
// grace period. We need to self-terminate well before that so the cursor
// + reinvoke can write cleanly: a 13-min budget leaves ~90s for the
// terminal Firestore write + the reinvoke fetch.
//
// The watchdog is a thin wrapper over setTimeout. The bg-function's batch
// loop checks `isExpired()` after each rebalance and breaks out early if
// the budget is up, committing the partial batch's progress to Firestore
// before reinvoking. This guards against per-rebalance compute being
// slower than the planned average (e.g., Polygon throttling, a slow
// scoring call) and silently blowing past the ceiling.

export interface Watchdog {
  /** Begin the budget timer. Idempotent — repeated calls reset the clock. */
  start(): void;
  /** Cancel the pending timer. Safe to call multiple times. */
  stop(): void;
  /** True once the budget has expired (and remains true thereafter). */
  isExpired(): boolean;
}

/**
 * Create a watchdog with a budget and a one-shot expiry callback.
 *
 * The callback fires at most once even if the timer somehow re-arms.
 * Once expired, `isExpired()` returns true permanently — the bg-function
 * uses this as a sticky break signal in its batch loop.
 */
export function createWatchdog(
  budgetMs: number,
  onExpiry: () => void,
): Watchdog {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let expired = false;
  let fired = false;

  return {
    start(): void {
      if (timer !== null) clearTimeout(timer);
      expired = false;
      fired = false;
      timer = setTimeout(() => {
        expired = true;
        timer = null;
        if (!fired) {
          fired = true;
          try {
            onExpiry();
          } catch {
            // Callback errors must not crash the timer chain; the bg-function
            // checks isExpired() and will handle the break-out itself.
          }
        }
      }, budgetMs);
    },
    stop(): void {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    },
    isExpired(): boolean {
      return expired;
    },
  };
}
