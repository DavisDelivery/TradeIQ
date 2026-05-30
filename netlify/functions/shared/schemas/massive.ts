// Schemas for Massive Financials endpoints (Phase 4w W2 migration).
//
// Replaces the legacy Polygon vX `reference/financials` endpoint with the
// four canonical Massive endpoints behind the Stocks Financials add-on:
//   - /stocks/financials/v1/ratios                  (current snapshot)
//   - /stocks/financials/v1/income-statements       (PIT history)
//   - /stocks/financials/v1/balance-sheets          (PIT history)
//   - /stocks/financials/v1/cash-flow-statements    (PIT history)
//
// All four use bare numeric fields (NOT the VX `{value, unit, label, order}`
// wrapping). All four pass through `parseOrFallback` so unexpected fields
// from the vendor never throw — they're just dropped.

import { z } from 'zod';

const nullableNum = z.number().nullable().optional();
const optStr = z.string().optional();
const optNum = z.number().optional();

// ---------------------------------------------------------------------------
// Common metadata block (present on all four endpoint result rows)
// ---------------------------------------------------------------------------

const MetadataSchema = z
  .object({
    tickers: z.array(z.string()).optional(),
    cik: optStr,
    period_end: optStr,
    filing_date: z.string().nullable().optional(),
    fiscal_year: z.union([z.number(), z.string()]).optional(),
    fiscal_quarter: z.union([z.number(), z.string()]).optional(),
    timeframe: optStr,
  })
  .passthrough();

// ---------------------------------------------------------------------------
// Ratios — /stocks/financials/v1/ratios
// CURRENT SNAPSHOT ONLY (no historical mode). Used for the live-mode
// comprehensive ratio block.
// ---------------------------------------------------------------------------

export const MassiveRatiosResultSchema = z
  .object({
    ticker: optStr,
    cik: optStr,
    date: optStr,
    price: nullableNum,
    average_volume: nullableNum,
    market_cap: nullableNum,
    earnings_per_share: nullableNum,
    price_to_earnings: nullableNum,
    price_to_book: nullableNum,
    price_to_sales: nullableNum,
    price_to_cash_flow: nullableNum,
    price_to_free_cash_flow: nullableNum,
    dividend_yield: nullableNum,
    return_on_assets: nullableNum,
    return_on_equity: nullableNum,
    debt_to_equity: nullableNum,
    // Liquidity ratios (named without the `_ratio` suffix on the wire).
    current: nullableNum,
    quick: nullableNum,
    cash: nullableNum,
    // Enterprise value ratios.
    ev_to_sales: nullableNum,
    ev_to_ebitda: nullableNum,
    enterprise_value: nullableNum,
    free_cash_flow: nullableNum,
  })
  .passthrough();

export const MassiveRatiosResponseSchema = z
  .object({
    status: optStr,
    request_id: optStr,
    next_url: optStr,
    results: z.array(MassiveRatiosResultSchema).optional().default([]),
  })
  .passthrough();

// ---------------------------------------------------------------------------
// Income statements
// ---------------------------------------------------------------------------

export const MassiveIncomeStatementResultSchema = MetadataSchema.merge(
  z.object({
    revenue: nullableNum,
    cost_of_revenue: nullableNum,
    gross_profit: nullableNum,
    selling_general_administrative: nullableNum,
    research_development: nullableNum,
    other_operating_expenses: nullableNum,
    total_operating_expenses: nullableNum,
    operating_income: nullableNum,
    interest_expense: nullableNum,
    interest_income: nullableNum,
    other_income_expense: nullableNum,
    total_other_income_expense: nullableNum,
    income_before_income_taxes: nullableNum,
    income_taxes: nullableNum,
    consolidated_net_income_loss: nullableNum,
    net_income_loss_attributable_common_shareholders: nullableNum,
    basic_earnings_per_share: nullableNum,
    diluted_earnings_per_share: nullableNum,
    basic_shares_outstanding: nullableNum,
    diluted_shares_outstanding: nullableNum,
    ebitda: nullableNum,
  }),
).passthrough();

export const MassiveIncomeStatementsResponseSchema = z
  .object({
    status: optStr,
    request_id: optStr,
    next_url: optStr,
    results: z.array(MassiveIncomeStatementResultSchema).optional().default([]),
  })
  .passthrough();

// ---------------------------------------------------------------------------
// Balance sheets
// ---------------------------------------------------------------------------

export const MassiveBalanceSheetResultSchema = MetadataSchema.merge(
  z.object({
    cash_and_equivalents: nullableNum,
    receivables: nullableNum,
    inventories: nullableNum,
    total_current_assets: nullableNum,
    property_plant_equipment_net: nullableNum,
    goodwill: nullableNum,
    total_assets: nullableNum,
    accounts_payable: nullableNum,
    debt_current: nullableNum,
    total_current_liabilities: nullableNum,
    // Phase 4w Q4 decision: this field bundles capital leases — no separate
    // ASC-842 residual handling. Map VX `long_term_debt` → this.
    long_term_debt_and_capital_lease_obligations: nullableNum,
    total_liabilities: nullableNum,
    common_stock: nullableNum,
    retained_earnings_deficit: nullableNum,
    // Phase 4w Q3 decision: use total_equity_attributable_to_parent (parent
    // only, excludes minority interest) for VX-continuity in debtToEquity.
    total_equity_attributable_to_parent: nullableNum,
    noncontrolling_interest: nullableNum,
    total_equity: nullableNum,
    total_liabilities_and_equity: nullableNum,
  }),
).passthrough();

export const MassiveBalanceSheetsResponseSchema = z
  .object({
    status: optStr,
    request_id: optStr,
    next_url: optStr,
    results: z.array(MassiveBalanceSheetResultSchema).optional().default([]),
  })
  .passthrough();

// ---------------------------------------------------------------------------
// Cash flow statements
// ---------------------------------------------------------------------------

export const MassiveCashFlowResultSchema = MetadataSchema.merge(
  z.object({
    net_income: nullableNum,
    depreciation_depletion_and_amortization: nullableNum,
    other_operating_activities: nullableNum,
    change_in_other_operating_assets_and_liabilities_net: nullableNum,
    net_cash_from_operating_activities: nullableNum,
    purchase_of_property_plant_and_equipment: nullableNum,
    sale_of_property_plant_and_equipment: nullableNum,
    other_investing_activities: nullableNum,
    net_cash_from_investing_activities: nullableNum,
    long_term_debt_issuances_repayments: nullableNum,
    short_term_debt_issuances_repayments: nullableNum,
    dividends: nullableNum,
    other_financing_activities: nullableNum,
    net_cash_from_financing_activities: nullableNum,
    effect_of_currency_exchange_rate: nullableNum,
    change_in_cash_and_equivalents: nullableNum,
  }),
).passthrough();

export const MassiveCashFlowStatementsResponseSchema = z
  .object({
    status: optStr,
    request_id: optStr,
    next_url: optStr,
    results: z.array(MassiveCashFlowResultSchema).optional().default([]),
  })
  .passthrough();

// ---------------------------------------------------------------------------
// Inferred types
// ---------------------------------------------------------------------------

export type MassiveRatiosResult = z.infer<typeof MassiveRatiosResultSchema>;
export type MassiveIncomeStatement = z.infer<typeof MassiveIncomeStatementResultSchema>;
export type MassiveBalanceSheet = z.infer<typeof MassiveBalanceSheetResultSchema>;
export type MassiveCashFlow = z.infer<typeof MassiveCashFlowResultSchema>;

// Silence unused-import warnings — keep optNum exported via reference so future
// schema extensions can use it without re-importing.
export const _unused = optNum;
