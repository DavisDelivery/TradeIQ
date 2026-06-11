// Wave 4D (code-review-2026-06 m9) — History header formatting guards.
//
// 1. `(snapshot.scanDurationMs / 1000).toFixed(1)` rendered "NaNs" when
//    the field was absent; formatScanDuration must guard to '—'.
// 2. formatAge rounded to hours, so a 20-minute-old snapshot read
//    "0h ago"; under an hour it must show minutes.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { formatAge, formatScanDuration } from '../HistoryView.jsx';

describe('formatScanDuration', () => {
  it('formats milliseconds as seconds with one decimal', () => {
    expect(formatScanDuration(12_340)).toBe('12.3s');
    expect(formatScanDuration(0)).toBe('0.0s');
  });

  it('guards absent / non-finite values to an em-dash (regression: "NaNs")', () => {
    expect(formatScanDuration(undefined)).toBe('—');
    expect(formatScanDuration(null)).toBe('—');
    expect(formatScanDuration(NaN)).toBe('—');
    expect(formatScanDuration('12')).toBe('—');
  });
});

describe('formatAge', () => {
  const NOW = new Date('2026-06-11T12:00:00.000Z').getTime();

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function isoAgo(ms) {
    return new Date(NOW - ms).toISOString();
  }

  it('shows minutes under an hour (regression: 20 min read "0h ago")', () => {
    expect(formatAge(isoAgo(20 * 60_000))).toBe('20m ago');
    expect(formatAge(isoAgo(59 * 60_000))).toBe('59m ago');
  });

  it('shows hours from 1h up to a day', () => {
    expect(formatAge(isoAgo(60 * 60_000))).toBe('1h ago');
    expect(formatAge(isoAgo(5 * 3_600_000))).toBe('5h ago');
  });

  it('shows days beyond 24h', () => {
    expect(formatAge(isoAgo(48 * 3_600_000))).toBe('2d ago');
  });

  it('returns empty string for missing input', () => {
    expect(formatAge(null)).toBe('');
    expect(formatAge(undefined)).toBe('');
  });
});
