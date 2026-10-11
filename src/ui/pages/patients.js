// Patients tab: the patient registry — one row per unique person, with a
// drill-in list of their bills. Bills themselves live in the History tab.
//
// v1: person.id (was rootId), bill.id (was bill_no), bill.labId/docId (not
// name strings), bill.pId. Lab/doc names resolved for display.

import db from '../../core/db.js';
import Dialog from '../dialog.js';
import { money } from '../../core/money.js';
import { timeAgo } from '../../core/time.js';
import { bindOff } from '../dom.js';
import { initAll, destroyAll, registerAction, unregisterAction } from './listNav.js';
import { openModal } from '../modals/index.js';

const PAGE = 50;
let st;
let nav = null;

async function render() {
  st.tbody.replaceChildren();
  if (nav) nav.clearActiveRow();

  const q = st.searchEl.value.trim();
  const dueOnly = !!st.onlyDue;
  let rows;
  let total;

  if (q || dueOnly) {
    // Search and "pending only" scan the (bounded) patient set, then paginate
    // the filtered list in memory. Dues come from peopleProj.pending.
    let matched;
    if (dueOnly && !q) {
      matched = (await db.sortPeople({
        by: st.sort.by, dir: st.sort.dir, offset: 0, limit: 5000,
      })).filter((p) => (Number(p.pending) || 0) > 0);
    } else {
      matched = q
        ? await db.searchPeopleByPrefix(q, 200)
        : await db.sortPeople({ by: st.sort.by, dir: st.sort.dir, offset: 0, limit: 5000 });
      if (dueOnly) matched = matched.filter((p) => (Number(p.pending) || 0) > 0);
    }
    total = matched.length;
    const pages = Math.max(1, Math.ceil(total / PAGE));
    if (st.offset >= total) st.offset = Math.max(0, (pages - 1) * PAGE);
    const page = Math.floor(st.offset / PAGE) + 1;
    rows = matched.slice(st.offset, st.offset + PAGE);
    st.infoEl.textContent = `Page ${page} / ${pages} — ${total} patient${total === 1 ? '' : 's'}` +
      (dueOnly ? ' with dues' : '');
    st.prevBtn.disabled = st.offset <= 0;
    st.nextBtn.disabled = st.offset + PAGE >= total;
    st.pager.hidden = false;
  } else {
    total = await db.countPeople();
    rows = await db.sortPeople({
      by: st.sort.by, dir: st.sort.dir, offset: st.offset, limit: PAGE,
    });
    const pages = Math.max(1, Math.ceil(total / PAGE));
    const page = Math.floor(st.offset / PAGE) + 1;
    st.infoEl.textContent = `Page ${page} / ${pages} — ${total} patients`;
    st.prevBtn.disabled = st.offset <= 0;
    st.nextBtn.disabled = st.offset + PAGE >= total;
    st.pager.hidden = false;
  }

  for (const p of rows) {
    const tr = document.createElement('tr');
    tr.className = 'row-click';
    tr.dataset.id = String(p.id);
    tr.setAttribute('role', 'button');
    tr.setAttribute('aria-label', `Patient #${p.id}, ${p.name}, ${p.mob} — open`);
    const lastAt = p.lastBillAt;
    const due = Number(p.pending) || 0;
    if (due > 0) tr.classList.add('row-due');
    const cells = [
      p.id,
      p.name,
      p.mob,
      p.age != null ? p.age : '',
      p.gender || '',
      p.weight != null ? p.weight : '',
      p.billsCount != null ? p.billsCount : 0,
      due > 0 ? money(due) : '',
      lastAt ? timeAgo(lastAt) : '',
    ];
    cells.forEach((c, i) => {
      const td = document.createElement('td');
      td.textContent = String(c);
      if (i === 7 && due > 0) td.classList.add('due');
      if (i === 8 && lastAt) td.title = new Date(lastAt).toLocaleString();
      tr.appendChild(td);
    });
    st.tbody.appendChild(tr);
  }

  st.empty.hidden = rows.length > 0;
  st.countEl.textContent = total + ' patient' + (total === 1 ? '' : 's');
}

