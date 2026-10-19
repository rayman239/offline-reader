// Minimal promise wrapper around IndexedDB.
// Stores:
//   files  — mirror of repo files: { key: "<repo>:<path>", repo, path, sha, text? | blob? }
//   shas   — key "<repo>:<path>" -> blob sha (lets sync compare without loading contents)
//   kv     — small settings/state values
//   outbox — pending writes to GitHub, processed in order

const DB_NAME = 'offline-reader';
const VERSION = 1;
let dbp;

function open() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('files')) {
        const s = db.createObjectStore('files', { keyPath: 'key' });
        s.createIndex('repo', 'repo');
      }
      if (!db.objectStoreNames.contains('shas')) db.createObjectStore('shas');
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
      if (!db.objectStoreNames.contains('outbox')) db.createObjectStore('outbox', { keyPath: 'id', autoIncrement: true });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}

function wrap(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function store(name, mode = 'readonly') {
  const db = await open();
  return db.transaction(name, mode).objectStore(name);
}

export const db = {
  async get(name, key) { return wrap((await store(name)).get(key)); },
  async put(name, value, key) { return wrap((await store(name, 'readwrite')).put(value, key)); },
  async del(name, key) { return wrap((await store(name, 'readwrite')).delete(key)); },
  async all(name) { return wrap((await store(name)).getAll()); },
  async keys(name) { return wrap((await store(name)).getAllKeys()); },
  async byRepo(repo) { return wrap((await store('files')).index('repo').getAll(repo)); },
  // Map(path -> sha) for one repo, without loading file contents.
  async shasByRepo(repo) {
    const s = await store('shas');
    const range = IDBKeyRange.bound(`${repo}:`, `${repo}:\uffff`);
    const [keys, vals] = await Promise.all([wrap(s.getAllKeys(range)), wrap(s.getAll(range))]);
    return new Map(keys.map((k, i) => [k.slice(repo.length + 1), vals[i]]));
  },
  // Writes file records and their shas atomically.
  async putFiles(records) {
    const db = await open();
    const tx = db.transaction(['files', 'shas'], 'readwrite');
    for (const r of records) { tx.objectStore('files').put(r); tx.objectStore('shas').put(r.sha, r.key); }
    return new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); });
  },
  async delFiles(keys) {
    const db = await open();
    const tx = db.transaction(['files', 'shas'], 'readwrite');
    for (const k of keys) { tx.objectStore('files').delete(k); tx.objectStore('shas').delete(k); }
    return new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); });
  },
  async getMany(name, keys) {
    const s = await store(name);
    return Promise.all(keys.map(k => wrap(s.get(k))));
  },
  async putMany(name, values) {
    const db = await open();
    const tx = db.transaction(name, 'readwrite');
    const s = tx.objectStore(name);
    for (const v of values) s.put(v);
    return new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); });
  },
  async delMany(name, keys) {
    const db = await open();
    const tx = db.transaction(name, 'readwrite');
    const s = tx.objectStore(name);
    for (const k of keys) s.delete(k);
    return new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); });
  },
  async clearAll() {
    const db = await open();
    const tx = db.transaction(['files', 'shas', 'kv', 'outbox'], 'readwrite');
    for (const n of ['files', 'shas', 'kv', 'outbox']) tx.objectStore(n).clear();
    return new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); });
  },
};

export const kv = {
  get: key => db.get('kv', key),
  set: (key, value) => db.put('kv', value, key),
  del: key => db.del('kv', key),
};

export const fileKey = (repo, path) => `${repo}:${path}`;
export const getFile = (repo, path) => db.get('files', fileKey(repo, path));
