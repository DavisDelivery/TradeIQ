# Phase 4a Smoke Test Brief — Run a Real Backtest from CLI

You are running the first real backtest with TradeIQ's Phase 4a engine. Phase 4a merged to main at `5fc2414` (v0.13.0-alpha, verified live). The CLI script `scripts/run-backtest.ts` exists; sample configs are in `configs/`. Your job is to run a sanity backtest against the Dow 2018-2024 monthly config (the cleanest universe — fully survivorship-corrected back to 2018), capture the output, and report metrics. We don't need impressive numbers — we need **honest** ones, so we can tell whether the existing analyst weights are signal or noise.

This is one workstream. No code changes. ≤ 1 hour including cold-cache fill.

---

## What you are working on

**Repo.** `github.com/DavisDelivery/TradeIQ`, branch `main` (Phase 4a merged at `5fc2414`)
**Working version.** `0.13.0-alpha`
**Goal.** Run the Dow 2018-2024 monthly top-20 backtest end-to-end, sanity-check the metrics, report back.

---

## Credentials (use these — do not request from user)

```
GITHUB_PAT=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
NETLIFY_TOKEN=nfp_cwoJworGUNTi6opj8rukZpkKWXL78pbV0278
NETLIFY_SITE_ID=8e90d525-78f3-4288-9c15-8b1968e994c1
NETLIFY_TEAM_ID=69c43f638748ee6e940f5f62
```

The backtest needs all the data-provider env vars. They are set on Netlify already (Phase 0–3 used them) but you need them in your local process. **Pull them from Netlify's API using the token above**, then set them in your shell. Do not ask the user for the values.

Required env vars to populate:
- `POLYGON_API_KEY`
- `FINNHUB_API_KEY`
- `QUIVER_API_KEY`
- `FRED_API_KEY`
- `ANTHROPIC_API_KEY`
- `FIREBASE_SERVICE_ACCOUNT` (multi-line JSON; preserve as-is)

**How to pull from Netlify.**
```bash
NETLIFY_TOKEN=nfp_cwoJworGUNTi6opj8rukZpkKWXL78pbV0278
SITE_ID=8e90d525-78f3-4288-9c15-8b1968e994c1
TEAM_SLUG=davisdelivery  # the team account_slug

# Fetch all env vars for this site
curl -sS -H "Authorization: Bearer $NETLIFY_TOKEN" \
  "https://api.netlify.com/api/v1/accounts/${TEAM_SLUG}/env?site_id=${SITE_ID}" \
  -o /tmp/netlify-env.json

# Inspect what's available (key names only — don't echo values)
python3 -c "import json; d=json.load(open('/tmp/netlify-env.json')); print('\n'.join(v['key'] for v in d))"
```

If the team slug `davisdelivery` doesn't resolve, try `chad-davisdelivery` or list teams first via `curl -sS -H "Authorization: Bearer $NETLIFY_TOKEN" https://api.netlify.com/api/v1/accounts | python3 -m json.tool | head`.

For each required key, extract its current value:
```bash
# Example pattern — repeat per key
python3 <<'EOF'
import json, os
data = json.load(open('/tmp/netlify-env.json'))
keys = ['POLYGON_API_KEY', 'FINNHUB_API_KEY', 'QUIVER_API_KEY', 'FRED_API_KEY', 'ANTHROPIC_API_KEY', 'FIREBASE_SERVICE_ACCOUNT']
out = []
for k in keys:
    for v in data:
        if v['key'] == k:
            # Get the value for context 'all' or 'production'
            vals = v.get('values', [])
            val = next((x['value'] for x in vals if x.get('context') in ('all', 'production')), None)
            if val:
                # Escape for shell single-quoted string
                escaped = val.replace("'", "'\\''")
                out.append(f"export {k}='{escaped}'")
            break
open('/tmp/env-export.sh', 'w').write('\n'.join(out) + '\n')
print(f"wrote {len(out)} keys")
EOF

source /tmp/env-export.sh
rm /tmp/env-export.sh /tmp/netlify-env.json    # wipe secrets from disk after sourcing
```

Verify each var is set (length only, never echo values):
```bash
for k in POLYGON_API_KEY FINNHUB_API_KEY QUIVER_API_KEY FRED_API_KEY ANTHROPIC_API_KEY FIREBASE_SERVICE_ACCOUNT; do
  v="${!k}"
  echo "${k}: $([ -n "$v" ] && echo "set (${#v} chars)" || echo "MISSING")"
done
```

If any are MISSING, surface to user and stop.

---

## Required tools

`bash_tool`, `view`. The backtest does the heavy lifting — your role is to invoke it and report.

---

## Working tree setup

```bash
cd /home/claude
[ -d tradeiq ] || git clone https://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@github.com/DavisDelivery/TradeIQ.git tradeiq
cd tradeiq
git config user.email "chad@davisdelivery.com"
git config user.name "Chad Davis"
git fetch origin
git checkout main
git pull --ff-only origin main
npm ci --silent
```

