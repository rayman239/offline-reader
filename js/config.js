// Device settings (kept in localStorage) and repo names.
import { GitHub } from './github.js';

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

const defaultOwner = location.hostname.endsWith('.github.io') ? location.hostname.split('.')[0] : '';

export const config = {
  get token() { return read('or.token'); },
  set token(v) { write('or.token', v); },
  get owner() { return read('or.owner', defaultOwner); },
  set owner(v) { write('or.owner', v); },
  get textSize() { return read('or.textSize', 'm'); },
  set textSize(v) { write('or.textSize', v); },
  get configured() { return Boolean(this.token && this.owner); },
};

let client;
export function gh() {
  if (!client || client.token !== config.token || client.owner !== config.owner) {
    client = new GitHub(config.token, config.owner);
  }
  return client;
}
