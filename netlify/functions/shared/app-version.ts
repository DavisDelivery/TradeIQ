// FIX-1 — single source of truth for the app version.
//
// Why this exists: `netlify/functions/health.ts` hardcoded
// `version: '0.10.0-alpha'` while the real APP_VERSION lived (and was
// bumped) in `src/App.jsx` — so production /api/health reported a
// version nine minors stale. This module is a pure constant with no
// imports so BOTH sides can consume it:
//
//   - Functions (esbuild bundle):  import { APP_VERSION } from './shared/app-version'
//   - Frontend (Vite, from src/):  import { APP_VERSION } from '../netlify/functions/shared/app-version'
//
// The ORCHESTRATOR.md standing rule "ALWAYS bump APP_VERSION in
// src/App.jsx" now means: bump it HERE (App.jsx re-exports the import).
// MODEL_VERSION (scoring math) is separate — see shared/model-version.ts.

export const APP_VERSION = '0.26.0-alpha';
