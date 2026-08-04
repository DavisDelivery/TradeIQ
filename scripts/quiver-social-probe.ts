// One-shot probe: does this Quiver plan include the SOCIAL datasets?
//
// Same probe table as netlify/functions/diag-quiver-social.ts, runnable from a
// shell so the answer does not depend on a deploy being live.
//
//   QUIVER_API_KEY=... npx tsx scripts/quiver-social-probe.ts [TICKER]
//
// Read the CONTROLS first. If lobbying (known-good) is not 200, the key or the
// base URL is wrong and every other line is noise, not a finding.

const BASE = 'https://api.quiverquant.com/beta';

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
    why: 'CONTROL: known 403 on this plan per data-provider.ts — proves the probe can see a gate',
    paths: ['/live/insiders'],
  },
  {
    family: 'lobbying (control)',
    why: 'CONTROL: known-good, already wired in political-provider.ts',
    paths: ['/historical/lobbying/{t}'],
  },
];

function verdictFor(status: number | null): string {
  if (status === 200) return 'AVAILABLE';
  if (status === 403) return 'SUBSCRIPTION_GATE';
  if (status === 404) return 'NOT_FOUND';
  if (status === 429) return 'RATE_LIMITED';
  if (status === 401) return 'BAD_KEY';
  return 'ERROR';
}

async function main() {
  const key = process.env.QUIVER_API_KEY;
  if (!key) {
    console.error('QUIVER_API_KEY not set');
    process.exit(2);
  }
  const ticker = (process.argv[2] ?? 'GME').toUpperCase();
  console.log(`probing ${BASE} for ${ticker}\n`);

  for (const probe of PROBES) {
    let verdict = 'NOT_FOUND';
    let detail = '';
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
          verdict = arr && arr.length === 0 ? 'AVAILABLE_BUT_EMPTY' : v;
          detail = arr
            ? `${arr.length} rows · keys: ${arr.length ? Object.keys(arr[0]).slice(0, 12).join(', ') : '(empty)'}`
            : `non-array body: ${JSON.stringify(body).slice(0, 160)}`;
          console.log(`  ${path} -> ${status} ${verdict}`);
          if (arr && arr.length) console.log(`     sample: ${JSON.stringify(arr[0]).slice(0, 300)}`);
          break;
        }
        console.log(`  ${path} -> ${status} ${v}`);
        if (status === 403 || status === 401) { verdict = v; break; }
      } catch (err: any) {
        console.log(`  ${path} -> ERROR ${String(err?.message ?? err)}`);
      }
    }
    console.log(`${probe.family.toUpperCase()}: ${verdict}${detail ? ` — ${detail}` : ''}`);
    console.log(`   (${probe.why})\n`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
