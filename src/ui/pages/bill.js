// Bill tab: build/edit a bill, save it, print it.
// Split layout form left, live preview right. Autofill suggestions
// on customer name/mob. Update history lives in a <dialog>.
//
// v1: items are pins {itemId,itemV,hid}; prices are hydrated from testRevs
// for display and totals. Re-adding an item that was on the bill prompts the
// operator to keep the old itemV or use the latest.

import db from '../../core/db.js';
import { renderBillHtml } from '../../print/billHtml.js';
import { printHtml } from '../../print/printHtml.js';
import { toast } from '../toast.js';
import Dialog from '../dialog.js';
import { money } from '../../core/money.js';
import { computeBillTotals, maxDiscount } from '../../core/billing.js';
import { isAdmin, currentUserSync } from '../../core/auth.js';
import { nowLocalInput, timeAgo } from '../../core/time.js';
import { normPayment } from '../../core/norm.js';
import { el, bindOff } from '../dom.js';
import { debounce } from '../../core/util.js';

// currentTests items: { itemId, itemV, hid, name, sell, buy }
let currentTests = [];
let editingId = null;
let _company = '';
let _companyAddress = '';
let _loadedOriginal = null;      // hydrated bill when editing
let _loadedPins = [];            // original pins [{itemId,itemV,hid}]
let _formInitialized = false;
let selectedIndex = -1;
let refreshToken = 0;
let off = null;
const runNameSearch = debounce(runNameSearchImpl, 120);
let lastFocused = null;

function billRows() {
  return Array.from(document.querySelectorAll('#bill-tests-body tr.bill-test-row'));
}

function selectBillRow(i, focus = true) {
  const rows = billRows();
  if (!rows.length) return;
  const next = Math.min(Math.max(i, 0), rows.length - 1);
  selectedIndex = next;
  rows.forEach((tr, idx) => {
    const on = idx === next;
    tr.classList.toggle('row-selected', on);
    tr.tabIndex = on ? 0 : -1;
  });
  if (focus) rows[next].focus();
}

// Drop any row highlight/selection (e.g. ArrowUp back into the test input).
function clearBillRowSelection() {
  selectedIndex = -1;
  for (const tr of billRows()) {
    tr.classList.remove('row-selected');
    tr.tabIndex = -1;
  }
}

// ---- item pinning ----

async function latestTestV(itemId) {
  const last = await db.raw.testRevs
    .where('[id+v]')
    .between([Number(itemId), -Infinity], [Number(itemId), Infinity])
    .last();
  return last ? last.v : null;
}

async function hydratePin(pin) {
  const rev = await db.raw.testRevs.get([Number(pin.itemId), Number(pin.itemV)]);
  return {
    itemId: Number(pin.itemId),
    itemV: Number(pin.itemV),
    hid: pin.hid ? 1 : 0,
    name: rev ? rev.name : '(deleted)',
    sell: rev ? Number(rev.sell) || 0 : 0,
    buy: rev ? Number(rev.buy) || 0 : 0,
  };
}

// Add a test (catalog row) to the bill. Pins the latest itemV, unless the item
// was on the bill's original pins — then ask the operator to choose.
async function addTestToBill(test) {
  if (currentTests.some((t) => t.itemId === test.id && !t.hid)) {
    toast(`"${test.name}" is already on this bill.`, 'warn');
    return;
  }
  const latestV = await latestTestV(test.id);
  if (latestV == null) {
    toast('Test has no revision. Save it first.', 'warn');
    return;
  }
  let itemV = latestV;
  const prior = _loadedPins.find((p) => Number(p.itemId) === Number(test.id));
  if (prior && Number(prior.itemV) !== latestV) {
    const priorRev = await db.raw.testRevs.get([Number(test.id), Number(prior.itemV)]);
    const oldPrice = priorRev ? money(priorRev.sell) : '?';
    const newPrice = money(test.sell);
    const keepOld = await Dialog.confirm(
      `"${test.name}" was on this bill at v${prior.itemV} (${oldPrice}). ` +
      `Latest is v${latestV} (${newPrice}).\n\nKeep the old price?`,
      { okLabel: 'Keep old', title: 'Item price' }
    );
    itemV = keepOld ? Number(prior.itemV) : latestV;
  }
  const hydrated = await hydratePin({ itemId: test.id, itemV, hid: 0 });
  currentTests.push(hydrated);
  const input = el('bill-test-input');
  if (input) input.value = '';
  const ul = el('bill-test-suggest');
  if (ul) ul.hidden = true;
  selectedIndex = currentTests.length - 1;
  renderBillTests();
  reseedDiscountFromPercent();
  selectBillRow(selectedIndex);
  if (input) input.focus();
}

// ---- test typeahead ----
async function renderTestSuggest(q) {
  const ul = el('bill-test-suggest');
  if (!ul) return;
  const token = ++refreshToken;
  const query = String(q || '').trim();
  if (query.length < 1) {
    ul.hidden = true;
    return;
  }
  const tests = await db.listTests();
  if (token !== refreshToken) return;
  const chosen = new Set(currentTests.filter((t) => !t.hid).map((t) => t.name));
  const ql = query.toLowerCase();
  const matches = tests
    .filter((t) => !chosen.has(t.name) && (t.name.toLowerCase().includes(ql) || String(t.code || '').toLowerCase().includes(ql)))
    .slice(0, 8);
  renderTestSuggestList(ul, matches);
}

