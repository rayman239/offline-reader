// First-run setup and settings.
import { config, gh, LIBRARY, VAULT } from '../config.js';
import { db, kv } from '../db.js';
import { GitHub } from '../github.js';
import { sync, status as syncStatus } from '../sync.js';
import { pending } from '../outbox.js';
import { on } from '../events.js';
import { esc, el, icons, toast, confirmSheet, ago } from '../ui.js';
import { THEMES, getTheme, setTheme } from '../theme.js';

const TOKEN_URL = 'https://github.com/settings/personal-access-tokens/new';

export function setupView(root) {
  const page = el(`
    <div class="page prose">
      <h1>Offline Reader</h1>
      <p>Connect this device to your library on GitHub. You only do this once per device.</p>
      <h2>1 · Create a key</h2>
      <ol>
        <li>Open <a href="${TOKEN_URL}" target="_blank" rel="noopener">GitHub → new fine-grained token</a>.</li>
        <li>Name it e.g. <code>Offline Reader – iPhone</code>, and choose the longest expiry offered.</li>
        <li>Under <b>Repository access</b>, choose <b>Only select repositories</b> and pick <code>${LIBRARY}</code> and <code>${VAULT}</code>.</li>
        <li>Under <b>Permissions → Repository permissions</b>, set <b>Contents</b> to <b>Read and write</b>.</li>
        <li>Generate the token and copy it.</li>
      </ol>
      <h2>2 · Paste it here</h2>
      <div class="stack">
        <input class="field mono" data-owner placeholder="GitHub username" autocapitalize="off" autocomplete="username" spellcheck="false" value="${esc(config.owner || '')}">
        <input class="field mono" data-token type="password" placeholder="github_pat_…" autocapitalize="off" autocomplete="off" spellcheck="false">
        <button class="btn primary" data-connect style="justify-content:center">Connect</button>
        <p class="error" data-error></p>
      </div>
      <p class="muted mono" style="font-size:12px">The key is stored only on this device and is only ever sent to GitHub.</p>
    </div>`);
  root.replaceChildren(page);
  const btn = page.querySelector('[data-connect]');
  const err = page.querySelector('[data-error]');
  btn.onclick = async () => {
    const owner = page.querySelector('[data-owner]').value.trim();
    const token = page.querySelector('[data-token]').value.trim();
    err.textContent = '';
    if (!owner || !token) { err.textContent = 'Both fields are needed.'; return; }
    btn.disabled = true;
    btn.textContent = 'Checking…';
    try {
      const client = new GitHub(token, owner);
      for (const repo of [LIBRARY, VAULT]) {
        const r = await client.checkRepo(repo);
        if (r.permissions && !r.permissions.push) throw new Error(`The key can read ${repo} but can't write to it. Set Contents to “Read and write”.`);
      }
      config.owner = owner;
      config.token = token;
      if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
      // Restart the app connected (setting the hash alone does nothing if it's already #/).
      history.replaceState(null, '', location.pathname + '#/');
      location.reload();
    } catch (e) {
      err.textContent = e.status === 401 ? 'GitHub didn’t accept that key.'
        : e.status === 404 ? `Couldn’t find ${owner}/${LIBRARY} and ${VAULT} with that key. Check the repository access.`
        : e.message;
      btn.disabled = false;
      btn.textContent = 'Connect';
    }
  };
}

