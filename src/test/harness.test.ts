import { describe, it, expect } from 'vitest';

// Smoke test — confirms the frontend Vitest project (jsdom env) wires up.
// If we ever break the jest-dom setup, this fails first.
describe('vitest harness (frontend)', () => {
  it('runs jsdom env tests', () => {
    expect(typeof document).toBe('object');
    expect(typeof window).toBe('object');
  });

  it('jest-dom matchers are available', () => {
    const div = document.createElement('div');
    div.textContent = 'hello';
    document.body.appendChild(div);
    expect(div).toBeInTheDocument();
    expect(div).toHaveTextContent('hello');
  });
});
