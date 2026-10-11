// Doctors tab — name-only catalog (referred-by source on the bill form).

import db from '../../core/db.js';
import { createCatalogPage } from './catalog.js';

const page = createCatalogPage({
  pageId: 'page-doctors',
  kind: 'doctor',
  tableId: 'doctor-table',
  searchId: 'doctor-search',
  addBtnId: 'doctor-add-btn',
  countId: 'doctors-count',
  emptyId: 'doctors-empty',
  rowClass: 'doctor-row',
  labels: {
    addTitle: 'Add Doctor',
    editTitle: 'Edit Doctor',
    sub: 'Doctor name used in “Referred By”.',
    emptyAll: 'No doctors yet — click "+ Add Doctor" to create one.',
    emptyNone: 'No doctors match your search.',
    confirm: (name) => `Delete doctor "${name}"? This cannot be undone.`,
  },
  api: {
    list: () => db.listDoctors(),
    get: (id) => db.getDoctor(id),
    add: (rec) => db.addDoctor(rec),
    update: (rec) => db.updateDoctor(rec),
    remove: (id) => db.deleteDoctor(id),
  },
});

export const mount = page.mount;
export const unmount = page.unmount;
export const __openModalForTest = page.__openModalForTest;
export const __submitForTest = page.__submitForTest;
