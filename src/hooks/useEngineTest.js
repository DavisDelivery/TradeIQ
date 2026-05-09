import { useMutation, useQueryClient } from '@tanstack/react-query';
import { queryKeys } from '../lib/queryKeys.js';
import { fetchWithRetry } from '../lib/validateResponse.js';

// Engine test — manual-trigger pattern. Unlike the board hooks, this
// fires only when the user clicks "Run", so useMutation is the right
// primitive (useQuery would fire on every mount). The result lands in
// the regular query cache via setQueryData so a second click on the
// same ticker is instant (mutationKey doesn't auto-cache).
//
// Returns the same shape as useQuery for ergonomics:
//   { data, error, isPending, mutate, reset }
// where mutate(ticker) replaces the prior result.

export function useEngineTest() {
  const qc = useQueryClient();

  const mutation = useMutation({
    mutationFn: async (ticker) => {
      const r = await fetchWithRetry(
        `/api/engine-test?ticker=${encodeURIComponent(ticker.toUpperCase())}`,
      );
      const data = await r.json();
      if (!r.ok || data.error) throw new Error(data.error || `HTTP ${r.status}`);
      return data;
    },
    onSuccess: (data, ticker) => {
      qc.setQueryData(queryKeys.engineTest(ticker.toUpperCase()), data);
    },
  });

  return mutation;
}
