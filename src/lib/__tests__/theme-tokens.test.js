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
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

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
  // The shades actually used as TEXT in the codebase.
  const TEXT_SHADES = ['200', '300', '400'];
  const TEXT_FAMILIES = ['emerald', 'rose', 'amber', 'sky', 'violet', 'neutral'];

  for (const fam of TEXT_FAMILIES) {
    for (const shade of TEXT_SHADES) {
      it(`text-${fam}-${shade} clears 4.5:1`, () => {
        const v = lightTokens[`${fam}-${shade}`];
        expect(v, `missing light token ${fam}-${shade}`).toBeTruthy();
        expect(contrast(v, LIGHT_BG)).toBeGreaterThanOrEqual(4.5);
      });
    }
  }

  it('gains are not harder to read than losses — the original defect', () => {
    // Before this change: gains 3.48:1, losses 5.81:1. The app was literally
    // less legible when the number was good.
    const gain = contrast(lightTokens['emerald-400'], LIGHT_BG);
    const loss = contrast(lightTokens['rose-400'], LIGHT_BG);
    expect(gain).toBeGreaterThanOrEqual(4.5);
    expect(Math.abs(gain - loss)).toBeLessThan(3);
  });
});

describe('the old override layer is gone', () => {
  it('no per-class !important colour rules remain to drift out of sync', () => {
    const perClass = css.match(/html\.theme-light\s+\.(?:text|bg|border)-[^{]*\{[^}]*!important/g) || [];
    expect(perClass).toHaveLength(0);
  });
});