let _returnRow = -1;

// The timeline dialog lives in ui/patientView.js (tab-independent). This page
// only parks its row navigation while the dialog is open and restores it after.
async function openPatient(id) {
  await openModal('patientView', {
    id,
    onBeforeShow: () => {
      if (!_mounted) return;
      _returnRow = nav ? nav.getActive() : -1;
      destroyAll();
      nav = null;
    },
    onClose: () => {
      if (!_mounted || !st) return;
      nav = initAll(document.getElementById('page-patients'))[0] || null;
      const rows = nav ? nav.rowEls() : [];
      if (_returnRow >= 0 && _returnRow < rows.length) {
        nav.setActiveRow(_returnRow);
        nav.focusRow();
      } else if (st.searchEl) {
        st.searchEl.focus();
      }
      _returnRow = -1;
    },
  });
}

// Family head picker + advance/family-due hint for the open patient.
async function fillFamilyControls(person) {
  const sel = document.getElementById('patient-view-head');
  const payBtn = document.getElementById('patient-view-pay-btn');
  if (!sel) return;
  const heads = (await db._db.peopleProj.toArray())
    .filter((p) => !p.hid && p.headId == null && p.id !== person.id)
    .sort((a, b) => String(a.name).localeCompare(String(b.name)))
    .slice(0, 500);
  sel.replaceChildren();
  const own = document.createElement('option');
  own.value = '';
  own.textContent = '(own head)';
  sel.appendChild(own);
  for (const h of heads) {
    const o = document.createElement('option');
    o.value = String(h.id);
    o.textContent = h.name + ' · ' + (h.mob || '#' + h.id);
    sel.appendChild(o);
  }
  sel.value = person.headId != null ? String(person.headId) : '';
  if (payBtn) {
    const headId = person.headId != null ? person.headId : person.id;
    const adv = await db.advanceBalance(headId);
    payBtn.textContent = adv > 0 ? 'Receive payment (advance ₹' + money(adv) + ')' : 'Receive payment';
  }
}

async function receiveFamilyPayment(person) {
  const { receiveFamilyPayment: pay } = await import('../familyPay.js');
  if (!(await pay(person))) return;
  await render();
  await openPatient(person.id);
}

async function refundFamilyAdvance(person) {
  const dlg = document.getElementById('family-refund-dialog');
  if (!dlg) return;
  const headId = person.headId != null ? person.headId : person.id;
  const head = await db.getPerson(headId);
  const adv = await db.advanceBalance(headId);
  document.getElementById('family-refund-sub').textContent =
    (head ? head.name : '#' + headId) + ' · advance held ₹' + money(adv);
  const amt = document.getElementById('family-refund-amount');
  amt.value = adv > 0 ? String(adv) : '';
  amt.max = adv > 0 ? String(adv) : '';
  document.getElementById('family-refund-note').value = '';
  document.getElementById('family-refund-info').textContent = adv > 0
    ? 'Money handed back to the customer. Cannot be more than the advance held.'
    : 'No advance is held, nothing to refund.';
  document.getElementById('family-refund-save').disabled = !(adv > 0);
  dlg.returnValue = '';
  await new Promise((resolve) => {
    const onClose = () => {
      dlg.removeEventListener('close', onClose);
      resolve();
    };
    dlg.addEventListener('close', onClose);
    dlg.showModal();
    amt.focus();
  });
  if (dlg.returnValue !== 'save') return;
  const value = Number(amt.value);
  if (!(value > 0)) return;
  try {
    await db.refundAdvance({
      headId,
      amount: value,
      method: Number(document.getElementById('family-refund-method').value),
      note: document.getElementById('family-refund-note').value.trim() || null,
    });
  } catch (err) {
    await Dialog.alert(err && err.message ? err.message : 'Refund failed.');
    return;
  }
  await render();
  await openPatient(person.id);
}

let _mounted = false;

