// Reusable revision-history modal. Timeline of every appended revision of one
// entity (bill | person | test | lab | doctor | user), newest first, with a
// per-step diff. Also renders a user's authored activity (bills + people).
//
// Self-contained: owns its DOM lookups, keyboard nav, and the diff engine.
// Open from anywhere via openRevisions(entity, id).
// Element ids live in index.html (#revisions-modal, -title, -meta, -list).

import db from '../core/db.js';
import { el } from './dom.js';
import { createListNav } from './pages/listNav.js';
import { openModal } from './modals/index.js';
import { timeAgo } from '../core/time.js';
import { diffValues, contentKeys, BILL_SKIP } from '../core/diff.js';
import { listUsers, isAdmin, currentUserSync } from '../core/auth.js';

let wired = false;
let nav; // keyboard list navigation (timeline)

function items() {
  const list = el('revisions-list');
  return list ? Array.from(list.children) : [];
}

function span(cls, text) {
  const s = document.createElement('span');
  s.className = cls;
  s.textContent = text == null ? '' : String(text);
  return s;
}

// Wait until a modal shell is open AND its body has finished rendering.
// openModal() fills the body a tick after showModal(), so element lookups
// for #revisions-list / #revisions-title must wait for that.
async function waitModalRendered(id, timeoutMs) {
  const lim = timeoutMs == null ? 2500 : timeoutMs;
  const t0 = Date.now();
  while (Date.now() - t0 < lim) {
    const d = el(id);
    if (d && d.open && !d.classList.contains('is-rendering')) return d;
    await new Promise((r) => setTimeout(r, 20));
  }
  return el(id);
}

function wireOnce() {
  if (wired) return;
  wired = true;
  nav = createListNav({
    getRows: items,
    getBody: () => el('revisions-list'),
    activeClass: 'hx-active',
    isOpen: () => {
      const m = el('revisions-modal');
      return !!(m && m.open);
    },
    onEscape: () => closeRevisions(),
  });
  document.addEventListener('keydown', (e) => nav.keydown(e));
}

export function closeRevisions() {
  if (nav) nav.clear();
  const modal = el('revisions-modal');
  if (modal && modal.open) modal.close();
  activityState = null;
  revState = null;
}

// ---- diff engine ------------------------------------------------------
// Human labels. Falls back to the raw key. (Key selection + equality live in
// core/diff.js; this layer only formats.)
const LABELS = {
  id: 'Bill No', name: 'Name', mob: 'Mobile', age: 'Age', gender: 'Gender',
  weight: 'Weight', datetime: 'Date', items: 'Tests', hid: 'Visibility',
  labId: 'Lab', labV: 'Lab version', docId: 'Referred', docV: 'Referred version',
  pId: 'Patient', pV: 'Patient version', headId: 'Family head',
  disc_amt: 'Discount ₹', discount_per: 'Discount %',
  cust_total: 'Subtotal', merch_total: 'Merchant total', cust_payable: 'Payable',
  grand_total: 'Grand total', payment: 'Payment',
  sell: 'Sell', buy: 'Buy', username: 'Username', role: 'Role', disabled: 'Disabled',
};

function fmt(key, val) {
  if (key === 'hid') return val ? 'deleted' : 'active';
  if (key === 'payment') return Number(val) === 0 ? 'Unpaid' : Number(val) === 2 ? 'UPI' : 'Cash';
  if (key === 'disabled') return val ? 'disabled' : 'active';
  if (key === 'items') {
    const arr = Array.isArray(val) ? val : [];
    if (!arr.length) return '—';
    return arr.map((t) => `#${t.itemId}@${t.itemV}${t.hid ? ' (x)' : ''}`).join(', ');
  }
  if (key === 'weight') return val == null ? '—' : val + ' kg';
  if (key.endsWith('Id')) return val == null ? '—' : '#' + val;
  if (key.endsWith('V')) return val == null ? '—' : 'v' + val;
  return val == null || val === '' ? '—' : String(val);
}

