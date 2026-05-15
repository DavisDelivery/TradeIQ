// Phase 4f — weekly cron that fires the broader stub-analyst audit
// covering all 4 quadrants (Target + Prophet × largecap + russell2k).
//
// Schedule: 0 19 * * 0  (Sunday 19:00 UTC, an hour after the existing
// Prophet-only cron from PR #23). One-hour offset to avoid hitting
// Firestore at the same time.
//
// The audit endpoint writes its result to `stubAudits/runs/{stamp}`;
// future Phase 4f follow-up reads the latest row to populate
// `reports/phase-4f/audit.md` § 1.

import { schedule } from '@netlify/functions';
import { logger } from './shared/logger';

export const handler = schedule('0 19 * * 0', async () => {
  const log = logger.child({ fn: 'scan-stub-audit-cron' });
  const origin = process.env.URL ?? 'https://tradeiq-alpha.netlify.app';
  const url = `${origin}/.netlify/functions/audit-stub-analysts?days=30&board=both&universe=both`;
  try {
    const res = await fetch(url);
    log.info('audit_cron_dispatched', { status: res.status });
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
