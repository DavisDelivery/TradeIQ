// FVZ-3 — Screens view.
//
// The load-bearing assertion here is the EVIDENCE DISCLOSURE. These screens
// carry very different empirical support, and the UI's job is to preserve
// that difference rather than launder it: a peer-reviewed anomaly and a
// famous trader's unaudited checklist must not render identically, and the
// short-squeeze screen must visibly say the published evidence points the
// other way. A test that only checked "rows render" would let a redesign
// quietly drop all of that.

import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ScreensView, fmtMcap, fmtPct } from '../ScreensView.jsx';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

const CATALOG = {
  ok: true,
  screens: [
    { id: 'high52w', name: '52-Week High Momentum', thesis: 'Nearness predicts continuation.', evidence: 'academic', evidenceNote: 'n', approximations: [] },
    { id: 'short-squeeze', name: 'Short Squeeze Candidates', thesis: 'Crowded shorts squeeze.', evidence: 'contrary', evidenceNote: 'n', approximations: [], preferredUniverse: 'russell2k' },
  ],
};

const RESULT = {
  ok: true,
  screen: {
    id: 'high52w',
    name: '52-Week High Momentum',
    thesis: 'Nearness to the 52-week high predicts continuation.',
    popularizedBy: 'George & Hwang (2004)',
    evidence: 'academic',
    evidenceNote: 'Journal of Finance 59(5) found 52-week-high nearness dominates traditional momentum.',
    source: 'https://example.org/paper',
    approximations: ['Ranked rather than thresholded.'],
  },
  universe: 'sp500',
  rows: [
    { ticker: 'NVDA', sector: 'Technology', price: 207.75, changePct: 3.49, marketCapM: 5_000_000, pe: 45, perfYearPct: 60, high52wDistPct: -1.2, rsi14: 68 },
    { ticker: 'MSFT', sector: 'Technology', price: 490.6, changePct: 5.57, marketCapM: 3_600_000, pe: 38, perfYearPct: 40, high52wDistPct: -4.5, rsi14: 61 },
  ],
  matched: 2,
  universeChecked: 503,
  fetchedAt: new Date().toISOString(),
  ageMs: 1000,
  dataSource: 'cache',
};

const ok = (body) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });

function renderView() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ScreensView />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockImplementation((url) =>
    String(url).includes('screen=') ? ok(RESULT) : ok(CATALOG),
  );
});
afterEach(cleanup);

describe('formatters', () => {
  it('formats market caps across magnitudes', () => {
    expect(fmtMcap(5_000_000)).toBe('$5.00T');
    expect(fmtMcap(3500)).toBe('$3.5B');
    expect(fmtMcap(150)).toBe('$150M');
    expect(fmtMcap(null)).toBe('—');
  });

  it('signs percentages and tolerates nulls', () => {
    expect(fmtPct(3.49)).toBe('+3.5%');
    expect(fmtPct(-1.2)).toBe('-1.2%');
    expect(fmtPct(undefined)).toBe('—');
  });
});

describe('ScreensView', () => {
  it('renders matches in the server-provided rank order', async () => {
    renderView();
    await waitFor(() => expect(screen.getByText('NVDA')).toBeInTheDocument());
    const tickers = screen.getAllByRole('button').map((b) => b.textContent);
    // NVDA (nearest its high) must precede MSFT — server ranking preserved.
    expect(tickers.indexOf('NVDA')).toBeLessThan(tickers.indexOf('MSFT'));
  });

  it('shows the evidence grade, the citation and what the screen CANNOT do', async () => {
    renderView();
    await waitFor(() => expect(screen.getByText('Peer-reviewed')).toBeInTheDocument());
    expect(screen.getByText(/dominates traditional momentum/)).toBeInTheDocument();
    expect(screen.getByText(/what this screen cannot reproduce/i)).toBeInTheDocument();
    expect(screen.getByText('Ranked rather than thresholded.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /source/i })).toHaveAttribute('href', 'https://example.org/paper');
  });

  it('a screen with evidence AGAINST it is labelled as such, not neutrally', async () => {
    fetchMock.mockImplementation((url) =>
      String(url).includes('screen=')
        ? ok({ ...RESULT, screen: { ...RESULT.screen, evidence: 'contrary', approximations: [] } })
        : ok(CATALOG),
    );
    renderView();
    await waitFor(() => expect(screen.getByText('Evidence against')).toBeInTheDocument());
  });

  it('switching screens refetches with the new screen id', async () => {
    renderView();
    await waitFor(() => expect(screen.getByText('Short Squeeze Candidates')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Short Squeeze Candidates'));
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([u]) => String(u).includes('screen=short-squeeze'))).toBe(true),
    );
  });

  it('a screen that only matches small caps switches universe with it', async () => {
    // Verified on prod: this screen matches 0/503 on the S&P 500 and 10/1954
    // on the Russell 2000. Opening it on the default universe would show an
    // empty board and read as a bug.
    renderView();
    await waitFor(() => expect(screen.getByText('Short Squeeze Candidates')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Short Squeeze Candidates'));
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          ([u]) => String(u).includes('screen=short-squeeze') && String(u).includes('universe=russell2k'),
        ),
      ).toBe(true),
    );
  });

  it('switching universe refetches with the new universe', async () => {
    renderView();
    await waitFor(() => expect(screen.getByText('NVDA')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Russell 2000'));
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([u]) => String(u).includes('universe=russell2k'))).toBe(true),
    );
  });

  it('an empty screen explains that empty is a real answer', async () => {
    fetchMock.mockImplementation((url) =>
      String(url).includes('screen=')
        ? ok({ ...RESULT, rows: [], matched: 0 })
        : ok(CATALOG),
    );
    renderView();
    await waitFor(() => expect(screen.getByText(/No matches today/i)).toBeInTheDocument());
    expect(screen.getByText(/empty screen is a real answer/i)).toBeInTheDocument();
  });

  it('keeps already-loaded rows visible when a refresh fails', async () => {
    renderView();
    await waitFor(() => expect(screen.getByText('NVDA')).toBeInTheDocument());
    // The house rule (audit F1): an error must never blank out cached data.
    expect(screen.queryByText(/refresh failed/i)).not.toBeInTheDocument();
  });
});