// Reference keys resolve to the entity they point at, so the timeline can
// expand them in place (one level) instead of hiding them.
const REF_KIND = {
  pId: { kind: 'person', idKey: 'pId' },
  pV: { kind: 'person', idKey: 'pId' },
  labId: { kind: 'lab', idKey: 'labId' },
  labV: { kind: 'lab', idKey: 'labId' },
  docId: { kind: 'doctor', idKey: 'docId' },
  docV: { kind: 'doctor', idKey: 'docId' },
};

// Pin arrays -> added/removed sets, so "Tests" reads as a delta, not two blobs.
function itemsDelta(from, to) {
  const key = (t) => Number(t.itemId) + '@' + Number(t.itemV) + (t.hid ? 'x' : '');
  const a = new Set((Array.isArray(from) ? from : []).map(key));
  const b = new Set((Array.isArray(to) ? to : []).map(key));
  const added = [...b].filter((k) => !a.has(k));
  const removed = [...a].filter((k) => !b.has(k));
  const show = (arr) => (arr.length ? arr.map((k) => '#' + k).join(', ') : null);
  return { from: show(removed), to: show(added) };
}

// Compare two revisions of the same root. Returns changed fields as
// [{ key, label, from, to, ref? }]. `prev` may be null (first revision = created).
// skip: entity-specific content exclusions (bills pass BILL_SKIP).
export function diffRevisions(prev, cur, skip) {
  // Cost fields are admin only
  const hide = isAdmin(currentUserSync()) ? null : new Set(['merch_total', 'buy']);
  const keys = contentKeys(prev, cur, skip).filter((k) => !(hide && hide.has(k)));
  return diffValues(prev, cur, keys).map((c) => {
    const row = {
      key: c.key,
      label: LABELS[c.key] || c.key,
      from: prev ? fmt(c.key, c.from) : null,
      to: fmt(c.key, c.to),
    };
    if (c.key === 'items') {
      const d = itemsDelta(c.from, c.to);
      row.from = d.from;
      row.to = d.to;
      row.ref = { kind: 'items', id: null };
    } else if (REF_KIND[c.key]) {
      row.ref = { kind: REF_KIND[c.key].kind, id: cur ? cur[REF_KIND[c.key].idKey] : null };
    }
    return row;
  });
}

// ---- rendering --------------------------------------------------------

async function userMap() {
  const map = new Map();
  try {
    for (const u of await listUsers()) map.set(Number(u.id), u.username || 'user #' + u.id);
  } catch {
    /* attribution falls back to ids */
  }
  return map;
}

function renderStep(rev, prev, index, users, isBill) {
  const item = document.createElement('div');
  item.className = 'hx-item rev-item' + (rev.hid ? ' hidden-rev' : '');
  item.dataset.v = String(rev.v);

  const dot = document.createElement('div');
  dot.className = 'hx-dot';

  const body = document.createElement('div');
  body.className = 'hx-body';

  const head = document.createElement('div');
  head.className = 'hx-head';
  const stamp = rev.revAt || rev.crtAt;
  const when = stamp ? new Date(stamp) : null;
  const abs = when ? when.toLocaleString() : '';
  const rel = stamp ? timeAgo(stamp) : '';
  const isCurrent = index === 0;
  let badge = 'superseded';
  let badgeCls = 'hx-badge badge-superseded';
  if (rev.hid) {
    badge = 'deleted';
    badgeCls = 'hx-badge badge-hidden';
  } else if (isCurrent) {
    badge = 'current';
    badgeCls = 'hx-badge badge-current';
  }
  const uname =
    rev.uId != null ? (users && users.get(Number(rev.uId))) || 'user #' + rev.uId : '';
  head.append(
    span('hx-date', 'v' + rev.v),
    span(badgeCls, badge),
    ...(uname ? [span('hx-badge badge-user', uname)] : []),
    span('hx-time', rel ? rel + (abs ? ' · ' + abs : '') : abs)
  );

  const meta = document.createElement('div');
  meta.className = 'hx-meta rev-changes';
  if (!prev) {
    meta.textContent = 'created';
  } else {
    const changes = diffRevisions(prev, rev, isBill ? BILL_SKIP : null);
    if (!changes.length) {
      meta.textContent = 'no field change';
    } else {
      for (const c of changes) meta.appendChild(revChangeRow(c, rev, prev));
    }
  }
  body.append(head, meta);
  item.append(dot, body);
  return item;
}

