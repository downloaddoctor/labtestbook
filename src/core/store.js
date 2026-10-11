// Tiny localStorage-backed store. One localStorage entry per key (O(1)
// get/set, no JSON blob). Instantiate with a namespace prefix:
//
//   const doctors = new Store('doctor');
//   doctors.set('defaultId', 3);     // localStorage['ltb.doctor.defaultId'] = '3'
//   doctors.get('defaultId');        // '3'
//   doctors.num('defaultId');        // 3
//   doctors.del('defaultId');
//
// A global app prefix ('ltb.') keeps keys from colliding with other apps on the
// same origin. Keys are flat strings; values are stored as plain strings.

const APP_PREFIX = 'ltb.';

// Resolve localStorage ONCE at module load (absent / throws in private mode).
let LS = null;
try {
  LS = typeof localStorage !== 'undefined' ? localStorage : null;
} catch {
  LS = null;
}

export class Store {
  constructor(namespace = '') {
    this.ns = String(namespace || '');
  }

  _key(key) {
    return APP_PREFIX + (this.ns ? this.ns + '.' : '') + String(key);
  }

  get(key, fallback = null) {
    if (!LS) return fallback;
    const v = LS.getItem(this._key(key));
    return v == null ? fallback : v;
  }

  set(key, value) {
    if (!LS) return value;
    if (value == null) LS.removeItem(this._key(key));
    else LS.setItem(this._key(key), String(value));
    return value;
  }

  del(key) {
    if (LS) LS.removeItem(this._key(key));
  }

  has(key) {
    return LS ? LS.getItem(this._key(key)) != null : false;
  }

  num(key, fallback = null) {
    const v = this.get(key);
    if (v == null || v === '') return fallback;
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  }

  bool(key, fallback = false) {
    const v = this.get(key);
    if (v == null) return fallback;
    return v === 'true' || v === '1';
  }

  // Every key in this namespace (without prefix). O(n) — debug/inspection.
  keys() {
    if (!LS) return [];
    const base = APP_PREFIX + (this.ns ? this.ns + '.' : '');
    const out = [];
    for (let i = 0; i < LS.length; i++) {
      const k = LS.key(i);
      if (k && k.startsWith(base)) out.push(k.slice(base.length));
    }
    return out;
  }

  clear() {
    for (const k of this.keys()) this.del(k);
  }
}

export default Store;
