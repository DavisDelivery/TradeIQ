// GET /api/screens-board
//   ?screen=<id>&universe=sp500|russell2k|ndx|dji
//   (no screen param) → the screen catalog with evidence grades
//
// FVZ-3 — published screening strategies over the cached Finviz universe.
//
// Deliberately NOT snapshot-backed like the scored boards: a screen is a
// deterministic predicate over a universe we already cache for 15 minutes,
// so it recomputes in microseconds and there is nothing to schedule. The
// freshness the user cares about is the UNDERLYING quote data's, which is
// what `fetchedAt`/`ageMs` report.
//
// Status discipline matches the other boards: 200 with an empty list is a
// legitimate answer (an oversold screen SHOULD be empty in a melt-up), while
// an upstream failure is 502 and a missing token is 503 — a caller must
// never mistake "Finviz is down" for "nothing qualifies today".

import type { Handler } from '@netlify/functions';
import {
  finvizEnabled,
  getFinvizUniverseSnapshot,
  fetchFinvizScreener,
  FINVIZ_UNIVERSE_FILTERS,
  type FinvizUniverse,
  type FinvizRow,
} from './shared/finviz';
import { SCREENS, SCREENS_BY_ID, applyScreen } from './shared/finviz-screens';
import { createLogger } from './shared/logger';

const log = createLogger('screens-board');
const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=300' };

const json = (statusCode: number, body: unknown) => ({
  statusCode,
  headers,
  body: JSON.stringify(body),
});

/** Catalog entries omit the functions — they are not serializable. */
const catalog = () =>
  SCREENS.map(
    ({ id, name, thesis, popularizedBy, evidence, evidenceNote, source, approximations, take, preferredUniverse }) => ({
      id,
      name,
      thesis,
      popularizedBy,
      evidence,
      evidenceNote,
      source,
      approximations: approximations ?? [],
      take: take ?? null,
      preferredUniverse: preferredUniverse ?? null,
      needsDedicatedFetch: (SCREENS_BY_ID.get(id)?.filters.length ?? 0) > 0,
    }),
  );

export const handler: Handler = async (event) => {
  const start = Date.now();
  const qs = event.queryStringParameters ?? {};
  const screenId = qs.screen;
  const universeRaw = qs.universe ?? 'sp500';

  if (!screenId) return json(200, { ok: true, screens: catalog() });

  if (!(universeRaw in FINVIZ_UNIVERSE_FILTERS)) {
    return json(400, {
      ok: false,
      error: `unknown universe '${universeRaw}'`,
      universes: Object.keys(FINVIZ_UNIVERSE_FILTERS),
    });
  }
  const universe = universeRaw as FinvizUniverse;

  const screen = SCREENS_BY_ID.get(screenId);
  if (!screen) {
    return json(404, { ok: false, error: `unknown screen '${screenId}'`, screens: SCREENS.map((s) => s.id) });
  }
  if (!finvizEnabled()) {
    return json(503, { ok: false, enabled: false, error: 'FINVIZ_AUTH_TOKEN not configured' });
  }

  try {
    let rows: FinvizRow[];
    let fetchedAt: string;
    let source: 'cache' | 'live';

    if (screen.filters.length > 0) {
      // Screens whose constraints live outside our 51 columns pay for a
      // dedicated export call, scoped to the requested universe.
      const res = await fetchFinvizScreener([FINVIZ_UNIVERSE_FILTERS[universe], ...screen.filters]);
      if (res === null) {
        log.error('screener fetch failed', { screenId, universe, durationMs: Date.now() - start });
        return json(502, { ok: false, error: 'finviz screener fetch failed', screen: screenId });
      }
      rows = res.rows;
      fetchedAt = new Date().toISOString();
      source = 'live';
    } else {
      const snap = await getFinvizUniverseSnapshot(universe);
      if (snap === null) {
        log.error('universe fetch failed', { screenId, universe, durationMs: Date.now() - start });
        return json(502, { ok: false, error: 'finviz universe fetch failed', screen: screenId });
      }
      rows = snap.rows;
      fetchedAt = snap.fetchedAt;
      source = snap.source;
    }

    const result = applyScreen(screen, rows);
    const ageMs = Date.now() - Date.parse(fetchedAt);

    log.info('response', {
      screenId,
      universe,
      matched: result.rows.length,
      universeChecked: result.universeChecked,
      source,
      durationMs: Date.now() - start,
    });

    return json(200, {
      ok: true,
      screen: {
        id: screen.id,
        name: screen.name,
        thesis: screen.thesis,
        popularizedBy: screen.popularizedBy,
        evidence: screen.evidence,
        evidenceNote: screen.evidenceNote,
        source: screen.source,
        approximations: screen.approximations ?? [],
      },
      universe,
      rows: result.rows,
      matched: result.rows.length,
      universeChecked: result.universeChecked,
      fetchedAt,
      ageMs,
      dataSource: source,
    });
  } catch (err: any) {
    log.error('failed', { error: err, screenId, durationMs: Date.now() - start });
    return json(500, { ok: false, error: String(err?.message ?? err) });
  }
};
