import React, { useState, useMemo } from 'react';
import {
  Activity,
  ChevronDown,
  ChevronRight,
  AlertTriangle,
  Clock,
  ExternalLink,
  Loader2,
  CheckCircle2,
} from 'lucide-react';
import { useStartBacktest } from '../hooks/useStartBacktest.js';
import { SurvivorshipBanner } from './SurvivorshipBanner.jsx';

// Phase 4b-2 — backtest launcher form.
//
// Replaces the LauncherPlaceholder note that 4b-1 dropped in. POSTs a
// BacktestConfig to /api/backtest-runs/start (the trigger endpoint —
// distinct path from the GET list at /api/backtest-runs because
// Netlify method-conditioned redirects aren't reliable, see
// netlify.toml). On 202 auto-selects the new run in the parent view
// via setSelectedRunId. Polling-while-incomplete lives in
// useBacktestRun (4b-1 hook patched in W4); the launcher itself is
// fire-and-go.
//
// Mobile-first single column on phone, 2 cols on sm+. All form state is
// local React state (no React Hook Form, no Zod schema) — the field set
// is small, the server's validateConfig is the single source of truth
// for shape, and lifting a form library in just for this would push the
// bundle past its budget.

// ---------- defaults ---------------------------------------------------------

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function daysAgoIso(days) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

const DEFAULT_CONFIG = Object.freeze({
  universe: 'dow',
  startDate: '2018-01-01',
  // endDate filled in by component at mount so the default tracks current time.
  rebalanceFrequency: 'monthly',
  board: 'prophet',
  topN: 20,
  initialCapital: 100000,
  minComposite: 50,
  maxPositionPct: 0.1,
  maxSectorPct: 0.4,
  cashSleeve: 0.05,
  weighting: 'equal',
});

const UNIVERSES = [
  { value: 'dow', label: 'DOW', subtitle: '30 names · corrected' },
  { value: 'sp500', label: 'S&P 500', subtitle: '~500 names · uncorrected', warning: 'sp500' },
  { value: 'ndx', label: 'NDX 100', subtitle: '~100 names · uncorrected', warning: 'sp500' },
  { value: 'russell2k', label: 'RUSSELL 2K', subtitle: '~2000 names · may exceed 15m cap', warning: 'russell2k' },
];

const REBALANCES = [
  { value: 'weekly', label: 'WEEKLY', subtitle: 'more trades = more slippage' },
  { value: 'monthly', label: 'MONTHLY', subtitle: 'balanced' },
  { value: 'quarterly', label: 'QUARTERLY', subtitle: 'lower turnover' },
];

const BOARDS = [
  { value: 'prophet', label: 'PROPHET', enabled: true },
  { value: 'catalyst', label: 'CATALYST', enabled: false },
  { value: 'insider', label: 'INSIDER', enabled: false },
  { value: 'williams', label: 'WILLIAMS', enabled: false },
];

// ---------- field-level validation -----------------------------------------
//
// Mirrors the engine's validateConfig where possible. The point isn't to
// replicate the server's checks (it has the final say) but to fail fast
// in the UI so the user doesn't submit a config that the server will
// 400 on anyway.

function validateForm(form) {
  const errs = {};
  if (form.startDate < '2018-01-01') {
    errs.startDate = 'Snapshot history starts 2018-01-01';
  }
  if (form.endDate > todayIso()) {
    errs.endDate = 'End date cannot be in the future';
  }
  if (form.startDate >= form.endDate) {
    errs.endDate = errs.endDate ?? 'End date must be after start date';
  } else {
    // 90-day floor: too short and there aren't enough rebalances to be
    // a real backtest. The engine doesn't enforce this; we do so the
    // user doesn't waste a 5-min run discovering it.
    const startMs = Date.parse(form.startDate);
    const endMs = Date.parse(form.endDate);
    if (endMs - startMs < 90 * 86_400_000) {
      errs.endDate = 'Backtest window must be at least 90 days';
    }
  }
  if (!Number.isFinite(+form.topN) || +form.topN < 5 || +form.topN > 50) {
    errs.topN = 'Top N must be 5..50';
  }
  if (!Number.isFinite(+form.initialCapital) || +form.initialCapital < 10_000 || +form.initialCapital > 10_000_000) {
    errs.initialCapital = 'Capital must be $10K..$10M';
  }
  if (!Number.isFinite(+form.minComposite) || +form.minComposite < 0 || +form.minComposite > 100) {
    errs.minComposite = '0..100';
  }
  if (!Number.isFinite(+form.maxPositionPct) || +form.maxPositionPct < 0.01 || +form.maxPositionPct > 0.5) {
    errs.maxPositionPct = '0.01..0.5';
  }
  if (!Number.isFinite(+form.maxSectorPct) || +form.maxSectorPct < 0.05 || +form.maxSectorPct > 1) {
    errs.maxSectorPct = '0.05..1.0';
  }
  if (!Number.isFinite(+form.cashSleeve) || +form.cashSleeve < 0 || +form.cashSleeve > 0.5) {
    errs.cashSleeve = '0..0.5';
  }
  return errs;
}

