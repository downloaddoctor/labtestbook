// Name / mobile / bill-no normalizers shared by the DB read + write method groups.
// Names are stored UPPERCASE in place (no *_upper column).

export const PAYMENT = {
  UNPAID: 0,
  CASH: 1,
  UPI: 2,
};

export function normName(s) {
  return s == null ? '' : String(s).trim().toUpperCase();
}

export function normMob(s) {
  return s == null ? '' : String(s).trim();
}

export function normBillNo(v) {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}

// Payment is tri-state: 0 = unpaid, 1 = cash, 2 = UPI. Anything else -> unpaid (0).
export function normPayment(v) {
  const n = Number(v);
  return n === PAYMENT.CASH || n === PAYMENT.UPI ? n : PAYMENT.UNPAID;
}
