// Money-entry modals for a family head.
//   openModal('familyPay',    { sub, info, amount, max? })        -> { amount, method } | null
//   openModal('familyRefund', { sub, info, amount, max, canSave }) -> { amount, method, note } | null
// They only collect input; the caller writes to the DB.

import { defineModal } from './modal.js';

function amountOk(ctx, sel) {
  const a = ctx.$(sel);
  if (!a.checkValidity()) {
    a.reportValidity();
    return null;
  }
  const v = Number(a.value);
  return v > 0 ? v : null;
}

defineModal('familyPay', {
  id: 'family-pay-dialog',
  title: 'Receive payment',
  sub: (d) => d.sub || '',
  enterSubmits: true,
  body: () =>
    '<label>Amount <input id="family-pay-amount" type="number" min="0.01" step="0.01" required /></label>' +
    '<label>Method <select id="family-pay-method"><option value="1">Cash</option><option value="2">UPI</option></select></label>' +
    '<p class="hint" id="family-pay-info"></p>',
  footer: [
    { label: 'Cancel', onClick: (ctx) => ctx.close(null) },
    {
      label: 'Save',
      id: 'family-pay-save',
      kind: 'primary',
      onClick(ctx) {
        const v = amountOk(ctx, '#family-pay-amount');
        if (v == null) return;
        ctx.close({ amount: v, method: Number(ctx.$('#family-pay-method').value) });
      },
    },
  ],
  onOpen(ctx) {
    const d = ctx.data;
    const a = ctx.$('#family-pay-amount');
    if (d.max != null) a.max = String(d.max);
    else a.removeAttribute('max');
    a.value = d.amount != null ? String(d.amount) : '';
    ctx.$('#family-pay-info').textContent = d.info || '';
    a.focus();
  },
});

defineModal('familyRefund', {
  id: 'family-refund-dialog',
  title: 'Refund advance',
  sub: (d) => d.sub || '',
  enterSubmits: true,
  body: () =>
    '<label>Amount <input id="family-refund-amount" type="number" min="0.01" step="0.01" required /></label>' +
    '<label>Method <select id="family-refund-method"><option value="1">Cash</option><option value="2">UPI</option></select></label>' +
    '<label>Note <input id="family-refund-note" type="text" /></label>' +
    '<p class="hint" id="family-refund-info"></p>',
  footer: [
    { label: 'Cancel', onClick: (ctx) => ctx.close(null) },
    {
      label: 'Refund',
      id: 'family-refund-save',
      kind: 'primary',
      onClick(ctx) {
        const v = amountOk(ctx, '#family-refund-amount');
        if (v == null) return;
        ctx.close({
          amount: v,
          method: Number(ctx.$('#family-refund-method').value),
          note: ctx.$('#family-refund-note').value.trim() || null,
        });
      },
    },
  ],
  onOpen(ctx) {
    const d = ctx.data;
    const a = ctx.$('#family-refund-amount');
    a.value = d.amount != null ? String(d.amount) : '';
    if (d.max != null) a.max = String(d.max);
    ctx.$('#family-refund-info').textContent = d.info || '';
    ctx.$('#family-refund-save').disabled = !d.canSave;
    a.focus();
  },
});
