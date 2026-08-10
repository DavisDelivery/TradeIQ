// PROFILE-1 W3 — the peer drawer.

import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import { PeerDrawer, markerPosition, fmtStat } from '../PeerDrawer.jsx';

const STAT = {
  metricKey: 'pe', subjectTicker: 'AAPL', subjectValue: 29.4,
  poolLevel: 'industry', poolLabel: 'Consumer Electronics (industry)',
  n: 41, excludedCount: 7,
  exclusionNote: '34 of 41 have positive earnings; the rest are excluded from this ratio',
  percentile: 0.72, ordinal: null, peers: null,
  median: 22.1, displayLow: 8, displayHigh: 60,
  winsorNote: 'Distribution clipped at the 2.5th and 97.5th percentiles for display; ranks use every value.',
  subjectNotMeaningful: false, noPool: false,
  phrase: 'P/E sits at the 72nd percentile of its peer group — 72th percentile of 41 Consumer Electronics peers.',
};

let lastUrl = null;

function renderDrawer(body, { open = true } = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } } });
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
    lastUrl = String(url);
    return { ok: true, status: 200, json: async () => body };
  });
  return render(
    <QueryClientProvider client={qc}>
      <PeerDrawer ticker="AAPL" metricKey="pe" open={open} />
    </QueryClientProvider>,
  );
}

afterEach(() => { vi.restoreAllMocks(); lastUrl = null; });

describe('it is a drawer, not an overlay', () => {
  it('renders inline with no fixed positioning', async () => {
    // A fixed overlay here would be an overlay over TickerDetailModal — the
    // exact arrangement #196 records going wrong against the sticky header.
    const { container } = renderDrawer({ ok: true, stat: STAT });
    await waitFor(() => expect(screen.getByTestId('peer-phrase')).toBeInTheDocument());
    expect(container.innerHTML).not.toMatch(/\bfixed\b|\bz-\d/);
  });

  it('animates height via grid-rows so content below is pushed down', async () => {
    renderDrawer({ ok: true, stat: STAT });
    const drawer = screen.getByTestId('peer-drawer');
    expect(drawer.className).toMatch(/grid-rows-\[1fr\]/);
    expect(drawer.className).toMatch(/transition-\[grid-template-rows\]/);
  });

  it('collapses to zero height when closed', () => {
    renderDrawer({ ok: true, stat: STAT }, { open: false });
    expect(screen.getByTestId('peer-drawer').className).toMatch(/grid-rows-\[0fr\]/);
  });

  it('honours prefers-reduced-motion', () => {
    renderDrawer({ ok: true, stat: STAT });
    expect(screen.getByTestId('peer-drawer').className).toMatch(/motion-reduce:transition-none/);
  });
});

describe('laziness', () => {
  it('fetches NOTHING while closed', async () => {
    renderDrawer({ ok: true, stat: STAT }, { open: false });
    await new Promise((r) => setTimeout(r, 20));
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('fetches the one metric it needs when opened', async () => {
    renderDrawer({ ok: true, stat: STAT });
    await waitFor(() => expect(screen.getByTestId('peer-phrase')).toBeInTheDocument());
    expect(lastUrl).toMatch(/ticker=AAPL/);
    expect(lastUrl).toMatch(/metric=pe/);
  });
});

describe('provenance is always shown', () => {
  it('prints the pool level, N and the exclusion note', async () => {
    renderDrawer({ ok: true, stat: STAT });
    await waitFor(() => expect(screen.getByTestId('peer-provenance')).toBeInTheDocument());
    const text = screen.getByTestId('peer-provenance').textContent;
    expect(text).toMatch(/Consumer Electronics \(industry\)/);
    expect(text).toMatch(/n=41/);
    expect(text).toMatch(/34 of 41 have positive earnings/);
  });

  it('shows the winsorization note beside the strip', async () => {
    renderDrawer({ ok: true, stat: STAT });
    await waitFor(() => expect(screen.getByText(/clipped at the 2.5th/)).toBeInTheDocument());
  });

  it('draws the marker and the median tick', async () => {
    renderDrawer({ ok: true, stat: STAT });
    await waitFor(() => expect(screen.getByTestId('peer-strip')).toBeInTheDocument());
    expect(screen.getByTestId('peer-marker')).toBeInTheDocument();
    expect(screen.getByTestId('peer-median-tick')).toBeInTheDocument();
  });
});

describe('small pools show names instead of a statistic', () => {
  const small = {
    ...STAT, percentile: null, ordinal: 3, n: 9,
    peers: [{ ticker: 'AAA', value: 40 }, { ticker: 'BBB', value: 31 }],
    phrase: '3rd highest of 10 in Consumer Electronics — too few peers for a percentile.',
  };

  it('renders the peer list and no distribution strip', async () => {
    renderDrawer({ ok: true, stat: small });
    await waitFor(() => expect(screen.getByTestId('peer-list')).toBeInTheDocument());
    expect(screen.queryByTestId('peer-strip')).not.toBeInTheDocument();
    expect(screen.getByText(/AAA/)).toBeInTheDocument();
  });
});

describe('a refusal is an answer, not an error', () => {
  it('renders the no-pool note as prose', async () => {
    renderDrawer({
      ok: true, stat: null, reason: 'no-pool',
      note: 'This metric is not in the screener universe the peer statistics are computed from.',
    });
    await waitFor(() =>
      expect(screen.getByText(/not in the screener universe/)).toBeInTheDocument());
    expect(screen.queryByText(/Couldn't load/)).not.toBeInTheDocument();
  });

  it('renders the universe-unavailable note as prose too', async () => {
    renderDrawer({
      ok: true, stat: null, reason: 'universe-unavailable',
      note: 'The screener universe is unavailable right now.',
    });
    await waitFor(() => expect(screen.getByText(/unavailable right now/)).toBeInTheDocument());
  });

  it('DOES show an error for an actual failure', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => ({
      ok: false, status: 500, json: async () => ({ error: 'boom' }),
    }));
    render(
      <QueryClientProvider client={qc}>
        <PeerDrawer ticker="AAPL" metricKey="pe" open />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(screen.getByText(/Couldn't load peers/)).toBeInTheDocument());
  });
});

describe('markerPosition', () => {
  it('places a value within the winsorized window', () => {
    expect(markerPosition(50, 0, 100)).toBeCloseTo(0.5, 10);
    expect(markerPosition(25, 0, 100)).toBeCloseTo(0.25, 10);
  });

  it('clamps a value outside the clipped window to the edge', () => {
    // The strip is winsorized, so an extreme subject sits AT the end rather
    // than off the rail.
    expect(markerPosition(500, 0, 100)).toBe(1);
    expect(markerPosition(-500, 0, 100)).toBe(0);
  });

  it('returns null when any bound is missing', () => {
    expect(markerPosition(null, 0, 100)).toBeNull();
    expect(markerPosition(50, null, 100)).toBeNull();
    expect(markerPosition(50, 0, null)).toBeNull();
  });

  it('centres a degenerate window rather than dividing by zero', () => {
    expect(markerPosition(5, 5, 5)).toBe(0.5);
  });
});

describe('fmtStat', () => {
  it('scales precision with magnitude', () => {
    expect(fmtStat(1234)).toBe('1234');
    expect(fmtStat(29.44)).toBe('29.4');
    expect(fmtStat(1.234)).toBe('1.23');
  });

  it('dashes out unusable values', () => {
    for (const bad of [null, undefined, Number.NaN, Infinity]) expect(fmtStat(bad)).toBe('—');
  });
});
