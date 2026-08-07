// TICKER-1 — structural guard: surfaces the 2026-08-06 five-agent audit
// found DEAD must stay converted. This is deliberately a list of exact
// call-site patterns, not a heuristic: a heuristic that guesses "is this
// span a ticker?" would drown in false positives, but a converted surface
// regressing to a bare span is exactly detectable.
//
// If you are here because this test failed: you replaced a <Ticker> with
// plain text somewhere the owner explicitly asked to be tappable. Put the
// primitive back, or — if the surface is genuinely being removed — delete
// its row here in the same commit and say so.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const MUST_USE_TICKER = [
  // file, minimum <Ticker occurrences, note
  ['src/HistoryView.jsx', 1, 'snapshot replay ticker column'],
  // TrendExposureView.jsx removed 2026-08-07 — the trend-exposure endpoint was
  // retired (netlify/functions-retired/README.md) and the view deleted with it.
  ['src/ForwardTestView.jsx', 1, 'pick log'],
  ['src/EngineTestView.jsx', 2, 'result hero + sector ETF grid'],
  ['src/VectorView.jsx', 1, 'evaluator hero'],
  ['src/ChartView.jsx', 1, 'signal header hero'],
  ['src/RegimeView.jsx', 2, 'SPY / TLT trend label'],
  ['src/DeskView.jsx', 1, 'focus-pane header'],
  ['src/TridentView.jsx', 2, 'company name + regime-card ETF'],
  ['src/FableView.jsx', 1, 'company name'],
  ['src/ProphetView.jsx', 1, 'company name'],
  ['src/CatalystView.jsx', 1, 'company name'],
  ['src/components/desk/WatchlistPanel.jsx', 1, 'row symbol'],
  ['src/components/desk/PositionsPanel.jsx', 1, 'row symbol'],
  ['src/components/desk/EarningsRadarPanel.jsx', 1, 'row symbol'],
  ['src/components/desk/TapeStrip.jsx', 1, 'index tape'],
  ['src/components/desk/DossierTabs.jsx', 1, 'dossier header symbol'],
  ['src/components/StopBreachBanner.jsx', 1, 'breaching symbols'],
  ['src/components/TradeQueuePanel.jsx', 1, 'queue row symbol'],
  ['src/components/TopTradesTable.jsx', 1, 'attribution rows'],
  ['src/components/detail/RelativeStrengthChart.jsx', 2, 'peer SPY + sector ETF'],
];

describe('every audited ticker surface uses the primitive', () => {
  for (const [file, min, note] of MUST_USE_TICKER) {
    it(`${file} — ${note}`, () => {
      const src = readFileSync(file, 'utf8');
      const uses = (src.match(/<Ticker[\s>]/g) || []).length;
      expect(uses, `${file} should render >=${min} <Ticker> (${note})`).toBeGreaterThanOrEqual(min);
    });
  }

  it('FundamentalsStrip is never rendered inert on a board surface', () => {
    // showExpandIcon={false} with no onExpand = a strip the user cannot tap.
    // The audit found three of these; zero is the standing state.
    const files = [
      'src/CatalystView.jsx', 'src/InsiderBoardView.jsx', 'src/EarningsView.jsx',
      'src/SentimentView.jsx', 'src/OptionsFlowView.jsx', 'src/JournalView.jsx',
    ];
    const offenders = [];
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      for (const m of src.matchAll(/<FundamentalsStrip[^/>]*\/>/gs)) {
        if (!m[0].includes('onExpand')) offenders.push(`${f}: ${m[0].slice(0, 80)}`);
      }
    }
    expect(offenders.join('\n')).toBe('');
  });
});
