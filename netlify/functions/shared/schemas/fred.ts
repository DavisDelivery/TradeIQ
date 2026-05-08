// FRED (Federal Reserve Economic Data) schemas.
//
// Single endpoint hit:
//   - /series/observations
//
// FRED returns observations as `{ value: string }` — strings, not numbers.
// The "missing observation" sentinel is the literal "." which downstream
// code filters explicitly. We model `value` as a string here (since that's
// what the wire ships) and let the provider parse + filter.

import { z } from 'zod';

export const FredObservationSchema = z.object({
  date: z.string(),                          // YYYY-MM-DD
  value: z.string(),                          // string; '.' means missing
  realtime_start: z.string().optional(),
  realtime_end: z.string().optional(),
}).passthrough();

export const FredObservationsResponseSchema = z.object({
  realtime_start: z.string().optional(),
  realtime_end: z.string().optional(),
  observation_start: z.string().optional(),
  observation_end: z.string().optional(),
  units: z.string().optional(),
  output_type: z.number().optional(),
  file_type: z.string().optional(),
  order_by: z.string().optional(),
  sort_order: z.string().optional(),
  count: z.number().optional(),
  offset: z.number().optional(),
  limit: z.number().optional(),
  observations: z.array(FredObservationSchema).optional().default([]),
}).passthrough();

export type FredObservation = z.infer<typeof FredObservationSchema>;
export type FredObservationsResponse = z.infer<typeof FredObservationsResponseSchema>;
