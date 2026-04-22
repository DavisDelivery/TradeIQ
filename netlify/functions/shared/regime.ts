// Macro regime — pulls real VIX + treasuries from FRED, classifies + builds Regime object
// matching v1's MOCK_REGIME shape exactly.

import { getMacroData } from './data-provider';
import type { Regime } from './types';

export async function computeRegime(): Promise<Regime> {
  const m = await getMacroData();
  const vix = m.vix ?? 18;
  const y10 = m.yield10y ?? 4.1;
  const spread = m.spread2s10sBps ?? 0;

  // VIX regime + trend
  const vixRegime: 'low' | 'medium' | 'high' = vix < 15 ? 'low' : vix > 22 ? 'high' : 'medium';
  let vixTrend: 'rising' | 'falling' | 'stable' = 'stable';
  if (m.vixHistory && m.vixHistory.length >= 20) {
    const recent = m.vixHistory.slice(-5).reduce((s, x) => s + x.value, 0) / 5;
    const prior = m.vixHistory.slice(-20, -15).reduce((s, x) => s + x.value, 0) / 5;
    if (recent > prior * 1.1) vixTrend = 'rising';
    else if (recent < prior * 0.9) vixTrend = 'falling';
  }
  const vixPercentile = vixPercentileHist(m.vixHistory ?? [], vix);

  const curveRegime: 'normal' | 'flat' | 'inverted' =
    spread > 50 ? 'normal' : spread < 0 ? 'inverted' : 'flat';

  // Overall regime
  let regime: 'risk_on' | 'risk_off' | 'neutral' = 'neutral';
  let conviction: 'high' | 'medium' | 'low' = 'medium';

  if (vixRegime === 'low' && curveRegime !== 'inverted' && vixTrend !== 'rising') {
    regime = 'risk_on';
    conviction = vixPercentile < 25 ? 'high' : 'medium';
  } else if (vixRegime === 'high' || (curveRegime === 'inverted' && vixTrend === 'rising')) {
    regime = 'risk_off';
    conviction = vix > 28 ? 'high' : 'medium';
  }

  const ratioTrend = regime === 'risk_on' ? 'risk_on_rising' : regime === 'risk_off' ? 'risk_off_rising' : 'neutral';
  const creditSignal = regime === 'risk_on' ? 'tightening_spreads' : regime === 'risk_off' ? 'widening_spreads' : 'stable_spreads';

  const rationale = `${regime === 'risk_on' ? 'Risk-on' : regime === 'risk_off' ? 'Risk-off' : 'Neutral'} regime (${conviction}): VIX ${vix.toFixed(1)} (${vixRegime}, ${vixTrend}), 2y10y ${curveRegime} ${spread}bp, ${ratioTrend.replace(/_/g, ' ')}, ${creditSignal.replace(/_/g, ' ')}`;

  return {
    regime,
    conviction,
    vol: { level: +vix.toFixed(2), regime: vixRegime, trend: vixTrend, percentile: vixPercentile },
    rates: { tenYear: +y10.toFixed(2), twoTenSpread: spread, curveRegime, trend: 'stable' },
    riskAppetite: { ratioTrend, creditSignal },
    rationale,
    computedAt: new Date().toISOString(),
  };
}

export function regimeToMacroBias(regime: Regime): number {
  // Convert regime to -1..+1 score for analyst composite
  if (regime.regime === 'risk_on') return regime.conviction === 'high' ? 0.6 : 0.3;
  if (regime.regime === 'risk_off') return regime.conviction === 'high' ? -0.6 : -0.3;
  return 0;
}

function vixPercentileHist(history: Array<{ date: string; value: number }>, current: number): number {
  if (history.length < 10) return 50;
  const below = history.filter((h) => h.value < current).length;
  return Math.round((below / history.length) * 100);
}
