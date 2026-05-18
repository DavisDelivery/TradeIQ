// Phase 4o W1 — token-bucket rate limiter + 429-aware fetch helper.
//
// Background: the russell2k insider scan fires ~2,000 Finnhub
// insider-transaction calls at concurrency 8 with no pacing. Finnhub's
// per-minute limit gets hit immediately and the surplus calls all return
// HTTP 429, which `getFinnhubInsiderTransactions` historically swallowed
// into `return []`. Every empty result advanced the cursor and a
// terminal snapshot landed with `results: []`. A silent failure.
//
// This module gives the data-provider a way to pace calls AND react to
// 429s with backoff-and-retry. Pacing alone isn't sufficient because the
// scheduled scans may collide with each other (4 universes once shared a
// `30 21 * * 1-5` slot), and a cold start may queue several batches
// before the limiter's token bucket has had time to refill from a prior
// invocation. The fetch helper retries on 429 with exponential backoff,
// honors `Retry-After` if present, and lets the caller observe whether
// the request was rate-limited (so W3 can flag the run as degraded
// rather than silently publishing).
//
// Netlify Functions are stateless per invocation, so a module-scope
// token bucket only paces calls within one invocation. That's
// sufficient because the checkpoint-resume machinery already serializes
// one invocation at a time per scan, and W1 staggers the 4 insider
// cron slots so the 4 universes don't collide.

const DEFAULT_CALLS_PER_MIN = Number(process.env.FINNHUB_RPM ?? 55);

/**
 * Token-bucket rate limiter. Calls `acquire()` block until a token is
 * available, then return. Refills at `ratePerMs = capacity / windowMs`.
 *
 * The capacity is also the burst ceiling: a freshly-created limiter
 * starts full, so a small batch issued during a cold start runs
 * unthrottled. Steady-state pacing only kicks in once the bucket
 * empties.
 */
export interface TokenBucket {
  /** Block until a token is available, then consume it. */
  acquire(): Promise<void>;
  /** Number of tokens currently in the bucket (for tests / introspection). */
  available(): number;
  /** Capacity (max burst). */
  capacity(): number;
}

export interface TokenBucketOpts {
  /** Max tokens in the bucket. Default = `callsPerWindow`. */
  capacity?: number;
  /** Window length in ms. Default = 60_000 (per-minute). */
  windowMs?: number;
  /** Calls allowed in one window. Default = `capacity`. */
  callsPerWindow: number;
  /** Test seam: returns current time in ms. Default = `Date.now`. */
  now?: () => number;
  /** Test seam: sleep N ms. Default = setTimeout-based. */
  sleep?: (ms: number) => Promise<void>;
}

