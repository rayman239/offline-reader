// Library: Unread / Feed / Archive lists, tag filter, search, and the "add" sheet.
import { loadItems, loadFeeds, processing, hostOf } from '../library.js';
import { db, fileKey } from '../db.js';
import { LIBRARY } from '../config.js';
import { enqueue } from '../outbox.js';
import { status as syncStatus, sync } from '../sync.js';
import { on } from '../events.js';
import { swipeRows } from '../swipe.js';
import { esc, el, icons, sheet, toast, confirmSheet, readingTime, shortDate, ago } from '../ui.js';

let bodies = null; // id -> lowercase article text, loaded on first search
let state = { tag: null, q: '' };

export function libraryView(root, { tab }) {
  const page = el(`
    <div class="page">
      <header class="top">
        <nav class="tabs">
          <a href="#/" data-tab="unread">Unread<span class="count"></span></a>
          <a href="#/feed" data-tab="feed">Feed<span class="count"></span></a>
          <a href="#/archive" data-tab="archive">Archive</a>
          <a href="#/themes" data-tab="themes">Themes</a>
        </nav>
        <div class="actions">
          <button class="icon-btn" data-add aria-label="Save a link or PDF">${icons.plus}</button>
          <a class="icon-btn" href="#/settings" aria-label="Settings">${icons.gear}</a>
        </div>
      </header>
      <input class="search" type="search" placeholder="Search" autocomplete="off" enterkeyhint="search">
      <div class="feedbar hidden"></div>
      <div class="tagbar"></div>
      <ul class="list"></ul>
      <div class="syncline"></div>
    </div>`);
  root.replaceChildren(page);
  page.querySelector(`[data-tab="${tab}"]`).classList.add('active');

  const search = page.querySelector('.search');
  const list = page.querySelector('.list');
  const tagbar = page.querySelector('.tagbar');
  search.value = state.q;
  page.querySelector('[data-add]').onclick = () => addSheet();

  let renderToken = 0;
  async function render() {
    const my = ++renderToken;
    const [items, proc, feedInfo] = await Promise.all([loadItems(), processing(), loadFeeds()]);
    if (my !== renderToken) return;
    const unreadCount = items.filter(i => !i.inFeed && i.status !== 'archived').length;
    const feedCount = items.filter(i => i.inFeed && i.status !== 'archived').length;
    page.querySelector('[data-tab="unread"] .count').textContent = unreadCount ? ` ${unreadCount}` : '';
    page.querySelector('[data-tab="feed"] .count').textContent = feedCount ? ` ${feedCount}` : '';

    let shown = tab === 'feed'
      ? items.filter(i => i.inFeed).sort((a, b) => String(b.published || b.saved).localeCompare(String(a.published || a.saved)))
      : items.filter(i => !i.inFeed && (tab === 'archive' ? i.status === 'archived' : i.status !== 'archived'));
    const feedbar = page.querySelector('.feedbar');
    feedbar.classList.toggle('hidden', tab !== 'feed');
    if (tab === 'feed') {
      const n = feedInfo.feeds.length;
      const problems = feedInfo.feeds.filter(f => feedInfo.status[f.id]?.error).length;
      feedbar.innerHTML = `<a href="#/newsletters">${n ? `${n} newsletter${n === 1 ? '' : 's'}` : 'Follow a newsletter'}${problems ? ` · <span class="warn">${problems} with a problem</span>` : ''} ›</a>
        <span>Posts leave after 30 days unless you keep them.</span>`;
    }
    // The theme filter bar only shows on Archive; Unread stays uncluttered.
    const tags = tab === 'archive' ? [...new Set(shown.flatMap(i => i.tags))].sort((a, b) => a.localeCompare(b)) : [];
    if (state.tag && !tags.includes(state.tag)) state.tag = null;
    tagbar.innerHTML = tags.map(t => `<button class="tag ${t === state.tag ? 'on' : ''}" data-tag="${esc(t)}">${esc(t)}</button>`).join('');
    tagbar.classList.toggle('hidden', !tags.length);
    if (state.tag) shown = shown.filter(i => i.tags.includes(state.tag));

    const q = state.q.trim().toLowerCase();
    if (q) shown = items; // search covers everything: Unread, Feed and Archive
    if (q) {
      if (!bodies) await loadBodies(items);
      const terms = q.split(/\s+/);
      shown = shown
        .map(i => {
          const head = `${i.title} ${i.site || ''} ${i.author || ''} ${i.tags.join(' ')}`.toLowerCase();
          const body = bodies.get(i.id) || '';
          const hit = terms.every(t => head.includes(t) || body.includes(t));
          return hit ? { i, score: terms.filter(t => head.includes(t)).length } : null;
        })
        .filter(Boolean).sort((a, b) => b.score - a.score).map(x => x.i);
    }
    if (my !== renderToken) return;

    const rows = [];
    if (tab === 'unread' && !q && !state.tag) {
      for (const p of proc) {
        rows.push(`<li class="row processing"><div class="title">${esc(p.label)}</div>
          <div class="meta"><span>${esc(p.error ? `Retrying — ${p.error}` : p.detail)}</span></div></li>`);
      }
    }
    for (const i of shown) rows.push(i.status === 'failed' ? failedRow(i) : i.inFeed ? feedRow(i) : itemRow(i, tab));
    if (!rows.length) {
      list.innerHTML = `<li class="empty">${emptyText(tab, q, items.length, feedInfo.feeds.length)}</li>`;
    } else {
      list.innerHTML = rows.join('');
    }
    renderSync();
  }

  function renderSync() {
    const s = syncStatus;
    const line = page.querySelector('.syncline');
    let text;
    if (s.offline) text = 'Offline — everything here is readable';
    else if (s.running && s.total) text = `Downloading ${s.done} of ${s.total}`;
    else if (s.running) text = 'Syncing…';
    else if (s.error) text = `Sync problem: ${esc(s.error)} · <button data-sync>Retry</button>`;
    else text = `Synced ${ago(s.lastSync)}`;
    line.innerHTML = text;
    const b = line.querySelector('[data-sync]');
    if (b) b.onclick = () => sync({ force: true });
  }

  tagbar.addEventListener('click', e => {
    const t = e.target.closest('[data-tag]');
    if (!t) return;
    state.tag = state.tag === t.dataset.tag ? null : t.dataset.tag;
    render();
  });
  let debounce;
  search.addEventListener('input', () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => { state.q = search.value; render(); }, 150);
  });
  list.addEventListener('click', async e => {
    const retry = e.target.closest('[data-retry]');
    const remove = e.target.closest('[data-remove]');
    if (retry) {
      e.preventDefault();
      await enqueue({ type: 'queueLink', url: retry.dataset.url, replace: retry.dataset.retry });
      toast('Trying again…');
    } else if (remove) {
      e.preventDefault();
      if (await confirmSheet({ title: 'Remove this item?', confirm: 'Remove', danger: true })) {
        await enqueue({ type: 'deleteItem', itemId: remove.dataset.remove });
      }
    }
  });

  // Swipe a row left: Delete and Archive (or Unread). A long swipe archives straight away.
  // Feed rows: Keep and Read (or Unread); a long swipe marks the post read.
  const offSwipe = swipeRows(list, async (act, id) => {
    const inFeed = tab === 'feed' || Boolean(list.querySelector(`li[data-id="${CSS.escape(id)}"][data-feed]`));
    if (act === 'keep') {
      await enqueue({ type: 'state', itemId: id, status: 'unread', kept: true });
      toast('Kept — it’s in Unread now');
    } else if (act === 'delete') {
      const ok = await confirmSheet({
        title: 'Delete this item?',
        body: 'It will be removed from every device. Clips already in your theme files are kept.',
        confirm: 'Delete', danger: true,
      });
      if (!ok) return false;
      await enqueue({ type: 'deleteItem', itemId: id });
      toast('Deleted');
    } else {
      const status = act === 'archive' ? 'archived' : 'unread';
      await enqueue({ type: 'state', itemId: id, status });
      toast(inFeed ? (status === 'archived' ? 'Marked as read' : 'Marked as unread') : status === 'archived' ? 'Archived' : 'Moved to Unread');
    }
  });

  const offs = [
    offSwipe,
    on('synced', () => { bodies = null; render(); }),
    on('outbox', render),
    on('queued', render),
    on('sync-status', renderSync),
  ];
  const tickTimer = setInterval(renderSync, 30000);
  render();
  return () => { offs.forEach(f => f()); clearInterval(tickTimer); };
}

