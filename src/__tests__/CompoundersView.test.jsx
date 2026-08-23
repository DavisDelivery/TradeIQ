// COMP-1 — this board's contract with the reader, held shut.
//
// Three things must be true of every render, because this board has NO
// measurement behind it and its rows are famous mega-caps that look like
// advice on their own:
//   1. the rows are the server's ranking, unsorted and unrelabelled;
//   2. the UNMEASURED verdict is on screen — from the registry chip AND
//      from the payload banner, which are independent failure paths;
//   3. a score computed on the ROE proxy is visibly a proxy.

import React from 'react';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  CompoundersView,
  EXACT_BASIS,
  isProxyBasis,
  fmtScore,
  fmtPctile,
  fmtPct,
} from '../CompoundersView.jsx';

// Shape copied from scan-compounders.buildCompoundersBanner — nulls and all.
const BANNER = {
  grade: 'axes-replicated-blend-unmeasured',
  netEdgeLowPp: null,
  netEdgeHighPp: null,
  headline:
    'UNMEASURED. Both axes replicate externally; this combination of them has never been ' +
    'forward-tested here, so no edge figure is published.',
  discovery: 'NOT MEASURED (no t-statistic)',
  departure:
    'No value axis. The house construction is integrated quality-VALUE; a cheapness axis is ' +
    'precisely what excludes a high-multiple franchise, so it was dropped on purpose.',
  policyVersion: '2026-08-07',
  sources: ['Novy-Marx (2013) — gross profits / total assets'],
};

const payload = (over = {}) => ({
  ok: true,
  universe: 'largecap',
  source: 'snapshot',
  stale: false,
  modelVersion: 'compounders-v1',
  universeChecked: 503,
  universeSize: 520,
  scored: 3,
  exactBasisCount: 2,
  excludedCounts: {},
  unscorableCounts: {},
  banner: BANNER,
  warnings: [],
  rows: [
    {
      rank: 1, ticker: 'AAA', sector: 'Technology', composite: 0.964,
      qualityPct: 0.98, momentumPct: 0.94, grossProfitability: 0.42,
      momentum12_1Pct: 31.2, qualityBasis: EXACT_BASIS,
    },
    {
      rank: 2, ticker: 'BBB', sector: 'Healthcare', composite: 0.912,
      qualityPct: 0.91, momentumPct: 0.92, grossProfitability: 0.37,
      momentum12_1Pct: -4.4, qualityBasis: EXACT_BASIS,
    },
    {
      rank: 3, ticker: 'CCC', sector: 'Technology', composite: 0.883,
      qualityPct: 0.86, momentumPct: 0.9, grossProfitability: null,
      momentum12_1Pct: 12.0, qualityBasis: 'roe-proxy',
    },
  ],
  disclosure: 'Compounders ranks quality first and carries NO value axis.',
  ...over,
});

function renderView() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <CompoundersView />
    </QueryClientProvider>,
  );
}

const mock = (body, { ok = true, status = 200 } = {}) =>
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok, status, json: async () => body })));

