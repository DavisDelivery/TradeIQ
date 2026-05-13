// In-memory narrative cache shared by prophet-picks and prophet-narrate.
//
// Key: `${ticker}:${band}` where band = floor(composite / 5) * 5. The band
// quantization means two requests for the same ticker at composite 63 vs 64
// hit the same cache entry — different scans of the same ticker produce
// slightly different composites, and we don't want to re-narrate just because
// the score moved one point.
//
// Lifetime: per-container memory. Netlify functions can be cold-started at
// any time, so this is a best-effort cache, not a guarantee. A cold start
// means a re-narration — that's fine.

export interface NarrativeCacheEntry {
  text: string;
  at: number;
}

const CACHE = new Map<string, NarrativeCacheEntry>();
const NARRATIVE_TTL_MS = 6 * 60 * 60 * 1000; // 6h

export function narrativeCacheKey(ticker: string, composite: number): string {
  const band = Math.floor(composite / 5) * 5;
  return `${ticker}:${band}`;
}

export function getCachedNarrative(ticker: string, composite: number): string | null {
  const key = narrativeCacheKey(ticker, composite);
  const hit = CACHE.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > NARRATIVE_TTL_MS) {
    CACHE.delete(key);
    return null;
  }
  return hit.text;
}

export function setCachedNarrative(ticker: string, composite: number, text: string): void {
  if (!text) return;
  const key = narrativeCacheKey(ticker, composite);
  CACHE.set(key, { text, at: Date.now() });
}

// Test hooks
export const __testInternals = {
  reset: () => CACHE.clear(),
  size: () => CACHE.size,
  TTL_MS: NARRATIVE_TTL_MS,
};