function itemRow(i, tab) {
  const facts = [
    i.site || hostOf(i.source),
    i.type === 'pdf' ? 'PDF' : '',
    i.words ? readingTime(i.words) : '',
    shortDate(i.saved),
  ].filter(Boolean).join(', ');
  const meta = `<span>${esc(facts)}</span>` + i.tags.map(t => `<span class="t">${esc(t)}</span>`).join('');
  const first = tab === 'archive' ? '<button data-act="unread" tabindex="-1">Unread</button>' : '<button data-act="archive" tabindex="-1">Archive</button>';
  return `<li class="swipe" data-id="${esc(i.id)}">
    <div class="swipe-actions"><button data-act="delete" tabindex="-1">Delete</button>${first}</div>
    <a class="row" href="#/read/${encodeURIComponent(i.id)}"><div class="title">${esc(i.title)}</div><div class="meta">${meta}</div></a></li>`;
}

const DAY = 86400e3;

function feedRow(i) {
  const when = Date.parse(i.published || i.saved);
  const left = Math.ceil((when + 30 * DAY - Date.now()) / DAY);
  const facts = [
    i.feedName || i.site || hostOf(i.source),
    i.words ? readingTime(i.words) : '',
    shortDate(i.published || i.saved),
  ].filter(Boolean).join(', ');
  const expiry = left <= 5 ? `<span class="t">${left <= 1 ? 'leaves today' : `${left} days left`}</span>` : '';
  const read = i.status === 'archived';
  return `<li class="swipe" data-id="${esc(i.id)}" data-feed>
    <div class="swipe-actions"><button data-act="keep" tabindex="-1">Keep</button><button data-act="${read ? 'unread' : 'archive'}" tabindex="-1">${read ? 'Unread' : 'Read'}</button></div>
    <a class="row${read ? ' read' : ''}" href="#/read/${encodeURIComponent(i.id)}"><div class="title">${esc(i.title)}</div><div class="meta"><span>${esc(facts)}</span>${expiry}</div></a></li>`;
}

