// Synthetic Bar fixtures for prophet-layers unit tests.
//
// Each builder returns a deterministic Bar[] of the requested length so
// tests can assert specific layer behaviours (uptrend → high momentum,
// chop → low RS, etc.) without pulling Polygon data.

import type { Bar } from '../../shared/data-provider';

interface BuilderOpts {
  length?: number;
  startPrice?: number;
  startTs?: number;  // unix ms of first bar
  baseVol?: number;
}

function* tsGen(startTs: number) {
  let t = startTs;
  while (true) {
    yield t;
    t += 86_400_000;  // 1 trading day
  }
}

function bar(t: number, c: number, vol: number, range = 0.01): Bar {
  const r = c * range;
  return {
    t,
    o: c - r * 0.3,
    h: c + r,
    l: c - r,
    c,
    v: Math.round(vol),
  };
}

// Clean uptrend: small daily drift up, mild noise, rising volume.
export function uptrend(opts: BuilderOpts = {}): Bar[] {
  const length = opts.length ?? 260;
  const start = opts.startPrice ?? 100;
  const baseVol = opts.baseVol ?? 1_000_000;
  const ts = tsGen(opts.startTs ?? Date.parse('2024-01-02') - length * 86_400_000);
  const out: Bar[] = [];
  for (let i = 0; i < length; i++) {
    const drift = 1 + 0.0035;
    const noise = 1 + (Math.sin(i * 0.7) * 0.004);
    const c = start * Math.pow(drift, i) * noise;
    const v = baseVol * (1 + i / length * 0.5);
    out.push(bar(ts.next().value as number, +c.toFixed(2), v));
  }
  return out;
}

// Clean downtrend: small daily drift down, mild noise.
export function downtrend(opts: BuilderOpts = {}): Bar[] {
  const length = opts.length ?? 260;
  const start = opts.startPrice ?? 100;
  const baseVol = opts.baseVol ?? 1_000_000;
  const ts = tsGen(opts.startTs ?? Date.parse('2024-01-02') - length * 86_400_000);
  const out: Bar[] = [];
  for (let i = 0; i < length; i++) {
    const drift = 1 - 0.003;
    const noise = 1 + (Math.sin(i * 0.7) * 0.004);
    const c = start * Math.pow(drift, i) * noise;
    const v = baseVol;
    out.push(bar(ts.next().value as number, +c.toFixed(2), v));
  }
  return out;
}

// Tight chop: oscillates in a narrow band, no trend.
export function chop(opts: BuilderOpts = {}): Bar[] {
  const length = opts.length ?? 260;
  const start = opts.startPrice ?? 100;
  const baseVol = opts.baseVol ?? 1_000_000;
  const ts = tsGen(opts.startTs ?? Date.parse('2024-01-02') - length * 86_400_000);
  const out: Bar[] = [];
  for (let i = 0; i < length; i++) {
    const c = start * (1 + Math.sin(i * 0.4) * 0.015);
    out.push(bar(ts.next().value as number, +c.toFixed(2), baseVol, 0.005));
  }
  return out;
}

// Low-vol grind: very tight range, low ATR.
export function lowVolGrind(opts: BuilderOpts = {}): Bar[] {
  const length = opts.length ?? 260;
  const start = opts.startPrice ?? 100;
  const baseVol = opts.baseVol ?? 1_000_000;
  const ts = tsGen(opts.startTs ?? Date.parse('2024-01-02') - length * 86_400_000);
  const out: Bar[] = [];
  for (let i = 0; i < length; i++) {
    const c = start * (1 + 0.0008 * i + Math.sin(i * 0.3) * 0.002);
    out.push(bar(ts.next().value as number, +c.toFixed(2), baseVol, 0.002));
  }
  return out;
}

// High-vol regime: large daily swings.
export function highVol(opts: BuilderOpts = {}): Bar[] {
  const length = opts.length ?? 260;
  const start = opts.startPrice ?? 100;
  const baseVol = opts.baseVol ?? 1_500_000;
  const ts = tsGen(opts.startTs ?? Date.parse('2024-01-02') - length * 86_400_000);
  const out: Bar[] = [];
  for (let i = 0; i < length; i++) {
    const c = start * (1 + Math.sin(i * 1.3) * 0.05 + Math.cos(i * 0.7) * 0.04);
    out.push(bar(ts.next().value as number, +c.toFixed(2), baseVol, 0.04));
  }
  return out;
}

// Breakout: chop for first ~95% of bars, then sharp 5-day surge with
// volume spikes well above the 20-day average. Designed so avgVol20
// (the layer's reference) doesn't get dragged up by the surge itself.
export function breakout(opts: BuilderOpts = {}): Bar[] {
  const length = opts.length ?? 260;
  const start = opts.startPrice ?? 100;
  const baseVol = opts.baseVol ?? 1_000_000;
  const ts = tsGen(opts.startTs ?? Date.parse('2024-01-02') - length * 86_400_000);
  const out: Bar[] = [];
  const breakIdx = length - 5;
  for (let i = 0; i < length; i++) {
    let c: number;
    let v: number;
    if (i < breakIdx) {
      c = start * (1 + Math.sin(i * 0.3) * 0.01);
      v = baseVol;
    } else {
      const k = i - breakIdx;
      // 2.5% per day, 4× volume — well above surge thresholds (1.5%, 1.5×)
      c = start * Math.pow(1.025, k + 1);
      v = baseVol * 4;
    }
    out.push(bar(ts.next().value as number, +c.toFixed(2), v));
  }
  return out;
}
