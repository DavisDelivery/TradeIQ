# Executor kickoff — Phase 5a: ML Training Pipeline (Discovery)

> **For Chad:** paste this entire file as the opening message of a new
> Claude conversation. Then in your second message provide the
> write-scoped GitHub PAT and the Firebase service-account JSON. The
> agent has everything else it needs after that.

---

You are an executor agent. Your single assignment is **Phase 5a — ML
Training Pipeline (Discovery)** for the TradeIQ project. The
conversation you're reading right now is your boot prompt: all the
context, secrets, repo layout, conventions, and hand-off protocol
live below. Do not ask Chad to explain TradeIQ or re-summarize the
brief. Read this end-to-end, then read the brief.

## 1. What TradeIQ is (one paragraph)

TradeIQ is a personal multi-board equity-research app at
`https://tradeiq-alpha.netlify.app`. The Prophet board scores tickers
across 7 layers (structure, momentum, volume, volatility, relative
strength, fundamental, catalyst), composites them via a hand-tuned
weighted sum, and surfaces the top candidates. Phase 4a built a
backtest engine that writes one `mlTraining` row per
`(asOfDate, ticker)` pair to Firestore — each row is a point-in-time
observation with all 7 layer scores plus the realized forward return.
That data has been accumulating for weeks. Phase 5a is the first phase
that consumes it. Stack: the live app is TypeScript + React + Vite +
Firestore + Polygon/Finnhub/Quiver data. Phase 5a adds **Python**
to the repo for the first time (in `scripts/ml/`); Phase 5b will deal
with deploying any winning model back into the TypeScript scorer.

## 2. Your assignment in two sentences

Train a small set of candidate ML models on the existing `mlTraining`
data and answer one question: **does any model beat the hand-tuned
composite scorer by a statistically meaningful margin, using
methodology that holds up to scrutiny?** Your deliverable is
`reports/phase-5a/findings.md`; the report's headline answer
(YES with model X / NO, composite is the ceiling) decides whether
Phase 5b is created.

## 3. Boot sequence — literal commands

Run these as the first thing you do, in order. The PAT and service-
account JSON come from Chad's next message.

```bash
# Working directory
mkdir -p /home/claude && cd /home/claude

# Clone (replace <PAT> with the value from Chad's next message)
git clone https://<PAT>@github.com/DavisDelivery/TradeIQ.git
cd TradeIQ

# Confirm you landed on the right commit. Most recent commit on main
# at the time this kickoff was written: 58d5b03. Newer is fine; older
# means something's wrong.
git log --oneline -5
# Expected to include (top of list, in order):
#   58d5b03 kickoffs: executor boot prompts for 4e-1 and 5a
#   ec0f3e0 briefs: 4e-1 — Prophet Portfolio engine + backtest validation
#   1d7c9aa Phase 4c-2 — Russell sieve + earnings-priority Prophet (#20)
#   ffcc5d3 Phase 4c-1 — Prophet detail completeness + EPS bug (#19)

# Identity for your commits
git config user.email "executor-5a@tradeiq.local"
git config user.name "Executor 5a"

# Place the Firebase service-account JSON Chad provides into:
mkdir -p .secrets
# Then paste the JSON into .secrets/firebase-sa.json
# IMPORTANT: confirm .secrets/ is in .gitignore before placing the file:
grep "^\.secrets" .gitignore || echo ".secrets/" >> .gitignore
git diff .gitignore   # confirm the line is there

# Python tooling. Prefer uv if available; pip is the fallback.
which uv && uv --version    # if uv exists, great
which python3 && python3 --version    # need 3.11
echo "3.11" > .python-version

# Create your branch (don't push yet)
git checkout -b phase-5a-ml-discovery

# Verify the TypeScript baseline still passes — your Python work should
# not break the existing test suite (and shouldn't even touch it)
npm ci
npm test         # must report: 446 passing
```

If `git log` shows fewer commits than expected, stop and surface the
discrepancy to Chad. If `python3` isn't 3.11.x, surface and ask before
proceeding.

## 4. Critical reading list, in order

1. **`briefs/phase-5a-brief.md`** — your spec. 571 lines, ~20 min to
   read carefully. Read the **"dishonesty trap"** section at the very
   top THREE times before you write any code. It enumerates the seven
   specific ways ML on financial data lies, and every protocol below
   it exists to prevent one of them. The protocols are not
   negotiable — relaxing them because early results look ugly is the
   failure mode.
