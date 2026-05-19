import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  AnalystContributions,
  StatusBadge,
  provenanceFor,
  _internals,
} from '../components/AnalystContributions.jsx';

// Phase 4f W5 — provenance + badge contract.
//
// Three states the panel must visually distinguish:
//   - LIVE     (green)   — analyst produced a real signal this snapshot
//   - NO DATA  (gray)    — analyst's upstream was empty this snapshot;
//                          weight rescaled away by composeWeights
//   - REMOVED  (gray)    — analyst permanently removed from BASE_WEIGHTS
//                          (currently macro-regime, patent-analyst per
//                          Phase 4f-finish audit § 2)
//
// Phase 4q — adds inline accordion. Tests cover row expansion, no-data
// row rendering ("No actionable data — <reason>"), and signals
// rendering via the W1 endpoint payload.

const sampleTarget = {
  ticker: 'NVDA',
  scoredAnalysts: [
    'technical-analyst',
    'sector-rotation',
    'fundamental-analyst',
    'flow-analyst',
    'earnings-analyst',
    'insider-analyst',
    'political-analyst',
  ],
  noDataAnalysts: ['news-sentiment'],
  analystContributions: [
    { analyst: 'technical-analyst',   score: 78, direction: 'long',    weight: 0.17 },
    { analyst: 'sector-rotation',     score: 65, direction: 'long',    weight: 0.09 },
    { analyst: 'fundamental-analyst', score: 60, direction: 'long',    weight: 0.15 },
    { analyst: 'flow-analyst',        score: 55, direction: 'neutral', weight: 0.11 },
    { analyst: 'news-sentiment',      score: 50, direction: 'neutral', weight: 0 },
    { analyst: 'earnings-analyst',    score: 58, direction: 'long',    weight: 0.08 },
    { analyst: 'macro-regime',        score: 50, direction: 'neutral', weight: 0 },
    { analyst: 'insider-analyst',     score: 72, direction: 'long',    weight: 0.16 },
    { analyst: 'patent-analyst',      score: 50, direction: 'neutral', weight: 0 },
    { analyst: 'political-analyst',   score: 68, direction: 'long',    weight: 0.11 },
  ],
};

// Phase 4q — every test mounts AnalystContributions, which calls
// useTargetRationale() → fetch. Tests get a wrapper QueryClientProvider
// and a global fetch mock so the hook resolves deterministically.

function makeWrapper() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity, staleTime: Infinity } },
  });
  const wrapper = ({ children }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return { qc, wrapper };
}

function rationalePayload(overrides = {}) {
  return {
    ok: true,
    ticker: 'NVDA',
    composite: 64,
    tier: 'B',
    direction: 'long',
    scoredAt: '2026-05-19T12:00:00.000Z',
    modelVersion: 'v1',
    analysts: [
      {
        analyst: 'technical-analyst',
        score: 78,
        direction: 'long',
        weight: 0.17,
        confidence: 0.65,
        rationale: 'uptrend intact, +4.2% 20d',
        signals: { ema20: 105, ema50: 100, roc20Pct: 4.2, volRatio: 1.4 },
      },
      {
        analyst: 'news-sentiment',
        score: 50,
        direction: 'neutral',
        weight: 0,
        confidence: 0,
        rationale: 'no recent news',
        signals: { newsCount: 0, _noData: true, _reason: 'no_data' },
      },
      {
        analyst: 'earnings-analyst',
        score: 50,
        direction: 'neutral',
        weight: 0,
        confidence: 0,
        rationale: 'no earnings catalyst',
        signals: { _noData: true, _reason: 'no_actionable_data', beats4q: 0 },
      },
    ],
    ...overrides,
  };
}

let fetchSpy;
beforeEach(() => {
  fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => ({
    ok: true,
    status: 200,
    json: async () => rationalePayload(),
  }));
});
afterEach(() => {
  fetchSpy?.mockRestore();
});

