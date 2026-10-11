// Shared money flows on top of the familyPay / familyRefund modals.
// receiveFamilyPayment(person) -> Promise<boolean> (true = a payment was saved).
// receiveBillPayment(bill, person) -> Promise<boolean>: same modal, one bill.
//   Full amount on a bill without part payments settles it directly;
//   anything else is recorded as a part payment against that bill only.
// addFamilyAdvance(person), refundFamilyAdvance(person) -> Promise<boolean>.

import db from '../core/db.js';
import { money } from '../core/money.js';
import Dialog from './dialog.js';
import { openModal } from './modals/index.js';

const headIdOf = (person) => (person.headId != null ? person.headId : person.id);

export async function addFamilyAdvance(person) {
  const headId = headIdOf(person);
  const head = await db.getPerson(headId);
  const due = await db.familyDueBills(headId);
  const total = due.reduce((s, d) => s + d.due, 0);
  const adv = await db.advanceBalance(headId);
  const r = await openModal('familyPay', {
    sub: (head ? head.name : '#' + headId) + ' · advance ₹' + money(adv),
    amount: '',
    info: total > 0
      ? 'Money kept as advance. Note: ₹' + money(total) + ' is due and will be settled first, oldest bill first.'
      : 'Money kept as advance for future bills.',
  });
  if (!r) return false;
  await db.recordPayment({ headId, amount: r.amount, method: r.method, billIds: [-1] });
  return true;
}

export async function refundFamilyAdvance(person) {
  const headId = headIdOf(person);
  const head = await db.getPerson(headId);
  const adv = await db.advanceBalance(headId);
  const r = await openModal('familyRefund', {
    sub: (head ? head.name : '#' + headId) + ' · advance held ₹' + money(adv),
    amount: adv > 0 ? String(adv) : '',
    max: adv > 0 ? adv : null,
    canSave: adv > 0,
    info: adv > 0
      ? 'Money handed back to the customer. Cannot be more than the advance held.'
      : 'No advance is held, nothing to refund.',
  });
  if (!r) return false;
  try {
    await db.refundAdvance({ headId, amount: r.amount, method: r.method, note: r.note });
  } catch (err) {
    await Dialog.alert(err && err.message ? err.message : 'Refund failed.');
    return false;
  }
  return true;
}

export async function receiveFamilyPayment(person) {
  const headId = headIdOf(person);
  const head = await db.getPerson(headId);
  const due = await db.familyDueBills(headId);
  const total = due.reduce((s, d) => s + d.due, 0);
  const adv = await db.advanceBalance(headId);
  const r = await openModal('familyPay', {
    sub: (head ? head.name : '#' + headId) + ' · family due ₹' + money(total) + ' · advance ₹' + money(adv),
    amount: total > 0 ? String(total) : '',
    info: due.length + ' open bill(s), applied oldest first. Any excess is kept as advance.',
  });
  if (!r) return false;
  await db.recordPayment({ headId, amount: r.amount, method: r.method });
  return true;
}

export async function receiveBillPayment(bill, person) {
  const headId = headIdOf(person);
  const due = await db.billOutstanding(bill.id);
  if (!(due > 0)) return false;
  const parts = await db.raw.allocations.where('billId').equals(Number(bill.id)).count();
  const r = await openModal('familyPay', {
    sub: 'Bill ' + bill.id + (person.name ? ' · ' + person.name : '') + ' · due ₹' + money(due),
    amount: String(due),
    max: due,
    info: 'Full amount settles the bill. A smaller amount is recorded as a part payment.',
  });
  if (!r || r.amount > due + 0.004) return false;
  if (!parts && r.amount >= due - 0.004) {
    await db.setBillPayment(bill.id, r.method);
  } else {
    await db.recordPayment({ headId, amount: r.amount, method: r.method, billIds: [Number(bill.id)] });
  }
  return true;
}
