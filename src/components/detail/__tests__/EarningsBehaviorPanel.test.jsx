// PROFILE-1 W1.2 — the earnings-behaviour panel.

import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import {
  EarningsBehaviorPanel,
  quarterLabel,
  surpriseClass,
  fmtPct1,
  fmtEps,
} from '../EarningsBehaviorPanel.jsx';

function renderPanel(behavior) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } } });
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => ({
    ok: true, status: 200,
    json: async () => ({ ok: true, ticker: 'AAPL', catalysts: { earningsBehavior: behavior } }),
  }));
  return render(
    <QueryClientProvider client={qc}>
      <EarningsBehaviorPanel ticker="AAPL" />
    </QueryClientProvider>,
  );
}

afterEach(() => vi.restoreAllMocks());

const q = (period, surprisePct, reactionPct, epsActual = 1.2, epsEstimate = 1.0) =>
  ({ period, announceDate: `${period}`, epsActual, epsEstimate, surprisePct, reactionPct });

const behavior = {
  quarters: [q('2026-03-31', 20, 8.2), q('2025-12-31', -5, -12.4), q('2025-09-30', 0.4, 3.1)],
  avgAbsMovePct: 7.9,
  worstMovePct: -12.4,
  measured: 3,
  total: 3,
};

describe('the two position-sizing facts lead', () => {
  it('shows average absolute move and the worst move', async () => {
    renderPanel(behavior);
    await waitFor(() => expect(screen.getByTestId('eb-avg')).toBeInTheDocument());
    expect(screen.getByTestId('eb-avg').textContent).toBe('7.9%');
    expect(screen.getByTestId('eb-worst').textContent).toBe('-12.4%');
  });

  it('keeps the worst move SIGNED', async () => {
    // Rendering |worst| would report a -12.4% quarter as "12.4%" and invert
    // the direction of the risk the number exists to describe.
    renderPanel(behavior);
    await waitFor(() => expect(screen.getByTestId('eb-worst')).toBeInTheDocument());
    expect(screen.getByTestId('eb-worst').textContent).toMatch(/^-/);
    expect(screen.getByTestId('eb-worst').textContent).not.toBe('12.4%');
  });
});

describe('per-quarter rows', () => {
  it('renders every fetched quarter, newest first', async () => {
    renderPanel(behavior);
    await waitFor(() => expect(screen.getByTestId('eb-row-2026-03-31')).toBeInTheDocument());
    expect(screen.getByTestId('eb-row-2025-12-31')).toBeInTheDocument();
    expect(screen.getByTestId('eb-row-2025-09-30')).toBeInTheDocument();
  });

  it('shows a dash, not a zero, for an unanchored quarter', async () => {
    const withGap = {
      ...behavior,
      quarters: [q('2026-03-31', 20, null)],
      measured: 0, total: 1, avgAbsMovePct: null, worstMovePct: null,
    };
    renderPanel(withGap);
    await waitFor(() => expect(screen.getByTestId('eb-row-2026-03-31')).toBeInTheDocument());
    // Assert on the MOVE cell, not the row: a loose /0\.0%/ over the whole
    // row matches the substring inside "+20.0%" from the surprise column.
    const cells = screen.getByTestId('eb-row-2026-03-31').querySelectorAll('td');
    expect(cells[cells.length - 1].textContent).toBe('—');
    expect(cells[3].textContent).toBe('+20.0%'); // surprise still rendered
  });

  it('keeps an unanchored quarter VISIBLE rather than dropping it', async () => {
    // Silently omitting the quarters we could not anchor would understate
    // how often the measurement fails.
    const withGap = { ...behavior, quarters: [q('2026-03-31', 20, null)], measured: 0, total: 1 };
    renderPanel(withGap);
    await waitFor(() => expect(screen.getByTestId('eb-row-2026-03-31')).toBeInTheDocument());
    expect(screen.getByText(/could not be anchored/)).toBeInTheDocument();
  });

  it('prints measured/total in the header', async () => {
    renderPanel({ ...behavior, measured: 6, total: 8 });
    await waitFor(() => expect(screen.getByText('6 of 8 measured')).toBeInTheDocument());
  });
});

describe('the measurement states its own limitation', () => {
  it('explains the straddle and why the session is unknown', async () => {
    renderPanel(behavior);
    await waitFor(() => expect(screen.getByTestId('eb-avg')).toBeInTheDocument());
    expect(screen.getByText(/before the open or after the close/)).toBeInTheDocument();
  });
});

describe('absent data', () => {
  it('renders nothing at all when there is no behaviour block', async () => {
    const { container } = renderPanel(null);
    await waitFor(() => expect(container.querySelector('[data-testid="earnings-behavior"]')).toBeNull());
  });

  it('renders nothing when the quarters array is empty', async () => {
    const { container } = renderPanel({ quarters: [], avgAbsMovePct: null, worstMovePct: null, measured: 0, total: 0 });
    await waitFor(() => expect(container.querySelector('[data-testid="earnings-behavior"]')).toBeNull());
  });
});

describe('helpers', () => {
  it('quarterLabel maps a period end to a fiscal quarter', () => {
    expect(quarterLabel('2026-03-31')).toBe("Q1 '26");
    expect(quarterLabel('2026-06-30')).toBe("Q2 '26");
    expect(quarterLabel('2025-12-31')).toBe("Q4 '25");
    expect(quarterLabel('garbage')).toBe('garbage');
  });

  it('surpriseClass treats a rounding-sized surprise as in-line', () => {
    // 0.4% is rounding, not news.
    expect(surpriseClass(0.4)).toBe('inline');
    expect(surpriseClass(-0.9)).toBe('inline');
    expect(surpriseClass(20)).toBe('beat');
    expect(surpriseClass(-5)).toBe('miss');
    expect(surpriseClass(null)).toBe('none');
  });

  it('formatters dash out unusable values instead of printing NaN', () => {
    for (const bad of [null, undefined, Number.NaN, Infinity]) {
      expect(fmtPct1(bad)).toBe('—');
      expect(fmtEps(bad)).toBe('—');
    }
    expect(fmtPct1(3.14)).toBe('+3.1%');
    expect(fmtPct1(-3.14)).toBe('-3.1%');
    expect(fmtEps(1.5)).toBe('$1.50');
  });
});
