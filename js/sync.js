// Mirrors the library and vault repos into IndexedDB so everything is readable offline.
// Only files whose blob sha changed are downloaded; progress is saved file by file,
// so an interrupted sync simply resumes next time.
import { db, kv, fileKey } from './db.js';
import { gh, config, LIBRARY, VAULT } from './config.js';
import { flush, parseJson } from './outbox.js';
import { emit } from './events.js';
import { saveWebImage, webImageUrls } from './webimages.js';

const TEXT_RE = /\.(md|json|txt)$/i;
const TEXT_BATCH = 40;
const BINARY_CONCURRENCY = 4;

function wantLibrary(path) {
  if (path === 'index.json') return true;
  if (!path.startsWith('items/')) return false;
  return !path.endsWith('/original.pdf'); // page images cover "view original"
}

function wantVault(path) {
  return path.endsWith('.md') && !path.split('/').some(seg => seg.startsWith('.'));
}

function priority(repo, path) {
  if (path === 'index.json') return 0;
  if (repo === VAULT) return 1;
  if (path.endsWith('/state.json') || path.endsWith('/highlights.json')) return 2;
  if (path.endsWith('/article.md')) return 3;
  if (path.includes('/images/')) return 4;
  return 5; // PDF page images
}

export const status = {
  running: false, done: 0, total: 0, error: null, offline: !navigator.onLine,
  lastSync: null, rateLimitedUntil: 0,
};

function setStatus(patch) {
  Object.assign(status, patch);
  emit('sync-status', status);
}

kv.get('lastSync').then(v => setStatus({ lastSync: v || null })).catch(() => {});

let running = null;
export function sync(opts = {}) {
  if (running) return running;
  running = run(opts).finally(() => { running = null; });
  return running;
}

async function run({ force = false } = {}) {
  if (!config.configured) return;
  if (!navigator.onLine) { setStatus({ offline: true }); return; }
  if (Date.now() < status.rateLimitedUntil) return;
  setStatus({ running: true, error: null, offline: false, done: 0, total: 0 });
  try {
    await flush();
    const plans = [];
    for (const [repo, want] of [[LIBRARY, wantLibrary], [VAULT, wantVault]]) {
      plans.push(await plan(repo, want, force));
    }
    const removed = plans.some(p => p.removed);
    const todo = plans.flatMap(p => p.todo.map(e => ({ ...e, repo: p.repo, prio: priority(p.repo, e.path) })))
      // Lower priority number first; within a tier, newest items first (ids start with the date).
      .sort((a, b) => a.prio - b.prio || b.path.localeCompare(a.path));
    setStatus({ total: todo.length });
    if (removed) emit('synced', { partial: true });
    await download(todo);
    await saveWebImages();
    await flush();
    const now = Date.now();
    await kv.set('lastSync', now);
    setStatus({ running: false, lastSync: now });
    emit('synced', {});
  } catch (e) {
    console.warn('Sync failed', e);
    const patch = { running: false, error: e.message };
    if (e.offline) { patch.offline = true; patch.error = null; }
    if (e.rateLimited) patch.rateLimitedUntil = e.reset || Date.now() + 15 * 60e3;
    if (e.status === 401) emit('auth-error');
    setStatus(patch);
    emit('synced', { partial: true });
  }
}

async function plan(repo, want, force) {
  const etagKey = `etag:${repo}`;
  const listKey = `list:${repo}`;
  const r = await gh().tree(repo, force ? null : await kv.get(etagKey));
  let list;
  if (r.notModified) {
    list = (await kv.get(listKey)) || [];
  } else {
    list = r.tree.filter(e => e.type === 'blob').map(e => ({ path: e.path, sha: e.sha, size: e.size || 0 }));
    if (r.truncated) console.warn(`${repo}: file listing truncated by GitHub`);
    await kv.set(listKey, list);
    if (r.etag) await kv.set(etagKey, r.etag);
  }
  if (repo === LIBRARY) {
    const queue = list.filter(e => e.path.startsWith('queue/') && !e.path.endsWith('.gitkeep')).map(e => e.path);
    await kv.set('remoteQueue', queue);
  }

  const wanted = list.filter(e => want(e.path));
  const wantedPaths = new Set(wanted.map(e => e.path));
  const local = await db.shasByRepo(repo);
  const stale = [...local.keys()].filter(p => !wantedPaths.has(p)).map(p => fileKey(repo, p));
  if (stale.length) await db.delFiles(stale);
  const todo = wanted.filter(e => local.get(e.path) !== e.sha);
  return { repo, todo, removed: stale.length > 0 };
}