// Generic suggestion list: owns the <li> boilerplate (role/aria/highlight/
// mousedown/mouseenter) and pre-highlights the first row so Enter picks it.
// Callers supply only pick() and a buildRow(item) -> DOM node.
function renderSuggestList(ul, items, pick, buildRow) {
  ul.replaceChildren();
  _suggestState.set(ul, { items, pick, hi: items.length ? 0 : -1 });
  if (!items.length) {
    ul.hidden = true;
    return;
  }
  items.forEach((item, i) => {
    const li = document.createElement('li');
    li.setAttribute('role', 'option');
    li.id = ul.id + '-opt-' + i;
    li.setAttribute('aria-selected', i === 0 ? 'true' : 'false');
    if (i === 0) li.classList.add('hl');
    li.append(buildRow(item)); // node or DocumentFragment
    li.addEventListener('mousedown', (e) => {
      e.preventDefault();
      pick(item);
    });
    li.addEventListener('mouseenter', () => _setSuggestHi(ul, i));
    ul.appendChild(li);
  });
  ul.hidden = false;
}

function testSuggestRow(t) {
  const main = document.createElement('div');
  main.className = 's-main';
  const name = document.createElement('span');
  name.className = 's-name';
  name.textContent = t.name;
  const price = document.createElement('span');
  price.className = 's-ago';
  price.textContent = money(t.sell);
  main.append(name, price);
  const hint = [t.code, t.sample, t.tat].filter(Boolean).join(' · ');
  if (!hint) return main;
  const sub = document.createElement('div');
  sub.className = 's-sub';
  sub.textContent = hint;
  const frag = document.createDocumentFragment();
  frag.append(main, sub);
  return frag;
}

function renderTestSuggestList(ul, tests) {
  renderSuggestList(ul, tests, addTestToBill, testSuggestRow);
}

