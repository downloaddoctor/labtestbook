// Integer enums. Stored as small ints in the DB and the CSV log (shorter than
// strings). Names are used only in code and the UI. Never renumber: append.

// bill.payment and payments.method share the cash/UPI codes.
export const PAYMENT = { UNPAID: 0, CASH: 1, UPI: 2 };

// allocations.ak: how an allocation was funded.
export const ALLOC = { RECEIPT: 0, APPLY: 1 };

// ledger.kind (derived rows only, never in the CSV log).
export const LEDGER_KIND = {
  SALE_CASH: 1,
  SALE_CREDIT: 2,
  PAY: 3,
  UNPAY: 4,
  ADJUST: 5,
  DELETE: 6,
  RESTORE: 7,
  PAY_PART: 8,
  ADVANCE: 9,
  ADVANCE_APPLY: 10,
  REFUND: 11,
  ALLOC_RETURN: 12,
};

export const LEDGER_KIND_NAME = Object.fromEntries(
  Object.entries(LEDGER_KIND).map(([name, code]) => [code, name])
);

// Names in, ints out (and back). Unknown values map to 0 / the raw number.
export const kindCode = (name) => LEDGER_KIND[name] || 0;
export const kindName = (code) => LEDGER_KIND_NAME[code] || String(code);