beforeEach(() => {
  mock(payload());
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('the board renders the server ranking', () => {
  it('renders one row per ranked name, in the order the server sent', async () => {
    renderView();
    await screen.findByText('AAA');
    const body = screen.getAllByRole('row').slice(1).map((r) => r.textContent);
    expect(body).toHaveLength(3);
    expect(body[0]).toContain('AAA');
    expect(body[1]).toContain('BBB');
    expect(body[2]).toContain('CCC');
  });

  it('shows every contracted column: rank, score, both percentiles, 12-1', async () => {
    renderView();
    const first = (await screen.findByText('AAA')).closest('tr');
    // rank 1 · composite 0.964 · quality 98 · momentum 94 · +31.2%
    expect(first.textContent).toContain('1');
    expect(first.textContent).toContain('0.964');
    expect(first.textContent).toContain('98');
    expect(first.textContent).toContain('94');
    expect(first.textContent).toContain('+31.2%');
  });

  it('keeps three decimals on the composite, because the top of the board is crowded', async () => {
    // 0.964 and 0.912 round to the same 2dp band often enough that a 2dp
    // column prints ties that are not ties.
    renderView();
    await screen.findByText('AAA');
    expect(screen.getByText('0.964')).toBeInTheDocument();
    expect(screen.getByText('0.912')).toBeInTheDocument();
  });

  it('does not claim "not completed yet" for a run that ran and was refused', async () => {
    // QS-1 post-mortem, inherited: the server's note distinguishes states
    // this component cannot.
    mock(payload({
      rows: [], scored: 0, source: 'snapshot-unpublished',
      note: 'A scan ran at 2026-08-21T21:41:00Z and scored 0 of 503 names, so it was not published.',
      warnings: ['only 0 scorable names — below the floor'],
    }));
    renderView();
    await waitFor(() => expect(screen.getByText(/scored 0 of 503/)).toBeInTheDocument());
    expect(screen.queryByText(/has not completed yet/)).not.toBeInTheDocument();
    expect(screen.getByText(/below the floor/)).toBeInTheDocument();
  });

  it('says so plainly when the board genuinely never ran', async () => {
    mock(payload({ rows: [], scored: 0, source: 'snapshot-missing', note: undefined }));
    renderView();
    await waitFor(() =>
      expect(screen.getByText(/first Compounders scan has not completed yet/)).toBeInTheDocument());
  });
});

describe('the UNMEASURED verdict is unmissable', () => {
  it('renders the registry chip, which reads NOT MEASURED', async () => {
    renderView();
    const chip = await screen.findByTestId('verdict-chip-compounders');
    expect(chip).toHaveTextContent('NOT MEASURED');
  });

  it('renders the payload banner: headline, grade and discovery verdict', async () => {
    renderView();
    expect(await screen.findByText(/never been forward-tested here/)).toBeInTheDocument();
    expect(screen.getByText(/axes-replicated-blend-unmeasured/)).toBeInTheDocument();
    expect(screen.getByText(/NOT MEASURED \(no t-statistic\)/)).toBeInTheDocument();
  });

  it('states the missing value axis as a departure', async () => {
    renderView();
    expect(await screen.findByText(/No value axis/)).toBeInTheDocument();
  });

  it('prints the banner the SERVER sent rather than composing one here', async () => {
    // A headline assembled in the component would be a front-end constant
    // claiming a haircut it never applied — and would not move when the
    // policy does.
    mock(payload({ banner: { ...BANNER, headline: 'Expected net edge after haircut ~9.9pp/yr over SPY.' } }));
    renderView();
    expect(await screen.findByText(/9\.9pp\/yr/)).toBeInTheDocument();
  });

  it('keeps the banner AND the chip on an empty board', async () => {
    mock(payload({ rows: [], scored: 0, source: 'snapshot-missing' }));
    renderView();
    expect(await screen.findByText(/never been forward-tested here/)).toBeInTheDocument();
    expect(screen.getByTestId('verdict-chip-compounders')).toHaveTextContent('NOT MEASURED');
  });

  it('keeps the chip when the fetch fails outright', async () => {
    // The chip is registry-driven, so it is the surface that survives having
    // no payload at all.
    mock({ error: 'boom' }, { ok: false, status: 500 });
    renderView();
    await waitFor(() => expect(screen.getByText(/boom/)).toBeInTheDocument());
    expect(screen.getByTestId('verdict-chip-compounders')).toHaveTextContent('NOT MEASURED');
  });
});

describe('a proxied score is visibly proxied', () => {
  it('tags the ROE-proxy row and only that row', async () => {
    renderView();
    await screen.findByText('CCC');
    const tags = screen.getAllByTestId('quality-basis-proxy');
    expect(tags).toHaveLength(1);
    expect(tags[0].closest('tr').textContent).toContain('CCC');
    expect(screen.getByText('AAA').closest('tr').querySelector('[data-testid="quality-basis-proxy"]'))
      .toBeNull();
  });

  it('names the leverage problem in the tag itself, not only in a footnote', async () => {
    renderView();
    const tag = (await screen.findAllByTestId('quality-basis-proxy'))[0];
    expect(tag.getAttribute('title')).toMatch(/leverage/i);
  });

  it('states how much of the whole run fell back to the proxy', async () => {
    renderView();
    const summary = await screen.findByTestId('basis-summary');
    // scored 3, exactBasisCount 2 → 1 proxied.
    expect(summary.textContent).toMatch(/1 of 3 ranked names fell back to the ROE proxy/);
  });

  it('says the board is fully exact when it is, rather than staying silent', async () => {
    mock(payload({
      exactBasisCount: 3,
      rows: payload().rows.map((r) => ({ ...r, qualityBasis: EXACT_BASIS })),
    }));
    renderView();
    expect(await screen.findByText(/All 3 ranked names use the exact quality ratio/)).toBeInTheDocument();
    expect(screen.queryAllByTestId('quality-basis-proxy')).toHaveLength(0);
  });
});

describe('mobile-first: nothing goes off-screen and stays there', () => {
  it('wraps the control row — the off-screen-buttons bug is a shipped one', async () => {
    renderView();
    const controls = await screen.findByTestId('sector-filter');
    expect(controls.className).toMatch(/flex-wrap/);
  });

  it('scrolls the table inside its own container instead of widening the page', async () => {
    renderView();
    const table = (await screen.findByText('AAA')).closest('table');
    expect(table.parentElement.className).toMatch(/overflow-x-auto/);
  });

  it('filters by sector without re-ranking the survivors', async () => {
    renderView();
    await screen.findByText('AAA');
    fireEvent.click(screen.getByRole('button', { name: 'Healthcare' }));
    const body = screen.getAllByRole('row').slice(1).map((r) => r.textContent);
    expect(body).toHaveLength(1);
    expect(body[0]).toContain('BBB');
    // The server's rank travels with the row — filtering is not re-ranking.
    expect(body[0]).toContain('2');
  });
});

describe('formatters', () => {
  it('renders a dash rather than NaN for an unmeasured value', () => {
    for (const bad of [null, undefined, NaN, Infinity]) {
      expect(fmtScore(bad)).toBe('—');
      expect(fmtPctile(bad)).toBe('—');
      expect(fmtPct(bad)).toBe('—');
    }
  });

  it('formats scores, percentiles and signed percents', () => {
    expect(fmtScore(0.9641)).toBe('0.964');
    expect(fmtPctile(0.98)).toBe('98');
    expect(fmtPctile(0)).toBe('0');
    expect(fmtPct(31.24)).toBe('+31.2%');
    expect(fmtPct(-4.44)).toBe('-4.4%');
  });

  it('treats anything that is not the exact Novy-Marx ratio as a proxy', () => {
    expect(isProxyBasis(EXACT_BASIS)).toBe(false);
    expect(isProxyBasis('roe-proxy')).toBe(true);
    expect(isProxyBasis('none')).toBe(true);
    // An unknown basis added later must read as unproven, not as exact.
    expect(isProxyBasis('something-new')).toBe(true);
    expect(isProxyBasis(undefined)).toBe(true);
  });
});
