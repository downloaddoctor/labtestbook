// Bills tab: day-paged bill list with reprint/edit/delete.
//
// v1: bills carry short keys (id, labId, docId, pId, hid, crtAt, disc_amt).
// Customer name comes from peopleProj (joined by pId) for display. Items in
// the bill-view dialog are hydrated from testRevs.
//
// Navigation: a single day cursor (Earlier / Today / Later). No search, no
// date-range filters — the toolbar steps one day at a time.

import db from '../../core/db.js';
import { PAYMENT } from '../../core/enums.js';
import { renderBillHtml } from '../../print/billHtml.js';
import { printHtml } from '../../print/printHtml.js';
import Dialog from '../dialog.js';
import { toast } from '../toast.js';
import { money } from '../../core/money.js';
import { isAdmin, currentUserSync } from '../../core/auth.js';
import { epochToParts, dayBounds, dayBoundsFromStr, ymdFixed } from '../../core/time.js';
import { el, bindOff } from '../dom.js';
import { paymentLabel } from '../payment.js';
import { initAll, destroyAll, registerAction, unregisterAction } from './listNav.js';
import { openModal } from '../modals/index.js';

const PAGE_SIZE = 50;

let offset = 0;
let off = null;
let nav = null;

let dayCursor = Date.now();

function currentWindow() {
  return dayBounds(dayCursor);
}

const rowEls = () => (nav ? nav.rowEls() : []);
function selectRow(i) {
  if (nav) nav.setActiveRow(i);
}

async function render() {
  const table = el('bills-table');
  let busyTimer = null;
  if (table) {
    table.setAttribute('aria-busy', 'true');
    busyTimer = setTimeout(() => table.classList.add('is-loading'), 150);
  }
  if (offset < 0) offset = 0;
  const win = currentWindow();
  const wfilter = { from: win.from, to: win.to };
  let { results, total } = await db.getBillsPage({ offset, limit: PAGE_SIZE, filter: wfilter });
  if (!results.length && total > 0) {
    offset = Math.max(0, (Math.ceil(total / PAGE_SIZE) - 1) * PAGE_SIZE);
    ({ results, total } = await db.getBillsPage({ offset, limit: PAGE_SIZE, filter: wfilter }));
  }
  // Join people for display names on the current page.
  const personIds = new Set();
  for (const b of results) if (b.pId != null) personIds.add(b.pId);
  const personMap = new Map();
  for (const pid of personIds) {
    const p = await db.getPerson(pid);
    if (p) personMap.set(pid, p);
  }

  const tbody = document.querySelector('#bills-table tbody');
  tbody.replaceChildren();

  const empty = el('bills-empty');
  if (!results.length) {
    if (empty) {
      empty.hidden = false;
      empty.textContent = 'No bills on this day.';
    }
  } else if (empty) {
    empty.hidden = true;
  }

  for (const [i, bill] of results.entries()) {
    const tr = document.createElement('tr');
    tr.className = 'row-click bills-row';
    tr.dataset.id = String(bill.id);
    tr.dataset.index = String(i);
    tr.dataset.no = String(bill.id != null ? bill.id : '');
    tr.setAttribute('role', 'button');
    const person = bill.pId != null ? personMap.get(bill.pId) : null;
    const pname = person ? person.name : '';
    tr.setAttribute(
      'aria-label',
      `Bill ${bill.id}, ${pname}, total ${money(bill.cust_total)} — open`
    );
    const sel = nav ? nav.getActive() : -1;
    tr.tabIndex = i === sel ? 0 : -1;
    if (i === sel) tr.classList.add('active');

    // Date/Time come from crtAt (the real write instant), not the print datetime.
    const { date: bDate, time12: bTime } = epochToParts(bill.crtAt);
    const pay = Number(bill.payment);
    const cells = [bill.id, bDate, bTime, pname, money(bill.cust_total)];
    for (const c of cells) {
      const td = document.createElement('td');
      td.textContent = c == null ? '' : String(c);
      tr.appendChild(td);
    }
    const payTd = document.createElement('td');
    const pill = document.createElement('span');
    pill.className = 'hx-badge' + (pay === PAYMENT.UNPAID ? ' badge-unpaid' : '');
    pill.textContent = paymentLabel(pay);
    if (pay === PAYMENT.UNPAID) {
      const due = await db.billOutstanding(bill.id);
      const payable = Number(bill.cust_payable != null ? bill.cust_payable : bill.cust_total) || 0;
      if (due > 0 && due < payable) {
        pill.className = 'hx-badge badge-partial';
        pill.textContent = 'Partial · due ₹' + money(due);
      } else if (due > 0) {
        pill.className = 'hx-badge badge-unpaid';
        pill.textContent = 'Unpaid ₹' + money(due);
      } else {
        pill.className = 'hx-badge badge-settled';
        pill.textContent = 'Settled';
      }
    }
    payTd.appendChild(pill);
    tr.appendChild(payTd);
    tbody.appendChild(tr);
  }

  const page = Math.floor(offset / PAGE_SIZE) + 1;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const countEl = el('bills-page-info');
  if (countEl) countEl.textContent = total ? `${total} bill${total === 1 ? '' : 's'}` : '';
  const pageEl = el('bills-page-hint');
  if (pageEl) pageEl.textContent = total ? `Page ${page} / ${totalPages}` : '';
  const dayEl = el('bills-day-label');
  if (dayEl) dayEl.value = ymdFixed(dayCursor);



  if (table) {
    if (busyTimer) clearTimeout(busyTimer);
    table.setAttribute('aria-busy', 'false');
    table.classList.remove('is-loading');
  }
}

