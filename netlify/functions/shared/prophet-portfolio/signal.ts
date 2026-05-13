// Phase 4e-1 — Pluggable RankingSignal.
//
// `compositeRankingSignal` (id: 'composite-v1') is the live ranker for
// 4e-1: it reads Prophet snapshots and returns top-N picks that pass
// the earnings-quality gate (`layers.fundamental.pass === true`).
//
// Phase 5b will add `mlRankingSignal` exporting the same RankingSignal
// interface. The rebalance function consumes the interface, so swapping
// signals is a one-line config change — no refactor.

import {
  latestSnapshot,
  snapshotBeforeDate,
  type BoardSnapshot,
  type UniverseKey,
} from '../snapshot-store';
import type {
  PortfolioUniverse,
  RankingResult,
  RankingSignal,
} from './types';

// Map portfolio universes to snapshot-store universe keys. Prophet writes
// to 'largecap' and 'russell2k' under board='prophet'.
function snapshotUniverseFor(universe: PortfolioUniverse): UniverseKey {
  return universe; // identical mapping today
}

type ProphetLayerEntry = {
  score?: number;
  pass?: boolean;
  details?: Record<string, unknown>;
  flags?: string[];
};

type SnapshotPick = {
  ticker: string;
  name?: string;
  sector?: string;
  composite?: number;
  conviction?: string | null;
  layers?: Record<string, ProphetLayerEntry>;
  _regime?: string;
};

function normalizeLayers(
  raw: Record<string, ProphetLayerEntry> | undefined,
): RankingResult['layers'] {
  if (!raw) return {};
  const out: RankingResult['layers'] = {};
  for (const [k, v] of Object.entries(raw)) {
    out[k] = {
      score: typeof v?.score === 'number' ? v.score : 0,
      pass: v?.pass === true,
    };
  }
  return out;
}

function normalizeRegime(r: string | undefined): RankingResult['regime'] {
  if (r === 'risk_on' || r === 'risk_off') return r;
  return 'neutral';
}

/**
 * Pure transform: snapshot → top-N RankingResults. Extracted so the
 * backtest harness can feed in synthetic snapshots without going
 * through Firestore.
 */
export function pickFromSnapshot(
  snap: BoardSnapshot,
  opts: { topN: number; minComposite: number; signalId: string },
): RankingResult[] {
  if (!snap || !Array.isArray(snap.results)) return [];
  const results = snap.results as SnapshotPick[];
  const filtered = results
    .filter((p) => typeof p?.composite === 'number')
    .filter((p) => (p.composite as number) >= opts.minComposite)
    .filter((p) => p.layers?.fundamental?.pass === true)
    .sort((a, b) => {
      const ca = a.composite ?? 0;
      const cb = b.composite ?? 0;
      if (cb !== ca) return cb - ca;
      return (a.ticker ?? '').localeCompare(b.ticker ?? '');
    })
    .slice(0, opts.topN);

  return filtered.map((p) => ({
    ticker: p.ticker,
    name: p.name ?? p.ticker,
    sector: p.sector ?? 'Unknown',
    composite: p.composite as number,
    layers: normalizeLayers(p.layers),
    fundamentalPass: p.layers?.fundamental?.pass === true,
    regime: normalizeRegime(p._regime),
    signalId: opts.signalId,
  }));
}

export const compositeRankingSignal: RankingSignal = {
  id: 'composite-v1',

  async rankAtDate({ universe, asOfDate, topN, minComposite = 50 }) {
    const snapUniverse = snapshotUniverseFor(universe);
    // Backtest paths use snapshotBeforeDate; live paths can pass today's
    // date and effectively get the same answer (snapshotBeforeDate is
    // inclusive of end-of-day UTC on asOfDate).
    const snap =
      (await snapshotBeforeDate('prophet', snapUniverse, asOfDate)) ??
      (await latestSnapshot('prophet', snapUniverse));
    if (!snap) return [];
    return pickFromSnapshot(snap, {
      topN,
      minComposite,
      signalId: 'composite-v1',
    });
  },
};
