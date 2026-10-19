// Reader: distraction-free article view, highlights and clipping.
import { loadItem, loadThemes, sourceLink, cleanThemeName, itemBlob, pageCount, hostOf } from '../library.js';
import { renderArticle, attachImages, releaseImages } from '../render.js';
import { describe, paint } from '../highlight.js';
import { enqueue } from '../outbox.js';
import { kv } from '../db.js';
import { config } from '../config.js';
import { on } from '../events.js';
import { esc, el, icons, sheet, toast, confirmSheet, readingTime, longDate, uid } from '../ui.js';

const SIZES = ['s', 'm', 'l'];

export function readerView(root, { id, back = '#/' }) {
  let item = null;
  let lastAnchor = null;
  let destroyed = false;

  const page = el(`
    <div class="reader size-${config.textSize}">
      <div class="progress"></div>
      <header class="bar">
        <a class="icon-btn" href="${esc(back)}" aria-label="Back to library">${icons.back}</a>
        <span class="spacer"></span>
        <button class="label" data-size aria-label="Text size">Aa</button>
        <button class="label hidden" data-pages>Pages</button>
        <button class="label" data-archive>Archive</button>
        <button class="icon-btn" data-more aria-label="More">${icons.more}</button>
      </header>
      <div class="page">
        <article class="doc">
          <h1 class="title"></h1>
          <p class="byline"></p>
          <div class="content"></div>
          <footer class="end">
            <button class="btn" data-archive-end>Archive</button>
            <a class="link-btn" data-original target="_blank" rel="noopener">Open original</a>
          </footer>
        </article>
      </div>
      <button class="clip-fab" data-clip>Clip</button>
    </div>`);
  root.replaceChildren(page);
  const content = page.querySelector('.content');
  const bar = page.querySelector('.bar');
  const fab = page.querySelector('[data-clip]');
  const progress = page.querySelector('.progress');

  async function load(first) {
    const fresh = await loadItem(id);
    if (destroyed) return;
    if (!fresh) {
      if (first) page.querySelector('.doc').innerHTML = '<div class="empty"><p>This item isn\'t on this device yet.</p><p class="mono">It will appear after the next sync.</p></div>';
      return;
    }
    const bodyChanged = !item || item.body !== fresh.body;
    item = fresh;
    document.title = item.title;
    page.querySelector('.title').textContent = item.title;
    const by = [
      `<a href="${esc(sourceLink(item))}" target="_blank" rel="noopener">${esc(item.site || hostOf(item.source) || 'PDF')}</a>`,
      item.author ? `<span>${esc(item.author)}</span>` : '',
      item.published ? `<span>${esc(longDate(new Date(item.published)))}</span>` : '',
      item.words ? `<span>${readingTime(item.words)}</span>` : '',
    ].join('');
    page.querySelector('.byline').innerHTML = by;
    page.querySelector('[data-original]').href = sourceLink(item);
    const archived = item.status === 'archived';
    page.querySelector('[data-archive]').textContent = archived ? 'Unarchive' : 'Archive';
    page.querySelector('[data-archive]').classList.toggle('on', archived);
    page.querySelector('[data-archive-end]').textContent = archived ? 'Move back to Unread' : 'Done — archive';
    if (item.type === 'pdf') {
      const n = await pageCount(item.id);
      page.querySelector('[data-pages]').classList.toggle('hidden', !n);
    }
    if (bodyChanged) {
      await renderArticle(content, item);
      if (first) restorePosition();
    }
    paint(content, item.highlights);
  }

  // ---------- reading position ----------
  const posKey = `pos:${id}`;
  async function restorePosition() {
    const pos = await kv.get(posKey);
    if (pos && pos > 0) {
      requestAnimationFrame(() => window.scrollTo(0, pos * (document.documentElement.scrollHeight - innerHeight)));
    }
  }
  let saveTimer;
  let lastY = scrollY;
  function onScroll() {
    const max = document.documentElement.scrollHeight - innerHeight;
    const frac = max > 0 ? Math.min(1, scrollY / max) : 0;
    progress.style.width = `${frac * 100}%`;
    const dy = scrollY - lastY;
    if (scrollY < 60 || dy < -8) bar.classList.remove('away');
    else if (dy > 8) bar.classList.add('away');
    if (Math.abs(dy) > 8) lastY = scrollY;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => kv.set(posKey, frac), 400);
  }
  addEventListener('scroll', onScroll, { passive: true });

  // Tapping the very top of the screen brings the bar back.
  function onTapTop(e) {
    if (e.clientY < 50 && !e.target.closest('.bar')) bar.classList.remove('away');
  }
  page.addEventListener('click', onTapTop);

  // ---------- controls ----------
  page.querySelector('[data-size]').onclick = () => {
    const next = SIZES[(SIZES.indexOf(config.textSize) + 1) % SIZES.length];
    config.textSize = next;
    page.classList.remove('size-s', 'size-m', 'size-l');
    page.classList.add(`size-${next}`);
  };
  const toggleArchive = async () => {
    if (!item) return;
    const status = item.status === 'archived' ? 'unread' : 'archived';
    await enqueue({ type: 'state', itemId: item.id, status });
    toast(status === 'archived' ? 'Archived' : 'Moved to Unread');
    if (status === 'archived') setTimeout(() => { location.hash = back; }, 350);
  };
  page.querySelector('[data-archive]').onclick = toggleArchive;
  page.querySelector('[data-archive-end]').onclick = toggleArchive;
  page.querySelector('[data-pages]').onclick = () => { location.hash = `#/pages/${encodeURIComponent(id)}`; };
  page.querySelector('[data-more]').onclick = () => moreSheet(item);

  // ---------- selection → Clip ----------
  function selectionInContent() {
    const sel = getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
    const r = sel.getRangeAt(0);
    if (!content.contains(r.commonAncestorContainer)) return null;
    return { range: r, text: sel.toString() };
  }
  function onSelection() {
    const s = selectionInContent();
    if (s && s.text.trim().length > 1) {
      const anchor = describe(content, s.range);
      if (anchor) {
        lastAnchor = { ...anchor, quote: s.text };
        fab.classList.add('show');
        return;
      }
    }
    fab.classList.remove('show');
  }
  let selTimer;
  const onSelChange = () => { clearTimeout(selTimer); selTimer = setTimeout(onSelection, 120); };
  document.addEventListener('selectionchange', onSelChange);
  // Keep the selection alive when pressing the button.
  fab.addEventListener('pointerdown', e => e.preventDefault());
  fab.addEventListener('mousedown', e => e.preventDefault());
  fab.addEventListener('click', () => {
    if (!lastAnchor || !item) return;
    const anchor = lastAnchor;
    fab.classList.remove('show');
    clipSheet(item, anchor, () => load(false));
  });

  // Tapping a highlight shows what it was clipped to.
  content.addEventListener('click', e => {
    const m = e.target.closest('mark.hl');
    if (!m || selectionInContent()) return;
    const hl = item && item.highlights.find(h => h.id === m.dataset.id);
    if (hl) highlightSheet(item, hl);
  });

  const offs = [
    on('synced', () => load(false)),
    on('outbox', () => load(false)),
    on('images-updated', () => item && attachImages(content, item.id, true)),
  ];
  load(true);

  return () => {
    destroyed = true;
    removeEventListener('scroll', onScroll);
    document.removeEventListener('selectionchange', onSelChange);
    offs.forEach(f => f());
    releaseImages();
    document.title = 'Offline Reader';
  };
}

