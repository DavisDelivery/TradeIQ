// AI-1 (2026-08-06) — the Chart tab must not spend Claude tokens on mount.
//
// ChartView calls useChartAnalysis with a DEFAULT ticker of 'NVDA', so before
// this fix simply opening the tab fired /api/chart-analysis with the AI
// narrative enabled — the exact page-load spend the on-demand rule forbids.
// It survived the first on-demand pass because that pass only chased the
// Prophet paths.
//
// The second assertion is the subtle one: the AI and no-AI responses come
// from the same endpoint, so if both variants shared a query key the
// "Generate AI read" button would be a no-op that re-served the cached
// AI-less payload.

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useChartAnalysis } from '../useChartAnalysis.js';
import { queryKeys } from '../../lib/queryKeys.js';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

const wrapper = ({ children }) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
};

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockImplementation(() =>
    Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ticker: 'NVDA', bars: [] }) }),
  );
});

describe('useChartAnalysis — AI is opt-in', () => {
  it('DEFAULTS to skipAi=1, so mounting the Chart tab spends nothing', async () => {
    renderHook(() => useChartAnalysis('NVDA', 180), { wrapper });
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(String(fetchMock.mock.calls[0][0])).toContain('skipAi=1');
  });

  it('omits skipAi only when the caller explicitly opts in', async () => {
    renderHook(() => useChartAnalysis('NVDA', 180, { withAi: true }), { wrapper });
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(String(fetchMock.mock.calls[0][0])).not.toContain('skipAi');
  });

  it('keys the two variants apart — else the Generate button is a no-op', () => {
    expect(queryKeys.chartAnalysis('NVDA', false)).not.toEqual(
      queryKeys.chartAnalysis('NVDA', true),
    );
  });
});
