// Payment modal: set payment on a bill (0 unpaid, 1 cash, 2 UPI).
//   openModal('payment', { bill }) -> number | null   (does NOT write)

import { normPayment } from '../../core/norm.js';
import { defineModal } from './modal.js';

defineModal('payment', {
  id: 'payment-dialog',
  closeId: 'payment-close',
  title: 'Payment',
  sub: (d) => {
    const b = d.bill;
    const who = b.person ? b.person.name : '';
    return `Bill ${b.id}${who ? ' · ' + who : ''} · ₹` + (b.grand_total != null ? b.grand_total : 0);
  },
  enterSubmits: true,
  body: (d) =>
    '<label>Payment <select id="payment-status">' +
    '<option value="1">Cash</option><option value="2">UPI</option><option value="0">Unpaid</option>' +
    '</select></label>',
  footer: [
    { label: 'Cancel', onClick: (ctx) => ctx.close(null) },
    {
      label: 'Save',
      id: 'payment-save',
      kind: 'primary',
      onClick: (ctx) => ctx.close(Number(ctx.$('#payment-status').value)),
    },
  ],
  onOpen(ctx) {
    const sel = ctx.$('#payment-status');
    sel.value = String(normPayment(ctx.data.bill.payment));
    sel.addEventListener('change', () => ctx.$('#payment-save').focus());
    sel.focus();
  },
});
