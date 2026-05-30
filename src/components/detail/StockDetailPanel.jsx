// Phase 6 W2 — StockDetailPanel: the comprehensive stock detail orchestrator.
//
// Top-level panel rendered inside the MasterDetail container (full-screen
// modal on mobile, docked side panel on desktop ≥1280px). Accepts a `board`
// ('williams' | 'lynch' | 'target') and a `ticker`, picks the matching
// strategy-rationale endpoint, and also pulls the shared stock-detail bundle.
//
// PR-B shipped the SHELL: the hero + the server-generated thesis. PR-C adds
// the price + relative-strength charts in place of their stubs; PR-D will
// land fundamentals, PR-E will land metrics / catalysts / risks / score
// breakdown. The section order is the brief's 30-second-scan order:
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
import { SectionStub } from './SectionStub.jsx';
import { DetailPriceChart } from './DetailPriceChart.jsx';
import { RelativeStrengthChart } from './RelativeStrengthChart.jsx';

export function StockDetailPanel({ board, ticker, row }) {
  const isWilliams = board === 'williams';
  const isLynch = board === 'lynch';
  const isTarget = board === 'target';

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
  const thesis = isTarget
    ? (row?.rationale ?? null)
    : (rationale?.thesis ?? null);
  const thesisLoading = !isTarget && rationaleQuery.isLoading;
  const thesisError = !isTarget && rationaleQuery.isError;

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

      <ThesisParagraph
        thesis={thesis}
        loading={thesisLoading}
        error={thesisError}
        onRetry={() => rationaleQuery.refetch()}
      />

      <DetailPriceChart ticker={ticker} />
      <SectionStub title="Key Metrics" arrivesIn="PR-E" />
      <RelativeStrengthChart ticker={ticker} />
      <SectionStub title="Fundamentals" arrivesIn="PR-D" />
      <SectionStub title="Catalysts" arrivesIn="PR-E" />
      <SectionStub title="Risk Callouts" arrivesIn="PR-E" />
      <SectionStub title="Score Breakdown" arrivesIn="PR-E" />
    </div>
  );
}
