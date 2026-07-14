import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CrossesView, formatCrossDate } from '../CrossesView.jsx';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

const ROWS = [
  { ticker: 'AAPL', type: 'golden', date: '2026-07-10', closeAtCross: 200, sma50: 201, sma200: 199, barsAgo: 1, lastClose: 210, pctSinceCross: 5, name: 'Apple Inc', sector: 'Tech' },
  { ticker: 'XOM', type: 'death', date: '2026-05-01', closeAtCross: 100, sma50: 99, sma200: 101, barsAgo: 48, lastClose: 90, pctSinceCross: -10, name: 'Exxon', sector: 'Energy' },
  { ticker: 'MSFT', type: 'golden', date: '2026-06-15', closeAtCross: 300, sma50: 301, sma200: 299, barsAgo: 20, lastClose: 400, pctSinceCross: 33.3, name: 'Microsoft', sector: 'Tech' },
];

function ok(body) {
  return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
}

function renderView() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <CrossesView />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockImplementation(() =>
    ok({ ok: true, rows: ROWS, universeChecked: 500, generatedAt: new Date().toISOString() }),
  );
});
afterEach(cleanup);

describe('formatCrossDate', () => {
  it('formats YYYY-MM-DD without a local-timezone day shift', () => {
    // The classic F3 bug: new Date('2026-07-10') renders Jul 9 in US zones.
    expect(formatCrossDate('2026-07-10')).toBe('Jul 10, 2026');
    expect(formatCrossDate('2026-01-01')).toBe('Jan 1, 2026');
    expect(formatCrossDate(null)).toBe('—');
  });
});

describe('CrossesView', () => {
  it('renders rows sorted by date desc by default, with a NEW badge on fresh crosses', async () => {
    renderView();
    const aapl = await screen.findByText('AAPL');
    expect(aapl).toBeInTheDocument();
    const tickers = screen.getAllByRole('row').slice(1).map((tr) => tr.querySelector('td:nth-child(2)')?.textContent);
    expect(tickers[0]).toContain('AAPL'); // 2026-07-10 newest first
    expect(tickers[2]).toContain('XOM');  // 2026-05-01 oldest last
    expect(screen.getByText('new')).toBeInTheDocument(); // barsAgo 1 ≤ 5
  });

  it('clicking the Date header flips the sort to ascending', async () => {
    renderView();
    await screen.findByText('AAPL');
    fireEvent.click(screen.getByText('Date'));
    const tickers = screen.getAllByRole('row').slice(1).map((tr) => tr.querySelector('td:nth-child(2)')?.textContent);
    expect(tickers[0]).toContain('XOM'); // oldest first after flip
  });

  it('requests the server-side type filter when a chip is clicked', async () => {
    renderView();
    await screen.findByText('AAPL');
    fireEvent.click(screen.getByRole('button', { name: 'Golden' }));
    // A new query fires with type=golden in the URL.
    const urls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.includes('type=golden'))).toBe(true);
  });
});
