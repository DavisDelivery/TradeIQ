// Structured JSON logger.
//
// Reconciles two call shapes from Phase 0 and Phase 1, keeping every
// behaviour Phase 0 added (Sentry forwarding, key redaction, Error /
// BigInt-safe serialisation) while exposing the top-level `logger` /
// `logger.child(ctx)` shape Phase 1's rewrites depend on.
//
// Two equivalent ways to log:
//
//   import { createLogger } from './shared/logger';
//   const log = createLogger('target-board');                        // Phase 0
//   log.info('request', { universe: 'core' });
//
//   import { logger } from './shared/logger';
//   const log = logger.child({ fn: 'scan-target-board-sp500', universe }); // Phase 1
//   log.info('scan_started', { tickerCount: 1930 });
//
// Output: one JSON object per line on stdout (info/debug/warn) or stderr
// (error). Errors also forward to Sentry when SENTRY_DSN is configured;
// otherwise the forward is a no-op.

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogContext {
  [key: string]: unknown;
}

export interface Logger {
  debug(event: string, data?: LogContext): void;
  info(event: string, data?: LogContext): void;
  warn(event: string, data?: LogContext): void;
  error(event: string, data?: LogContext): void;
  child(extra: LogContext): Logger;
}

function emit(level: LogLevel, baseCtx: LogContext, event: string, data: LogContext = {}): void {
  // Single line of JSON per log event. Netlify ingests stdout as-is; the
  // single-line shape keeps each event queryable as a row.
  const fn = (baseCtx.fn ?? data.fn) as string | undefined;
  const merged = sanitize({ ...baseCtx, ...data });
  // Hoist `fn` to top-level when present, then strip from tail to avoid
  // double-emission.
  const { fn: _fn, ...tail } = merged;
  const entry = {
    ts: new Date().toISOString(),
    level,
    ...(fn ? { fn } : {}),
    event,
    ...tail,
  };
  if (level === 'error') console.error(JSON.stringify(entry));
  else console.log(JSON.stringify(entry));

  // Errors also go to Sentry (no-op if SENTRY_DSN unset). Fire and forget —
  // we never want logger emission to block the request path on Sentry I/O.
  if (level === 'error') {
    void forwardErrorToSentry(fn ?? 'unknown', event, merged);
  }
}

// Cheap belt-and-suspenders: never let an Error or BigInt blow up
// JSON.stringify; also redact common secret-shaped fields if they slip in.
function sanitize(ctx: LogContext): LogContext {
  const out: LogContext = {};
  for (const [k, v] of Object.entries(ctx)) {
    if (/api[_-]?key|secret|token|authorization/i.test(k)) {
      out[k] = '[redacted]';
      continue;
    }
    if (v instanceof Error) {
      out[k] = { name: v.name, message: v.message, stack: v.stack };
    } else if (typeof v === 'bigint') {
      out[k] = v.toString();
    } else if (typeof v === 'string' && v.length > 4096) {
      // Keep huge payloads from blowing up Netlify log lines.
      out[k] = v.slice(0, 4096) + `...[truncated ${v.length - 4096}b]`;
    } else {
      out[k] = v;
    }
  }
  return out;
}

// Forward error-level events to Sentry. The forwarding is lazy and falls
// back to a no-op if Sentry isn't configured (DSN missing). We swallow any
// failure inside the forwarder itself — logging must not throw.
async function forwardErrorToSentry(fn: string, msg: string, ctx: LogContext): Promise<void> {
  if (!process.env.SENTRY_DSN) return;
  try {
    const { captureException } = await import('./sentry');
    // Find the first Error in ctx, otherwise fabricate one from msg.
    let err: unknown = msg;
    for (const v of Object.values(ctx)) {
      if (v instanceof Error) { err = v; break; }
    }
    if (typeof err === 'string') err = new Error(`[${fn}] ${msg}`);
    captureException(err, { fn, msg, ...ctx });
  } catch {
    // If Sentry import fails (e.g. bundling oddity), don't crash logging.
  }
}

function makeLogger(baseCtx: LogContext): Logger {
  return {
    debug: (event, data) => emit('debug', baseCtx, event, data),
    info: (event, data) => emit('info', baseCtx, event, data),
    warn: (event, data) => emit('warn', baseCtx, event, data),
    error: (event, data) => emit('error', baseCtx, event, data),
    child: (extra) => makeLogger({ ...baseCtx, ...extra }),
  };
}

// Phase 1's preferred entry point.
export const logger: Logger = makeLogger({});

// Phase 0's preferred entry point — the first arg becomes the `fn` field
// on every emitted record so existing call sites don't need to change.
export function createLogger(fn: string, baseCtx: LogContext = {}): Logger {
  return makeLogger({ fn, ...baseCtx });
}
