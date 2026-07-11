// FIX-1 W4 — verdict registry tests. The registry is the single source
// the UI chips render from; these pin the seeded standing verdicts and
// the label grammar so a registry edit that weakens the honesty line
// (e.g. dropping the measured number) fails loudly.

import { describe, it, expect } from 'vitest';
import {
  BOARD_VERDICTS,
  verdictLabel,
  isUnvalidated,
} from '../verdicts';

describe('BOARD_VERDICTS — seeded standing verdicts', () => {
  it('williams: NO_EDGE at −73.4pp vs SPY on the 4r W2 run', () => {
    const v = BOARD_VERDICTS.williams;
    expect(v.status).toBe('NO_EDGE');
    expect(v.excessVsSPYPp).toBe(-73.4);
    expect(v.runId).toBe('bt_20260519014409_zsxtsq');
  });

  it('lynch: NO_EDGE with IC 0.0011 / −1.3pp vs SPY (bt_20260608015737)', () => {
    const v = BOARD_VERDICTS.lynch;
    expect(v.status).toBe('NO_EDGE');
    expect(v.ic).toBe(0.0011);
    expect(v.excessVsSPYPp).toBe(-1.3);
    expect(v.runId).toBe('bt_20260608015737');
  });

  it('prophet: MIXED — +80.9pp vs SPY full-window, −58pp vs QQQ, 4/8 rolling windows', () => {
    const v = BOARD_VERDICTS.prophet;
    expect(v.status).toBe('MIXED');
    expect(v.excessVsSPYPp).toBe(80.9);
    expect(v.excessVsQQQPp).toBe(-58);
    expect(v.rollingWindowsWon).toBe('4/8');
  });

  it('target: NO_EDGE after the FIX-1 W3 sp500 run (−74.2pp vs SPY, negative IC)', () => {
    const v = BOARD_VERDICTS.target;
    expect(v.status).toBe('NO_EDGE');
    expect(v.excessVsSPYPp).toBe(-74.2);
    expect(v.ic).toBe(-0.0105);
    expect(v.runId).toBe('bt_20260711013530_q5qdh7');
    expect(v.date).toBe('2026-07-11');
    // The note records that the first valid run (q5qdh7) superseded the
    // INVALID avaa64 run.
    expect(v.note).toMatch(/avaa64/);
    expect(v.note).toMatch(/screener/);
  });
});

describe('verdictLabel — the chip must carry the measured number, not just a word', () => {
  it('williams label includes the pp-vs-SPY figure', () => {
    expect(verdictLabel(BOARD_VERDICTS.williams)).toBe('NO VALIDATED EDGE (−73.4pp vs SPY)');
  });
  it('lynch label includes IC and pp-vs-SPY', () => {
    expect(verdictLabel(BOARD_VERDICTS.lynch)).toBe('NO VALIDATED EDGE (IC 0.0011, −1.3pp vs SPY)');
  });
  it('prophet label carries both benchmarks and rolling consistency', () => {
    expect(verdictLabel(BOARD_VERDICTS.prophet)).toBe('MIXED (+80.9pp vs SPY, −58pp vs QQQ, 4/8 windows)');
  });
  it('target label carries IC and pp-vs-SPY (NO_EDGE after W3)', () => {
    expect(verdictLabel(BOARD_VERDICTS.target)).toBe('NO VALIDATED EDGE (IC -0.0105, −74.2pp vs SPY)');
  });
});

describe('isUnvalidated — nav demotion follows the registry', () => {
  it('williams + lynch + target are demoted; prophet (MIXED) is not', () => {
    expect(isUnvalidated('williams')).toBe(true);
    expect(isUnvalidated('lynch')).toBe(true);
    expect(isUnvalidated('target')).toBe(true); // FIX-1 W3: composite demoted to a screener
    expect(isUnvalidated('prophet')).toBe(false);
  });
});
