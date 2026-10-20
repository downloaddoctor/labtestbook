// Test catalog editor modal (was tests.js #test-modal).
//   openModal('testEdit', { id? }) -> 'saved' | 'deleted' | null
// Keeps legacy element ids so existing selftest hooks keep working.

import db from '../../core/db.js';
import Dialog from '../dialog.js';
import { toast } from '../toast.js';
import { defineModal } from './modal.js';

defineModal('testEdit', {
  id: 'test-modal',
  closeId: 'modal-test-close',
  title: (d) => (d && d.id != null ? 'Edit Test' : 'Add Test'),
  sub: 'Catalog entry — customer and merchant prices.',
  enterSubmits: true,
  header(d, ctx) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'modal-hist-btn';
    btn.id = 'modal-test-history';
    btn.innerHTML = 'History<kbd class="kbd">Alt+H</kbd>';
    btn.hidden = !d || d.id == null;
    btn.addEventListener('click', () => {
      if (d && d.id != null)
        import('../revisions.js').then(({ openRevisions }) => openRevisions('test', Number(d.id)));
    });
    return [btn];
  },
  body: () =>
    '<input type="hidden" id="modal-test-id" />' +
    '<label class="modal-field">Name <input type="text" id="modal-test-name" required maxlength="80" autocomplete="off" /></label>' +
    '<label class="modal-field">Price <input type="number" id="modal-test-customer-price" step="0.01" min="0" /></label>' +
    '<label class="modal-field">Merchant Price <input type="number" id="modal-test-merchant-price" step="0.01" min="0" required /></label>' +
    '<label class="modal-field">Code <input type="text" id="modal-test-code" maxlength="40" autocomplete="off" /></label>' +
    '<label class="modal-field">Sample <input type="text" id="modal-test-sample" maxlength="300" autocomplete="off" /></label>' +
    '<label class="modal-field">Reporting time <input type="text" id="modal-test-tat" maxlength="40" autocomplete="off" /></label>' +
    '<label class="modal-field">Details <textarea id="modal-test-info" rows="4" style="width:100%"></textarea></label>',
  footer: (d) => [
    {
      label: 'Delete',
      id: 'modal-test-delete-btn',
      kind: 'danger',
      hidden: () => !d || d.id == null,
      async onClick(ctx) {
        const name = ctx.$('#modal-test-name').value.trim();
        ctx.close(null);
        const ok = await Dialog.confirm(`Delete test "${name}"? This cannot be undone.`, {
          danger: true,
          okLabel: 'Delete',
          title: 'Delete test',
        });
        if (!ok) return;
        await db.deleteTest(Number(d.id));
      },
    },
    { label: 'Cancel', id: 'modal-test-cancel-btn', onClick: (ctx) => ctx.close(null) },
    {
      label: 'Save',
      id: 'modal-test-save-btn',
      kind: 'primary',
      async onClick(ctx) {
        const id = ctx.$('#modal-test-id').value;
        const name = ctx.$('#modal-test-name').value.trim();
        const cpRaw = parseFloat(ctx.$('#modal-test-customer-price').value);
        const cp = isNaN(cpRaw) ? 0 : cpRaw;
        const mp = parseFloat(ctx.$('#modal-test-merchant-price').value);
        if (!name || isNaN(cp) || isNaN(mp)) return;
        const det = {
          code: ctx.$('#modal-test-code').value,
          sample: ctx.$('#modal-test-sample').value,
          tat: ctx.$('#modal-test-tat').value,
          info: ctx.$('#modal-test-info').value,
        };
        if (id) await db.updateTest({ id: Number(id), name, sell: cp, buy: mp, ...det });
        else await db.addTest({ name, sell: cp, buy: mp, ...det });
        toast(id ? 'Test updated.' : 'Test added.', 'ok');
        ctx.close('saved');
      },
    },
  ],
  async onOpen(ctx) {
    const d = ctx.data || {};
    if (d.id != null) {
      const test = await db.getTest(d.id);
      if (!test) {
        ctx.close(null);
        return;
      }
      ctx.$('#modal-test-id').value = String(test.id);
      ctx.$('#modal-test-name').value = test.name;
      ctx.$('#modal-test-customer-price').value = test.sell;
      ctx.$('#modal-test-merchant-price').value = test.buy;
      ctx.$('#modal-test-code').value = test.code || '';
      ctx.$('#modal-test-sample').value = test.sample || '';
      ctx.$('#modal-test-tat').value = test.tat || '';
      ctx.$('#modal-test-info').value = test.info || '';
    } else {
      ctx.$('#modal-test-id').value = '';
      ctx.$('#modal-test-name').value = '';
      ctx.$('#modal-test-customer-price').value = '';
      ctx.$('#modal-test-merchant-price').value = '';
      ctx.$('#modal-test-code').value = '';
      ctx.$('#modal-test-sample').value = '';
      ctx.$('#modal-test-tat').value = '';
      ctx.$('#modal-test-info').value = '';
    }
    const n = ctx.$('#modal-test-name');
    n.focus();
    n.select();
  },
});
