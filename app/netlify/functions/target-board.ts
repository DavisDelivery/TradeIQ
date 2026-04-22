// Target board — stub returning placeholder data so frontend loads.
// TODO(next-session): wire actual analyst pipeline, ingest real market data,
// apply macro regime multiplier, compute composite scores.

import type { Handler } from '@netlify/functions';
import { blobGet, todayKey } from './shared/blobs';
import type { TargetBoard } from './shared/types';

export const handler: Handler = async () => {
  // Try to serve today's persisted board if available
  const cached = await blobGet<TargetBoard>('targetboard', todayKey());
  if (cached) {
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(cached),
    };
  }

  // Placeholder scaffold so the frontend renders something. Replace with real pipeline output.
  const placeholder: TargetBoard = {
    regime: {
      regime: 'risk_on',
      vix: 13.8,
      yield10y: 4.12,
      spread2s10s: 22,
      updatedAt: new Date().toISOString(),
    },
    candidates: [],
    generatedAt: new Date().toISOString(),
    schemaVersion: 2,
  };

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(placeholder),
  };
};
