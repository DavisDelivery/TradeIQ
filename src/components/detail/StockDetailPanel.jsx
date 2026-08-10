// Phase 6 W2 — StockDetailPanel: the comprehensive stock detail orchestrator.
//
// Top-level panel rendered inside the MasterDetail container (full-screen
// modal on mobile, docked side panel on desktop ≥1280px). Accepts a `board`
// ('williams' | 'lynch' | 'target') and a `ticker`, picks the matching
// strategy-rationale endpoint, and also pulls the shared stock-detail bundle.
//
// PR-B shipped the SHELL: hero + server-generated thesis. PR-C added price
// + relative-strength charts. PR-D added the fundamentals tab. PR-E lands
// the remaining stub-free sections: KeyMetricsPanel, CatalystsFeed,
// RiskCallouts, ScoreBreakdown. SectionStub is no longer imported.
// Section order is the brief's 30-second-scan order:
// Price chart → Key metrics → Relative strength → Fundamentals → Catalysts
// → Risk callouts → Score breakdown.
//
// Data path: all three rationale hooks are mounted but enabled-gated to the
// active board, so exactly one rationale fetch fires; useStockDetail is the
// single shared detail path (session-memoized, deduped — the same hook the
// PR-F FundamentalsStrip will reuse). Opening the same ticker twice never
// re-fetches.

import React from 'react';
import { useWilliamsRationale } from '../../hooks/useWilliamsRationale.js';
import { useLynchRationale } from '../../hooks/useLynchRationale.js';
import { useTargetRationale } from '../../hooks/useTargetRationale.js';
import { useStockDetail } from '../../hooks/useStockDetail.js';
import { StockDetailHero } from './StockDetailHero.jsx';
import { ThesisParagraph } from './ThesisParagraph.jsx';
import { SectorContextPanel } from './SectorContextPanel.jsx';
import { FablePillarsSection } from './FablePillarsSection.jsx';
import { TridentPillarsSection } from './TridentPillarsSection.jsx';
import { AdvancedPriceChart } from './AdvancedPriceChart.jsx';
import { RelativeStrengthChart } from './RelativeStrengthChart.jsx';
import { FundamentalsChart } from './FundamentalsChart.jsx';
import { KeyMetricsPanel } from './KeyMetricsPanel.jsx';
import { EarningsBehaviorPanel } from './EarningsBehaviorPanel.jsx';
import { TradabilityStrip } from './TradabilityStrip.jsx';
import { CatalystsFeed } from './CatalystsFeed.jsx';
import { RiskCallouts } from './RiskCallouts.jsx';
import { ScoreBreakdown } from './ScoreBreakdown.jsx';
import { ResearchPanel } from '../ResearchPanel.jsx';
import { CamilloPanel } from './CamilloPanel.jsx';
import { TradeTakenButton } from '../TradeTakenButton.jsx';
import { chartTheme } from '../../lib/chartTheme.js';

