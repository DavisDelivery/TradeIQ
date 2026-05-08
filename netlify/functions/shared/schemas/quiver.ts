// Quiver Quantitative response schemas.
//
// Quiver datasets fetched via quiver-client.ts -> quiverGetTicker(dataset, ticker):
//   - senatetrading       (political-provider.ts)
//   - housetrading        (political-provider.ts)
//   - lobbying            (political-provider.ts)
//   - govcontractsall     (govcontracts-provider.ts)
//   - allpatents          (patent-provider.ts; primary)
//   - patents             (patent-provider.ts; fallback)
//
// Quiver's API has historically been *extremely* inconsistent with field
// casing — Date / date / TransactionDate / ActionDate all coexist depending
// on dataset. Existing providers normalize this via q()/qn()/qdate() helpers
// in quiver-client.ts. The schemas here intentionally mark every field
// optional and use .passthrough() — the goal is to:
//   (1) guarantee we got an array of records
//   (2) detect a complete shape break (e.g., Quiver suddenly returns
//       {error: ...} instead of an array)
//   (3) NOT block on individual field name drift, which the q() helpers
//       handle.

import { z } from 'zod';

// All Quiver records share a flexible shape — fields optional, .passthrough()
// to tolerate field-casing variation. We capture the union of common keys
// across casings so downstream tooling has typing hints.

const QuiverGenericRecordSchema = z.object({
  // common date fields across datasets
  Date: z.string().optional(),
  date: z.string().optional(),
  TransactionDate: z.string().optional(),
  ActionDate: z.string().optional(),
  ReportDate: z.string().optional(),
  Disclosure: z.string().optional(),
  Filed: z.string().optional(),
  // common amount/value fields
  Amount: z.union([z.string(), z.number()]).optional(),
  Dollars: z.union([z.string(), z.number()]).optional(),
  amount: z.union([z.string(), z.number()]).optional(),
  dollars: z.union([z.string(), z.number()]).optional(),
  Value: z.union([z.string(), z.number()]).optional(),
  // common ticker/symbol fields
  Ticker: z.string().optional(),
  ticker: z.string().optional(),
  Symbol: z.string().optional(),
  // descriptive fields
  Description: z.string().optional(),
  description: z.string().optional(),
  Title: z.string().optional(),
  title: z.string().optional(),
  // agency/representative
  Agency: z.string().optional(),
  AwardingAgency: z.string().optional(),
  agency: z.string().optional(),
  Representative: z.string().optional(),
  Senator: z.string().optional(),
  Client: z.string().optional(),
  Issue: z.string().optional(),
  Award: z.string().optional(),
}).passthrough();

// Each dataset is fundamentally an array. `quiverGet` already collapses
// `{data: [...]}` and `{records: [...]}` envelopes back to an array, so by
// the time the provider receives the response it should be an array — but
// we model both shapes here in case that wrapper changes.

export const QuiverArrayResponseSchema = z.array(QuiverGenericRecordSchema);

export const QuiverEnvelopedResponseSchema = z.object({
  data: z.array(QuiverGenericRecordSchema).optional(),
  records: z.array(QuiverGenericRecordSchema).optional(),
}).passthrough();

// Union: either a bare array, an envelope, or null (which the client
// returns on tier-gated 403s and 404s).
export const QuiverResponseSchema = z.union([
  QuiverArrayResponseSchema,
  QuiverEnvelopedResponseSchema,
  z.null(),
]);

// ---------------------------------------------------------------------------
// Per-dataset row schemas — for tighter validation in the providers
// themselves. All fields optional + .passthrough() because Quiver field
// names vary by case and dataset.
// ---------------------------------------------------------------------------

export const QuiverInsiderRowSchema = QuiverGenericRecordSchema;

export const QuiverCongressionalTradeRowSchema = z.object({
  Representative: z.string().optional(),
  Senator: z.string().optional(),
  Transaction: z.string().optional(),
  Range: z.string().optional(),
  Amount: z.union([z.string(), z.number()]).optional(),
  TransactionDate: z.string().optional(),
  ReportDate: z.string().optional(),
  Disclosure: z.string().optional(),
  Filed: z.string().optional(),
  Date: z.string().optional(),
  Ticker: z.string().optional(),
  Party: z.string().optional(),
  House: z.string().optional(),
  Chamber: z.string().optional(),
}).passthrough();

export const QuiverLobbyingRowSchema = z.object({
  Client: z.string().optional(),
  Amount: z.union([z.string(), z.number()]).optional(),
  Dollars: z.union([z.string(), z.number()]).optional(),
  Date: z.string().optional(),
  Issue: z.string().optional(),
  ReportDate: z.string().optional(),
  Ticker: z.string().optional(),
}).passthrough();

export const QuiverGovContractRowSchema = z.object({
  Date: z.string().optional(),
  ActionDate: z.string().optional(),
  Amount: z.union([z.string(), z.number()]).optional(),
  Dollars: z.union([z.string(), z.number()]).optional(),
  Agency: z.string().optional(),
  AwardingAgency: z.string().optional(),
  Description: z.string().optional(),
  Award: z.string().optional(),
  Ticker: z.string().optional(),
}).passthrough();

export const QuiverPatentRowSchema = z.object({
  Date: z.string().optional(),
  Title: z.string().optional(),
  PatentNumber: z.string().optional(),
  Abstract: z.string().optional(),
  Ticker: z.string().optional(),
  Filed: z.string().optional(),
  Granted: z.string().optional(),
}).passthrough();

export const QuiverInsiderArraySchema = z.array(QuiverInsiderRowSchema);
export const QuiverCongressionalArraySchema = z.array(QuiverCongressionalTradeRowSchema);
export const QuiverLobbyingArraySchema = z.array(QuiverLobbyingRowSchema);
export const QuiverGovContractArraySchema = z.array(QuiverGovContractRowSchema);
export const QuiverPatentArraySchema = z.array(QuiverPatentRowSchema);

export type QuiverGenericRecord = z.infer<typeof QuiverGenericRecordSchema>;
export type QuiverCongressionalTradeRow = z.infer<typeof QuiverCongressionalTradeRowSchema>;
export type QuiverLobbyingRow = z.infer<typeof QuiverLobbyingRowSchema>;
export type QuiverGovContractRow = z.infer<typeof QuiverGovContractRowSchema>;
export type QuiverPatentRow = z.infer<typeof QuiverPatentRowSchema>;
