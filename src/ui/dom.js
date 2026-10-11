// Tiny DOM helpers — no framework, no globals.

export function el(id) {
  return document.getElementById(id);
}

export function on(target, type, fn, opts) {
  target.addEventListener(type, fn, opts);
  return () => target.removeEventListener(type, fn, opts);
}

// Pages collect listeners in mount and release them in unmount via off().
export function bindOff() {
  const offs = [];
  return {
    on(target, type, fn, opts) {
      target.addEventListener(type, fn, opts);
      offs.push([target, type, fn, opts]);
    },
    off() {
      for (const [target, type, fn, opts] of offs) target.removeEventListener(type, fn, opts);
      offs.length = 0;
    },
  };
}

// Show/hide an inline error element. showError(node, null) clears it.
export function showError(node, msg) {
  if (!node) return;
  if (msg == null || msg === '') {
    node.hidden = true;
    node.textContent = '';
    return;
  }
  node.textContent = msg;
  node.hidden = false;
}

// Keyboard row-highlight helper for list/table pages. Toggles `cls` on exactly
// one element and scrolls it into view. Returns the clamped index, or -1 when
// `rows` is empty. Callers keep their own active-index state.
export function highlightRow(rows, i, cls = 'active') {
  if (!rows.length) return -1;
  i = Math.max(0, Math.min(i, rows.length - 1));
  for (let k = 0; k < rows.length; k++) rows[k].classList.toggle(cls, k === i);
  rows[i].scrollIntoView({ block: 'nearest' });
  return i;
}

export function clearHighlight(rows, cls = 'active') {
  for (const r of rows) r.classList.remove(cls);
}

// Re-export; canonical location is core/time.js.
export { timeAgo } from '../core/time.js';
