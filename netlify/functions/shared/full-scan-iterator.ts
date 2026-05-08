// Concurrency-controlled async iterator for full-universe scans.
//
// Existing live endpoints used ad-hoc `for (let i; i += chunk)` loops with
// hard-coded concurrency = 5. Scheduled scans need to walk 1,930+ tickers
// without tripping Polygon (5 req/s free, 100 req/s paid) or Finnhub
// (60 req/min free, 300 req/min paid). One helper, one tunable knob.
//
// Patterns:
//
//   // Yield batches of tickers to process; pace between batches.
//   for await (const batch of iterateUniverse(tickers, { batchSize: 8, pacingMs: 100 })) {
//     await Promise.all(batch.map(scoreTicker));
//   }
//
//   // Or use mapWithConcurrency for the common case.
//   const results = await mapWithConcurrency(tickers, scoreTicker, {
//     concurrency: 8,
//     pacingMs: 100,
//   });

export interface IterateOpts {
  /** Tickers per yielded batch. Default 8. */
  batchSize?: number;
  /** Sleep this many ms between batches (rate-limit pacing). Default 0. */
  pacingMs?: number;
}

export async function* iterateUniverse(
  tickers: string[],
  opts: IterateOpts = {},
): AsyncGenerator<string[]> {
  const batchSize = opts.batchSize ?? 8;
  const pacingMs = opts.pacingMs ?? 0;
  for (let i = 0; i < tickers.length; i += batchSize) {
    yield tickers.slice(i, i + batchSize);
    if (pacingMs > 0 && i + batchSize < tickers.length) {
      await sleep(pacingMs);
    }
  }
}

export interface MapOpts<T> extends IterateOpts {
  /** Max in-flight tasks per batch. Defaults to batchSize. */
  concurrency?: number;
  /** Called on each error; default = swallow + continue. */
  onError?: (err: unknown, ticker: string) => void;
  /** Abort early if this returns true. Checked once per batch. */
  shouldAbort?: () => boolean;
  /**
   * Mapped result type (defaults to mapper return). Errors yield undefined
   * unless onError throws — full universe scans should NOT crash on one
   * ticker, so the default is to log + continue.
   */
  _phantom?: T;
}

export async function mapWithConcurrency<T>(
  tickers: string[],
  fn: (ticker: string) => Promise<T>,
  opts: MapOpts<T> = {},
): Promise<Array<T | undefined>> {
  const batchSize = opts.batchSize ?? 8;
  const pacingMs = opts.pacingMs ?? 0;
  const onError = opts.onError;
  const out: Array<T | undefined> = new Array(tickers.length);

  for (let i = 0; i < tickers.length; i += batchSize) {
    if (opts.shouldAbort?.()) break;
    const batch = tickers.slice(i, i + batchSize);
    const settled = await Promise.allSettled(batch.map((t) => fn(t)));
    settled.forEach((s, k) => {
      const idx = i + k;
      if (s.status === 'fulfilled') {
        out[idx] = s.value;
      } else {
        out[idx] = undefined;
        onError?.(s.reason, batch[k]);
      }
    });
    if (pacingMs > 0 && i + batchSize < tickers.length) {
      await sleep(pacingMs);
    }
  }
  return out;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
