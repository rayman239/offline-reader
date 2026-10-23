// Full-screen image viewer with pinch/drag/double-tap zoom (touch) and click/trackpad zoom (Mac).
import { el, esc } from './ui.js';

const MAX = 6;
const DOUBLE_TAP_ZOOM = 2.5;

export function openViewer(src, alt = '') {
  const root = el(`
    <div class="viewer" role="dialog" aria-modal="true" aria-label="${esc(alt || 'Image')}">
      <img class="viewer-img" src="${esc(src)}" alt="${esc(alt)}" draggable="false">
      <button class="viewer-close" aria-label="Close">×</button>
      ${alt ? `<div class="viewer-caption">${esc(alt)}</div>` : ''}
    </div>`);
  const img = root.querySelector('img');
  document.body.append(root);
  document.documentElement.classList.add('viewer-open');
  requestAnimationFrame(() => root.classList.add('show'));

  let s = 1, tx = 0, ty = 0;   // current scale and translation (screen px)
  let base = null;              // image's layout box at scale 1
  const measure = () => {
    const prev = img.style.transform;
    img.style.transform = 'none';
    base = img.getBoundingClientRect();
    img.style.transform = prev;
  };

  function apply(animate = false) {
    img.style.transition = animate ? 'transform 0.22s ease' : 'none';
    img.style.transform = `translate(${tx}px, ${ty}px) scale(${s})`;
    root.classList.toggle('zoomed', s > 1.01);
  }

  // Zoom to scale `to`, keeping the image point under screen point (mx, my) fixed.
  function zoomAt(mx, my, to, animate) {
    to = Math.min(MAX, Math.max(1, to));
    const qx = (mx - base.left - tx) / s;
    const qy = (my - base.top - ty) / s;
    s = to;
    tx = mx - base.left - s * qx;
    ty = my - base.top - s * qy;
    clamp();
    apply(animate);
  }

  // Keep a zoomed image covering the screen (or centred if it's smaller than the screen).
  function clamp() {
    if (s <= 1.01) { s = 1; tx = 0; ty = 0; return; }
    const vw = innerWidth, vh = innerHeight;
    const w = base.width * s, h = base.height * s;
    const fit = (len, view, start, t) => {
      if (len <= view) return (view - len) / 2 - start;
      return Math.min(-start, Math.max(view - len - start, t));
    };
    tx = fit(w, vw, base.left, tx);
    ty = fit(h, vh, base.top, ty);
  }

  function close() {
    root.classList.remove('show');
    document.documentElement.classList.remove('viewer-open');
    removeEventListener('keydown', onKey);
    removeEventListener('resize', onResize);
    setTimeout(() => root.remove(), 220);
  }
  const onKey = e => { if (e.key === 'Escape') close(); };
  const onResize = () => { s = 1; tx = 0; ty = 0; apply(); measure(); };
  addEventListener('keydown', onKey);
  addEventListener('resize', onResize);
  root.querySelector('.viewer-close').addEventListener('click', e => { e.stopPropagation(); close(); });
  if (img.complete) measure(); else img.addEventListener('load', measure, { once: true });

  // ---------- touch & mouse ----------
  const pts = new Map();
  let pinch = null;      // { d0, s0, tx0, ty0, mx0, my0 }
  let drag = null;       // { x, y, tx0, ty0, moved, swipe }
  let lastTap = 0;

  const mid = () => {
    const [a, b] = [...pts.values()];
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, d: Math.hypot(a.x - b.x, a.y - b.y) };
  };

  root.addEventListener('pointerdown', e => {
    if (e.target.closest('.viewer-close')) return;
    if (!base) measure();
    try { root.setPointerCapture(e.pointerId); } catch { /* pointer already gone */ }
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pts.size === 2) {
      const m = mid();
      pinch = { d0: m.d || 1, s0: s, tx0: tx, ty0: ty, mx0: m.x, my0: m.y };
      drag = null;
    } else if (pts.size === 1) {
      drag = { x: e.clientX, y: e.clientY, tx0: tx, ty0: ty, moved: false, swipe: s === 1 };
    }
  });

  root.addEventListener('pointermove', e => {
    if (!pts.has(e.pointerId)) return;
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinch && pts.size >= 2) {
      const m = mid();
      const to = Math.min(MAX, Math.max(0.8, pinch.s0 * m.d / pinch.d0));
      // Anchor the image point that was under the fingers at the start, following them as they move.
      const qx = (pinch.mx0 - base.left - pinch.tx0) / pinch.s0;
      const qy = (pinch.my0 - base.top - pinch.ty0) / pinch.s0;
      s = to;
      tx = m.x - base.left - s * qx;
      ty = m.y - base.top - s * qy;
      apply();
    } else if (drag) {
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      if (Math.hypot(dx, dy) > 6) drag.moved = true;
      if (!drag.moved) return;
      if (drag.swipe) {
        // At normal size, dragging down dismisses.
        ty = Math.max(0, dy);
        root.style.setProperty('--fade', String(Math.max(0.3, 1 - ty / 400)));
      } else {
        tx = drag.tx0 + dx;
        ty = drag.ty0 + dy;
      }
      apply();
    }
  });

  const end = e => {
    if (!pts.has(e.pointerId)) return;
    pts.delete(e.pointerId);
    if (pinch) {
      if (pts.size < 2) { pinch = null; clamp(); apply(true); drag = null; }
      return;
    }
    if (!drag) return;
    const d = drag;
    drag = null;
    if (d.swipe && d.moved) {
      if (ty > 110) { close(); return; }
      ty = 0;
      root.style.setProperty('--fade', '1');
      apply(true);
      return;
    }
    if (d.moved) { clamp(); apply(true); return; }

    // A tap.
    // Hit-test by position: with pointer capture, e.target is always the viewer itself.
    const r = img.getBoundingClientRect();
    const onImage = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
    if (e.pointerType === 'mouse') {
      if (!onImage && s === 1) { close(); return; }
      zoomAt(e.clientX, e.clientY, s > 1 ? 1 : DOUBLE_TAP_ZOOM, true);
      return;
    }
    const now = Date.now();
    if (now - lastTap < 300) {
      lastTap = 0;
      zoomAt(e.clientX, e.clientY, s > 1 ? 1 : DOUBLE_TAP_ZOOM, true);
    } else {
      lastTap = now;
    }
  };
  root.addEventListener('pointerup', end);
  root.addEventListener('pointercancel', end);

  // Trackpad pinch arrives as ctrl+wheel; plain wheel/two-finger scroll pans when zoomed.
  root.addEventListener('wheel', e => {
    e.preventDefault();
    if (!base) measure();
    if (e.ctrlKey) {
      zoomAt(e.clientX, e.clientY, s * Math.exp(-e.deltaY / 100), false);
    } else if (s > 1) {
      tx -= e.deltaX;
      ty -= e.deltaY;
      clamp();
      apply();
    }
  }, { passive: false });

  return close;
}
