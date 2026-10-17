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

function selText(node) {
  const o = node.options[node.selectedIndex];
  return o && o.value ? o.textContent : '';
}

function selByText(node, text) {
  const t = String(text || '').trim().toLowerCase();
  if (!t) return false;
  for (const o of node.options) {
    if (o.value && o.textContent.trim().toLowerCase() === t) {
      node.value = o.value;
      return true;
    }
  }
  return false;
}

function exportSettings(ctx) {
  const data = {
    app: 'labtestbook-settings',
    v: 1,
    companyName: ctx.$('#settings-company').value.trim(),
    subHeading: ctx.$('#settings-address').value.trim(),
    defaultLab: selText(ctx.$('#settings-default-lab')),
    defaultDoctor: selText(ctx.$('#settings-default-doctor')),
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'labtestbook-settings.json';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  toast('Settings exported.', 'ok');
}

function importSettings(ctx) {
  const inp = document.createElement('input');
  inp.type = 'file';
  inp.accept = 'application/json,.json';
  inp.onchange = async () => {
    const f = inp.files && inp.files[0];
    if (!f) return;
    try {
      const d = JSON.parse(await f.text());
      if (!d || d.app !== 'labtestbook-settings') throw new Error('bad file');
      ctx.$('#settings-company').value = String(d.companyName || '').slice(0, 60);
      ctx.$('#settings-address').value = String(d.subHeading || '').slice(0, 300);
      const labOk = selByText(ctx.$('#settings-default-lab'), d.defaultLab);
      const docOk = selByText(ctx.$('#settings-default-doctor'), d.defaultDoctor);
      const miss = (d.defaultLab && !labOk) || (d.defaultDoctor && !docOk);
      toast(miss ? 'Imported. Some default lab/doctor names were not found. Click Save to apply.' : 'Imported. Click Save to apply.', miss ? 'warn' : 'ok');
    } catch {
      toast('Not a valid settings file.', 'err');
    }
  };
  inp.click();
}

defineModal('settings', {
  id: 'settings-dialog',
  title: 'Settings',
  sub: 'Defaults applied to new bills.',
  enterSubmits: true,
  body: () =>
    '<label class="auth-field">Company name (printed on bills) <input id="settings-company" type="text" maxlength="60" placeholder="Lab Name" /></label>' +
    '<label class="auth-field">Sub heading (printed under the name; Enter = new line; &lt;b&gt; &lt;i&gt; &lt;em&gt; &lt;u&gt; allowed) <textarea id="settings-address" rows="4" maxlength="300" placeholder="Address, phone, tagline..."></textarea></label>' +
    '<label class="auth-field">Default lab (Affiliated By) <select id="settings-default-lab"></select></label>' +
    '<label class="auth-field">Default doctor (Referred By) <select id="settings-default-doctor"></select></label>',
  footer: [
    { label: 'Export', id: 'settings-export', onClick: (ctx) => exportSettings(ctx) },
    { label: 'Import', id: 'settings-import', onClick: (ctx) => importSettings(ctx) },
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
        toast('Settings saved.', 'ok');
        ctx.close('saved');
      },
    },
  ],
  async onOpen(ctx) {
    const [labs, docs, defLab, defDoc, company, address] = await Promise.all([
      db.listLabs(),
      db.listDoctors(),
      db.getDefaultLabId(),
      db.getDefaultDoctorId(),
      db.getCompanyName(),
      db.getCompanyAddress(),
    ]);
    fill(ctx.$('#settings-default-lab'), labs, defLab);
    fill(ctx.$('#settings-default-doctor'), docs, defDoc);
    ctx.$('#settings-company').value = company || '';
    ctx.$('#settings-address').value = address || '';
    ctx.$('#settings-company').focus();
  },
});
