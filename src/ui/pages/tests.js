// Tests tab: lab-test catalog CRUD with a native-dialog editor.
// Row highlight follows TokenBook's pattern: `.row-click` for hover, `.active`
// for the keyboard-highlighted row. Focus stays on the search box; arrow keys
// move the highlight (no roving tabindex).

import db from '../../core/db.js';
import Dialog from '../dialog.js';
import { toast } from '../toast.js';
import { money } from '../../core/money.js';
import { el, bindOff } from '../dom.js';
import { openModal as openModalUI } from '../modals/index.js';
import { initAll, destroyAll, registerAction, unregisterAction } from './listNav.js';

let off = null;
let nav = null;

const setActiveRow = (i) => nav && nav.setActiveRow(i);
const clearActiveRow = () => nav && nav.clearActiveRow();

async function render() {
  const tbody = document.querySelector('#test-table tbody');
  if (!tbody) return;
  tbody.replaceChildren();
  const q = (el('test-search')?.value || '').toLowerCase();
  const all = await db.listTests();
  const visible = all.filter((t) => !q || t.name.toLowerCase().includes(q));

  const emptyEl = el('tests-empty');
  const countEl = el('tests-count');
  if (countEl) countEl.textContent = all.length ? `${all.length} test${all.length === 1 ? '' : 's'}` : '';

  if (!visible.length) {
    if (emptyEl) {
      emptyEl.hidden = false;
      emptyEl.textContent = all.length
        ? 'No tests match your search.'
        : 'No tests yet — click "+ Add Test" to create one.';
    }
    if (nav) nav.clearActiveRow();
    return;
  }
  if (emptyEl) emptyEl.hidden = true;

  visible.forEach((test, i) => {
    const tr = document.createElement('tr');
    tr.className = 'row-click test-row';
    tr.dataset.id = String(test.id);
    tr.dataset.index = String(i);
    tr.setAttribute('role', 'button');
    tr.setAttribute('aria-label', `Test ${test.name}, price ${money(test.sell)}`);
    if (nav && i === nav.getActive()) tr.classList.add('active');
    const tdName = document.createElement('td');
    tdName.textContent = test.name;
    const tdC = document.createElement('td');
    tdC.textContent = money(test.sell);
    const tdM = document.createElement('td');
    tdM.textContent = money(test.buy);
    const tdV = document.createElement('td');
    tdV.className = 'col-ver';
    tdV.textContent = 'v' + (test.v || 1);
    tr.append(tdName, tdC, tdM, tdV);
    tbody.appendChild(tr);
  });
}

async function confirmDelete(id, name) {
  const ok = await Dialog.confirm(`Delete test "${name}"? This cannot be undone.`, {
    danger: true,
    okLabel: 'Delete',
    title: 'Delete test',
  });
  if (!ok) return;
  await db.deleteTest(id);
  await render();
}

async function openModal(id) {
  await openModalUI('testEdit', { id });
  await render();
  const search = el('test-search');
  if (search) search.focus();
}

function closeModal() {
  const dlg = el('test-modal');
  if (dlg && dlg.open) dlg.close();
  el('test-search').focus();
}

function wireList() {
  off.on(el('test-search'), 'input', () => {
    if (nav) nav.clearActiveRow();
    render();
  });

  off.on(el('test-add-btn'), 'click', () => openModal());

  const tbody = document.querySelector('#test-table tbody');
  off.on(tbody, 'click', (e) => {
    if (e.target.closest('button')) return;
    const tr = e.target.closest('tr.test-row');
    if (!tr) return;
    setActiveRow(Number(tr.dataset.index));
    openModal(Number(tr.dataset.id));
  });
}

export async function mount() {
  off = bindOff();
  wireList();
  registerAction('test-enter', (row) => openModal(Number(row.dataset.id)));
  registerAction('test-delete', (row) => confirmDelete(Number(row.dataset.id), row.cells[0] ? row.cells[0].textContent : ''));
  registerAction('test-history', (row) =>
    import('../revisions.js').then(({ openRevisions }) => openRevisions('test', Number(row.dataset.id)))
  );
  await render();
  nav = initAll(document.getElementById('page-tests'))[0] || null;
  if (nav) nav.clearActiveRow();
  const search = el('test-search');
  if (search) search.focus();
}

export function unmount() {
  if (off) off.off();
  off = null;
  unregisterAction('test-enter');
  unregisterAction('test-delete');
  unregisterAction('test-history');
  destroyAll();
  nav = null;
}

// ---- DEV/TEST hooks (never imported by prod) ----

export function __getForm() {
  return {
    fields: {
      id: el('modal-test-id'),
      name: el('modal-test-name'),
      customerPrice: el('modal-test-customer-price'),
      merchantPrice: el('modal-test-merchant-price'),
      search: el('test-search'),
    },
    modal: el('test-modal'),
    deleteBtn: el('modal-test-delete-btn'),
    addBtn: el('test-add-btn'),
  };
}

// Open the modal via the real path (Add mode when id is null).
// openModal()'s promise resolves when the dialog CLOSES, not when it opens,
// so we intentionally do NOT await it — otherwise the caller would block
// for the entire modal lifetime.
export async function __openModalForTest(id = null) {
  // eslint-disable-next-line no-floating-promises
  openModal(id);
  await new Promise((r) => setTimeout(r, 30));
}

// Submit the modal via the real Save button. The modal is now generated at
// runtime by src/ui/modals/testEdit.js — there is no <form> element with the
// legacy id, so click the footer's primary button instead.
export async function __submitTestModalForTest() {
  const btn = el('modal-test-save-btn');
  if (btn) btn.click();
  await new Promise((r) => setTimeout(r, 220));
}

