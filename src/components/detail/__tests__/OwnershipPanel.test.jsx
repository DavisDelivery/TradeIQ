// PROFILE-1 W1.3 — ownership and short structure.

import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import {
  OwnershipPanel,
  ownershipRows,
  shortNarrative,
  fmtPct2,
  fmtDays,
  fmtFloatM,
} from '../OwnershipPanel.jsx';

function renderPanel(ownership) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } } });
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => ({
    ok: true, status: 200,
    json: async () => ({ ok: true, ticker: 'AAPL', finviz: ownership ? { ownership } : null }),
  }));
  return render(
    <QueryClientProvider client={qc}>
      <OwnershipPanel ticker="AAPL" />
    </QueryClientProvider>,
  );
}

afterEach(() => vi.restoreAllMocks());

const full = {
  instOwnPct: 61.2, insiderOwnPct: 0.07, insiderTransPct: -1.4,
  shortFloatPct: 0.9, shortRatio: 1.8, floatM: 15_000,
};

const heavilyShorted = { ...full, shortFloatPct: 22.5, shortRatio: 6.2 };

describe('short interest is shown as a PAIR', () => {
  it('renders both float percentage and days to cover', async () => {
    // Raw short interest lost significance after 2000; the liquidity-scaled
    // form is what survived. Showing one without the other ships the half
    // that stopped working.
    renderPanel(full);
    await waitFor(() => expect(screen.getByTestId('ownership-panel')).toBeInTheDocument());
    expect(screen.getByTestId('own-Short % of float')).toBeInTheDocument();
    expect(screen.getByTestId('own-Days to cover')).toBeInTheDocument();
  });

  it('states BOTH readings and picks neither', async () => {
    renderPanel(heavilyShorted);
    await waitFor(() => expect(screen.getByTestId('own-short-narrative')).toBeInTheDocument());
    const text = screen.getByTestId('own-short-narrative').textContent;
    expect(text).toMatch(/bearish position/);
    expect(text).toMatch(/buying pressure/);
    expect(text).toMatch(/does not say which/);
  });

  it('never asserts a squeeze', async () => {
    renderPanel(heavilyShorted);
    await waitFor(() => expect(screen.getByTestId('own-short-narrative')).toBeInTheDocument());
    const text = screen.getByTestId('own-short-narrative').textContent;
    expect(text).not.toMatch(/squeeze (is )?(imminent|likely|coming)/i);
    expect(text).not.toMatch(/\b(bullish|bearish signal|opportunity)\b/i);
  });

  it('uses no green or red anywhere — the direction table calls this a flag', async () => {
    const { container } = renderPanel(heavilyShorted);
    await waitFor(() => expect(screen.getByTestId('ownership-panel')).toBeInTheDocument());
    expect(container.innerHTML).not.toMatch(/emerald|rose|green-|red-/);
  });
});

describe('shortNarrative', () => {
  it('stays silent on an ordinary short position', () => {
    // Narrating "0.9% short" as a finding teaches the reader to see signals
    // in noise.
    expect(shortNarrative(0.9, 1.8)).toBeNull();
    expect(shortNarrative(4.9, 2.0)).toBeNull();
  });

  it('speaks once the position is genuinely elevated', () => {
    expect(shortNarrative(22.5, 6.2)).toMatch(/22\.5% of float/);
    expect(shortNarrative(22.5, 6.2)).toMatch(/6\.2 days to cover/);
  });

  it('says so when days-to-cover is missing rather than omitting it', () => {
    // Silence would leave the reader with the half that stopped working.
    expect(shortNarrative(22.5, null)).toMatch(/days-to-cover unavailable/);
  });

  it('returns null when short float is unknown', () => {
    expect(shortNarrative(null, 6.2)).toBeNull();
  });
});

describe('rows', () => {
  it('drops missing rows and keeps a real zero', () => {
    const rows = ownershipRows({ ...full, insiderOwnPct: 0, instOwnPct: null });
    const labels = rows.map((r) => r.label);
    expect(labels).toContain('Insider');       // 0.00% is a measurement
    expect(labels).not.toContain('Institutional');
  });

  it('preserves a negative net insider transaction', () => {
    const rows = ownershipRows({ ...full, insiderTransPct: -12.5 });
    expect(rows.find((r) => r.label === 'Insider net trans.').value).toBe('-12.50%');
  });

  it('renders nothing at all when the block is empty', async () => {
    const { container } = renderPanel({
      instOwnPct: null, insiderOwnPct: null, insiderTransPct: null,
      shortFloatPct: null, shortRatio: null, floatM: null,
    });
    await waitFor(() => expect(container.querySelector('[data-testid="ownership-panel"]')).toBeNull());
  });

  it('renders nothing when finviz is absent', async () => {
    const { container } = renderPanel(null);
    await waitFor(() => expect(container.querySelector('[data-testid="ownership-panel"]')).toBeNull());
  });
});

describe('it admits what it cannot show', () => {
  it('says the figures are point-in-time, not a trend', async () => {
    renderPanel(full);
    await waitFor(() => expect(screen.getByText(/Point-in-time, not a trend/)).toBeInTheDocument());
  });
});

describe('formatters', () => {
  it('formats percentages, days and float', () => {
    expect(fmtPct2(61.234, 1)).toBe('61.2%');
    expect(fmtDays(1)).toBe('1.0 day');
    expect(fmtDays(6.24)).toBe('6.2 days');
    expect(fmtFloatM(15_000)).toBe('15.00B sh');
    expect(fmtFloatM(320)).toBe('320M sh');
  });

  it('returns null rather than a dash, so rows can be dropped upstream', () => {
    for (const bad of [null, undefined, Number.NaN, Infinity]) {
      expect(fmtPct2(bad)).toBeNull();
      expect(fmtDays(bad)).toBeNull();
      expect(fmtFloatM(bad)).toBeNull();
    }
  });
});
