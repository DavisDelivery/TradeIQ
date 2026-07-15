import React, { useState } from 'react';
import { Sun, Moon } from 'lucide-react';
import { getTheme, toggleTheme } from '../lib/theme.js';

// Light/dark toggle. Reads the current theme on mount and flips <html>'s
// theme class on click (persisted to localStorage). Default is light.
export function ThemeToggle({ className = '' }) {
  const [theme, setThemeState] = useState(getTheme());
  const onClick = () => setThemeState(toggleTheme());
  const isLight = theme === 'light';
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={isLight ? 'Switch to dark theme' : 'Switch to light theme'}
      title={isLight ? 'Dark theme' : 'Light theme'}
      data-testid="theme-toggle"
      className={
        'inline-flex items-center justify-center h-8 w-8 border border-neutral-800 ' +
        'text-neutral-500 hover:text-neutral-200 hover:border-neutral-600 transition-colors ' +
        className
      }
    >
      {isLight ? <Moon className="h-4 w-4" /> : <Sun className="h-4 w-4" />}
    </button>
  );
}
