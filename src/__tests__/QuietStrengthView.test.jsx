// QS-1 — the banner is non-negotiable, so it is tested as a contract.

import React from 'react';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { QuietStrengthView, fmt1, fmt2, fmtPct, fmtExposure } from '../QuietStrengthView.jsx';

const BANNER = {
  grade: 'replicated-external',
  netEdgeLowPp: 0.5,
  netEdgeHighPp: 1.5,
  headline:
    'Expected net edge after haircut ~0.5–1.5pp/yr over SPY; expect multi-year droughts (2000–2015-style).',
  discovery: 'NOT MEASURED (no t-statistic)',
  policyVersion: '2026-08-07',
  sources: ['Blitz, Huij & Martens (2011)'],
};

const payload = (over = {}) => ({
  ok: true,
  source: 'snapshot',
  stale: false,
  banner: BANNER,
  exposure: { exposure: 0.5, bearDimmed: true, volScaled: 1, reasons: [] },
  returnBasis: 'price',
  warnings: [],
  rows: [
    { ticker: 'AAA', rank: 1, score: 12.34, percentile: 1, plain12_1Pct: 25.5, betaMkt: 0.9, band: 'enter', tranche: 0 },
    { ticker: 'BBB', rank: 2, score: 8.1, percentile: 0.9, plain12_1Pct: -3.2, betaMkt: 1.1, band: 'hold', tranche: 2 },
  ],
  disclosure: 'Quiet Strength ranks residual momentum.',
  ...over,
});

function renderView() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <QuietStrengthView />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true, status: 200, json: async () => payload(),
  })));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('the banner rides the payload and always renders', () => {
  it('shows the mandated sentence with rows present', async () => {
    renderView();
    expect(await screen.findByText(/after haircut/)).toBeInTheDocument();
    expect(screen.getByText(/0\.5.*1\.5pp\/yr over SPY/)).toBeInTheDocument();
    expect(screen.getByText(/multi-year droughts/)).toBeInTheDocument();
  });

  it('shows it on an EMPTY board too', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true, status: 200,
      json: async () => payload({ rows: [], source: 'snapshot-missing' }),
    })));
    renderView();
    expect(await screen.findByText(/after haircut/)).toBeInTheDocument();
    expect(screen.getByText(/first Quiet Strength scan has not completed/)).toBeInTheDocument();
  });

  it('renders the evidence grade and the NOT-MEASURED verdict', async () => {
    renderView();
    await screen.findByText(/after haircut/);
    expect(screen.getByText(/replicated-external/)).toBeInTheDocument();
    expect(screen.getByText(/NOT MEASURED/)).toBeInTheDocument();
  });

  it('does NOT compute the haircut client-side — it prints what the server sent', async () => {
    // A server that (hypothetically) shipped a different policy must be
    // reflected verbatim; a hardcoded "0.5-1.5" in the component would be a
    // front-end constant claiming a haircut it never applied.
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true, status: 200,
      json: async () => payload({
        banner: { ...BANNER, headline: 'Expected net edge after haircut ~9.9pp/yr over SPY; expect multi-year droughts.' },
      }),
    })));
    renderView();
    expect(await screen.findByText(/9\.9pp\/yr/)).toBeInTheDocument();
  });

  it('surfaces the bear dimmer and the price-return basis', async () => {
    renderView();
    await screen.findByText(/after haircut/);
    expect(screen.getByText(/bear-dimmed/)).toBeInTheDocument();
    expect(screen.getByText(/dividends not reinvested/)).toBeInTheDocument();
  });
});

describe('rows', () => {
  it('renders in the order the server sent, without re-sorting', async () => {
    renderView();
    await screen.findByText('AAA');
    const cells = screen.getAllByRole('row').slice(1).map((r) => r.textContent);
    expect(cells[0]).toContain('AAA');
    expect(cells[1]).toContain('BBB');
  });

  it('shows the enter/hold band', async () => {
    renderView();
    await screen.findByText('AAA');
    expect(screen.getByText('enter')).toBeInTheDocument();
    expect(screen.getByText('hold')).toBeInTheDocument();
  });
});

describe('errors do not blank the board', () => {
  it('reports a failure without throwing', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false, status: 500, json: async () => ({ error: 'boom' }),
    })));
    renderView();
    await waitFor(() => expect(screen.getByText(/boom/)).toBeInTheDocument());
  });
});

describe('formatters', () => {
  it('renders a dash rather than NaN for unmeasured values', () => {
    for (const bad of [null, undefined, NaN, Infinity]) {
      expect(fmt1(bad)).toBe('—');
      expect(fmt2(bad)).toBe('—');
      expect(fmtPct(bad)).toBe('—');
    }
  });

  it('formats numbers', () => {
    expect(fmt1(1.234)).toBe('1.2');
    expect(fmt2(1.234)).toBe('1.23');
    expect(fmtPct(3.14)).toBe('+3.1%');
    expect(fmtPct(-3.14)).toBe('-3.1%');
  });

  it('formats exposure as a percentage of full size', () => {
    expect(fmtExposure({ exposure: 0.5 })).toBe('50%');
    expect(fmtExposure({ exposure: 1 })).toBe('100%');
    expect(fmtExposure(null)).toBe('—');
    expect(fmtExposure({ exposure: null })).toBe('—');
  });
});
