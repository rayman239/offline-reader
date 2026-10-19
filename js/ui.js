// Small UI helpers: escaping, sheets, toasts, formatting.

export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export function el(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

export const icons = {
  plus: '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>',
  back: '<svg viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7"/></svg>',
  more: '<svg viewBox="0 0 24 24"><circle cx="5" cy="12" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="19" cy="12" r="1.2"/></svg>',
  gear: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>',
};

// Keeps sheets above the iOS keyboard.
if (window.visualViewport) {
  const update = () => {
    const kb = Math.max(0, window.innerHeight - visualViewport.height - visualViewport.offsetTop);
    document.documentElement.style.setProperty('--kb', `${kb}px`);
  };
  visualViewport.addEventListener('resize', update);
  visualViewport.addEventListener('scroll', update);
}

let openSheet = null;

// Opens a bottom sheet. Returns { root, close }. onClose runs once when dismissed.
export function sheet(html, { onClose } = {}) {
  if (openSheet) openSheet.close();
  const scrim = el('<div class="scrim"></div>');
  const root = el(`<div class="sheet" role="dialog" aria-modal="true">${html}</div>`);
  document.body.append(scrim, root);
  requestAnimationFrame(() => { scrim.classList.add('show'); root.classList.add('show'); });
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    scrim.classList.remove('show');
    root.classList.remove('show');
    setTimeout(() => { scrim.remove(); root.remove(); }, 250);
    document.removeEventListener('keydown', onKey);
    if (openSheet && openSheet.root === root) openSheet = null;
    if (onClose) onClose();
  };
  const onKey = e => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  scrim.addEventListener('click', close);
  root.addEventListener('focusin', e => {
    if (e.target.matches('input, textarea')) setTimeout(() => e.target.scrollIntoView({ block: 'nearest' }), 300);
  });
  openSheet = { root, close };
  return openSheet;
}

export function closeSheet() { if (openSheet) openSheet.close(); }

let toastEl;
let toastTimer;
export function toast(msg, ms = 2400) {
  if (!toastEl) { toastEl = el('<div class="toast" role="status"></div>'); document.body.append(toastEl); }
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), ms);
}

// A confirm dialog as a sheet (never window.confirm).
export function confirmSheet({ title, body = '', confirm = 'OK', danger = false }) {
  return new Promise(resolve => {
    let answered = false;
    const s = sheet(`
      <h2>${esc(title)}</h2>
      ${body ? `<p class="note" style="font-size:13px">${esc(body)}</p>` : ''}
      <div class="buttons">
        <button class="btn" data-no>Cancel</button>
        <button class="btn ${danger ? 'danger' : 'primary'}" data-yes>${esc(confirm)}</button>
      </div>`, { onClose: () => { if (!answered) resolve(false); } });
    s.root.querySelector('[data-no]').onclick = () => s.close();
    s.root.querySelector('[data-yes]').onclick = () => { answered = true; resolve(true); s.close(); };
  });
}

export function readingTime(words) {
  if (!words) return '';
  return `${Math.max(1, Math.round(words / 230))} min`;
}

export function shortDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d)) return '';
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', ...(sameYear ? {} : { year: 'numeric' }) });
}

export function longDate(d = new Date()) {
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

export function ago(ts) {
  if (!ts) return 'never';
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return shortDate(new Date(ts).toISOString());
}

export function uid() {
  return Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4);
}