// ---------- clip sheet ----------

async function clipSheet(item, anchor, done) {
  const themes = await loadThemes();
  const recent = (await kv.get('recentThemes')) || [];
  // Recently used themes first, then the rest alphabetically.
  const names = [...new Set([...recent, ...themes.map(t => t.name)])];
  const chosen = new Set();
  const quote = anchor.quote.trim();

  const s = sheet(`
    <h2>Clip</h2>
    <blockquote class="quote ${quote.length < 260 ? 'short' : ''}">${esc(quote)}</blockquote>
    <div class="label">Theme</div>
    <div class="chips"></div>
    <input class="field" data-new placeholder="New theme…" autocomplete="off" enterkeyhint="done" style="margin-top:10px">
    <div class="label">Thought</div>
    <textarea class="field" data-thought placeholder="Optional — what did this spark?"></textarea>
    <div class="buttons">
      <button class="btn" data-cancel>Cancel</button>
      <button class="btn primary" data-save disabled>Clip</button>
    </div>`);
  const chips = s.root.querySelector('.chips');
  const save = s.root.querySelector('[data-save]');
  const newInput = s.root.querySelector('[data-new]');

  function drawChips() {
    chips.innerHTML = names.map(n => `<button class="chip ${chosen.has(n) ? 'on' : ''}" data-name="${esc(n)}">${esc(n)}</button>`).join('')
      || '<span class="note" style="margin:0">No themes yet — type one below.</span>';
    save.disabled = !chosen.size && !cleanThemeName(newInput.value);
  }
  chips.addEventListener('click', e => {
    const c = e.target.closest('[data-name]');
    if (!c) return;
    const n = c.dataset.name;
    chosen.has(n) ? chosen.delete(n) : chosen.add(n);
    drawChips();
  });
  const addNew = () => {
    const n = cleanThemeName(newInput.value);
    if (!n) return;
    const existing = names.find(x => x.toLowerCase() === n.toLowerCase());
    const name = existing || n;
    if (!existing) names.unshift(name);
    chosen.add(name);
    newInput.value = '';
    drawChips();
  };
  newInput.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); addNew(); } });
  newInput.addEventListener('input', drawChips);
  newInput.addEventListener('blur', addNew);
  s.root.querySelector('[data-cancel]').onclick = () => s.close();
  drawChips();

  save.onclick = async () => {
    addNew();
    if (!chosen.size) return;
    save.disabled = true;
    const thought = s.root.querySelector('[data-thought]').value.trim();
    const clipId = uid();
    const themesChosen = [...chosen];
    const hl = {
      id: clipId, exact: anchor.exact, prefix: anchor.prefix, suffix: anchor.suffix, start: anchor.start,
      themes: themesChosen, thought: thought || undefined, created: new Date().toISOString(),
    };
    const entry = buildEntry({ quote, item, thought, clipId });
    await enqueue({ type: 'hlAdd', itemId: item.id, hl });
    for (const theme of themesChosen) await enqueue({ type: 'clip', theme, clipId, entry });
    await kv.set('recentThemes', [...themesChosen, ...recent.filter(r => !chosen.has(r))].slice(0, 30));
    getSelection().removeAllRanges();
    s.close();
    toast(`Clipped to ${themesChosen.join(', ')}`);
    done();
  };
}

