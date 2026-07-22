import { useQuery } from '@tanstack/react-query';
import { fetchWithRetry } from '../lib/validateResponse.js';

// Global header typeahead. Resolves a free-text query to real, tradeable
// symbols via /api/symbol-search (Polygon reference `search` — matches ticker
// AND company name). Debouncing is the caller's job: pass an already-debounced
// query so each keystroke doesn't spawn a request. Disabled on empty query.
export function useSymbolSearch(query) {
  const q = (query ?? '').trim();
  return useQuery({
    queryKey: ['symbol-search', q],
    enabled: q.length >= 1,
    queryFn: async ({ signal }) => {
      const r = await fetchWithRetry(`/api/symbol-search?q=${encodeURIComponent(q)}`, { signal });
      const json = await r.json();
      if (!r.ok || json.error) throw new Error(json.error || `HTTP ${r.status}`);
      return json.results ?? [];
    },
    // Reference data is static; keep results warm across re-opens of the box.
    staleTime: 5 * 60 * 1000,
  });
}
