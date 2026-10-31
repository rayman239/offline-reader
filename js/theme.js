// Light / dark appearance: "auto" follows the device, or a fixed choice. Stored per device.
// index.html applies the same logic inline before first paint, so there's no flash.
const KEY = 'or.theme';
const COLORS = { light: '#f8f2e3', dark: '#161616' };
const media = window.matchMedia('(prefers-color-scheme: dark)');

export const THEMES = [['auto', 'Auto'], ['light', 'Light'], ['dark', 'Dark']];

export function getTheme() {
  try { return localStorage.getItem(KEY) || 'auto'; } catch { return 'auto'; }
}

export function setTheme(choice) {
  try { localStorage.setItem(KEY, choice); } catch { /* storage unavailable */ }
  applyTheme();
}

export function applyTheme() {
  const choice = getTheme();
  const resolved = choice === 'auto' ? (media.matches ? 'dark' : 'light') : choice;
  document.documentElement.dataset.theme = resolved;
  for (const m of document.querySelectorAll('meta[name="theme-color"]')) {
    m.removeAttribute('media');
    m.content = COLORS[resolved];
  }
}

// In Auto, follow the device when it switches (e.g. at sunset).
media.addEventListener('change', () => { if (getTheme() === 'auto') applyTheme(); });
