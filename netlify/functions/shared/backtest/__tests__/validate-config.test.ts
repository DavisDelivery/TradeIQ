// Wave 4D (track-3 minor 10) — validateConfig must not let a future
// endDate through untouched: the run would drag a flat-equity tail
// through the window, diluting CAGR/Sharpe (and interacting with PIT
// cache poisoning). When the caller injects today's date the endDate is
// clamped in place with a warning; the engine itself stays
// wall-clock-free (the walk-forward integrity audit bans new Date()
// window derivation inside engine sources), so without todayIso the
// validator behaves exactly as before.

import { describe, it, expect } from 'vitest';
import { validateConfig } from '../engine';
import type { BacktestConfig } from '../types';

function makeConfig(overrides: Partial<BacktestConfig> = {}): BacktestConfig {
  return {
    universe: 'dow',
    startDate: '2018-01-01',
    endDate: '2018-04-01',
    rebalanceFrequency: 'monthly',
    board: 'prophet',
    portfolio: {
      topN: 10,
      weighting: 'equal',
      maxPositionPct: 0.1,
      maxSectorPct: 0.4,
      cashSleeve: 0.05,
      minComposite: 50,
    },
    costs: { slippageBps: { dow: 3 }, commission: 0 },
    initialCapital: 10000,
    ...overrides,
  } as BacktestConfig;
}

describe('validateConfig — future endDate (Wave 4D)', () => {
  const TODAY = '2026-06-11';

  it('clamps a future endDate to todayIso and returns a warning', () => {
    const config = makeConfig({ endDate: '2027-01-01' });
    const warnings = validateConfig(config, TODAY);
    expect(config.endDate).toBe(TODAY);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/endDate 2027-01-01 is in the future/);
    expect(warnings[0]).toMatch(/clamped to 2026-06-11/);
  });

  it('leaves endDate === today untouched (cron-style "through today" windows)', () => {
    const config = makeConfig({ endDate: TODAY });
    const warnings = validateConfig(config, TODAY);
    expect(config.endDate).toBe(TODAY);
    expect(warnings).toEqual([]);
  });

  it('leaves a past endDate untouched and returns no warnings', () => {
    const config = makeConfig();
    const warnings = validateConfig(config, TODAY);
    expect(config.endDate).toBe('2018-04-01');
    expect(warnings).toEqual([]);
  });

  it('without todayIso the future-endDate check is skipped (engine stays clock-free)', () => {
    const config = makeConfig({ endDate: '2027-01-01' });
    const warnings = validateConfig(config);
    expect(config.endDate).toBe('2027-01-01');
    expect(warnings).toEqual([]);
  });

  it('clamping can surface startDate > endDate as the existing error', () => {
    const config = makeConfig({ startDate: '2026-12-01', endDate: '2027-01-01' });
    expect(() => validateConfig(config, TODAY)).toThrow(/startDate.*endDate/);
  });

  it('still throws on the pre-existing validations', () => {
    expect(() =>
      validateConfig(makeConfig({ startDate: '2017-01-01' }), TODAY),
    ).toThrow(/before 2018-01-01/);
    expect(() =>
      validateConfig(makeConfig({ initialCapital: 0 }), TODAY),
    ).toThrow(/initialCapital/);
  });

  it('batchSize: accepts [1,16] integers, rejects out-of-range/non-integers, allows undefined', () => {
    expect(validateConfig(makeConfig({ batchSize: 2 }), TODAY)).toEqual([]);
    expect(validateConfig(makeConfig({ batchSize: 16 }), TODAY)).toEqual([]);
    expect(validateConfig(makeConfig({}), TODAY)).toEqual([]);
    expect(() => validateConfig(makeConfig({ batchSize: 0 }), TODAY)).toThrow(/batchSize/);
    expect(() => validateConfig(makeConfig({ batchSize: 17 }), TODAY)).toThrow(/batchSize/);
    expect(() => validateConfig(makeConfig({ batchSize: 2.5 }), TODAY)).toThrow(/batchSize/);
  });
});