// One change row. Reference rows are buttons that expand (one level) to the
// referenced entity's own field diff.
function revChangeRow(c, rev, prev) {
  const row = document.createElement('div');
  row.className = 'rev-change';
  const value = c.from == null ? c.to : c.from + ' → ' + c.to;
  if (!c.ref) {
    row.append(span('rev-label', c.label), span('rev-val', value));
    return row;
  }
  row.classList.add('expandable');
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'rev-ref';
  btn.append(span('rev-label', c.label), span('rev-val', value));
  const child = document.createElement('div');
  child.className = 'rev-ref-body';
  child.hidden = true;
  btn.addEventListener('click', async () => {
    if (!child.dataset.loaded) {
      child.dataset.loaded = '1';
      const rows = await refDiff(c.ref, rev, prev);
      if (!rows.length) {
        child.textContent = 'no field change';
      } else {
        for (const r of rows) {
          const rr = document.createElement('div');
          rr.className = 'rev-change';
          rr.append(span('rev-label', r.label), span('rev-val', r.from == null ? r.to : r.from + ' → ' + r.to));
          child.appendChild(rr);
        }
      }
    }
    child.hidden = !child.hidden;
    row.classList.toggle('expanded', !child.hidden);
  });
  row.append(btn, child);
  return row;
}

// Open the revision timeline for one entity. entity: bill|person|test|lab|doctor|user.
const REV_PAGE = 20;
let revState = null; // { entity, id, beforeV, users, loaded, loading, done, noun }

// Store map for reference lookups (mirrors db.reads.REV_STORE).
const REF_STORE = { person: 'people', lab: 'labRevs', doctor: 'doctorRevs' };
// id field / version field per ref kind.
const REF_ID = { person: 'pId', lab: 'labId', doctor: 'docId' };
const REF_V = { person: 'pV', lab: 'labV', doctor: 'docV' };

// Fields shown for an expanded reference, as plain (non-recursive) rows.
// `noun` relabels the entity's own `id` (e.g. "Lab No", not "Bill No").
function fieldRows(old, cur, noun) {
  return diffValues(old, cur).map((c) => ({
    key: c.key,
    label: c.key === 'id' && noun ? noun + ' No' : LABELS[c.key] || c.key,
    from: old ? fmt(c.key, c.from) : null,
    to: fmt(c.key, c.to),
  }));
}

const REF_NOUN = { person: 'Patient', lab: 'Lab', doctor: 'Doctor' };

// One-level ref diff for a bill revision. `ref`: {kind, id}. Resolves BOTH
// sides to the referenced entity the bill pinned at that revision (id may
// differ too — e.g. the bill was switched to another lab).
async function refDiff(ref, rev, prev) {
  if (!prev || !ref) return [];
  if (ref.kind === 'items') return itemsRefDiff(rev, prev);
  const store = REF_STORE[ref.kind];
  const idKey = REF_ID[ref.kind];
  const vKey = REF_V[ref.kind];
  if (!store || !idKey || !vKey) return [];
  if (Number(prev[idKey]) === Number(rev[idKey]) && Number(prev[vKey]) === Number(rev[vKey])) {
    return [];
  }
  // Bills pin pV but not labV/docV, so fall back to the referenced entity's
  // latest revision when no version is recorded.
  const resolve = async (id, v) => {
    if (id == null) return null;
    if (v != null) return db.raw[store].get([Number(id), Number(v)]);
    const all = await db.revisionsOf(ref.kind, Number(id));
    return all.length ? all[all.length - 1] : null;
  };
  const old = await resolve(prev[idKey], prev[vKey]);
  const cur = await resolve(rev[idKey], rev[vKey]);
  if (!cur && !old) return [];
  return fieldRows(old, cur, REF_NOUN[ref.kind]);
}

