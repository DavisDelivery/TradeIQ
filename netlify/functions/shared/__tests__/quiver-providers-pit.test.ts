import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the quiver-client at the module top — every provider uses it.
vi.mock('../quiver-client', async (orig) => {
  const actual = await orig<typeof import('../quiver-client')>();
  return {
    ...actual,
    quiverGetTicker: vi.fn(),
  };
});

import { getPoliticalActivity } from '../political-provider';
import { getPatentActivity } from '../patent-provider';
import { getGovContractActivity } from '../govcontracts-provider';
import * as quiverClient from '../quiver-client';

beforeEach(() => {
  vi.mocked(quiverClient.quiverGetTicker).mockReset();
});

// ===========================================================================
// W7a — Political (Quiver senate + house + lobbying) PIT
// ===========================================================================

describe('getPoliticalActivity PIT semantics', () => {
  // Senate trade rows in Quiver shape
  const senate = [
    { Senator: 'Foo Senator', Date: '2024-08-15', Transaction: 'Purchase', Range: '$1,001 - $15,000', Amount: '1001.0', Party: 'R' },
    { Senator: 'Bar Senator', Date: '2024-04-15', Transaction: 'Purchase', Range: '$50,001 - $100,000', Amount: '50001.0', Party: 'D' },
    { Senator: 'Baz Senator', Date: '2023-12-15', Transaction: 'Sale', Range: '$1,001 - $15,000', Amount: '1001.0', Party: 'R' },
  ];
  const house: any[] = [];
  const lobbying = [
    { Date: '2024-09-30', Amount: '2000000.0', Client: 'FOO INC' },
    { Date: '2024-06-30', Amount: '1000000.0', Client: 'FOO INC' },
    { Date: '2023-12-31', Amount: '500000.0', Client: 'FOO INC' },
  ];

  it('returns all trades when asOfDate omitted', async () => {
    vi.mocked(quiverClient.quiverGetTicker)
      .mockResolvedValueOnce(senate)
      .mockResolvedValueOnce(house)
      .mockResolvedValueOnce(lobbying);
    // Use 4-year lookback so 2023-2024 fixture data falls inside the window
    // (real Date.now is 2026; default 180d would exclude them).
    const out = await getPoliticalActivity('FOO', 4 * 365);
    expect(out.totalTrades).toBe(3);
  });

  it('clips trades dated after asOfDate', async () => {
    vi.mocked(quiverClient.quiverGetTicker)
      .mockResolvedValueOnce(senate)
      .mockResolvedValueOnce(house)
      .mockResolvedValueOnce(lobbying);
    // asOfDate = 2024-06-01: drops the 2024-08-15 trade
    const out = await getPoliticalActivity('FOO', 365, { asOfDate: '2024-06-01' });
    expect(out.totalTrades).toBe(2);
    expect(out.recentTrades.every((t) => t.date <= '2024-06-01')).toBe(true);
  });

  it('clips lobbying filings dated after asOfDate', async () => {
    vi.mocked(quiverClient.quiverGetTicker)
      .mockResolvedValueOnce(senate)
      .mockResolvedValueOnce(house)
      .mockResolvedValueOnce(lobbying);
    const out = await getPoliticalActivity('FOO', 365, { asOfDate: '2024-08-01' });
    // 2024-09-30 dropped; 2024-06-30 in current window, 2023-12-31 in prior
    expect(out.recentFilings.every((f) => f.date <= '2024-08-01')).toBe(true);
  });
});

// ===========================================================================
// W7b — Patent PIT
// ===========================================================================

describe('getPatentActivity PIT semantics', () => {
  const patents = [
    { PatentNumber: 'P1', Title: 'AI thing', Date: '2024-09-15', CPC: 'G06N3/00', Assignee: 'FOO' },
    { PatentNumber: 'P2', Title: 'Semi thing', Date: '2024-05-15', CPC: 'H01L21/00', Assignee: 'FOO' },
    { PatentNumber: 'P3', Title: 'Old thing', Date: '2023-08-15', CPC: 'G06F1/00', Assignee: 'FOO' },
  ];

  it('returns all grants when asOfDate omitted', async () => {
    vi.mocked(quiverClient.quiverGetTicker).mockResolvedValueOnce(patents);
    const out = await getPatentActivity('FOO', 'Foo Inc', 4 * 365);
    expect(out.totalGrants).toBe(3);
  });

  it('clips grants dated after asOfDate', async () => {
    vi.mocked(quiverClient.quiverGetTicker).mockResolvedValueOnce(patents);
    const out = await getPatentActivity('FOO', 'Foo Inc', 365, { asOfDate: '2024-06-01' });
    // Only P2 (2024-05-15) and P3 (2023-08-15) should remain.
    expect(out.recentGrants.every((g) => g.grantDate <= '2024-06-01')).toBe(true);
    expect(out.recentGrants.find((g) => g.patentId === 'P1')).toBeUndefined();
  });
});

// ===========================================================================
// W7c — GovContracts PIT
// ===========================================================================

describe('getGovContractActivity PIT semantics', () => {
  const contracts = [
    { Date: '2024-12-01', action_date: '2024-09-15', Amount: 1000000, Agency: 'Department of Defense', Description: 'A' },
    { Date: '2024-08-01', action_date: '2024-06-15', Amount: 500000, Agency: 'Department of Energy', Description: 'B' },
    { Date: '2023-11-01', action_date: '2023-09-15', Amount: 250000, Agency: 'NASA', Description: 'C' },
  ];

  it('returns all contracts when asOfDate omitted', async () => {
    vi.mocked(quiverClient.quiverGetTicker).mockResolvedValueOnce(contracts);
    const out = await getGovContractActivity('FOO', 4 * 365);
    expect(out.totalContracts).toBe(3);
  });

  it('clips contracts published after asOfDate (uses Date, not action_date)', async () => {
    vi.mocked(quiverClient.quiverGetTicker).mockResolvedValueOnce(contracts);
    // Critical: action_date 2024-09-15 < 2024-10-01 cutoff, but Date is
    // 2024-12-01 (publication). Must use Date for PIT.
    const out = await getGovContractActivity('FOO', 365, { asOfDate: '2024-10-01' });
    expect(out.recentContracts.every((c) => c.date <= '2024-10-01')).toBe(true);
    // The 2024-12-01-published contract must be excluded even though its
    // action_date precedes the cutoff.
    expect(out.recentContracts.find((c) => c.amount === 1000000)).toBeUndefined();
  });
});