2. **`ORCHESTRATOR.md`** — the project's source of truth. Most
   relevant for you: the Phase 4a entry (explains how `mlTraining`
   rows are written and what they contain), the Status table to see
   what's shipped, and the "Lessons learned" section (less relevant
   to Python work but useful context).
3. **`netlify/functions/shared/prophet-layers.ts`** — specifically
   the `composeProphet` function and `BASE_WEIGHTS` constant. This is
   the hand-tuned composite scorer that you must beat. **You do not
   modify it.** You compute its information coefficient on the same
   data your models see and treat that IC as the baseline to beat.
4. **`netlify/functions/shared/backtest/engine.ts`** — where the
   `mlTraining` rows get written. Search for `mlTraining` to find
   the write site; the surrounding code shows you the schema.
5. **The actual `mlTraining` schema in Firestore** — confirm before
   training that the rows have the columns the brief expects. Use
   `firebase-admin` in Python with the service-account JSON to read a
   sample of rows and validate the schema. See "Data sanity check"
   below.

## 5. Repo orientation

```
TradeIQ/
├── briefs/phase-5a-brief.md         ← your spec
├── kickoffs/phase-5a-executor.md    ← this file
├── reports/                         ← phase-5a/findings.md goes here
│   └── phase-5a/                    ← create this
│       ├── findings.md              ← the binding deliverable
│       ├── plots/                   ← any charts go here
│       └── tables/                  ← any CSV/parquet supporting artifacts
├── scripts/
│   └── ml/                          ← NEW — your Python lives here
│       ├── pull_training_data.py    ← Firestore → local parquet
│       ├── features.py              ← feature prep + leakage prevention
│       ├── cv.py                    ← purged walk-forward CV
│       ├── models/                  ← one file per candidate model
│       ├── evaluate.py              ← IC + significance tests
│       └── report.py                ← assembles findings.md
├── .python-version                  ← "3.11"
├── pyproject.toml or requirements.txt  ← pinned deps (commit lock file)
├── .secrets/firebase-sa.json        ← gitignored; never committed
├── netlify/                         ← existing TS code; DO NOT TOUCH
├── src/                             ← existing React app; DO NOT TOUCH
└── ORCHESTRATOR.md                  ← edit at the very end to mark row done
```

Your files all live under:
- `scripts/ml/` (new directory)
- `reports/phase-5a/` (new directory)
- `pyproject.toml` OR `requirements.txt` at repo root
- `.python-version` at repo root (pinned to 3.11)
- `.gitignore` (edit to add `.secrets/`, `__pycache__/`, `*.parquet`,
  `.venv/`)
- `ORCHESTRATOR.md` (edit at the very end)
- `briefs/phase-5a-pr-description.md` (new — short PR overview)

Do NOT touch (this is enforced; PR will be rejected if you do):
- Anything under `netlify/` — that's all TypeScript and not your
  domain in this phase
- Anything under `src/` — that's the React app
- Any `*.ts`, `*.tsx`, `*.jsx`, `*.js` file anywhere
- `package.json`, `vite.config.ts`, `vitest.config.ts`, `tsconfig.json`
- `netlify.toml`
- Phase 4e-1's territory: `netlify/functions/shared/prophet-portfolio/`
  (running in parallel with you in a separate executor session)
- `src/App.jsx` (APP_VERSION stays where it is — no frontend changes
  in this phase)
- `netlify/functions/shared/model-version.ts` (MODEL_VERSION stays —
  no model deploys in 5a; 5b will bump it)

## 6. Python tooling decisions (made for you)

- **Python version:** 3.11. Pinned in `.python-version`.
- **Dependency manager:** `uv` if available (faster, modern). Plain
  `pip` with a pinned `requirements.txt` otherwise. Commit the lock
  file either way.
- **Core libraries:**
  - `firebase-admin` for Firestore reads
  - `pandas` for data wrangling
  - `numpy` for numerics
  - `scikit-learn` for the simpler models + the CV scaffolding
  - `lightgbm` for the gradient-boosted candidate
  - `statsmodels` for the rank-IC + Wilcoxon
  - `shap` for feature attribution on the winning model
  - `matplotlib` for any plots that go into `reports/phase-5a/plots/`
- **No PyTorch / TensorFlow.** This is tabular data with maybe 50k-
  500k rows; nothing in 5a needs a deep model. If you reach for one
  you've misread the brief.
- **Reproducibility:** set seeds everywhere. Random splits, model
  init, sklearn-side, lightgbm-side. Commit the seed used in
  `findings.md` so a reader can reproduce.

## 7. Operational secrets

