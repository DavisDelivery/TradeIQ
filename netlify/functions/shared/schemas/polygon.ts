// Polygon REST response schemas.
//
// These wrap inbound JSON from api.polygon.io at the boundary inside
// data-provider.ts. Drift in vendor field shapes surfaces as a single
// `schema_mismatch` warning instead of an `undefined` propagating three
// calls deep.
//
// Schema philosophy:
//   - Every top-level response uses .passthrough(). Polygon ships new
//     fields constantly (e.g., they added `vw` to bars without notice in
//     2022). Strict mode would mean any vendor expansion crashes prod.
//   - Optional fields use .optional(). Numeric fields that have arrived
//     as strings in the wild use z.coerce.number().
//   - We do NOT model every Polygon field — only what data-provider.ts
//     reads. If the provider starts reading a new field, add it here.

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Aggregates / bars — /v2/aggs/ticker/{ticker}/range/{multiplier}/{timespan}/{from}/{to}
// Also reused by /v2/aggs/ticker/{ticker}/prev which returns the same bar shape.
// ---------------------------------------------------------------------------

export const PolygonBarSchema = z.object({
  o: z.number(),                // open
  h: z.number(),                // high
  l: z.number(),                // low
  c: z.number(),                // close
  v: z.number(),                // volume
  t: z.number(),                // unix ms
  vw: z.number().optional(),    // volume-weighted price (added 2022)
  n: z.number().optional(),     // trade count
}).passthrough();

export const PolygonAggregatesResponseSchema = z.object({
  ticker: z.string().optional(),
  status: z.string().optional(),
  queryCount: z.number().optional(),
  resultsCount: z.number().optional(),
  results: z.array(PolygonBarSchema).optional().default([]),
  request_id: z.string().optional(),
  next_url: z.string().optional(),
}).passthrough();

// ---------------------------------------------------------------------------
// Reference / Financials — /vX/reference/financials
// Polygon's financials endpoint is famously deeply nested; we model only the
// nesting depth we read in getFundamentals().
// ---------------------------------------------------------------------------

// A single line item: { value: number, unit: string, label: string, ... }
// We only consume `value`. Polygon sometimes returns it as a string for
// extremely large numbers; coerce defensively.
const PolygonFinancialLineItemSchema = z.object({
  value: z.coerce.number().optional(),
  unit: z.string().optional(),
  label: z.string().optional(),
  order: z.number().optional(),
}).passthrough();

const PolygonIncomeStatementSchema = z.object({
  revenues: PolygonFinancialLineItemSchema.optional(),
  basic_earnings_per_share: PolygonFinancialLineItemSchema.optional(),
  gross_profit: PolygonFinancialLineItemSchema.optional(),
  operating_income_loss: PolygonFinancialLineItemSchema.optional(),
}).passthrough();

const PolygonBalanceSheetSchema = z.object({
  long_term_debt: PolygonFinancialLineItemSchema.optional(),
  equity: PolygonFinancialLineItemSchema.optional(),
}).passthrough();

const PolygonFinancialsBlockSchema = z.object({
  income_statement: PolygonIncomeStatementSchema.optional(),
  balance_sheet: PolygonBalanceSheetSchema.optional(),
}).passthrough();

export const PolygonFinancialsResultSchema = z.object({
  start_date: z.string().optional(),
  end_date: z.string().optional(),
  filing_date: z.string().optional(),
  fiscal_period: z.string().optional(),
  fiscal_year: z.string().optional(),
  cik: z.string().optional(),
  company_name: z.string().optional(),
  financials: PolygonFinancialsBlockSchema.optional(),
}).passthrough();

export const PolygonFinancialsResponseSchema = z.object({
  status: z.string().optional(),
  request_id: z.string().optional(),
  count: z.number().optional(),
  results: z.array(PolygonFinancialsResultSchema).optional().default([]),
  next_url: z.string().optional(),
}).passthrough();

// ---------------------------------------------------------------------------
// News — /v2/reference/news
// ---------------------------------------------------------------------------

const PolygonNewsPublisherSchema = z.object({
  name: z.string().optional(),
  homepage_url: z.string().optional(),
  logo_url: z.string().optional(),
  favicon_url: z.string().optional(),
}).passthrough();

export const PolygonNewsItemSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string().optional(),
  published_utc: z.string(),
  article_url: z.string(),
  tickers: z.array(z.string()).optional().default([]),
  publisher: PolygonNewsPublisherSchema.optional(),
  amp_url: z.string().optional(),
  image_url: z.string().optional(),
  keywords: z.array(z.string()).optional(),
  author: z.string().optional(),
}).passthrough();

export const PolygonNewsResponseSchema = z.object({
  status: z.string().optional(),
  count: z.number().optional(),
  request_id: z.string().optional(),
  results: z.array(PolygonNewsItemSchema).optional().default([]),
  next_url: z.string().optional(),
}).passthrough();

// ---------------------------------------------------------------------------
// Inferred types
// ---------------------------------------------------------------------------

export type PolygonBar = z.infer<typeof PolygonBarSchema>;
export type PolygonAggregatesResponse = z.infer<typeof PolygonAggregatesResponseSchema>;
export type PolygonFinancialsResponse = z.infer<typeof PolygonFinancialsResponseSchema>;
export type PolygonFinancialsResult = z.infer<typeof PolygonFinancialsResultSchema>;
export type PolygonNewsItem = z.infer<typeof PolygonNewsItemSchema>;
export type PolygonNewsResponse = z.infer<typeof PolygonNewsResponseSchema>;
