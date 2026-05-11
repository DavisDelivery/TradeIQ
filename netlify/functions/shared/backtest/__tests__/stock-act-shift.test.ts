import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  STOCK_ACT_LAG_DAYS,
  shiftedPoliticalAsOfDate,
} from '../stock-act-shift';
import { addDays } from '../trading-calendar';

describe('stock-act-shift', () => {
  it('STOCK_ACT_LAG_DAYS = 45 (Act maximum)', () => {
    expect(STOCK_ACT_LAG_DAYS).toBe(45);
  });

  it('shifts asOfDate back by 45 days', () => {
    expect(shiftedPoliticalAsOfDate('2024-03-15')).toBe(
      addDays('2024-03-15', -45),
    );
  });

  it('shift is deterministic', () => {
    const a = shiftedPoliticalAsOfDate('2023-06-15');
    const b = shiftedPoliticalAsOfDate('2023-06-15');
    expect(a).toBe(b);
  });

  describe('synthetic trade scenario from brief', () => {
    // Construct a trade with TransactionDate=2023-01-01,
    // ReportDate=2023-02-10 (40 days later). Backtest at asOfDate=
    // 2023-02-01 must NOT see the trade. At asOfDate=2023-02-15,
    // must see it.
    const transactionDate = '2023-01-01';

    it('asOfDate before report date: shifted asOf is BEFORE transaction date → trade excluded', () => {
      // At asOfDate=2023-02-01, shifted = 2022-12-18 (≈ 45 days earlier)
      // Provider filters by transaction date <= shifted, so a
      // transaction on 2023-01-01 is > 2022-12-18 and excluded.
      const shifted = shiftedPoliticalAsOfDate('2023-02-01');
      expect(shifted < transactionDate).toBe(true);
    });

    it('asOfDate well after report date: shifted asOf is AT/AFTER transaction date → trade included', () => {
      // At asOfDate=2023-02-15 (5 days after the report was filed),
      // shifted = 2023-01-01 — exactly matches the transaction date,
      // so the trade is included (filter is <=).
      const shifted = shiftedPoliticalAsOfDate('2023-02-15');
      expect(shifted >= transactionDate).toBe(true);
    });

    it('asOfDate exactly 45 days after transaction: boundary, trade included', () => {
      // Worst-case STOCK Act filing delay: 45 days after transaction.
      const asOf = addDays(transactionDate, 45); // 2023-02-15
      const shifted = shiftedPoliticalAsOfDate(asOf);
      // Shifted = transactionDate exactly
      expect(shifted).toBe(transactionDate);
      expect(shifted >= transactionDate).toBe(true);
    });
  });
});
