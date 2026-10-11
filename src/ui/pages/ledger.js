// Ledger tab (Ctrl+8): a plain-language money diary.
//
// Shows, in simple words, what happened with money:
//   - Money received   (cash / UPI that came in)
//   - Not paid yet     (bills given on credit, still to collect)
//   - Collected later  (credit bills that were paid afterwards)
// One period (Day / Week / Month / Year) at a time, newest first.
// Every line is a sentence: who, which bill, what happened.
// Scope: whole lab, or a single patient (drill-in from Patients).

import db from '../../core/db.js';
import { money, money0 } from '../../core/money.js';
import { epochToParts, periodKey, periodBounds, timeAgo } from '../../core/time.js';
import { bindOff } from '../dom.js';
import { PAYMENT } from '../../core/enums.js';
import { receiveFamilyPayment, refundFamilyAdvance, addFamilyAdvance } from '../familyPay.js';
import { toast } from '../toast.js';
import Dialog from '../dialog.js';

let st;
let scope = 'global';        // 'global' | 'person'
let scopePId = null;
let scopePName = '';
let _topHidden = true;
let mode = 'day';            // 'day' | 'week' | 'month' | 'year'
let show = 'all';            // 'all' | 'cash' | 'due'
let pIdx = 0;                // 0 = newest period that has entries
let _keys = [];
const _names = new Map();

const getTable = () => document.getElementById('ledger-gl');
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
// Profit per row. Advance received and refunds are not profit (money held for the patient). Profit lands when advance is spent on a bill, and reverses if that bill is deleted.
const profitOf = (e) => {
  const c = Number(e.cashDelta) || 0;
  const d = Number(e.receivableDelta) || 0;
  const mc = Number(e.merchantDelta) || 0;
  if (e.kind === 'ADVANCE' || e.kind === 'REFUND') return 0;
  if (e.kind === 'ADVANCE_APPLY' || e.kind === 'ALLOC_RETURN') return r2(-d);
  return r2(c - mc);
};

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

function periodLabel(key, at) {
  if (mode === 'year') return key;
  if (mode === 'month') {
    const [y, mo] = key.split('-');
    return new Date(Number(y), Number(mo) - 1, 1).toLocaleString(undefined, { month: 'long', year: 'numeric' });
  }
  const { from, to } = periodBounds(at, mode);
  const p = from ? epochToParts(from) : null;
  const q = to ? epochToParts(to) : null;
  if (mode === 'week') return p && q ? `${p.date} to ${q.date}` : key;
  return p ? p.date : key;
}

async function nameOf(pId) {
  if (pId == null) return '';
  if (_names.has(pId)) return _names.get(pId);
  const p = await db.getPerson(pId);
  const n = p ? p.name : '#' + pId;
  _names.set(pId, n);
  return n;
}

function kindPill(kind) {
  const map = {
    SALE_CASH: ['Paid', 'ok'],
    SALE_CREDIT: ['Credit', 'warn'],
    PAY: ['Paid', 'ok'],
    PAY_PART: ['Part paid', 'ok'],
    ADVANCE: ['Advance', 'accent'],
    ADVANCE_APPLY: ['Advance', 'accent'],
    REFUND: ['Refund', 'err'],
    ALLOC_RETURN: ['Returned', 'warn'],
    UNPAY: ['Unpaid', 'warn'],
    DELETE: ['Deleted', 'err'],
    RESTORE: ['Restored', 'ok'],
    ADJUST: ['Adjusted', 'warn'],
  };
  return map[kind] || [kind, ''];
}

// Who actually handed over the money for a payment row (the family head),
// and how (cash / UPI). Null for rows that are not tied to a payment.
const _payCache = new Map();
async function payInfo(e) {
  if (e.payId == null) return null;
  if (_payCache.has(e.payId)) return _payCache.get(e.payId);
  const pay = await db.raw.payments.get(Number(e.payId));
  const info = pay
    ? { payer: await nameOf(pay.headId), payerId: Number(pay.headId), via: Number(pay.method) === PAYMENT.UPI ? 'UPI' : 'cash' }
    : null;
  _payCache.set(e.payId, info);
  return info;
}

// One plain sentence per ledger event: who paid whom, how much, which bill.
// `who` = patient the bill belongs to. `pay` = { payer, via } for payment rows.
function sentence(e, who, pay) {
  const ref = e.billId != null ? e.billId : e.forBill;
  const bill = ref != null ? 'Bill #' + ref : 'a bill';
  const payer = pay && pay.payer ? pay.payer : who;
  const same = pay && pay.payerId != null ? pay.payerId === Number(e.pId) : payer === who;
  const other = same ? '' : ` (${who})`;
  const head = same ? payer : 'Head ' + payer;
  switch (e.kind) {
    case 'SALE_CASH': return `${who} paid ${bill}`;
    case 'SALE_CREDIT': return `${bill} (${who}) given on credit`;
    case 'PAY': return `${who} paid ${bill}`;
    case 'PAY_PART': return `${head} paid ${bill}${other}`;
    case 'ADVANCE': return `${head} paid advance`;
    case 'ADVANCE_APPLY': return `${head} paid ${bill}${other} using advance`;
    case 'REFUND': return `Advance refunded to ${head}`;
    case 'ALLOC_RETURN': return `${bill}${other} deleted — payment back to advance`;
    case 'UNPAY': return `${bill} (${who}) payment cancelled`;
    case 'DELETE': return `${bill} (${who}) deleted`;
    case 'RESTORE': return `${bill} (${who}) restored`;
    case 'ADJUST': return `${bill} (${who}) amount changed`;
    default: return `${who} — ${e.kind}`;
  }
}

