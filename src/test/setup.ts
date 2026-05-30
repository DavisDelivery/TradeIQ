// Frontend test setup — runs once before every jsdom test file.
// Adds @testing-library/jest-dom matchers (toBeInTheDocument, etc.).
import '@testing-library/jest-dom/vitest';

// Recharts' ResponsiveContainer uses ResizeObserver, which jsdom doesn't
// ship. Phase 6 PR-C charts and any future Recharts-using component need
// this stub at the global setup layer; otherwise the first chart render in
// a test throws "ResizeObserver is not defined".
if (typeof globalThis.ResizeObserver === 'undefined') {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}