async function onTestInputKey(e) {
  const ul = el('bill-test-suggest');
  const open = ul && !ul.hidden;
  if (open && (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Escape')) {
    _onSuggestKey(e);
    return;
  }
  const input = el('bill-test-input');
  if (!open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
    if (currentTests.length) {
      e.preventDefault();
      const empty = input.value.trim() === '';
      let next;
      if (empty) {
        next = e.key === 'ArrowDown' ? 0 : currentTests.length - 1;
        selectBillRow(next, true);
      } else {
        next = e.key === 'ArrowDown' ? selectedIndex + 1 : selectedIndex - 1;
        selectBillRow(next, true);
      }
    }
    return;
  }
  if (e.key !== 'Enter') return;
  e.preventDefault();
  const st = ul ? _suggestState.get(ul) : null;
  if (st && st.items.length) {
    const pick = st.hi >= 0 ? st.items[st.hi] : st.items[0];
    await addTestToBill(pick);
    return;
  }
  const q = input.value.trim();
  if (!q) {
    // Empty input + Enter: do nothing. Removing an item is Delete/Backspace on
    // a focused row (or clicking the row), never a stray Enter.
    return;
  }
  const tests = await db.listTests();
  const chosen = new Set(currentTests.filter((t) => !t.hid).map((t) => t.name));
  const ql = q.toLowerCase();
  const hit = tests.find((t) => (t.name.toLowerCase().includes(ql) || String(t.code || '').toLowerCase().includes(ql)) && !chosen.has(t.name));
  if (hit) await addTestToBill(hit);
  else toast('No matching test.', 'warn');
}

// ---- discount ----
// % is a person-level default (written to the person, not the bill); ₹ is the
// frozen per-bill override, seeded from %×subtotal but freely editable.
// Until the operator edits ₹ directly, ₹ tracks %×subtotal as items change.
let _discAmtManual = false;

function applyPercentToAmount() {
  const perEl = el('bill-discount-per');
  const amtEl = el('bill-discount-no');
  if (!perEl || !amtEl) return;
  const per = Number(perEl.value);
  if (!Number.isFinite(per) || perEl.value === '') { renderTotals(); renderPreview(); return; }
  const sub = sumField(activeItems(), 'sell');
  amtEl.value = String(Math.round(sub * (per / 100) * 100) / 100);
  clampDiscountToCtc();
  renderTotals();
  renderPreview();
}

// Re-seed ₹ from the person's % when items change (unless ₹ was hand-edited).
function reseedDiscountFromPercent() {
  if (_discAmtManual) { clampDiscountToCtc(); renderTotals(); renderPreview(); return; }
  applyPercentToAmount();
}

// Operator typed in ₹ directly -> stop auto-tracking the %.
function syncDiscount() {
  _discAmtManual = true;
  clampDiscountToCtc();
  renderTotals();
  renderPreview();
}

// ---- cost-to-cost (CTC) ----
// CTC = the merchant/cost total of the bill. Admins may discount down to that
// floor (zero margin) but never past it, so grand_total can't fall below cost.
function currentCtcMax() {
  return maxDiscount({
    cust_total: sumField(activeItems(), 'sell'),
    merch_total: sumField(activeItems(), 'buy'),
  });
}

// Keep the ₹ discount at or below the CTC cap (admin-only rule). Runs on every
// ₹ edit and after CTC is applied, so the field can never exceed the floor.
function clampDiscountToCtc() {
  if (!isAdmin(currentUserSync())) return;
  const amtEl = el('bill-discount-no');
  if (!amtEl) return;
  const cap = currentCtcMax();
  const cur = Number(amtEl.value);
  if (Number.isFinite(cur) && cur > cap) amtEl.value = String(cap);
}

// CTC button: fill the discount with the maximum (customer pays cost-to-cost).
function applyCtc() {
  const amtEl = el('bill-discount-no');
  if (!amtEl) return;
  const cap = currentCtcMax();
  amtEl.value = String(cap);
  _discAmtManual = true;
  renderTotals();
  renderPreview();
}

// Admins only; called on mount so the button appears for the right role.
function syncCtcVisibility() {
  const btn = el('bill-discount-ctc');
  if (btn) btn.hidden = !isAdmin(currentUserSync());
}

// Operator changed % -> overwrite ₹ and resume auto-tracking.
function syncDiscountPercent() {
  _discAmtManual = false;
  applyPercentToAmount();
}

// ---- live preview + totals ----

function activeItems() {
  return currentTests.filter((it) => !it.hid);
}

function renderPreview() {
  const host = el('bill-ps-host');
  if (!host) return;
  const meta = collectMeta();
  const datetime = (el('bill-datetime') && el('bill-datetime').value) || (editingId ? _originalDatetime() : nowLocalInput());
  const bill = {
    id: meta.id,
    datetime,
    items: activeItems().map((t) => ({
      itemId: t.itemId, itemV: t.itemV, hid: 0, name: t.name, sell: t.sell, buy: t.buy,
    })),
    labName: selText('bill-lab'),
    docName: selText('bill-doc'),
    companyName: _company,
    companyAddress: _companyAddress,
    person: {
      name: el('bill-cust-name') ? el('bill-cust-name').value.trim().toUpperCase() : '',
      mob: el('bill-cust-mob') ? el('bill-cust-mob').value.trim() : '',
      age: el('bill-cust-age') ? el('bill-cust-age').value.trim() : '',
      gender: el('bill-cust-gender') ? el('bill-cust-gender').value : '',
    },
    payment: Number(el('bill-paid') ? el('bill-paid').value : 1),
    cust_total: sumField(activeItems(), 'sell'),
    merch_total: sumField(activeItems(), 'buy'),
    disc_amt: numOrZero(el('bill-discount-no') ? el('bill-discount-no').value : ''),
    grand_total: 0,
  };
  const sub = bill.cust_total;
  const da = Math.min(bill.disc_amt, sub);
  bill.disc_amt = da;
  bill.grand_total = sub - da;
  const html = renderBillHtml(bill);
  host.innerHTML = `<div class="preview-scale">${html}</div>`;
  const PAGE_W_PX = 210 * (96 / 25.4);
  const inner = host.clientWidth - 24;
  const scale = inner > 0 ? Math.min(1, inner / PAGE_W_PX) : 1;
  host.style.setProperty('--preview-scale', String(scale));
}

function sumField(items, key) {
  let s = 0;
  for (const it of items) {
    const v = Number(it[key]);
    if (Number.isFinite(v)) s += v;
  }
  return Math.round(s * 100) / 100;
}
function numOrZero(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function renderTotals() {
  const t = computeBillTotals({
    items: activeItems(),
    disc_amt: el('bill-discount-no') ? el('bill-discount-no').value : null,
  });
  if (el('tot-subtotal')) el('tot-subtotal').textContent = money(t.cust_total);
  if (el('tot-discount')) el('tot-discount').textContent = money(t.disc_amt);
  if (el('tot-grand')) el('tot-grand').textContent = money(t.grand_total);
}

function renderBillTests() {
  const tbody = document.getElementById('bill-tests-body');
  tbody.replaceChildren();
  const shown = currentTests.filter((it) => !it.hid);
  if (selectedIndex >= shown.length) selectedIndex = shown.length - 1;
  shown.forEach((bt, idx) => {
    const tr = document.createElement('tr');
    tr.className = 'nav-row bill-test-row';
    tr.dataset.index = String(idx);
    const on = idx === selectedIndex || (selectedIndex < 0 && idx === 0);
    tr.tabIndex = on ? 0 : -1;
    if (idx === selectedIndex) tr.classList.add('row-selected');
    const nameTd = document.createElement('td');
    nameTd.textContent = bt.name;
    const priceTd = document.createElement('td');
    priceTd.className = 'num';
    priceTd.textContent = money(bt.sell);
    tr.append(nameTd, priceTd);
    tr.title = 'Click to remove';
    tr.addEventListener('click', () => removeTest(Number(tr.dataset.index)));
    tbody.appendChild(tr);
  });
  renderTotals();
  renderPreview();
}

function removeTest(idx) {
  const shown = currentTests.filter((it) => !it.hid);
  const target = shown[idx];
  if (!target) return;
  const realIdx = currentTests.indexOf(target);
  const hadRowFocus = document.activeElement && document.activeElement.classList.contains('bill-test-row');
  currentTests.splice(realIdx, 1);
  if (selectedIndex >= currentTests.filter((it) => !it.hid).length) {
    selectedIndex = currentTests.filter((it) => !it.hid).length - 1;
  }
  renderBillTests();
  reseedDiscountFromPercent();
  if (currentTests.length === 0) {
    const input = el('bill-test-input');
    if (input) input.focus();
  } else if (hadRowFocus) {
    selectBillRow(Math.min(idx, currentTests.filter((it) => !it.hid).length - 1), true);
  } else {
    const input = el('bill-test-input');
    if (input) input.focus();
  }
}

function selText(id) {
  const s = el(id);
  if (!s) return '';
  const o = s.options[s.selectedIndex];
  return o ? o.textContent.trim() : '';
}

function setSelectById(id, want) {
  const s = el(id);
  if (!s || want == null) return;
  const w = String(want);
  for (let i = 0; i < s.options.length; i++) {
    if (s.options[i].value === w) {
      s.selectedIndex = i;
      return;
    }
  }
}

function collectMeta() {
  const pidRaw = el('bill-person-id') ? el('bill-person-id').value.trim() : '';
  const idRaw = el('bill-no').value.trim();
  return {
    id: idRaw ? Number(idRaw) : null,
    labId: el('bill-lab') ? Number(el('bill-lab').value) || 0 : 0,
    docId: el('bill-doc') ? Number(el('bill-doc').value) || 0 : 0,
    pId: pidRaw ? Number(pidRaw) : null,
    name: el('bill-cust-name').value.trim(),
    mob: el('bill-cust-mob').value.trim(),
    age: el('bill-cust-age') ? el('bill-cust-age').value.trim() : '',
    gender: el('bill-cust-gender') ? el('bill-cust-gender').value : '',
    weight: el('bill-cust-weight') ? el('bill-cust-weight').value.trim() : '',
    disc_amt: el('bill-discount-no') ? el('bill-discount-no').value.trim() : '',
    discount_per: el('bill-discount-per') ? el('bill-discount-per').value.trim() : '',
    payment: el('bill-paid') ? Number(el('bill-paid').value) : 1,
    datetime: el('bill-datetime') ? el('bill-datetime').value : '',
  };
}

// Alt+H: open the generic revision timeline for the bill being edited.
function openHistoryDialog() {
  if (editingId == null) {
    const pid = Number(el('bill-person-id') ? el('bill-person-id').value.trim() : '');
    if (!pid) return;
    import('../modals/index.js').then((m) => m.openModal('patientView', { id: pid }));
    return;
  }
  import('../revisions.js').then(({ openRevisions }) =>
    openRevisions('bill', editingId, { title: 'Bill revisions' })
  );
}

// ---- autofill suggest-lists ----
const _suggestState = new WeakMap();

function _setSuggestHi(ul, i) {
  const st = _suggestState.get(ul);
  if (!st) return;
  st.hi = i;
  const lis = ul.children;
  for (let k = 0; k < lis.length; k++) {
    const on = k === i;
    lis[k].classList.toggle('hl', on);
    lis[k].setAttribute('aria-selected', on ? 'true' : 'false');
  }
  if (i >= 0 && lis[i]) lis[i].scrollIntoView({ block: 'nearest' });
}

function _onSuggestKey(e) {
  const input = e.currentTarget;
  // Enter must never implicitly submit the bill form from an autofill field —
  // swallow it even when no suggestion dropdown is open.
  if (e.key === 'Enter') e.preventDefault();
  const ulId = input.getAttribute('aria-controls');
  const ul = ulId && document.getElementById(ulId);
  if (!ul || ul.hidden) return;
  const st = _suggestState.get(ul);
  if (!st || !st.items.length) return;
  const n = st.items.length;
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    _setSuggestHi(ul, st.hi < 0 ? 0 : Math.min(st.hi + 1, n - 1));
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    _setSuggestHi(ul, st.hi <= 0 ? 0 : st.hi - 1);
  } else if (e.key === 'Enter') {
    if (st.hi >= 0) {
      e.preventDefault();
      st.pick(st.items[st.hi]);
    } else {
      // Dropdown open but nothing highlighted — accept the top match instead of
      // letting the browser implicitly submit the bill form.
      e.preventDefault();
      st.pick(st.items[0]);
    }
  } else if (e.key === 'Escape') {
    e.preventDefault();
    hideSuggests();
  }
}

function personSuggestRow(c) {
  const main = document.createElement('div');
  main.className = 's-main';
  const name = document.createElement('span');
  name.className = 's-name';
  name.textContent = c.name || '(no name)';
  const ago = document.createElement('span');
  ago.className = 's-ago';
  ago.textContent = timeAgo(c.lastBillAt) || (c.billsCount ? `${c.billsCount} bill(s)` : '');
  main.append(name, ago);
  const sub = document.createElement('div');
  sub.className = 's-sub';
  const parts = [];
  if (c.id != null) parts.push({ cls: 's-pid', text: '#' + c.id });
  if (c.mob) parts.push({ cls: 's-mob', text: c.mob });
  if (c.age != null && c.age !== '') parts.push({ cls: 's-age', text: c.age + 'y' });
  if (c.gender) parts.push({ cls: 's-gender', text: c.gender });
  if (c.weight != null && c.weight !== '') parts.push({ cls: 's-weight', text: c.weight + 'kg' });
  for (const part of parts) {
    const span = document.createElement('span');
    span.className = part.cls;
    span.textContent = part.text;
    sub.append(span);
  }
  const frag = document.createDocumentFragment();
  frag.append(main, sub);
  return frag;
}

function renderSuggest(ul, items, pick) {
  renderSuggestList(ul, items, pick, personSuggestRow);
}

function hideSuggests() {
  for (const id of ['bill-test-suggest', 'cust-name-suggest']) {
    const u = el(id);
    if (u) u.hidden = true;
  }
  for (const id of ['bill-test-input', 'bill-cust-name']) {
    const i = el(id);
    if (i) i.setAttribute('aria-expanded', 'false');
  }
}

async function populateCatalogSelects(selLab = undefined, selDoc = undefined) {
  const labSel = el('bill-lab');
  const docSel = el('bill-doc');
  if (!labSel || !docSel) return;
  const [labs, docs, defLab, defDoc] = await Promise.all([
    db.listLabs(),
    db.listDoctors(),
    db.getDefaultLabId(),
    db.getDefaultDoctorId(),
  ]);
  const fill = (sel, rows, want) => {
    const prev = want !== undefined ? want : sel.value;
    sel.replaceChildren();
    for (const r of rows) {
      const o = document.createElement('option');
      o.value = String(r.id);
      o.textContent = r.name;
      sel.appendChild(o);
    }
    const pick = prev != null && rows.some((r) => String(r.id) === String(prev))
      ? String(prev)
      : (rows[0] ? String(rows[0].id) : '');
    if (pick) sel.value = pick;
  };
  fill(labSel, labs, selLab !== undefined ? selLab : defLab);
  fill(docSel, docs, selDoc !== undefined ? selDoc : defDoc);
}

// Tell the operator when the patient (or their family head) has advance money.
async function showAdvanceNote(pId) {
  const note = el('bill-advance-note');
  if (!note) return;
  note.hidden = true;
  note.textContent = '';
  if (pId == null || pId === '') return;
  const p = await db.getPerson(Number(pId));
  if (!p) return;
  const headId = p.headId != null ? p.headId : p.id;
  const adv = await db.advanceBalance(headId);
  if (!(adv > 0)) return;
  let who = 'This patient has';
  if (headId !== p.id) {
    const h = await db.getPerson(headId);
    who = 'Family head ' + (h ? h.name : '#' + headId) + ' has';
  }
  note.textContent = who + ' ₹' + money(adv) +
    ' advance paid. Payment is set to Unpaid so the advance pays this bill automatically; nothing to collect.';
  note.hidden = false;
  if (editingId == null && el('bill-paid')) el('bill-paid').value = '0';
}

function pickCustomer(p) {
  showAdvanceNote(p.id);
  el('bill-cust-name').value = p.name || '';
  el('bill-cust-mob').value = p.mob || '';
  if (el('bill-cust-age')) el('bill-cust-age').value = p.age != null ? String(p.age) : '';
  if (el('bill-cust-gender')) el('bill-cust-gender').value = p.gender || '';
  if (el('bill-cust-weight')) el('bill-cust-weight').value = p.weight != null ? String(p.weight) : '';
  if (el('bill-person-id')) el('bill-person-id').value = p.id != null ? String(p.id) : '';
  if (el('bill-discount-per')) {
    el('bill-discount-per').value = p.discount_per != null ? String(p.discount_per) : '';
  }
  // Picking a person re-seeds ₹ from their % and resumes auto-tracking.
  _discAmtManual = false;
  applyPercentToAmount();
  hideSuggests();
  const testInput = el('bill-test-input');
  if (testInput) testInput.focus();
}

async function runNameSearchImpl(q, ul, input) {
  const items = await db.searchPeopleByPrefix(q, 8);
  renderSuggest(ul, items, pickCustomer);
  input.setAttribute('aria-expanded', items.length ? 'true' : 'false');
}

function wireAutofill() {
  const nameInput = el('bill-cust-name');
  const nameUl = el('cust-name-suggest');
  if (!nameInput || !nameUl) return;

  nameInput.setAttribute('role', 'combobox');
  nameInput.setAttribute('aria-autocomplete', 'list');
  nameInput.setAttribute('aria-expanded', 'false');
  nameInput.setAttribute('aria-controls', nameUl.id);
  nameUl.setAttribute('role', 'listbox');
  off.on(nameInput, 'keydown', _onSuggestKey);

  // Name field searches people by name OR mobile (digit prefix), so the mobile
  // field no longer needs its own dropdown.
  off.on(nameInput, 'input', () => {
    const q = nameInput.value.trim();
    if (q.length < 2) {
      runNameSearch.cancel();
      nameUl.hidden = true;
      nameInput.setAttribute('aria-expanded', 'false');
      return;
    }
    runNameSearch(q, nameUl, nameInput);
  });

  off.on(nameInput, 'blur', () => {
    nameUl.hidden = true;
    nameInput.setAttribute('aria-expanded', 'false');
  });

  off.on(document, 'mousedown', (e) => {
    const t = e.target;
    if (nameUl.contains(t) || t === nameInput) return;
    hideSuggests();
  });
}

// ---- form reset / load ----

async function resetForm() {
  _formInitialized = true;
  editingId = null;
  currentTests = [];
  _loadedPins = [];
  selectedIndex = -1;
  el('bill-edit-id').value = '';
  el('bill-no').value = await db.getNextBillNo();
  el('bill-lab').value = '';
  if (el('bill-doc')) el('bill-doc').value = '';
  el('bill-cust-name').value = '';
  el('bill-cust-mob').value = '';
  if (el('bill-cust-age')) el('bill-cust-age').value = '';
  if (el('bill-cust-gender')) el('bill-cust-gender').value = 'M';
  if (el('bill-cust-weight')) el('bill-cust-weight').value = '';
  if (el('bill-person-id')) el('bill-person-id').value = '';
  if (el('bill-discount-per')) el('bill-discount-per').value = '';
  if (el('bill-discount-no')) el('bill-discount-no').value = '';
  _discAmtManual = false;
  if (el('bill-paid')) el('bill-paid').value = '1';
  if (el('bill-datetime')) el('bill-datetime').value = nowLocalInput();
  showAdvanceNote(null);
  _loadedOriginal = null;
  formMsgClear();
  await populateCatalogSelects();
  el('new-bill-btn').style.display = 'none';
  renderBillTests();
  hideSuggests();
  if (el('bill-cust-name')) el('bill-cust-name').focus();
}

// `bill` here must be HYDRATED (items carry name/sell/buy). Callers use
// db.hydrateBill() first.
async function loadForEdit(bill) {
  editingId = bill.id;
  _loadedPins = (bill.items || []).map((t) => ({
    itemId: Number(t.itemId), itemV: Number(t.itemV), hid: t.hid ? 1 : 0,
  }));
  currentTests = (bill.items || []).map((t) => ({
    itemId: Number(t.itemId), itemV: Number(t.itemV), hid: t.hid ? 1 : 0,
    name: t.name, sell: Number(t.sell) || 0, buy: Number(t.buy) || 0,
  }));
  selectedIndex = -1;
  el('bill-edit-id').value = String(bill.id);
  el('bill-no').value = bill.id != null ? String(bill.id) : '';
  await populateCatalogSelects(bill.labId, bill.docId);
  el('bill-cust-name').value = bill.person ? bill.person.name || '' : '';
  el('bill-cust-mob').value = bill.person ? bill.person.mob || '' : '';
  if (el('bill-cust-age'))
    el('bill-cust-age').value = bill.person && bill.person.age != null ? String(bill.person.age) : '';
  if (el('bill-cust-gender'))
    el('bill-cust-gender').value = bill.person ? bill.person.gender || '' : '';
  if (el('bill-cust-weight'))
    el('bill-cust-weight').value = bill.person && bill.person.weight != null ? String(bill.person.weight) : '';
  if (el('bill-person-id'))
    el('bill-person-id').value = bill.pId != null ? String(bill.pId) : '';
  if (el('bill-discount-no'))
    el('bill-discount-no').value = bill.disc_amt != null ? String(bill.disc_amt) : '';
  // On re-edit: % resets to 0 and ₹ keeps the bill's frozen disc_amt; the operator
  // may type a new % (which re-seeds ₹) or edit ₹ directly.
  if (el('bill-discount-per')) el('bill-discount-per').value = '0';
  _discAmtManual = true;
  if (el('bill-paid')) el('bill-paid').value = String(normPayment(bill.payment));
  if (el('bill-datetime')) el('bill-datetime').value = bill.datetime || '';
  _loadedOriginal = bill;
  showAdvanceNote(bill.pId);
  formMsgClear();
  el('new-bill-btn').style.display = 'inline-block';
  renderBillTests();
  el('bill-lab').focus();
}

// ---- save / print ----

function formError(message, fieldId) {
  toast(message, 'err');
  if (fieldId) {
    const f = el(fieldId);
    if (f) f.focus();
  }
}
function formMsgClear() { }

async function doSave() {
  formMsgClear();
  if (!activeItems().length) {
    formError('Add at least one item.', 'bill-test-input');
    return;
  }
  const meta = collectMeta();
  if (!meta.id) {
    formError('Bill No is required.', 'bill-no');
    return;
  }
  const requiredFields = [
    ['bill-cust-name', meta.name, 'Customer Name'],
    ['bill-cust-mob', meta.mob, 'Mobile'],
    ['bill-cust-age', meta.age, 'Age'],
    ['bill-cust-gender', meta.gender, 'Gender'],
  ];
  for (const [id, value, label] of requiredFields) {
    if (value === '' || value == null) {
      formError(`${label} is required.`, id);
      return;
    }
  }
  // Send the full pin list (with hid) so removed items persist.
  const pins = currentTests.map((t) => ({
    itemId: t.itemId, itemV: t.itemV, hid: t.hid ? 1 : 0,
  }));
  let discAmt = meta.disc_amt === '' ? null : Number(meta.disc_amt);
  // Admin CTC guard: the discount may not push grand_total below the bill's
  // cost-to-cost floor. Clamp on save so a typed/stale value can't slip past.
  if (isAdmin(currentUserSync()) && discAmt != null) {
    const cap = currentCtcMax();
    if (discAmt > cap) discAmt = cap;
  }
  // On re-edit the % field starts at 0 (a display default). 0 or empty means
  // "leave the person's discount_per unchanged" — pass null, not 0.
  const perRaw = meta.discount_per;
  const discPer = perRaw === '' || Number(perRaw) === 0 ? null : Number(perRaw);

  if (editingId) {
    // Preserve the loaded/entered datetime; revAt is stamped by _appendBillRev.
    const datetime = (el('bill-datetime') && el('bill-datetime').value) || _originalDatetime() || nowLocalInput();
    try {
      const updated = await db.updateBill({
        id: editingId,
        labId: meta.labId,
        docId: meta.docId,
        datetime,
        items: pins,
        disc_amt: discAmt,
        discount_per: discPer,
        payment: meta.payment,
        name: meta.name,
        mob: meta.mob,
        age: meta.age,
        gender: meta.gender,
        weight: meta.weight,
      });
      const saved = updated.rec || updated;
      if (updated.unchanged) {
        toast(`No changes. Bill ${saved.id}`, 'warn');
      } else {
        toast(`Updated. Bill ${saved.id} — ₹${money(saved.grand_total)}`, 'ok');
      }
      await afterSave(saved.id);
    } catch (e) {
      if (e && e.name === 'NeedsItemVChoiceError') {
        await resolveItemChoiceThenRetry(e, { id: editingId, labId: meta.labId, docId: meta.docId, datetime, disc_amt: discAmt, payment: meta.payment });
      } else {
        toast(e && e.message ? e.message : String(e), 'err');
      }
    }
  } else {
    const dup = await db.getBill(meta.id);
    if (dup) {
      formError(
        'Bill No already exists. Change it, or reopen the existing bill via the field above.',
        'bill-no'
      );
      return;
    }
    const id = await db.getNextBillNo();
    try {
      const created = await db.addBill({
        id,
        labId: meta.labId,
        docId: meta.docId,
        name: meta.name,
        mob: meta.mob,
        age: meta.age,
        gender: meta.gender,
        weight: meta.weight,
        datetime: meta.datetime || nowLocalInput(),
        items: pins,
        discount_per: discPer,
        disc_amt: discAmt,
        payment: meta.payment,
      });
      const saved = created.rec || created;
      let paidNote = '';
      if (Number(meta.payment) === 0) {
        const due = await db.billOutstanding(saved.id);
        const payable = Number(saved.cust_payable != null ? saved.cust_payable : saved.cust_total) || 0;
        if (due <= 0) paidNote = ' — paid from advance';
        else if (due < payable) paidNote = ` — ₹${money(payable - due)} paid from advance, ₹${money(due)} due`;
      }
      toast(`Saved. Bill ${saved.id} — ₹${money(saved.grand_total)}${paidNote}`, 'ok');
      await afterSave(saved.id);
    } catch (e) {
      if (e && e.name === 'NeedsItemVChoiceError') {
        await resolveItemChoiceThenRetry(e, { id, labId: meta.labId, docId: meta.docId, name: meta.name, mob: meta.mob, age: meta.age, gender: meta.gender, weight: meta.weight, disc_amt: discAmt, payment: meta.payment });
      } else {
        toast(e && e.message ? e.message : String(e), 'err');
      }
    }
  }
}

async function resolveItemChoiceThenRetry(err, meta) {
  const keepOld = await Dialog.confirm(
    `Item #${err.itemId} was on this bill at v${err.prevItemV}. ` +
    `Latest is v${err.latestItemV}.\n\nKeep the old price?`,
    { okLabel: 'Keep old', title: 'Item price' }
  );
  const pins = currentTests.map((t) => ({
    itemId: t.itemId,
    itemV: t.itemId === err.itemId ? (keepOld ? err.prevItemV : err.latestItemV) : t.itemV,
    hid: t.hid ? 1 : 0,
  }));
  // Update currentTests so the UI reflects the choice.
  for (const t of currentTests) {
    if (t.itemId === err.itemId) {
      const h = await hydratePin({ itemId: t.itemId, itemV: pins.find((p) => p.itemId === t.itemId).itemV });
      t.itemV = h.itemV; t.sell = h.sell; t.buy = h.buy; t.name = h.name;
    }
  }
  renderBillTests();
  const args = { ...meta, items: pins };
  if (meta.id) await db.updateBill(args);
  else await db.addBill(args);
  await resetForm();
}

function _originalDatetime() {
  return _loadedOriginal && _loadedOriginal.datetime ? _loadedOriginal.datetime : '';
}

// After a successful save: keep the saved bill loaded (no auto-reset) and print.
async function afterSave(billId) {
  try {
    const b = await db.getBill(billId);
    if (b) {
      const hydrated = await db.hydrateBill(b);
      const withRefs = await db.hydrateBillRefs(hydrated);
      await loadForEdit(withRefs);
    }
  } catch {
    // Reload is best-effort; still attempt to print what's on screen.
  }
  await doPrint();
}

async function doPrint() {
  formMsgClear();
  if (!activeItems().length) {
    formError('Add at least one item.', 'bill-test-input');
    return;
  }
  const meta = collectMeta();
  const datetime = (el('bill-datetime') && el('bill-datetime').value) || (editingId ? _originalDatetime() : nowLocalInput());
  const sub = sumField(activeItems(), 'sell');
  const da = Math.min(numOrZero(el('bill-discount-no') ? el('bill-discount-no').value : ''), sub);
  const bill = {
    id: meta.id,
    datetime,
    items: activeItems().map((t) => ({ itemId: t.itemId, itemV: t.itemV, hid: 0, name: t.name, sell: t.sell, buy: t.buy })),
    labName: selText('bill-lab'),
    docName: selText('bill-doc'),
    companyName: _company,
    companyAddress: _companyAddress,
    person: { name: meta.name.toUpperCase(), mob: meta.mob, age: meta.age, gender: meta.gender },
    payment: meta.payment,
    cust_total: sub,
    merch_total: sumField(activeItems(), 'buy'),
    disc_amt: da,
    grand_total: sub - da,
  };
  await printHtml(renderBillHtml(bill));
}

async function onBillNoChange() {
  const input = el('bill-no');
  if (!input) return;
  const raw = input.value.trim();
  if (!raw) return;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    toast('Bill No must be a number.', 'err');
    return;
  }
  if (editingId && _loadedOriginal && Number(_loadedOriginal.id) === n) return;
  const existing = await db.getBill(n);
  if (!existing) {
    if (editingId) {
      editingId = null;
      _loadedOriginal = null;
      _loadedPins = [];
      el('bill-edit-id').value = '';
      el('new-bill-btn').style.display = 'none';
      toast('Bill No ' + n + ' is free', 'info');
    }
    return;
  }
  const hydrated = await db.hydrateBill(existing);
  const withRefs = await db.hydrateBillRefs(hydrated);
  await loadForEdit(withRefs);
  if (el('bill-no')) el('bill-no').focus();
  toast('Editing bill #' + existing.id + '.', 'info');
}