async function renderScopeBar() {
  const nameEl = document.getElementById('ledger-scope-name');
  const clearBtn = document.getElementById('ledger-scope-clear');
  const bar = document.getElementById('ledger-scope');
  const inFamily = scope === 'person';
  nameEl.textContent = inFamily ? 'Ledger family: ' + (scopePName || '#' + scopePId) : 'Ledger: whole lab';
  if (bar) bar.hidden = false;
  clearBtn.hidden = !inFamily;
  // All-time toggle is for the whole-lab view; the family view gets actions.
  const sumBtn = document.getElementById('ledger-summary-btn');
  if (sumBtn) sumBtn.hidden = inFamily;
  const actions = document.getElementById('ledger-scope-actions');
  const addBtn = document.getElementById('ledger-add-btn');
  const payBtn = document.getElementById('ledger-pay-btn');
  const refBtn = document.getElementById('ledger-refund-btn');
  const advBtn = document.getElementById('ledger-advance-btn');
  let due = 0;
  let adv = 0;
  if (inFamily) {
    const dueBills = await db.familyDueBills(scopePId);
    due = dueBills.reduce((s, d) => s + d.due, 0);
    adv = await db.advanceBalance(scopePId);
  }
  for (const b of [addBtn, payBtn, refBtn, advBtn]) if (b) b.dataset.id = String(scopePId);
  if (actions) actions.hidden = !inFamily;
  if (addBtn) addBtn.hidden = !inFamily;
  if (advBtn) advBtn.hidden = !inFamily;
  if (payBtn) {
    payBtn.hidden = !(inFamily && due > 0);
    payBtn.textContent = 'Pay due ₹' + money(due);
  }
  if (refBtn) {
    refBtn.hidden = !(inFamily && adv > 0);
    refBtn.textContent = 'Refund advance ₹' + money(adv);
  }
}

// Family cards: head first, then members, shown only in a family ledger.
async function renderFamily() {
  const host = document.getElementById('ledger-family');
  if (!host) return;
  host.replaceChildren();
  host.hidden = scope !== 'person';
  if (scope !== 'person') return;
  const ids = await db.familyIds(scopePId);
  const people = [];
  for (const id of ids) {
    const p = await db.getPerson(id);
    if (p && !p.hid) people.push(p);
  }
  const headId = Number(scopePId);
  people.sort((a, b) => (Number(a.id) === headId ? -1 : Number(b.id) === headId ? 1 : String(a.name).localeCompare(String(b.name))));
  const adv = await db.advanceBalance(headId);
  for (const p of people) {
    const isHead = Number(p.id) === headId;
    const due = Number(p.pending) || 0;
    const card = el('div', 'family-card' + (isHead ? ' head' : '') + (due > 0 ? ' has-due' : ''));
    const top = el('div', 'family-top');
    const role = el('div', 'family-role');
    role.append('#' + p.id + (p.mob ? ' · ' + p.mob : ''));
    top.append(el('div', 'family-name', p.name || '#' + p.id), role);
    const stats = el('div', 'family-stats');
    stats.append(
      el('span', 'family-stat', (p.billsCount || 0) + ' bill' + ((p.billsCount || 0) === 1 ? '' : 's')),
      el('span', 'family-stat' + (due > 0 ? ' warn' : ' ok'), due > 0 ? 'Due ₹' + money(due) : 'No dues')
    );
    if (isHead && adv > 0) stats.append(el('span', 'family-stat ok', 'Advance ₹' + money(adv)));
    card.append(el('div', 'family-avatar', String(p.name || '?').trim().charAt(0).toUpperCase()), top, stats);
    stats.style.gridColumn = '1 / -1';
    const mk = (label, act, cls) => {
      const b = el('button', 'family-btn' + (cls ? ' ' + cls : ''), label);
      b.type = 'button';
      b.dataset.act = act;
      b.dataset.id = String(p.id);
      return b;
    };
    card.append(el('span', 'family-badge', isHead ? 'Head' : 'Member'));
    if (!isHead) {
      const x = mk('×', 'remove', 'family-remove');
      x.title = 'Remove from this family';
      x.setAttribute('aria-label', 'Remove ' + (p.name || '#' + p.id) + ' from this family');
      card.append(x);
    }
    host.appendChild(card);
  }
}

