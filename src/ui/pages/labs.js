// Labs tab — name-only catalog (affiliated-by source on the bill form).

import db from '../../core/db.js';
import { createCatalogPage } from './catalog.js';

const page = createCatalogPage({
  pageId: 'page-labs',
  kind: 'lab',
  tableId: 'lab-table',
  searchId: 'lab-search',
  addBtnId: 'lab-add-btn',
  countId: 'labs-count',
  emptyId: 'labs-empty',
  rowClass: 'lab-row',
  labels: {
    addTitle: 'Add Lab',
    editTitle: 'Edit Lab',
    sub: 'Lab name used in “Affiliated By”.',
    emptyAll: 'No labs yet — click "+ Add Lab" to create one.',
    emptyNone: 'No labs match your search.',
    confirm: (name) => `Delete lab "${name}"? This cannot be undone.`,
  },
  api: {
    list: () => db.listLabs(),
    get: (id) => db.getLab(id),
    add: (rec) => db.addLab(rec),
    update: (rec) => db.updateLab(rec),
    remove: (id) => db.deleteLab(id),
  },
});

export const mount = page.mount;
export const unmount = page.unmount;
export const __openModalForTest = page.__openModalForTest;
export const __submitForTest = page.__submitForTest;
