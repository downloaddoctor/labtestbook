// Revisions modal (was #revisions-modal in revisions.js).
//   openModal('revisions', { kind, id }) -> null
// The heavy rendering lives in src/ui/revisions.js; this only owns the shell.

import { defineModal } from './modal.js';

defineModal('revisions', {
  id: 'revisions-modal',
  closeId: 'revisions-close',
  titleId: 'revisions-title',
  subId: 'revisions-meta',
  wide: true,
  title: 'Revisions',
  sub: '',
  body: () =>
    '<div id="revisions-list" class="hx-list"></div>' +
    '<p id="revisions-loading" class="hint" hidden>Loading…</p>',
  footer: [{ label: 'Close', kind: 'primary', onClick: (ctx) => ctx.close(null) }],
});
