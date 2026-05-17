// Phase 4j W2 guardrail — snapshot pick schema must NOT carry the
// description field. A ~500-char description × ~2,000 russell2k picks
// would push the snapshot document past Firestore's 1 MiB hard ceiling
// and silently break the terminal snapshot write (same trap 4e-1-infra
// and 4h had to engineer around).
//
// This test is structural: it reads the Target type and the scan-target
// runner source and asserts neither references a description field.
// If a future change adds one, this test fires before the cap is hit
// in production.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(__dirname, '..', '..', '..');

function read(rel: string): string {
  return readFileSync(resolve(root, rel), 'utf8');
}

describe('Phase 4j guardrail — description is on-demand, NOT on the pick', () => {
  it('Target interface in types.ts does not declare a description field', () => {
    const src = read('netlify/functions/shared/types.ts');
    // Find the Target interface body.
    const m = src.match(/export interface Target \{([\s\S]*?)\n\}/);
    expect(m, 'Target interface must be defined in types.ts').toBeTruthy();
    const body = m![1];
    // Allow `// description` comments (we use them in this very file's
    // header), but disallow an actual `description` field on the type.
    expect(body).not.toMatch(/^\s*description[?]?:\s/m);
  });

  it('scan-target.ts does not write description onto picks', () => {
    const src = read('netlify/functions/shared/scan-target.ts');
    // It's fine for the file to mention the word in comments, but no
    // assignment to a `description` property should happen during scan.
    expect(src).not.toMatch(/\bdescription\s*:/);
  });

  it('analyst-runner.ts (which builds the pick) does not attach a description', () => {
    const src = read('netlify/functions/shared/analyst-runner.ts');
    // Same check on the function that actually constructs a Target.
    // We allow `// description` comments inside the file but no
    // `description:` field assignment.
    expect(src).not.toMatch(/^\s*description\s*:/m);
  });
});
