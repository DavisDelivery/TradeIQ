import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CamilloPanel } from '../components/detail/CamilloPanel.jsx';

// CAMILLO-1 — the two rules this panel exists to enforce visually:
//   1. nothing fires until clicked (the endpoint costs Anthropic budget)
//   2. the unverified list is never demoted, hidden, or collapsed

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

const PAYLOAD = {
  ok: true, ticker: 'CROX', universe: 'russell2k', model: 'claude-opus-5',
  read: {
    product: 'Casual footwear under two brands.',
    trend: 'Sales growth 22% QoQ is the only real demand signal.',
    materiality: 'Cannot be judged — no segment revenue in the evidence.',
    discovery: 'Institutional ownership 45%, room left.',
    readVerdict: 'WORTH_DIGGING',
    whyVerdict: 'Real growth, not yet crowded.',
    falsifier: 'Sales growth decelerating below 5% next quarter.',
    nextChecks: ['Read the 10-K segment note'],
    unverified: ['segment revenue', 'whether a trend exists at all'],
  },
  evidence: {
    asOf: '2026-08-03', hasFundamentals: true, attention: { momPct: 12, recentDailyMean: 1200 },
    googleTrends: { available: true, keyword: 'Crocs Inc', recentVsBase: 8.4, reason: null },
    offExchange: {
      available: true, volumeZ: 0.3, recentDailyVolume: 458685,
      dpiRecent: 0.698, dpiBase: 0.584, days: 1209, asOf: '2026-08-03', reason: null,
    },
    insiderCount: 1, newsCount: 4, nextEarnings: null, gaps: ['google trends: not configured'],
  },
};

const ok = (b) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(b) });

function renderPanel() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><CamilloPanel ticker="CROX" /></QueryClientProvider>);
}

beforeEach(() => { fetchMock.mockReset(); fetchMock.mockImplementation(() => ok(PAYLOAD)); });
afterEach(cleanup);

describe('CamilloPanel', () => {
  it('fires NOTHING until clicked — the call costs budget', () => {
    renderPanel();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /run the read/i })).toBeInTheDocument();
  });

  it('runs on click and renders the four questions', async () => {
    renderPanel();
    fireEvent.click(screen.getByRole('button', { name: /run the read/i }));
    await waitFor(() => expect(screen.getByText(/Casual footwear/)).toBeInTheDocument());
    expect(screen.getByText(/What it sells/i)).toBeInTheDocument();
    expect(screen.getByText(/Is demand changing/i)).toBeInTheDocument();
    expect(screen.getByText(/Materiality — the question that kills these/i)).toBeInTheDocument();
    expect(screen.getByText(/Has the market noticed/i)).toBeInTheDocument();
    expect(screen.getByText(/Falsifier/i)).toBeInTheDocument();
  });

  it('always shows the unverified list', async () => {
    renderPanel();
    fireEvent.click(screen.getByRole('button', { name: /run the read/i }));
    await waitFor(() => expect(screen.getByText(/Not verified/i)).toBeInTheDocument());
    expect(screen.getByText('segment revenue')).toBeInTheDocument();
    // Not inside a <details> — it must not be collapsible.
    expect(screen.getByText('segment revenue').closest('details')).toBeNull();
  });

  it('shows the verdict as a WORD, never a number', async () => {
    renderPanel();
    fireEvent.click(screen.getByRole('button', { name: /run the read/i }));
    await waitFor(() => expect(screen.getByText('Worth digging')).toBeInTheDocument());
    const panel = screen.getByText('Worth digging').closest('section');
    expect(panel.textContent).not.toMatch(/\b\d{1,3}\s*\/\s*100\b/);
  });

  it('names the model that answered', async () => {
    renderPanel();
    fireEvent.click(screen.getByRole('button', { name: /run the read/i }));
    await waitFor(() => expect(screen.getByText('claude-opus-5')).toBeInTheDocument());
  });

  it('surfaces a refusal (422) as a readable reason, not a blank panel', async () => {
    fetchMock.mockImplementation(() => Promise.resolve({
      ok: false, status: 422,
      json: () => Promise.resolve({ error: 'insufficient_evidence', message: 'No screener row and no news for CROX.' }),
    }));
    renderPanel();
    fireEvent.click(screen.getByRole('button', { name: /run the read/i }));
    await waitFor(() => expect(screen.getByText(/No screener row and no news/)).toBeInTheDocument());
  });

  it('sends the ticker and universe', async () => {
    renderPanel();
    fireEvent.click(screen.getByRole('button', { name: /run the read/i }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(String(fetchMock.mock.calls[0][0])).toContain('/api/camillo-research?ticker=CROX');
  });
});

// The context strip carries three attention sources that were asked to be
// VISIBLE and are deliberately UNWEIGHTED. The risk it manages is that a
// number on screen reads as a signal — so the heading, not the reader,
// has to carry the disclaimer.
describe('CamilloPanel context strip', () => {
  const run = async () => {
    renderPanel();
    fireEvent.click(screen.getByRole('button', { name: /run the read/i }));
    await waitFor(() => expect(screen.getByText(/Attention & crowding/i)).toBeInTheDocument());
  };

  it('shows Google Trends even though it has no weight', async () => {
    await run();
    expect(screen.getByText(/google trends \(index\)/i)).toBeInTheDocument();
    expect(screen.getByText(/\+8\.4 idx pts/)).toBeInTheDocument();
  });

  it('shows all three sources side by side', async () => {
    await run();
    expect(screen.getByText(/wikipedia \(absolute\)/i)).toBeInTheDocument();
    expect(screen.getByText(/google trends \(index\)/i)).toBeInTheDocument();
    expect(screen.getByText(/off-exchange volume/i)).toBeInTheDocument();
  });

  it('says "zero weight" in the heading, so no row can be read as a signal', async () => {
    await run();
    expect(screen.getByText(/context only, zero weight/i)).toBeInTheDocument();
  });

  it('states the sign convention: retail already here argues AGAINST the setup', async () => {
    await run();
    expect(screen.getByText(/argues against an undiscovered name, not for it/i)).toBeInTheDocument();
  });

  it('says WSB is not on the plan, so its absence is not read as quiet', async () => {
    await run();
    expect(screen.getByText(/WallStreetBets mentions are not on this Quiver plan/i)).toBeInTheDocument();
  });

  it('prints the REASON a source is missing, never a dash that reads as zero', async () => {
    fetchMock.mockImplementation(() => ok({
      ...PAYLOAD,
      evidence: {
        ...PAYLOAD.evidence,
        googleTrends: { available: false, keyword: 'Crocs Inc', recentVsBase: null, reason: 'SERPAPI_KEY unset' },
        offExchange: { available: false, volumeZ: null, days: 0, reason: 'Quiver request failed' },
      },
    }));
    await run();
    expect(screen.getByText('SERPAPI_KEY unset')).toBeInTheDocument();
    expect(screen.getByText('Quiver request failed')).toBeInTheDocument();
  });

  it('shows DPI recent AND baseline together — never a bare level', async () => {
    await run();
    // A single DPI number invites cross-company comparison; the level tracks
    // market cap, so the pair is the only honest presentation.
    expect(screen.getByText(/DPI 0\.698 vs 0\.584/)).toBeInTheDocument();
  });
});
