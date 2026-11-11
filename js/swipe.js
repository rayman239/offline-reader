// Swipe a list row to the left to reveal its actions, like Mail on iPhone.
// A short swipe leaves the buttons showing; a long swipe runs the edge one (Archive, or Read in the Feed).
// Touch only: on a laptop the rows behave as plain links.
const OPEN = 168;   // width of the revealed buttons (two × 84px)
const FULL = 0.55;  // fraction of the row width that counts as a long swipe

export function swipeRows(list, onAction) {
  let open = null;         // the <li> whose buttons are showing
  let g = null;            // the gesture in progress
  let swallowClick = false;

  function setX(li, x, animate = true) {
    const row = li.querySelector('.row');
    const acts = li.querySelector('.swipe-actions');
    row.style.transition = acts.style.transition = animate ? '' : 'none';
    row.style.transform = x ? `translateX(${-x}px)` : '';
    acts.style.width = `${x}px`;
    li.classList.toggle('full', x > OPEN * 1.4);
  }
  function close(li = open) {
    if (!li) return;
    setX(li, 0);
    if (li === open) open = null;
  }
  async function run(li, act) {
    const done = await onAction(act, li.dataset.id);
    if (done === false && li.isConnected) close(li); // e.g. delete cancelled
  }

  function down(e) {
    if (e.pointerType === 'mouse') return;
    swallowClick = false;
    if (open && !open.isConnected) open = null; // the list was redrawn
    const li = e.target.closest('li.swipe');
    if (open && li !== open) { close(); swallowClick = Boolean(li); return; } // first tap just closes
    if (!li || e.target.closest('.swipe-actions')) return;
    g = { li, id: e.pointerId, x0: e.clientX, y0: e.clientY, base: li === open ? OPEN : 0, x: 0, dir: null };
  }
  function move(e) {
    if (!g || e.pointerId !== g.id) return;
    const dx = e.clientX - g.x0;
    const dy = e.clientY - g.y0;
    if (!g.dir) {
      if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
      g.dir = Math.abs(dx) > Math.abs(dy) && (dx < 0 || g.base) ? 'x' : 'y';
      if (g.dir === 'y') { g = null; return; }
    }
    g.x = Math.max(0, g.base - dx);
    setX(g.li, g.x, false);
  }
  function up(e) {
    if (!g || e.pointerId !== g.id) return;
    const { li, x, dir } = g;
    g = null;
    if (!dir) { if (li === open) { close(); swallowClick = true; } return; }
    swallowClick = true;
    const w = li.offsetWidth;
    if (x > w * FULL) { setX(li, w); open = null; run(li, [...li.querySelectorAll('[data-act]')].pop().dataset.act); }
    else if (x > OPEN / 2) { setX(li, OPEN); open = li; }
    else close(li);
  }
  function cancel(e) {
    if (!g || e.pointerId !== g.id) return;
    const { li, base } = g;
    g = null;
    setX(li, base);
  }
  function click(e) {
    const b = e.target.closest('.swipe-actions [data-act]');
    if (b) {
      e.preventDefault();
      const li = b.closest('li');
      run(li, b.dataset.act);
      if (b.dataset.act !== 'delete') open = null; else close(li);
      return;
    }
    if (swallowClick) { e.preventDefault(); e.stopPropagation(); swallowClick = false; }
  }
  // Touching anywhere outside the list closes an open row.
  function outside(e) { if (open && !list.contains(e.target)) close(); }

  list.addEventListener('pointerdown', down);
  list.addEventListener('pointermove', move);
  list.addEventListener('pointerup', up);
  list.addEventListener('pointercancel', cancel);
  list.addEventListener('click', click, true);
  document.addEventListener('pointerdown', outside);
  return () => document.removeEventListener('pointerdown', outside);
}
