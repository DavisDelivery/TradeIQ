// Wave 4B (code-review-2026-06 M8) — provider failure discipline.
//
// Contract: a TRANSPORT failure (fetch throw, non-OK status, rate-limit
// exhaustion, malformed body) returns NULL so consumers take their
// no-data path (analyst-runner `_noData` weight rescale, scan-catalyst
// skip-not-score, prophet catalyst degraded warning). The `empty`
// activity object is reserved for VERIFIED-empty responses — HTTP 200
// with zero rows.
//
// Pre-fix, all three providers caught every error and returned `empty`,
// so a Quiver/Finnhub outage scored as "no insider activity, confidence
// 0.1" — the stub-score problem Phase 4f existed to eliminate. The
// transport-error tests in this file FAIL against that code (verified
// during Wave 4B by reverting the provider diffs and re-running).

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../data-provider', () => ({
  getFinnhubInsiderTransactionsWithStatus: vi.fn(),
}));

vi.mock('../edgar-roles', () => ({
  lookupInsiderRole: vi.fn(async () => null),
}));

vi.mock('../quiver-client', async (orig) => {
  const actual = await orig<typeof import('../quiver-client')>();
  return {
    ...actual,
    quiverGetTickerWithStatus: vi.fn(),
  };
});

import { getInsiderActivity } from '../insider-provider';
import { getPoliticalActivity } from '../political-provider';
import { getGovContractActivity } from '../govcontracts-provider';
import { getFinnhubInsiderTransactionsWithStatus } from '../data-provider';
import * as quiverClient from '../quiver-client';
import { __clearLiveCacheL1ForTesting } from '../provider-live-cache';

const finnhubMock = vi.mocked(getFinnhubInsiderTransactionsWithStatus);
const quiverMock = vi.mocked(quiverClient.quiverGetTickerWithStatus);

beforeEach(() => {
  finnhubMock.mockReset();
  quiverMock.mockReset();
  // 2026-07-15 — the providers now front a live cache with an in-process
  // L1; clear it so one case's verified-empty doesn't serve the next case.
  __clearLiveCacheL1ForTesting();
});

// ---------------------------------------------------------------------------
// insider-provider (Finnhub-backed)
// ---------------------------------------------------------------------------

describe('getInsiderActivity — transport-error discipline (M8)', () => {
  it('returns null when Finnhub rate-limit retries are exhausted', async () => {
    finnhubMock.mockResolvedValue({ data: [], rateLimited: true, rateLimitExhausted: true });
    const out = await getInsiderActivity('NVDA', 90);
    expect(out).toBeNull();
  });

  it('returns null on non-429 transport failure (errorMessage set)', async () => {
    finnhubMock.mockResolvedValue({
      data: [],
      rateLimited: false,
      rateLimitExhausted: false,
      errorMessage: 'finnhub status 500',
    });
    const out = await getInsiderActivity('NVDA', 90);
    expect(out).toBeNull();
  });

  it('returns null when the underlying fetch throws', async () => {
    finnhubMock.mockRejectedValue(new Error('socket hang up'));
    const out = await getInsiderActivity('NVDA', 90);
    expect(out).toBeNull();
  });

  it('returns the verified-empty activity object on HTTP 200 with zero rows', async () => {
    finnhubMock.mockResolvedValue({ data: [], rateLimited: false, rateLimitExhausted: false });
    const out = await getInsiderActivity('NVDA', 90);
    expect(out).not.toBeNull();
    expect(out!.totalBuys).toBe(0);
    expect(out!.totalSells).toBe(0);
    expect(out!.transactions).toEqual([]);
    expect(out!.ticker).toBe('NVDA');
  });

  it('still computes real activity from verified rows', async () => {
    finnhubMock.mockResolvedValue({
      data: [
        {
          name: 'CEO PERSON',
          share: 1_000,
          change: 1_000,
          filingDate: '2026-05-20',
          transactionDate: '2026-05-18',
          transactionPrice: 50,
          transactionCode: 'P',
          isDerivative: false,
          source: 'F4',
          currency: 'USD',
        },
      ],
      rateLimited: false,
      rateLimitExhausted: false,
    });
    const out = await getInsiderActivity('NVDA', 90);
    expect(out).not.toBeNull();
    expect(out!.totalBuys).toBe(1);
    expect(out!.buyDollars).toBe(50_000);
  });
});

// ---------------------------------------------------------------------------
// political-provider (Quiver senate + house + lobbying)
// ---------------------------------------------------------------------------

describe('getPoliticalActivity — transport-error discipline (M8)', () => {
  it('returns null when ANY of the three Quiver datasets fails transport', async () => {
    quiverMock
      .mockResolvedValueOnce({ rows: [], ok: true })    // senate verified-empty
      .mockResolvedValueOnce({ rows: [], ok: true })    // house verified-empty
      .mockResolvedValueOnce({ rows: [], ok: false });  // lobbying transport failure
    const out = await getPoliticalActivity('FOO', 180);
    expect(out).toBeNull();
  });

  it('returns null on a full Quiver outage (all datasets ok=false)', async () => {
    quiverMock.mockResolvedValue({ rows: [], ok: false });
    const out = await getPoliticalActivity('FOO', 180);
    expect(out).toBeNull();
  });

  it('returns the all-zeros activity object when all three datasets are verified-empty', async () => {
    quiverMock.mockResolvedValue({ rows: [], ok: true });
    const out = await getPoliticalActivity('FOO', 180);
    expect(out).not.toBeNull();
    expect(out!.totalTrades).toBe(0);
    expect(out!.totalLobbyingDollars).toBe(0);
    expect(out!.recentTrades).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// govcontracts-provider (Quiver govcontractsall)
// ---------------------------------------------------------------------------

describe('getGovContractActivity — transport-error discipline (M8)', () => {
  it('returns null on transport failure', async () => {
    quiverMock.mockResolvedValue({ rows: [], ok: false });
    const out = await getGovContractActivity('LMT', 180);
    expect(out).toBeNull();
  });

  it('returns null when the quiver client itself throws', async () => {
    quiverMock.mockRejectedValue(new Error('boom'));
    const out = await getGovContractActivity('LMT', 180);
    expect(out).toBeNull();
  });

  it('returns the verified-empty activity object on HTTP 200 with zero rows', async () => {
    quiverMock.mockResolvedValue({ rows: [], ok: true });
    const out = await getGovContractActivity('LMT', 180);
    expect(out).not.toBeNull();
    expect(out!.totalContracts).toBe(0);
    expect(out!.recentContracts).toEqual([]);
  });
});