// Map the local form state to the BacktestConfig shape the trigger expects.
function buildConfig(form) {
  // Slippage defaults — mirrors DEFAULT_SLIPPAGE_BPS in shared/backtest/costs.ts.
  const slippageBps = { dow: 3, sp500: 5, ndx: 5, russell2k: 20 };
  return {
    universe: form.universe,
    startDate: form.startDate,
    endDate: form.endDate,
    rebalanceFrequency: form.rebalanceFrequency,
    board: form.board,
    portfolio: {
      topN: +form.topN,
      weighting: form.weighting,
      maxPositionPct: +form.maxPositionPct,
      maxSectorPct: +form.maxSectorPct,
      cashSleeve: +form.cashSleeve,
      minComposite: +form.minComposite,
    },
    costs: { slippageBps, commission: 0 },
    initialCapital: +form.initialCapital,
  };
}

// ---------- small primitives ------------------------------------------------

function FieldLabel({ children, hint }) {
  return (
    <div className="flex items-baseline justify-between mb-1.5">
      <label className="text-[10px] uppercase tracking-[0.2em] text-neutral-400 font-mono">
        {children}
      </label>
      {hint && <span className="text-[10px] text-neutral-600 font-mono">{hint}</span>}
    </div>
  );
}

function FieldError({ msg }) {
  if (!msg) return null;
  return <div className="text-[10px] text-rose-400 font-mono mt-1">{msg}</div>;
}

function RadioPill({ value, label, subtitle, selected, disabled, onSelect, title, iconLeft }) {
  const handle = () => {
    if (disabled) return;
    onSelect(value);
  };
  const ring = selected
    ? 'border-emerald-700/60 bg-emerald-950/15 text-emerald-200'
    : disabled
      ? 'border-neutral-900 bg-neutral-950/30 text-neutral-600 cursor-not-allowed'
      : 'border-neutral-800 bg-neutral-950/30 text-neutral-300 hover:bg-neutral-900/40';
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      aria-disabled={disabled}
      title={title}
      onClick={handle}
      disabled={disabled}
      className={`text-left border ${ring} px-3 py-2 transition-colors`}
    >
      <div className="flex items-center gap-2">
        {iconLeft}
        <span className="font-mono text-[11px] font-semibold tracking-wide">{label}</span>
      </div>
      {/* No truncate on subtitles: they carry warnings ("may exceed 15m
          cap", "more trades = more slippage") that were being cut
          mid-phrase (formatting audit #5). Wrap instead. */}
      {subtitle && (
        <div className="text-[10px] font-mono text-neutral-500 mt-0.5 leading-snug">{subtitle}</div>
      )}
    </button>
  );
}

function NumberInput({ value, onChange, min, max, step, ariaInvalid, dataTestid }) {
  return (
    <input
      type="number"
      value={value}
      min={min}
      max={max}
      step={step}
      aria-invalid={ariaInvalid || undefined}
      onChange={(e) => onChange(e.target.value)}
      data-testid={dataTestid}
      className={`w-full bg-neutral-950 border ${ariaInvalid ? 'border-rose-700/60' : 'border-neutral-800'} px-2 py-1.5 font-mono text-[12px] text-neutral-200 tabular-nums focus:outline-none focus:border-neutral-600`}
    />
  );
}

function DateInput({ value, onChange, min, max, ariaInvalid, dataTestid }) {
  return (
    <input
      type="date"
      value={value}
      min={min}
      max={max}
      aria-invalid={ariaInvalid || undefined}
      onChange={(e) => onChange(e.target.value)}
      data-testid={dataTestid}
      className={`w-full bg-neutral-950 border ${ariaInvalid ? 'border-rose-700/60' : 'border-neutral-800'} px-2 py-1.5 font-mono text-[12px] text-neutral-200 focus:outline-none focus:border-neutral-600`}
    />
  );
}

