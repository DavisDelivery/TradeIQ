// Phase 6 W2 — StockDetailPanel: the comprehensive stock detail orchestrator.
//
// Top-level panel rendered inside the MasterDetail container (full-screen
// modal on mobile, docked side panel on desktop ≥1280px). Accepts a `board`
// ('williams' | 'lynch' | 'target') and a `ticker`, picks the matching
// strategy-rationale endpoint, and also pulls the shared stock-detail bundle.
//
// PR-B ships the SHELL: the hero + the server-generated thesis are real; the
// seven content sections below are staged stubs (their final components land
// in PR-C charts, PR-D fundamental charts, PR-E metrics/catalysts/risks/score
// breakdown). The section order here is the final 30-second-scan order from
// the brief: Price chart → Key metrics → Relative strength → Fundamentals →
// Catalysts → Risk callouts → Score breakdown.
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

const SECTIONS = [
  { title: 'Price Chart', arrivesIn: 'PR-C' },
  { title: 'Key Metrics', arrivesIn: 'PR-E' },
  { title: 'Relative Strength', arrivesIn: 'PR-C' },
  { title: 'Fundamentals', arrivesIn: 'PR-D' },
  { title: 'Catalysts', arrivesIn: 'PR-E' },
  { title: 'Risk Callouts', arrivesIn: 'PR-E' },
  { title: 'Score Breakdown', arrivesIn: 'PR-E' },
];

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

      {SECTIONS.map((s) => (
        <SectionStub key={s.title} title={s.title} arrivesIn={s.arrivesIn} />
      ))}
    </div>
  );
}
