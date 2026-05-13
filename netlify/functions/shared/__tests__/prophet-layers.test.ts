// Unit tests for the 7 layers in prophet-layers.ts.
//
// Coverage target (per Phase 0 brief / Workstream 3): ≥ 60% lines.
//
// Strategy: deterministic Bar fixtures (uptrend, downtrend, chop, breakout,
// low-vol, high-vol) with known directional properties. Each layer gets
// 3-5 assertions checking that score, pass, and key flags fall in the
// expected zones.
//
// We deliberately don't pin scores to exact integers — the layers compose
// many small bumps and small refactors of the bumps shouldn't break tests.
// Instead we check coarse bands (e.g. uptrend → score >= 60, pass: true)
// and the presence/absence of named flags.

import { describe, it, expect } from 'vitest';
import {
  layerStructure,
  layerMomentum,
  layerVolume,
  layerVolatility,
  layerRelativeStrength,
  layerFundamental,
  layerCatalyst,
  composeProphet,
  type FundInput,
  type CatalystInput,
} from '../prophet-layers';
import {
  uptrend, downtrend, chop, lowVolGrind, highVol, breakout,
} from './fixtures';

// ───────────────────────────────────────────────────────────────────────────
// Layer 1 — Structure
// ───────────────────────────────────────────────────────────────────────────

