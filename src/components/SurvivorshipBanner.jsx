import React from 'react';
import { AlertTriangle } from 'lucide-react';

// Phase 4b — universe survivorship warning banner.
//
// Renders when (and only when) the backtest's universe is NOT
// survivorship-corrected. Phase 4a's whole honesty argument depends on
// this banner showing every single time someone looks at an SP500 or NDX
// run: the engine cannot rebuild historical index membership without the
// snapshot infrastructure those universes lack, so the run silently used
// current-day constituents — which means it skipped every company that
// dropped out, got acquired, or delisted over the backtest window.
// Results favor the survivors and overstate alpha. The banner says so
// in red and links to BACKTEST_LIMITATIONS.md for the long form.
//
// Rendering rules (all gated):
//   - universeStamp absent  → return null (run pre-dates the stamp field,
//                             or a malformed doc; either way, don't render
//                             a false-positive "this is fine" signal)
//   - corrected === true    → return null
//   - corrected === false   → render full banner
//
// The link points at the repo doc because that's the source of truth for
// the methodology + caveats; navigating away from the app to a markdown
// file on GitHub is a deliberate friction — it forces the user to read
// the limitations rather than glossing over an in-app tooltip.

export function SurvivorshipBanner({ universeStamp }) {
  if (!universeStamp || universeStamp.corrected) return null;
  const universeLabel = String(universeStamp.universe ?? '').toUpperCase() || 'UNIVERSE';
  return (
    <div
      role="alert"
      data-testid="survivorship-banner"
      className="border border-rose-700/60 bg-rose-950/30 px-4 py-3 mb-4 rounded"
    >
      <div className="flex items-start gap-3">
        <AlertTriangle className="h-5 w-5 text-rose-400 shrink-0 mt-0.5" aria-hidden="true" />
        <div className="flex-1 text-sm text-rose-200">
          <div className="font-semibold mb-1">
            Universe is not survivorship-corrected
          </div>
          <div className="text-rose-300/80 leading-relaxed">
            Backtest used current {universeLabel} constituents only.
            Companies that delisted, got acquired, or dropped from the index
            over the backtest window are not represented. Results favor
            surviving stocks and overstate alpha. Treat with extreme
            caution.{' '}
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