async function renderSummary() {
  const host = document.getElementById('ledger-summary');
  if (!host) return;
  const off = _topHidden || scope === 'person';
  host.hidden = off;
  host.replaceChildren();
  if (off) return;

  // Admin overview: one read (db.ledgerOverview), shown as titled sections.
  const o = await db.ledgerOverview({ headId: scope === 'person' ? scopePId : null });
  const s = o.sum;
  const rs = (v) => '₹' + money0(v);
  const stat = (label, value, cls, tip) => {
    const box = el('div', 'stat' + (cls ? ' ' + cls : ''));
    box.title = tip || '';
    box.append(el('span', 'stat-label', label), el('span', 'stat-value', value));
    return box;
  };
  const card = (title, stats, wide) => {
    const c = el('section', 'sum-card' + (wide ? ' wide' : ''));
    c.appendChild(el('h4', 'sum-title', title));
    const row = el('div', 'sum-row');
    for (const x of stats) row.appendChild(x);
    c.appendChild(row);
    return c;
  };
  const ag = o.aging;
  host.append(
    card('Sales', [
      stat('Bills', String(s.count), '', 'All live bills in this scope'),
      stat('Billed', rs(s.custTotal), '', 'Before discount'),
      stat('Discount', rs(o.discount), o.discount > 0 ? 'warn' : '', 'Given to customers'),
      stat('Total sales', rs(s.total), 'accent', 'After discount'),
      stat('Avg bill', rs(o.avgBill), ''),
    ]),
    card('Money in hand', [
      stat('Received', rs(o.received), 'ok', 'Cash + UPI + part payments'),
      stat('Cash', rs(s.cash), 'ok'),
      stat('UPI', rs(s.upi), 'upi'),
      stat('Part paid', rs(s.partial), 'ok', 'Collected on credit bills'),
      stat('Collected', o.collectedPct + '%', o.collectedPct >= 90 ? 'ok' : 'warn', 'Received / total sales'),
    ]),
    card('To collect', [
      stat('Outstanding', rs(s.unpaidTotal), s.unpaidTotal ? 'err' : 'ok', 'Credit still unpaid'),
      stat('Open bills', String(s.unpaid), s.unpaid ? 'warn' : ''),
      stat('Oldest due', o.oldestDueDays + ' d', o.oldestDueDays > 30 ? 'err' : o.oldestDueDays > 7 ? 'warn' : ''),
      stat('Advance held', rs(o.advance), 'accent', 'Owed back to customers'),
      stat('Refunded', rs(o.flow.refunds), o.flow.refunds ? 'err' : ''),
    ]),
    card('Profit', [
      stat('Lab cost', rs(s.merchTotal), 'err', 'What labs charge us'),
      stat('Gross profit', rs(s.grossProfit), 'ok', 'Total sales − lab cost'),
      stat('Margin', o.margin + '%', o.margin < 0 ? 'err' : 'ok'),
      stat('Net profit', rs(s.netProfit), s.netProfit < 0 ? 'err' : 'ok', 'Gross profit − outstanding'),
    ]),
    card('Dues by age', [
      stat('0–7 days', rs(ag.d0_7), ag.d0_7 ? 'warn' : ''),
      stat('8–30 days', rs(ag.d8_30), ag.d8_30 ? 'warn' : ''),
      stat('31–90 days', rs(ag.d31_90), ag.d31_90 ? 'err' : ''),
      stat('90+ days', rs(ag.d90p), ag.d90p ? 'err' : ''),
    ])
  );
  const topCard = el('section', 'sum-card wide');
  topCard.appendChild(el('h4', 'sum-title', 'Top dues'));
  if (!o.top.length) {
    topCard.appendChild(el('p', 'hint', 'Nobody owes anything.'));
  } else {
    const ul = el('ul', 'sum-top');
    for (const t of o.top) {
      const li = el('li', '');
      li.append(el('span', 'sum-top-name', t.name), el('span', 'sum-top-amt', rs(t.due)));
      ul.appendChild(li);
    }
    topCard.appendChild(ul);
  }
  host.appendChild(topCard);
}

