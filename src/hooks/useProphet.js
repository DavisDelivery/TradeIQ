import { useQuery } from '@tanstack/react-query';
import { queryKeys } from '../lib/queryKeys.js';
import { validate, SHAPES, fetchWithRetry } from '../lib/validateResponse.js';

// Prophet has prophet-specific defensive JSON handling that doesn't apply
// to other endpoints:
//
//   1. AI-generated narratives occasionally contain stray ASCII control
//      chars (\u0000-\u001F + \u2028/\u2029) that can break native
//      JSON.parse on mobile webviews. We sanitize the raw text and retry
//      parse before giving up.
//   2. If parse still fails, we re-issue the fetch with `narrate=0` to
//      strip the AI narratives entirely (the deterministic fields are
//      always clean). Worst case: user gets the data without narratives,
//      not a hard failure.
//
// All of this is wrapped inside the queryFn so it's transparent to the
// view; ProphetView gets a plain { data, error, ... } from useQuery.
async function fetchProphet(url, signal) {
  const r = await fetchWithRetry(url, { signal });
  const ctype = r.headers.get('content-type') ?? '';
  if (!ctype.includes('json')) {
    const text = await r.text();
    throw new Error(`Server ${r.status}: ${text.slice(0, 120)}`);
  }
  // Read as text first so we can sanitize before parsing.
  const raw = await r.text();
  let json;
  try {
    json = JSON.parse(raw);
  } catch (parseErr) {
    // Strip control chars and retry parse.
    const clean = raw.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u2028\u2029]/g, ' ');
    try {
      json = JSON.parse(clean);
    } catch {
      // Last resort: refetch without narratives. Console.error so
      // it shows in Sentry breadcrumbs as a known recovery path.
      // eslint-disable-next-line no-console
      console.error('[useProphet] JSON parse failed, retrying with narrate=0', parseErr.message);
      const fallback = await fetch(`${url}&narrate=0`, { signal });
      if (!fallback.ok) throw new Error(`Scan failed: ${parseErr.message}`);
      json = await fallback.json();
    }
  }
  if (!r.ok || (!json.ok && json.error)) {
    throw new Error(json.error || `HTTP ${r.status}`);
  }
  return validate(json, SHAPES.prophet, 'prophet');
}

export function useProphet(universe, minConviction) {
  const url = () => {
    const qs = new URLSearchParams({ universe, limit: '30' });
    if (minConviction) qs.set('minConviction', minConviction);
    return `/api/prophet-picks?${qs.toString()}`;
  };

  const query = useQuery({
    queryKey: queryKeys.prophet(universe, minConviction),
    queryFn: ({ signal }) => fetchProphet(url(), signal),
    staleTime: 60_000,
  });

  // "Force Rescan" in the snapshot-first model = re-read the authoritative
  // latest snapshot, NOT a live `force=1` scan. A forced live scan is slower
  // than the snapshot (~30s, riding the 26s function ceiling → intermittent
  // 504), returns FEWER picks (partial: it only reaches a fraction of the
  // 508/1928 universe before the budget), and bypasses the query lifecycle
  // so the UI shows no spinner and swallows errors — the exact behavior
  // PR-H removed. `refetch()` re-reads the snapshot and drives `isFetching`
  // + `error` correctly. Fresh scans come from the 22:00 cron / background
  // trigger, which is the only path that can scan the full universe.
  const forceRescan = () => query.refetch();

  return { ...query, forceRescan };
}
