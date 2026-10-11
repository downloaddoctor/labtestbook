// Single source of truth for bill totals and discount.
// Consumed by the bill form, the DB write path, dev/seed, and the self-test so
// the committed row and the preview can never diverge.
//
// v1: bills no longer carry gst_* or discount_per. The bill stores:
//   discount_no (frozen ₹ override, seeded from the person's discount_per),
//   disc_amt (the resolved ₹ discount applied),
//   cust_total / merch_total (sums from priced items),
//   cust_payable / grand_total.
//
// Items passed in MUST already be resolved (itemV -> testRevs) and carry the
// price fields `sell` and `buy` (customer / merchant).

function round2(n) {
  const v = Number(n);
  return Number.isFinite(v) ? Math.round(v * 100) / 100 : 0;
}

function normalizeDiscountNo(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

function sumItems(items, field) {
  let s = 0;
  for (const it of items || []) {
    const v = Number(it && it[field]);
    if (Number.isFinite(v)) s += v;
  }
  return s;
}

// Sums priced items. Priced items look like {itemId,itemV,hid,sell,buy}.
// Returns { cust_total, merch_total }.
export function sumPricedItems(items) {
  return {
    cust_total: round2(sumItems(items, 'sell')),
    merch_total: round2(sumItems(items, 'buy')),
  };
}

// Cost-to-cost (CTC) floor: the merchant/cost total. The customer's payable
// may never drop below this — i.e. a bill's margin can be discounted to zero
// but never negative. maxDiscount = how much ₹ can be taken off cust_total.
export function ctcFloor({ cust_total, merch_total } = {}) {
  const cost = round2(merch_total);
  const total = round2(cust_total);
  return Math.max(0, Math.min(cost, total));
}

// Largest ₹ discount that still keeps grand_total >= cost-to-cost (CTC).
export function maxDiscount({ cust_total, merch_total } = {}) {
  return round2(Math.max(0, round2(cust_total) - ctcFloor({ cust_total, merch_total })));
}

// Resolve the ₹ discount to apply. `disc_amt` is the operator's figure (or
// the person default seeded from discount_per at create time). Capped at
// cust_total. Returns { disc_amt }.
export function resolveDiscount({ cust_total, disc_amt } = {}) {
  const base = round2(cust_total);
  const raw = Number(disc_amt);
  if (!Number.isFinite(raw) || raw <= 0) return { disc_amt: 0 };
  return { disc_amt: Math.min(round2(raw), base) };
}

// Full bill totals from priced items + a frozen ₹ discount.
// Returns { cust_total, merch_total, disc_amt, cust_payable, grand_total }.
export function computeBillTotals({ items, disc_amt } = {}) {
  const { cust_total, merch_total } = sumPricedItems(items);
  const d = resolveDiscount({ cust_total, disc_amt });
  const cust_payable = round2(Math.max(0, cust_total - d.disc_amt));
  const grand_total = cust_payable;
  return {
    cust_total,
    merch_total,
    disc_amt: d.disc_amt,
    cust_payable,
    grand_total,
  };
}