async function render() {
  const all = scope === 'person' ? await db.ledgerForFamily(scopePId) : await db.ledgerAll();
  await renderSummary();
  await renderScopeBar();
  await renderFamily();

  // Only events that move cash or dues matter to a normal reader.
  const base = all
    .filter((e) => (Number(e.cashDelta) || 0) || (Number(e.receivableDelta) || 0))
    .sort((x, y) => x.at - y.at || (x.id || 0) - (y.id || 0));
  const groups = new Map();
  for (const e of base) {
    const k = periodKey(e.at, mode);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(e);
  }
  _keys = Array.from(groups.keys()).sort().reverse();
  if (pIdx < 0) pIdx = 0;
  if (pIdx >= _keys.length) pIdx = Math.max(0, _keys.length - 1);

  const table = getTable();
  table.replaceChildren();
  const empty = document.getElementById('ledger-empty');
  if (empty) {
    empty.hidden = _keys.length > 0;
    empty.textContent = 'Nothing has happened yet. Save a bill and it will appear here.';
  }
  const info = document.getElementById('ledger-page-info');
  const hint = document.getElementById('ledger-page-hint');
  const prev = document.getElementById('ledger-prev-btn');
  const next = document.getElementById('ledger-next-btn');
  if (!_keys.length) {
    if (info) info.textContent = '';
    if (hint) hint.value = '';
    const ph = document.getElementById('ledger-period');
    if (ph) ph.replaceChildren();
    prev.disabled = true;
    next.disabled = true;
    return;
  }

  const key = _keys[pIdx];
  const group = groups.get(key);
  const first = group[0];
  const last = group[group.length - 1];

  let received = 0, newUnpaid = 0, collected = 0, refunded = 0, labCost = 0, netProfit = 0;
  let advIn = 0, partIn = 0, advUsed = 0;
  let profitCash = 0, advSpent = 0;
  for (const e of group) {
    const c = Number(e.cashDelta) || 0;
    const d = Number(e.receivableDelta) || 0;
    if (e.kind === 'ADVANCE' && c > 0) advIn += c;
    if (e.kind === 'PAY_PART' && c > 0) partIn += c;
    if (e.kind === 'ADVANCE_APPLY' && d < 0) advUsed += -d;
    if (c > 0) received += c; else refunded += -c;
    if (e.kind === 'DELETE' || e.kind === 'RESTORE') newUnpaid += d; else if (e.kind === 'ALLOC_RETURN') collected -= d; else if (d > 0) newUnpaid += d; else collected += -d;
    labCost += Number(e.merchantDelta) || 0;
    netProfit += profitOf(e);
    if (e.kind === 'ADVANCE_APPLY' || e.kind === 'ALLOC_RETURN') advSpent += -d;
    else if (e.kind !== 'ADVANCE' && e.kind !== 'REFUND') profitCash += c;
  }

  // Period summary: same 11 Bills fields as the top summary, scoped and
  // restricted to the bills created in this period.
  const bounds = periodBounds(first.at, mode);
  let periodBills;
  if (scope === 'person') {
    const mine = await db.familyBills(scopePId);
    periodBills = mine.filter((b) => (b.crtAt || 0) >= bounds.from && (b.crtAt || 0) <= bounds.to);
  } else {
    periodBills = await db.getBillsInRange(bounds.from, bounds.to);
  }
  const periodUnpaid = periodBills.filter((b) => Number(b.payment) === PAYMENT.UNPAID).map((b) => b.id);
  const periodAlloc = await db.allocationsMap(periodUnpaid);
  const ps = db.summarizeBills(periodBills, periodAlloc);
  // Advance applied only to the bills created in this period.
  const periodIds = new Set(periodBills.map((b) => Number(b.id)));
  let advBills = 0;
  for (const e of group) {
    if (e.kind === 'ADVANCE_APPLY' && periodIds.has(Number(e.forBill))) advBills += -(Number(e.receivableDelta) || 0);
  }

  const pHost = document.getElementById('ledger-period');
  pHost.replaceChildren();
  pHost.hidden = false;
  const chip = (label, value, cls, tip) => {
    const box = el('div', 'stat' + (cls ? ' ' + cls : ''));
    box.title = tip || '';
    box.append(el('span', 'stat-label', label), el('span', 'stat-value', value));
    return box;
  };
  const pcard = (title, stats) => {
    const c = el('section', 'sum-card');
    c.appendChild(el('h4', 'sum-title', title));
    const row = el('div', 'sum-row');
    for (const x of stats) row.appendChild(x);
    c.appendChild(row);
    return c;
  };

  const thead = document.createElement('thead');
  thead.innerHTML = '<tr><th>When</th><th>What happened</th><th>Kind</th><th>Mode</th>' +
    '<th>Money received</th><th>Unpaid amount</th>' +
    '<th>Lab cost</th><th>Profit</th></tr>';
  const tbody = document.createElement('tbody');

  const rows = group.filter((e) => {
    if (show === 'cash') return Number(e.cashDelta) || 0;
    if (show === 'due') return Number(e.receivableDelta) || 0;
    return true;
  });
  const signed = (v, posCls, negCls) => {
    if (!v) return el('td', '', '');
    const cls = v > 0 ? (posCls || ' pos') : (negCls || ' neg');
    return el('td', cls.trim(), (v > 0 ? '+' : '−') + money(Math.abs(v)));
  };
  let totalLabCost = 0;
  let totalProfit = 0;
  let totalGross = 0;
  let modeCash = 0;
  let modeUpi = 0;
  const isSale = (k) => k === 'SALE_CASH' || k === 'SALE_CREDIT' || k === 'DELETE' || k === 'RESTORE';
  for (const e of rows) {
    const c = Number(e.cashDelta) || 0;
    const d = Number(e.receivableDelta) || 0;
    const mc = Number(e.merchantDelta) || 0;
    const profit = profitOf(e);
    const gross = isSale(e.kind) ? r2((c || d) - mc) : 0;
    totalLabCost += mc;
    totalProfit += profit;
    totalGross += gross;
    const p = epochToParts(e.at);
    const who = await nameOf(e.pId);
    const pay = await payInfo(e);
    let via = pay && pay.via ? pay.via : '';
    if (!via && c && e.billId != null) {
      const bp = await db.raw.billsProj.get(Number(e.billId));
      if (bp) via = Number(bp.payment) === PAYMENT.UPI ? 'UPI' : Number(bp.payment) === PAYMENT.CASH ? 'cash' : '';
    }
    if (via && c) {
      if (via === 'UPI') modeUpi += c; else modeCash += c;
    }
    const tr = el('tr', 'row-click gl-entry' + (d > 0 ? ' gl-credit' : ''));
    if (e.pId != null) tr.dataset.pid = String(e.pId);
    if (e.billId != null) tr.dataset.bill = String(e.billId);
    if (e.payId != null) tr.dataset.payid = String(e.payId);
    tr.append(
      el('td', 'gl-date', (p.date ? p.date.slice(5) + ' ' : '') + (p.time12 || '')),
      el('td', '', sentence(e, who, pay)),
      (() => {
        const td = document.createElement('td');
        const [txt, cls] = kindPill(e.kind);
        const pill = document.createElement('span');
        pill.className = 'hx-badge' + (cls ? ' gl-kind-' + cls : '');
        pill.textContent = txt;
        td.appendChild(pill);
        return td;
      })(),
      (() => {
        const td = document.createElement('td');
        if (via) {
          const m = document.createElement('span');
          m.className = 'hx-badge ' + (via === 'UPI' ? 'gl-kind-upi' : 'gl-kind-ok');
          m.textContent = via === 'UPI' ? 'UPI' : 'Cash';
          td.appendChild(m);
        }
        return td;
      })(),
      signed(c),
      signed(d, ' warn', ' pos'),
      signed(mc, ' warn', ' pos'),
      (() => {
        const td = document.createElement('td');
        const n = document.createElement('span');
        n.className = profit >= 0 ? 'pos' : 'neg';
        n.title = 'Net (cash) profit = received − lab cost';
        n.textContent = (profit > 0 ? '+' : profit < 0 ? '−' : '') + money(Math.abs(profit));
        td.appendChild(n);
        return td;
      })()
    );
    tbody.appendChild(tr);
  }
  if (!rows.length) {
    const tr = el('tr', '');
    tr.appendChild(el('td', 'gl-note', 'Nothing of this kind in this period. Choose "All" above.'));
    tr.firstChild.colSpan = 8;
    tbody.appendChild(tr);
  }
  const rs = (v) => '₹' + money0(v);
  pHost.append(
    pcard('Sales', [
      chip('Bills', String(ps.count), ''),
      chip('Billed', rs(ps.custTotal), '', 'Before discount'),
      chip('Discount', rs(ps.custTotal - ps.total), ps.custTotal - ps.total > 0 ? 'warn' : ''),
      chip('Total sales', rs(ps.total), 'accent', 'After discount'),
    ]),
    pcard('Money in', [
      chip('Received', rs(received), 'ok', 'All cash + UPI that came in'),
      chip('Cash in', rs(modeCash), 'ok'),
      chip('UPI in', rs(modeUpi), 'upi'),
      chip('Part paid', rs(partIn), 'ok'),
      chip('Adv used', rs(r2(advBills)), 'accent', 'Advance spent on bills of this period'),
    ]),
    pcard('To collect', [
      chip('New credit', rs(newUnpaid), newUnpaid ? 'warn' : ''),
      chip('Real credit', rs(Math.max(0, r2(newUnpaid - advBills))), newUnpaid - advBills > 0 ? 'warn' : '', 'New credit minus advance used'),
      chip('Collected', rs(collected), 'ok', 'Earlier dues paid in this period'),
      chip('Open bills', String(ps.unpaid), ps.unpaid ? 'warn' : ''),
      chip('Refunded', rs(refunded), refunded ? 'err' : ''),
    ]),
    pcard('Profit', [
      chip('Lab cost', rs(r2(totalLabCost)), 'err'),
      chip('Gross', rs(r2(totalGross)), 'ok'),
      chip('Net profit', rs(r2(netProfit)), r2(netProfit) < 0 ? 'err' : 'ok'),
    ])
  );

  // Flow trees: each line shows how the figure above it is made up.
  const fnode = (n) => {
    const li = el('li', 'flow-node');
    const row = el('div', 'flow-row');
    row.append(el('span', 'flow-op', n.op || ''), el('span', 'flow-label', n.label), el('span', 'flow-val' + (n.cls ? ' ' + n.cls : ''), rs(n.v)));
    if (n.tip) row.title = n.tip;
    li.appendChild(row);
    if (n.kids && n.kids.length) {
      const ul = el('ul', 'flow-kids');
      for (const k of n.kids) ul.appendChild(fnode(k));
      li.appendChild(ul);
    }
    return li;
  };
  const flowCard = (title, root) => {
    const c = el('section', 'sum-card flow-card');
    c.appendChild(el('h4', 'sum-title', title));
    const ul = el('ul', 'flow-tree');
    ul.appendChild(fnode(root));
    c.appendChild(ul);
    return c;
  };
  const paidNow = r2(ps.cash + ps.upi);
  const onCredit = r2(ps.total - paidNow);
  const billPays = r2(received - partIn - advIn);
  pHost.append(
    flowCard('How sales became money', {
      label: 'Billed (before discount)', v: ps.custTotal, cls: '',
      kids: [
        { op: '−', label: 'Discount given', v: r2(ps.custTotal - ps.total), cls: 'warn' },
        {
          op: '=', label: 'Total sales', v: ps.total, cls: 'accent',
          kids: [
            {
              op: '→', label: 'Paid at billing', v: paidNow, cls: 'ok',
              kids: [
                { op: '→', label: 'Cash', v: r2(ps.cash), cls: 'ok' },
                { op: '→', label: 'UPI', v: r2(ps.upi), cls: 'upi' },
              ],
            },
            {
              op: '→', label: 'Left on credit', v: onCredit, cls: onCredit ? 'warn' : '',
              kids: [
                { op: '→', label: 'Paid since (part payments / advance)', v: r2(ps.partial), cls: 'ok' },
                { op: '→', label: 'Still to collect', v: r2(ps.unpaidTotal), cls: ps.unpaidTotal ? 'err' : 'ok' },
              ],
            },
          ],
        },
      ],
    }),
    flowCard('Where the money came and went', {
      label: 'Money received', v: r2(received), cls: 'ok',
      kids: [
        { op: '→', label: 'Bill payments at billing', v: billPays, cls: 'ok' },
        { op: '→', label: 'Part payments / dues collected', v: r2(partIn), cls: 'ok' },
        { op: '→', label: 'Advance deposits (not profit)', v: r2(advIn), cls: 'accent' },
        {
          op: '−', label: 'Refunded', v: r2(refunded), cls: refunded ? 'err' : '',
          kids: [{ op: '=', label: 'Money kept', v: r2(received - refunded), cls: 'ok' }],
        },
      ],
    }),
    flowCard('How profit is made', {
      label: 'Cash from sales and dues', v: r2(profitCash), cls: 'ok', tip: 'Cash received, excluding advance deposits and refunds',
      kids: [
        { op: '+', label: 'Advance spent on bills', v: r2(advSpent), cls: 'accent' },
        { op: '−', label: 'Lab cost', v: r2(labCost), cls: 'err' },
        { op: '=', label: 'Net profit', v: r2(netProfit), cls: r2(netProfit) < 0 ? 'err' : 'ok' },
      ],
    })
  );
  const tot = el('tr', 'gl-total');
  tot.append(
    el('td', ''),
    el('td', '', 'Total for this period'),
    el('td', ''),
    (() => {
      const td = document.createElement('td');
      const add = (label, amt, cls) => {
        if (!r2(amt)) return;
        const b = document.createElement('div');
        b.className = cls;
        b.textContent = (amt < 0 ? '−' : '') + money(Math.abs(r2(amt)));
        b.title = label;
        td.appendChild(b);
      };
      add('Cash', modeCash, 'ok');
      add('UPI', modeUpi, 'upi');
      return td;
    })(),
    el('td', '', '+' + money(received) + (refunded ? '  −' + money(refunded) : '')),
    (() => {
      const td = document.createElement('td');
      const add = document.createElement('span');
      add.className = 'warn';
      add.title = 'New credit given this period (bills left unpaid)';
      add.textContent = '+' + money(newUnpaid);
      const sub = document.createElement('span');
      sub.className = 'ok';
      sub.title = 'Collected this period from earlier dues';
      sub.textContent = ' −' + money(collected);
      td.append(add, sub);
      return td;
    })(),
    el('td', '', r2(totalLabCost) ? money(r2(totalLabCost)) : ''),
    (() => {
      const td = document.createElement('td');
      const g = document.createElement('span');
      g.className = 'pos';
      g.title = 'Gross profit (sale margin) for this period';
      g.textContent = '+' + money(r2(totalGross)) + '  ';
      const n = document.createElement('span');
      n.className = r2(totalProfit) >= 0 ? 'pos' : 'neg';
      n.title = 'Net (cash) profit for this period';
      n.textContent = (r2(totalProfit) > 0 ? '+' : r2(totalProfit) < 0 ? '−' : '') + money(Math.abs(r2(totalProfit)));
      td.append(n);
      return td;
    })()
  );
  tbody.appendChild(tot);
  table.append(thead, tbody);
  const legendText = 'Money received: + cash/UPI in, − refunds. Unpaid amount: + new credit given, − collected from earlier dues. Lab cost: cost of tests. Profit: credit sale = − lab cost (nothing received yet); paid sale = received − lab cost; later collection of a credit = + received (cost was already deducted on the credit row, so it is not counted twice).';
  let legend = table.nextElementSibling && table.nextElementSibling.classList && table.nextElementSibling.classList.contains('gl-legend')
    ? table.nextElementSibling
    : null;
  if (!legend) {
    legend = el('p', 'hint gl-legend');
    table.after(legend);
  }
  legend.textContent = legendText;

  if (info) info.textContent = '';
  if (hint) {
    const t = mode === 'day' ? 'date' : mode === 'week' ? 'week' : mode === 'month' ? 'month' : 'number';
    if (hint.type !== t) hint.type = t;
    hint.value = key;
    hint.title = periodLabel(key, first.at) + ' (pick another period)';
  }
  prev.disabled = pIdx >= _keys.length - 1;
  next.disabled = pIdx === 0;
}

