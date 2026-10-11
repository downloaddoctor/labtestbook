// Generic name-only catalog page (Labs, Doctors). Mirrors tests.js UX:
// row highlight follows keyboard, dialog editor, search filter.
// createCatalogPage(cfg) returns { mount, unmount, ...devhooks }.

import Dialog from '../dialog.js';
import { toast } from '../toast.js';
import { el, bindOff } from '../dom.js';
import { openModal as openModalUI } from '../modals/index.js';
import { initAll, destroyAll, registerAction, unregisterAction } from './listNav.js';

// cfg: { pageId, tableId, searchId, addBtnId, countId, emptyId,
//        rowClass, api, labels:{title,addTitle,editTitle,sub,emptyAll,emptyNone,confirm} }
export function createCatalogPage(cfg) {
  const {
    pageId,
    kind,
    tableId,
    searchId,
    addBtnId,
    countId,
    emptyId,
    rowClass,
    api,
    labels,
  } = cfg;

  let off = null;
  let nav = null;

  const setActiveRow = (i) => nav && nav.setActiveRow(i);
  const clearActiveRow = () => nav && nav.clearActiveRow();

  async function render() {
    const tbody = document.querySelector(`#${tableId} tbody`);
    if (!tbody) return;
    tbody.replaceChildren();
    const q = (el(searchId)?.value || '').toLowerCase();
    const all = await api.list();
    const visible = all.filter((t) => !q || t.name.toLowerCase().includes(q));

    const emptyEl = el(emptyId);
    const countEl = el(countId);
    if (countEl) countEl.textContent = all.length ? `${all.length} item${all.length === 1 ? '' : 's'}` : '';

    if (!visible.length) {
      if (emptyEl) {
        emptyEl.hidden = false;
        emptyEl.textContent = all.length ? labels.emptyNone : labels.emptyAll;
      }
      if (nav) nav.clearActiveRow();
      return;
    }
    if (emptyEl) emptyEl.hidden = true;

    const defaultId = api.getDefaultId ? await api.getDefaultId() : null;

    visible.forEach((item, i) => {
      const tr = document.createElement('tr');
      tr.className = `row-click ${rowClass}`;
      tr.dataset.id = String(item.id);
      tr.dataset.index = String(i);
      tr.setAttribute('role', 'button');
      tr.setAttribute('aria-label', `${item.name} — click to edit`);
      if (nav && i === nav.getActive()) tr.classList.add('active');
      const tdName = document.createElement('td');
      tdName.textContent = item.name;
      const isDefault = defaultId != null && String(defaultId) === String(item.id);
      if (isDefault) {
        const tag = document.createElement('span');
        tag.className = 'tag-default';
        tag.textContent = 'default';
        tdName.appendChild(tag);
      }
      tr.appendChild(tdName);
      const tdV = document.createElement('td');
      tdV.className = 'col-ver';
      tdV.textContent = 'v' + (item.v || 1);
      tr.appendChild(tdV);

      if (api.setDefaultId) {
        const tdDef = document.createElement('td');
        tdDef.className = 'col-default';
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'default-toggle' + (isDefault ? ' on' : '');
        btn.textContent = isDefault ? 'Default ✓' : 'Set default';
        btn.setAttribute('aria-pressed', isDefault ? 'true' : 'false');
        btn.addEventListener('click', async (e) => {
          e.stopPropagation();
          await api.setDefaultId(isDefault ? null : item.id);
          await render();
        });
        tdDef.appendChild(btn);
        tr.appendChild(tdDef);
      }
      tbody.appendChild(tr);
    });
  }

  async function confirmDelete(id, name) {
    const ok = await Dialog.confirm(labels.confirm(name), {
      danger: true,
      okLabel: 'Delete',
      title: 'Delete',
    });
    if (!ok) return;
    await api.remove(id);
    await render();
  }

  async function openModal(id) {
    await openModalUI('catalogEdit', {
      kind,
      id,
      labels,
      api,
      onDelete: (delId, name) => confirmDelete(delId, name),
    });
    await render();
    const s = el(searchId);
    if (s) s.focus();
  }

  function wireList() {
    off.on(el(searchId), 'input', () => {
      if (nav) nav.clearActiveRow();
      render();
    });
    off.on(el(addBtnId), 'click', () => openModal());
    const tbody = document.querySelector(`#${tableId} tbody`);
    off.on(tbody, 'click', (e) => {
      if (e.target.closest('button')) return;
      const tr = e.target.closest(`tr.${rowClass}`);
      if (!tr) return;
      setActiveRow(Number(tr.dataset.index));
      openModal(Number(tr.dataset.id));
    });
  }

  // (nav is wired declaratively via initAll; see mount/unmount.)

  return {
    async mount() {
      off = bindOff();
      wireList();
      registerAction(pageId + '-enter', (row) => openModal(Number(row.dataset.id)));
      registerAction(pageId + '-delete', (row) =>
        confirmDelete(Number(row.dataset.id), row.cells[0] ? row.cells[0].textContent : '')
      );
      registerAction(pageId + '-history', (row) =>
        import('../revisions.js').then(({ openRevisions }) => openRevisions(kind, Number(row.dataset.id)))
      );
      await render();
      nav = initAll(document.getElementById(pageId))[0] || null;
      if (nav) nav.clearActiveRow();
      const s = el(searchId);
      if (s) s.focus();
    },
    unmount() {
      if (off) off.off();
      off = null;
      unregisterAction(pageId + '-enter');
      unregisterAction(pageId + '-delete');
      unregisterAction(pageId + '-history');
      destroyAll();
      nav = null;
    },
    // ---- DEV/TEST hooks ----
    // Use the LOCAL openModal(id) helper (it re-renders the page after the
    // modal closes). Do not await it — the returned promise resolves on
    // dialog close and would block the test run.
    async __openModalForTest(id = null) {
      // eslint-disable-next-line no-floating-promises
      openModal(id);
      await new Promise((r) => setTimeout(r, 30));
    },
    // The modal body is now generated (src/ui/modals/catalogEdit.js) and has
    // no <form id="catalog-edit-form">; click the real Save button.
    async __submitForTest() {
      const btn = el('modal-catalog-save-btn');
      if (btn) btn.click();
      await new Promise((r) => setTimeout(r, 220));
    },
  };
}
