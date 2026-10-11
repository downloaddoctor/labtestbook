// Bill print template (half-A4 landscape, dual copy).
// renderBillHtml(bill) -> full HTML string. No DOM side effects; pure.
// Geometry lives in CSS (.print-receipt), not here.
// Merchant zone (left 40%): item names only.
// Customer zone (right 60%): company header, diagnosed-by, bill no / date,
//   name / age, test name + price, totals, PAID stamp when settled.
// Data template: loops items[], so row count is unbounded (pages flow).
//
// v1: pass a HYDRATED bill — items carry {name, sell, buy}; bill carries
// labName (company), docName, person {name, mob, age}, payment. Call
// db.hydrateBill() + db.hydrateBillRefs() before calling this.

import { money } from '../core/money.js';
import { PAYMENT } from '../core/enums.js';

const COMPANY = 'LAB TEST BOOK';

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// '2026-10-11T15:45' -> '11 Oct 2026, 03:45 PM' (day and hour zero-padded). Parsed by hand (no Date) so the
// printed time is exactly the stored one, with no timezone shift. Unknown shapes pass through.
function fmtDt(v) {
  const s = String(v == null ? '' : v).trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{1,2}):(\d{2}))?/.exec(s);
  if (!m) return s;
  const mon = MONTHS[Number(m[2]) - 1];
  if (!mon) return s;
  const date = m[3] + ' ' + mon + ' ' + m[1];
  if (m[4] == null) return date;
  const h = Number(m[4]);
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return date + ', ' + String(h12).padStart(2, '0') + ':' + m[5] + ' ' + (h >= 12 ? 'PM' : 'AM');
}

function metaLines(meta, opts) {
  const lines = [];
  lines.push(`Bill No: ${esc(meta.id)}`);
  lines.push(`Date: ${esc(fmtDt(meta.datetime))}`);
  lines.push(`Affiliated By: ${esc(meta.labName || '')}`);
  lines.push(`Referred By: ${esc(meta.docName || '')}`);
  if (opts && opts.customer && meta.person) {
    lines.push(`Customer: ${esc(meta.person.name || '')}`);
    lines.push(`Mobile: ${esc(meta.person.mob || '')}`);
  }
  return lines;
}

export function renderBillHtml(bill) {
  const items = Array.isArray(bill.items) ? bill.items.filter((it) => !it.hid) : [];
  const person = bill.person || {};

  const mRows = items.map((t) => `<tr><td class="c-name">${esc(t.name)}</td></tr>`).join('');

  const cRows = items
    .map((t) => {
      const p = money(t.sell);
      return `<tr><td class="c-name">${esc(t.name)}</td><td class="c-price">${esc(p)}</td></tr>`;
    })
    .join('');

  const mMeta = metaLines(bill, { customer: false }).join('<br>');

  const custTotal = money(bill.cust_total || 0);
  const discAmt = money(bill.disc_amt || 0);
  const grandTotal = money(bill.grand_total != null ? bill.grand_total : bill.cust_total || 0);
  const showDisc = Number(bill.disc_amt) > 0;

  const isPaid = Number(bill.payment) !== PAYMENT.UNPAID;
  const tick = isPaid ? '<span class="pr-tick">✓</span>' : '';

  // With a discount: Subtotal, Discount, Grand Total. Without: Grand Total only.
  // The first visible totals row carries .tot-first (dashed rule above it): Subtotal when shown, else Grand Total.
  const totalsRows = [
    showDisc
      ? `<tr class="tot-first"><td class="c-name">Subtotal</td><td class="c-price">${esc(custTotal)}</td></tr>`
      : '',
    showDisc
      ? `<tr><td class="c-name">Discount</td><td class="c-price">- ${esc(discAmt)}</td></tr>`
      : '',
    `<tr class="${showDisc ? '' : 'tot-first'}"><td class="c-name"><strong>Grand Total</strong></td><td class="c-price">${tick}<strong>${esc(grandTotal)}</strong></td></tr>`,
  ].join('');

  const company = bill.companyName || COMPANY;
  const affiliated = bill.labName || '';

  return `<div class="print-receipt">
  <section class="pr-copy pr-merchant">
    <h1 class="pr-company">${esc(company)}</h1>
    <p class="pr-diagnosed">Diagnosed by: ${esc(bill.docName || '')}</p>
    <div class="pr-row2 pr-row2-top">
      <span>Bill No: ${esc(bill.id)}</span>
      <span>Date: ${esc(fmtDt(bill.datetime))}</span>
    </div>
    <table class="pr-table pr-table-merchant">
      <thead><tr><th class="c-name">Test</th></tr></thead>
      <tbody>${mRows}</tbody>
    </table>
  </section>
  <section class="pr-copy pr-customer">
    <h1 class="pr-company">${esc(company)}</h1>
    <p class="pr-diagnosed">Affiliated By: ${esc(affiliated)}</p>
    <p class="pr-diagnosed">Diagnosed by: ${esc(bill.docName || '')}</p>
    <div class="pr-row2">
      <span>Bill No: ${esc(bill.id)}</span>
      <span>Date: ${esc(fmtDt(bill.datetime))}</span>
    </div>
    <div class="pr-row2">
      <span>Name: ${esc(person.name || '')}</span>
      <span>Age: ${esc(person.age != null && person.age !== '' ? person.age : '')}</span>
    </div>
    <table class="pr-table pr-table-customer">
      <thead><tr><th class="c-name">Test</th><th class="c-price">Price</th></tr></thead>
      <tbody>${cRows}${totalsRows}</tbody>
    </table>
  </section>
</div>`;
}