// Public: called by Patients page to open the ledger scoped to a person.
export async function openForPerson(pId, pName) {
  scope = 'person';
  // Always open the family head's ledger (member -> head).
  const p = await db.getPerson(pId);
  const headId = p && p.headId != null ? Number(p.headId) : Number(pId);
  const head = headId === Number(pId) ? p : await db.getPerson(headId);
  scopePId = headId;
  scopePName = head ? head.name : (pName || '');
  mode = 'year';
  syncSeg('#ledger-mode', 'mode', mode);
  pIdx = 0;
  const router = await import('../router.js');
  const r = router.getRouter();
  if (r && r.currentTab !== 'ledger') r.activateTab('ledger');
  else await render();
}

export function setGlobalScope() {
  scope = 'global';
  scopePId = null;
  scopePName = '';
  mode = 'day';
  syncSeg('#ledger-mode', 'mode', mode);
  pIdx = 0;
}

// Row click: whole-lab view -> that person's family ledger (member -> head).
// Family view -> a bill that still has dues opens the Receive payment dialog.
async function onRowClick(e) {
  const tr = e.target.closest('tr[data-pid]');
  if (!tr) return;
  try {
    const pId = Number(tr.dataset.pid);
    if (tr.dataset.payid) {
      // Payment row (part paid, advance, refund): open the ledger of whoever paid.
      // The payer is the payment's head; openForPerson also maps member -> head.
      const pay = await db.raw.payments.get(Number(tr.dataset.payid));
      await openForPerson(pay && pay.headId != null ? Number(pay.headId) : pId);
      return;
    }
    if (scope !== 'person') {
      await openForPerson(pId);
      return;
    }
    if (!tr.dataset.bill) return;
    const due = await db.billOutstanding(Number(tr.dataset.bill));
    if (!(due > 0)) {
      toast('Bill ' + tr.dataset.bill + ' is fully paid.', 'ok');
      return;
    }
    const person = await db.getPerson(scopePId);
    if (!person) return;
    if (await receiveFamilyPayment(person)) await render();
  } catch (err) {
    console.error('ledger row click failed', err);
    toast(err && err.message ? err.message : String(err), 'err');
  }
}

