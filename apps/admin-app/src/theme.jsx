import React, { useState } from 'react';

// Bright theme by default; the choice is a per-browser convenience only.
const KEY = 'sentinelpay-theme';
const read = () => { try { return localStorage.getItem(KEY) || 'light'; } catch { return 'light'; } };

export function initTheme() { document.documentElement.dataset.theme = read(); }

export function ThemeToggle() {
  const [theme, setTheme] = useState(read);
  const next = theme === 'light' ? 'dark' : 'light';
  const flip = () => {
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem(KEY, next); } catch { /* private mode: keep it for this page only */ }
    setTheme(next);
  };
  return (
    <button type="button" className="theme-toggle" onClick={flip} title={`Switch to the ${next} theme`}>
      <span aria-hidden="true">{theme === 'light' ? '🌙' : '☀️'}</span><span className="tt-l">{theme === 'light' ? 'Dark' : 'Light'}</span>
    </button>
  );
}
