// Bill view modal (was #bill-view-dialog in bills.js).
//   openModal('billView', { bill, onAction }) -> null
// The caller passes the hydrated bill and an onAction(kind, bill) callback so
// the page keeps owning the print/payment/edit/delete flow.

import db from '../../core/db.js';
import { PAYMENT } from '../../core/enums.js';
import { renderBillHtml } from '../../print/billHtml.js';
import { printHtml } from '../../print/printHtml.js';
import { toast } from '../toast.js';
import { money } from '../../core/money.js';
import { isAdmin, currentUserSync } from '../../core/auth.js';
import { paymentLabel } from '../payment.js';
import { defineModal } from './modal.js';

function fill(ctx, bill) {
  const admin = isAdmin(currentUserSync());
  ctx.setTitle('Bill ' + (bill.id != null ? bill.id : ''));
  ctx.setSub((bill.datetime || '') + (bill.labName ? '  ·  ' + bill.labName : ''));

  const meta = ctx.$('#bill-view-meta');
  meta.replaceChildren();
  const pname = bill.person ? bill.person.name : '';
  const pmob = bill.person ? bill.person.mob : '';
  const nm = document.createElement('span');
  nm.className = 'bv-name';
  nm.textContent = pname || '(no customer)';
  meta.appendChild(nm);
  if (pmob) {
    const mb = document.createElement('span');
    mb.className = 'bv-mob';
    mb.textContent = pmob;
    meta.appendChild(mb);
  }

  const tbody = ctx.$('#bill-view-tests tbody');
  tbody.replaceChildren();
  const items = (bill.items || []).filter((t) => !t.hid);
  for (const t of items) {
    const tr = document.createElement('tr');
    const tdName = document.createElement('td');
    tdName.textContent = t.name;
    const tdPrice = document.createElement('td');
    tdPrice.className = 'num';
    tdPrice.textContent = '₹' + money(t.sell);
    tr.append(tdName, tdPrice);
    tbody.appendChild(tr);
  }

  const cust = bill.cust_total != null ? bill.cust_total : 0;
  const merch = bill.merch_total != null ? bill.merch_total : 0;
  const payable = bill.cust_payable != null ? bill.cust_payable : cust;
  const delBtn = ctx.$('#bill-view-delete-btn');
  if (delBtn) delBtn.textContent = admin ? 'Delete' : 'Request delete';

  const totals = ctx.$('#bill-view-totals');
  totals.replaceChildren();
  const addRow = (label, value, cls) => {
    const tr = document.createElement('tr');
    if (cls) tr.className = cls;
    const l = document.createElement('td');
    l.className = 'tot-label';
    l.textContent = label;
    const v = document.createElement('td');
    v.className = 'tot-num';
    if (value instanceof Node) v.appendChild(value);
    else v.textContent = value;
    tr.append(l, v);
    totals.appendChild(tr);
    return v;
  };
  addRow('Total', money(cust));
  if (bill.disc_amt != null && Number(bill.disc_amt) > 0) {
    addRow('Discount', '- ' + money(bill.disc_amt));
  }
  if (admin) addRow('Merchant total', money(merch));
  addRow('Grand Total', money(payable), 'tot-grand');

  const payEl = ctx.$('#bill-view-payment');
  const setPay = (text, state) => {
    payEl.replaceChildren();
    const lb = document.createElement('span');
    lb.className = 'bv-pay-label';
    lb.textContent = 'Payment';
    const bd = document.createElement('span');
    bd.className = 'bv-badge ' + state;
    bd.textContent = text;
    payEl.append(lb, bd);
  };
  setPay(paymentLabel(bill.payment), Number(bill.payment) === PAYMENT.UNPAID ? 'unpaid' : 'paid');
  if (Number(bill.payment) === PAYMENT.UNPAID) {
    db.billOutstanding(bill.id).then((due) => {
      const partial = due > 0.004 && due < payable - 0.004;
      const state = due <= 0.004 ? 'paid' : partial ? 'partial' : 'unpaid';
      const label = due <= 0.004 ? 'Settled' : partial
        ? 'Partial · paid ' + money(payable - due) + ' · due ' + money(due)
        : 'Unpaid · due ' + money(due);
      setPay(label, state);
    });
  }
}

defineModal('billView', {
  id: 'bill-view-dialog',
  closeId: 'bill-view-close',
  titleId: 'bill-view-title',
  wide: true,
  title: 'Bill',
  sub: '',
  header() {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'modal-hist-btn';
    btn.id = 'bill-view-history-btn';
    btn.innerHTML = 'History<kbd class="kbd">Alt+H</kbd>';
    return [btn];
  },
  body: () =>
    '<div id="bill-view-meta" class="bv-meta"></div>' +
    '<table id="bill-view-tests"><thead><tr><th>Test</th><th>Price</th></tr></thead>' +
    '<tbody></tbody><tbody id="bill-view-totals" class="bv-tot"></tbody></table>' +
    '<div id="bill-view-payment" class="bv-pay"></div>',
  footer: () => [
    { label: 'Print', id: 'bill-view-print-btn', onClick: (ctx) => { ctx.close(null); if (ctx.data.onAction) ctx.data.onAction('print', ctx.data.bill); } },
    { label: 'Payment…', id: 'bill-view-payment-btn', onClick: (ctx) => { ctx.close(null); if (ctx.data.onAction) ctx.data.onAction('payment', ctx.data.bill); } },
    { label: 'Edit', id: 'bill-view-edit-btn', kind: 'primary', onClick: (ctx) => { ctx.close(null); if (ctx.data.onAction) ctx.data.onAction('edit', ctx.data.bill); } },
    { label: 'Delete', id: 'bill-view-delete-btn', kind: 'danger', onClick: (ctx) => { ctx.close(null); if (ctx.data.onAction) ctx.data.onAction('delete', ctx.data.bill); } },
  ],
  async onOpen(ctx) {
    // Legacy id kept for the self-test hook (was on the old <h2>).
    const titleEl = ctx.$('.m-title');
    if (titleEl) titleEl.id = 'bill-view-title';
    fill(ctx, ctx.data.bill);
    ctx.$('#bill-view-history-btn')?.addEventListener('click', () => {
      if (ctx.data.onAction) ctx.data.onAction('history', ctx.data.bill);
    });
  },
});
