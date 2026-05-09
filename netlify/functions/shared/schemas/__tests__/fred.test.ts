import { describe, it, expect } from 'vitest';
import { FredObservationsResponseSchema } from '../fred';

const fredFixture = {
  realtime_start: '2024-10-30',
  realtime_end: '2024-10-30',
  observation_start: '1776-07-04',
  observation_end: '9999-12-31',
  units: 'lin',
  output_type: 1,
  file_type: 'json',
  order_by: 'observation_date',
  sort_order: 'desc',
  count: 12345,
  offset: 0,
  limit: 10,
  observations: [
    { realtime_start: '2024-10-30', realtime_end: '2024-10-30', date: '2024-10-29', value: '20.33' },
    { realtime_start: '2024-10-30', realtime_end: '2024-10-30', date: '2024-10-28', value: '19.80' },
    { realtime_start: '2024-10-30', realtime_end: '2024-10-30', date: '2024-10-27', value: '.' },
    { realtime_start: '2024-10-30', realtime_end: '2024-10-30', date: '2024-10-26', value: '21.05' },
  ],
};

describe('FredObservationsResponseSchema', () => {
  it('parses a real FRED observations response', () => {
    const parsed = FredObservationsResponseSchema.safeParse(fredFixture);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.observations).toHaveLength(4);
      expect(parsed.data.observations?.[0].value).toBe('20.33');
    }
  });

  it('preserves the "." sentinel as a string (downstream filters it)', () => {
    const parsed = FredObservationsResponseSchema.safeParse(fredFixture);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      const missing = parsed.data.observations?.find((o) => o.value === '.');
      expect(missing).toBeDefined();
    }
  });

  it('defaults observations to [] when missing', () => {
    const parsed = FredObservationsResponseSchema.safeParse({ count: 0 });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.observations).toEqual([]);
  });

  it('passes through unknown top-level fields', () => {
    const parsed = FredObservationsResponseSchema.safeParse({
      ...fredFixture,
      vintage_dates: ['2024-10-30'],
      response_id: 'fred-xyz',
    });
    expect(parsed.success).toBe(true);
  });

  it('passes through unknown observation fields', () => {
    const parsed = FredObservationsResponseSchema.safeParse({
      observations: [{ date: '2024-10-29', value: '20.33', new_field: 'x' }],
    });
    expect(parsed.success).toBe(true);
  });

  it('fails when an observation is missing the date field (drift detection)', () => {
    const parsed = FredObservationsResponseSchema.safeParse({
      observations: [{ value: '20.33' }],
    });
    expect(parsed.success).toBe(false);
  });

  it('fails when value is sent as a number instead of string', () => {
    // FRED has shipped strings here for the entire history of the API; if
    // they ever switch to numbers we want a loud signal.
    const parsed = FredObservationsResponseSchema.safeParse({
      observations: [{ date: '2024-10-29', value: 20.33 }],
    });
    expect(parsed.success).toBe(false);
  });
});
