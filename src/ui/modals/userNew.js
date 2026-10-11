// New-user modal.
//   openModal('userNew', { onCreate: async ({ username, password, role }) => void }) -> 'created' | null
// onCreate may throw; its message is shown inside the modal and it stays open.

import { showError } from '../dom.js';
import { defineModal } from './modal.js';

defineModal('userNew', {
  id: 'user-new-dialog',
  title: 'New user',
  sub: 'Create a user or admin account.',
  body: () =>
    '<form id="user-new-form" autocomplete="off">' +
    '<label class="auth-field">Username <input id="user-new-name" type="text" maxlength="40" autocomplete="off" required /></label>' +
    '<label class="auth-field">Role <select id="user-new-role">' +
    '<option value="user">User (no Users)</option>' +
    '<option value="admin">Admin (full access + manage users)</option></select></label>' +
    '<label class="auth-field">Password <input id="user-new-pass" type="password" minlength="4" autocomplete="off" required /></label>' +
    '<label class="auth-field">Confirm password <input id="user-new-pass2" type="password" minlength="4" autocomplete="off" required /></label>' +
    '<p id="user-new-err" class="auth-error" hidden></p></form>',
  footer: [
    { label: 'Cancel', onClick: (ctx) => ctx.close(null) },
    {
      label: 'Create',
      kind: 'primary',
      onClick: (ctx) => ctx.$('#user-new-form').requestSubmit(),
    },
  ],
  onOpen(ctx) {
    const form = ctx.$('#user-new-form');
    const err = ctx.$('#user-new-err');
    showError(err);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      showError(err);
      const name = ctx.$('#user-new-name').value;
      const p1 = ctx.$('#user-new-pass').value;
      const p2 = ctx.$('#user-new-pass2').value;
      const role = ctx.$('#user-new-role').value;
      if (!name.trim()) return showError(err, 'Username is required.');
      if (p1.length < 4) return showError(err, 'Password must be at least 4 characters.');
      if (p1 !== p2) return showError(err, 'Passwords do not match.');
      try {
        await ctx.data.onCreate({ username: name, password: p1, role });
        ctx.close('created');
      } catch (e2) {
        showError(err, e2 && e2.message ? e2.message : String(e2));
      }
    });
    ctx.$('#user-new-name').focus();
  },
});
