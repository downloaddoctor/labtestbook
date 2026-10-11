// Generic field-diff primitive. One walker, two shapes:
//   diff(prev, cur, fields?)        → string[]            (compact)
//   diffValues(prev, cur, fields?)  → [{key,from,to}]     (non-compact)
// `fields` (whitelist) wins over the META blacklist. null/undefined are
// treated as equal; numbers compare as numbers; everything else via stable JSON.

export const META_KEYS = new Set(['v', 'crtAt', 'revAt', 'uId', 'uV']);

// Bill content keys = every key a bill revision/projection can carry, minus
// derived/meta. Derived from the canonical projection shape; new content fields
// are picked up automatically because callers pass live rows and we filter here.
export const BILL_SKIP = new Set([
  'id', 'v', 'history', 'crtAt', 'revAt', 'updatedAt', 'uId', 'uV',
]);

// Content keys present across `a` and `b`, excluding `skip` and META_KEYS.
export function contentKeys(a, b, skip) {
  const out = [];
  const seen = new Set();
  for (const k of [...Object.keys(a || {}), ...Object.keys(b || {})]) {
    if (seen.has(k)) continue;
    seen.add(k);
    if (META_KEYS.has(k)) continue;
    if (skip && skip.has(k)) continue;
    out.push(k);
  }
  return out;
}

function eq(a, b) {
  const an = a == null ? null : a;
  const bn = b == null ? null : b;
  if (typeof an === 'number' && typeof bn === 'number') return an === bn;
  return JSON.stringify(an) === JSON.stringify(bn);
}

function keysOf(prev, cur, fields) {
  if (fields) return fields;
  return [...new Set([...Object.keys(prev || {}), ...Object.keys(cur || {})])].filter(
    (k) => !META_KEYS.has(k)
  );
}

// Changed keys, in declared order (or insertion order when fields omitted).
export function diff(prev, cur, fields) {
  const out = [];
  for (const k of keysOf(prev, cur, fields)) {
    if (!eq(prev ? prev[k] : undefined, cur ? cur[k] : undefined)) out.push(k);
  }
  return out;
}

export function isNoop(prev, cur, fields) {
  return diff(prev, cur, fields).length === 0;
}

// Changed keys with before/after values.
export function diffValues(prev, cur, fields) {
  const out = [];
  for (const k of keysOf(prev, cur, fields)) {
    const a = prev ? prev[k] : undefined;
    const b = cur ? cur[k] : undefined;
    if (!eq(a, b)) out.push({ key: k, from: a == null ? null : a, to: b == null ? null : b });
  }
  return out;
}