export async function mount() {
  _mounted = true;
  st = {
    searchEl: document.getElementById('patients-search'),
    countEl: document.getElementById('patients-count'),
    tbody: document.querySelector('#patients-table tbody'),
    empty: document.getElementById('patients-empty'),
    pager: document.getElementById('patients-pager'),
    prevBtn: document.getElementById('pg-prev'),
    nextBtn: document.getElementById('pg-next'),
    infoEl: document.getElementById('pg-info'),
    offset: 0,
  };

  const off = bindOff();
  st.onlyDue = false;
  st.sort = st.sort || { by: 'lastBillAt', dir: 'desc' };

  // Clickable column headers: toggle asc/desc on the same column, or switch
  // column (defaults to desc). Both sorted fields are indexed projections.
  const sortThs = Array.from(document.querySelectorAll('#patients-table thead th.sortable'));
  const syncSortHeaders = () => {
    for (const th of sortThs) {
      const on = th.dataset.sort === st.sort.by;
      th.classList.toggle('sorted', on);
      th.classList.toggle('sorted-desc', on && st.sort.dir === 'desc');
      th.setAttribute('aria-sort', on ? (st.sort.dir === 'desc' ? 'descending' : 'ascending') : 'none');
    }
  };
  for (const th of sortThs) {
    off.on(th, 'click', () => {
      const key = th.dataset.sort;
      if (st.sort.by === key) st.sort.dir = st.sort.dir === 'desc' ? 'asc' : 'desc';
      else { st.sort.by = key; st.sort.dir = 'desc'; }
      st.offset = 0;
      syncSortHeaders();
      render();
    });
  }
  syncSortHeaders();

  const dueToggle = document.getElementById('patients-due-toggle');
  if (dueToggle) {
    dueToggle.classList.toggle('active', false);
    dueToggle.setAttribute('aria-pressed', 'false');
    off.on(dueToggle, 'click', () => {
      st.onlyDue = !st.onlyDue;
      dueToggle.classList.toggle('active', st.onlyDue);
      dueToggle.setAttribute('aria-pressed', st.onlyDue ? 'true' : 'false');
      st.offset = 0;
      render();
    });
  }

  let searchTimer = null;
  off.on(st.searchEl, 'input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      st.offset = 0;
      render();
    }, 150);
  });

  off.on(st.prevBtn, 'click', async () => {
    st.offset = Math.max(0, st.offset - PAGE);
    await render();
    if (nav) nav.gotoFirstRow();
  });
  off.on(st.nextBtn, 'click', async () => {
    st.offset += PAGE;
    await render();
    if (nav) nav.gotoFirstRow();
  });

  off.on(st.tbody, 'click', (e) => {
    const tr = e.target.closest('tr[data-id]');
    if (!tr) return;
    if (nav) nav.setActiveRow(nav.rowEls().indexOf(tr));
    openPatient(Number(tr.dataset.id));
  });

  st.off = off;
  registerAction('patients-enter', (row) => openPatient(Number(row.dataset.id)));
  registerAction('patients-history', (row) =>
    import('../revisions.js').then(({ openRevisions }) =>
      openRevisions('person', Number(row.dataset.id), { title: 'Patient revisions' })
    )
  );
  await render();
  nav = initAll(document.getElementById('page-patients'))[0] || null;
  if (st.searchEl) st.searchEl.focus();
}

export function unmount() {
  _mounted = false;
  if (st && st.off) st.off.off();
  unregisterAction('patients-enter');
  unregisterAction('patients-history');
  destroyAll();
  nav = null;
}

// Alt+L helper. Tries, in order:
//   1) the open patient-view modal — its current patient
//   2) the focused row on the Patients table
// Returns true if a ledger was opened, false if there was no target.
export async function openActivePatientLedger() {
  const pv = document.getElementById('patient-view-dialog');
  if (pv && pv.open && pv.dataset.patientId) {
    const id = Number(pv.dataset.patientId);
    pv.close();
    const { openForPerson } = await import('./ledger.js');
    await openForPerson(id);
    return true;
  }
  if (nav) {
    const rows = nav.rowEls();
    const a = nav.getActive();
    if (a >= 0 && a < rows.length) {
      const id = Number(rows[a].dataset.id);
      if (id) {
        const { openForPerson } = await import('./ledger.js');
        await openForPerson(id);
        return true;
      }
    }
  }
  return false;
}
