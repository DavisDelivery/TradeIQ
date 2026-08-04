// GET /api/camillo-research?ticker=CROX[&universe=russell2k][&force=1]
//
// Runs the Camillo judgment pass on one name: gathers what the app knows,
// then has the model answer product / trend / materiality / discovery and
// name the falsifier.
//
// Model: Opus 5 by default, with a single fallback to the model version
// already proven in this repo if the account cannot serve it. Which one
// actually answered is reported in the payload — a silent downgrade would
// be a lie about what produced the read.

import type { Handler } from '@netlify/functions';
import { BudgetExhaustedError, CircuitOpenError, callAnthropic } from './shared/anthropic-client';
import { SYSTEM_PROMPT, gatherEvidence, parseRead, renderEvidence } from './shared/camillo-research';
import { logger } from './shared/logger';

const log = logger.child({ fn: 'camillo-research' });

const PRIMARY_MODEL = process.env.CAMILLO_MODEL ?? 'claude-opus-5';
/** Known-good in this repo (narrative-generator.ts) — used only if primary is unavailable. */
const FALLBACK_MODEL = 'claude-opus-4-8';

const TICKER_RE = /^[A-Z][A-Z0-9.\-]{0,9}$/;

function json(status: number, body: unknown) {
  return {
    statusCode: status,
    headers: { 'content-type': 'application/json', 'cache-control': 'private, no-store' },
    body: JSON.stringify(body),
  };
}

/** True for the error shape an account gets when a model id is not available. */
function isModelUnavailable(err: any): boolean {
  const s = String(err?.message ?? err);
  return /model/i.test(s) && /(not_found|not found|invalid|does not exist|404|400)/i.test(s);
}

export const handler: Handler = async (event) => {
  const start = Date.now();
  const qp = event.queryStringParameters ?? {};
  const ticker = (qp.ticker ?? '').trim().toUpperCase();
  const universe = qp.universe === 'sp500' ? 'sp500' : 'russell2k';

  if (!TICKER_RE.test(ticker)) {
    return json(400, { ok: false, error: 'ticker must be 1-10 chars, A-Z0-9.- , starting with a letter' });
  }

  try {
    const evidence = await gatherEvidence(ticker, universe);

    // Refuse rather than reason over nothing. With no fundamentals AND no
    // news, the model would be writing from the ticker string alone — which
    // is exactly how a confident hallucination gets rendered as research.
    if (!evidence.fundamentals && evidence.news.length === 0) {
      log.warn('insufficient_evidence', { ticker, gaps: evidence.gaps.length });
      return json(422, {
        ok: false, ticker, error: 'insufficient_evidence',
        message: `No screener row and no news for ${ticker}. There is nothing to reason over — the model would be guessing from the ticker alone.`,
        gaps: evidence.gaps,
      });
    }

    const todayIso = new Date().toISOString().slice(0, 10);
    const user = `Today's date is ${todayIso}.\n\n${renderEvidence(evidence)}\n\nAnswer the four questions.`;

    let usedModel = PRIMARY_MODEL;
    let data: { content: Array<{ type: string; text?: string }> };
    try {
      data = await callAnthropic({
        model: PRIMARY_MODEL, max_tokens: 1600,
        system: SYSTEM_PROMPT, messages: [{ role: 'user', content: user }],
      });
    } catch (err: any) {
      if (err instanceof BudgetExhaustedError) {
        return json(503, {
          ok: false, ticker, error: 'budget_exhausted',
          message: 'AI features paused — daily Anthropic budget reached. Resets at 00:00 UTC.',
        });
      }
      if (err instanceof CircuitOpenError) {
        return json(503, { ok: false, ticker, error: 'circuit_open', message: 'Anthropic circuit breaker is open.' });
      }
      if (!isModelUnavailable(err)) throw err;
      log.warn('model_fallback', { from: PRIMARY_MODEL, to: FALLBACK_MODEL, err: String(err?.message ?? err) });
      usedModel = FALLBACK_MODEL;
      data = await callAnthropic({
        model: FALLBACK_MODEL, max_tokens: 1600,
        system: SYSTEM_PROMPT, messages: [{ role: 'user', content: user }],
      });
    }

    const text = data.content.filter((c) => c.type === 'text').map((c) => c.text ?? '').join('');
    const read = parseRead(text);   // throws on a malformed or overconfident answer

    log.info('response', {
      status: 200, ticker, model: usedModel,
      verdict: read.readVerdict, gaps: evidence.gaps.length, durationMs: Date.now() - start,
    });

    return json(200, {
      ok: true,
      ticker,
      universe,
      model: usedModel,
      read,
      evidence: {
        asOf: evidence.asOf,
        hasFundamentals: !!evidence.fundamentals,
        attention: evidence.attention,
        // Unweighted context legs. Sent so the UI can show what the model
        // actually saw — including when they were unavailable and why.
        googleTrends: evidence.googleTrends
          ? {
              available: evidence.googleTrends.available,
              keyword: evidence.googleTrends.keyword,
              recentVsBase: evidence.googleTrends.recentVsBase,
              reason: evidence.googleTrends.reason,
            }
          : null,
        offExchange: evidence.offExchange
          ? {
              available: evidence.offExchange.available,
              volumeZ: evidence.offExchange.volumeZ,
              recentDailyVolume: evidence.offExchange.recentDailyVolume,
              dpiRecent: evidence.offExchange.dpiRecent,
              dpiBase: evidence.offExchange.dpiBase,
              days: evidence.offExchange.days,
              asOf: evidence.offExchange.asOf,
              reason: evidence.offExchange.reason,
            }
          : null,
        mentions: evidence.mentions
          ? {
              state: evidence.mentions.state,
              mentions: evidence.mentions.mentions,
              mentions24hAgo: evidence.mentions.mentions24hAgo,
              rank: evidence.mentions.rank,
              universeSize: evidence.mentions.universeSize,
              floor: evidence.mentions.floor,
              reason: evidence.mentions.reason,
            }
          : null,
        appRating: evidence.appRating
          ? {
              available: evidence.appRating.available,
              appName: evidence.appRating.appName,
              rating: evidence.appRating.rating,
              ratingCount: evidence.appRating.ratingCount,
              matchConfidence: evidence.appRating.matchConfidence,
              reason: evidence.appRating.reason,
            }
          : null,
        insiderCount: evidence.insiders.length,
        newsCount: evidence.news.length,
        nextEarnings: evidence.nextEarnings,
        gaps: evidence.gaps,
      },
      // Travels in the contract so a UI refactor cannot drop it.
      disclaimer:
        'Judgment from fetched evidence only. No score, no target, no measured edge. ' +
        'The attention leg measured NO_EDGE in this system\'s own study.',
    });
  } catch (err: any) {
    const msg = String(err?.message ?? err);
    log.error('failed', { ticker, err: msg, durationMs: Date.now() - start });
    return json(502, { ok: false, ticker, error: msg });
  }
};