// ---------- amber russell2k pre-warning ------------------------------------

function Russell2kWarning() {
  return (
    <div
      role="alert"
      data-testid="russell2k-prewarning"
      className="border border-amber-700/60 bg-amber-950/20 px-3 py-2 my-3 rounded"
    >
      <div className="flex items-start gap-2">
        <Clock className="h-4 w-4 text-amber-400 shrink-0 mt-0.5" aria-hidden="true" />
        <div className="flex-1 text-[11px] font-mono text-amber-200/90 leading-relaxed">
          <span className="font-semibold">Russell 2k may exceed the 15-minute background cap.</span>{' '}
          Partial results will be stamped failed if the function times out.
          Consider dow/sp500/ndx first.
        </div>
      </div>
    </div>
  );
}

// ---------- launcher --------------------------------------------------------

export function BacktestLauncher({ setSelectedRunId }) {
  const [form, setForm] = useState(() => ({
    ...DEFAULT_CONFIG,
    endDate: daysAgoIso(30),
  }));
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [touched, setTouched] = useState(false);
  const mutation = useStartBacktest();

  const errors = useMemo(() => validateForm(form), [form]);
  const hasErrors = Object.keys(errors).length > 0;

  const update = (k, v) => {
    setForm((prev) => ({ ...prev, [k]: v }));
    // Clear any prior mutation outcome the moment the user touches a
    // field — feels more responsive than persisting stale banners.
    if (mutation.isError || mutation.isSuccess) {
      mutation.reset();
    }
  };

  const handleSubmit = () => {
    setTouched(true);
    if (hasErrors) return;
    const config = buildConfig(form);
    mutation.mutate(config, {
      onSuccess: (data) => {
        // Auto-select the new run so the user lands on its detail view.
        // The runs-list query is also invalidated by the hook itself.
        if (data?.runId) {
          setSelectedRunId?.(data.runId);
        }
      },
    });
  };

  const showSurvivorshipWarning =
    form.universe === 'sp500' || form.universe === 'ndx';
  const showRussell2kWarning = form.universe === 'russell2k';

  return (
    <div
      className="border border-neutral-800 bg-neutral-950/30 p-3 sm:p-4 mb-5"
      data-testid="backtest-launcher"
    >
      {/* Header */}
      <div className="flex items-center gap-2 mb-4">
        <Activity className="h-4 w-4 text-neutral-400" aria-hidden="true" />
        <h2 className="text-[10px] uppercase tracking-[0.25em] text-neutral-400 font-mono font-semibold">
          New backtest
        </h2>
      </div>

      {/* Top half: 2-column grid on sm+ */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        {/* Universe */}
        <div role="radiogroup" aria-label="Universe">
          <FieldLabel>Universe</FieldLabel>
          <div className="grid grid-cols-2 gap-1.5">
            {UNIVERSES.map((u) => (
              <RadioPill
                key={u.value}
                value={u.value}
                label={u.label}
                subtitle={u.subtitle}
                selected={form.universe === u.value}
                onSelect={(v) => update('universe', v)}
                iconLeft={
                  u.warning === 'sp500' ? (
                    <AlertTriangle className="h-3 w-3 text-rose-400" aria-label="uncorrected" />
                  ) : u.warning === 'russell2k' ? (
                    <Clock className="h-3 w-3 text-amber-400" aria-label="may time out" />
                  ) : null
                }
              />
            ))}
          </div>
        </div>

        {/* Board */}
        <div role="radiogroup" aria-label="Board">
          <FieldLabel hint="prophet only — others pending PIT scoring">Board</FieldLabel>
          <div className="grid grid-cols-2 gap-1.5">
            {BOARDS.map((b) => (
              <RadioPill
                key={b.value}
                value={b.value}
                label={b.label}
                selected={form.board === b.value}
                disabled={!b.enabled}
                onSelect={(v) => update('board', v)}
                title={
                  b.enabled
                    ? undefined
                    : `${b.label}'s point-in-time scoring is incomplete; see BACKTEST_LIMITATIONS.md`
                }
              />
            ))}
          </div>
        </div>

        {/* Start date */}
        <div>
          <FieldLabel hint="≥ 2018-01-01">Start date</FieldLabel>
          <DateInput
            value={form.startDate}
            onChange={(v) => update('startDate', v)}
            min="2018-01-01"
            max={form.endDate}
            ariaInvalid={!!(touched && errors.startDate)}
            dataTestid="start-date"
          />
          <FieldError msg={touched && errors.startDate} />
        </div>

        {/* End date */}
        <div>
          <FieldLabel hint="≤ today">End date</FieldLabel>
          <DateInput
            value={form.endDate}
            onChange={(v) => update('endDate', v)}
            min={form.startDate}
            max={todayIso()}
            ariaInvalid={!!(touched && errors.endDate)}
            dataTestid="end-date"
          />
          <FieldError msg={touched && errors.endDate} />
        </div>

        {/* Rebalance */}
        <div role="radiogroup" aria-label="Rebalance frequency">
          <FieldLabel>Rebalance</FieldLabel>
          <div className="grid grid-cols-3 gap-1.5">
            {REBALANCES.map((r) => (
              <RadioPill
                key={r.value}
                value={r.value}
                label={r.label}
                subtitle={r.subtitle}
                selected={form.rebalanceFrequency === r.value}
                onSelect={(v) => update('rebalanceFrequency', v)}
              />
            ))}
          </div>
        </div>

        {/* Top N + Capital */}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <FieldLabel hint="5..50">Top N</FieldLabel>
            <NumberInput
              value={form.topN}
              onChange={(v) => update('topN', v)}
              min={5}
              max={50}
              step={1}
              ariaInvalid={!!(touched && errors.topN)}
              dataTestid="top-n"
            />
            <FieldError msg={touched && errors.topN} />
          </div>
          <div>
            <FieldLabel hint="$10K..$10M">Capital</FieldLabel>
            <NumberInput
              value={form.initialCapital}
              onChange={(v) => update('initialCapital', v)}
              min={10000}
              max={10_000_000}
              step={1000}
              ariaInvalid={!!(touched && errors.initialCapital)}
              dataTestid="initial-capital"
            />
            <FieldError msg={touched && errors.initialCapital} />
          </div>
        </div>
      </div>

      {/* Inline survivorship pre-warning under universe row */}
      {showSurvivorshipWarning && (
        <div data-testid="launcher-survivorship-prewarning">
          <SurvivorshipBanner
            universeStamp={{ universe: form.universe, corrected: false, coverageThrough: null }}
          />
        </div>
      )}
      {showRussell2kWarning && <Russell2kWarning />}

      {/* Advanced (collapsible) */}
      <div className="mt-4 border-t border-neutral-900 pt-3">
        <button
          type="button"
          onClick={() => setShowAdvanced((v) => !v)}
          className="flex items-center gap-1.5 text-[10px] uppercase tracking-[0.25em] text-neutral-500 font-mono hover:text-neutral-300"
          aria-expanded={showAdvanced}
          aria-controls="launcher-advanced"
          data-testid="advanced-toggle"
        >
          {showAdvanced ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
          Advanced
        </button>
        {showAdvanced && (
          <div
            id="launcher-advanced"
            className="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-3"
            data-testid="advanced-section"
          >
            <div>
              <FieldLabel hint="0..100">Min composite</FieldLabel>
              <NumberInput
                value={form.minComposite}
                onChange={(v) => update('minComposite', v)}
                min={0}
                max={100}
                step={1}
                ariaInvalid={!!(touched && errors.minComposite)}
                dataTestid="min-composite"
              />
              <FieldError msg={touched && errors.minComposite} />
            </div>
            <div>
              <FieldLabel hint="0.01..0.5">Max position %</FieldLabel>
              <NumberInput
                value={form.maxPositionPct}
                onChange={(v) => update('maxPositionPct', v)}
                min={0.01}
                max={0.5}
                step={0.01}
                ariaInvalid={!!(touched && errors.maxPositionPct)}
                dataTestid="max-position"
              />
              <FieldError msg={touched && errors.maxPositionPct} />
            </div>
            <div>
              <FieldLabel hint="0.05..1.0">Max sector %</FieldLabel>
              <NumberInput
                value={form.maxSectorPct}
                onChange={(v) => update('maxSectorPct', v)}
                min={0.05}
                max={1}
                step={0.05}
                ariaInvalid={!!(touched && errors.maxSectorPct)}
                dataTestid="max-sector"
              />
              <FieldError msg={touched && errors.maxSectorPct} />
            </div>
            <div>
              <FieldLabel hint="0..0.5">Cash sleeve</FieldLabel>
              <NumberInput
                value={form.cashSleeve}
                onChange={(v) => update('cashSleeve', v)}
                min={0}
                max={0.5}
                step={0.01}
                ariaInvalid={!!(touched && errors.cashSleeve)}
                dataTestid="cash-sleeve"
              />
              <FieldError msg={touched && errors.cashSleeve} />
            </div>
            <div className="col-span-2 sm:col-span-4" role="radiogroup" aria-label="Weighting">
              <FieldLabel>Weighting</FieldLabel>
              <div className="grid grid-cols-2 gap-1.5">
                <RadioPill
                  value="equal"
                  label="EQUAL"
                  subtitle="1/N across top N"
                  selected={form.weighting === 'equal'}
                  onSelect={(v) => update('weighting', v)}
                />
                <RadioPill
                  value="composite"
                  label="COMPOSITE"
                  subtitle="weight ∝ score"
                  selected={form.weighting === 'composite'}
                  onSelect={(v) => update('weighting', v)}
                />
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Result banner */}
      {mutation.isSuccess && mutation.data?.runId && (
        <div
          className="mt-4 border border-emerald-700/60 bg-emerald-950/20 px-3 py-2 font-mono text-[11px] text-emerald-200"
          data-testid="launch-success"
          role="status"
        >
          <div className="flex items-start gap-2">
            <CheckCircle2 className="h-4 w-4 text-emerald-400 shrink-0 mt-0.5" />
            <div>
              <div className="font-semibold mb-0.5">Backtest queued</div>
              <div className="text-emerald-300/80">
                runId <span className="text-emerald-200">{mutation.data.runId}</span> — it will appear in the runs list once the engine starts.
              </div>
            </div>
          </div>
        </div>
      )}

      {mutation.isError && (
        <div
          className="mt-4 border border-rose-700/60 bg-rose-950/20 px-3 py-2 font-mono text-[11px] text-rose-200"
          data-testid="launch-error"
          role="alert"
        >
          <div className="flex items-start gap-2">
            <AlertTriangle className="h-4 w-4 text-rose-400 shrink-0 mt-0.5" />
            <div className="flex-1">
              <div className="font-semibold mb-0.5">
                {mutation.error?.status === 409
                  ? 'A backtest is already running'
                  : mutation.error?.status === 400
                    ? 'Config rejected'
                    : 'Failed to launch'}
              </div>
              <div className="text-rose-300/80 leading-relaxed">
                {mutation.error?.message ?? 'Unknown error'}
              </div>
              {mutation.error?.status === 409 && mutation.error?.runId && (
                <button
                  type="button"
                  onClick={() => setSelectedRunId?.(mutation.error.runId)}
                  className="mt-1.5 underline text-rose-100 hover:text-rose-50"
                  data-testid="launch-409-deeplink"
                >
                  View existing run →
                </button>
              )}
              {mutation.error?.status !== 409 && (
                <button
                  type="button"
                  onClick={() => {
                    mutation.reset();
                    handleSubmit();
                  }}
                  className="mt-1.5 underline text-rose-100 hover:text-rose-50"
                >
                  Retry
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Submit */}
      <div className="mt-4 flex items-center justify-between gap-3">
        <a
          href="https://github.com/DavisDelivery/TradeIQ/blob/main/docs/BACKTEST_LIMITATIONS.md"
          target="_blank"
          rel="noopener noreferrer"
          className="text-[10px] font-mono text-neutral-500 hover:text-neutral-300 inline-flex items-center gap-1"
        >
          Limitations <ExternalLink className="h-3 w-3" />
        </a>
        <button
          type="button"
          onClick={handleSubmit}
          disabled={mutation.isPending || (touched && hasErrors)}
          data-testid="launch-submit"
          className="px-4 py-2 border border-emerald-700/60 bg-emerald-950/30 text-emerald-200 hover:bg-emerald-950/60 disabled:opacity-40 disabled:cursor-not-allowed font-mono text-[11px] uppercase tracking-[0.25em] font-semibold transition-colors"
        >
          {mutation.isPending ? (
            <span className="inline-flex items-center gap-2">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> Launching…
            </span>
          ) : (
            'Run backtest'
          )}
        </button>
      </div>
    </div>
  );
}

// Exported for unit testing without spinning up the full form.
export const __test_internals = { validateForm, buildConfig, DEFAULT_CONFIG };
