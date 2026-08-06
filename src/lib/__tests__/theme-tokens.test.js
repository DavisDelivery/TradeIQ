// THEME-1 (2026-08-06) — light is the DEFAULT theme, and it must stay complete.
//
// Light used to be an !important override layer enumerating one rule per
// utility class. An audit found 133 colour utilities in src/ with NO light
// rule — 36 of them hover/focus states — and three semantic failures below
// WCAG AA on the light page: gains 3.48:1, losses 4.34:1, warnings 2.95:1.
// The app was least readable exactly when it mattered most.
//
// Colours now resolve through CSS variables, so completeness is structural
// rather than remembered. These tests pin the two things that could quietly
// undo that: a family losing its tokens, and a light value drifting below AA.

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';

/** Every .js/.jsx under src/, excluding tests. */
function sourceFiles(dir = 'src', out = []) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) { if (e !== '__tests__') sourceFiles(p, out); }
    else if (/\.jsx?$/.test(e)) out.push(p);
  }
  return out;
}
const SOURCES = sourceFiles().map((p) => [p, readFileSync(p, 'utf8')]);

const css = readFileSync(resolve('src/index.css'), 'utf8');
const cfg = readFileSync(resolve('tailwind.config.js'), 'utf8');

const FAMILIES = ['neutral', 'emerald', 'rose', 'amber', 'sky', 'red', 'violet', 'orange', 'cyan', 'fuchsia'];

/** Pull `--c-<name>: r g b` out of a given block. */
function tokensIn(block) {
  const out = {};
  for (const m of block.matchAll(/--c-([a-z]+-\d{2,3}):\s*([\d\s]+);/g)) out[m[1]] = m[2].trim();
  return out;
}
const rootBlock = css.slice(css.indexOf(':root {'), css.indexOf('html.theme-light {'));
const lightBlock = css.slice(css.indexOf('html.theme-light {'));
const darkTokens = tokensIn(rootBlock);
const lightTokens = tokensIn(lightBlock);

function contrast(rgbStr, bgHex) {
  const chan = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  const lum = ([r, g, b]) => 0.2126 * chan(r) + 0.7152 * chan(g) + 0.0722 * chan(b);
  const fg = rgbStr.split(/\s+/).map(Number);
  const bg = [1, 3, 5].map((i) => parseInt(bgHex.slice(i, i + 2), 16));
  const [hi, lo] = [lum(fg), lum(bg)].sort((a, b) => b - a);
  return (hi + 0.05) / (lo + 0.05);
}
const LIGHT_BG = '#f5f6f8';

describe('every colour family is tokenised', () => {
  it('tailwind.config emits var() for each family, so no utility can bypass the theme', () => {
    for (const fam of FAMILIES) {
      expect(cfg, `family ${fam} missing from config`).toContain(`--c-${fam}-400`);
      expect(cfg).toContain('<alpha-value>'); // opacity modifiers must stay theme-aware
    }
  });

  it('both themes define the same token set — no shade can be light-only or dark-only', () => {
    expect(Object.keys(darkTokens).length).toBeGreaterThan(100);
    expect(Object.keys(lightTokens).sort()).toEqual(Object.keys(darkTokens).sort());
  });
});

describe('light-mode legibility (WCAG AA on the real page background)', () => {
  // Derived from ACTUAL usage, not a hand-kept list. The previous version of
  // this test hardcoded shades 200/300/400 and passed while the two most-used
  // text shades in the app were failing: text-neutral-500 (435 uses) at
  // 4.38:1 and text-neutral-600 (179 uses) at 2.33:1. A list you maintain by
  // hand tests the list, not the app.
  const used = new Map();
  for (const [, src] of SOURCES) {
    for (const m of src.matchAll(/\btext-([a-z]+)-(\d{2,3})\b/g)) {
      const key = `${m[1]}-${m[2]}`;
      used.set(key, (used.get(key) ?? 0) + 1);
    }
  }

  it('finds the text shades by scanning src, so new usage is covered automatically', () => {
    expect(used.size).toBeGreaterThan(15);
    expect(used.get('neutral-500')).toBeGreaterThan(100);
  });

  for (const [tokenName, count] of [...used.entries()].sort((x, y) => y[1] - x[1])) {
    const v = lightTokens[tokenName];
    if (!v) continue; // not a palette colour
    it(`text-${tokenName} (${count} uses) clears 4.5:1 on the light page`, () => {
      expect(contrast(v, LIGHT_BG)).toBeGreaterThanOrEqual(4.5);
    });
  }

  it('gains are not harder to read than losses — the original defect', () => {
    const gain = contrast(lightTokens['emerald-400'], LIGHT_BG);
    const loss = contrast(lightTokens['rose-400'], LIGHT_BG);
    expect(gain).toBeGreaterThanOrEqual(4.5);
    expect(Math.abs(gain - loss)).toBeLessThan(3);
  });
});

describe('surfaces are themeable (THEME-2)', () => {
  // The palette was already token-driven when the light theme still rendered
  // as a black page: every SURFACE was an arbitrary Tailwind value —
  // bg-[#050607], bg-[#0a0b0d] — which no theme can reach. Light repainted
  // the text and left the background, i.e. dark ink on near-black.
  for (const name of ['page', 'chrome', 'strip', 'rail']) {
    it(`--c-${name} is defined in both themes and exposed to Tailwind`, () => {
      expect(rootBlock).toContain(`--c-${name}:`);
      expect(lightBlock).toContain(`--c-${name}:`);
      expect(cfg).toContain(`var(--c-${name})`);
    });
  }

  it('no component paints a surface with an arbitrary hex value', () => {
    const offenders = [];
    for (const [path, src] of SOURCES) {
      for (const m of src.matchAll(/\b(?:bg|text|border|from|via|to|ring|divide)-\[#[0-9a-fA-F]{3,8}\]/g)) {
        offenders.push(`${path}: ${m[0]}`);
      }
    }
    expect(offenders.join('\n')).toBe('');
  });

  it('no chart hardcodes a colour outside chartTheme', () => {
    // Charts take colours as JS values, so they cannot inherit from CSS. They
    // must resolve through chartTheme(), which reads the same tokens.
    const offenders = [];
    for (const [path, src] of SOURCES) {
      if (path.endsWith('chartTheme.js')) continue; // owns the fallback table
      for (const line of src.split('\n')) {
        if (/^\s*(\/\/|\*|\/\*)/.test(line)) continue; // prose may cite a hex
        if (/#[0-9a-fA-F]{6}\b/.test(line)) offenders.push(`${path}: ${line.trim().slice(0, 90)}`);
      }
    }
    expect(offenders.join('\n')).toBe('');
  });
});

describe('the old override layer is gone', () => {
  it('no per-class !important colour rules remain to drift out of sync', () => {
    const perClass = css.match(/html\.theme-light\s+\.(?:text|bg|border)-[^{]*\{[^}]*!important/g) || [];
    expect(perClass).toHaveLength(0);
  });
});
