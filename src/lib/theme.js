// Theme control. The app is built with hardcoded dark Tailwind classes;
// light mode is an override layer in index.css scoped to `html.theme-light`
// (see the LIGHT THEME block there). Default is LIGHT — the owner asked for
// a readable, non-dark UI. Toggle persists to localStorage and applies the
// class on <html> so there's no flash (applied in main.jsx before render).

export const THEME_KEY = 'tradeiq-theme';

export function getTheme() {
  try {
    const t = localStorage.getItem(THEME_KEY);
    return t === 'dark' || t === 'light' ? t : 'light';
  } catch {
    return 'light';
  }
}

export function applyTheme(theme) {
  const light = theme === 'light';
  document.documentElement.classList.toggle('theme-light', light);
}

export function setTheme(theme) {
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    /* private mode — session-only */
  }
  applyTheme(theme);
}

export function toggleTheme() {
  const next = getTheme() === 'light' ? 'dark' : 'light';
  setTheme(next);
  return next;
}
