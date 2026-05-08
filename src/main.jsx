import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.jsx';
import { initSentry } from './lib/sentry.js';
import { QueryClientProvider } from '@tanstack/react-query';
import { queryClient } from './lib/queryClient.js';
import './index.css';

// Init early so cold-start errors and the App ErrorBoundary both have a
// place to land. No-op until VITE_SENTRY_DSN is configured.
initSentry();

// Devtools only in dev: lazy-loaded so production bundles don't ship the
// devtools chunk. import.meta.env.DEV is statically replaced at build
// time, so the lazy import is dead-code-eliminated in prod.
const Devtools = import.meta.env.DEV
  ? React.lazy(() =>
      import('@tanstack/react-query-devtools').then((m) => ({
        default: m.ReactQueryDevtools,
      })),
    )
  : null;

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
      {Devtools && (
        <React.Suspense fallback={null}>
          <Devtools initialIsOpen={false} />
        </React.Suspense>
      )}
    </QueryClientProvider>
  </React.StrictMode>
);
