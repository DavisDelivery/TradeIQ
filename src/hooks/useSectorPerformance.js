// SECTOR-1 — the cross-sector strength table.
//
// Deliberately NOT keyed by ticker: the table is identical for every stock in
// the app, so one query entry serves every profile open and the sector panel
// is free after the first fetch of the session.

import { useQuery } from '@tanstack/react-query';
import { queryKeys } from '../lib/queryKeys.js';
import { fetchWithRetry } from '../lib/validateResponse.js';

export function useSectorPerformance() {
  const query = useQuery({
    queryKey: queryKeys.sectorPerformance(),
    queryFn: async ({ signal }) => {
      const r = await fetchWithRetry('/api/sector-performance', { signal });
      const json = await r.json();
      if (!r.ok || json?.ok === false) throw new Error(json?.error || `HTTP ${r.status}`);
      return json;
    },
    staleTime: 30 * 60 * 1000, // sector aggregates are daily-ish
    placeholderData: (prev) => prev,
  });

  const sectors = query.data?.sectors ?? [];
  return {
    sectors,
    bySector: Object.fromEntries(sectors.map((s) => [s.sector, s])),
    spy: query.data?.spy ?? {},
    asOf: query.data?.asOf ?? null,
    unavailable: query.data?.unavailable ?? [],
    isLoading: query.isLoading,
    error: query.error,
  };
}
