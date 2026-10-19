// Themes: read-only view of the theme files (the Obsidian vault).
import { loadThemes } from '../library.js';
import { mdToHtml } from '../render.js';
import { on } from '../events.js';
import { esc, el, icons } from '../ui.js';

export function themesView(root) {
  const page = el(`
    <div class="page">
      <header class="top">
        <nav class="tabs">
          <a href="#/">Unread</a>
          <a href="#/archive">Archive</a>
          <a href="#/themes" class="active">Themes</a>
        </nav>
        <div class="actions"><a class="icon-btn" href="#/settings" aria-label="Settings">${icons.gear}</a></div>
      </header>
      <ul class="list"></ul>
    </div>`);
  root.replaceChildren(page);
  const list = page.querySelector('.list');
  async function render() {
    const themes = await loadThemes();
    list.innerHTML = themes.length
      ? themes.map(t => `<li><a class="row" href="#/themes/${encodeURIComponent(t.name)}">
          <div class="title">${esc(t.name)}</div>
          <div class="meta"><span>${t.count} clip${t.count === 1 ? '' : 's'}</span></div></a></li>`).join('')
      : '<li class="empty"><p>No themes yet.</p><p class="mono">Select text while reading and tap Clip.</p></li>';
  }
  const offs = [on('synced', render), on('outbox', render)];
  render();
  return () => offs.forEach(f => f());
}

export function themeView(root, { name }) {
  const page = el(`
    <div class="reader size-m theme-doc">
      <header class="bar">
        <a class="icon-btn" href="#/themes" aria-label="Back to themes">${icons.back}</a>
        <span class="spacer"></span><span class="label">${esc(name)}</span>
      </header>
      <div class="page"><article class="doc"><h1 class="title">${esc(name)}</h1><p class="byline"></p><div class="content"></div></article></div>
    </div>`);
  root.replaceChildren(page);
  async function render() {
    const t = (await loadThemes()).find(x => x.name === name);
    const content = page.querySelector('.content');
    if (!t) { content.innerHTML = '<div class="empty"><p>This theme has no clips yet.</p></div>'; return; }
    page.querySelector('.byline').innerHTML = `<span>${t.count} clip${t.count === 1 ? '' : 's'}</span><span>Edit in Obsidian</span>`;
    content.innerHTML = mdToHtml(t.text);
    for (const a of content.querySelectorAll('a[href]')) { a.target = '_blank'; a.rel = 'noopener noreferrer'; }
  }
  const offs = [on('synced', render), on('outbox', render)];
  render();
  return () => offs.forEach(f => f());
}
