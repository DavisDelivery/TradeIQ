# Retired scheduled scans

Cron TRIGGER functions for boards retired on 2026-08-06 (owner decision,
AUDIT-1 evidence — see reports/research-2026-08/board-trust-audit.md):

  williams (−73.4pp vs SPY) · lynch (−101.0pp) · target (−74.2pp, IC<0)
  fable (−73.4pp; top-5 worse at −104pp) · sentiment (coincident signal,
  −1.68pp forward alpha) · trend (failed placebo — attribution tab only,
  which never had a scan)

And on 2026-08-07, the last one:

  prophet — retired UNMEASURED. Its only positive number was an artifact
  (one basket bought on day one, never rebalanced, all-cash years counted
  as rolling wins). Three attempts at a valid measurement died in the
  engine's self-reinvoke chain: dispatch returns HTTP 202 and the next
  invocation never lands, reproducible at batchSize 8 and 2. Live forward
  alpha −2.87pp at a 26% win rate. Prophet carried the heaviest cron
  footprint in the app — 8 scheduled functions including the portfolio
  backtest cron that produced 20 consecutive all-cash runs.

No ranking board remains in the app.

This directory is NOT bundled by Netlify, so the schedules stop firing —
which is the point: williams alone scanned every 30 minutes across four
universes during market hours for a board measured 73 points behind SPY.
The -background workers stay in netlify/functions/, dormant: they only run
when POSTed, so the boards' read endpoints and history remain intact.

To revive a board: move its scan-*.ts triggers back into
netlify/functions/, re-add its VIEWS entry and router branch in
src/App.jsx, and deploy. Nothing else was removed.