// Searchable person picker. Resolves the chosen person id, or null if cancelled.
function pickPerson(title, people, hint, okLabel) {
  return new Promise((resolve) => {
    const dlg = document.createElement('dialog');
    dlg.className = 'modal-dialog';
    const form = el('form', 'modal-card');
    form.method = 'dialog';
    const head = el('header', 'modal-head');
    head.append(el('h2', '', title));
    const body = el('div', 'modal-body');
    const search = document.createElement('input');
    search.type = 'text';
    search.placeholder = 'Search name or mobile';
    search.placeholder = 'Type name or mobile (min 2 letters)…';
    search.autocomplete = 'off';
    const ul = el('ul', 'suggest-list');
    ul.hidden = true;
    ul.style.top = 'auto';
    ul.style.marginTop = '2px';
    ul.style.maxHeight = '200px';
    ul.style.zIndex = '50';
    const anchor = el('div', 'autofill-field');
    anchor.style.position = 'relative';
    const picked = el('div', 'picked-card');
    const setPicked = (p) => {
      picked.replaceChildren();
      picked.classList.toggle('empty', !p);
      if (!p) {
        picked.append(el('span', 'picked-empty', 'No one selected yet'));
        return;
      }
      const meta = [];
      meta.push('#' + p.id);
      if (p.mob) meta.push(p.mob);
      if (p.age != null && p.age !== '') meta.push(p.age + 'y');
      if (p.gender) meta.push(p.gender);
      const txt = el('div', 'picked-text');
      txt.append(el('div', 'picked-name', p.name || '#' + p.id), el('div', 'picked-meta', meta.join(' · ')));
      picked.append(el('div', 'picked-avatar', String(p.name || '?').trim().charAt(0).toUpperCase()), txt);
    };
    setPicked(null);
    const foot = el('footer', 'modal-actions');
    const cancel = el('button', '', 'Cancel');
    cancel.value = 'cancel';
    const ok = el('button', 'primary', okLabel || 'Add');
    ok.value = 'save';
    ok.disabled = true;
    const allowed = new Set(people.map((p) => Number(p.id)));
    let items = [];
    let hi = -1;
    let chosen = null;
    const setHi = (i) => {
      hi = i;
      Array.from(ul.children).forEach((li, k) => li.classList.toggle('hl', k === i));
      if (ul.children[i]) ul.children[i].scrollIntoView({ block: 'nearest' });
    };
    const choose = (p) => {
      chosen = p;
      search.value = p.name || '';
      ul.hidden = true;
      setPicked(p);
      ok.disabled = false;
      ok.focus();
    };
    const row = (c) => {
      const main = el('div', 's-main');
      main.append(el('span', 's-name', c.name || '(no name)'), el('span', 's-ago', timeAgo(c.lastBillAt) || (c.billsCount ? c.billsCount + ' bill(s)' : '')));
      const sub = el('div', 's-sub');
      sub.append(el('span', 's-pid', '#' + c.id));
      if (c.mob) sub.append(el('span', 's-mob', c.mob));
      if (c.age != null && c.age !== '') sub.append(el('span', 's-age', c.age + 'y'));
      if (c.gender) sub.append(el('span', 's-gender', c.gender));
      const f = document.createDocumentFragment();
      f.append(main, sub);
      return f;
    };
    const showList = () => {
      ul.replaceChildren();
      items.forEach((c, i) => {
        const li = document.createElement('li');
        li.append(row(c));
        li.addEventListener('mousedown', (ev) => {
          ev.preventDefault();
          choose(c);
        });
        li.addEventListener('mouseenter', () => setHi(i));
        ul.appendChild(li);
      });
      ul.hidden = !items.length;
      setHi(items.length ? 0 : -1);
    };
    let timer = null;
    search.addEventListener('input', () => {
      chosen = null;
      ok.disabled = true;
      setPicked(null);
      clearTimeout(timer);
      const q = search.value.trim();
      if (q.length < 2) {
        items = [];
        showList();
        return;
      }
      timer = setTimeout(async () => {
        const found = await db.searchPeopleByPrefix(q, 50);
        items = found.filter((p) => allowed.has(Number(p.id))).slice(0, 8);
        showList();
      }, 150);
    });
    search.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') {
        ev.preventDefault();
        if (!ul.hidden && hi >= 0) choose(items[hi]);
        else if (chosen) ok.click();
      } else if (ev.key === 'ArrowDown' && items.length) {
        ev.preventDefault();
        setHi(Math.min(hi + 1, items.length - 1));
      } else if (ev.key === 'ArrowUp' && items.length) {
        ev.preventDefault();
        setHi(Math.max(hi - 1, 0));
      }
    });
    anchor.append(search, ul);
    body.append(anchor, picked, el('p', 'hint', hint || ''));
    body.style.overflow = 'visible';
    form.style.overflow = 'visible';
    dlg.style.overflow = 'visible';
    foot.append(cancel, ok);
    form.append(head, body, foot);
    dlg.append(form);
    document.body.appendChild(dlg);
    dlg.addEventListener('close', () => {
      clearTimeout(timer);
      const v = dlg.returnValue === 'save' && chosen ? Number(chosen.id) : null;
      dlg.remove();
      resolve(v);
    });
    dlg.showModal();
    search.focus();
  });
}

