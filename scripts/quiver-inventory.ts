// Full inventory: which Quiver datasets does THIS plan actually serve?
//
//   QUIVER_API_KEY=... npx tsx scripts/quiver-inventory.ts [TICKER]
//
// 403 = dataset exists, plan does not include it (upgrade buys it).
// 404 = path wrong or dataset does not exist under that name.
// 200 = on the plan.
//
// Run this before assuming a leg "needs a new vendor" — some of it is already
// paid for and unused.

const BASE = 'https://api.quiverquant.com/beta';

const DATASETS = [
  'congresstrading', 'senatetrading', 'housetrading', 'govcontracts',
  'govcontractsall', 'lobbying', 'wallstreetbets', 'twitter', 'insiders',
  'offexchange', 'patents', 'allpatents', 'sec13f', '13f', 'flights',
  'appratings', 'politicalbeta', 'wikipedia', 'spendingdata', 'etfholdings',
  'institutions', 'pelositracker', 'corporatelobbying', 'stockcomments',
];

function v(s: number | null) {
  if (s === 200) return 'ON PLAN';
  if (s === 403) return 'gated (exists, not on plan)';
  if (s === 404) return 'no such path';
  if (s === 401) return 'BAD KEY';
  return `http ${s}`;
}

async function hit(url: string, key: string): Promise<{ status: number | null; rows: number | null }> {
  try {
    const res = await fetch(url, { headers: { Accept: 'application/json', Authorization: `Token ${key}` } });
    if (res.status !== 200) return { status: res.status, rows: null };
    const body: any = await res.json().catch(() => null);
    return { status: 200, rows: Array.isArray(body) ? body.length : null };
  } catch {
    return { status: null, rows: null };
  }
}

async function main() {
  const key = process.env.QUIVER_API_KEY;
  if (!key) { console.error('QUIVER_API_KEY not set'); process.exit(2); }
  const ticker = (process.argv[2] ?? 'CROX').toUpperCase();

  const on: string[] = [], gated: string[] = [], absent: string[] = [];

  for (const d of DATASETS) {
    const h = await hit(`${BASE}/historical/${d}/${ticker}`, key);
    let status = h.status, rows = h.rows, shape = 'historical';
    if (status === 404) {
      const l = await hit(`${BASE}/live/${d}`, key);
      if (l.status !== 404) { status = l.status; rows = l.rows; shape = 'live'; }
    }
    const line = `${d.padEnd(18)} ${shape.padEnd(10)} ${v(status)}${rows != null ? ` · ${rows} rows` : ''}`;
    console.log(line);
    if (status === 200) on.push(d);
    else if (status === 403) gated.push(d);
    else absent.push(d);
  }

  console.log(`\nON PLAN (${on.length}): ${on.join(', ') || '—'}`);
  console.log(`GATED  (${gated.length}): ${gated.join(', ') || '—'}`);
  console.log(`ABSENT (${absent.length}): ${absent.join(', ') || '—'}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
