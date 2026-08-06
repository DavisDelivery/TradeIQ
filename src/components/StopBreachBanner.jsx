// STOP-1 — app-wide stop-breach strip.
//
// The watcher runs whether or not the app is open; this is the part that
// actually tells you. Putting it only in the Desk right rail would mean the
// notice is reachable only from the one tab you were already going to check —
// which is the same failure the tooltip had. It sits under the header on every
// view and taps through to the Desk.
//
// Deliberately renders NOTHING when there is nothing observed. A persistent
// "all clear" strip would be a claim the watcher cannot always support (see
// the stale case, which the Positions panel surfaces where the stops live).

import React from 'react';
import { ShieldAlert } from 'lucide-react';
import { useStopWatch } from '../hooks/useStopWatch.js';

export function StopBreachBanner({ onOpenDesk }) {
  const { breaches } = useStopWatch();
  if (!breaches.length) return null;

  const tickers = [...new Set(breaches.map((b) => b.ticker))];
  return (
    <button
      type="button"
      data-testid="stop-breach-banner"
      onClick={() => onOpenDesk?.()}
      className="w-full flex items-center gap-2 px-3 sm:px-6 py-2 border-b border-rose-500/30 bg-rose-500/10 text-left text-[12px] font-mono text-rose-300 hover:bg-rose-500/15 transition-colors"
    >
      <ShieldAlert className="h-3.5 w-3.5 flex-shrink-0" aria-hidden="true" />
      <span className="min-w-0 truncate">
        {/* "Observed at or below", never "stopped out" — the watcher samples
            every 15 minutes, so it knows where price was when it looked and
            nothing at all about what happened in between. */}
        <span className="font-semibold">{tickers.join(', ')}</span>{' '}
        observed at or below your stop
      </span>
      <span className="ml-auto flex-shrink-0 text-[10px] uppercase tracking-widest text-rose-400/70">
        Positions →
      </span>
    </button>
  );
}
