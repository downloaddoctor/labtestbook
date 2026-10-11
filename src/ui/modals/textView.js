// Read-only text modals: backup log and self-test report.
//   openModal('log',      { sub, text, buttons? })
//   openModal('selfTest', { sub, text, buttons? })
// buttons = [{ label, onClick(ctx) }] are added to the footer next to Close.

import { defineModal } from './modal.js';

function textModal(name, id, title) {
  defineModal(name, {
    id,
    wide: true,
    title,
    sub: (d) => d.sub || '',
    body: (d) => {
      const pre = document.createElement('pre');
      pre.className = 'log-view';
      pre.textContent = d.text || '';
      return pre;
    },
    footer: (d) => [
      ...(d.buttons || []).map((b) => ({ label: b.label, onClick: (ctx) => b.onClick(ctx) })),
      { label: 'Close', kind: 'primary', onClick: (ctx) => ctx.close(null) },
    ],
    onOpen(ctx) {
      const pre = ctx.$('pre');
      if (pre && ctx.data.scrollEnd) pre.scrollTop = pre.scrollHeight;
    },
  });
}

textModal('log', 'log-dialog', 'Backup log');
textModal('selfTest', 'test-dialog', 'Self-test');
