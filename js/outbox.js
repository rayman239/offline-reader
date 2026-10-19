// Pending writes to GitHub. Every change the app makes is queued here first, so it
// works offline; the queue is flushed in order whenever we're online.
// Views show the "optimistic" state by applying pending ops on top of the synced files
// (see pending() and the helpers in library.js).
import { db, kv } from './db.js';
import { gh, config, LIBRARY, VAULT } from './config.js';
import { utf8ToBase64, bytesToBase64 } from './github.js';
import { emit } from './events.js';

export async function enqueue(op) {
  await db.put('outbox', { ...op, created: Date.now(), tries: 0 });
  emit('outbox');
  flush();
}

export async function pending() {
  return (await db.all('outbox')).sort((a, b) => a.id - b.id);
}

let flushing = null;
export function flush() {
  if (flushing) return flushing;
  flushing = run().finally(() => { flushing = null; });
  return flushing;
}

async function run() {
  if (!navigator.onLine || !config.configured) return;
  for (const op of await pending()) {
    try {
      await handlers[op.type](op);
      await db.del('outbox', op.id);
      emit('outbox');
    } catch (e) {
      if (e.offline || e.rateLimited || !e.status || e.status >= 500) return; // try again later
      if (e.status === 401) { emit('auth-error'); return; }
      op.tries += 1;
      op.error = e.message;
      if (op.tries >= 5) {
        // Give up on this one so it doesn't block everything behind it.
        const dead = (await kv.get('deadOps')) || [];
        dead.push(op);
        await kv.set('deadOps', dead.slice(-50));
        await db.del('outbox', op.id);
        console.error('Dropped change after 5 attempts', op, e);
      } else {
        await db.put('outbox', op);
      }
      emit('outbox');
      return;
    }
  }
  emit('outbox-flushed');
}

// Read-modify-write with retry if someone else changed the file in between.
async function update(repo, path, fn, message) {
  const { storeFile } = await import('./sync.js');
  for (let attempt = 0; attempt < 4; attempt++) {
    const cur = await gh().getText(repo, path);
    const next = fn(cur ? cur.text : null);
    if (next === null || (cur && next === cur.text)) {
      if (cur) await storeFile(repo, path, cur.sha, cur.text);
      return;
    }
    try {
      const sha = await gh().putFile(repo, path, utf8ToBase64(next), message, cur && cur.sha);
      await storeFile(repo, path, sha, next);
      return;
    } catch (e) {
      if (e.status !== 409 && e.status !== 422) throw e;
    }
  }
  throw Object.assign(new Error('File kept changing'), { status: 409 });
}

export const parseJson = (text, fallback) => {
  if (!text) return fallback;
  try { return JSON.parse(text); } catch { return fallback; }
};

export function applyHighlightOp(list, op) {
  if (op.type === 'hlAdd') return [...list.filter(h => h.id !== op.hl.id), op.hl];
  if (op.type === 'hlRemove') return list.filter(h => h.id !== op.hlId);
  return list;
}

// Appends a clip entry to a theme file. Never touches existing content.
export function appendEntry(text, entry) {
  const base = text || '';
  if (!base.trim()) return entry.trimEnd() + '\n';
  return base.replace(/\s*$/, '') + '\n\n' + entry.trimEnd() + '\n';
}

function stamp() {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '') + '-' + Math.random().toString(36).slice(2, 6);
}

const handlers = {
  async state(op) {
    await update(LIBRARY, `items/${op.itemId}/state.json`,
      () => JSON.stringify({ status: op.status, updated: new Date(op.created).toISOString() }, null, 2) + '\n',
      `${op.status === 'archived' ? 'Archive' : 'Unarchive'} ${op.itemId}`);
  },

  async hlAdd(op) {
    await update(LIBRARY, `items/${op.itemId}/highlights.json`,
      text => JSON.stringify(applyHighlightOp(parseJson(text, []), op), null, 2) + '\n',
      `Highlight in ${op.itemId}`);
  },

  async hlRemove(op) {
    await update(LIBRARY, `items/${op.itemId}/highlights.json`,
      text => (text ? JSON.stringify(applyHighlightOp(parseJson(text, []), op), null, 2) + '\n' : null),
      `Remove highlight in ${op.itemId}`);
  },

  async clip(op) {
    await update(VAULT, `${op.theme}.md`,
      text => (text && text.includes(`clip:${op.clipId}`) ? null : appendEntry(text, op.entry)),
      `Clip to ${op.theme}`);
  },

  async queueLink(op) {
    const path = `queue/${stamp()}.json`;
    const body = JSON.stringify({ url: op.url, added: new Date(op.created).toISOString(), replace: op.replace || undefined });
    await gh().putFile(LIBRARY, path, utf8ToBase64(body), `Save ${op.url}`);
    await noteQueued(path);
  },

  async queuePdf(op) {
    const safe = op.name.replace(/\.pdf$/i, '').replace(/[^\w .()-]+/g, '').trim().slice(0, 80) || 'document';
    const path = `queue/${stamp()}--${safe}.pdf`;
    const bytes = new Uint8Array(await op.blob.arrayBuffer());
    await gh().putFile(LIBRARY, path, bytesToBase64(bytes), `Save PDF ${safe}`);
    await noteQueued(path);
  },

  async deleteItem(op) {
    const list = (await kv.get(`list:${LIBRARY}`)) || [];
    const prefix = `items/${op.itemId}/`;
    const paths = list.filter(e => e.path.startsWith(prefix)).map(e => e.path);
    if (paths.length) await gh().deletePaths(LIBRARY, paths, `Delete ${op.itemId}`);
    const keys = (await db.shasByRepo(LIBRARY));
    await db.delFiles([...keys.keys()].filter(p => p.startsWith(prefix)).map(p => `${LIBRARY}:${p}`));
  },
};

// Show a just-queued item as "processing" until the next sync lists it.
async function noteQueued(path) {
  const q = (await kv.get('remoteQueue')) || [];
  if (!q.includes(path)) q.push(path);
  await kv.set('remoteQueue', q);
  emit('queued');
}
