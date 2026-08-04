// GET /api/diag-quiver-social[?ticker=GME]
//
// Answers one question: does this Quiver plan include the SOCIAL datasets?
//
// Quiver sells WallStreetBets mentions, Twitter/X followers, and app ratings.
// This repo calls six datasets and none of them is social — political,
// lobbying, gov contracts and patents only. Whether the social ones are
// available is the difference between "the investor-saturation leg needs a
// new vendor" and "it is already paid for and unused".
//
// The client distinguishes the answers we care about (quiver-client.ts:47-56):
//   403 -> subscription gate. The dataset exists; this plan does not have it.
//   404 -> path wrong or dataset renamed.
//   200 -> available.
//
// This is a DIAGNOSTIC, not a data endpoint. It reports transport facts and
// a tiny row sample so a human can see the shape. It never scores anything.

import type { Handler } from '@netlify/functions';
import { logger } from './shared/logger';

const log = logger.child({ fn: 'diag-quiver-social' });
const BASE = 'https://api.quiverquant.com/beta';

/**
 * Candidate paths, most-likely first per family. Quiver's docs and community
 * wrappers disagree on several of these, so each family gets more than one
 * shot before it is called absent — a 404 on the first guess proves nothing.
 */
const PROBES: Array<{ family: string; why: string; paths: string[] }> = [
  {
    family: 'wallstreetbets',
    why: 'retail chatter — the investor-saturation leg this app has no source for',
    paths: ['/historical/wallstreetbets/{t}', '/historical/wsb/{t}', '/live/wallstreetbets'],
  },
  {
    family: 'twitter',
    why: 'X/Twitter follower counts — a slow-moving brand-attention proxy',
    paths: ['/historical/twitter/{t}', '/historical/twittersentiment/{t}', '/live/twitter'],
  },
  {
    family: 'appratings',
    why: 'app-store ratings — a CONSUMER-DEMAND leg (what people do, not look at)',
    paths: ['/historical/appratings/{t}', '/historical/appRatings/{t}', '/live/appratings'],
  },
  {
    family: 'spendingdata',
    why: 'consumer spending — closest thing Quiver has to card-panel data',
    paths: ['/historical/spendingdata/{t}', '/historical/spending/{t}'],
  },
  {
    family: 'insiders (control)',
    why: 'CONTROL: known 403 on this plan per data-provider.ts:1288 — proves the probe can see a gate',
    paths: ['/live/insiders'],
  },
  {
    family: 'lobbying (control)',
    why: 'CONTROL: known-good, already wired in political-provider.ts',
    paths: ['/historical/lobbying/{t}'],
  },
];

function json(status: number, body: unknown) {
  return {
    statusCode: status,
    headers: { 'content-type': 'application/json', 'cache-control': 'private, no-store' },
    body: JSON.stringify(body, null, 2),
  };
}

type Attempt = { path: string; status: number | null; verdict: string; note?: string };

function verdictFor(status: number | null): string {
  if (status === 200) return 'AVAILABLE';
  if (status === 403) return 'SUBSCRIPTION_GATE';
  if (status === 404) return 'NOT_FOUND';
  if (status === 429) return 'RATE_LIMITED';
  if (status === 401) return 'BAD_KEY';
  return 'ERROR';
}

export const handler: Handler = async (event) => {
  const key = process.env.QUIVER_API_KEY;
  if (!key) return json(503, { ok: false, error: 'QUIVER_API_KEY not set in this environment' });

  const ticker = (event.queryStringParameters?.ticker ?? 'GME').toUpperCase();
  const results: Array<{ family: string; why: string; verdict: string; sampleKeys: string[] | null; rows: number | null; attempts: Attempt[] }> = [];

  for (const probe of PROBES) {
    const attempts: Attempt[] = [];
    let verdict = 'NOT_FOUND';
    let sampleKeys: string[] | null = null;
    let rows: number | null = null;

    for (const tpl of probe.paths) {
      const path = tpl.replace('{t}', encodeURIComponent(ticker));
      let status: number | null = null;
      try {
        const res = await fetch(`${BASE}${path}`, {
          headers: { Accept: 'application/json', Authorization: `Token ${key}` },
        });
        status = res.status;
        const v = verdictFor(status);
        if (status === 200) {
          const body: any = await res.json().catch(() => null);
          const arr = Array.isArray(body) ? body : null;
          rows = arr ? arr.length : null;
          // The row SHAPE is what tells us whether it is usable — a 200 with
          // an empty array means "covered but no data for this ticker",
          // which is a different answer from "the plan includes it".
          sampleKeys = arr && arr.length ? Object.keys(arr[0]).slice(0, 15) : [];
          attempts.push({ path, status, verdict: v, note: arr ? `${arr.length} rows` : 'non-array body' });
          verdict = arr && arr.length === 0 ? 'AVAILABLE_BUT_EMPTY' : v;
          break;
        }
        attempts.push({ path, status, verdict: v });
        // A subscription gate is a definitive answer for the family — stop.
        if (status === 403) { verdict = v; break; }
        if (status === 401) { verdict = v; break; }
      } catch (err: any) {
        attempts.push({ path, status, verdict: 'ERROR', note: String(err?.message ?? err) });
      }
    }
    if (!attempts.some((a) => a.status === 200) && verdict === 'NOT_FOUND') {
      verdict = attempts.find((a) => a.status === 403) ? 'SUBSCRIPTION_GATE' : 'NOT_FOUND';
    }
    results.push({ family: probe.family, why: probe.why, verdict, sampleKeys, rows, attempts });
  }

  const available = results.filter((r) => r.verdict.startsWith('AVAILABLE')).map((r) => r.family);
  const gated = results.filter((r) => r.verdict === 'SUBSCRIPTION_GATE').map((r) => r.family);

  // The controls make the whole probe interpretable. If lobbying (known-good)
  // is not AVAILABLE, the key or the base URL is wrong and every other line
  // here is meaningless — say so rather than reporting a wall of NOT_FOUND
  // as if it were a finding about the plan.
  const controlGood = results.find((r) => r.family.startsWith('lobbying'))?.verdict.startsWith('AVAILABLE');
  const controlGate = results.find((r) => r.family.startsWith('insiders'))?.verdict;

  log.info('probe', { ticker, available: available.length, gated: gated.length, controlGood });

  return json(200, {
    ok: true,
    ticker,
    probedAt: new Date().toISOString(),
    summary: {
      social_available: available.filter((f) => !f.includes('control')),
      social_gated: gated.filter((f) => !f.includes('control')),
      controls: { lobbying_known_good: controlGood, insiders_known_gate: controlGate },
      trustworthy: controlGood
        ? true
        : false,
      note: controlGood
        ? 'Controls behaved as expected — the per-family verdicts below are meaningful.'
        : 'CONTROL FAILED: the known-good lobbying dataset did not return 200. The key, base URL or plan is broken; treat every verdict below as unreliable.',
    },
    results,
  });
};
