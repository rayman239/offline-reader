// Newsletters: the ones you follow for the Feed, how each is doing, and adding/removing them.
import { loadFeeds, loadItems, feedId, newsletterUrl, isSubstack, hostOf } from '../library.js';
import { enqueue } from '../outbox.js';
import { sync } from '../sync.js';
import { on } from '../events.js';
import { esc, el, icons, toast, confirmSheet, shortDate, ago } from '../ui.js';

const DAY = 86400e3;

export function feedsView(root) {
  const page = el(`
    <div class="page prose newsletters">
      <header class="top" style="margin-bottom:6px">
        <a class="icon-btn" href="#/feed" aria-label="Back to Feed">${icons.back}</a>
      </header>
      <h1>Newsletters</h1>
      <p class="muted intro">New posts from these appear in your Feed. Posts leave after 30 days unless you keep them or highlight something in them.</p>
      <div class="follow">
        <input class="field mono" type="url" inputmode="url" placeholder="stratechery.com" autocomplete="off" autocapitalize="off" spellcheck="false" enterkeyhint="go">
        <button class="btn primary" data-follow>Follow</button>
      </div>
      <p class="muted mono hint">Paste the newsletter’s web address, a post from it, or its feed.</p>
      <ul class="nl-list"></ul>
      <div data-mac></div>
    </div>`);
  root.replaceChildren(page);
  const input = page.querySelector('input');
  const list = page.querySelector('.nl-list');

  async function follow() {
    const url = newsletterUrl(input.value);
    if (!url) { toast('That doesn’t look like a web address'); return; }
    const { feeds } = await loadFeeds();
    const id = feedId(url);
    if (feeds.some(f => f.id === id)) { toast('You already follow that one'); return; }
    await enqueue({ type: 'feedAdd', feed: { id, url, added: new Date().toISOString() } });
    input.value = '';
    toast(isSubstack(url) ? 'Following — your Mac will fetch it within 30 min' : 'Following — first posts in a few minutes');
    setTimeout(() => sync(), 90e3);
  }
  page.querySelector('[data-follow]').onclick = follow;
  input.addEventListener('keydown', e => { if (e.key === 'Enter') follow(); });

  list.addEventListener('click', async e => {
    const b = e.target.closest('[data-unfollow]');
    if (!b) return;
    const ok = await confirmSheet({
      title: `Stop following ${b.dataset.name}?`,
      body: 'No new posts will arrive. Posts already in your Feed stay until they’re 30 days old.',
      confirm: 'Unfollow', danger: true,
    });
    if (!ok) return;
    await enqueue({ type: 'feedRemove', id: b.dataset.unfollow });
    toast('Unfollowed');
  });

  async function render() {
    const [{ feeds, status, mac }, items] = await Promise.all([loadFeeds(), loadItems()]);
    if (!feeds.length) {
      list.innerHTML = '<li class="empty"><p>You’re not following any newsletters yet.</p></li>';
    } else {
      list.innerHTML = feeds.map(f => row(f, status[f.id], items.filter(i => i.feed === f.id), mac)).join('');
    }
    const macBox = page.querySelector('[data-mac]');
    const substack = feeds.filter(f => isSubstack(f.url));
    if (!substack.length) { macBox.innerHTML = ''; return; }
    const last = mac && Date.parse(mac.lastRun);
    const stale = !last || Date.now() - last > DAY;
    macBox.innerHTML = `<h2>Your Mac</h2>
      <p class="${stale ? 'warn' : 'muted'}">${last
        ? `Substack newsletters are fetched by your Mac. It last checked them ${esc(ago(last))}.`
        : 'Substack newsletters are fetched by your Mac, which hasn’t checked in yet.'}
      ${stale ? ' New Substack posts will arrive once it’s awake and online.' : ''}</p>`;
  }

  const offs = [on('synced', render), on('outbox', render)];
  render();
  return () => offs.forEach(f => f());
}

function row(f, st, posts, mac) {
  const name = st?.name || hostOf(f.url);
  const inFeed = posts.filter(i => i.inFeed);
  const unread = inFeed.filter(i => i.status !== 'archived').length;
  const newest = posts.map(i => i.published || i.saved).sort().pop();
  const facts = [];
  if (f.pending || !st) {
    facts.push(['Status', 'Waiting for the first check — usually a few minutes']);
  } else {
    facts.push(['In Feed', inFeed.length ? `${inFeed.length} post${inFeed.length === 1 ? '' : 's'}${unread ? `, ${unread} unread` : ''}` : 'none']);
    facts.push(['Latest post', newest ? shortDate(newest) : 'none in the last 30 days']);
    facts.push(['Checked', st.checked ? ago(Date.parse(st.checked)) : 'not yet']);
    if (st.via === 'mac') {
      const macErr = mac?.feeds?.[f.id] && !mac.feeds[f.id].ok ? mac.feeds[f.id].error : null;
      facts.push(['Fetched by', 'your Mac (Substack blocks GitHub)']);
      if (macErr) facts.push(['Mac problem', macErr, 'warn']);
    }
    if (st.skipped) facts.push(['Skipped', `${st.skipped} subscriber-only post${st.skipped === 1 ? '' : 's'}`]);
    if (st.waiting) facts.push(['Status', st.waiting]);
    if (st.error) facts.push(['Problem', st.error, 'warn']);
  }
  return `<li class="nl">
    <div class="nl-head"><span class="nl-name">${esc(name)}</span>
      <button class="link-btn" data-unfollow="${esc(f.id)}" data-name="${esc(name)}">Unfollow</button></div>
    <a class="nl-url mono" href="${esc(f.url)}" target="_blank" rel="noopener">${esc(f.url.replace(/^https?:\/\//, ''))}</a>
    <dl class="kv">${facts.map(([k, v, cls]) => `<dt>${esc(k)}</dt><dd${cls ? ` class="${cls}"` : ''}>${esc(v)}</dd>`).join('')}</dl>
  </li>`;
}