export function settingsView(root) {
  const page = el(`
    <div class="page prose">
      <header class="top" style="margin-bottom:6px">
        <a class="icon-btn" href="#/" aria-label="Back">${icons.back}</a>
      </header>
      <h1>Settings</h1>
      <h2>Appearance</h2>
      <div class="stack" style="grid-auto-flow:column;justify-content:start" data-themes>
        ${THEMES.map(([v, l]) => `<button class="chip" data-v="${v}">${l}</button>`).join('')}
      </div>
      <p class="muted mono" style="font-size:12px">Auto follows your device’s light/dark setting.</p>
      <h2>Sync</h2>
      <dl class="kv" data-sync></dl>
      <div class="stack" style="grid-auto-flow:column;justify-content:start">
        <button class="btn" data-now>Sync now</button>
      </div>
      <h2>Storage on this device</h2>
      <dl class="kv" data-storage></dl>
      <h2>Saving from your iPhone</h2>
      <p>Use the <b>Save to Offline Reader</b> shortcut from the Share sheet in Safari, Arc, Mail or Files. <a href="https://github.com/${esc(config.owner)}/offline-reader/blob/main/docs/iphone-shortcut.md" target="_blank" rel="noopener">How to set it up</a>.</p>
      <h2>Install</h2>
      <p>On iPhone: open this page in Safari, tap Share → <b>Add to Home Screen</b>. In Arc on a Mac, you can simply keep this page pinned.</p>
      <h2>Account</h2>
      <dl class="kv"><dt>GitHub</dt><dd>${esc(config.owner)}</dd><dt>Library</dt><dd>${LIBRARY}</dd><dt>Themes</dt><dd>${VAULT}</dd></dl>
      <div class="stack" style="grid-auto-flow:column;justify-content:start;margin-top:18px">
        <button class="btn danger" data-signout>Disconnect this device</button>
      </div>
    </div>`);
  root.replaceChildren(page);

  async function render() {
    const ops = await pending();
    const dead = (await kv.get('deadOps')) || [];
    const s = syncStatus;
    page.querySelector('[data-sync]').innerHTML = `
      <dt>Last synced</dt><dd>${ago(s.lastSync)}</dd>
      <dt>Status</dt><dd>${s.offline ? 'Offline' : s.running ? (s.total ? `Downloading ${s.done} of ${s.total}` : 'Syncing…') : s.error ? esc(s.error) : 'Up to date'}</dd>
      <dt>Waiting to send</dt><dd>${ops.length}${ops.some(o => o.error) ? ` — last error: ${esc(ops.find(o => o.error).error)}` : ''}</dd>
      ${dead.length ? `<dt>Failed changes</dt><dd>${dead.length} (couldn't be sent after 5 tries)</dd>` : ''}`;
    let est = {};
    try { est = await navigator.storage.estimate(); } catch { /* not supported */ }
    let persisted = null;
    try { persisted = await navigator.storage.persisted(); } catch { /* not supported */ }
    const mb = b => `${(b / 1024 / 1024).toFixed(b > 100 * 1024 * 1024 ? 0 : 1)} MB`;
    page.querySelector('[data-storage]').innerHTML = `
      <dt>Used</dt><dd>${est.usage != null ? mb(est.usage) : 'unknown'}</dd>
      <dt>Protected</dt><dd>${persisted === true ? 'Yes — the system won’t clear it' : persisted === false ? 'Not yet (install to the home screen)' : 'unknown'}</dd>`;
  }
  const markTheme = () => {
    for (const b of page.querySelectorAll('[data-themes] .chip')) b.classList.toggle('on', b.dataset.v === getTheme());
  };
  page.querySelector('[data-themes]').addEventListener('click', e => {
    const b = e.target.closest('[data-v]');
    if (b) { setTheme(b.dataset.v); markTheme(); }
  });
  markTheme();
  page.querySelector('[data-now]').onclick = () => { sync({ force: true }); toast('Syncing…'); };
  page.querySelector('[data-signout]').onclick = async () => {
    const ok = await confirmSheet({
      title: 'Disconnect this device?',
      body: 'This removes the key and all downloaded items from this device. Nothing is deleted from GitHub. Changes not yet sent will be lost.',
      confirm: 'Disconnect', danger: true,
    });
    if (!ok) return;
    await db.clearAll();
    config.token = null;
    location.hash = '#/';
    location.reload();
  };
  const offs = [on('sync-status', render), on('outbox', render)];
  render();
  return () => offs.forEach(f => f());
}