describe('provenanceFor', () => {
  it('classifies permanently-removed analysts as removed', () => {
    expect(provenanceFor('macro-regime', sampleTarget.scoredAnalysts, sampleTarget.noDataAnalysts))
      .toBe('removed');
    expect(provenanceFor('patent-analyst', sampleTarget.scoredAnalysts, sampleTarget.noDataAnalysts))
      .toBe('removed');
  });

  it('classifies no-data analysts as no_data', () => {
    expect(provenanceFor('news-sentiment', sampleTarget.scoredAnalysts, sampleTarget.noDataAnalysts))
      .toBe('no_data');
  });

  it('classifies scored analysts as live', () => {
    expect(provenanceFor('technical-analyst', sampleTarget.scoredAnalysts, sampleTarget.noDataAnalysts))
      .toBe('live');
    expect(provenanceFor('insider-analyst', sampleTarget.scoredAnalysts, sampleTarget.noDataAnalysts))
      .toBe('live');
  });

  it('removed takes precedence over no_data (defensive)', () => {
    // If macro-regime ever ALSO ended up in noDataAnalysts (e.g. via a
    // future provider change), the structural REMOVED classification
    // should still win — it's documenting that the analyst was pulled
    // from the weight table, not just that this snapshot is empty.
    expect(provenanceFor('macro-regime', [], ['macro-regime']))
      .toBe('removed');
  });

  it('handles missing arrays gracefully', () => {
    expect(provenanceFor('technical-analyst', undefined, undefined)).toBe('live');
    expect(provenanceFor('news-sentiment', null, null)).toBe('live'); // no longer no_data without list
  });

  it('PERMANENTLY_REMOVED set documents the live removals', () => {
    expect(_internals.PERMANENTLY_REMOVED.has('macro-regime')).toBe(true);
    expect(_internals.PERMANENTLY_REMOVED.has('patent-analyst')).toBe(true);
    expect(_internals.PERMANENTLY_REMOVED.size).toBe(2);
  });
});

describe('StatusBadge', () => {
  it('renders LIVE for status="live"', () => {
    render(<StatusBadge status="live" />);
    expect(screen.getByText('LIVE')).toBeInTheDocument();
  });

  it('renders NO DATA for status="no_data"', () => {
    render(<StatusBadge status="no_data" />);
    expect(screen.getByText('NO DATA')).toBeInTheDocument();
  });

  it('renders REMOVED for status="removed"', () => {
    render(<StatusBadge status="removed" />);
    expect(screen.getByText('REMOVED')).toBeInTheDocument();
  });

  it('renders nothing for unknown / null status', () => {
    const { container: c1 } = render(<StatusBadge status={null} />);
    expect(c1).toBeEmptyDOMElement();
    const { container: c2 } = render(<StatusBadge status="banana" />);
    expect(c2).toBeEmptyDOMElement();
  });

  it('LIVE uses emerald color class (visual contract)', () => {
    render(<StatusBadge status="live" />);
    const el = screen.getByText('LIVE');
    expect(el.className).toMatch(/emerald/);
  });

  it('REMOVED uses neutral-700 class (struck-through styling)', () => {
    render(<StatusBadge status="removed" />);
    const el = screen.getByText('REMOVED');
    expect(el.className).toMatch(/neutral-/);
  });
});

