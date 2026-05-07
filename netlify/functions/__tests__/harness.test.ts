import { describe, it, expect } from 'vitest';

// Smoke test — confirms the functions-side Vitest project (node env) wires up.
// If the harness regresses, this is the canary.
describe('vitest harness (functions)', () => {
  it('runs node env tests', () => {
    expect(typeof process).toBe('object');
    expect(typeof window).toBe('undefined');
  });
});