async function onFamilyClick(e) {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  try {
    const id = Number(btn.dataset.id);
    const person = await db.getPerson(id);
    if (!person) return;
    if (btn.dataset.act === 'advance') {
      if (await addFamilyAdvance(person)) await render();
    } else if (btn.dataset.act === 'pay') {
      if (await receiveFamilyPayment(person)) await render();
    } else if (btn.dataset.act === 'refund') {
      if (await refundFamilyAdvance(person)) await render();
    } else if (btn.dataset.act === 'remove') {
      const ok = await Dialog.confirm(
        'Remove ' + (person.name || '#' + id) + ' from this family? Their bills (paid and unpaid) leave this ledger and they become their own head. Advance already held stays with this head.',
        { danger: true, okLabel: 'Remove', title: 'Remove member' }
      );
      if (!ok) return;
      await db.setPersonHead(id, null);
      toast((person.name || '#' + id) + ' removed from the family.', 'ok');
      await render();
    } else if (btn.dataset.act === 'add') {
      const all = (await db.raw.peopleProj.toArray()).filter((p) => !p.hid);
      const headsWithKids = new Set(all.filter((p) => p.headId != null).map((p) => Number(p.headId)));
      const candidates = all
        .filter((p) => Number(p.id) !== Number(scopePId) && Number(p.headId) !== Number(scopePId) && !headsWithKids.has(Number(p.id)))
        .sort((a, b) => String(a.name).localeCompare(String(b.name)));
      if (!candidates.length) {
        toast('No other patient available to add.', 'err');
        return;
      }
      const chosen = await pickPerson(
        'Add member to ' + (scopePName || '#' + scopePId),
        candidates,
        'Their bills (paid and unpaid) join this family. Patients who head their own family are not listed.',
        'Add member'
      );
      if (chosen == null) return;
      await db.setPersonHead(chosen, scopePId);
      const added = candidates.find((p) => Number(p.id) === chosen);
      toast((added ? added.name : '#' + chosen) + ' added to the family.', 'ok');
      await render();
    }
  } catch (err) {
    console.error('family action failed', err);
    toast(err && err.message ? err.message : String(err), 'err');
  }
}