// Open the ledger for the currently-attached customer (bill-person-id).
// Used by the Alt+L hotkey (via app.js) and the register-hints "Ledger" chip.
export async function openCustomerLedger() {
  const pidEl = el('bill-person-id');
  const pid = pidEl ? String(pidEl.value || '').trim() : '';
  if (!pid) {
    toast('Pick a customer first — then Alt+L opens their ledger.', 'info');
    return;
  }
  const { openForPerson } = await import('./ledger.js');
  await openForPerson(Number(pid));
}

// Alt+N: from ANY tab, activate the Bill tab and start a fresh bill.
// Exposed so app.js can call it as a global hotkey.
export async function newBill() {
  const router = await import('../router.js');
  const r = router.getRouter();
  if (r && r.currentTab !== 'bill') r.activateTab('bill');
  await resetForm();
  const nameInput = el('bill-cust-name');
  if (nameInput) nameInput.focus();
}

function wire() {
  off.on(el('new-bill-btn'), 'click', resetForm);
  if (el('bill-discount-no')) off.on(el('bill-discount-no'), 'input', syncDiscount);
  if (el('bill-discount-per')) off.on(el('bill-discount-per'), 'input', syncDiscountPercent);
  if (el('bill-discount-ctc')) off.on(el('bill-discount-ctc'), 'click', applyCtc);
  const form = el('bill-form');
  if (form) {
    off.on(form, 'input', renderPreview);
    off.on(form, 'change', renderPreview);
    off.on(form, 'submit', (e) => {
      e.preventDefault();
      // Only the Save button (or an explicit requestSubmit with that submitter)
      // may save. Implicit Enter submits carry no submitter -> ignore.
      const s = e.submitter;
      if (s && s.id === 'save-bill-btn') doSave();
    });
    // Enter inside a form field must NOT implicitly submit the form (which would
    // save the bill). Only the Save button / Ctrl+S / Alt+S save.
    off.on(form, 'keydown', (e) => {
      if (e.key !== 'Enter') return;
      const t = e.target;
      if (!t || !t.matches) return;
      if (t.matches('textarea, button, [type=submit]')) return;
      // The test typeahead manages its own Enter; every other field (including
      // the customer autofill inputs) must never implicitly submit the form.
      if (t.id === 'bill-test-input') return;
      e.preventDefault();
    });
  }
  off.on(window, 'resize', renderPreview);
  off.on(el('print-bill-btn'), 'click', doPrint);

  const testInput = el('bill-test-input');
  const testUl = el('bill-test-suggest');
  if (testInput && testUl) {
    testInput.setAttribute('role', 'combobox');
    testInput.setAttribute('aria-autocomplete', 'list');
    testInput.setAttribute('aria-expanded', 'false');
    testInput.setAttribute('aria-controls', testUl.id);
    testUl.setAttribute('role', 'listbox');
    off.on(testInput, 'input', (e) => {
      renderTestSuggest(e.target.value).then(() => {
        testInput.setAttribute('aria-expanded', testUl.hidden ? 'false' : 'true');
      });
    });
    off.on(testInput, 'keydown', onTestInputKey);
    off.on(testInput, 'focus', (e) => renderTestSuggest(e.target.value));
  }

  const tbody = document.getElementById('bill-tests-body');
  off.on(tbody, 'focusin', () => {
    if (!activeItems().length) return;
    if (selectedIndex < 0) selectBillRow(0);
  });
  off.on(tbody, 'keydown', (e) => {
    const rows = billRows();
    if (!rows.length) return;
    const cur = rows.indexOf(e.target.closest('tr.bill-test-row'));
    const base = cur < 0 ? selectedIndex : cur;
    if (e.key === 'ArrowDown') { e.preventDefault(); selectBillRow(base + 1); return; }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (base <= 0) {
        const input = el('bill-test-input');
        clearBillRowSelection();
        if (input) input.focus();
        return;
      }
      selectBillRow(base - 1);
      return;
    }
    if (e.key === 'Home') { e.preventDefault(); selectBillRow(0); return; }
    if (e.key === 'End') { e.preventDefault(); selectBillRow(rows.length - 1); return; }
    if (e.key === 'Enter' || e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      const row = e.target.closest('tr.bill-test-row') || rows[selectedIndex];
      if (row) removeTest(Number(row.dataset.index));
    }
  });

  off.on(el('bill-no'), 'change', onBillNoChange);
  if (el('hint-save')) off.on(el('hint-save'), 'click', doSave);
  if (el('hint-print')) off.on(el('hint-print'), 'click', doPrint);
  if (el('hint-new')) off.on(el('hint-new'), 'click', resetForm);
  if (el('hint-ledger')) off.on(el('hint-ledger'), 'click', openCustomerLedger);

  const onKey = (e) => {
    if (!e.key) return;
    const k = e.key.toLowerCase();
    if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
      if (k === 's') { e.preventDefault(); doSave(); return; }
      if (k === 'p') { e.preventDefault(); doPrint(); return; }
      if (k === 'h') { e.preventDefault(); openHistoryDialog(); return; }
      if (k === 'n') { e.preventDefault(); resetForm(); return; }
      return;
    }
    if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey) {
      if (k === 's') { e.preventDefault(); doSave(); }
      else if (k === 'p') { e.preventDefault(); doPrint(); }
      else if (k === 'n') { e.preventDefault(); resetForm(); }
    }
  };
  off.on(document, 'keydown', onKey);
  wireAutofill();
}

