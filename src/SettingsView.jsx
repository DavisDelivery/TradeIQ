import React, { useState } from 'react';
import { AlertTriangle, ShoppingCart } from 'lucide-react';
import { StatusDot } from './components/Badges.jsx';
import { signIn, signOutUser, onAuthChange } from './lib/auth.js';

// Agentic Trading — Google sign-in (owner preference: a login, no shared
// secrets). Queue mutations send the Firebase ID token; the server
// verifies it and requires the email to be on the OWNER_EMAILS allowlist
// (Netlify env, fail-closed). The executor agent reports fills in chat;
// you confirm them with one tap in the Journal's queue panel — every
// money-adjacent write stays behind this login.
function AgenticTradingSettings() {
  const [user, setUser] = React.useState(undefined); // undefined = loading
  const [err, setErr] = React.useState('');
  React.useEffect(() => onAuthChange((u) => setUser(u ?? null)), []);
  const doSignIn = async () => {
    setErr('');
    try { await signIn(); } catch (e) { setErr(String(e?.message || e)); }
  };
  return (
    <div className="border border-neutral-800 p-5">
      <h3 className="font-serif text-lg mb-1 flex items-center gap-2"><ShoppingCart className="h-4 w-4 text-neutral-500" /> Agentic Trading</h3>
      <p className="text-[11px] text-neutral-500 font-mono mb-3 leading-relaxed">
        Sign in with Google to queue orders and confirm fills. The server only accepts
        accounts on its owner allowlist — no tokens to copy, nothing to store.
      </p>
      {user === undefined && <div className="text-[11px] font-mono text-neutral-600">checking sign-in…</div>}
      {user === null && (
        <button type="button" onClick={doSignIn}
          className="px-4 h-9 border border-neutral-700 text-[11px] font-mono uppercase tracking-widest text-neutral-200 hover:border-neutral-500">
          Sign in with Google
        </button>
      )}
      {user && (
        <div className="flex items-center gap-3 flex-wrap">
          <span className="text-[12px] font-mono text-emerald-300">✓ {user.email}</span>
          <button type="button" onClick={() => signOutUser()}
            className="px-3 h-8 border border-neutral-700 text-[10px] font-mono uppercase tracking-widest text-neutral-400 hover:border-neutral-500">
            Sign out
          </button>
        </div>
      )}
      {err && <div className="mt-2 text-[11px] font-mono text-rose-400">{err}</div>}
    </div>
  );
}

export const SettingsView = () => (
  <div className="px-3 py-4 sm:p-6 max-w-[1200px] mx-auto space-y-4">
    <div className="mb-4">
      <div className="text-[10px] uppercase tracking-[0.2em] text-neutral-500 font-mono mb-2">Configuration</div>
      <h1 className="font-serif text-3xl font-bold tracking-tight">Settings</h1>
    </div>

    <AgenticTradingSettings />

    <div className="border border-neutral-800 p-5">
      <h3 className="font-serif text-lg mb-4">Data Sources</h3>
      <div className="space-y-3">
        {/* Status reflects the deployed Netlify env config. The four live
            providers below are confirmed wired (they serve the prices,
            earnings/insider, macro-rate, and narrative surfaces today);
            TradeStation OAuth is the one integration still pending — the
            options-flow surface runs in underlying-proxy mode until it lands. */}
        {[
          { name: 'Polygon.io Stocks Advanced', purpose: 'Bulk scanning, prices, fundamentals, news', status: 'connected' },
          { name: 'TradeStation API', purpose: 'Real-time quotes, options chains, execution', status: 'pending' },
          { name: 'Finnhub Premium', purpose: 'Earnings, revisions, insider transactions', status: 'connected' },
          { name: 'FRED', purpose: 'Macro rates data (free)', status: 'connected' },
          { name: 'Claude API', purpose: 'News sentiment, geopolitical synthesis, narratives', status: 'connected' },
        ].map(s => (
          <div key={s.name} className="flex items-center justify-between py-2">
            <div className="flex items-center gap-3">
              <StatusDot status={s.status === 'connected' ? 'healthy' : 'warning'} />
              <div>
                <div className="text-neutral-200">{s.name}</div>
                <div className="text-[11px] text-neutral-500 font-mono">{s.purpose}</div>
              </div>
            </div>
            <span className={`font-mono text-[10px] uppercase tracking-widest px-2 py-1 border ${
              s.status === 'connected' ? 'text-emerald-400 border-emerald-500/30 bg-emerald-500/10' :
              'text-amber-400 border-amber-500/30 bg-amber-500/10'
            }`}>
              {s.status === 'connected' ? 'CONNECTED' : 'PENDING'}
            </span>
          </div>
        ))}
      </div>
      <p className="text-[11px] text-neutral-500 font-mono mt-4">
        Keys managed via Netlify env vars. Never exposed to the browser.
      </p>
    </div>

    <div className="border border-neutral-800 p-5 bg-rose-500/5">
      <div className="flex items-start gap-3">
        <AlertTriangle className="h-5 w-5 text-rose-400 flex-shrink-0 mt-0.5" />
        <div>
          <h3 className="font-serif text-base text-neutral-200">Not Financial Advice</h3>
          <p className="text-[13px] text-neutral-400 mt-1 leading-relaxed">
            TradeIQ Alpha synthesizes signals from multiple data sources into ranked trade ideas. It is a research
            tool, not investment advice. Past signal accuracy does not predict future results. Size positions appropriately,
            track outcomes, and remember: a coherent-sounding AI narrative can make a noise setup look like signal.
            Let outcome data, not thesis elegance, determine whether you follow a target.
          </p>
        </div>
      </div>
    </div>
  </div>
);
