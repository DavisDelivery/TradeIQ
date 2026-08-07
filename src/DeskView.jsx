// DESK-1 W2 — the trader workstation tab.
//
// One dense, dark, desktop-first screen. Three regions at >=1280
// (useBreakpoint): left rail = market tape context + watchlist; center =
// focus ticker chart + evidence dossier; right rail = open positions +
// your base rates + earnings radar. Mobile: the same modules stacked,
// tape as a horizontal scroll strip.
//
// This tab presents EVIDENCE, not predictions. No AI call fires without
// an explicit button press (the dossier AI BRIEF tab is button-gated).
//
// Budget discipline: quote polling (15s tape / 30s watchlist+positions)
// pauses whenever the tab is hidden (TanStack focusManager +
// refetchIntervalInBackground:false → visibilityState-aware), sparing
// the Polygon budget.
//
// As of 2026-08-07 there are no signal chips: every ranking board has been
// retired for want of a measured edge, so there is nothing left to chip.

import React, { useEffect, useMemo, useState } from 'react';
import { Monitor } from 'lucide-react';
import { useBreakpoint } from './hooks/useBreakpoint.js';
import { useRegime } from './hooks/useRegime.js';
import { useLiveQuotes } from './hooks/useLiveQuotes.js';
import { useDeskStats } from './hooks/useDeskStats.js';
import { useEarningsRadar } from './hooks/useEarningsRadar.js';
import { readWatchlist } from './watchlist.js';
import { readLog } from './tradeLog.js';
import { isClosed } from './lib/baseRates.js';
import { AdvancedPriceChart } from './components/detail/AdvancedPriceChart.jsx';
import { TapeStrip } from './components/desk/TapeStrip.jsx';
import { WatchlistPanel } from './components/desk/WatchlistPanel.jsx';
import { DossierTabs } from './components/desk/DossierTabs.jsx';
import { PositionsPanel } from './components/desk/PositionsPanel.jsx';
import { BrokerPanel } from './components/desk/BrokerPanel.jsx';
import { BaseRatesPanel } from './components/desk/BaseRatesPanel.jsx';
import { EarningsRadarPanel } from './components/desk/EarningsRadarPanel.jsx';
import { Ticker } from './components/Ticker.jsx';

export function DeskView() {
  const { isDesktop } = useBreakpoint();
  const { data: regime } = useRegime();

  // ── watch state ──────────────────────────────────────────────────────
  const [watchTickers, setWatchTickers] = useState(() => readWatchlist().map((e) => e.ticker));
  const [openTickers, setOpenTickers] = useState(
    () => [...new Set(readLog().filter((t) => !isClosed(t)).map((t) => t.ticker))],
  );
  // Start with NO ticker focused — the app shouldn't auto-open a watchlist
  // stock on load. The user picks one from the watchlist to open the dossier.
  const [focusTicker, setFocusTicker] = useState(null);

  useEffect(() => {
    const onWatch = () => {
      const next = readWatchlist().map((e) => e.ticker);
      setWatchTickers(next);
      setFocusTicker((cur) => cur ?? next[0] ?? null);
    };
    const onLog = () =>
      setOpenTickers([...new Set(readLog().filter((t) => !isClosed(t)).map((t) => t.ticker))]);
    window.addEventListener('watchlist:change', onWatch);
    window.addEventListener('tradelog:change', onLog);
    return () => {
      window.removeEventListener('watchlist:change', onWatch);
      window.removeEventListener('tradelog:change', onLog);
    };
  }, []);

  // ── data ────────────────────────────────────────────────────────────
  // One quotes poll covers watchlist + open positions (dedup'd set).
  const quoteTickers = useMemo(
    () => [...new Set([...watchTickers, ...openTickers])],
    [watchTickers, openTickers],
  );
  const { quotesByTicker } = useLiveQuotes(quoteTickers);
  const { statsByTicker, isLoading: statsLoading } = useDeskStats(watchTickers);
  // Earnings proximity matters MOST for money already at risk, so this covers
  // open positions too — it was watchlist-only, which meant a position you held
  // but had not also starred reported with no warning at all.
  const { radarByTicker } = useEarningsRadar(quoteTickers);

  // Signal chips are GONE. Target was removed when that board retired, and
  // prophet — the last remaining source — retired 2026-08-07 after its only
  // positive number turned out to be an artifact and its measurement could
  // not be completed. With no validated board left to derive one from, a
  // chip on a watchlist row would be decoration implying evidence.

  // ── modules ─────────────────────────────────────────────────────────
  const watchlist = (
    <WatchlistPanel
      statsByTicker={statsByTicker}
      statsLoading={statsLoading}
      quotesByTicker={quotesByTicker}
      radarByTicker={radarByTicker}
      focusTicker={focusTicker}
      onFocus={setFocusTicker}
    />
  );

  const focus = focusTicker ? (
    <div data-testid="desk-focus">
      <div className="flex items-baseline gap-2 mb-2">
        <Ticker symbol={focusTicker} board="desk" className="text-lg font-semibold font-mono text-neutral-100" />
        {statsByTicker[focusTicker]?.name && (
          <span className="text-[11px] text-neutral-500 truncate">{statsByTicker[focusTicker].name}</span>
        )}
        {statsByTicker[focusTicker]?.sector && (
          <span className="text-[9px] font-mono uppercase tracking-widest text-neutral-600 border border-neutral-800 px-1.5 py-0.5">
            {statsByTicker[focusTicker].sector}
          </span>
        )}
      </div>
      <AdvancedPriceChart ticker={focusTicker} />
      <DossierTabs ticker={focusTicker} />
    </div>
  ) : (
    <div data-testid="desk-focus-empty" className="border border-dashed border-neutral-800 p-10 text-center">
      <Monitor className="h-6 w-6 text-neutral-600 mx-auto mb-2" />
      <div className="text-[12px] font-mono text-neutral-500">
        Add a ticker to the watchlist and tap a row to focus it here.
      </div>
    </div>
  );

  const rightRail = (
    <div className="space-y-3">
      {/* Robinhood Agentic account snapshot (broker-sync) — hidden until
          the executor agent pushes the first sync. */}
      <BrokerPanel />
      <PositionsPanel
        quotesByTicker={quotesByTicker}
        focusTicker={focusTicker}
        onFocus={setFocusTicker}
      />
      <BaseRatesPanel />
      <EarningsRadarPanel
        radarByTicker={radarByTicker}
        focusTicker={focusTicker}
        onFocus={setFocusTicker}
      />
    </div>
  );

  // ── layout ──────────────────────────────────────────────────────────
  if (isDesktop) {
    return (
      <div data-testid="desk-view" className="max-w-[1920px] mx-auto">
        <TapeStrip regime={regime} />
        <div className="desk-grid grid gap-3 p-3">
          <div className="min-w-0">{watchlist}</div>
          <div className="min-w-0">{focus}</div>
          <div className="min-w-0">{rightRail}</div>
        </div>
      </div>
    );
  }

  // Mobile: stacked, tape stays a horizontal scroll strip.
  return (
    <div data-testid="desk-view" className="pb-8">
      <TapeStrip regime={regime} />
      <div className="p-3 space-y-3">
        {watchlist}
        {focus}
        {rightRail}
      </div>
    </div>
  );
}
