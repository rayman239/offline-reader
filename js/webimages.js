// Images the library couldn't download (some sites block GitHub's servers) are kept in the
// article as web links. This device downloads them itself and keeps them for offline reading:
//   - as a normal file in IndexedDB when the site allows it (CORS), or
//   - in the Cache API otherwise, from where the service worker serves it to <img> offline.
import { db, fileKey, getFile } from './db.js';

export const WEB_CACHE = 'offline-reader-web-images';
const REPO = 'web';

const opts = mode => ({ mode, credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store' });

async function inCache(url) {
  if (!('caches' in self)) return false;
  return Boolean(await (await caches.open(WEB_CACHE)).match(url));
}

// Downloads one image for offline use. Returns true if it's now stored.
export async function saveWebImage(url) {
  if (await getFile(REPO, url) || await inCache(url)) return true;
  try {
    const res = await fetch(url, opts('cors'));
    if (res.ok && (res.headers.get('content-type') || '').startsWith('image/')) {
      const blob = await res.blob();
      await db.putFiles([{ key: fileKey(REPO, url), repo: REPO, path: url, sha: 'web', blob }]);
      return true;
    }
  } catch { /* no CORS — fall through */ }
  try {
    const res = await fetch(url, opts('no-cors'));
    if (res.type === 'opaque' || res.ok) {
      await (await caches.open(WEB_CACHE)).put(url, res);
      return true;
    }
  } catch { /* offline or blocked */ }
  return false;
}

// Best source for an <img>: a stored copy, or the web address (served from the cache offline).
export async function webImageSrc(url) {
  const f = await getFile(REPO, url);
  if (f && f.blob) return { src: URL.createObjectURL(f.blob), blob: true };
  if (navigator.onLine || await inCache(url)) return { src: url, blob: false };
  return null;
}

export const WEB_IMAGE_RE = /!\[[^\]\n]*\]\((https?:\/\/[^)\s]+)\)/g;
export function webImageUrls(md) {
  return [...(md || '').matchAll(WEB_IMAGE_RE)].map(m => m[1]);
}