// Each item pin that moved to a new itemV -> its test revision diff.
async function itemsRefDiff(rev, prev) {
  const curPins = Array.isArray(rev.items) ? rev.items : [];
  const oldPins = Array.isArray(prev.items) ? prev.items : [];
  const out = [];
  for (const p of curPins) {
    const before = oldPins.find((x) => Number(x.itemId) === Number(p.itemId));
    const aV = before ? Number(before.itemV) : null;
    const bV = Number(p.itemV);
    if (aV == null || aV === bV) continue;
    const old = await db.raw.testRevs.get([Number(p.itemId), aV]);
    const cur = await db.raw.testRevs.get([Number(p.itemId), bV]);
    if (!cur) continue;
    for (const r of fieldRows(old, cur, 'Test')) {
      out.push({ label: 'Test #' + p.itemId + ' · ' + r.label, from: r.from, to: r.to });
    }
  }
  return out;
}

async function loadMoreRevisions() {
  const st = revState;
  if (!st || st.loading || st.done) return;
  st.loading = true;
  const shell = el('revisions-modal');
  const listEl = el('revisions-list');
  const metaEl = el('revisions-meta') || (shell && shell.querySelector('.m-sub'));
  const spinner = el('revisions-loading');
  if (spinner) spinner.hidden = false;
  try {
    const { items, hasMore, nextBeforeV } = await db.revisionsPage(st.entity, st.id, {
      beforeV: st.beforeV,
      limit: REV_PAGE,
    });
    for (const { rev, prev } of items) {
      const isBill = st.entity === 'bill';
      listEl.appendChild(renderStep(rev, prev, st.loaded, st.users, isBill));
      st.loaded++;
    }
    st.beforeV = nextBeforeV;
    st.done = !hasMore || items.length === 0;
    if (metaEl) metaEl.textContent = st.loaded + (st.done ? '' : '+') + ' revision' + (st.loaded === 1 ? '' : 's');
    if (st.done && st.loaded === 0) {
      const empty = document.createElement('p');
      empty.className = 'hint';
      empty.textContent = 'No revisions.';
      listEl.appendChild(empty);
    }
  } finally {
    st.loading = false;
    if (spinner) spinner.hidden = true;
  }
}

export async function openRevisions(entity, id, { title } = {}) {
  if (!entity || id == null) return;
  wireOnce();
  const shell = el('revisions-modal');
  if (!shell) return;
  // Open the shell FIRST — the modal system fills the body (including
  // #revisions-list) after openModal runs. Do NOT await openModal: its
  // promise resolves on close, which would block everything below.
  openModal('revisions', { entity, id });
  await waitModalRendered('revisions-modal');
  const shellEl = el('revisions-modal');
  const titleEl = el('revisions-title') || (shellEl && shellEl.querySelector('.m-title'));
  const metaEl = el('revisions-meta') || (shellEl && shellEl.querySelector('.m-sub'));
  const listEl = el('revisions-list');
  if (!listEl) return;

  const noun = entity[0].toUpperCase() + entity.slice(1);
  if (titleEl) titleEl.textContent = title || noun + ' revisions';
  // (the modal shell owns show/close; we only fill it)
  if (metaEl) metaEl.textContent = 'loading…';
  listEl.replaceChildren();
  if (nav) nav.clear();

  revState = {
    entity,
    id: Number(id),
    beforeV: null,
    users: await userMap(),
    loaded: 0,
    loading: false,
    done: false,
  };
  activityState = null;
  wireListScroll();
  const scrollBox = listEl.parentElement;
  if (scrollBox) scrollBox.scrollTop = 0;


  await loadMoreRevisions();
}

// Back-compat wrapper.
export function openBillRevisions(id) {
  return openRevisions('bill', id, { title: 'Bill revisions' });
}

// ---- user activity (authored changes) ---------------------------------

const ACTIVITY_PAGE = 15;
let activityState = null; // { uId, offset, total, loading, done }