let _openBill = null;   // hydrated bill (items have name/sell/buy, refs joined)

async function openRow(id) {
  const raw = await db.getBill(id);
  if (!raw) return;
  const hydrated = await db.hydrateBill(raw);
  const withRefs = await db.hydrateBillRefs(hydrated);
  withRefs.companyName = await db.getCompanyName();
  _openBill = withRefs;
  await openModal('billView', {
    bill: withRefs,
    onAction: (kind, bill) => billAction(kind, bill),
  });
}

async function billAction(kind, bill) {
  if (kind === 'history') {
    const { openBillRevisions } = await import('../revisions.js');
    await openBillRevisions(bill.id);
    return;
  }
  if (kind === 'print') {
    await printHtml(renderBillHtml(bill));
    return;
  }
  if (kind === 'payment') {
    await billPayment(bill);
    return;
  }
  if (kind === 'edit') {
    const billPage = await import('./bill.js');
    await billPage.openBillForEdit(bill);
    return;
  }
  if (kind === 'delete') {
    await confirmDelete(bill.id, bill.id);
    await refreshReqBtn();
  }
}

async function billPayment(bill) {
  // Unpaid bill (full or part): one amount + method dialog.
  if (Number(bill.payment) === PAYMENT.UNPAID) {
    const due = await db.billOutstanding(bill.id);
    if (!(due > 0)) {
      toast('Bill ' + bill.id + ' is fully paid.', 'ok');
      return;
    }
    const person = await db.getPerson(bill.pId);
    if (!person) return;
    const { receiveBillPayment } = await import('../familyPay.js');
    if (await receiveBillPayment(bill, person)) {
      await render();
      await openRow(bill.id);
    }
    return;
  }
  const { openPaymentFor, paymentLabel } = await import('../payment.js');
  let choice;
  try {
    choice = await openPaymentFor(bill);
  } catch (e) {
    toast(e && e.name === 'PartPaidError'
      ? 'This bill already has part payments. Use "Receive payment" on the Patients page for the rest.'
      : (e && e.message ? e.message : String(e)), 'err');
    return;
  }
  if (choice != null) {
    await render();
    await openRow(bill.id);
    toast(`Bill ${bill.id} — ${paymentLabel(choice)}.`, 'ok');
  }
}

