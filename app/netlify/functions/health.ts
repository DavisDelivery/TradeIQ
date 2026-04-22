import type { Handler } from '@netlify/functions';

export const handler: Handler = async () => {
  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      status: 'ok',
      version: '0.2.0-alpha',
      timestamp: new Date().toISOString(),
      features: {
        claudePm: true,
        arbitrator: true,
        earningsInterpreter: true,
        regimeNarrative: true,
      },
    }),
  };
};
