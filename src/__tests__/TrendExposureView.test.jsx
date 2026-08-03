import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TrendExposureView } from '../TrendExposureView.jsx';

// TREND-1 — the guarantees this view must never lose.
//
// The tab exists BECAUSE the predictive version of this idea failed its
// placebo test. What shipped is attribution plus descriptive context. These
// tests pin the three things that keep it honest:
//   1. The NO EDGE verdict chip renders in the header.
//   2. An ambiguous phrase is labelled ambiguous instead of being presented
//      as an attribution.
//   3. Zero EDGAR hits reads as "no listed filer", not as an error or an
//      empty table the user might mistake for a loading state.
// Plus: no request fires until the user actually submits (SEC rate budget).

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

// VERBATIM from the API contract in netlify/functions/trend-exposure.ts.
// 2026-08-03 review: this fixture previously carried a TRUNCATED disclaimer
// while the real one ends "…materiality, or expected return." The ban-list
// test below forbids that phrase, so the guarantee only passed because the
// fixture disagreed with the endpoint it was standing in for. Keeping the
// real string here means the ban-list has to be scoped honestly instead.
const DISCLAIMER =
  'Attribution only. Filing mentions describe disclosure, not demand, ' +
  'materiality, or expected return.';

const CLEAN = {
  ok: true,
  phrase: 'HeyDude',
  forms: ['10-K'],
  startDate: '2024-08-03',
  endDate: '2026-08-03',
  totalFilings: 16,
  specificity: 0.4375,
  ambiguous: false,
  noListedMention: false,
  filers: [
    { name: 'Crocs, Inc.', ticker: 'CROX', cik: '0001334036', filings: 7, share: 0.4375 },
    { name: 'CALERES INC', ticker: 'CAL', cik: '0000014707', filings: 4, share: 0.25 },
    { name: 'Some Private Fund L.P.', ticker: null, cik: '0001930054', filings: 1, share: 0.0625 },
  ],
  pageviews: null,
  disclaimer: DISCLAIMER,
};

const AMBIGUOUS = {
  ...CLEAN,
  phrase: 'Celsius',
  totalFilings: 384,
  specificity: 0.044,
  ambiguous: true,
  filers: [{ name: 'Celsius Holdings, Inc.', ticker: 'CELH', cik: '0001341766', filings: 17, share: 0.044 }],
};

const NO_MENTION = {
  ...CLEAN,
  phrase: 'Stanley Quencher',
  totalFilings: 0,
  specificity: null,
  ambiguous: false,
  noListedMention: true,
  filers: [],
};

function ok(body) {
  return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
}

function renderView() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <TrendExposureView />
    </QueryClientProvider>,
  );
}

async function search(term) {
  fireEvent.change(screen.getByLabelText('Phrase to attribute'), { target: { value: term } });
  fireEvent.click(screen.getByRole('button', { name: /attribute/i }));
}

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockImplementation(() => ok(CLEAN));
});
afterEach(cleanup);

describe('TrendExposureView', () => {
  it('renders the NO EDGE verdict chip in the header', () => {
    renderView();
    expect(screen.getByText(/no validated edge|no edge/i)).toBeInTheDocument();
  });

  it('fires no request until a phrase is submitted', () => {
    renderView();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('lists filers with tickers, and marks unlisted filers as such', async () => {
    renderView();
    await search('HeyDude');
    await waitFor(() => expect(screen.getByText('Crocs, Inc.')).toBeInTheDocument());
    expect(screen.getByText('CROX')).toBeInTheDocument();
    expect(screen.getByText('not listed')).toBeInTheDocument();
  });

  it('sends the phrase, form and window to the API', async () => {
    renderView();
    await search('HeyDude');
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const url = fetchMock.mock.calls[0][0];
    expect(url).toContain('/api/trend-exposure');
    expect(url).toContain('q=HeyDude');
    expect(url).toContain('forms=10-K');
    expect(url).toContain('days=730');
  });

  it('labels an ambiguous phrase instead of presenting it as an attribution', async () => {
    fetchMock.mockImplementation(() => ok(AMBIGUOUS));
    renderView();
    await search('Celsius');
    await waitFor(() => expect(screen.getByText(/ambiguous phrase/i)).toBeInTheDocument());
    // The ranking still renders — the warning is a guard, not censorship.
    expect(screen.getByText('Celsius Holdings, Inc.')).toBeInTheDocument();
  });

  it('explains zero hits as "no listed filer", not as a failure', async () => {
    fetchMock.mockImplementation(() => ok(NO_MENTION));
    renderView();
    await search('Stanley Quencher');
    await waitFor(() => expect(screen.getByText(/no listed filer mentions this/i)).toBeInTheDocument());
    expect(screen.getByText(/privately held/i)).toBeInTheDocument();
  });

  it('shows no score, rank, or buy/sell language in the results region', async () => {
    // Scoped to everything EXCEPT the disclaimer: the disclaimer is the one
    // place these words legitimately appear, in negated form ("...not demand,
    // materiality, or expected return"). Scanning the whole container would
    // force the disclaimer to be watered down to keep a test green — exactly
    // backwards. The disclaimer's own wording is asserted separately below.
    const { container } = renderView();
    await search('HeyDude');
    await waitFor(() => expect(screen.getByText('Crocs, Inc.')).toBeInTheDocument());

    const disclaimer = container.querySelector('[data-testid="trend-disclaimer"]');
    expect(disclaimer).not.toBeNull();
    const results = container.cloneNode(true);
    results.querySelector('[data-testid="trend-disclaimer"]')?.remove();

    const text = results.textContent.toLowerCase();
    for (const banned of ['buy', 'sell', 'conviction', 'target price', 'expected return']) {
      expect(text).not.toContain(banned);
    }
  });

  it('renders the full disclaimer verbatim from the API payload', async () => {
    renderView();
    await search('HeyDude');
    await waitFor(() => expect(screen.getByText('Crocs, Inc.')).toBeInTheDocument());
    expect(screen.getByTestId('trend-disclaimer').textContent).toBe(DISCLAIMER);
  });

  it('surfaces an API error rather than rendering an empty table', async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve({ ok: false, status: 429, json: () => Promise.resolve({ error: 'EDGAR FTS 429' }) }),
    );
    renderView();
    await search('Crocs');
    await waitFor(() => expect(screen.getByText(/EDGAR FTS 429/)).toBeInTheDocument());
  });
});