async function requestDelete(id, no) {
  const reason = await Dialog.prompt(`Ask an admin to delete bill "${no}". Reason (optional):`, {
    title: 'Request delete',
    okLabel: 'Send request',
  });
  if (reason === null) return;
  const r = await db.requestBillDelete(id, reason);
  if (!r) toast('Bill ' + no + ' not found.', 'err');
  else if (r.duplicate) toast('Bill ' + no + ' already has a pending delete request.', 'ok');
  else toast('Delete request sent for bill ' + no + '.', 'ok');
}

async function refreshReqBtn() {
  const btn = el('bills-requests');
  if (!btn) return;
  const admin = isAdmin(currentUserSync());
  btn.hidden = !admin;
  if (!admin) return;
  const n = await db.pendingDeleteCount();
  btn.textContent = n ? `Delete requests (${n})` : 'Delete requests';
}

async function confirmDelete(id, no) {
  if (!isAdmin(currentUserSync())) return requestDelete(id, no);
  const ok = await Dialog.confirm(`Delete bill "${no}"? This cannot be undone.`, {
    danger: true,
    okLabel: 'Delete',
    title: 'Delete bill',
  });
  if (!ok) return;
  await db.deleteBill(id);
  await render();
  if (rowEls().length) selectRow(!nav || nav.getActive() < 0 ? 0 : nav.getActive());
  else el('bills-today').focus();
}

function wire() {
  if (el('bills-requests')) off.on(el('bills-requests'), 'click', async () => {
    await openModal('deleteRequests', {
      onResolved: async () => {
        await refreshReqBtn();
        await render();
      },
    });
  });

  off.on(el('bills-prev-day'), 'click', async () => {
    dayCursor -= 86400000;
    offset = 0;
    if (nav) nav.clearActiveRow();
    await render();
    if (nav) nav.gotoFirstRow();
  });
  off.on(el('bills-next-day'), 'click', async () => {
    dayCursor += 86400000;
    offset = 0;
    if (nav) nav.clearActiveRow();
    await render();
    if (nav) nav.gotoFirstRow();
  });
  off.on(el('bills-day-label'), 'change', async (ev) => {
    const v = String(ev.target.value || '');
    if (!v) {
      await render();
      return;
    }
    dayCursor = dayBoundsFromStr(v).from;
    offset = 0;
    if (nav) nav.clearActiveRow();
    await render();
    if (nav) nav.gotoFirstRow();
  });
  off.on(el('bills-today'), 'click', async () => {
    dayCursor = Date.now();
    offset = 0;
    if (nav) nav.clearActiveRow();
    await render();
    if (nav) nav.gotoFirstRow();
  });

  const tbody = document.querySelector('#bills-table tbody');
  off.on(tbody, 'click', (e) => {
    if (e.target.closest('button')) return;
    const tr = e.target.closest('tr.bills-row');
    if (!tr) return;
    selectRow(Number(tr.dataset.index));
    openRow(Number(tr.dataset.id));
  });
}

export async function mount() {
  off = bindOff();
  dayCursor = Date.now();
  wire();
  await refreshReqBtn();
  registerAction('bills-enter', (row) => openRow(Number(row.dataset.id)));
  registerAction('bills-delete', (row) => confirmDelete(Number(row.dataset.id), row.dataset.no));
  registerAction('bills-history', (row) =>
    import('../revisions.js').then(({ openRevisions }) =>
      openRevisions('bill', Number(row.dataset.id), { title: 'Bill revisions' })
    )
  );
  el('bills-today').focus();
  await render();
  nav = initAll(document.getElementById('page-bills'))[0] || null;
}

export function unmount() {
  if (off) off.off();
  off = null;
  unregisterAction('bills-enter');
  unregisterAction('bills-delete');
  unregisterAction('bills-history');
  destroyAll();
  nav = null;
}