export function buildEntry({ quote, item, thought, clipId, date = new Date() }) {
  const q = quote.split(/\n+/).map(l => l.trim()).filter(Boolean).map(l => `> ${l}`).join('\n>\n');
  const title = item.title.replace(/([*_[\]\\])/g, '\\$1');
  let s = `${q}\n\n— *${title}* · [source](<${sourceLink(item)}>) · ${longDate(date)}\n`;
  if (thought) {
    const [first, ...rest] = thought.split('\n');
    s += `**Thought:** ${first}\n${rest.length ? rest.join('\n') + '\n' : ''}`;
  }
  s += `%% clip:${clipId} %%\n`;
  return s;
}

function highlightSheet(item, hl) {
  const s = sheet(`
    <h2>Highlight</h2>
    <blockquote class="quote ${hl.exact.length < 260 ? 'short' : ''}">${esc(hl.exact)}</blockquote>
    <div class="hl-themes">${(hl.themes || []).map(t => `<a class="chip" href="#/themes/${encodeURIComponent(t)}">${esc(t)}</a>`).join('')}</div>
    ${hl.thought ? `<p class="thought">${esc(hl.thought)}</p>` : ''}
    <p class="note">Removing the highlight only removes it here. The clip stays in your theme files.</p>
    <div class="buttons">
      <button class="btn danger" data-remove>Remove highlight</button>
      <button class="btn" data-close>Done</button>
    </div>`);
  s.root.querySelector('[data-close]').onclick = () => s.close();
  s.root.querySelector('.hl-themes').addEventListener('click', () => s.close());
  s.root.querySelector('[data-remove]').onclick = async () => {
    await enqueue({ type: 'hlRemove', itemId: item.id, hlId: hl.id });
    s.close();
    toast('Highlight removed');
  };
}

function moreSheet(item) {
  if (!item) return;
  const s = sheet(`
    <h2>${esc(item.title)}</h2>
    <div class="stack" style="display:grid;gap:10px">
      <a class="btn" href="${esc(sourceLink(item))}" target="_blank" rel="noopener">Open original</a>
      ${item.source ? '<button class="btn" data-copy>Copy link</button>' : ''}
      <button class="btn danger" data-delete>Delete from library</button>
    </div>
    <div class="buttons"><button class="btn" data-close>Close</button></div>`);
  s.root.querySelector('[data-close]').onclick = () => s.close();
  const copy = s.root.querySelector('[data-copy]');
  if (copy) copy.onclick = async () => {
    try { await navigator.clipboard.writeText(item.source); toast('Link copied'); } catch { toast('Couldn\'t copy'); }
    s.close();
  };
  s.root.querySelector('[data-delete]').onclick = async () => {
    s.close();
    const ok = await confirmSheet({
      title: 'Delete this item?',
      body: 'It will be removed from every device. Clips already in your theme files are kept.',
      confirm: 'Delete', danger: true,
    });
    if (!ok) return;
    await enqueue({ type: 'deleteItem', itemId: item.id });
    toast('Deleted');
    location.hash = '#/';
  };
}

// ---------- original PDF pages ----------

export function pagesView(root, { id }) {
  const page = el(`
    <div class="reader">
      <header class="bar">
        <a class="icon-btn" href="#/read/${encodeURIComponent(id)}" aria-label="Back to text">${icons.back}</a>
        <span class="spacer"></span><span class="label">Original pages</span>
      </header>
      <div class="page"><div class="doc pages"></div></div>
    </div>`);
  root.replaceChildren(page);
  const wrap = page.querySelector('.pages');
  const urls = [];
  (async () => {
    const n = await pageCount(id);
    for (let i = 1; i <= n; i++) {
      const blob = await itemBlob(id, `pages/${String(i).padStart(3, '0')}.webp`);
      const img = document.createElement('img');
      img.alt = `Page ${i}`;
      img.loading = 'lazy';
      if (blob) { const u = URL.createObjectURL(blob); urls.push(u); img.src = u; }
      wrap.append(img, el(`<div class="pn">${i} / ${n}</div>`));
    }
    if (!n) wrap.innerHTML = '<div class="empty"><p>No page images for this item.</p></div>';
  })();
  return () => urls.forEach(u => URL.revokeObjectURL(u));
}
