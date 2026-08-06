// STOP-1 (2026-08-06) — server-side stop watcher.
//
// WHY THIS IS SERVER-SIDE, AND WHY THAT IS THE WHOLE POINT.
// PositionsPanel already stores a `stop` per trade and computes an R-multiple
// against it, but nothing in the app ever compared price to it — and the stop
// itself was reachable only through a `title` tooltip, which does not exist on
// iOS touch. So on the owner's primary device the stop he recorded was
// literally unreadable and entirely unenforced.
//
// The obvious fix — colour the row when `last <= stop` — is NOT a watcher. The
// quote poll uses refetchIntervalInBackground:false, and iOS Safari suspends a
// backgrounded tab aggressively, so a client-side highlight can only ever
// appear while he is already staring at the panel. It structurally cannot see
// an intraday move through the stop that recovers before he next looks.
//
// This runs on a schedule instead. It samples during market hours whether or
// not the app is open, and records the FIRST time a breach was observed. That
// difference is the entire value: "AAPL traded at or below your 190.00 stop —
// first seen 14:32 ET" is a fact the UI cannot reconstruct after the fact.
//
// HONESTY CONSTRAINTS, deliberately encoded:
//   - It reports what it OBSERVED, never what happened. A poll samples; it
//     does not tick. Between samples anything can occur, so the event says
//     "observed at or below" and carries the sample time, and callers must not
//     render it as "stopped out".
//   - A missing or failed quote is NEVER a breach. Silence is not evidence.
//   - Re-arming works: the event is keyed by (tradeId, stop), so moving a stop
//     starts a fresh watch rather than inheriting a stale breach.

export interface WatchedTrade {
  id: string;
  ticker: string;
  loggedPrice?: number | null;
  shares?: number | null;
  stop?: number | null;
  side?: string | null;
  pending?: boolean;
  exitPrice?: number | null;
  exitAt?: string | null;
  isSellEvent?: boolean;
}

export interface StopBreachEvent {
  /** `${tradeId}:${stop}` — re-arms automatically when the stop is moved. */
  key: string;
  tradeId: string;
  ticker: string;
  stop: number;
  entry: number | null;
  /** The quote that triggered it. */
  observedPrice: number;
  /** When the WATCHER saw it — not when the market traded there. */
  firstObservedAt: string;
  lastObservedAt: string;
  /** Lowest price the watcher has sampled since the breach began. */
  lowestObserved: number;
  /** Samples taken at or below the stop. 1 = seen once, could be noise. */
  observations: number;
}

const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/**
 * Trades this watcher is responsible for.
 *
 * Excludes, in each case because including them would produce a false alarm:
 *   - closed positions (an exit is already recorded)
 *   - sell events (an exit, not a holding)
 *   - PENDING orders — broker docs are written at order placement, so an
 *     armed protective stop is itself a pending sell. Watching one would
 *     mean alerting that your stop is at your stop.
 *   - anything without a usable stop
 */
export function selectWatchedTrades(trades: WatchedTrade[]): WatchedTrade[] {
  return (trades || []).filter((t) => {
    if (!t || typeof t.ticker !== 'string' || !t.ticker) return false;
    if (t.pending === true) return false;
    if (t.isSellEvent === true || t.side === 'sell') return false;
    if (num(t.exitPrice) && t.exitAt) return false; // already closed
    if (!num(t.stop) || t.stop <= 0) return false;
    if (num(t.shares) && t.shares <= 0) return false; // short/closed lot
    return true;
  });
}

/**
 * Compare the watched trades against a quote map and fold the result into the
 * previously-stored events.
 *
 * `quotes` maps UPPERCASE ticker -> last price. A ticker ABSENT from the map
 * is skipped entirely: a provider outage must never read as a breach, and an
 * existing event for that ticker is carried forward untouched rather than
 * being "confirmed" by data we do not have.
 */
export function foldBreaches(
  watched: WatchedTrade[],
  quotes: Record<string, number | null | undefined>,
  prior: StopBreachEvent[],
  nowIso: string,
): { events: StopBreachEvent[]; opened: StopBreachEvent[]; cleared: string[] } {
  const priorByKey = new Map(prior.map((e) => [e.key, e]));
  const events: StopBreachEvent[] = [];
  const opened: StopBreachEvent[] = [];

  for (const t of watched) {
    const stop = t.stop as number;
    const key = `${t.id}:${stop}`;
    const last = quotes[t.ticker.toUpperCase()];

    if (!num(last) || last <= 0) {
      // No usable quote. Preserve any existing event verbatim — do not
      // extend, clear, or "re-observe" it on data we never received.
      const carried = priorByKey.get(key);
      if (carried) events.push(carried);
      continue;
    }

    if (last > stop) continue; // above the stop: nothing to report

    const existing = priorByKey.get(key);
    if (existing) {
      events.push({
        ...existing,
        observedPrice: last,
        lastObservedAt: nowIso,
        lowestObserved: Math.min(existing.lowestObserved, last),
        observations: existing.observations + 1,
      });
    } else {
      const fresh: StopBreachEvent = {
        key,
        tradeId: t.id,
        ticker: t.ticker.toUpperCase(),
        stop,
        entry: num(t.loggedPrice) ? t.loggedPrice : null,
        observedPrice: last,
        firstObservedAt: nowIso,
        lastObservedAt: nowIso,
        lowestObserved: last,
        observations: 1,
      };
      events.push(fresh);
      opened.push(fresh);
    }
  }

  // Anything in `prior` that did not survive into `events` is cleared, and the
  // caller must delete it. Two distinct routes get here and BOTH matter:
  //   - the trade is gone (closed, exited) or its stop moved, so the key retired
  //   - the trade is still watched but price RECOVERED above the stop
  // Deriving this from the surviving events rather than from `liveKeys` is what
  // catches the recovery case; keying off the trade list alone left a recovered
  // position showing a permanent red banner with no way to retract it.
  //
  // Note this deliberately does NOT clear an event carried through a missing
  // quote — those are pushed into `events` above, so they survive an outage.
  const survived = new Set(events.map((e) => e.key));
  const cleared = prior.filter((e) => !survived.has(e.key)).map((e) => e.key);
  return { events, opened, cleared };
}

/**
 * True when the scheduled watcher is expected to be sampling.
 *
 * This exists because "zero breaches" and "the cron is dead" look identical
 * from the outside, and the first reads as reassurance. Freshness can only be
 * judged inside the window the watcher actually runs in — overnight silence is
 * correct behaviour, not a fault — so the read endpoint gates its staleness
 * claim on this rather than implying a dead watcher every evening.
 *
 * Mirrors CRON = '0,15,30,45 13-20 * * 1-5' in scan-stop-watch.ts. Keep the
 * two in step: a wider cron with this unchanged would under-report staleness.
 */
export function isStopWatchWindow(now: Date): boolean {
  const h = now.getUTCHours();
  return h >= 13 && h < 21;
}

/**
 * One-line human summary. Phrased as an OBSERVATION with its sample time,
 * because that is all a poll can honestly claim.
 */
export function describeBreach(e: StopBreachEvent): string {
  const drop =
    e.entry != null && e.entry > 0
      ? ` (${(((e.observedPrice - e.entry) / e.entry) * 100).toFixed(1)}% vs entry ${e.entry})`
      : '';
  return (
    `${e.ticker} observed at or below your ${e.stop} stop — ` +
    `${e.observedPrice}${drop}, first seen ${e.firstObservedAt}`
  );
}