async function loadMoreActivity() {
  const st = activityState;
  if (!st || st.loading || st.done) return;
  st.loading = true;
  const listEl = el('revisions-list');
  const spinner = el('revisions-loading');
  if (spinner) spinner.hidden = false;
  try {
    const { items: page, total, hasMore } = await db.activityForUser(st.uId, {
      offset: st.offset,
      limit: ACTIVITY_PAGE,
    });
    for (const e of page) listEl.appendChild(renderActivityStep(e));
    st.offset += page.length;
    st.total = total;
    st.done = !hasMore || page.length === 0;
    const shellAct = el('revisions-modal');
    const metaEl = el('revisions-meta') || (shellAct && shellAct.querySelector('.m-sub'));
    if (metaEl) metaEl.textContent = st.offset + ' of ' + st.total + ' change' + (st.total === 1 ? '' : 's');
    if (st.done && st.offset === 0) {
      const empty = document.createElement('p');
      empty.className = 'hint';
      empty.textContent = 'No activity by this user.';
      listEl.appendChild(empty);
    }
  } finally {
    st.loading = false;
    if (spinner) spinner.hidden = true;
  }
}

let _listScrollWired = false;
function wireListScroll() {
  const listEl = el('revisions-list');
  const box = listEl && listEl.parentElement;
  if (!box || _listScrollWired) return;
  _listScrollWired = true;
  box.addEventListener('scroll', (e) => {
    const b = e.target;
    if (b.scrollTop + b.clientHeight < b.scrollHeight - 120) return;
    if (revState) loadMoreRevisions();
    else if (activityState) loadMoreActivity();
  });
}

export async function openUserActivity(uId, username) {
  if (uId == null) return;
  wireOnce();
  const shell = el('revisions-modal');
  if (!shell) return;
  openModal('revisions', {});
  await waitModalRendered('revisions-modal');
  const shellEl = el('revisions-modal');
  const titleEl = el('revisions-title') || (shellEl && shellEl.querySelector('.m-title'));
  const metaEl = el('revisions-meta') || (shellEl && shellEl.querySelector('.m-sub'));
  const listEl = el('revisions-list');
  if (!listEl) return;

  if (titleEl) titleEl.textContent = (username || 'User #' + uId) + ' — activity';
  if (metaEl) metaEl.textContent = 'loading…';
  listEl.replaceChildren();
  if (nav) nav.clear();

  activityState = { uId: Number(uId), offset: 0, total: 0, loading: false, done: false };
  revState = null;
  wireListScroll();
  const scrollBox = listEl.parentElement;
  if (scrollBox) scrollBox.scrollTop = 0;


  await loadMoreActivity();
}

function renderActivityStep(entry) {
  const { kind, rev, prev } = entry;
  const item = document.createElement('div');
  item.className = 'hx-item rev-item';
  item.dataset.kind = kind;

  const dot = document.createElement('div');
  dot.className = 'hx-dot';

  const body = document.createElement('div');
  body.className = 'hx-body';

  const head = document.createElement('div');
  head.className = 'hx-head';
  const stamp = rev.revAt || rev.crtAt;
  const when = stamp ? new Date(stamp) : null;
  const abs = when ? when.toLocaleString() : '';
  const rel = stamp ? timeAgo(stamp) : '';
  const kindLabel = kind === 'bill' ? 'bill' : 'patient';
  const kindCls = 'hx-badge ' + (kind === 'bill' ? 'badge-current' : 'badge-superseded');
  const ent = kind === 'bill' ? 'Bill ' + rev.id : rev.name || '#' + rev.id;
  head.append(
    span(kindCls, kindLabel),
    span('hx-date', 'v' + rev.v),
    span('hx-entity', ent),
    span('hx-time', rel ? rel + (abs ? ' · ' + abs : '') : abs)
  );

  const meta = document.createElement('div');
  meta.className = 'hx-meta rev-changes';
  if (!prev) {
    meta.textContent = 'created';
  } else {
    const changes = diffRevisions(prev, rev, kind === 'bill' ? BILL_SKIP : null);
    if (!changes.length) meta.textContent = 'no field change';
    else {
      for (const c of changes) {
        const row = document.createElement('div');
        row.className = 'rev-change';
        row.append(
          span('rev-label', c.label),
          span('rev-val', c.from == null ? c.to : c.from + ' → ' + c.to)
        );
        meta.appendChild(row);
      }
    }
  }
  body.append(head, meta);
  item.append(dot, body);
  return item;
}