Verify the engine + CLI exist:
```bash
ls netlify/functions/shared/backtest/engine.ts scripts/run-backtest.ts configs/
```

If any are missing, the merge didn't deploy what you expect — STOP and surface.

---

## Workstreams

### W1 — Run the Dow backtest

The cleanest config: Dow 2018-01-01 to 2024-12-31, monthly rebalance, top 20, prophet board. Dow has the most historical coverage (101 monthly survivorship-corrected snapshots), is the smallest universe (~30 tickers per date so fast cache fill), and runs from the earliest plan-tier-allowed start date.

Use the bundled config if available:
```bash
cat configs/dow-2018-2024-monthly-top20.json 2>/dev/null || echo "config not bundled"
```

Run it:
```bash
npx tsx scripts/run-backtest.ts --config configs/dow-2018-2024-monthly-top20.json 2>&1 | tee /tmp/backtest-run.log
```

If the config file isn't there, invoke with CLI flags:
```bash
npx tsx scripts/run-backtest.ts \
  --universe dow \
  --start 2018-01-01 \
  --end 2024-12-31 \
  --rebalance monthly \
  --top-n 20 \
  --board prophet \
  2>&1 | tee /tmp/backtest-run.log
```

**Expectations on duration.** First run is cold cache. With ~30 Dow tickers × ~84 monthly rebalances = ~2,500 ticker-date scoring calls × ~5 PIT data calls each = ~12,000 vendor calls. Polygon free tier is 5 calls/sec. Even with concurrency limits, expect 30–90 minutes for the first run. Cache hits make subsequent runs minutes.

**Don't kill the run if it's slow.** Slow first run is expected. Kill only if (a) errors are spamming the log, (b) the run hangs for > 10 minutes with no log output, or (c) you hit hard API quota limits (Polygon will return 429s repeatedly).

### W2 — Capture metrics + runId

When the script completes, the last lines of stdout should print the runId and summary metrics. Extract:

```bash
RUN_ID=$(grep -oE "runId: [a-zA-Z0-9_]+" /tmp/backtest-run.log | head -1 | cut -d' ' -f2)
echo "Run ID: $RUN_ID"
tail -50 /tmp/backtest-run.log
```

Required metrics to capture (from the log output or by reading Firestore at `backtestRuns/{runId}`):
- Total return (%)
- CAGR (annualized)
- Sharpe ratio
- Sortino ratio
- Max drawdown (%)
- Recovery time (days)
- Win rate (%)
- Average win / Average loss / Profit factor
- Information coefficient (IC)
- Information ratio (IR)
- Per-regime breakdown (return + Sharpe for risk_on / neutral / risk_off)
- Number of trades total
- universeSurvivorshipCorrected flag

### W3 — Sanity-check the numbers

This is the most important step. Backtest results that are "too good to be true" are almost always look-ahead bias bugs.

**Red flags to flag explicitly:**

| Metric | Suspicious if | Why |
|---|---|---|
| Sharpe | > 2.5 on Dow long-only | Top-tier hedge funds run 1.5–2.0 Sharpe. > 2.5 strongly suggests data leak |
| Max DD | < 10% over 2018–2024 | The 2020 COVID crash was -34% on SPX; a long-only model that avoided it cleanly is suspicious |
| Win rate | > 70% | Best systematic equity strategies run 50–60% |
| IC | > 0.15 | Genuine equity IC averages 0.03–0.08; > 0.15 is "too good" territory |
| CAGR | > 25% | Dow returned ~12% CAGR over this period; a model meaningfully above that needs explanation |

If any of these fire, **do not declare success**. Surface to user with the actual numbers and the sanity-check verdict. The integrity tests in Phase 4a should have caught look-ahead, but absence of failing tests is not proof of absence — these red flags are the secondary backstop.

