// Generic name-only catalog editor modal (Labs, Doctors).
//   openModal('catalogEdit', { kind, id?, labels, api }) -> 'saved' | null
// Keeps legacy element ids (modal-catalog-*) so selftest hooks keep working.

import db from '../../core/db.js';
import { toast } from '../toast.js';
import { defineModal } from './modal.js';

defineModal('catalogEdit', {
  id: 'catalog-modal',
  closeId: 'modal-catalog-close',
  title: (d) => (d && d.id != null ? d.labels.editTitle : d.labels.addTitle),
  sub: (d) => d.labels.sub,
  enterSubmits: true,
  header(d) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'modal-hist-btn';
    btn.id = 'modal-catalog-history';
    btn.innerHTML = 'History<kbd class="kbd">Alt+H</kbd>';
    btn.hidden = !d || d.id == null;
    btn.addEventListener('click', () => {
      if (d && d.id != null)
        import('../revisions.js').then(({ openRevisions }) => openRevisions(d.kind, Number(d.id)));
    });
    return [btn];
  },
  body: () =>
    '<input type="hidden" id="modal-catalog-id" />' +
    '<label class="modal-field">Name <input type="text" id="modal-catalog-name" required maxlength="80" autocomplete="off" /></label>',
  footer: (d) => [
    {
      label: 'Delete',
      id: 'modal-catalog-delete-btn',
      kind: 'danger',
      hidden: () => !d || d.id == null,
      async onClick(ctx) {
        const name = ctx.$('#modal-catalog-name').value.trim();
        ctx.close(null);
        if (ctx.data.onDelete) await ctx.data.onDelete(Number(d.id), name);
      },
    },
    { label: 'Cancel', id: 'modal-catalog-cancel-btn', onClick: (ctx) => ctx.close(null) },
    {
      label: 'Save',
      id: 'modal-catalog-save-btn',
      kind: 'primary',
      async onClick(ctx) {
        const id = ctx.$('#modal-catalog-id').value;
        const name = ctx.$('#modal-catalog-name').value.trim();
        if (!name) return;
        const api = ctx.data.api;
        if (id) await api.update({ id: Number(id), name });
        else await api.add({ name });
        toast(id ? 'Updated.' : 'Added.', 'ok');
        ctx.close('saved');
      },
    },
  ],
  async onOpen(ctx) {
    const d = ctx.data || {};
    if (d.id != null) {
      const item = await d.api.get(d.id);
      if (!item) {
        ctx.close(null);
        return;
      }
      ctx.$('#modal-catalog-id').value = String(item.id);
      ctx.$('#modal-catalog-name').value = item.name;
    } else {
      ctx.$('#modal-catalog-id').value = '';
      ctx.$('#modal-catalog-name').value = '';
    }
    const n = ctx.$('#modal-catalog-name');
    n.focus();
    n.select();
  },
});
