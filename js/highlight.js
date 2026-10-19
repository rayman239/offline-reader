// Anchoring highlights to article text (quote + surrounding context), and drawing them.

const CONTEXT = 40;

function textNodes(root) {
  const out = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let pos = 0;
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    out.push({ node: n, start: pos, end: pos + n.data.length });
    pos += n.data.length;
  }
  return { nodes: out, text: out.map(x => x.node.data).join('') };
}

function offsetOf(nodes, container, offset) {
  if (container.nodeType === Node.TEXT_NODE) {
    const n = nodes.find(x => x.node === container);
    return n ? n.start + offset : null;
  }
  // Element boundary: the first text node starting at or after the boundary point.
  const point = document.createRange();
  point.setStart(container, offset);
  point.collapse(true);
  for (const x of nodes) {
    if (point.comparePoint(x.node, 0) >= 0) return x.start;
  }
  return nodes.length ? nodes[nodes.length - 1].end : 0;
}

// Describes a selection Range inside root as a text-quote anchor.
export function describe(root, range) {
  const { nodes, text } = textNodes(root);
  let s = offsetOf(nodes, range.startContainer, range.startOffset);
  let e = offsetOf(nodes, range.endContainer, range.endOffset);
  if (s == null || e == null || e <= s) return null;
  while (s < e && /\s/.test(text[s])) s++;
  while (e > s && /\s/.test(text[e - 1])) e--;
  if (e <= s) return null;
  return {
    exact: text.slice(s, e),
    prefix: text.slice(Math.max(0, s - CONTEXT), s),
    suffix: text.slice(e, e + CONTEXT),
    start: s,
  };
}

function commonSuffixLen(a, b) {
  let n = 0;
  while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n++;
  return n;
}
function commonPrefixLen(a, b) {
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n++;
  return n;
}

// Finds the best match for an anchor in the text. Returns [start, end] or null.
function locate(text, hl) {
  const hits = [];
  for (let i = text.indexOf(hl.exact); i >= 0; i = text.indexOf(hl.exact, i + 1)) hits.push(i);
  if (!hits.length) return null;
  let best = hits[0];
  let bestScore = -Infinity;
  for (const i of hits) {
    const score = commonSuffixLen(text.slice(Math.max(0, i - CONTEXT), i), hl.prefix || '')
      + commonPrefixLen(text.slice(i + hl.exact.length, i + hl.exact.length + CONTEXT), hl.suffix || '')
      - Math.abs(i - (hl.start || 0)) / 10000;
    if (score > bestScore) { bestScore = score; best = i; }
  }
  return [best, best + hl.exact.length];
}

// Wraps every highlight in <mark class="hl" data-id>. Returns ids that couldn't be placed.
export function paint(root, highlights) {
  for (const m of root.querySelectorAll('mark.hl')) m.replaceWith(...m.childNodes);
  root.normalize();
  const missing = [];
  for (const hl of highlights) {
    const { nodes, text } = textNodes(root);
    const at = locate(text, hl);
    if (!at) { missing.push(hl.id); continue; }
    const [s, e] = at;
    for (const x of nodes) {
      if (x.end <= s || x.start >= e) continue;
      if (!x.node.data.trim()) continue; // don't wrap whitespace between blocks
      let node = x.node;
      const a = Math.max(0, s - x.start);
      const b = Math.min(node.data.length, e - x.start);
      if (b < node.data.length) node.splitText(b);
      if (a > 0) node = node.splitText(a);
      const mark = document.createElement('mark');
      mark.className = 'hl';
      mark.dataset.id = hl.id;
      node.replaceWith(mark);
      mark.appendChild(node);
    }
  }
  return missing;
}
