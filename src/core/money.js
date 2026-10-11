// Money formatting helper. Values are plain numbers (rupees), displayed with
// two decimals. Not a currency library — intentionally tiny.

export function money(n) {
  const v = Number(n);
  return Number.isFinite(v) ? v.toFixed(2) : '0.00';
}

// Whole-rupee formatter (no decimals) — for summary stats where .00 is noise.
export function money0(n) {
  const v = Number(n);
  return Number.isFinite(v) ? String(Math.round(v)) : '0';
}