- **Write-scoped GitHub PAT** — Chad provides in his next message.
  Use only for `git push origin phase-5a-ml-discovery` and the PR-
  open API call. Treat as a session credential; never commit.
- **Firebase service-account JSON** — Chad provides in his next
  message. REQUIRED for this phase. Write to
  `.secrets/firebase-sa.json` AFTER confirming `.secrets/` is in
  `.gitignore`. Reference path from Python via env var:
  `export GOOGLE_APPLICATION_CREDENTIALS=$(pwd)/.secrets/firebase-sa.json`
  before running anything that imports `firebase_admin`.
- **No other API keys needed.** Your work is purely against
  Firestore + local data; no Polygon, Finnhub, Quiver, or Anthropic
  calls.

If you commit a secret by accident: stop, surface to Chad immediately,
rotate the key. Do NOT try to scrub it from git history yourself —
that's a careful operation and Chad will direct.

## 8. Data sanity check — do this BEFORE writing any models

Before you build features, before you build CV, before you train
anything: read a sample of `mlTraining` rows and validate the schema
matches what the brief says. If the schema has drifted, surface to
Chad before proceeding — training against drifted data wastes a day.

```python
# scripts/ml/pull_training_data.py (rough sketch — you write the full version)
import os
import firebase_admin
from firebase_admin import credentials, firestore

cred = credentials.Certificate(os.environ["GOOGLE_APPLICATION_CREDENTIALS"])
firebase_admin.initialize_app(cred)
db = firestore.client()

# Walk backtestRuns/*/mlTraining/* with reasonable pagination
runs = db.collection("backtestRuns").stream()
for run in list(runs)[:3]:
    rows = run.reference.collection("mlTraining").limit(5).stream()
    for r in rows:
        print(r.to_dict())
```

Verify:
- Row count by run (need at least 5-10 runs × hundreds of rows each
  to have any chance of meaningful results)
- Column names match the brief
- Forward-return column is populated (not null/NaN)
- `asOfDate` is well-formed
- Layer score columns are all numeric in [0, 100]

If any of those are off, STOP and ask Chad.

## 9. The first 4 hours of your work, concretely

**Hour 1 — Read + setup.**
- Brief end-to-end (twice for the dishonesty-trap section)
- Phase 4a entry in ORCHESTRATOR
- `composeProphet` and `BASE_WEIGHTS` in `prophet-layers.ts`
- Python env: install deps, freeze lock file, commit
- Place service-account JSON, verify gitignore

**Hour 2 — Data pull + sanity check.**
- Write `pull_training_data.py`: read Firestore, write a local
  parquet of all mlTraining rows with run metadata
- Print row count, date range, distinct tickers, distinct runs
- Spot-check 20 random rows manually for obvious problems
- Commit the parquet to a gitignored local cache directory

**Hour 3 — Feature prep.**
- Write `features.py`: normalize layer scores, build any derived
  features the brief specifies, document leakage prevention checks
- This is the most important hour — leakage prevention is the heart
  of the brief

**Hour 4 — CV scaffolding.**
- Write `cv.py`: purged walk-forward CV with embargo, exactly per
  the brief's protocol
- Unit-test the CV splits with a synthetic dataset before running
  any real training — verify NO row index appears in both a fold's
  train and test sets, and verify the embargo gap is honored

After those 4 hours you have the infrastructure. Then you can train
the candidate models against the same CV, the same feature pipeline,
and the same evaluation function — apples to apples.

## 10. The binding findings report

Your `reports/phase-5a/findings.md` opens with a one-line **headline
answer**:

```
**Answer:** <YES — Model X beats composite at p < 0.05 after correction
             | NO — composite is the ceiling on this data
             | INCONCLUSIVE — need more data; here's how much>
```

Then the body covers:

1. Data summary (row count, date range, ticker coverage)
2. Methodology (CV scheme, features, models tested, evaluation metric)
3. Composite baseline: its IC on the test folds
4. Per-model results in a table with: IC, IC standard error, p-value,
   Bonferroni-corrected p-value, % of folds beating composite,
   regime-by-regime IC
5. Feature attribution on the winning model (SHAP) if YES
6. Honest discussion of limitations
7. Recommendation for Phase 5b (deploy Model X / defer ML / etc.)

**Be honest.** The brief's "dishonesty trap" section enumerates the
ways ML on financial data lies. Every one of them produces gorgeous
in-sample numbers that evaporate live. Ugly honest results are
infinitely more valuable than pretty cheating ones. Chad will read
the report carefully; padding it with optimism that the numbers don't
support means he asks you to redo the analysis.

