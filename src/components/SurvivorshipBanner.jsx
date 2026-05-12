import React from 'react';

// SurvivorshipBanner — gates off `universeStamp.corrected`.
//
// Phase 4a's whole honesty argument is: backtests on SP500/NDX use CURRENT
// constituents, which means delisted/acquired/dropped names are absent
// from the universe. Survivors win the lookback by construction; the
// reported alpha is inflated. This banner exists so users can't forget that
// when they're staring at a 0.224 Sharpe and wondering why it's not better.
//
// Render rule:
//   - corrected === true   → return null
//   - missing stamp        → return null (older runs without stamp don't show this)
//   - corrected === false  → red banner, full width, top of run detail.
// Do NOT soften the language. Do NOT hide the link to BACKTEST_LIMITATIONS.md.
// Do NOT make this dismissible.

export function SurvivorshipBanner({ universeStamp }) {
  if (!universeStamp) return null;
  if (universeStamp.corrected === true) return null;

  const universe = String(universeStamp.universe ?? 'this universe').toUpperCase();

  return (
    <div className="border border-rose-700/60 bg-rose-950/30 px-4 py-3 mb-4 rounded">
      <div className="flex items-start gap-3">
        <span aria-hidden="true" className="text-rose-400 text-lg leading-none">
          ⚠
        </span>
        <div className="flex-1 text-sm text-rose-200">
          <div className="font-semibold mb-1">Universe is not survivorship-corrected</div>
          <div className="text-rose-300/80 leading-relaxed">
            Backtest used current {universe} constituents only. Companies that delisted, got
            acquired, or dropped from the index over the backtest window are not represented.
            Results favor surviving stocks and overstate alpha. Treat with extreme caution.
            {' '}
            <a
              href="https://github.com/DavisDelivery/TradeIQ/blob/main/docs/BACKTEST_LIMITATIONS.md"
              target="_blank"
              rel="noopener noreferrer"
              className="underline hover:text-rose-100"
            >
              Limitations →
            </a>
          </div>
        </div>
      </div>
    </div>
  );
}
