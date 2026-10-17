// Settings modal: company name + default lab/doctor for new bills.
//   openModal('settings') -> 'saved' | null

import db from '../../core/db.js';
import { toast } from '../toast.js';
import { defineModal } from './modal.js';

function fill(node, rows, current) {
  node.replaceChildren();
  const none = document.createElement('option');
  none.value = '';
  none.textContent = '— none —';
  node.appendChild(none);
  for (const r of rows) {
    const o = document.createElement('option');
    o.value = String(r.id);
    o.textContent = r.name;
    node.appendChild(o);
  }
  node.value = current != null ? String(current) : '';
}

defineModal('settings', {
  id: 'settings-dialog',
  title: 'Settings',
  sub: 'Defaults applied to new bills.',
  enterSubmits: true,
  body: () =>
    '<label class="auth-field">Company name (printed on bills) <input id="settings-company" type="text" maxlength="60" placeholder="Lab Name" /></label>' +
    '<label class="auth-field">Address (printed under the name) <input id="settings-address" type="text" maxlength="160" placeholder="Address" /></label>' +
    '<label class="auth-field">Phone (printed under the address) <input id="settings-phone" type="text" maxlength="60" placeholder="Mob No" /></label>' +
    '<label class="auth-field">Default lab (Affiliated By) <select id="settings-default-lab"></select></label>' +
    '<label class="auth-field">Default doctor (Referred By) <select id="settings-default-doctor"></select></label>',
  footer: [
    { label: 'Cancel', onClick: (ctx) => ctx.close(null) },
    {
      label: 'Save',
      id: 'settings-save',
      kind: 'primary',
      async onClick(ctx) {
        const labId = ctx.$('#settings-default-lab').value;
        const docId = ctx.$('#settings-default-doctor').value;
        await db.setDefaultLabId(labId ? Number(labId) : null);
        await db.setDefaultDoctorId(docId ? Number(docId) : null);
        await db.setCompanyName(ctx.$('#settings-company').value);
        await db.setCompanyAddress(ctx.$('#settings-address').value);
        await db.setCompanyPhone(ctx.$('#settings-phone').value);
        toast('Settings saved.', 'ok');
        ctx.close('saved');
      },
    },
  ],
  async onOpen(ctx) {
    const [labs, docs, defLab, defDoc, company, address, phone] = await Promise.all([
      db.listLabs(),
      db.listDoctors(),
      db.getDefaultLabId(),
      db.getDefaultDoctorId(),
      db.getCompanyName(),
      db.getCompanyAddress(),
      db.getCompanyPhone(),
    ]);
    fill(ctx.$('#settings-default-lab'), labs, defLab);
    fill(ctx.$('#settings-default-doctor'), docs, defDoc);
    ctx.$('#settings-company').value = company || '';
    ctx.$('#settings-address').value = address || '';
    ctx.$('#settings-phone').value = phone || '';
    ctx.$('#settings-company').focus();
  },
});
