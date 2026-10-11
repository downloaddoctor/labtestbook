// Patient timeline modal. Opened from any page:
//   openModal('patientView', { id, onBeforeShow?, onClose? })
// Shell (header, close, Esc, backdrop, footer) comes from modal.js.

import db from '../../core/db.js';
import { PAYMENT } from '../../core/enums.js';
import { money } from '../../core/money.js';
import { paymentLabel } from '../payment.js';
import { defineModal } from './modal.js';

function items(ctx) {
  const list = ctx.body.querySelector('.hx-list');
  return list ? Array.from(list.children) : [];
}

function setActive(ctx, i) {
  const list = items(ctx);
  if (!list.length) return;
  i = Math.max(0, Math.min(i, list.length - 1));
  list.forEach((n, k) => n.classList.toggle('hx-active', k === i));
  ctx.s.active = i;
  list[i].scrollIntoView({ block: 'nearest' });
}

async function openBill(ctx, billId) {
  const bill = await db.getBill(billId);
  if (!bill) return;
  ctx.close();
  const billPage = await import('../pages/bill.js');
  await billPage.openBillForEdit(bill);
}

function renderBillItem(b, labMap, docMap, allocMap) {
  const item = document.createElement('div');
  const pay = Number(b.payment);
  item.className = 'hx-item ' + (pay === PAYMENT.UNPAID ? 'unpaid' : 'paid');
  item.dataset.id = String(b.id);
  const dot = document.createElement('div');
  dot.className = 'hx-dot';
  const body = document.createElement('div');
  body.className = 'hx-body';
  const head = document.createElement('div');
  head.className = 'hx-head';
  const date = document.createElement('span');
  date.className = 'hx-date';
  date.textContent = 'Bill ' + (b.id != null ? b.id : '');
  const payable = Number(b.cust_payable != null ? b.cust_payable : b.cust_total) || 0;
  const got = Math.min(payable, (allocMap && allocMap.get(b.id)) || 0);
  const due = Math.max(0, payable - got);
  const badge = document.createElement('span');
  badge.className = 'hx-badge';
  if (pay === PAYMENT.UNPAID && due <= 0.004) badge.textContent = 'Settled';
  else if (pay === PAYMENT.UNPAID && got > 0) badge.textContent = 'Partial · due ₹' + money(due);
  else badge.textContent = paymentLabel(pay);
  const time = document.createElement('span');
  time.className = 'hx-time';
  time.textContent = b.datetime || '';
  head.append(date, badge, time);
  const meta = document.createElement('div');
  meta.className = 'hx-meta';
  const bits = ['₹' + money(payable)];
  if (pay === PAYMENT.UNPAID && got > 0) bits.push('paid ₹' + money(got) + ' · due ₹' + money(due));
  const labName = labMap.get(b.labId);
  const docName = docMap.get(b.docId);
  if (labName) bits.push(labName);
  if (docName) bits.push(docName);
  meta.textContent = bits.join('  ·  ');
  body.append(head, meta);
  item.append(dot, body);
  return item;
}

defineModal('patientView', {
  id: 'patient-view-dialog',
  closeId: 'patient-view-close',
  title: 'Patient',
  async body(data, ctx) {
    const titleEl = ctx.$('.m-title');
    if (titleEl) titleEl.id = 'patient-view-title';
    ctx.s = { person: null, active: -1 };
    const wrap = document.createElement('div');
    const person = await db.getPerson(Number(data.id));
    if (!person) {
      wrap.textContent = 'Patient not found.';
      return wrap;
    }
    ctx.s.person = person;
    const bills = await db.billsForPerson(person.id);
    const labMap = new Map();
    const docMap = new Map();
    for (const b of bills) {
      if (b.labId && !labMap.has(b.labId)) {
        const l = await db.getLab(b.labId);
        if (l) labMap.set(b.labId, l.name);
      }
      if (b.docId && !docMap.has(b.docId)) {
        const d = await db.getDoctor(b.docId);
        if (d) docMap.set(b.docId, d.name);
      }
    }
    const allocMap = await db.allocationsMap(
      bills.filter((b) => Number(b.payment) === PAYMENT.UNPAID).map((b) => b.id)
    );

    ctx.setTitle(person.name || '(no name)');
    const subText = [
      '#' + person.id,
      person.mob || null,
      person.age != null ? person.age + 'y' : null,
      person.gender || null,
      person.weight != null ? person.weight + 'kg' : null,
      person.discount_per != null && Number(person.discount_per) > 0 ? 'Discount ' + person.discount_per + '%' : null,
      (bills.length || person.billsCount || 0) + ' bill(s)',
    ]
      .filter(Boolean)
      .join('  ·  ');
    ctx.setSub(subText);

    let unpaid = 0;
    for (const b of bills) {
      if (Number(b.payment) !== PAYMENT.UNPAID) continue;
      const amt = Number(b.cust_payable != null ? b.cust_payable : b.cust_total) || 0;
      const left = Math.max(0, amt - (allocMap.get(b.id) || 0));
      if (left > 0.004) unpaid += left;
    }
    if (unpaid > 0) {
      const pill = document.createElement('span');
      pill.className = 'hx-badge badge-unpaid';
      pill.textContent = 'Unpaid ₹' + money(unpaid);
      ctx.el.querySelector('.m-sub').append(document.createTextNode('  '), pill);
    }

    const list = document.createElement('div');
    list.className = 'hx-list';
    list.id = 'patient-view-bills';
    for (const b of bills) list.appendChild(renderBillItem(b, labMap, docMap, allocMap));
    list.addEventListener('click', (e) => {
      const item = e.target.closest('.hx-item[data-id]');
      if (!item) return;
      setActive(ctx, items(ctx).indexOf(item));
      openBill(ctx, Number(item.dataset.id));
    });
    wrap.appendChild(list);
    if (!bills.length) {
      const p = document.createElement('p');
      p.className = 'empty';
      p.textContent = 'No bills for this patient.';
      wrap.appendChild(p);
    }
    return wrap;
  },
  footer: [
    {
      label: 'Ledger',
      html: 'Ledger<kbd class="kbd">Alt+L</kbd>',
      id: 'patient-view-ledger-btn',
      async onClick(ctx) {
        const p = ctx.s && ctx.s.person;
        if (!p) return;
        ctx.close();
        const { openForPerson } = await import('../pages/ledger.js');
        await openForPerson(p.id, p.name);
      },
    },
  ],
  onKey(e, ctx) {
    const list = items(ctx);
    if (!list.length) return;
    const a = ctx.s.active;
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive(ctx, a < 0 ? 0 : a + 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(ctx, a < 0 ? list.length - 1 : a - 1); }
    else if (e.key === 'Home') { e.preventDefault(); setActive(ctx, 0); }
    else if (e.key === 'End') { e.preventDefault(); setActive(ctx, list.length - 1); }
    else if (e.key === 'Enter' && a >= 0 && list[a]) {
      e.preventDefault();
      openBill(ctx, Number(list[a].dataset.id));
    }
  },
  onOpen(ctx) {
    // Publish the current patient id on the dialog element so global
    // hotkeys (Alt+L) can find it while the modal is open from any tab.
    if (ctx.el && ctx.data && ctx.data.id != null) {
      ctx.el.dataset.patientId = String(ctx.data.id);
    }
    if (ctx.data && ctx.data.onBeforeShow) ctx.data.onBeforeShow();
  },
  onClose(ctx) {
    if (ctx.el) delete ctx.el.dataset.patientId;
    if (ctx.data && ctx.data.onClose) ctx.data.onClose();
  },
});
