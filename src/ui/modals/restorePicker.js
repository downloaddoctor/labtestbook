// Backup picker modal.
//   openModal('restorePicker', { sub, groups: [{ title, items: [{ value, name, version, when, pills[], note }] }] })
//   -> the chosen item's value | null

import { defineModal } from './modal.js';

defineModal('restorePicker', {
  id: 'restore-picker',
  title: 'Choose a backup to restore',
  sub: (d) => d.sub || '',
  body(d, ctx) {
    const list = document.createElement('div');
    list.className = 'hx-list';
    let total = 0;
    for (const g of d.groups || []) {
      if (!g.items.length) continue;
      const h = document.createElement('div');
      h.className = 'hx-group';
      h.textContent = g.title;
      list.appendChild(h);
      for (const it of g.items) {
        total++;
        const item = document.createElement('div');
        item.className = 'hx-item';
        item.tabIndex = -1;
        item.setAttribute('role', 'button');
        const dot = document.createElement('div');
        dot.className = 'hx-dot';
        const body = document.createElement('div');
        body.className = 'hx-body';
        const head = document.createElement('div');
        head.className = 'hx-head';
        const n = document.createElement('span');
        n.className = 'hx-date';
        n.textContent = it.name;
        const v = document.createElement('span');
        v.className = 'hx-badge';
        v.textContent = it.version || '\u2014';
        const w = document.createElement('span');
        w.className = 'hx-time';
        w.textContent = it.when || '?';
        head.append(n, v, w);
        const meta = document.createElement('div');
        meta.className = 'hx-meta picker-models';
        if (it.pills && it.pills.length) {
          for (const t of it.pills) {
            const p = document.createElement('span');
            p.className = 'pill';
            p.textContent = t;
            meta.appendChild(p);
          }
        } else meta.textContent = it.note || '';
        body.append(head, meta);
        item.append(dot, body);
        item.addEventListener('click', () => ctx.close(it.value));
        list.appendChild(item);
      }
    }
    if (!total) {
      const p = document.createElement('p');
      p.className = 'hint';
      p.textContent = 'No backup files in this folder.';
      list.appendChild(p);
    }
    return list;
  },
  footer: [{ label: 'Cancel', onClick: (ctx) => ctx.close(null) }],
});