function syncSeg(sel, attr, val) {
  document.querySelectorAll(sel + ' .seg-btn').forEach((x) => x.classList.toggle('active', x.dataset[attr] === val));
}

function wire() {
  if (st.off) st.off.off();
  const off = bindOff();
  st.off = off;
  document.querySelectorAll('#ledger-mode .seg-btn').forEach((b) => {
    off.on(b, 'click', async () => {
      mode = b.dataset.mode;
      syncSeg('#ledger-mode', 'mode', mode);
      pIdx = 0;
      await render();
    });
  });
  document.querySelectorAll('#ledger-book .seg-btn').forEach((b) => {
    off.on(b, 'click', async () => {
      show = b.dataset.book;
      syncSeg('#ledger-book', 'book', show);
      await render();
    });
  });
  off.on(document.getElementById('ledger-family'), 'click', onFamilyClick);
  off.on(document.getElementById('ledger-scope'), 'click', onFamilyClick);
  off.on(document.getElementById('ledger-gl'), 'click', onRowClick);
  off.on(document.getElementById('ledger-scope-clear'), 'click', async () => {
    setGlobalScope();
    await render();
  });
  const summaryBtn = document.getElementById('ledger-summary-btn');
  if (summaryBtn) {
    summaryBtn.textContent = _topHidden ? 'Show all-time' : 'Hide all-time';
    off.on(summaryBtn, 'click', async () => {
      _topHidden = !_topHidden;
      summaryBtn.textContent = _topHidden ? 'Show all-time' : 'Hide all-time';
      await render();
    });
  }
  off.on(document.getElementById('ledger-page-hint'), 'change', async (ev) => {
    const v = String(ev.target.value || '');
    if (!v) {
      await render();
      return;
    }
    // _keys is newest-first; jump to the latest period at or before the pick.
    let i = _keys.findIndex((k) => k <= v);
    if (i < 0) i = _keys.length - 1;
    pIdx = Math.max(0, i);
    await render();
  });
  off.on(document.getElementById('ledger-prev-btn'), 'click', async () => {
    pIdx += 1;
    await render();
  });
  off.on(document.getElementById('ledger-next-btn'), 'click', async () => {
    pIdx = Math.max(0, pIdx - 1);
    await render();
  });
}

export async function mount() {
  st = { off: null };
  if (scope !== 'person') mode = 'day';
  document.getElementById('ledger-prev-btn').textContent = '← Earlier';
  document.getElementById('ledger-next-btn').textContent = 'Later →';
  syncSeg('#ledger-mode', 'mode', mode);
  syncSeg('#ledger-book', 'book', show);
  wire();
  await render();
  const btn = document.querySelector('#ledger-book .seg-btn.active');
  if (btn) btn.focus();
}

export function unmount() {
  if (st && st.off) st.off.off();
}