export async function mount() {
  off = bindOff();
  _company = await db.getCompanyName();
  _companyAddress = await db.getCompanyAddress();
  syncCtcVisibility();
  wire();
  if (editingId) renderBillTests();
  else if (!_formInitialized) {
    await resetForm();
    _formInitialized = true;
  } else {
    renderBillTests();
    await populateCatalogSelects();
  }
  renderPreview();
}

export function unmount() {
  if (off) off.off();
  off = null;
  runNameSearch.cancel();
  hideSuggests();
}

export async function openBillForEdit(bill) {
  const hydrated = await db.hydrateBill(bill);
  const withRefs = await db.hydrateBillRefs(hydrated);
  await loadForEdit(withRefs);
  const { getRouter } = await import('../router.js');
  const r = getRouter();
  if (r) r.activateTab('bill');
}

export function __getForm() {
  return {
    fields: {
      billNo: el('bill-no'),
      lab: el('bill-lab'),
      doc: el('bill-doc'),
      name: el('bill-cust-name'),
      mob: el('bill-cust-mob'),
      age: el('bill-cust-age'),
      gender: el('bill-cust-gender'),
      weight: el('bill-cust-weight'),
      personId: el('bill-person-id'),
      datetime: el('bill-datetime'),
      testInput: el('bill-test-input'),
      editId: el('bill-edit-id'),
    },
    saveBtn: el('save-bill-btn'),
    printBtn: el('print-bill-btn'),
    newBtn: el('new-bill-btn'),
  };
}

export async function __submitForTest() {
  await doSave();
}

export async function __resetForTest() {
  await resetForm();
}

export function resetFormState() {
  _formInitialized = false;
  editingId = null;
}

export function __getTests() {
  return currentTests.slice();
}

export async function __loadForEditForTest(bill) {
  const hydrated = await db.hydrateBill(bill);
  const withRefs = await db.hydrateBillRefs(hydrated);
  await loadForEdit(withRefs);
}