// Downloads, on this device, the images the library kept as web links (see webimages.js).
async function saveWebImages() {
  const idx = parseJson((await db.get('files', fileKey(LIBRARY, 'index.json')))?.text, { items: [] });
  const ids = idx.items.filter(i => i.remoteImages > 0).map(i => i.id);
  if (!ids.length) return;
  const recs = await db.getMany('files', ids.map(id => fileKey(LIBRARY, `items/${id}/article.md`)));
  const urls = [...new Set(recs.filter(Boolean).flatMap(r => webImageUrls(r.text)))];
  let saved = 0;
  for (const u of urls) if (await saveWebImage(u)) saved++;
  if (saved) emit('images-updated');
}

// Opening an article while online fetches its images straight away, ahead of the rest of the sync.
export async function fetchItemNow(id) {
  if (!navigator.onLine || !config.configured) return;
  const list = (await kv.get(`list:${LIBRARY}`)) || [];
  const have = await db.shasByRepo(LIBRARY);
  const prefix = `items/${id}/`;
  const todo = list.filter(e => e.path.startsWith(prefix) && !TEXT_RE.test(e.path)
    && !e.path.endsWith('/original.pdf') && have.get(e.path) !== e.sha);
  let next = 0;
  const worker = async () => {
    while (next < todo.length) {
      const e = todo[next++];
      try {
        const blob = await gh().blobRaw(LIBRARY, e.sha);
        await db.putFiles([{ key: fileKey(LIBRARY, e.path), repo: LIBRARY, path: e.path, sha: e.sha, blob }]);
      } catch { /* the regular sync will retry */ }
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, todo.length) }, worker));
  const f = await db.get('files', fileKey(LIBRARY, `${prefix}article.md`));
  for (const u of webImageUrls(f && f.text)) await saveWebImage(u);
  emit('images-updated');
}

// Records a file as present locally (used by sync and by the outbox after a write).
export async function storeFile(repo, path, sha, content) {
  const rec = { key: fileKey(repo, path), repo, path, sha };
  if (typeof content === 'string') rec.text = content; else rec.blob = content;
  await db.putFiles([rec]);
}

async function download(todo) {
  let done = 0;
  const tick = n => { done += n; setStatus({ done }); };
  const text = todo.filter(e => TEXT_RE.test(e.path));
  const binary = todo.filter(e => !TEXT_RE.test(e.path));

  // Text files: batched through GraphQL, grouped per repo.
  for (const repo of [LIBRARY, VAULT]) {
    const files = text.filter(e => e.repo === repo);
    for (let i = 0; i < files.length; i += TEXT_BATCH) {
      const batch = files.slice(i, i + TEXT_BATCH);
      const texts = await gh().blobTexts(repo, [...new Set(batch.map(e => e.sha))]);
      const records = [];
      for (const e of batch) {
        let t = texts.get(e.sha);
        if (t == null) t = await (await gh().blobRaw(repo, e.sha)).text(); // large file
        records.push({ key: fileKey(repo, e.path), repo, path: e.path, sha: e.sha, text: t });
      }
      await db.putFiles(records);
      tick(batch.length);
      if (batch.some(e => e.prio <= 3)) emit('synced', { partial: true });
    }
  }

  // Images: a few in parallel, saved as they arrive.
  let next = 0;
  let lastEmit = Date.now();
  async function worker() {
    while (next < binary.length) {
      const e = binary[next++];
      const blob = await gh().blobRaw(e.repo, e.sha);
      await db.putFiles([{ key: fileKey(e.repo, e.path), repo: e.repo, path: e.path, sha: e.sha, blob }]);
      tick(1);
      if (Date.now() - lastEmit > 3000) { lastEmit = Date.now(); emit('images-updated'); }
    }
  }
  await Promise.all(Array.from({ length: Math.min(BINARY_CONCURRENCY, binary.length) }, worker));
  if (binary.length) emit('images-updated');
}

window.addEventListener('online', () => { setStatus({ offline: false }); sync(); });
window.addEventListener('offline', () => setStatus({ offline: true }));
