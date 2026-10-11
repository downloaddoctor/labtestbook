// App-update prompt.
//   openModal('update', { onNow }) -> 'now' | null

import { defineModal } from './modal.js';

defineModal('update', {
  id: 'update-dialog',
  closeId: 'update-close',
  title: 'Update available',
  sub: 'A new version of Lab Test Book is available.',
  body: () => '<p>Apply the update now? The app will reload once. Your data is not affected.</p>',
  footer: [
    { label: 'Later', id: 'update-later', onClick: (ctx) => ctx.close(null) },
    {
      label: 'Update now',
      id: 'update-now',
      kind: 'primary',
      onClick(ctx) {
        if (ctx.data && ctx.data.onNow) ctx.data.onNow();
        ctx.close('now');
      },
    },
  ],
});