**Honest numbers to expect.** If the analyst weights are doing real work but not magic, ballpark targets for Dow 2018-2024 monthly long-only:
- CAGR: 8–18% (vs Dow's ~12%)
- Sharpe: 0.5–1.5
- Max DD: 20–35%
- Win rate: 50–60%
- IC: 0.02–0.08

These are not targets to hit — they're the believability range. Coming in below means weights are weak. Coming in above means probable bias. Right in the middle means honest signal.

### W4 — Verify Firestore record

```bash
# Use the firebase-admin SDK via a quick Node script to read the run record
cat > /tmp/check-run.mjs <<EOF
import admin from 'firebase-admin';
const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({ credential: admin.credential.cert(sa), projectId: sa.project_id });
const db = admin.firestore();
const runId = '${RUN_ID}';
const doc = await db.collection('backtestRuns').doc(runId).get();
console.log('exists:', doc.exists);
if (doc.exists) {
  const data = doc.data();
  console.log('config:', JSON.stringify(data.config, null, 2));
  console.log('metrics:', JSON.stringify(data.metrics, null, 2));
  console.log('universeSurvivorshipCorrected:', data.universeSurvivorshipCorrected);
  console.log('completedAt:', data.completedAt);
}
const ml = await db.collection('backtestRuns').doc(runId).collection('mlTraining').count().get();
console.log('mlTraining row count:', ml.data().count);
const trades = await db.collection('backtestRuns').doc(runId).collection('trades').count().get();
console.log('trades count:', trades.data().count);
process.exit(0);
EOF
node /tmp/check-run.mjs
rm /tmp/check-run.mjs
```

Confirm:
- `exists: true`
- `metrics` populated
- `universeSurvivorshipCorrected.dow: true`
- mlTraining rows > 0 (Phase 5 will consume these)
- trades count plausible (probably 200-500 for a 7-year monthly top-20 backtest)

If the run record didn't land in Firestore, that's a Phase 4a engine bug — surface with the engine log.

### W5 — Report back

Format your response as:

```
PHASE 4A SANITY TEST — RESULTS

Run ID: <runId>
Duration: <minutes>
Config: Dow 2018-01-01 to 2024-12-31, monthly, top 20, prophet board

METRICS
  Total return:    X%
  CAGR:            X%
  Sharpe:          X
  Sortino:         X
  Max DD:          -X%
  Recovery:        X days
  Win rate:        X%
  Avg win / loss:  +X% / -X%
  Profit factor:   X
  IC:              X
  IR:              X
  Trades total:    X

PER-REGIME
  risk_on:   return=X%  sharpe=X  N rebalances=X
  neutral:   return=X%  sharpe=X  N rebalances=X
  risk_off:  return=X%  sharpe=X  N rebalances=X

UNIVERSE STAMP
  dow: corrected=true

SANITY-CHECK VERDICT
  Sharpe: <in range / suspiciously high / unimpressive>
  Max DD: <in range / suspicious / honest pain>
  Win rate: <in range / too high>
  IC: <honest / too good>
  Overall: <ship it / investigate before trusting>

FIRESTORE RECORD
  backtestRuns/{runId}: exists
  mlTraining rows: X
  trades subcoll: X

ANOMALIES / NOTES
  <anything weird in the log; any errors swallowed; cache hit rate if logged>
```

If the sanity check fires red flags, **flag them explicitly in the verdict**. Don't soft-pedal.

---

## Out of scope

- No code changes to the engine. If you find a bug, document and surface — don't patch.
- No UI work (Phase 4b).
- No additional backtest runs unless the first fails — single sanity test, report back.
- Don't run SP500 / NDX in this brief — those universes are survivorship-biased per Phase 4a docs.
- No env var modifications to Netlify (read-only access).

---

## What to do if blocked

- **Netlify env var pull fails** (wrong team slug, token scope). Surface to user with the error. Don't ask user to paste keys in chat — that's a downgrade in handling.
- **Polygon hits hard rate limit and the run errors out.** Lower concurrency via env var if the engine supports it, or pause and retry — cache will resume from where it left off.
- **Run exceeds 2 hours.** Kill it, capture partial logs, surface. Likely a missing cache wrap or unbounded concurrency.
- **Sharpe > 3 or other clear leak signal.** STOP. Do not declare success. Run the integrity test suite to confirm it's still green, then surface to user — the engine has a bug Phase 4a's tests missed.
- **Firestore quota.** Phase 4a engine should batch writes; if you still hit quota, capture the runId and inform user. Run is salvageable from logs.

---

## Wipe secrets

When done, wipe the secrets from your container:
```bash
unset POLYGON_API_KEY FINNHUB_API_KEY QUIVER_API_KEY FRED_API_KEY ANTHROPIC_API_KEY FIREBASE_SERVICE_ACCOUNT
# Sanity check
for k in POLYGON_API_KEY FINNHUB_API_KEY QUIVER_API_KEY FRED_API_KEY ANTHROPIC_API_KEY FIREBASE_SERVICE_ACCOUNT; do
  [ -z "${!k}" ] && echo "$k: cleared" || echo "$k: STILL SET"
done
```

---

## First actions

```bash
# 1. Working tree
cd /home/claude
[ -d tradeiq ] || git clone https://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@github.com/DavisDelivery/TradeIQ.git tradeiq
cd tradeiq
git fetch origin && git checkout main && git pull --ff-only origin main
npm ci --silent

# 2. Confirm engine + CLI exist
ls netlify/functions/shared/backtest/engine.ts scripts/run-backtest.ts configs/

# 3. Pull env vars from Netlify (see "Credentials" section above)
# ... follow that block, source the export script, verify all keys set ...

# 4. Run the backtest
npx tsx scripts/run-backtest.ts --config configs/dow-2018-2024-monthly-top20.json 2>&1 | tee /tmp/backtest-run.log
```

Then W2 (capture metrics) → W3 (sanity check) → W4 (verify Firestore) → W5 (report).

---

End of brief.
