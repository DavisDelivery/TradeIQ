// Structured JSON logger.
//
// Why: Netlify captures stdout per-function. Plain `console.log("got X")`
// across ~16 functions is impossible to grep, correlate, or build alerts on.
// Single-line JSON keyed on {ts, level, fn, msg, ...ctx} gives us queryable
// logs in Netlify's UI today and a clean export to Logtail/Datadog later.
//
// Three levels in active use: info, warn, error. `debug` is included for
// completeness but should be left off in normal request paths — we want logs
// signal-rich, not chatty.
//
// Pattern at a call site (one logger per function file):
//
//   const log = createLogger('target-board');
//   const start = Date.now();
//   log.info('request', { qs: event.queryStringParameters });
//   try {
//     // ... work ...
//     log.info('response', { status: 200, durationMs: Date.now() - start });
//     return json(200, response);
//   } catch (err) {
//     log.error('failed', { error: String(err), durationMs: Date.now() - start });
//     throw err;
//   }

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogContext {
  [key: string]: unknown;
}

export interface Logger {
  debug(msg: string, ctx?: LogContext): void;
  info(msg: string, ctx?: LogContext): void;
  warn(msg: string, ctx?: LogContext): void;
  error(msg: string, ctx?: LogContext): void;
  child(extra: LogContext): Logger;
}

function emit(level: LogLevel, fn: string, msg: string, ctx: LogContext = {}): void {
  // Single line of JSON per log event. Netlify ingests stdout as-is; the
  // single-line shape keeps each event queryable as a row.
  const entry = {
    ts: new Date().toISOString(),
    level,
    fn,
    msg,
    ...sanitize(ctx),
  };
  // Use console.log for info/debug/warn so they all flow to stdout uniformly,
  // and console.error for errors so they show as red in the Netlify UI.
  if (level === 'error') console.error(JSON.stringify(entry));
  else console.log(JSON.stringify(entry));
}

// Cheap belt-and-suspenders: never let an Error or BigInt blow up
// JSON.stringify; also drop common secret-shaped fields if they slip in.
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
    } else {
      out[k] = v;
    }
  }
  return out;
}

export function createLogger(fn: string, baseCtx: LogContext = {}): Logger {
  const merge = (extra: LogContext = {}): LogContext => ({ ...baseCtx, ...extra });
  return {
    debug: (m, c) => emit('debug', fn, m, merge(c)),
    info: (m, c) => emit('info', fn, m, merge(c)),
    warn: (m, c) => emit('warn', fn, m, merge(c)),
    error: (m, c) => emit('error', fn, m, merge(c)),
    child: (extra) => createLogger(fn, { ...baseCtx, ...extra }),
  };
}
