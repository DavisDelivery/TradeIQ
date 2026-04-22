import React from 'react';
import {
  Users, FlaskConical, Sparkles, Zap, TrendingUp, TrendingDown,
  Landmark, Briefcase,
} from 'lucide-react';

// Reusable badge strip showing catalyst signals. Drop into any row that has
// a catalyst object.

const CHIP_BASE = 'inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-medium border rounded-sm whitespace-nowrap';

export const CatalystChip = ({ icon: Icon, label, tone = 'neutral', title }) => {
  const tones = {
    bull: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300',
    bear: 'border-rose-500/40 bg-rose-500/10 text-rose-300',
    warn: 'border-amber-500/40 bg-amber-500/10 text-amber-300',
    info: 'border-sky-500/40 bg-sky-500/10 text-sky-300',
    political: 'border-violet-500/40 bg-violet-500/10 text-violet-300',
    neutral: 'border-neutral-700 bg-neutral-900/60 text-neutral-300',
  };
  return (
    <span className={`${CHIP_BASE} ${tones[tone] || tones.neutral}`} title={title || label}>
      {Icon && <Icon className="h-3 w-3" />}
      <span>{label}</span>
    </span>
  );
};

export const CatalystBadges = ({ catalyst, max = 5 }) => {
  if (!catalyst) return null;
  const chips = [];

  if (catalyst.hasClusterBuy) {
    const count = catalyst.components?.insider?.signals?.biggestCluster ?? '';
    chips.push({
      key: 'cluster',
      icon: Users,
      label: count ? `${count}-insider cluster` : 'Cluster buy',
      tone: 'bull',
      title: catalyst.components?.insider?.rationale || 'Multiple insiders buying within 14 days',
    });
  }
  if (catalyst.hasPoliticalTailwind) {
    chips.push({
      key: 'political',
      icon: Landmark,
      label: 'Congress buying',
      tone: 'political',
      title: catalyst.components?.political?.rationale || 'Net congressional buying / lobbying acceleration',
    });
  }
  if (catalyst.hasContractWin) {
    chips.push({
      key: 'contracts',
      icon: Briefcase,
      label: 'Contract flow',
      tone: 'political',
      title: catalyst.components?.contracts?.rationale || 'Federal contract awards accelerating',
    });
  }
  if (catalyst.hasPatentBurst) {
    chips.push({
      key: 'patent',
      icon: FlaskConical,
      label: 'Patent burst',
      tone: 'info',
      title: catalyst.components?.patent?.rationale || 'Patent grant velocity accelerating',
    });
  }
  if (catalyst.hasStackedSetup) {
    chips.push({
      key: 'setup',
      icon: Sparkles,
      label: `${catalyst.setupLabels?.length || 2} setups`,
      tone: 'warn',
      title: catalyst.setupLabels?.join(' + ') || 'Multiple technical setups active',
    });
  } else if (catalyst.setupLabels && catalyst.setupLabels.length === 1) {
    chips.push({
      key: 'setup-1',
      icon: Sparkles,
      label: catalyst.setupLabels[0],
      tone: 'warn',
    });
  }

  return (
    <div className="flex flex-wrap items-center gap-1">
      {chips.slice(0, max).map((c) => (
        <CatalystChip key={c.key} icon={c.icon} label={c.label} tone={c.tone} title={c.title} />
      ))}
    </div>
  );
};

// Loose-signals adapter for legacy rows that don't have a full catalyst object
export const SignalBadges = ({ signals, max = 4 }) => {
  if (!signals) return null;
  const chips = [];
  if (signals.insiderBuying || signals.insider_buying) {
    chips.push({ key: 'ib', icon: Users, label: 'Insider buy', tone: 'bull' });
  }
  if (signals.insiderSelling || signals.insider_selling) {
    chips.push({ key: 'is', icon: Users, label: 'Insider sell', tone: 'bear' });
  }
  if (signals.politicalTailwind || signals.political_tailwind) {
    chips.push({ key: 'pol', icon: Landmark, label: 'Congress buy', tone: 'political' });
  }
  if (signals.contractWin || signals.contract_win) {
    chips.push({ key: 'gc', icon: Briefcase, label: 'Contract', tone: 'political' });
  }
  if (signals.patentMomentum || signals.patent_momentum) {
    chips.push({ key: 'pm', icon: FlaskConical, label: 'Patents', tone: 'info' });
  }
  for (const s of signals.setups || []) {
    chips.push({ key: `su-${s}`, icon: Sparkles, label: s, tone: 'warn' });
  }
  return (
    <div className="flex flex-wrap items-center gap-1">
      {chips.slice(0, max).map((c) => (
        <CatalystChip key={c.key} icon={c.icon} label={c.label} tone={c.tone} />
      ))}
    </div>
  );
};

export const ConvictionChip = ({ conviction, direction }) => {
  if (!conviction) return null;
  const toneMap = { high: 'bull', medium: 'warn', low: 'neutral' };
  const labelMap = { high: 'High conviction', medium: 'Medium', low: 'Low' };
  const Icon = direction === 'short' ? TrendingDown : direction === 'long' ? TrendingUp : Zap;
  return <CatalystChip icon={Icon} label={labelMap[conviction] || conviction} tone={toneMap[conviction] || 'neutral'} />;
};
