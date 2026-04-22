import type { Bar } from '../shared/data-provider';
import type { AnalystOutput, Direction } from '../shared/types';

export function runSectorRotation(
  bars: Bar[],
  sectorEtfBars: Bar[],
  spyBars: Bar[],
  sectorName: string,
): AnalystOutput {
  if (bars.length < 40 || sectorEtfBars.length < 40 || spyBars.length < 40) {
    return { score: 50, direction: 'neutral', confidence: 0, rationale: 'insufficient history', signals: {} };
  }

  const rs20 = rel(bars, sectorEtfBars, 20);
  const rs60 = rel(bars, sectorEtfBars, 60);
  const sec20 = rel(sectorEtfBars, spyBars, 20);
  const sec60 = rel(sectorEtfBars, spyBars, 60);
  const abs20 = rel(bars, spyBars, 20);
  const abs60 = rel(bars, spyBars, 60);

  let raw = rs20 * 60 + rs60 * 30 + sec20 * 40 + sec60 * 20 + abs20 * 75 + abs60 * 35;

  // head-fake penalty: strong RS vs sector but sector is lagging → single-name story, de-rate
  if (rs20 > 0.02 && sec20 < -0.01) raw *= 0.5;
  if (rs20 < -0.02 && sec20 > 0.01) raw *= 0.5;

  raw = clamp(raw, -100, 100);
  const direction: Direction = raw > 10 ? 'long' : raw < -10 ? 'short' : 'neutral';
  const score = Math.round(50 + raw / 2);

  const parts: string[] = [];
  if (abs20 > 0.03) parts.push(`leading SPY +${(abs20 * 100).toFixed(1)}% 20d`);
  else if (abs20 < -0.03) parts.push(`lagging SPY ${(abs20 * 100).toFixed(1)}% 20d`);
  if (sec20 > 0.02 && rs20 > 0.01) parts.push(`${sectorName} winning sector, name leading`);
  else if (sec20 > 0.02) parts.push(`${sectorName} sector bid`);
  else if (sec20 < -0.02) parts.push(`${sectorName} sector weak`);

  return {
    score,
    direction,
    confidence: Math.min(1, (Math.abs(abs20) + Math.abs(rs20)) * 4),
    rationale: parts.join(', ') || 'neutral rotation',
    signals: {
      rsVsSector20d: +(rs20 * 100).toFixed(2),
      rsVsSector60d: +(rs60 * 100).toFixed(2),
      sectorVsSpy20d: +(sec20 * 100).toFixed(2),
      vsSpy20d: +(abs20 * 100).toFixed(2),
      vsSpy60d: +(abs60 * 100).toFixed(2),
      sector: sectorName,
    },
  };
}

function rel(a: Bar[], b: Bar[], look: number): number {
  if (a.length <= look || b.length <= look) return 0;
  const aR = a.at(-1)!.c / a[a.length - 1 - look].c - 1;
  const bR = b.at(-1)!.c / b[b.length - 1 - look].c - 1;
  return aR - bR;
}
function clamp(x: number, lo: number, hi: number): number { return Math.max(lo, Math.min(hi, x)); }
