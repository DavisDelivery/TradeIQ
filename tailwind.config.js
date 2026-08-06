/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx,ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      // THEME-1 (2026-08-06) — colour is now token-driven.
      //
      // Light used to be a ~60-rule !important override layer in index.css,
      // and it leaked: 133 colour utilities in src/ had no light rule at all,
      // 36 of them hover/focus states. Every new class was a new hole, and
      // three of the ones that leaked were semantic — gains rendered at
      // 3.48:1, losses 4.34:1 and warnings 2.95:1 against the light page,
      // all below WCAG AA. The app was hardest to read when you were winning.
      //
      // Emitting rgb(var(--c-*) / <alpha-value>) means EVERY utility resolves
      // through a variable: every shade, every opacity modifier, every
      // hover/focus/group variant, and every class not written yet. Flipping
      // the theme is now one block of variable values, not a per-class
      // enumeration that can drift.
      colors: {
        // THEME-2 (2026-08-06) — SURFACES.
        //
        // The palette below was already token-driven, but every surface in
        // the app was an arbitrary value: bg-[#050607] for the page,
        // bg-[#0a0b0d] for the header/sidebar/drawer/modals, bg-[#090a0c]
        // for the strips. Arbitrary values cannot be themed, so switching to
        // light repainted the TEXT dark and left the page black — dark ink
        // on a near-black page, which is how "light mode" shipped.
        //
        // Naming the surfaces is what closes that hole. Alpha modifiers keep
        // working (`bg-chrome/95` under a backdrop-blur), and a surface can
        // never again be introduced as an un-themeable literal.
        page: 'rgb(var(--c-page) / <alpha-value>)',
        chrome: 'rgb(var(--c-chrome) / <alpha-value>)',
        strip: 'rgb(var(--c-strip) / <alpha-value>)',
        rail: 'rgb(var(--c-rail) / <alpha-value>)',
        neutral: {
          '50': 'rgb(var(--c-neutral-50) / <alpha-value>)',
          '100': 'rgb(var(--c-neutral-100) / <alpha-value>)',
          '200': 'rgb(var(--c-neutral-200) / <alpha-value>)',
          '300': 'rgb(var(--c-neutral-300) / <alpha-value>)',
          '400': 'rgb(var(--c-neutral-400) / <alpha-value>)',
          '500': 'rgb(var(--c-neutral-500) / <alpha-value>)',
          '600': 'rgb(var(--c-neutral-600) / <alpha-value>)',
          '700': 'rgb(var(--c-neutral-700) / <alpha-value>)',
          '800': 'rgb(var(--c-neutral-800) / <alpha-value>)',
          '900': 'rgb(var(--c-neutral-900) / <alpha-value>)',
          '950': 'rgb(var(--c-neutral-950) / <alpha-value>)',
        },
        emerald: {
          '50': 'rgb(var(--c-emerald-50) / <alpha-value>)',
          '100': 'rgb(var(--c-emerald-100) / <alpha-value>)',
          '200': 'rgb(var(--c-emerald-200) / <alpha-value>)',
          '300': 'rgb(var(--c-emerald-300) / <alpha-value>)',
          '400': 'rgb(var(--c-emerald-400) / <alpha-value>)',
          '500': 'rgb(var(--c-emerald-500) / <alpha-value>)',
          '600': 'rgb(var(--c-emerald-600) / <alpha-value>)',
          '700': 'rgb(var(--c-emerald-700) / <alpha-value>)',
          '800': 'rgb(var(--c-emerald-800) / <alpha-value>)',
          '900': 'rgb(var(--c-emerald-900) / <alpha-value>)',
          '950': 'rgb(var(--c-emerald-950) / <alpha-value>)',
        },
        rose: {
          '50': 'rgb(var(--c-rose-50) / <alpha-value>)',
          '100': 'rgb(var(--c-rose-100) / <alpha-value>)',
          '200': 'rgb(var(--c-rose-200) / <alpha-value>)',
          '300': 'rgb(var(--c-rose-300) / <alpha-value>)',
          '400': 'rgb(var(--c-rose-400) / <alpha-value>)',
          '500': 'rgb(var(--c-rose-500) / <alpha-value>)',
          '600': 'rgb(var(--c-rose-600) / <alpha-value>)',
          '700': 'rgb(var(--c-rose-700) / <alpha-value>)',
          '800': 'rgb(var(--c-rose-800) / <alpha-value>)',
          '900': 'rgb(var(--c-rose-900) / <alpha-value>)',
          '950': 'rgb(var(--c-rose-950) / <alpha-value>)',
        },
        amber: {
          '50': 'rgb(var(--c-amber-50) / <alpha-value>)',
          '100': 'rgb(var(--c-amber-100) / <alpha-value>)',
          '200': 'rgb(var(--c-amber-200) / <alpha-value>)',
          '300': 'rgb(var(--c-amber-300) / <alpha-value>)',
          '400': 'rgb(var(--c-amber-400) / <alpha-value>)',
          '500': 'rgb(var(--c-amber-500) / <alpha-value>)',
          '600': 'rgb(var(--c-amber-600) / <alpha-value>)',
          '700': 'rgb(var(--c-amber-700) / <alpha-value>)',
          '800': 'rgb(var(--c-amber-800) / <alpha-value>)',
          '900': 'rgb(var(--c-amber-900) / <alpha-value>)',
          '950': 'rgb(var(--c-amber-950) / <alpha-value>)',
        },
        sky: {
          '50': 'rgb(var(--c-sky-50) / <alpha-value>)',
          '100': 'rgb(var(--c-sky-100) / <alpha-value>)',
          '200': 'rgb(var(--c-sky-200) / <alpha-value>)',
          '300': 'rgb(var(--c-sky-300) / <alpha-value>)',
          '400': 'rgb(var(--c-sky-400) / <alpha-value>)',
          '500': 'rgb(var(--c-sky-500) / <alpha-value>)',
          '600': 'rgb(var(--c-sky-600) / <alpha-value>)',
          '700': 'rgb(var(--c-sky-700) / <alpha-value>)',
          '800': 'rgb(var(--c-sky-800) / <alpha-value>)',
          '900': 'rgb(var(--c-sky-900) / <alpha-value>)',
          '950': 'rgb(var(--c-sky-950) / <alpha-value>)',
        },
        red: {
          '50': 'rgb(var(--c-red-50) / <alpha-value>)',
          '100': 'rgb(var(--c-red-100) / <alpha-value>)',
          '200': 'rgb(var(--c-red-200) / <alpha-value>)',
          '300': 'rgb(var(--c-red-300) / <alpha-value>)',
          '400': 'rgb(var(--c-red-400) / <alpha-value>)',
          '500': 'rgb(var(--c-red-500) / <alpha-value>)',
          '600': 'rgb(var(--c-red-600) / <alpha-value>)',
          '700': 'rgb(var(--c-red-700) / <alpha-value>)',
          '800': 'rgb(var(--c-red-800) / <alpha-value>)',
          '900': 'rgb(var(--c-red-900) / <alpha-value>)',
          '950': 'rgb(var(--c-red-950) / <alpha-value>)',
        },
        violet: {
          '50': 'rgb(var(--c-violet-50) / <alpha-value>)',
          '100': 'rgb(var(--c-violet-100) / <alpha-value>)',
          '200': 'rgb(var(--c-violet-200) / <alpha-value>)',
          '300': 'rgb(var(--c-violet-300) / <alpha-value>)',
          '400': 'rgb(var(--c-violet-400) / <alpha-value>)',
          '500': 'rgb(var(--c-violet-500) / <alpha-value>)',
          '600': 'rgb(var(--c-violet-600) / <alpha-value>)',
          '700': 'rgb(var(--c-violet-700) / <alpha-value>)',
          '800': 'rgb(var(--c-violet-800) / <alpha-value>)',
          '900': 'rgb(var(--c-violet-900) / <alpha-value>)',
          '950': 'rgb(var(--c-violet-950) / <alpha-value>)',
        },
        orange: {
          '50': 'rgb(var(--c-orange-50) / <alpha-value>)',
          '100': 'rgb(var(--c-orange-100) / <alpha-value>)',
          '200': 'rgb(var(--c-orange-200) / <alpha-value>)',
          '300': 'rgb(var(--c-orange-300) / <alpha-value>)',
          '400': 'rgb(var(--c-orange-400) / <alpha-value>)',
          '500': 'rgb(var(--c-orange-500) / <alpha-value>)',
          '600': 'rgb(var(--c-orange-600) / <alpha-value>)',
          '700': 'rgb(var(--c-orange-700) / <alpha-value>)',
          '800': 'rgb(var(--c-orange-800) / <alpha-value>)',
          '900': 'rgb(var(--c-orange-900) / <alpha-value>)',
          '950': 'rgb(var(--c-orange-950) / <alpha-value>)',
        },
        cyan: {
          '50': 'rgb(var(--c-cyan-50) / <alpha-value>)',
          '100': 'rgb(var(--c-cyan-100) / <alpha-value>)',
          '200': 'rgb(var(--c-cyan-200) / <alpha-value>)',
          '300': 'rgb(var(--c-cyan-300) / <alpha-value>)',
          '400': 'rgb(var(--c-cyan-400) / <alpha-value>)',
          '500': 'rgb(var(--c-cyan-500) / <alpha-value>)',
          '600': 'rgb(var(--c-cyan-600) / <alpha-value>)',
          '700': 'rgb(var(--c-cyan-700) / <alpha-value>)',
          '800': 'rgb(var(--c-cyan-800) / <alpha-value>)',
          '900': 'rgb(var(--c-cyan-900) / <alpha-value>)',
          '950': 'rgb(var(--c-cyan-950) / <alpha-value>)',
        },
        fuchsia: {
          '50': 'rgb(var(--c-fuchsia-50) / <alpha-value>)',
          '100': 'rgb(var(--c-fuchsia-100) / <alpha-value>)',
          '200': 'rgb(var(--c-fuchsia-200) / <alpha-value>)',
          '300': 'rgb(var(--c-fuchsia-300) / <alpha-value>)',
          '400': 'rgb(var(--c-fuchsia-400) / <alpha-value>)',
          '500': 'rgb(var(--c-fuchsia-500) / <alpha-value>)',
          '600': 'rgb(var(--c-fuchsia-600) / <alpha-value>)',
          '700': 'rgb(var(--c-fuchsia-700) / <alpha-value>)',
          '800': 'rgb(var(--c-fuchsia-800) / <alpha-value>)',
          '900': 'rgb(var(--c-fuchsia-900) / <alpha-value>)',
          '950': 'rgb(var(--c-fuchsia-950) / <alpha-value>)',
        },
      },
      fontFamily: {
        serif: ['"IBM Plex Serif"', 'Georgia', 'serif'],
        mono: ['"IBM Plex Mono"', 'ui-monospace', 'monospace'],
        sans: ['Sora', 'system-ui', 'sans-serif'],
      },
    },
  },
  plugins: [],
};
