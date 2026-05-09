import { describe, it, expect } from 'vitest';
import {
  QuiverCongressionalArraySchema,
  QuiverLobbyingArraySchema,
  QuiverGovContractArraySchema,
  QuiverPatentArraySchema,
  QuiverResponseSchema,
} from '../quiver';

// Quiver's API famously varies field casing across datasets and even
// across endpoints within a dataset. The schemas below reflect that
// reality: every field optional, .passthrough() everywhere, primary
// goal is "did we get an array of records?" rather than tight shape
// enforcement.

const congressionalFixture = [
  {
    Representative: 'Doe, Jane',
    Transaction: 'Purchase',
    Range: '$15,001 - $50,000',
    Amount: 32500,
    TransactionDate: '2024-09-15',
    ReportDate: '2024-10-15',
    Disclosure: 'P',
    Ticker: 'AAPL',
    Party: 'D',
    House: 'House',
    Chamber: 'House',
  },
  {
    Senator: 'Smith, John',
    Transaction: 'Sale',
    Range: '$100,001 - $250,000',
    TransactionDate: '2024-08-22',
    Filed: '2024-09-30',
    Ticker: 'AAPL',
    Party: 'R',
  },
];

const lobbyingFixture = [
  { Client: 'Apple Inc', Amount: 2_400_000, Date: '2024-Q3', Issue: 'TAX', Ticker: 'AAPL' },
  { Client: 'Apple Inc', Dollars: '2100000', Date: '2024-Q2', Issue: 'TRD', Ticker: 'AAPL' },
];

const govContractFixture = [
  {
    Date: '2024-09-15',
    Amount: 12_500_000,
    Agency: 'Department of Defense',
    Description: 'Cloud infrastructure modernization',
    Ticker: 'AMZN',
  },
  {
    ActionDate: '2024-08-30',
    Dollars: '8500000',
    AwardingAgency: 'Department of Veterans Affairs',
    Award: 'EHR support services',
    Ticker: 'AMZN',
  },
];

const patentFixture = [
  {
    Date: '2024-07-15',
    Title: 'Method and apparatus for adaptive cooling',
    PatentNumber: 'US12345678',
    Abstract: 'A system for thermal management of compute clusters...',
    Ticker: 'AAPL',
    Filed: '2022-01-10',
    Granted: '2024-07-15',
  },
];

describe('QuiverCongressionalArraySchema', () => {
  it('parses senate + house mixed records', () => {
    const parsed = QuiverCongressionalArraySchema.safeParse(congressionalFixture);
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data).toHaveLength(2);
  });

  it('tolerates Amount as either string or number', () => {
    const mixed = [
      { Representative: 'X', Amount: 1000, TransactionDate: '2024-01-01' },
      { Representative: 'Y', Amount: '1000', TransactionDate: '2024-01-02' },
    ];
    const parsed = QuiverCongressionalArraySchema.safeParse(mixed);
    expect(parsed.success).toBe(true);
  });

  it('passes through unknown future fields', () => {
    const withExtra = [{ ...congressionalFixture[0], NewlyAddedField: 'value' }];
    const parsed = QuiverCongressionalArraySchema.safeParse(withExtra);
    expect(parsed.success).toBe(true);
  });

  it('fails when the response is not an array (catastrophic shape break)', () => {
    const parsed = QuiverCongressionalArraySchema.safeParse({ data: congressionalFixture });
    expect(parsed.success).toBe(false);
  });

  it('handles an empty array', () => {
    const parsed = QuiverCongressionalArraySchema.safeParse([]);
    expect(parsed.success).toBe(true);
  });
});

describe('QuiverLobbyingArraySchema', () => {
  it('parses real lobbying records', () => {
    const parsed = QuiverLobbyingArraySchema.safeParse(lobbyingFixture);
    expect(parsed.success).toBe(true);
  });

  it('tolerates Amount/Dollars in either string or number form', () => {
    const parsed = QuiverLobbyingArraySchema.safeParse([
      { Client: 'X', Amount: 1, Ticker: 'X' },
      { Client: 'Y', Dollars: '2', Ticker: 'Y' },
    ]);
    expect(parsed.success).toBe(true);
  });

  it('passes through unknown extra keys', () => {
    const parsed = QuiverLobbyingArraySchema.safeParse([
      { ...lobbyingFixture[0], Filer: 'Akin Gump' },
    ]);
    expect(parsed.success).toBe(true);
  });
});

describe('QuiverGovContractArraySchema', () => {
  it('parses contracts with both Date and ActionDate field-name casings', () => {
    const parsed = QuiverGovContractArraySchema.safeParse(govContractFixture);
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data).toHaveLength(2);
  });

  it('tolerates Agency vs AwardingAgency, Amount vs Dollars', () => {
    const parsed = QuiverGovContractArraySchema.safeParse([
      { Date: '2024-01-01', Agency: 'X', Amount: 100, Ticker: 'X' },
      { ActionDate: '2024-01-02', AwardingAgency: 'Y', Dollars: '200', Ticker: 'Y' },
    ]);
    expect(parsed.success).toBe(true);
  });

  it('passes through new fields like SubAwardId', () => {
    const parsed = QuiverGovContractArraySchema.safeParse([
      { ...govContractFixture[0], SubAwardId: 'SUB-12345', RecipientUEI: 'ABC1234' },
    ]);
    expect(parsed.success).toBe(true);
  });
});

describe('QuiverPatentArraySchema', () => {
  it('parses real patent records', () => {
    const parsed = QuiverPatentArraySchema.safeParse(patentFixture);
    expect(parsed.success).toBe(true);
  });

  it('tolerates patents with no granted date (still pending)', () => {
    const parsed = QuiverPatentArraySchema.safeParse([
      { Filed: '2024-01-01', Title: 'Pending application', Ticker: 'X' },
    ]);
    expect(parsed.success).toBe(true);
  });

  it('passes through extra fields', () => {
    const parsed = QuiverPatentArraySchema.safeParse([
      { ...patentFixture[0], InventorList: ['A', 'B'], Classification: 'G06F' },
    ]);
    expect(parsed.success).toBe(true);
  });
});

describe('QuiverResponseSchema (top-level wrapper)', () => {
  it('accepts a bare array', () => {
    const parsed = QuiverResponseSchema.safeParse(congressionalFixture);
    expect(parsed.success).toBe(true);
  });

  it('accepts an enveloped {data: [...]} response', () => {
    const parsed = QuiverResponseSchema.safeParse({ data: congressionalFixture });
    expect(parsed.success).toBe(true);
  });

  it('accepts a {records: [...]} response (alternate envelope)', () => {
    const parsed = QuiverResponseSchema.safeParse({ records: congressionalFixture });
    expect(parsed.success).toBe(true);
  });

  it('accepts null (which the client returns on tier-gated 403/404)', () => {
    const parsed = QuiverResponseSchema.safeParse(null);
    expect(parsed.success).toBe(true);
  });

  it('rejects entirely unrecognized shapes', () => {
    const parsed = QuiverResponseSchema.safeParse(42);
    expect(parsed.success).toBe(false);
  });
});
