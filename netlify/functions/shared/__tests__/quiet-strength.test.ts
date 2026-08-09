// QS-1 — sleeve rules and board assembly.

import { describe, it, expect } from 'vitest';
import {
  exposureFor,
  applyRankBuffer,
  trancheOf,
  buildEvidenceBanner,
  buildQuietStrengthBoard,
  TARGET_VOL_PCT,
  MAX_EXPOSURE,
  BEAR_TILT_MULTIPLIER,
  GROSS_EDGE_PP,
  MIN_HOLDINGS,
  TRANCHES,
  type QSCandidate,
} from '../quiet-strength';
import { haircutExcess, HAIRCUT_SURVIVAL, POLICY_VERSION } from '../research-policy';

describe('exposureFor — crash control', () => {
  it('scales down when vol exceeds the 12% target', () => {
    // 24% realized vol against a 12% target halves the sleeve.
    const d = exposureFor({ realizedVolPct: 24, benchmark24mPct: 10 });
    expect(d.volScaled).toBeCloseTo(0.5, 10);
    expect(d.exposure).toBeCloseTo(0.5, 10);
    expect(d.bearDimmed).toBe(false);
  });

  it('never levers above 1 when vol is low', () => {
    // 6% vol would imply 2x unconstrained. The lev cap keeps ~95% of the
    // drawdown benefit without ever borrowing.
    const d = exposureFor({ realizedVolPct: 6, benchmark24mPct: 10 });
    expect(TARGET_VOL_PCT / 6).toBe(2);
    expect(d.volScaled).toBe(MAX_EXPOSURE);
    expect(d.exposure).toBe(1);
  });

  it('halves the tilt in a 24-month bear', () => {
    const d = exposureFor({ realizedVolPct: 12, benchmark24mPct: -5 });
    expect(d.volScaled).toBe(1);
    expect(d.exposure).toBeCloseTo(BEAR_TILT_MULTIPLIER, 10);
    expect(d.bearDimmed).toBe(true);
    expect(d.reasons.join(' ')).toMatch(/tilt halved/);
  });

  it('compounds the vol scale and the bear dimmer', () => {
    const d = exposureFor({ realizedVolPct: 24, benchmark24mPct: -1 });
    expect(d.exposure).toBeCloseTo(0.25, 10);
  });

  it('does NOT size up when vol is unmeasurable', () => {
    // Being unable to measure risk is not evidence of low risk. The fallback
    // is the base exposure with a recorded reason, never an implicit 1 that
    // looks like a measurement.
    const d = exposureFor({ realizedVolPct: null, benchmark24mPct: 10 });
    expect(d.exposure).toBe(1);
    expect(d.reasons.join(' ')).toMatch(/unmeasured/);

    const both = exposureFor({ realizedVolPct: null, benchmark24mPct: null });
    expect(both.reasons.length).toBe(2);
    expect(both.bearDimmed).toBe(false);
  });

  it('treats zero and negative vol as unmeasurable rather than dividing', () => {
    for (const v of [0, -3]) {
      const d = exposureFor({ realizedVolPct: v, benchmark24mPct: 10 });
      expect(Number.isFinite(d.exposure)).toBe(true);
      expect(d.exposure).toBe(1);
    }
  });

  it('never returns a value outside [0, 1]', () => {
    for (const vol of [null, 0, 0.001, 1, 12, 80, 1e9]) {
      for (const bench of [null, -50, 0, 50]) {
        const d = exposureFor({ realizedVolPct: vol, benchmark24mPct: bench });
        expect(d.exposure).toBeGreaterThanOrEqual(0);
        expect(d.exposure).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe('applyRankBuffer', () => {
  const ranked = Array.from({ length: 100 }, (_, i) => `T${String(i).padStart(3, '0')}`);

  it('enters only the top decile', () => {
    const r = applyRankBuffer({ ranked, held: [] });
    expect(r.entered.length).toBe(10);
    expect(r.entered[0]).toBe('T000');
    expect(r.entered.at(-1)).toBe('T009');
  });

  it('holds an existing name down to the top quartile', () => {
    // T020 is rank 21 — outside the entry decile, inside the hold quartile.
    // A single threshold would churn it out and straight back in.
    const r = applyRankBuffer({ ranked, held: ['T020'] });
    expect(r.keep).toContain('T020');
    expect(r.exited).not.toContain('T020');
  });

  it('exits a name that leaves the top quartile', () => {
    const r = applyRankBuffer({ ranked, held: ['T030'] });
    expect(r.keep).not.toContain('T030');
    expect(r.exited).toContain('T030');
  });

  it('exits a name that left the ranked universe entirely', () => {
    const r = applyRankBuffer({ ranked, held: ['DELISTED'] });
    expect(r.exited).toContain('DELISTED');
  });

  it('does not displace a survivor with a marginally better newcomer', () => {
    const held = ranked.slice(15, 25); // ranks 16-25, all inside the quartile
    const r = applyRankBuffer({ ranked, held });
    for (const t of held) expect(r.keep).toContain(t);
  });

  it('handles an empty ranking without throwing', () => {
    const r = applyRankBuffer({ ranked: [], held: ['A', 'B'] });
    expect(r.keep).toEqual([]);
    expect(r.exited.sort()).toEqual(['A', 'B']);
  });
});

describe('trancheOf', () => {
  it('is deterministic', () => {
    expect(trancheOf('AAPL')).toBe(trancheOf('AAPL'));
  });

  it('returns a valid tranche index', () => {
    for (const t of ['AAPL', 'MSFT', 'A', 'ZZZZ', 'BRK.B']) {
      const v = trancheOf(t);
      expect(Number.isInteger(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(TRANCHES);
    }
  });

  it('spreads a realistic sleeve across all three tranches', () => {
    // Staggering only averages timing luck away if it actually splits the
    // book; a hash that piled everything into one tranche would silently
    // reduce this to a single rebalance date.
    const names = Array.from({ length: 300 }, (_, i) => `SYM${i}`);
    const counts = [0, 0, 0];
    for (const n of names) counts[trancheOf(n)]++;
    for (const c of counts) expect(c).toBeGreaterThan(300 / TRANCHES / 2);
  });
});

describe('buildEvidenceBanner — the haircut must be applied, not claimed', () => {
  const b = buildEvidenceBanner();

  it('derives the displayed range through research-policy', () => {
    // The banner must not hardcode "0.5-1.5". These assertions fail if the
    // policy's survival fraction changes and the banner does not follow.
    expect(b.netEdgeLowPp).toBe(haircutExcess(GROSS_EDGE_PP[0]));
    expect(b.netEdgeHighPp).toBe(haircutExcess(GROSS_EDGE_PP[1]));
    expect(b.netEdgeLowPp).toBeCloseTo(GROSS_EDGE_PP[0] * HAIRCUT_SURVIVAL, 10);
    expect(b.netEdgeHighPp).toBeCloseTo(GROSS_EDGE_PP[1] * HAIRCUT_SURVIVAL, 10);
  });

  it('carries the mandated sentence', () => {
    expect(b.headline).toContain('0.5');
    expect(b.headline).toContain('1.5');
    expect(b.headline).toMatch(/after haircut/);
    expect(b.headline).toMatch(/over SPY/);
    expect(b.headline).toMatch(/multi-year droughts/);
  });

  it('declares no internally-measured t-statistic', () => {
    // Rule 3: a null t is a FAIL, not a pass. The lynch registry shipped a
    // bare IC for months because nothing forced "compared to what error?".
    expect(b.discovery).toMatch(/NOT MEASURED/);
    expect(b.grade).toBe('replicated-external');
  });

  it('stamps the policy version and its sources', () => {
    expect(b.policyVersion).toBe(POLICY_VERSION);
    expect(b.sources.length).toBeGreaterThanOrEqual(3);
    expect(b.sources.join(' ')).toMatch(/Blitz/);
  });
});

describe('buildQuietStrengthBoard', () => {
  const mk = (ticker: string, score: number | null, over: Partial<QSCandidate> = {}): QSCandidate => ({
    ticker,
    score,
    marketCapM: 5_000,
    medianDollarVol: 20_000_000,
    price: 50,
    ...over,
  });

  const many = (n: number) =>
    Array.from({ length: n }, (_, i) => mk(`T${String(i).padStart(3, '0')}`, 100 - i));

  it('returns rows sorted best-first', () => {
    // Load-bearing: forward-test.extractTopN assigns rank by ARRAY POSITION
    // and never sorts. Unsorted rows would log the worst names to the league.
    const shuffled = [mk('LOW', 1), mk('HIGH', 99), mk('MID', 50)];
    const r = buildQuietStrengthBoard(shuffled, { realizedVolPct: 12, benchmark24mPct: 5 });
    expect(r.rows.map((x) => x.ticker)[0]).toBe('HIGH');
    for (let i = 1; i < r.rows.length; i++) {
      expect(r.rows[i - 1].score).toBeGreaterThanOrEqual(r.rows[i].score);
    }
  });

  it('exposes the score under a key forward-test.extractScore recognises', () => {
    const r = buildQuietStrengthBoard(many(50), { realizedVolPct: 12, benchmark24mPct: 5 });
    const row = r.rows[0] as unknown as Record<string, unknown>;
    const probed = ['composite', 'percentile', 'score', 'confidence', 'netDollars'];
    expect(probed.some((k) => typeof row[k] === 'number')).toBe(true);
    expect(typeof row.score).toBe('number');
  });

  it('breaks ties deterministically', () => {
    const tied = [mk('BBB', 5), mk('AAA', 5), mk('CCC', 5)];
    const a = buildQuietStrengthBoard(tied, { realizedVolPct: 12, benchmark24mPct: 1 });
    const b = buildQuietStrengthBoard([...tied].reverse(), { realizedVolPct: 12, benchmark24mPct: 1 });
    expect(a.rows.map((r) => r.ticker)).toEqual(b.rows.map((r) => r.ticker));
  });

  it('publishes the top quartile and bands the top decile as enter', () => {
    const r = buildQuietStrengthBoard(many(100), { realizedVolPct: 12, benchmark24mPct: 5 });
    expect(r.rows.length).toBe(25);
    expect(r.rows.filter((x) => x.band === 'enter').length).toBe(10);
    expect(r.rows.filter((x) => x.band === 'hold').length).toBe(15);
  });

  it('applies the universe policy and reports why names dropped', () => {
    const c = [
      mk('GOOD', 10),
      mk('TINY', 9, { marketCapM: 50 }),
      mk('THIN', 8, { medianDollarVol: 100_000 }),
      mk('CHEAP', 7, { price: 2 }),
      mk('NODATA', 6, { medianDollarVol: null }),
    ];
    const r = buildQuietStrengthBoard(c, { realizedVolPct: 12, benchmark24mPct: 5 });
    expect(r.rows.map((x) => x.ticker)).toEqual(['GOOD']);
    expect(r.excludedCounts.microcap).toBe(1);
    expect(r.excludedCounts.illiquid).toBe(1);
    expect(r.excludedCounts['price-floor']).toBe(1);
    expect(r.excludedCounts['no-data']).toBe(1);
  });

  it('counts unscorable names by reason rather than dropping them silently', () => {
    const c = [
      mk('OK', 10),
      mk('SHORT', null, { reason: 'insufficient-history' }),
      mk('SHORT2', null, { reason: 'insufficient-history' }),
      mk('DEG', null, { reason: 'degenerate-residuals' }),
    ];
    const r = buildQuietStrengthBoard(c, { realizedVolPct: 12, benchmark24mPct: 5 });
    expect(r.scored).toBe(1);
    expect(r.unscorableCounts['insufficient-history']).toBe(2);
    expect(r.unscorableCounts['degenerate-residuals']).toBe(1);
  });

  it('warns when the scorable set is below the holdings floor', () => {
    const r = buildQuietStrengthBoard(many(10), { realizedVolPct: 12, benchmark24mPct: 5 });
    expect(r.warnings.join(' ')).toMatch(new RegExp(`below the ${MIN_HOLDINGS}-name floor`));
  });

  it('always carries the banner and the exposure decision in the result', () => {
    // These must travel with the data so a UI refactor cannot drop them.
    const r = buildQuietStrengthBoard(many(60), { realizedVolPct: 30, benchmark24mPct: -2 });
    expect(r.banner.headline).toMatch(/after haircut/);
    expect(r.exposure.exposure).toBeCloseTo(Math.min(1, 12 / 30) * 0.5, 10);
    expect(r.exposure.bearDimmed).toBe(true);
  });

  it('survives an empty candidate list', () => {
    const r = buildQuietStrengthBoard([], { realizedVolPct: null, benchmark24mPct: null });
    expect(r.rows).toEqual([]);
    expect(r.scored).toBe(0);
    expect(r.banner).toBeTruthy();
  });
});
