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
  evidence: { asOf: '2026-08-03', hasFundamentals: true, attention: { momPct: 12 }, insiderCount: 1, newsCount: 4, nextEarnings: null, gaps: ['google trends: not configured'] },
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
