import { defineConfig } from 'vitest/config';

// Two test "projects" share one config:
//   - frontend: jsdom env, picks up React tests under src/**
//   - functions: node env, picks up TS tests under netlify/functions/**
//
// Coverage runs across both. We start with permissive thresholds and tighten
// as Phase 0+ work expands the suite. Per ORCHESTRATOR.md / Phase 0 brief:
// prophet-layers.ts must hit ≥60% line coverage to mark Workstream 3 done.
export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'json-summary'],
      include: ['netlify/functions/shared/**/*.ts', 'src/**/*.{js,jsx,ts,tsx}'],
      exclude: [
        '**/__tests__/**',
        '**/*.test.{js,jsx,ts,tsx}',
        '**/test/**',
        'app/**',
        'dist/**',
        'src/main.jsx',
      ],
      thresholds: {
        lines: 5,
        statements: 5,
        functions: 5,
        branches: 5,
      },
    },
    projects: [
      {
        extends: true,
        test: {
          name: 'frontend',
          environment: 'jsdom',
          setupFiles: ['./src/test/setup.ts'],
          include: ['src/**/*.test.{js,jsx,ts,tsx}'],
          globals: true,
        },
      },
      {
        extends: true,
        test: {
          name: 'functions',
          environment: 'node',
          include: [
            'netlify/functions/**/*.test.ts',
            'netlify/functions/**/__tests__/**/*.test.ts',
          ],
          globals: true,
        },
      },
    ],
  },
});
