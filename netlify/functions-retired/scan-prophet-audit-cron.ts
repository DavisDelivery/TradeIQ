// Phase 4e-1 follow-up — weekly Prophet layer audit cron.
//
// Schedule: 0 18 * * 0  (Sunday 18:00 UTC, weekly).
//
// Hits the audit-prophet-layers endpoint over HTTP so the audit
// archive (`prophetPortfolio/audits/runs/{stamp}`) gets a fresh row
// every week. The /api/portfolio-verdict endpoint reads the latest
// archive entry to populate § 0 of the verdict.

import { schedule } from '@netlify/functions';
import { logger } from './shared/logger';

export const handler = schedule('0 18 * * 0', async () => {
  const log = logger.child({ fn: 'scan-prophet-audit-cron' });
  const origin = process.env.URL ?? 'https://tradeiq-alpha.netlify.app';
  const url = `${origin}/.netlify/functions/audit-prophet-layers?days=30&universe=largecap`;

  try {
    const res = await fetch(url);
    const ok = res.status === 200;
    log.info('audit_cron_dispatched', { status: res.status, ok });
    return {
      statusCode: 200,
      body: JSON.stringify({ ok: true, auditStatus: res.status }),
    };
  } catch (err: any) {
    log.error('audit_cron_failed', { err: String(err?.message ?? err) });
    return {
      statusCode: 500,
      body: JSON.stringify({ ok: false, error: String(err?.message ?? err) }),
    };
  }
});