A NO answer is a perfectly fine outcome. It tells Chad the analyst
layers themselves are the ceiling and the next research direction is
adding analysts or improving signals, not re-weighting via ML.

## 11. Opening the PR

When the branch is ready:

```bash
git push -u origin phase-5a-ml-discovery

curl -sS -X POST \
  -H "Authorization: token <PAT>" \
  -H "Accept: application/vnd.github+json" \
  https://api.github.com/repos/DavisDelivery/TradeIQ/pulls \
  -d '{
    "title": "Phase 5a — ML Training Pipeline (Discovery)",
    "head": "phase-5a-ml-discovery",
    "base": "main",
    "body": "See briefs/phase-5a-pr-description.md for full description.\n\n**Answer: <YES Model X | NO | INCONCLUSIVE>**\n\nFindings: reports/phase-5a/findings.md.\n\n[2-3 sentence summary]\n\nBranch: phase-5a-ml-discovery. APP_VERSION + MODEL_VERSION unchanged (research-only)."
  }'
```

## 12. Hand-off message when the PR is ready

Post a single message in this conversation with EXACTLY this shape:

```
PR #<N> open: https://github.com/DavisDelivery/TradeIQ/pull/<N>

Answer: <YES Model X | NO composite is ceiling | INCONCLUSIVE>

Headline numbers:
- Composite baseline IC: <X.XX> (SE <X.XX>)
- Best-model IC: <X.XX> (SE <X.XX>) — <model name>
- Wilcoxon p-value vs composite: <X.XXX>
- Bonferroni-corrected p-value (over <N> models tested): <X.XXX>
- % of CV folds where best model beats composite: <NN>%

Data:
- mlTraining rows used: <N>
- Date range: <YYYY-MM-DD> to <YYYY-MM-DD>
- Distinct tickers: <N>
- Distinct runs: <N>

Recommendation for Phase 5b: <deploy Model X | defer ML, add analysts | etc.>

Verification:
- Python pipeline runs end-to-end: yes
- CV leakage tests pass: yes
- Report committed: reports/phase-5a/findings.md
- TypeScript baseline still passes (`npm test`): 446
```

That's the message. Don't recap the brief. Don't propose phases
beyond 5b. The numbers speak.

## 13. Failure modes to avoid (these are common; read them)

- **k-fold CV on time-series data.** Leakage from future rows into
  past training folds. Use purged walk-forward CV with embargo, exactly
  as the brief specifies. The unit tests in your `cv.py` exist to catch
  this — make them strict.
- **Hyperparameter search on the same data as the final evaluation.**
  In-sample IC reported as out-of-sample. Use nested CV or hold out
  a final test set the hyperparameter search never sees.
- **Cherry-picking the time window.** "The model works in 2020-2023"
  with no explanation for why 2018 and 2024 were excluded. Either run
  on all available data or justify the exclusion in the report.
- **Multiple-testing without correction.** Training 50 model variants,
  picking the one with highest IC, and reporting it as a win is just
  reporting random noise. Bonferroni correction is in the brief for
  a reason; apply it.
- **Reporting only the winning regime.** "Model 3 IC=0.08 in
  bull_low_vol" without comparable results for other regimes. Show
  the full regime breakdown.
- **Omitting the composite baseline.** A model IC of 0.05 is great
  unless the composite scorer on the same data has IC 0.06, in which
  case the model is strictly worse. Always report both.
- **Adding any model in the live scorer.** That's Phase 5b, not 5a.
  5a is research; no model goes anywhere near production.

## 14. If you get stuck

Ask Chad ONE targeted question with two concrete options:

```
Blocked on: <one sentence>

Option A: <concrete path forward>
Option B: <concrete alternative>

My recommendation: <A or B and one-sentence reason>
```

Don't ask "what should I do." Don't ask Chad to explain ML concepts
or re-summarize the brief. Don't post a wall of exploration.

## 15. Parallel-context note

Phase 4e-1 is running in a separate executor session in parallel with
you. They are building a paper-portfolio engine in TypeScript that
uses Prophet's composite scoring as the ranking signal — with a
pluggable interface so that whatever Phase 5b deploys (if your
findings recommend YES) can later plug in behind the same interface.

You do not touch their files. They do not touch yours. If your
findings recommend a model, Phase 5b is the bridge between your
Python work and their TypeScript portfolio engine — but 5b is a
future phase with its own brief. Don't write any bridge code in 5a.

---

End of kickoff. Read `briefs/phase-5a-brief.md` — especially the
"dishonesty trap" section — then run the data sanity check before
anything else.
