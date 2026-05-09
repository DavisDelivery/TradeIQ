import { useQuery } from '@tanstack/react-query';
import { queryKeys } from '../lib/queryKeys.js';
import { fetchWithRetry } from '../lib/validateResponse.js';

// Snapshot replay history — list of past board snapshots (target,
// prophet, etc.) for the HistoryView replay surface. staleTime 60s
// since snapshots are written every 30 min by scheduled functions and
// the UI only needs to track "is there a newer one yet".
//
// Two modes:
//   - List mode (default): snapshotId omitted -> returns the recent list
//   - Detail mode: pass snapshotId -> returns the full payload of a
//     specific past snapshot (cached per snapshotId so repeated views
//     don't re-fetch)

export function useSnapshotHistory(board, universe, snapshotId) {
  const detailMode = !!snapshotId;
  const queryKey = detailMode
    ? [...queryKeys.snapshotHistory(board), universe, snapshotId]
    : [...queryKeys.snapshotHistory(board), universe, 'list'];

  return useQuery({
    queryKey,
    enabled: !!board,
    queryFn: async ({ signal }) => {
      const base = `/api/snapshot-history?board=${encodeURIComponent(board)}&universe=${encodeURIComponent(universe ?? 'all')}`;
      const url = detailMode
        ? `${base}&snapshotId=${encodeURIComponent(snapshotId)}`
        : `${base}&limit=60`;
      const r = await fetchWithRetry(url, { signal });
      const json = await r.json();
      if (!r.ok || json.error) throw new Error(json.error || `HTTP ${r.status}`);
      return json;
    },
    staleTime: 60_000,
  });
}
