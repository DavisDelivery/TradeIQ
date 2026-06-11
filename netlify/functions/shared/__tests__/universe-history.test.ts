import { describe, it, expect } from 'vitest';
import {
  UNIVERSE_HISTORY,
  tickersInIndexOnDate,
  wasInIndexOnDate,
  universeHistoryCoverage,
} from '../universe-history';

describe('universe-history — lookup contract', () => {
  it('UNIVERSE_HISTORY is non-empty and well-shaped', () => {
    expect(UNIVERSE_HISTORY.length).toBeGreaterThan(0);
    for (const snap of UNIVERSE_HISTORY) {
      expect(snap.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(['sp500', 'ndx', 'dow', 'russell2k']).toContain(snap.index);
      expect(Array.isArray(snap.tickers)).toBe(true);
      // Tickers sorted alphabetically (deterministic comparison).
      const sorted = [...snap.tickers].sort();
      expect(snap.tickers).toEqual(sorted);
    }
  });

  it('tickersInIndexOnDate returns null when no snapshot covers the date', () => {
    // Pre-coverage date — well before our earliest Dow snapshot.
    expect(tickersInIndexOnDate('dow', '1950-01-01')).toBeNull();
    expect(tickersInIndexOnDate('sp500', '1950-01-01')).toBeNull();
  });

  it('tickersInIndexOnDate returns the latest snapshot ≤ date', () => {
    const tickers = tickersInIndexOnDate('dow', '2026-04-30');
    expect(tickers).not.toBeNull();
    expect(tickers!.length).toBe(30);
    expect(tickers).toContain('AAPL');
    expect(tickers).toContain('NVDA');
  });
});

describe('universe-history — known historical memberships (Dow)', () => {
  it('AAPL was in Dow on 2018-03-15 (added 2015)', () => {
    expect(wasInIndexOnDate('AAPL', 'dow', '2018-03-15')).toBe(true);
  });

  it('GE was in Dow on 2018-03-15 (removed 2018-06-26)', () => {
    expect(wasInIndexOnDate('GE', 'dow', '2018-03-15')).toBe(true);
  });

  it('GE was NOT in Dow on 2019-01-01 (already removed)', () => {
    expect(wasInIndexOnDate('GE', 'dow', '2019-01-01')).toBe(false);
  });

  it('WBA was in Dow on 2019-01-01 (added 2018-06-26)', () => {
    expect(wasInIndexOnDate('WBA', 'dow', '2019-01-01')).toBe(true);
  });

  it('WBA was NOT in Dow on 2024-04-01 (removed 2024-02-26)', () => {
    expect(wasInIndexOnDate('WBA', 'dow', '2024-04-01')).toBe(false);
  });

  it('AMZN was NOT in Dow on 2024-01-01 (added 2024-02-26)', () => {
    expect(wasInIndexOnDate('AMZN', 'dow', '2024-01-01')).toBe(false);
  });

  it('AMZN was in Dow on 2024-04-01', () => {
    expect(wasInIndexOnDate('AMZN', 'dow', '2024-04-01')).toBe(true);
  });

  it('NVDA was NOT in Dow on 2024-08-01 (added 2024-11-08)', () => {
    expect(wasInIndexOnDate('NVDA', 'dow', '2024-08-01')).toBe(false);
  });

  it('NVDA was in Dow on 2024-12-01', () => {
    expect(wasInIndexOnDate('NVDA', 'dow', '2024-12-01')).toBe(true);
  });

  it('INTC was in Dow on 2024-08-01 (replaced by NVDA in Nov 2024)', () => {
    expect(wasInIndexOnDate('INTC', 'dow', '2024-08-01')).toBe(true);
  });

  it('INTC was NOT in Dow on 2025-01-01', () => {
    expect(wasInIndexOnDate('INTC', 'dow', '2025-01-01')).toBe(false);
  });

  it('XOM was in Dow on 2020-01-01 (removed 2020-08-31)', () => {
    expect(wasInIndexOnDate('XOM', 'dow', '2020-01-01')).toBe(true);
  });

  it('XOM was NOT in Dow on 2021-01-01', () => {
    expect(wasInIndexOnDate('XOM', 'dow', '2021-01-01')).toBe(false);
  });

  it('CRM was NOT in Dow on 2020-06-01 (added 2020-08-31)', () => {
    expect(wasInIndexOnDate('CRM', 'dow', '2020-06-01')).toBe(false);
  });

  it('CRM was in Dow on 2021-01-01', () => {
    expect(wasInIndexOnDate('CRM', 'dow', '2021-01-01')).toBe(true);
  });

  it('returns null for pre-coverage dates instead of false', () => {
    // Phase 4 backtest distinguishes "no data" (null) from "not in index" (false)
    expect(wasInIndexOnDate('AAPL', 'dow', '1990-01-01')).toBeNull();
  });
});

describe('universe-history — coverage report', () => {
  it('reports Dow with broad month-end coverage', () => {
    const cov = universeHistoryCoverage();
    expect(cov.dow.snapshotCount).toBeGreaterThanOrEqual(60);
    expect(cov.dow.firstDate).toBe('2018-01-31');
    expect(cov.dow.lastDate! >= '2026-04-30').toBe(true);
  });

  it('reports SP500 / NDX / Russell2k with at least the current seed', () => {
    const cov = universeHistoryCoverage();
    expect(cov.sp500.snapshotCount).toBeGreaterThanOrEqual(1);
    expect(cov.ndx.snapshotCount).toBeGreaterThanOrEqual(1);
    expect(cov.russell2k.snapshotCount).toBeGreaterThanOrEqual(1);
    expect(cov.sp500.lastDate! >= '2026-04-30').toBe(true);
  });
});

describe('universe-history — data integrity (M5)', () => {
  // M5 (2026-06 review): generated snapshots carried literal duplicate
  // tickers (e.g. "ADRO","ADRO" in russell2k 2023-08 onwards, "JPM",
  // "JPM" in sp500 2025-08..10). A duplicate doubles that name's
  // portfolio weight in the backtest engine. The data has been fixed;
  // this test pins it so a generator re-run can't regress silently.
  it('no snapshot contains duplicate tickers', () => {
    const offenders: string[] = [];
    for (const snap of UNIVERSE_HISTORY) {
      const seen = new Set<string>();
      for (const t of snap.tickers) {
        if (seen.has(t)) offenders.push(`${snap.index} ${snap.date}: ${t}`);
        seen.add(t);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('previously-affected snapshots retain their members exactly once', () => {
    // The duplicates documented in the 2026-06 review — assert each
    // ticker is still present (dedup must not have dropped names).
    const cases: Array<[index: 'sp500' | 'russell2k', date: string, ticker: string]> = [
      ['russell2k', '2025-10-31', 'ADRO'],
      ['russell2k', '2025-06-30', 'HNVR'],
      ['russell2k', '2024-05-31', 'PLSE'],
      ['russell2k', '2024-05-31', 'DNMR'],
      ['russell2k', '2022-12-31', 'PLBY'],
      ['russell2k', '2022-03-31', 'QMCO'],
      ['sp500', '2025-09-30', 'JPM'],
    ];
    for (const [index, date, ticker] of cases) {
      const snap = UNIVERSE_HISTORY.find((s) => s.index === index && s.date === date);
      expect(snap, `${index} ${date}`).toBeDefined();
      const count = snap!.tickers.filter((t) => t === ticker).length;
      expect(count, `${index} ${date} ${ticker}`).toBe(1);
    }
  });
});
