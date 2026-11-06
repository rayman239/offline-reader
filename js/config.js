// Device settings (kept in localStorage) and repo names.
import { GitHub } from './github.js';
import { kv } from './db.js';

export const LIBRARY = 'offline-reader-library';
export const VAULT = 'offline-reader-vault';

function read(key, fallback = null) {
  try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; }
}
function write(key, value) {
  try {
    if (value === null || value === undefined) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch { /* storage unavailable */ }
}

// Display preferences are also copied into IndexedDB. iOS home-screen apps write localStorage
// to disk lazily, so a change made just before the app is closed can be lost; IndexedDB writes
// are durable once they complete. localStorage stays the fast path (read before first paint).
const PREFS = ['or.theme', 'or.textSize'];
export function writePref(key, value) {
  write(key, value);
  kv.set(`pref:${key}`, value).catch(() => {});
}
// On launch: if IndexedDB holds a choice localStorage lost, put it back. Returns true if changed.
export async function restorePrefs() {
  let changed = false;
  for (const key of PREFS) {
    try {
      const saved = await kv.get(`pref:${key}`);
      const local = read(key);
      if (saved != null && saved !== local) { write(key, saved); changed = true; }
      else if (saved == null && local != null) await kv.set(`pref:${key}`, local); // first run after update
    } catch { /* IndexedDB unavailable */ }
  }
  return changed;
}

const defaultOwner = location.hostname.endsWith('.github.io') ? location.hostname.split('.')[0] : '';

export const config = {
  get token() { return read('or.token'); },
  set token(v) { write('or.token', v); },
  get owner() { return read('or.owner', defaultOwner); },
  set owner(v) { write('or.owner', v); },
  get textSize() { return read('or.textSize', 'm'); },
  set textSize(v) { writePref('or.textSize', v); },
  get configured() { return Boolean(this.token && this.owner); },
};

let client;
export function gh() {
  if (!client || client.token !== config.token || client.owner !== config.owner) {
    client = new GitHub(config.token, config.owner);
  }
  return client;
}