export function createTokenBucket(opts: TokenBucketOpts): TokenBucket {
  const windowMs = opts.windowMs ?? 60_000;
  const callsPerWindow = opts.callsPerWindow;
  const capacity = opts.capacity ?? callsPerWindow;
  const refillPerMs = callsPerWindow / windowMs;
  const now = opts.now ?? (() => Date.now());
  const sleep = opts.sleep ?? defaultSleep;

  let tokens = capacity;
  let lastRefill = now();
  // Serializes concurrent acquire() calls so two simultaneous awaits
  // can't both observe `tokens >= 1`, both decrement, and both proceed
  // when only one token was actually available.
  let chain: Promise<void> = Promise.resolve();

  function refill(): void {
    const t = now();
    const dt = t - lastRefill;
    if (dt <= 0) return;
    tokens = Math.min(capacity, tokens + dt * refillPerMs);
    lastRefill = t;
  }

  async function acquireOne(): Promise<void> {
    refill();
    if (tokens >= 1) {
      tokens -= 1;
      return;
    }
    // Wait for the next token. (1 - tokens) / refillPerMs ms.
    const needed = 1 - tokens;
    const waitMs = Math.max(1, Math.ceil(needed / refillPerMs));
    await sleep(waitMs);
    refill();
    // Clamp: if multiple acquirers waited concurrently, the chain ensures
    // we still come out with at least one whole token to consume here.
    tokens = Math.max(0, tokens - 1);
  }

  return {
    acquire(): Promise<void> {
      const next = chain.then(acquireOne);
      // Keep the chain alive even if acquireOne throws.
      chain = next.catch(() => {});
      return next;
    },
    available(): number {
      refill();
      return tokens;
    },
    capacity(): number {
      return capacity;
    },
  };
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Finnhub module-scope bucket
// ---------------------------------------------------------------------------
//
// Finnhub's documented free-tier limit is 60 calls/min. We pace at ~55
// (default; override via FINNHUB_RPM) so the burst headroom doesn't push
// us into 429 territory on the first batch. Higher tiers can raise the
// limit safely without code change.

let _finnhubBucket: TokenBucket | null = null;

export function getFinnhubBucket(): TokenBucket {
  if (_finnhubBucket === null) {
    _finnhubBucket = createTokenBucket({ callsPerWindow: DEFAULT_CALLS_PER_MIN });
  }
  return _finnhubBucket;
}

/** Tests only — wipe the cached bucket so the next call gets a fresh one. */
export function _resetFinnhubBucketForTests(): void {
  _finnhubBucket = null;
}

// ---------------------------------------------------------------------------
// 429-aware fetch wrapper
// ---------------------------------------------------------------------------

export interface RateLimitedFetchResult {
  /** The final fetch Response (after any retries). */
  res: Response;
  /** Number of 429s observed across all attempts (including retries that
   *  ultimately succeeded). 0 means the first attempt succeeded. */
  rateLimitHits: number;
  /** True if every attempt returned 429 — the call exhausted retries. */
  rateLimitExhausted: boolean;
}

export interface RateLimitedFetchOpts {
  /** Max retry attempts on 429 (NOT counting the first request). Default 3. */
  maxRetries?: number;
  /** Initial backoff in ms. Doubles each retry. Default 500. */
  initialBackoffMs?: number;
  /** Max backoff per attempt in ms (cap). Default 8_000. */
  maxBackoffMs?: number;
  /** Test seam: sleep N ms. */
  sleep?: (ms: number) => Promise<void>;
  /** Test seam: fetch impl override. */
  fetchImpl?: typeof fetch;
}

/**
 * Fetch with 429-aware backoff-and-retry. The token bucket paces the
 * normal flow; this wrapper handles the case where the limiter's
 * estimate was wrong (clock skew, peer scan, multi-region) or where the
 * provider's allowance changed mid-window.
 *
 * Behavior:
 *   - First attempt: fire `fetch(url, init)`.
 *   - On 429: sleep `Retry-After` seconds (if present) or exponential
 *     backoff (initialBackoffMs * 2^n, capped at maxBackoffMs). Retry.
 *   - After `maxRetries` retries that all 429, return the last 429
 *     response with `rateLimitExhausted: true`. The caller decides
 *     whether to treat that as a flagged error or fall through.
 *   - Any non-429 response (200, 500, network error, etc.) returns
 *     immediately — this wrapper only owns rate-limit recovery.
 *
 * Network errors propagate as thrown exceptions; the caller handles
 * those via its existing try/catch.
 */
export async function fetchWithRateLimit(
  url: string,
  init: RequestInit | undefined,
  opts: RateLimitedFetchOpts = {},
): Promise<RateLimitedFetchResult> {
  const maxRetries = opts.maxRetries ?? 3;
  const initialBackoff = opts.initialBackoffMs ?? 500;
  const maxBackoff = opts.maxBackoffMs ?? 8_000;
  const sleep = opts.sleep ?? defaultSleep;
  const fetchImpl = opts.fetchImpl ?? fetch;

  let rateLimitHits = 0;
  let lastRes: Response | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const res = await fetchImpl(url, init);
    lastRes = res;
    if (res.status !== 429) {
      return { res, rateLimitHits, rateLimitExhausted: false };
    }
    rateLimitHits += 1;
    if (attempt === maxRetries) break;

    // Honor Retry-After when present (seconds or HTTP-date). Otherwise
    // exponential backoff capped at maxBackoffMs.
    const retryAfter = res.headers.get('Retry-After') ?? res.headers.get('retry-after');
    let waitMs = Math.min(initialBackoff * 2 ** attempt, maxBackoff);
    if (retryAfter) {
      const seconds = Number(retryAfter);
      if (Number.isFinite(seconds) && seconds > 0) {
        waitMs = Math.min(seconds * 1000, maxBackoff);
      }
    }
    await sleep(waitMs);
  }

  // All attempts (including the initial + maxRetries) returned 429.
  return {
    res: lastRes!,
    rateLimitHits,
    rateLimitExhausted: true,
  };
}
