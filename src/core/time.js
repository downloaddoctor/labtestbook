import Store from './store.js';

const APP_STORE = new Store('app');

// Store the timezone offset on first boot so ledger/day boundaries never shift
// if the user travels or changes their OS timezone.
export function getFixedOffset() {
  const stored = APP_STORE.get('timezoneOffset');
  if (stored === null || stored === '') {
    const offset = new Date().getTimezoneOffset();
    APP_STORE.set('timezoneOffset', offset);
    return offset;
  }
  return Number(stored);
}

// Returns a Date object shifted by the fixed offset, so its UTC methods
// (.getUTCHours, .getUTCDate, etc.) reflect the "wall clock" time of the
// original timezone.
export function toFixedDate(ms) {
  const offsetMs = getFixedOffset() * 60000;
  return new Date((ms == null ? Date.now() : Number(ms)) - offsetMs);
}

export function ymdFixed(ms) {
  const d = toFixedDate(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

// 'YYYY-MM-DDTHH:mm' — value accepted by <input type=datetime-local>.
export function toLocalInput(ms) {
  const d = toFixedDate(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return (
    `${d.getUTCFullYear()}` +
    `-${pad(d.getUTCMonth() + 1)}` +
    `-${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}` +
    `:${pad(d.getUTCMinutes())}`
  );
}

export function nowLocalInput() {
  return toLocalInput();
}

// 'HH:mm' (24-hour) -> 'hh:mm AM/PM'. Empty/invalid input passes through as-is.
export function fmtTime12(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || ''));
  if (!m) return hhmm || '';
  let h = Number(m[1]);
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return `${String(h).padStart(2, '0')}:${m[2]} ${ampm}`;
}

// Epoch ms -> local parts. Invalid/empty ms -> all-empty strings.
export function epochToParts(ms) {
  const d = toFixedDate(Number(ms));
  if (!ms || isNaN(d.getTime())) return { date: '', time24: '', time12: '' };
  const pad = (n) => String(n).padStart(2, '0');
  const hh = pad(d.getUTCHours());
  const mm = pad(d.getUTCMinutes());
  return {
    date: `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`,
    time24: `${hh}:${mm}`,
    time12: fmtTime12(`${hh}:${mm}`),
  };
}

// Human-readable timestamp from epoch ms (or Date/string). Falls back to ''.
export function fmtTime(ms) {
  if (ms == null || ms === '') return '';
  const d = toFixedDate(ms instanceof Date ? ms.getTime() : ms);
  if (isNaN(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

// Relative time (compact). Accepts epoch ms, Date, or ISO string.
export function timeAgo(when, { compact = false, fallback = '' } = {}) {
  if (when == null || when === '') return fallback;
  const d = when instanceof Date ? when : new Date(when);
  if (isNaN(d.getTime())) return fallback;
  const raw = Math.floor((Date.now() - d.getTime()) / 1000);
  if (raw < 0) {
    // Future timestamp: show the absolute time rather than a bogus "just now".
    return fmtTime(d);
  }
  const sec = raw;
  if (sec < 5) return compact ? 'now' : 'just now';
  if (sec < 60) return compact ? sec + 's' : sec + 's ago';
  const min = Math.floor(sec / 60);
  if (min < 60) return compact ? min + 'm' : min + 'm ago';
  const hr = Math.floor(min / 60);
  if (hr < 24) return compact ? hr + 'h' : hr + 'h ago';
  const day = Math.floor(hr / 24);
  if (day < 30) return compact ? day + 'd' : day + 'd ago';
  const mo = Math.floor(day / 30);
  if (mo < 12) return compact ? mo + 'mo' : mo + 'mo ago';
  const yr = Math.floor(mo / 12);
  return compact ? yr + 'y' : yr + 'y ago';
}

export function dayBounds(ms) {
  const [y, m, d] = ymdFixed(ms).split('-').map(Number);
  const offsetMs = getFixedOffset() * 60000;
  const from = Date.UTC(y, m - 1, d, 0, 0, 0, 0) + offsetMs;
  const to = Date.UTC(y, m - 1, d, 23, 59, 59, 999) + offsetMs;
  return { from, to };
}

export function monthBounds(ms) {
  const [y, m] = ymdFixed(ms).split('-').map(Number);
  const offsetMs = getFixedOffset() * 60000;
  const from = Date.UTC(y, m - 1, 1, 0, 0, 0, 0) + offsetMs;
  const to = Date.UTC(y, m, 0, 23, 59, 59, 999) + offsetMs;
  return { from, to };
}

export function dayBoundsFromStr(ymdStr) {
  const [y, m, d] = String(ymdStr).split('-').map(Number);
  const offsetMs = getFixedOffset() * 60000;
  const from = Date.UTC(y, m - 1, d, 0, 0, 0, 0) + offsetMs;
  const to = Date.UTC(y, m - 1, d, 23, 59, 59, 999) + offsetMs;
  return { from, to };
}

export function monthBoundsFromStr(ymStr) {
  const [y, m] = String(ymStr).split('-').map(Number);
  const offsetMs = getFixedOffset() * 60000;
  const from = Date.UTC(y, m - 1, 1, 0, 0, 0, 0) + offsetMs;
  const to = Date.UTC(y, m, 0, 23, 59, 59, 999) + offsetMs;
  return { from, to };
}

export function dayKey(ms) {
  const d = toFixedDate(ms);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

export function monthKey(ms) {
  const d = toFixedDate(ms);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}`;
}

export function yearKey(ms) {
  const d = toFixedDate(ms);
  return String(d.getUTCFullYear());
}

export function weekKey(ms) {
  const d = toFixedDate(ms);
  const thursday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 3 - ((d.getUTCDay() + 6) % 7)));
  const year = thursday.getUTCFullYear();
  const week1 = new Date(Date.UTC(year, 0, 4));
  const wk = 1 + Math.round(((thursday - week1) / 86400000 - 3 + ((week1.getUTCDay() + 6) % 7)) / 7);
  return `${year}-W${pad(wk)}`;
}

export function periodKey(ms, mode) {
  if (mode === 'week') return weekKey(ms);
  if (mode === 'month') return monthKey(ms);
  if (mode === 'year') return yearKey(ms);
  return dayKey(ms);
}

export function periodBounds(ms, mode) {
  const d = toFixedDate(ms);
  const year = d.getUTCFullYear();
  const month = d.getUTCMonth();
  const date = d.getUTCDate();
  const offsetMs = getFixedOffset() * 60000;

  if (mode === 'year') {
    const from = Date.UTC(year, 0, 1, 0, 0, 0, 0) + offsetMs;
    const to = Date.UTC(year, 11, 31, 23, 59, 59, 999) + offsetMs;
    return { from, to };
  }
  if (mode === 'month') {
    const from = Date.UTC(year, month, 1, 0, 0, 0, 0) + offsetMs;
    const to = Date.UTC(year, month + 1, 0, 23, 59, 59, 999) + offsetMs;
    return { from, to };
  }
  if (mode === 'week') {
    const day = (d.getUTCDay() + 6) % 7;
    const from = Date.UTC(year, month, date - day, 0, 0, 0, 0) + offsetMs;
    const to = from + 7 * 86400000 - 1;
    return { from, to };
  }
  const from = Date.UTC(year, month, date, 0, 0, 0, 0) + offsetMs;
  const to = from + 86400000 - 1;
  return { from, to };
}

function pad(n) {
  return String(n).padStart(2, '0');
}
