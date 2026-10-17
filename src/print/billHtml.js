// Bill print template (half-A4 landscape, dual copy).
// renderBillHtml(bill) -> full HTML string. No DOM side effects; pure.
// Geometry lives in CSS (.print-receipt), not here.
//
// MERCHANT copy (left 38%): UNCHANGED — item names only, minimal header.
// CUSTOMER copy (right 62%): styled after a diagnostic-center cash receipt:
//   company name + tagline + address/phone, CASH RECEIPT label, 2-col meta
//   block (Receipt No | Date, Name | Age/Sex, Mobile | Referred By), test
//   table (Sr.No | Test Name | Charges), totals (Total / Discount / Balance),
//   signature line.
//
// Data template: loops items[], so row count is unbounded (pages flow).
//
// v1: pass a HYDRATED bill — items carry {name, sell, buy}; bill carries
// labName (company), docName, person {name, mob, age, gender}, payment, and
// company{Name,Tagline,Address,Phone} fields. Call db.hydrateBill() +
// db.hydrateBillRefs() before calling this.

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

// 'Age Years / Sex' string for the customer meta row (empty parts omitted).
function ageSex(age, gender) {
  const a = age == null || age === '' ? '' : String(age);
  const g = gender === 'M' ? 'Male' : gender === 'F' ? 'Female' : gender === 'O' ? 'Other' : '';
  if (a && g) return a + ' Years / ' + g;
  return a ? a + ' Years' : g;
}

export function renderBillHtml(bill) {
  const items = Array.isArray(bill.items) ? bill.items.filter((it) => !it.hid) : [];
  const person = bill.person || {};

  const mRows = items.map((t) => `<tr><td class="c-name">${esc(t.name)}</td></tr>`).join('');

  // Customer table: Sr.No | Test Name | Charges. Serial numbers use the
  // printed row index (1-based, zero-padded), hidden rows excluded.
  const cRows = items
    .map((t, i) => {
      const sr = String(i + 1).padStart(2, '0');
      return `<tr><td class="c-sr">${esc(sr)}</td><td class="c-name">${esc(t.name)}</td><td class="c-price">${esc(money(t.sell))}</td></tr>`;
    })
    .join('');

  const custTotal = money(bill.cust_total || 0);
  const discAmt = money(bill.disc_amt || 0);
  const hasDisc = Number(bill.disc_amt || 0) > 0;
  const grandTotal = money(bill.grand_total != null ? bill.grand_total : bill.cust_total || 0);

  // ✓ before the Balance Amount when the bill is paid (Cash / UPI). Reference
  // behavior kept from the old customer copy.
  const isPaid = Number(bill.payment) !== PAYMENT.UNPAID;
  const tick = isPaid ? '<span class="pr-tick">✓</span>' : '';
  const company = bill.companyName || COMPANY;
  const address = bill.companyAddress || '';
  const phone = bill.companyPhone || '';

  return `<div class="print-receipt">
  <section class="pr-copy pr-merchant">
    <h1 class="pr-company">${esc(company)}</h1>
    <p class="pr-diagnosed">Referred By: ${esc(bill.docName || '')}</p>
    <div class="pr-row2 pr-row2-top">
      <span>Bill No: ${esc(bill.id)}</span>
      <span>Date: ${esc(fmtDt(bill.datetime))}</span>
    </div>
    <div class="pr-row2">
      <span>Patient Name: ${esc(person.name || '')}</span>
    </div>
    <div class="pr-row2">
      <span>Age: ${esc(person.age != null && person.age !== '' ? person.age + ' Years' : '')}</span>
      <span>Sex: ${esc(person.gender === 'M' ? 'Male' : person.gender === 'F' ? 'Female' : person.gender === 'O' ? 'Other' : '')}</span>
    </div>
    <table class="pr-table pr-table-merchant">
      <thead><tr><th class="c-name">Test</th></tr></thead>
      <tbody>${mRows}</tbody>
    </table>
  </section>
  <section class="pr-copy pr-customer">
    <header class="c-head">
      <h1 class="c-company">${esc(company)}</h1>
      ${address ? `<p class="c-contact">${esc(address).replace(/&lt;br\s*\/?&gt;/gi, '<br>').replace(/\r?\n/g, '<br>')}</p>` : ''}
      ${phone ? `<p class="c-contact">Phone : ${esc(phone)}</p>` : ''}
    </header>
    <table class="c-meta">
      <tbody>
        <tr>
          <td class="c-k">Receipt No</td><td class="c-v">: ${esc(bill.id)}</td>
          <td class="c-k">Date</td><td class="c-v">: ${esc(fmtDt(bill.datetime))}</td>
        </tr>
        <tr>
          <td class="c-k">Patient Name</td><td class="c-v">: ${esc(person.name || '')}</td>
          <td class="c-k">Age / Sex</td><td class="c-v">: ${esc(ageSex(person.age, person.gender))}</td>
        </tr>
        <tr>
          <td class="c-k">Mobile No</td><td class="c-v">: ${esc(person.mob || '')}</td>
          <td class="c-k c-up">Referred By</td><td class="c-v c-up">: ${esc(bill.docName || '')}</td>
        </tr>
      </tbody>
    </table>
    <table class="pr-table pr-table-customer">
      <thead><tr><th class="c-sr">Sr.No</th><th class="c-name">Test Name</th><th class="c-price">Charges (Rs.)</th></tr></thead>
      <tbody>${cRows}</tbody>
    </table>
    <table class="c-totals">
      <tbody>
        ${hasDisc ? `<tr><td class="c-k" colspan="2">Sub Total</td><td class="c-v">${esc(custTotal)}</td></tr>
        <tr><td class="c-k" colspan="2">Discount</td><td class="c-v">${esc(discAmt)}</td></tr>` : ''}
        <tr class="c-tot-grand"><td class="c-k" colspan="2">Grand Total</td><td class="c-v">${tick}${esc(grandTotal)}</td></tr>
      </tbody>
    </table>
  </section>
</div>`;
}
