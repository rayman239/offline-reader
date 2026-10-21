// Thin GitHub API client (REST + GraphQL), used directly from the browser.

const API = 'https://api.github.com';

export class GitHubError extends Error {
  constructor(message, status, extra = {}) {
    super(message);
    this.status = status;
    Object.assign(this, extra);
  }
}

export function utf8ToBase64(text) {
  const bytes = new TextEncoder().encode(text);
  return bytesToBase64(bytes);
}

export function bytesToBase64(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

export function base64ToUtf8(b64) {
  const bin = atob(b64.replace(/\s/g, ''));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

export class GitHub {
  constructor(token, owner) {
    this.token = token;
    this.owner = owner;
  }

  async req(path, { method = 'GET', body, accept = 'application/vnd.github+json', etag, raw = false } = {}) {
    const headers = {
      Authorization: `Bearer ${this.token}`,
      Accept: accept,
      'X-GitHub-Api-Version': '2022-11-28',
    };
    if (etag) headers['If-None-Match'] = etag;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    // Never hang: give up after 60s (uploads can be large) and treat it as a network problem.
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 60000);
    let res;
    try {
      res = await fetch(path.startsWith('http') ? path : API + path, {
        method, headers, body: body === undefined ? undefined : JSON.stringify(body), cache: 'no-store', signal: ctrl.signal,
      });
    } catch (e) {
      throw new GitHubError(e.name === 'AbortError' ? 'GitHub took too long to respond' : 'Network unavailable', 0, { offline: true });
    } finally {
      clearTimeout(timer);
    }
    if (res.status === 304) return { notModified: true, etag };
    if (!res.ok) {
      let msg = res.statusText;
      try { msg = (await res.json()).message || msg; } catch { /* ignore */ }
      const remaining = res.headers.get('x-ratelimit-remaining');
      const reset = Number(res.headers.get('x-ratelimit-reset') || 0) * 1000;
      throw new GitHubError(msg, res.status, {
        rateLimited: (res.status === 403 || res.status === 429) && remaining === '0',
        reset,
      });
    }
    if (raw) return res.blob();
    if (res.status === 204) return {};
    const data = await res.json();
    return { data, etag: res.headers.get('etag') };
  }

  repo(name) { return `/repos/${this.owner}/${name}`; }

  async checkRepo(name) {
    const { data } = await this.req(this.repo(name));
    return data;
  }

  // Full recursive listing of the default branch. Returns { notModified } or { tree, truncated, etag }.
  async tree(name, etag) {
    try {
      const r = await this.req(`${this.repo(name)}/git/trees/HEAD?recursive=1`, { etag });
      if (r.notModified) return r;
      return { tree: r.data.tree, truncated: r.data.truncated, etag: r.etag };
    } catch (e) {
      if (e.status === 409) return { tree: [], truncated: false, etag: null }; // empty repo
      throw e;
    }
  }

  // Fetches many text blobs in one GraphQL round trip. Returns Map(sha -> text|null).
  async blobTexts(name, shas) {
    const out = new Map();
    if (!shas.length) return out;
    const fields = shas.map((sha, i) => `b${i}: object(oid: "${sha}") { ... on Blob { text isBinary isTruncated } }`).join('\n');
    const query = `query { repository(owner: ${JSON.stringify(this.owner)}, name: ${JSON.stringify(name)}) { ${fields} } }`;
    const { data } = await this.req('/graphql', { method: 'POST', body: { query } });
    if (data.errors && !data.data) throw new GitHubError(data.errors[0].message, 400);
    const repo = data.data.repository;
    shas.forEach((sha, i) => {
      const b = repo[`b${i}`];
      out.set(sha, b && !b.isBinary && !b.isTruncated && typeof b.text === 'string' ? b.text : null);
    });
    return out;
  }

  async blobRaw(name, sha) {
    return this.req(`${this.repo(name)}/git/blobs/${sha}`, { accept: 'application/vnd.github.raw+json', raw: true });
  }

  // Returns { text, sha } or null if the file doesn't exist.
  async getText(name, path) {
    try {
      const { data } = await this.req(`${this.repo(name)}/contents/${encodePath(path)}?ref=HEAD`);
      if (data.encoding === 'base64' && data.content !== undefined && data.size <= 1024 * 1024) {
        return { text: base64ToUtf8(data.content), sha: data.sha };
      }
      const blob = await this.blobRaw(name, data.sha);
      return { text: await blob.text(), sha: data.sha };
    } catch (e) {
      if (e.status === 404) return null;
      throw e;
    }
  }

  // Creates or updates a file. `content64` is base64. Returns the new blob sha.
  async putFile(name, path, content64, message, sha) {
    const body = { message, content: content64 };
    if (sha) body.sha = sha;
    const { data } = await this.req(`${this.repo(name)}/contents/${encodePath(path)}`, { method: 'PUT', body });
    return data.content.sha;
  }

  // Deletes many paths in a single commit using the Git Data API.
  async deletePaths(name, paths, message) {
    for (let attempt = 0; attempt < 4; attempt++) {
      const { data: ref } = await this.req(`${this.repo(name)}/git/ref/heads/main`);
      const head = ref.object.sha;
      const { data: commit } = await this.req(`${this.repo(name)}/git/commits/${head}`);
      const { data: tree } = await this.req(`${this.repo(name)}/git/trees`, {
        method: 'POST',
        body: { base_tree: commit.tree.sha, tree: paths.map(p => ({ path: p, mode: '100644', type: 'blob', sha: null })) },
      });
      const { data: newCommit } = await this.req(`${this.repo(name)}/git/commits`, {
        method: 'POST', body: { message, tree: tree.sha, parents: [head] },
      });
      try {
        await this.req(`${this.repo(name)}/git/refs/heads/main`, { method: 'PATCH', body: { sha: newCommit.sha } });
        return;
      } catch (e) {
        if (e.status !== 422 && e.status !== 409) throw e; // someone else pushed; retry on new head
      }
    }
    throw new GitHubError('Could not delete — the library kept changing. Try again.', 409);
  }
}

function encodePath(p) {
  return p.split('/').map(encodeURIComponent).join('/');
}
