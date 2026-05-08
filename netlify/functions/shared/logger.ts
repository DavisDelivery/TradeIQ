// Minimal structured JSON logger.
//
// Phase 1 ships this as a stand-in because Phase 0 (which owns the canonical
// observability stack — Sentry, structured logger, Anthropic budget cap) has
// not yet been completed. The shape here is intentionally Phase-0-compatible:
// when Phase 0's full logger.ts replaces this file, every call site keeps
// working unchanged.
//
// Usage:
//   import { logger } from './shared/logger';
//   const log = logger.child({ fn: 'scan-target-board', universe: 'russell2k' });
//   log.info('scan_started', { tickerCount: 1930 });
//   log.warn('rate_limit_pacing', { remainingMs: 250 });
//   log.error('scan_failed', { err: String(err) });
//
// Output: one JSON object per line on stdout (info/warn) or stderr (error).
// Netlify aggregates stdout/stderr in function logs; structured JSON is
// queryable later when Phase 0 wires Logtail/Sentry on top.

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogContext {
  [key: string]: unknown;
}

export interface Logger {
  child(ctx: LogContext): Logger;
  debug(event: string, data?: LogContext): void;
  info(event: string, data?: LogContext): void;
  warn(event: string, data?: LogContext): void;
  error(event: string, data?: LogContext): void;
}

function emit(level: LogLevel, event: string, ctx: LogContext, data?: LogContext): void {
  const record = {
    ts: new Date().toISOString(),
    level,
    event,
    ...ctx,
    ...(data ?? {}),
  };
  const line = JSON.stringify(record, replacer);
  if (level === 'error') {
    // eslint-disable-next-line no-console
    console.error(line);
  } else {
    // eslint-disable-next-line no-console
    console.log(line);
  }
}

// Safer JSON: keep Errors readable, truncate huge strings.
function replacer(_key: string, value: unknown): unknown {
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }
  if (typeof value === 'string' && value.length > 4096) {
    return value.slice(0, 4096) + `...[truncated ${value.length - 4096}b]`;
  }
  return value;
}

function makeLogger(baseCtx: LogContext): Logger {
  return {
    child(extra) {
      return makeLogger({ ...baseCtx, ...extra });
    },
    debug(event, data) {
      emit('debug', event, baseCtx, data);
    },
    info(event, data) {
      emit('info', event, baseCtx, data);
    },
    warn(event, data) {
      emit('warn', event, baseCtx, data);
    },
    error(event, data) {
      emit('error', event, baseCtx, data);
    },
  };
}

export const logger: Logger = makeLogger({});
