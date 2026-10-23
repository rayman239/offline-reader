// Markdown → safe HTML, with images served from the offline store.
import { marked } from '../vendor/marked.esm.js';
import DOMPurify from '../vendor/purify.es.mjs';
import { itemBlob } from './library.js';

marked.use({ gfm: true, breaks: false });

export function mdToHtml(md) {
  const cleaned = md
    // Obsidian comments (%% … %%) are hidden, as in Obsidian's reading view.
    .replace(/%%[\s\S]*?%%/g, '')
    // An indented image line would render as a code block; some sites' HTML produces these.
    .replace(/^[ \t]+(!\[[^\]\n]*\]\([^)\n]*\))[ \t]*$/gm, '$1');
  const html = marked.parse(cleaned);
  return DOMPurify.sanitize(html, { ADD_TAGS: ['small'], FORBID_ATTR: ['style'] });
}

const urls = new Set();
export function releaseImages() {
  for (const u of urls) URL.revokeObjectURL(u);
  urls.clear();
}

// Renders an item's markdown into el, wiring images to local blobs.
export async function renderArticle(el, item) {
  // Build in a <template> so the browser doesn't try to fetch relative image paths.
  const tpl = document.createElement('template');
  tpl.innerHTML = mdToHtml(item.body);
  const frag = tpl.content;
  for (const img of frag.querySelectorAll('img')) {
    img.dataset.src = img.getAttribute('src') || '';
    img.removeAttribute('src');
  }
  for (const a of frag.querySelectorAll('a[href]')) {
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
  }
  for (const t of frag.querySelectorAll('table')) {
    const wrap = document.createElement('div');
    wrap.className = 'table-scroll';
    t.replaceWith(wrap);
    wrap.appendChild(t);
  }
  el.replaceChildren(frag);
  await attachImages(el, item.id);
}

// Points <img data-src="images/01.webp"> at the offline copy. With onlyPending,
// only fills images that weren't downloaded yet last time.
export async function attachImages(el, id, onlyPending = false) {
  for (const img of el.querySelectorAll(onlyPending ? 'img.pending' : 'img[data-src]')) {
    const rel = img.dataset.src;
    if (!rel || /^(https?:|data:)/.test(rel)) continue;
    img.decoding = 'async';
    const blob = await itemBlob(id, rel);
    if (blob) {
      const u = URL.createObjectURL(blob);
      urls.add(u);
      img.src = u;
      img.classList.remove('pending');
    } else {
      img.classList.add('pending'); // still downloading; filled in on 'images-updated'
    }
  }
}