function failedRow(i) {
  return `<li class="row failed"><div class="title">${esc(i.source || i.title)}</div>
    <div class="meta"><span>${esc(i.error || 'Couldn\'t save this.')}</span></div>
    <div class="row-actions">
      ${i.source ? `<button data-retry="${esc(i.id)}" data-url="${esc(i.source)}">Try again</button>` : ''}
      ${i.source ? `<a class="link-btn" href="${esc(i.source)}" target="_blank" rel="noopener">Open original</a>` : ''}
      <button data-remove="${esc(i.id)}">Remove</button>
    </div></li>`;
}

function emptyText(tab, q, total, feeds) {
  if (q) return '<p>Nothing matches.</p>';
  if (tab === 'feed') {
    return feeds
      ? '<p>No new posts in the last 30 days.</p><p class="mono">New posts appear here as your newsletters publish them.</p>'
      : '<p>Your Feed is empty.</p><p class="mono"><a href="#/newsletters">Follow a newsletter</a> and its new posts will appear here.</p>';
  }
  if (tab === 'archive') return '<p>Nothing archived yet.</p><p class="mono">Finished items go here.</p>';
  if (!total) return '<p>Your reading list is empty.</p><p class="mono">Tap + to save a link or a PDF.</p>';
  return '<p>All read.</p>';
}

async function loadBodies(items) {
  bodies = new Map();
  const recs = await db.getMany('files', items.map(i => fileKey(LIBRARY, `items/${i.id}/article.md`)));
  recs.forEach((r, n) => { if (r) bodies.set(items[n].id, r.text.toLowerCase()); });
}

// ---------- add sheet ----------

export function addSheet(prefill = '') {
  const s = sheet(`
    <h2>Save to Offline Reader</h2>
    <input class="field mono" type="url" inputmode="url" placeholder="Paste a link" autocomplete="off" autocapitalize="off" spellcheck="false" enterkeyhint="go" value="${esc(prefill)}">
    <div class="buttons"><button class="btn primary" data-save>Save link</button></div>
    <div class="divider">or</div>
    <label class="btn" style="justify-content:center;width:100%">Choose a PDF…<input type="file" accept="application/pdf,.pdf" hidden></label>
    <p class="note">Articles take about a minute to appear; PDFs a few minutes. You can close the app meanwhile.</p>`);
  const input = s.root.querySelector('input[type=url]');
  const file = s.root.querySelector('input[type=file]');
  setTimeout(() => input.focus(), 250);
  const save = async () => {
    const url = normaliseUrl(input.value);
    if (!url) { toast('That doesn\'t look like a link'); return; }
    await enqueue({ type: 'queueLink', url });
    s.close();
    toast(navigator.onLine ? 'Saved — processing…' : 'Saved — will send when online');
  };
  s.root.querySelector('[data-save]').onclick = save;
  input.addEventListener('keydown', e => { if (e.key === 'Enter') save(); });
  file.addEventListener('change', async () => {
    const f = file.files[0];
    if (!f) return;
    if (f.size > 90 * 1024 * 1024) { toast('That PDF is too large (over 90 MB)'); return; }
    await enqueue({ type: 'queuePdf', name: f.name, blob: f });
    s.close();
    toast(navigator.onLine ? 'Uploading PDF…' : 'PDF saved — will upload when online');
  });
}

export function normaliseUrl(text) {
  const m = /(https?:\/\/[^\s<>"']+)/i.exec((text || '').trim());
  if (m) return m[1];
  if (/^[\w-]+(\.[\w-]+)+(\/\S*)?$/.test((text || '').trim())) return `https://${text.trim()}`;
  return null;
}