export function StockDetailPanel({ board, ticker, row }) {
  const isWilliams = board === 'williams';
  const isLynch = board === 'lynch';
  const isTarget = board === 'target';
  const isFable = board === 'fable'; // no server rationale — pillars section renders from the row
  const isVector = board === 'vector'; // event board — verdict renders in VectorView; no rationale endpoint
  const isTrident = board === 'trident'; // pillars render from the row; no rationale endpoint
  // Generic ticker (e.g. opened from Crosses / a bare table): no board score
  // or rationale exists, so show the universal, ticker-based sections plus an
  // on-demand AI brief, and skip the board-only score/risk panels.
  const isGeneric = !isWilliams && !isLynch && !isTarget && !isFable && !isVector && !isTrident;

  // Mount all three; enabled-gating means only the active board's endpoint is
  // hit (Rules of Hooks: call unconditionally, gate via `enabled`).
  const williams = useWilliamsRationale(ticker, { enabled: isWilliams });
  const lynch = useLynchRationale(ticker, { enabled: isLynch });
  const target = useTargetRationale(ticker, { enabled: isTarget });
  const rationaleQuery = isWilliams ? williams : isLynch ? lynch : target;

  const detailQuery = useStockDetail(ticker);

  const rationale = rationaleQuery.data ?? null;
  const detail = detailQuery.data ?? null;

  // williams/lynch carry a server-generated thesis string; the target board's
  // composite thesis lives on the board row (rationale endpoint returns the
  // per-analyst breakdown, not prose).
  const thesis = isFable || isVector || isTrident
    ? null
    : isTarget
      ? (row?.rationale ?? null)
      : (rationale?.thesis ?? null);
  const thesisLoading = !isTarget && !isFable && !isVector && !isTrident && rationaleQuery.isLoading;
  const thesisError = !isTarget && !isFable && !isVector && !isTrident && rationaleQuery.isError;

  return (
    <div className="space-y-4" data-testid="stock-detail-panel" data-board={board}>
      <StockDetailHero
        board={board}
        ticker={ticker}
        rationale={rationale}
        detail={detail}
        row={row}
        thesis={thesis}
      />

      {/* W2.1 — the tradability strip sits directly under the hero, above
          everything else. It is the CONSTRAINT on the trade (how much can I
          buy, how far does it move), and a constraint discovered after the
          thesis is a constraint discovered too late. */}
      <TradabilityStrip ticker={ticker} />

      {/* One-tap execution log — captures live price + timestamp at tap. */}
      <TradeTakenButton ticker={ticker} />

      {/* CAMILLO-1 — the judgment pass. Mounted here rather than in
          ScreensView so it appears on a Screens row AND on every other
          ticker detail from one component. It fires nothing until clicked;
          the endpoint spends Anthropic budget per call. */}
      <CamilloPanel ticker={ticker} universe={board === 'screens' ? 'russell2k' : 'sp500'} />

      {isVector ? null : isGeneric ? (
        // Generic ticker: on-demand AI brief in place of a board thesis.
        <ResearchPanel ticker={ticker} board={board || 'generic'} />
      ) : isTrident ? (
        // TRIDENT: F×T×I pillars + entry card + smart-money state at top.
        <TridentPillarsSection row={row} />
      ) : isFable ? (
        // FABLE: my pillars at the top (Chad's spec), then the full
        // investor profile. No server thesis/rationale endpoint.
        <FablePillarsSection row={row} />
      ) : (
        <ThesisParagraph
          thesis={thesis}
          loading={thesisLoading}
          error={thesisError}
          onRetry={() => rationaleQuery.refetch()}
          board={board}
        />
      )}

      <AdvancedPriceChart
        ticker={ticker}
        priceLines={
          (isFable || isTrident) && row?.entry?.pivot != null
            ? [
                { price: row.entry.pivot, color: chartTheme().accent, title: 'entry pivot' },
                { price: row.entry.stop, color: chartTheme().down, title: 'stop' },
              ]
            : []
        }
      />
      <KeyMetricsPanel ticker={ticker} />
      {/* W2.1 order: grouped stats -> earnings behaviour -> ownership ->
          sector. Sits directly under the stats it contextualises: the stats
          say what the business is, this says what holding it through a print
          has actually cost. */}
      <EarningsBehaviorPanel ticker={ticker} />
      {/* SECTOR-1 — sits directly above the relative-strength chart it gives
          context to: the table says how the sector is doing, the chart shows
          the path. */}
      <SectorContextPanel ticker={ticker} />
      <RelativeStrengthChart ticker={ticker} />
      <FundamentalsChart ticker={ticker} />
      <CatalystsFeed ticker={ticker} />
      {!isGeneric && <RiskCallouts board={board} ticker={ticker} />}
      {!isFable && !isVector && !isTrident && !isGeneric && <ScoreBreakdown board={board} ticker={ticker} />}
    </div>
  );
}
