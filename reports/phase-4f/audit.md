# Phase 4f — Stub-Analyst Audit

**Generated:** 2026-05-15T10:23:04.637Z
**Sample window:** last 30 days

Total analysts/layers reviewed: 24 (across 4 quadrants)
Live: 14
Stub: 5
Degraded: 5

**Stub list:**
- target-board × russell2k: earnings-analyst
- target-board × russell2k: insider-analyst
- target-board × russell2k: macro-regime
- target-board × russell2k: patent-analyst
- target-board × russell2k: political-analyst

---

### Target Board — largecap

Snapshots scanned: 0.  Observations: 0.  Verdicts: 0 live · 0 stub · 0 degraded.

| Analyst/Layer        |     Mean |    StDev | % exactly 50 |  % null | % pass=false | Uniq scores | Verdict |
|----------------------|---------:|---------:|-------------:|--------:|-------------:|------------:|---------|

### Target Board — russell2k

Snapshots scanned: 19.  Observations: 36000.  Verdicts: 2 live · 5 stub · 3 degraded.

| Analyst/Layer        |     Mean |    StDev | % exactly 50 |  % null | % pass=false | Uniq scores | Verdict |
|----------------------|---------:|---------:|-------------:|--------:|-------------:|------------:|---------|
| earnings-analyst     |    50.06 |     0.98 |        98.89 |    0.00 |         0.00 |           6 | stub |
| flow-analyst         |    54.41 |     3.93 |         7.44 |    0.00 |         0.00 |          22 | degraded |
| fundamental-analyst  |    55.32 |    16.79 |         8.33 |    0.00 |         0.00 |          43 | live |
| insider-analyst      |    50.02 |     1.97 |        99.00 |    0.00 |         0.00 |           9 | stub |
| macro-regime         |    50.00 |     0.00 |       100.00 |    0.00 |         0.00 |           1 | stub |
| news-sentiment       |    54.85 |    12.52 |        47.50 |    0.00 |         0.00 |          37 | degraded |
| patent-analyst       |    50.00 |     0.00 |       100.00 |    0.00 |         0.00 |           1 | stub |
| political-analyst    |    50.01 |     1.51 |        98.53 |    0.00 |         0.00 |           7 | stub |
| sector-rotation      |    64.51 |    14.47 |         2.47 |    0.00 |         0.00 |          51 | live |
| technical-analyst    |    71.24 |     3.20 |         0.00 |    0.00 |         0.00 |          18 | degraded |

### Prophet — largecap

Snapshots scanned: 42.  Observations: 4942.  Verdicts: 6 live · 0 stub · 1 degraded.

| Analyst/Layer        |     Mean |    StDev | % exactly 50 |  % null | % pass=false | Uniq scores | Verdict |
|----------------------|---------:|---------:|-------------:|--------:|-------------:|------------:|---------|
| catalyst             |    36.17 |     4.84 |         0.00 |    0.00 |        93.06 |          24 | degraded |
| fundamental          |    53.42 |    19.12 |         0.99 |    0.00 |        11.19 |          44 | live |
| momentum             |    57.27 |     9.41 |        18.27 |    0.00 |        16.29 |          13 | live |
| relativeStrength     |    97.28 |     6.17 |         0.00 |    0.00 |         6.09 |          13 | live |
| structure            |    82.05 |    12.29 |         0.00 |    0.00 |        24.79 |          13 | live |
| volatility           |    60.11 |    13.10 |        10.20 |    0.00 |        13.03 |           7 | live |
| volume               |    67.58 |     9.43 |         0.14 |    0.00 |         0.71 |          10 | live |

### Prophet — russell2k

Snapshots scanned: 3.  Observations: 2282.  Verdicts: 6 live · 0 stub · 1 degraded.

| Analyst/Layer        |     Mean |    StDev | % exactly 50 |  % null | % pass=false | Uniq scores | Verdict |
|----------------------|---------:|---------:|-------------:|--------:|-------------:|------------:|---------|
| catalyst             |    29.08 |     6.48 |         0.00 |    0.00 |        98.77 |          11 | live |
| fundamental          |    42.14 |    21.16 |         4.29 |    0.00 |         7.06 |          47 | live |
| momentum             |    60.94 |    11.77 |         7.36 |    0.00 |        11.66 |          16 | live |
| relativeStrength     |    95.57 |     8.83 |         0.00 |    0.00 |         2.15 |          20 | live |
| structure            |    78.80 |    12.81 |         1.84 |    0.00 |        51.84 |          21 | live |
| volatility           |    61.03 |    16.98 |        34.66 |    0.00 |         9.20 |          10 | degraded |
| volume               |    67.66 |     9.52 |         5.83 |    0.00 |         0.92 |          11 | live |

---

## Next step — root-cause classification (W2)

For each stub above, follow the taxonomy in `kickoffs/phase-4f-executor.md` § 4.2 and write a per-stub diagnosis section into `reports/phase-4f/audit.md` § 2 (template at kickoff § 4.3). Then act on each in W3 (repair) or W5 (remove + reweight).
