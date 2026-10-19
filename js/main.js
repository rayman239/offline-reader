// Boot, routing and sync scheduling.
import { config } from './config.js';
import { sync, status as syncStatus } from './sync.js';
import { flush } from './outbox.js';
import { on } from './events.js';
import { toast } from './ui.js';
import { libraryView, addSheet, normaliseUrl } from './views/library.js';
import { readerView, pagesView } from './views/reader.js';
import { themesView, themeView } from './views/themes.js';
import { setupView, settingsView } from './views/settings.js';

const root = document.getElementById('app');
let teardown = null;
let lastList = '#/';
const scrollMemory = new Map();

function route() {
  const hash = location.hash || '#/';
  if (teardown) { teardown(); teardown = null; }
  const prevKey = route.current;
  if (prevKey) scrollMemory.set(prevKey, scrollY);
  route.current = hash;

  if (!config.configured) { setupView(root); return; }

  const [, section, arg] = hash.match(/^#\/?([^/]*)\/?(.*)$/) || [];
  const param = arg ? decodeURIComponent(arg) : '';
  switch (section) {
    case '': lastList = '#/'; teardown = libraryView(root, { tab: 'unread' }); break;
    case 'archive': lastList = '#/archive'; teardown = libraryView(root, { tab: 'archive' }); break;
    case 'themes': teardown = param ? themeView(root, { name: param }) : themesView(root); break;
    case 'read': teardown = readerView(root, { id: param, back: lastList }); break;
    case 'pages': teardown = pagesView(root, { id: param }); break;
    case 'settings': teardown = settingsView(root); break;
    default: location.replace('#/'); return;
  }
  // Lists restore their scroll position; everything else starts at the top.
  const y = section === 'read' ? 0 : (scrollMemory.get(hash) || 0);
  requestAnimationFrame(() => window.scrollTo(0, y));
}

addEventListener('hashchange', route);

// ?add=<url> (from a bookmarklet or shortcut) opens the save sheet prefilled.
function handleAddParam() {
  const params = new URLSearchParams(location.search);
  const add = params.get('add') || params.get('url') || params.get('text');
  if (!add) return;
  history.replaceState(null, '', location.pathname + (location.hash || '#/'));
  if (config.configured) addSheet(normaliseUrl(add) || add);
}

// On laptops: pasting a link anywhere (outside a text field) offers to save it.
addEventListener('paste', e => {
  if (!config.configured || e.target.closest('input, textarea')) return;
  const url = normaliseUrl(e.clipboardData && e.clipboardData.getData('text'));
  if (url) { e.preventDefault(); addSheet(url); }
});

on('auth-error', () => toast('GitHub rejected the key — reconnect in Settings', 5000));

// Sync on start, when coming back to the app, and every few minutes while open.
// After saving something, check more often until it has been processed.
let fastUntil = 0;
on('queued', () => { fastUntil = Date.now() + 6 * 60e3; });
let lastAuto = 0;
function autoSync(force) {
  if (!config.configured || document.visibilityState !== 'visible') return;
  const gap = Date.now() < fastUntil ? 20e3 : 5 * 60e3;
  if (force || Date.now() - lastAuto > gap) { lastAuto = Date.now(); sync(); }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') { autoSync(Date.now() - lastAuto > 60e3); flush(); }
});
setInterval(() => autoSync(false), 10e3);

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(e => console.warn('Service worker failed', e));
}
if (navigator.storage && navigator.storage.persist && config.configured) {
  navigator.storage.persisted().then(p => p || navigator.storage.persist()).catch(() => {});
}

route();
handleAddParam();
if (config.configured) autoSync(true);
window.offlineReader = { sync, syncStatus }; // handy for debugging from the console
