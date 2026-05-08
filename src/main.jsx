import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.jsx';
import { initSentry } from './lib/sentry.js';
import './index.css';

// Init early so cold-start errors and the App ErrorBoundary both have a
// place to land. No-op until VITE_SENTRY_DSN is configured.
initSentry();

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
