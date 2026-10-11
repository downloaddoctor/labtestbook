// Delete-requests modal (was #del-req-dialog in bills.js).
//   openModal('deleteRequests', { onResolved }) -> null

import db from '../../core/db.js';
import { money } from '../../core/money.js';
import { defineModal } from './modal.js';

async function render(ctx) {
  const rows = await db.listDeleteRequests(0);
  const tbody = ctx.$('#del-req-table tbody');
  tbody.replaceChildren();
  ctx.$('#del-req-empty').hidden = rows.length > 0;
  for (const r of rows) {
    const tr = document.createElement('tr');
    const cells = [r.billId, r.pname, r.total == null ? '' : money(r.total), r.username, r.reason || ''];
    for (const c of cells) {
      const td = document.createElement('td');
      td.textContent = String(c);
      tr.appendChild(td);
    }
    const act = document.createElement('td');
    const ok = document.createElement('button');
    ok.type = 'button';
    ok.className = 'btn-danger';
    ok.textContent = r.billGone ? 'Close' : 'Approve';
    ok.addEventListener('click', async () => {
      await db.resolveDeleteRequest(r.id, true);
      await render(ctx);
      if (ctx.data.onResolved) await ctx.data.onResolved();
    });
    const no = document.createElement('button');
    no.type = 'button';
    no.textContent = 'Reject';
    no.addEventListener('click', async () => {
      await db.resolveDeleteRequest(r.id, false);
      await render(ctx);
      if (ctx.data.onResolved) await ctx.data.onResolved();
    });
    act.append(ok, no);
    tr.appendChild(act);
    tbody.appendChild(tr);
  }
}

defineModal('deleteRequests', {
  id: 'del-req-dialog',
  closeId: 'del-req-close',
  wide: true,
  title: 'Delete requests',
  sub: 'Bills users asked to delete. Approve to delete, or reject to keep.',
  body: () =>
    '<table id="del-req-table" aria-label="Delete requests"><thead><tr>' +
    '<th>Bill</th><th>Name</th><th>Total</th><th>By</th><th>Reason</th><th></th>' +
    '</tr></thead><tbody></tbody></table>' +
    '<p id="del-req-empty" class="empty" hidden>No pending requests.</p>',
  footer: [{ label: 'Close', kind: 'primary', onClick: (ctx) => ctx.close(null) }],
  async onOpen(ctx) {
    await render(ctx);
  },
});