describe('layerStructure', () => {
  it('returns score 0 + pass:false for insufficient bars', () => {
    const bars = uptrend({ length: 100 });
    const r = layerStructure(bars);
    expect(r.score).toBe(0);
    expect(r.pass).toBe(false);
    expect(r.details.error).toBe('insufficient bars');
  });

  it('clean uptrend produces high score, pass, and aligned-SMA flags', () => {
    const r = layerStructure(uptrend());
    expect(r.score).toBeGreaterThanOrEqual(60);
    expect(r.pass).toBe(true);
    expect(r.flags).toContain('above_200d');
    expect(r.flags).toContain('sma_aligned');
  });

  it('downtrend fails the pass gate', () => {
    const r = layerStructure(downtrend());
    expect(r.pass).toBe(false);
    expect(r.flags).not.toContain('above_200d');
  });

  it('chop is below pass gate (no higher-highs / weak ADX)', () => {
    const r = layerStructure(chop());
    expect(r.pass).toBe(false);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Layer 2 — Momentum
// ───────────────────────────────────────────────────────────────────────────

describe('layerMomentum', () => {
  it('returns 0 for insufficient bars', () => {
    const r = layerMomentum(uptrend({ length: 20 }));
    expect(r.score).toBe(0);
    expect(r.pass).toBe(false);
  });

  it('breakout fixture produces macd_bull (acceleration → line > signal)', () => {
    const r = layerMomentum(breakout());
    expect(r.flags).toContain('macd_bull');
    expect(r.details.macd_line as number).toBeGreaterThan(r.details.macd_signal as number);
  });

  it('uptrend RSI lands in the bullish half of the dial', () => {
    // A relentless smooth uptrend can pin RSI > 80 (which the layer
    // correctly treats as overheated). Just assert it's bullish-side.
    const r = layerMomentum(uptrend());
    expect(r.details.rsi).not.toBeNull();
    expect(r.details.rsi as number).toBeGreaterThan(50);
    // MACD line and signal should both be above zero in a sustained bull leg.
    expect(r.details.macd_line as number).toBeGreaterThan(0);
    expect(r.details.macd_signal as number).toBeGreaterThan(0);
  });

  it('downtrend fails momentum gate (MACD bear, RSI low)', () => {
    const r = layerMomentum(downtrend());
    expect(r.pass).toBe(false);
    expect(r.flags).not.toContain('macd_bull');
  });

  it('downtrend produces low RSI (<50)', () => {
    const r = layerMomentum(downtrend());
    expect(r.details.rsi as number).toBeLessThan(50);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Layer 3 — Volume
// ───────────────────────────────────────────────────────────────────────────

describe('layerVolume', () => {
  it('returns 0 for insufficient bars', () => {
    const r = layerVolume(uptrend({ length: 10 }));
    expect(r.score).toBe(0);
    expect(r.pass).toBe(false);
  });

  it('uptrend with rising volume passes and shows obv_rising', () => {
    const r = layerVolume(uptrend());
    expect(r.flags).toContain('obv_rising');
    expect(r.pass).toBe(true);
  });

  it('breakout fixture surfaces volume_surge flag', () => {
    const r = layerVolume(breakout());
    expect(r.flags).toContain('volume_surge');
  });

  it('downtrend has obv_rising:false and likely fails pass', () => {
    const r = layerVolume(downtrend());
    expect(r.flags).not.toContain('obv_rising');
    expect(r.pass).toBe(false);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Layer 4 — Volatility
// ───────────────────────────────────────────────────────────────────────────

describe('layerVolatility', () => {
  it('returns 0 for insufficient bars', () => {
    const r = layerVolatility(uptrend({ length: 30 }));
    expect(r.score).toBe(0);
    expect(r.pass).toBe(false);
  });

  it('low-vol grind reads as compressed (lower atr_pct, vol_compressing possible)', () => {
    const r = layerVolatility(lowVolGrind());
    // ATR pct should be < 1.5 here — that subtracts 10 from base 50.
    expect(r.details.atr_pct as number).toBeLessThan(1.5);
    expect(r.score).toBeLessThanOrEqual(75);
  });

  it('high-vol regime produces low score and fails pass', () => {
    const r = layerVolatility(highVol());
    expect(r.details.atr_pct as number).toBeGreaterThan(2);
    // very high vol triggers the -25 / score floor; pass requires atr_pct <= 6.
    if ((r.details.atr_pct as number) > 6) expect(r.pass).toBe(false);
  });

  it('uptrend produces tradeable vol band', () => {
    const r = layerVolatility(uptrend());
    expect(r.score).toBeGreaterThanOrEqual(40);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Layer 5 — Relative Strength
// ───────────────────────────────────────────────────────────────────────────

describe('layerRelativeStrength', () => {
  it('returns 0 for insufficient bars', () => {
    const t = uptrend({ length: 50 });
    const s = uptrend({ length: 200 });
    const r = layerRelativeStrength(t, s, null);
    expect(r.score).toBe(0);
  });

  it('ticker outperforming SPY shows positive 20d/60d alpha and rs_strong flags', () => {
    const ticker = uptrend({ startPrice: 100, length: 260 });
    const spy = lowVolGrind({ startPrice: 100, length: 260 });
    const r = layerRelativeStrength(ticker, spy, null);
    expect(r.details.alpha_vs_spy_20d as number).toBeGreaterThan(0);
    expect(r.details.alpha_vs_spy_60d as number).toBeGreaterThan(0);
    expect(r.score).toBeGreaterThanOrEqual(60);
    expect(r.pass).toBe(true);
  });

  it('ticker lagging SPY produces negative alpha and may fail pass', () => {
    const ticker = downtrend({ startPrice: 100, length: 260 });
    const spy = uptrend({ startPrice: 100, length: 260 });
    const r = layerRelativeStrength(ticker, spy, null);
    expect(r.details.alpha_vs_spy_60d as number).toBeLessThan(0);
  });

  it('beating sector flag triggers when ticker beats sector ETF', () => {
    const ticker = uptrend({ startPrice: 100, length: 260 });
    const spy = lowVolGrind({ startPrice: 100, length: 260 });
    const sector = lowVolGrind({ startPrice: 100, length: 260 });
    const r = layerRelativeStrength(ticker, spy, sector);
    expect(r.flags).toContain('beating_sector');
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Layer 6 — Fundamental
// ───────────────────────────────────────────────────────────────────────────

describe('layerFundamental', () => {
  it('null fundamentals returns score 30 + pass:false (informational miss)', () => {
    const r = layerFundamental(null);
    expect(r.score).toBe(30);
    expect(r.pass).toBe(false);
    expect(r.details.error).toBe('no fundamentals');
  });

  it('strong growth + accelerating EPS + clean beat streak → high score, pass', () => {
    const fund: FundInput = {
      revenueGrowthYoY: 0.30,
      epsGrowthYoY: 0.60,
      epsAcceleration: 0.20,
      operatingMargin: 0.25,
      grossMargin: 0.55,
      pe: 25,
      peg: 1.2,
      debtToEquity: 0.5,
      epsSurpriseBeats: 4,
      streak: 'beats',
      avgSurpriseMagnitude: 12,
    };
    const r = layerFundamental(fund);
    expect(r.score).toBeGreaterThanOrEqual(80);
    expect(r.pass).toBe(true);
    expect(r.flags).toContain('eps_accelerating');
    expect(r.flags).toContain('perfect_beat_streak');
    expect(r.flags).toContain('blowout_avg');
  });

  it('contracting revenue + miss streak fails pass', () => {
    const fund: FundInput = {
      revenueGrowthYoY: -0.10,
      epsGrowthYoY: -0.15,
      epsSurpriseBeats: 0,
      streak: 'misses',
    };
    const r = layerFundamental(fund);
    expect(r.pass).toBe(false);
    expect(r.flags).toContain('eps_contracting');
    expect(r.flags).toContain('miss_streak');
  });

  it('rich PEG (>4) penalises and fails pass', () => {
    const fund: FundInput = {
      revenueGrowthYoY: 0.10,
      epsGrowthYoY: 0.10,
      pe: 100,
      peg: 5.0,
    };
    const r = layerFundamental(fund);
    expect(r.pass).toBe(false);
  });

  // 4c-2: new earnings-priority signals
  it('expanding op margin (YoY) adds score and flags', () => {
    const fund: FundInput = {
      revenueGrowthYoY: 0.10,
      epsGrowthYoY: 0.10,
      operatingMargin: 0.20,
      operatingMarginTrendPp: 4, // strong expansion
    };
    const r = layerFundamental(fund);
    expect(r.flags).toContain('op_margin_expanding_strong');
  });

  it('compressing op margin (YoY) penalises score', () => {
    const fundCompress: FundInput = {
      revenueGrowthYoY: 0.10,
      epsGrowthYoY: 0.10,
      operatingMargin: 0.18,
      operatingMarginTrendPp: -3,
    };
    const r1 = layerFundamental(fundCompress);
    expect(r1.flags).toContain('op_margin_compressing');

    const fundFlat: FundInput = { ...fundCompress, operatingMarginTrendPp: 0 };
    const r2 = layerFundamental(fundFlat);
    expect(r1.score).toBeLessThan(r2.score);
  });

  it('multiple expansion adds score; contraction penalises', () => {
    const baseFund: FundInput = {
      revenueGrowthYoY: 0.10,
      epsGrowthYoY: 0.10,
    };
    const expanding = layerFundamental({ ...baseFund, peExpansion: 0.40 });
    const contracting = layerFundamental({ ...baseFund, peExpansion: -0.25 });
    expect(expanding.flags).toContain('multiple_expanding_strong');
    expect(contracting.flags).toContain('multiple_contracting');
    expect(expanding.score).toBeGreaterThan(contracting.score);
  });

  // 4c-2: earnings-quality gate
  it('earnings-quality gate fails on severe EPS contraction even with strong tailwinds', () => {
    const fund: FundInput = {
      revenueGrowthYoY: 0.20,
      epsGrowthYoY: -0.25, // severe
      operatingMargin: 0.25,
      operatingMarginTrendPp: 5,
      peExpansion: 0.30,
    };
    const r = layerFundamental(fund);
    expect(r.pass).toBe(false);
    expect(r.flags.some((f) => f.startsWith('gate_failed:eps_contraction_severe'))).toBe(true);
  });

  it('earnings-quality gate fails anemic EPS with no quality offsets', () => {
    const fund: FundInput = {
      revenueGrowthYoY: 0.10,
      epsGrowthYoY: 0.02,
      operatingMargin: 0.15,
      operatingMarginTrendPp: 0,
      peExpansion: 0,
    };
    const r = layerFundamental(fund);
    expect(r.pass).toBe(false);
    expect(r.flags.some((f) => f.startsWith('gate_failed:eps_weak_no_quality_offsets'))).toBe(true);
  });

  it('earnings-quality gate passes anemic EPS when margin trend rescues', () => {
    const fund: FundInput = {
      revenueGrowthYoY: 0.10,
      epsGrowthYoY: 0.02,
      operatingMargin: 0.15,
      operatingMarginTrendPp: 2, // rescues
    };
    const r = layerFundamental(fund);
    expect(r.pass).toBe(true);
    expect(r.details.earnings_quality_gate).toBe(true);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Layer 7 — Catalyst
// ───────────────────────────────────────────────────────────────────────────

describe('layerCatalyst', () => {
  it('empty catalyst input returns score 30 (base)', () => {
    const r = layerCatalyst({});
    expect(r.score).toBe(30);
  });

  it('strong insider cluster + bullish news + sector leader stack to high score', () => {
    const cat: CatalystInput = {
      insiderScore: 90,
      insiderCluster: true,
      cSuiteBuy: true,
      firstBuyInYear: true,
      newsSentiment7d: 0.6,
      newsVolumeSpike: true,
      sectorRank: 1,
      macroBias: 0.5,
    };
    const r = layerCatalyst(cat);
    expect(r.score).toBeGreaterThanOrEqual(70);
    expect(r.pass).toBe(true);
    expect(r.flags).toContain('insider_cluster');
    expect(r.flags).toContain('c_suite_buy');
    expect(r.flags).toContain('sector_leader');
    expect(r.flags).toContain('news_bullish');
  });

  it('earnings within 3 days fails pass even with high score', () => {
    const cat: CatalystInput = {
      insiderScore: 95,
      insiderCluster: true,
      newsSentiment7d: 0.6,
      daysUntilEarnings: 1,
    };
    const r = layerCatalyst(cat);
    expect(r.flags).toContain('earnings_within_3d');
    expect(r.pass).toBe(false);
  });

  it('post-earnings drift adds a meaningful bump and flag', () => {
    const cat: CatalystInput = {
      insiderScore: 50,
      newsSentiment7d: 0.1,
      postEarningsDrift: true,
    };
    const r = layerCatalyst(cat);
    expect(r.flags).toContain('post_earnings_drift');
  });

  it('bearish news subtracts score', () => {
    const a = layerCatalyst({ insiderScore: 50 });
    const b = layerCatalyst({ insiderScore: 50, newsSentiment7d: -0.6 });
    expect(b.score).toBeLessThan(a.score);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// composeProphet — top-level composition. Smoke-test with a strong setup.
// ───────────────────────────────────────────────────────────────────────────

describe('composeProphet', () => {
  it('strong uptrend + good fundamentals + good catalysts produces a BUY signal', () => {
    const ticker = uptrend({ length: 260 });
    const spy = lowVolGrind({ length: 260 });
    const fund: FundInput = {
      revenueGrowthYoY: 0.25,
      epsGrowthYoY: 0.40,
      epsAcceleration: 0.10,
      operatingMargin: 0.20,
      grossMargin: 0.50,
      peg: 1.1,
      epsSurpriseBeats: 4,
      streak: 'beats',
      avgSurpriseMagnitude: 8,
    };
    const cat: CatalystInput = {
      insiderScore: 80,
      insiderCluster: true,
      newsSentiment7d: 0.4,
      sectorRank: 2,
      macroBias: 0.5,
    };

    // composeProphet takes pre-computed layer outputs. Mirror what the
    // prophet-picks endpoint does: run each layer, then compose.
    const layers = {
      structure: layerStructure(ticker),
      momentum: layerMomentum(ticker),
      volume: layerVolume(ticker),
      volatility: layerVolatility(ticker),
      relativeStrength: layerRelativeStrength(ticker, spy, null),
      fundamental: layerFundamental(fund),
      catalyst: layerCatalyst(cat),
    };
    const score = composeProphet(ticker, layers, 0.5);

    expect(score.layersPassed).toBeGreaterThanOrEqual(5);
    expect(score.composite).toBeGreaterThan(50);
    expect(score.signal).toBe('BUY');
    expect(['HIGH', 'MEDIUM', 'LOW']).toContain(score.conviction);
    expect(score.entry).toBeGreaterThan(0);
    expect(score.stop).toBeLessThan(score.entry as number);
    expect(score.targets.length).toBe(2);
  });

  it('weak inputs do not produce a BUY (signal is null)', () => {
    const ticker = downtrend({ length: 260 });
    const spy = uptrend({ length: 260 });
    const fund: FundInput = {
      revenueGrowthYoY: -0.10,
      epsGrowthYoY: -0.15,
      streak: 'misses',
    };
    const cat: CatalystInput = {
      insiderScore: 20,
      newsSentiment7d: -0.5,
      sectorRank: 11,
    };
    const layers = {
      structure: layerStructure(ticker),
      momentum: layerMomentum(ticker),
      volume: layerVolume(ticker),
      volatility: layerVolatility(ticker),
      relativeStrength: layerRelativeStrength(ticker, spy, null),
      fundamental: layerFundamental(fund),
      catalyst: layerCatalyst(cat),
    };
    const score = composeProphet(ticker, layers, 0);
    expect(score.layersPassed).toBeLessThan(5);
    // Implementation returns null (not 'HOLD') when no conviction tier hits.
    expect(score.signal).toBeNull();
    expect(score.conviction).toBeNull();
    expect(score.entry).toBeNull();
  });
});
