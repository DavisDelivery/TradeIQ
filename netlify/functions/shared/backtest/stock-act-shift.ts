// STOCK Act forward-shift for Quiver congressional trades.
//
// The problem (from the brief and Phase 3 audit doc):
//   Quiver's congressional endpoints expose `Date` = transaction date.
//   They do NOT expose `ReportDate` = the date the trade was filed with
//   the SEC under the STOCK Act, which can be up to 45 days after the
//   transaction. A backtest at asOfDate=T that filters trades by
//   transaction_date <= T will see trades that weren't actually public
//   knowledge until T + (up to) 45 days.
//
//   Result: live look-ahead. Phase 3 PIT-filtering is necessary but not
//   sufficient because Quiver doesn't expose ReportDate.
//
// The fix:
//   Shift the asOfDate by STOCK_ACT_LAG_DAYS=45 before calling the
//   political provider. The backtest at T treats the political signal as
//   "what was actually public by T", which is the data filed at most
//   T - 45 days ago. Trades whose transaction date is in (T - 45, T] are
//   excluded because they likely hadn't been filed yet.
//
//   This is a conservative shift — actual filing delays vary from a few
//   days to 45 days. Using the worst-case 45 makes the backtest
//   defensible (we never see future data) at the cost of dropping some
//   trades the strategy could have legitimately seen earlier.
//
// What the brief explicitly tests:
//   "Construct a synthetic congressional trade with TransactionDate=
//   2023-01-01, ReportDate=2023-02-10 (40 days later). Run the political
//   scorer at asOfDate=2023-02-01. Assert the trade is NOT in the
//   scorer's input. At asOfDate=2023-02-15, assert it IS in the input."
//
//   With STOCK_ACT_LAG_DAYS=45, asOfDate=2023-02-01 becomes effective
//   asOf 2022-12-18, which excludes a TransactionDate=2023-01-01 trade.
//   asOfDate=2023-02-15 becomes effective 2023-01-01, which includes
//   it (boundary). Behavior matches the spec.

import {
  getPoliticalActivity,
  type PoliticalActivity,
} from '../political-provider';
import { addDays } from './trading-calendar';

/**
 * STOCK Act maximum disclosure window in days. The Act requires a member
 * of Congress to file a Periodic Transaction Report (PTR) within 30 days
 * of becoming aware of a trade and no later than 45 days after the
 * transaction. We use the maximum so backtest analysis is conservative.
 */
export const STOCK_ACT_LAG_DAYS = 45;

/**
 * Effective asOfDate for political-data fetches in backtest mode.
 * Shifts the requested asOfDate BACK by STOCK_ACT_LAG_DAYS.
 */
export function shiftedPoliticalAsOfDate(asOfDate: string): string {
  return addDays(asOfDate, -STOCK_ACT_LAG_DAYS);
}

/**
 * Backtest-mode wrapper around getPoliticalActivity. Applies the STOCK
 * Act forward shift to asOfDate so the underlying provider's transaction-
 * date filter approximates a ReportDate filter.
 */
export async function getPoliticalActivityForBacktest(
  ticker: string,
  lookbackDays: number,
  asOfDate: string,
): Promise<PoliticalActivity> {
  const shifted = shiftedPoliticalAsOfDate(asOfDate);
  return getPoliticalActivity(ticker, lookbackDays, { asOfDate: shifted });
}
