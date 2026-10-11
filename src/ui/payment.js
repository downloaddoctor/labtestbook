// Reusable payment dialog: set payment on a bill (0 = unpaid, 1 = cash, 2 = upi).
// Self-contained — resolves <dialog id="payment-dialog"> lazily so it can be
// opened from any page. openPaymentDialog(bill) -> Promise<number|null>

import db from '../core/db.js';
import { normPayment } from '../core/norm.js';
import { PAYMENT } from '../core/enums.js';

function el(id) {
  return document.getElementById(id);
}

export function paymentLabel(p) {
  return Number(p) === PAYMENT.UNPAID ? 'Unpaid' : Number(p) === PAYMENT.UPI ? 'UPI' : 'Cash';
}

// Show the payment dialog. Does NOT write — callers apply via db.setBillPayment
// (or use openPaymentFor which does both).
export async function openPaymentDialog(bill) {
  const { openModal } = await import('./modals/index.js');
  return openModal('payment', { bill });
}

export async function openPaymentFor(bill) {
  if (!bill) return null;
  const choice = await openPaymentDialog(bill);
  if (choice == null) return null;
  await db.setBillPayment(bill.id, choice);
  return choice;
}
