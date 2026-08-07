# Retired scheduled scans

Cron TRIGGER functions for boards retired on 2026-08-06 (owner decision,
AUDIT-1 evidence — see reports/research-2026-08/board-trust-audit.md):

  williams (−73.4pp vs SPY) · lynch (−101.0pp) · target (−74.2pp, IC<0)
  fable (−73.4pp; top-5 worse at −104pp) · sentiment (coincident signal,
  −1.68pp forward alpha) · trend (failed placebo — attribution tab only,
  which never had a scan)

## 2026-08-07 — trend-exposure, the endpoint

`trend-exposure.ts` joins them. The 2026-08-06 pass retired the trend BOARD
(nav entry + router branch) but deliberately left this read endpoint live for
one-PR revival. It is now unwired: the `/api/trend-exposure` redirect and its
`timeout = 26` are gone from netlify.toml, and the frontend that called it
(`TrendExposureView.jsx`, `useTrendExposure.js`, their test, and the
`trendExposure` query key and response shape) is deleted.

`shared/trend-exposure.ts` STAYS in netlify/functions/shared/ and is not
retired — it is a live dependency of `camillo-research.ts` and of the
`trend-scanner` detect pass, both of which use its `resolveArticle` and
`fetchPageviews`. Only the HTTP surface is retired, not the EDGAR/Wikipedia
primitives underneath it.

To revive: move `trend-exposure.ts` back into netlify/functions/, restore the
redirect and timeout stanza, and restore the view + hook from git history.

---

This directory is NOT bundled by Netlify, so the schedules stop firing —
which is the point: williams alone scanned every 30 minutes across four
universes during market hours for a board measured 73 points behind SPY.
The -background workers stay in netlify/functions/, dormant: they only run
when POSTed, so the boards' read endpoints and history remain intact.

To revive a board: move its scan-*.ts triggers back into
netlify/functions/, re-add its VIEWS entry and router branch in
src/App.jsx, and deploy. Nothing else was removed.
