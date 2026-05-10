// Finnhub REST response schemas.
//
// Endpoints actually called from data-provider.ts:
//   - /calendar/earnings           (earnings calendar; range + per-symbol)
//   - /stock/earnings              (earnings surprise history)
//   - /stock/insider-transactions  (Form 4 feed; Quiver-equivalent on cheaper plan)
//
// Finnhub's quirks:
//   - Numeric fields occasionally arrive as strings (epsEstimate especially
//     for un-covered tickers). z.coerce.number() handles this.
//   - The earnings calendar returns `{ earningsCalendar: [...] }` even when
//     empty; we tolerate missing key with .optional().default().
//   - /stock/earnings returns a bare array (NOT an object). Keep this in
//     mind — it's the only Finnhub endpoint we hit that does this.

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Earnings calendar — /calendar/earnings
// Used by getUpcomingEarnings() (with symbol param) and
// getEarningsCalendarRange() (range only).
// ---------------------------------------------------------------------------

export const FinnhubEarningsCalendarItemSchema = z.object({
  symbol: z.string(),
  date: z.string(),                                // YYYY-MM-DD
  hour: z.string().optional(),                      // 'bmo' | 'amc' | 'dmh' | ''
  epsEstimate: z.coerce.number().nullable().optional(),
  epsActual: z.coerce.number().nullable().optional(),
  revenueEstimate: z.coerce.number().nullable().optional(),
  revenueActual: z.coerce.number().nullable().optional(),
  year: z.number().optional(),
  quarter: z.number().optional(),
}).passthrough();

export const FinnhubEarningsCalendarResponseSchema = z.object({
  earningsCalendar: z.array(FinnhubEarningsCalendarItemSchema).optional().default([]),
}).passthrough();

// ---------------------------------------------------------------------------
// Earnings history (surprises) — /stock/earnings
// Returns a bare array, not an envelope object.
// ---------------------------------------------------------------------------

export const FinnhubEarningsSurpriseSchema = z.object({
  symbol: z.string().optional(),
  period: z.string(),                  // YYYY-MM-DD (quarter end)
  actual: z.coerce.number(),
  estimate: z.coerce.number(),
  surprise: z.coerce.number().optional(),
  surprisePercent: z.coerce.number().optional(),
  year: z.number().optional(),
  quarter: z.number().optional(),
}).passthrough();

// /stock/earnings returns z.array(...) at the top level — not z.object.
// Tolerant wrapping: also allow null/undefined to fall through as [].
export const FinnhubEarningsHistoryResponseSchema = z.array(FinnhubEarningsSurpriseSchema);

// ---------------------------------------------------------------------------
// Insider transactions — /stock/insider-transactions
// Returns { data: [...], symbol: 'TICKER' }
// ---------------------------------------------------------------------------

export const FinnhubInsiderTxRowSchema = z.object({
  name: z.string().optional().default(''),
  share: z.coerce.number().optional().default(0),
  change: z.coerce.number().optional().default(0),
  filingDate: z.string().optional().default(''),
  transactionDate: z.string().optional().default(''),
  transactionPrice: z.coerce.number().optional().default(0),
  transactionCode: z.string().optional().default(''),
  isDerivative: z.boolean().optional().default(false),
  source: z.string().optional().default(''),
  currency: z.string().optional().default(''),
  symbol: z.string().optional(),
  id: z.string().optional(),
}).passthrough();

export const FinnhubInsiderTxResponseSchema = z.object({
  data: z.array(FinnhubInsiderTxRowSchema).optional().default([]),
  symbol: z.string().optional(),
}).passthrough();

// ---------------------------------------------------------------------------
// Recommendation trends — /stock/recommendation
// Returns a bare array of monthly snapshots. Each row has a `period`
// field (YYYY-MM-DD, the snapshot month-start) which we treat as the
// PIT timestamp — see W6 in data-provider.ts and the audit doc.
// Endpoint returns ~last 4 months by default.
// ---------------------------------------------------------------------------

export const FinnhubRecommendationRowSchema = z.object({
  symbol: z.string().optional(),
  period: z.string(),                       // YYYY-MM-DD (month-start)
  buy: z.coerce.number().optional().default(0),
  hold: z.coerce.number().optional().default(0),
  sell: z.coerce.number().optional().default(0),
  strongBuy: z.coerce.number().optional().default(0),
  strongSell: z.coerce.number().optional().default(0),
}).passthrough();

export const FinnhubRecommendationResponseSchema = z.array(FinnhubRecommendationRowSchema);

// ---------------------------------------------------------------------------
// Inferred types
// ---------------------------------------------------------------------------

export type FinnhubEarningsCalendarItem = z.infer<typeof FinnhubEarningsCalendarItemSchema>;
export type FinnhubEarningsCalendarResponse = z.infer<typeof FinnhubEarningsCalendarResponseSchema>;
export type FinnhubEarningsSurprise = z.infer<typeof FinnhubEarningsSurpriseSchema>;
export type FinnhubEarningsHistoryResponse = z.infer<typeof FinnhubEarningsHistoryResponseSchema>;
export type FinnhubInsiderTxRow = z.infer<typeof FinnhubInsiderTxRowSchema>;
export type FinnhubInsiderTxResponse = z.infer<typeof FinnhubInsiderTxResponseSchema>;
export type FinnhubRecommendationRow = z.infer<typeof FinnhubRecommendationRowSchema>;
export type FinnhubRecommendationResponse = z.infer<typeof FinnhubRecommendationResponseSchema>;