describe('AnalystContributions', () => {
  it('renders nothing when target is null', () => {
    const { wrapper } = makeWrapper();
    const { container } = render(<AnalystContributions target={null} />, { wrapper });
    expect(container).toBeEmptyDOMElement();
  });

  it('renders one row per analyst contribution', () => {
    const { wrapper } = makeWrapper();
    render(<AnalystContributions target={sampleTarget} />, { wrapper });
    expect(screen.getAllByText('LIVE').length).toBe(sampleTarget.scoredAnalysts.length);
    expect(screen.getAllByText('NO DATA').length).toBe(1);   // news-sentiment
    expect(screen.getAllByText('REMOVED').length).toBe(2);   // macro + patent
  });

  it('replaces removed analyst score with an em-dash', () => {
    const { wrapper } = makeWrapper();
    render(<AnalystContributions target={sampleTarget} />, { wrapper });
    // Each removed analyst's score cell renders "—" instead of "50".
    const dashes = screen.getAllByText('—');
    expect(dashes.length).toBeGreaterThanOrEqual(2);
  });

  it('honors target.scoredAnalysts to mark LIVE rows', () => {
    const { wrapper } = makeWrapper();
    render(<AnalystContributions target={sampleTarget} />, { wrapper });
    const liveBadges = screen.getAllByText('LIVE');
    expect(liveBadges.length).toBe(7);
  });

  it('renders empty when analystContributions is empty array', () => {
    const { wrapper } = makeWrapper();
    const empty = { ...sampleTarget, analystContributions: [] };
    render(<AnalystContributions target={empty} />, { wrapper });
    expect(screen.queryByText('LIVE')).not.toBeInTheDocument();
    expect(screen.queryByText('NO DATA')).not.toBeInTheDocument();
    expect(screen.queryByText('REMOVED')).not.toBeInTheDocument();
  });

  it('renders unknown analyst names as-is (no crash on label lookup)', () => {
    const { wrapper } = makeWrapper();
    const mystery = {
      ticker: 'MYST',
      scoredAnalysts: ['quantum-vibes'],
      noDataAnalysts: [],
      analystContributions: [
        { analyst: 'quantum-vibes', score: 77, direction: 'long', weight: 1 },
      ],
    };
    render(<AnalystContributions target={mystery} />, { wrapper });
    expect(screen.getByText('quantum-vibes')).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Phase 4q — accordion + signals + no-data rendering.
// ---------------------------------------------------------------------------

describe('AnalystContributions — Phase 4q accordion', () => {
  it('fetches /api/target-rationale for the target ticker on mount', async () => {
    const { wrapper } = makeWrapper();
    render(<AnalystContributions target={sampleTarget} />, { wrapper });
    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalled();
    });
    const url = fetchSpy.mock.calls[0][0];
    expect(url).toContain('/api/target-rationale');
    expect(url).toContain('ticker=NVDA');
  });

  it('does NOT fetch when target has no ticker (enabled gate)', async () => {
    const { wrapper } = makeWrapper();
    const noTicker = { ...sampleTarget, ticker: undefined };
    render(<AnalystContributions target={noTicker} />, { wrapper });
    // Allow microtasks to run
    await new Promise((r) => setTimeout(r, 10));
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('clicking a LIVE row expands rationale + signals', async () => {
    const { wrapper } = makeWrapper();
    render(<AnalystContributions target={sampleTarget} />, { wrapper });

    // Wait for the rationale fetch to land so the row body has data.
    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalled();
    });

    // Find the technical-analyst row's button (its label is "Technical")
    const techRow = screen.getByTestId('analyst-row-technical-analyst');
    const button = techRow.querySelector('button');
    expect(button).toBeTruthy();
    expect(button.getAttribute('aria-expanded')).toBe('false');

    fireEvent.click(button);
    expect(button.getAttribute('aria-expanded')).toBe('true');

    // Rationale text shows.
    await waitFor(() => {
      expect(screen.getByText(/uptrend intact/i)).toBeInTheDocument();
    });

    // Signals key/value rendering: humanized key + formatted value.
    // ema20 → "Ema20", value 105 (integer) → "105".
    expect(screen.getByText('Ema20')).toBeInTheDocument();
    expect(screen.getByText('105')).toBeInTheDocument();
    // roc20Pct → "Roc20 Pct", 4.2 (float) → "4.20".
    expect(screen.getByText('Roc20 Pct')).toBeInTheDocument();
    expect(screen.getByText('4.20')).toBeInTheDocument();
  });

  it('clicking a NO DATA row expands a greyed/italic "No actionable data" line', async () => {
    const { wrapper } = makeWrapper();
    render(<AnalystContributions target={sampleTarget} />, { wrapper });

    await waitFor(() => expect(fetchSpy).toHaveBeenCalled());

    // news-sentiment is the no-data row in sampleTarget; the endpoint
    // payload marks it _noData: true with _reason: 'no_data'.
    const newsRow = screen.getByTestId('analyst-row-news-sentiment');
    const button = newsRow.querySelector('button');
    fireEvent.click(button);

    // The expansion shows the explicit "No actionable data — no_data"
    // message — NOT the fallback rationale, and NOT a key/value table.
    await waitFor(() => {
      expect(newsRow.textContent).toMatch(/No actionable data\s+—\s+no_data/);
    });

    // The expanded body is rendered with reduced opacity (the greyed
    // state) so it's visually distinct from a real neutral score.
    const body = newsRow.querySelector('[id^="analyst-detail-"]');
    expect(body).toBeTruthy();
    expect(body.className).toMatch(/opacity-/);

    // And the message is italicized.
    const italic = body.querySelector('.italic');
    expect(italic).toBeTruthy();
    expect(italic.textContent).toMatch(/No actionable data/);
  });

  it('respects signals._reason in the no-data line (no_actionable_data variant)', async () => {
    // earnings-analyst hits the "no actionable data" branch with
    // _reason: 'no_actionable_data'. Earnings is in scoredAnalysts
    // here (live status), but the detail.signals._noData flag should
    // still drive the no-data rendering — that's the whole point of
    // the unmistakable no-data state.
    const earningsNoDataTarget = {
      ...sampleTarget,
      noDataAnalysts: ['earnings-analyst'],
      scoredAnalysts: sampleTarget.scoredAnalysts.filter((a) => a !== 'earnings-analyst'),
    };
    const { wrapper } = makeWrapper();
    render(<AnalystContributions target={earningsNoDataTarget} />, { wrapper });

    await waitFor(() => expect(fetchSpy).toHaveBeenCalled());

    const earnRow = screen.getByTestId('analyst-row-earnings-analyst');
    const button = earnRow.querySelector('button');
    fireEvent.click(button);

    await waitFor(() => {
      expect(earnRow.textContent).toMatch(/No actionable data\s+—\s+no_actionable_data/);
    });
  });

  it('REMOVED rows are not expandable (no chevron click target)', async () => {
    const { wrapper } = makeWrapper();
    render(<AnalystContributions target={sampleTarget} />, { wrapper });
    await waitFor(() => expect(fetchSpy).toHaveBeenCalled());

    const macroRow = screen.getByTestId('analyst-row-macro-regime');
    const button = macroRow.querySelector('button');
    // Button is disabled — clicking has no effect.
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    // No expanded body appears.
    expect(macroRow.querySelector('[id^="analyst-detail-"]')).toBeNull();
  });

  it('signals key/value rendering hides _-prefixed marker keys', () => {
    const visible = _internals.visibleSignalEntries({
      ema20: 100,
      _noData: true,
      _reason: 'no_data',
      bullishPattern: 'breakout',
    });
    expect(visible.map(([k]) => k)).toEqual(['ema20', 'bullishPattern']);
  });

  it('humanizeKey produces readable labels from camelCase + snake_case', () => {
    expect(_internals.humanizeKey('ema20')).toBe('Ema20');
    expect(_internals.humanizeKey('roc20Pct')).toBe('Roc20 Pct');
    expect(_internals.humanizeKey('days_until_earnings')).toBe('Days Until Earnings');
    expect(_internals.humanizeKey('bullishPattern')).toBe('Bullish Pattern');
  });

  it('formatSignalValue formats numbers / strings / booleans / arrays sensibly', () => {
    expect(_internals.formatSignalValue(null)).toBe('—');
    expect(_internals.formatSignalValue(undefined)).toBe('—');
    expect(_internals.formatSignalValue(true)).toBe('yes');
    expect(_internals.formatSignalValue(false)).toBe('no');
    expect(_internals.formatSignalValue(3)).toBe('3');
    expect(_internals.formatSignalValue(3.14159)).toBe('3.14');
    expect(_internals.formatSignalValue('uptrend')).toBe('uptrend');
    expect(_internals.formatSignalValue([])).toBe('[]');
    expect(_internals.formatSignalValue(['a', 'b', 'c'])).toBe('a, b, c');
    expect(_internals.formatSignalValue(['a', 'b', 'c', 'd', 'e', 'f'])).toBe('a, b, c, d, e (+1)');
    expect(_internals.formatSignalValue({ x: 1 })).toBe('{"x":1}');
  });
});
