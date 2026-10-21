// The library as the views see it: synced files + pending (not yet sent) changes.
import { db, kv, fileKey, getFile } from './db.js';
import { LIBRARY, VAULT, config } from './config.js';
import { pending, parseJson, applyHighlightOp, appendEntry } from './outbox.js';

export function parseFrontmatter(text) {
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(text || '');
  if (!m) return { meta: {}, body: text || '' };
  const meta = {};
  for (const line of m[1].split('\n')) {
    const i = line.indexOf(':');
    if (i < 0) continue;
    const raw = line.slice(i + 1).trim();
    try { meta[line.slice(0, i).trim()] = JSON.parse(raw); } catch { meta[line.slice(0, i).trim()] = raw; }
  }
  return { meta, body: text.slice(m[0].length) };
}

// Removes the publication's name from a page title. Kept identical to cleanTitle()
// in the library processor (processor/common.mjs), which applies it to new saves;
// here it also tidies items saved before that existed.
export function cleanTitle(title, site, url) {
  const norm = s => (s || '').toLowerCase().replace(/^the\s+/, '').replace(/[^a-z0-9]/g, '');
  // "en.wikipedia.org" → "wikipedia", "worksinprogress.co" → "worksinprogress"
  const root = h => {
    const labels = h.replace(/^www\./, '').split('.');
    return labels.length > 1 ? labels.slice(0, -1).sort((a, b) => b.length - a.length)[0] : labels[0];
  };
  let host = '';
  try { host = root(new URL(url).hostname); } catch { /* no url */ }
  const siteName = /^[\w-]+(\.[\w-]+)+$/.test(site || '') ? root(site) : site;
  const names = [norm(siteName), norm(host)].filter(n => n.length >= 4);
  if (!names.length || !title) return title;
  // A segment is the publication's name if it matches exactly, or differs only by a word
  // like "Magazine" or "News" ("Works in Progress Magazine" vs "worksinprogress").
  const EXTRA = /^(magazine|mag|news|blog|online|daily|weekly|review|journal|newsletter|com|co|org|net|io)?$/;
  const isName = seg => {
    const n = norm(seg);
    if (n.length < 3) return false;
    return names.some(x => (n.startsWith(x) && EXTRA.test(n.slice(x.length)))
      || (x.startsWith(n) && EXTRA.test(x.slice(n.length))));
  };
  const SEP = '\\s+[|\\-–—·•»]\\s+';
  let t = title.trim();
  const tail = new RegExp(`^(.*\\S)${SEP}([^|–—·•»]+)$`).exec(t);
  if (tail && isName(tail[2])) t = tail[1].trim();
  const head = new RegExp(`^([^|–—·•»:]+?)(?:${SEP}|:\\s+)(.+)$`).exec(t);
  if (head && isName(head[1]) && head[2].trim().length > 10) t = head[2].trim();
  return t || title;
}

export const themeName = file => file.replace(/\.md$/, '');
export const themeFile = name => `${name}.md`;
export function cleanThemeName(name) {
  return name.replace(/[\\/:*?"<>|#^[\]%]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
}

// ---------- items ----------

export async function loadItems() {
  const [idxFile, list, ops] = await Promise.all([
    getFile(LIBRARY, 'index.json'), kv.get(`list:${LIBRARY}`), pending(),
  ]);
  const index = parseJson(idxFile && idxFile.text, { items: [] });
  const present = new Set((list || []).map(e => e.path));
  const deleting = new Set(ops.filter(o => o.type === 'deleteItem').map(o => o.itemId));

  // Items processed since the last index build are picked up from their article.md.
  const known = new Set(index.items.map(i => i.id));
  const extraIds = [...present].filter(p => /^items\/[^/]+\/article\.md$/.test(p))
    .map(p => p.split('/')[1]).filter(id => !known.has(id));
  const extra = (await db.getMany('files', extraIds.map(id => fileKey(LIBRARY, `items/${id}/article.md`))))
    .filter(Boolean).map(f => ({ ...parseFrontmatter(f.text).meta, id: f.path.split('/')[1] }));

  let items = [...index.items, ...extra]
    .filter(i => !deleting.has(i.id))
    .filter(i => !list || present.has(`items/${i.id}/article.md`));

  const keys = items.flatMap(i => [fileKey(LIBRARY, `items/${i.id}/state.json`), fileKey(LIBRARY, `items/${i.id}/highlights.json`)]);
  const recs = await db.getMany('files', keys);
  items = items.map((item, n) => {
    const state = parseJson(recs[n * 2] && recs[n * 2].text, {});
    let highlights = parseJson(recs[n * 2 + 1] && recs[n * 2 + 1].text, []);
    let status = state.status || 'unread';
    for (const op of ops) {
      if (op.itemId !== item.id) continue;
      if (op.type === 'state') status = op.status;
      else highlights = applyHighlightOp(highlights, op);
    }
    const tags = [...new Set(highlights.flatMap(h => h.themes || []))].sort();
    const title = item.type === 'pdf' ? item.title : cleanTitle(item.title, item.site, item.source);
    return { ...item, title, status, highlights, tags };
  });
  items.sort((a, b) => String(b.saved).localeCompare(String(a.saved)));
  return items;
}

export async function loadItem(id) {
  const items = await loadItems();
  const item = items.find(i => i.id === id);
  if (!item) return null;
  const f = await getFile(LIBRARY, `items/${id}/article.md`);
  return { ...item, body: f ? parseFrontmatter(f.text).body : '' };
}

export async function itemBlob(id, rel) {
  const f = await getFile(LIBRARY, `items/${id}/${rel}`);
  return f && f.blob;
}

export async function pageCount(id) {
  const shas = await db.shasByRepo(LIBRARY);
  return [...shas.keys()].filter(p => p.startsWith(`items/${id}/pages/`)).length;
}

// Things saved but not yet processed: pending sends + files waiting in queue/.
export async function processing() {
  const [ops, remote] = await Promise.all([pending(), kv.get('remoteQueue')]);
  const out = [];
  for (const op of ops) {
    if (op.type === 'queueLink' && !op.replace) out.push({ label: hostOf(op.url), detail: 'Waiting to send', error: op.error });
    if (op.type === 'queuePdf') out.push({ label: op.name, detail: 'Waiting to send', error: op.error });
  }
  for (const p of remote || []) {
    const name = p.replace(/^queue\//, '');
    out.push({ label: name.endsWith('.pdf') ? name.replace(/^[\dT]+(-\w{4})?--/, '') : 'Link', detail: 'Processing…' });
  }
  return out;
}

export function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url || ''; }
}

// ---------- themes ----------

export async function loadThemes() {
  const [files, ops] = await Promise.all([db.byRepo(VAULT), pending()]);
  const map = new Map(files.map(f => [f.path, f.text || '']));
  for (const op of ops) {
    if (op.type !== 'clip') continue;
    const path = themeFile(op.theme);
    const cur = map.get(path) || '';
    if (!cur.includes(`clip:${op.clipId}`)) map.set(path, appendEntry(cur, op.entry));
  }
  return [...map.entries()]
    .filter(([path]) => !path.includes('/'))
    .map(([path, text]) => ({
      name: themeName(path), path, text,
      count: (text.match(/%%\s*clip:/g) || []).length,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function sourceLink(item) {
  if (item.source) return item.source;
  return `https://github.com/${config.owner}/${LIBRARY}/blob/main/items/${item.id}/original.pdf`;
}
