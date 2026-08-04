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
    mentions: { state: 'TRACKED', mentions: 1, mentions24hAgo: null, rank: 399, universeSize: 757, floor: 1, reason: null },
    appRating: { available: true, appName: 'Crocs', rating: 4.73, ratingCount: 46441, matchConfidence: 'HIGH', reason: null },
    reviews: { available: true, recentPerDay: 1.29, priorPerDay: 1, velocityPct: 29, recentRating: 1.72, priorRating: 1.96, versionsInWindow: 2, truncated: false, spanDays: 72, count: 100, reason: null },
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

  it('shows every attention source side by side', async () => {
    await run();
    for (const name of [/wikipedia \(absolute\)/i, /google trends \(index\)/i, /wsb mentions/i, /app store rating/i]) {
      expect(screen.getByText(name)).toBeInTheDocument();
    }
    // "off-exchange volume" also appears in the footnote prose, so scope to
    // the row label rather than asserting a unique match.
    expect(screen.getAllByText(/off-exchange volume/i).length).toBeGreaterThan(0);
  });

  it('says "zero weight" in the heading, so no row can be read as a signal', async () => {
    await run();
    expect(screen.getByText(/context only, zero weight/i)).toBeInTheDocument();
  });

  it('states the sign convention: retail already here argues AGAINST the setup', async () => {
    await run();
    expect(screen.getByText(/argues against an undiscovered name, not for it/i)).toBeInTheDocument();
  });

  it('states that quiet is the EXPECTED state, not a bullish tell', async () => {
    await run();
    expect(screen.getByText(/argues against an undiscovered name, not for it/i)).toBeInTheDocument();
    expect(screen.getByText(/"Quiet" is the expected state/i)).toBeInTheDocument();
  });

  it('warns that the app rating count is cumulative', async () => {
    await run();
    expect(screen.getByText(/lifetime cumulative/i)).toBeInTheDocument();
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

  it('shows WSB mentions — the leg Quiver would not sell', async () => {
    await run();
    expect(screen.getByText(/wsb mentions/i)).toBeInTheDocument();
    expect(screen.getByText(/1 today, rank 399\/757/)).toBeInTheDocument();
  });

  it('renders "quiet" as a VALUE, not as greyed-out missing data', async () => {
    // A ticker below the tracking floor is a real observation. If it rendered
    // in the missing-data style the finding would be thrown away.
    fetchMock.mockImplementation(() => ok({
      ...PAYLOAD,
      evidence: {
        ...PAYLOAD.evidence,
        mentions: { state: 'BELOW_FLOOR', mentions: null, rank: null, universeSize: 757, floor: 1, reason: 'not tracked' },
      },
    }));
    await run();
    const el = screen.getByText(/quiet — under 1 mentions/);
    expect(el).toBeInTheDocument();
    expect(el.className).not.toMatch(/italic/);
  });

  it('shows the app rating and flags a weak match', async () => {
    fetchMock.mockImplementation(() => ok({
      ...PAYLOAD,
      evidence: {
        ...PAYLOAD.evidence,
        appRating: { available: true, appName: 'Skiing Yeti Mountain', rating: 4.82, ratingCount: 4956, matchConfidence: 'LOW', reason: null },
      },
    }));
    await run();
    expect(screen.getByText(/weak match/i)).toBeInTheDocument();
  });

  it('shows review velocity — the only demand flow on the strip', async () => {
    await run();
    expect(screen.getByText(/review velocity/i)).toBeInTheDocument();
    expect(screen.getByText(/\+29% · 1\.29\/day/)).toBeInTheDocument();
  });

  it('warns inline when multiple app versions could be driving the rate', async () => {
    await run();
    expect(screen.getByText(/2 versions — may be release-driven/i)).toBeInTheDocument();
  });

  it('shows the rate without a change when the prior window was never observed', async () => {
    fetchMock.mockImplementation(() => ok({
      ...PAYLOAD,
      evidence: {
        ...PAYLOAD.evidence,
        reviews: { available: true, recentPerDay: 5.5, priorPerDay: null, velocityPct: null, versionsInWindow: 2, truncated: true, spanDays: 34, count: 200, reason: 'feed covered only 34 days' },
      },
    }));
    await run();
    expect(screen.getByText(/5\.5\/day · no prior window/)).toBeInTheDocument();
  });

  it('shows DPI recent AND baseline together — never a bare level', async () => {
    await run();
    // A single DPI number invites cross-company comparison; the level tracks
    // market cap, so the pair is the only honest presentation.
    expect(screen.getByText(/DPI 0\.698 vs 0\.584/)).toBeInTheDocument();
  });
});
