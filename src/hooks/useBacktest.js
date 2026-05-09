import { useQuery } from '@tanstack/react-query';
import { queryKeys } from '../lib/queryKeys.js';
import { validate, SHAPES, fetchWithRetry } from '../lib/validateResponse.js';

// Backtest — runs scoring across N days of history for a fixed ticker
// list. staleTime is generous (10 min) since the underlying data is
// historical and won't change between scans within a session.
//
// Cache key includes lookback days + the comma-joined ticker string so
// switching the lookback re-fetches but switching back returns instantly.

export function useBacktest(lookbackDays = 365, tickers = 'NVDA,AAPL,MSFT,GOOGL,AMZN,META,TSLA,AVGO,AMD,INTC') {
  return useQuery({
    queryKey: queryKeys.backtest(lookbackDays, tickers),
    queryFn: async ({ signal }) => {
      const r = await fetchWithRetry(
        `/api/backtest?lookbackDays=${lookbackDays}&tickers=${encodeURIComponent(tickers)}&sampleEvery=5`,
        { signal },
      );
      const json = await r.json();
      if (!r.ok || (!json.ok && json.error)) {
        throw new Error(json.error || `HTTP ${r.status}`);
      }
      return validate(json, SHAPES.backtest, 'backtest');
    },
    staleTime: 10 * 60 * 1000,
  });
}
