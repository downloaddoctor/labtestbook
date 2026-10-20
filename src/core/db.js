// IndexedDB wrapper (Dexie). DB 'labtestbook'. Schema v1.
//
// Model: revisioned, append-only entities + a projection table per entity.
//   people      — append-only identity revisions, keyed [id+v]. TRUTH.
//   peopleProj  — one row per id. Current identity + list/search index.
//   bills       — append-only bill revisions, keyed [id+v]. TRUTH.
//   billsProj   — one row per id. Current bill + list/day index.
//   tests/labs/doctors       — current-state catalog rows (soft-delete via hid).
//   testRevs/labRevs/doctorRevs — append-only catalog revisions, keyed [id+v].
//   users       — the current user row (secrets live ONLY here).
//   userRevs    — append-only user revisions (audit; no secrets).
//
// v1 uses SHORT col keys everywhere (log and DB): id, v, hid, crtAt, revAt,
// uId, uV, labId, labV, docId, docV, pId, pV, sell, buy, disc_amt.
//
// Invariants:
//   * Writes append a revision AND put the projection row, in the SAME tx.
//   * Revision rows are never mutated; projection rows are mutated freely.
//   * `_addBillImpl` is the ONLY bill write path; live and restore use it.
//   * `hid` is soft-delete; projections filter hidden rows out.
//   * Names are stored UPPERCASE in place (no name_upper column).
//   * rebuildProj() recovers projections from revisions. Idempotent.
//   * crtAt / revAt are epoch-milliseconds in the DB; seconds in the log.

import Dexie from 'https://unpkg.com/dexie@4.0.11/dist/modern/dexie.mjs';
import { APP_VERSION } from './version.js';
import Store from './store.js';
import { normName } from './norm.js';
import { readMethods } from './db.reads.js';
import { writeMethods } from './db.write.js';
import { isNoop } from './diff.js';
import { exportMethods } from './db.export.js';
import { restoreMethods } from './db.restore.js';
import { journalMethods } from './db.journal.js';
import { ledgerMethods, billEvents } from './db.ledger.js';
import { paymentMethods } from './db.payments.js';
import { deriveMethods } from './db.derive.js';

const DB_NAME = 'labtestbook';

export const PREFS = new Store('defaults');

class DB {
  constructor() {
    this._dbName = DB_NAME;
    this._db = new Dexie(this._dbName);
    this._declareSchema(this._db);
    this._openPromise = null;
    this._journal = null;
    this._journalBuffers = new Map();
    this._actorFn = null;
    this._testsCache = null;
    this._labsCache = null;
    this._doctorsCache = null;
  }

  _declareSchema(instance) {
    // v1: short col keys; catalogs are revisioned (current-state + *Revs).
    instance.version(1).stores({
      tests: '++id, name, hid',
      labs: '++id, name, hid',
      doctors: '++id, name, hid',
      testRevs: '[id+v], id, v',
      labRevs: '[id+v], id, v',
      doctorRevs: '[id+v], id, v',
      users: '++id, &username, role, disabled',
      userRevs: '[id+v], id, v',
      bills: '[id+v], id, v, pId, uId',
      billsProj: 'id, pId, crtAt, hid, [pId+crtAt]',
      people: '[id+v], id, v, [name+mob], uId',
      peopleProj: 'id, name, mob, [name+mob], lastBillAt, hid',
      meta: 'key',
    });
    // v2: add peopleProj.pending (outstanding ₹ per person, projection-only).
    // Backfill from billsProj so existing rows get a value without a rebuild.
    instance.version(2).stores({
      peopleProj: 'id, name, mob, [name+mob], lastBillAt, pending, hid',
    }).upgrade(async (tx) => {
      const bills = await tx.table('billsProj').toArray();
      const dueByPerson = new Map();
      for (const b of bills) {
        if (b.hid) continue;
        if (Number(b.payment) !== 0) continue;
        const amt = Number(b.cust_payable != null ? b.cust_payable : b.cust_total) || 0;
        const pid = Number(b.pId);
        dueByPerson.set(pid, (dueByPerson.get(pid) || 0) + amt);
      }
      await tx.table('peopleProj').toCollection().modify((p) => {
        p.pending = dueByPerson.get(Number(p.id)) || 0;
      });
    });

    // v3: Add ledger table for O(E) indexed reads instead of O(N) full scans.
    instance.version(3).stores({
      ledger: '[pId+at], at, billId, kind, cashDelta, receivableDelta, merchantDelta'
    }).upgrade(async (tx) => {
      const bills = await tx.table('bills').toArray();
      const byBill = new Map();
      for (const r of bills) {
        if (!byBill.has(r.id)) byBill.set(r.id, []);
        byBill.get(r.id).push(r);
      }
      for (const [id, revs] of byBill) {
        const pId = revs[0] ? revs[0].pId : null;
        const events = billEvents(pId, revs);
        for (const e of events) {
          await tx.table('ledger').add({
            pId: e.pId,
            at: e.at,
            billId: e.billId,
            kind: e.kind,
            cashDelta: e.cashDelta,
            receivableDelta: e.receivableDelta,
            merchantDelta: e.merchantDelta || 0
          });
        }
      }
    });

    // v4: Add [hid+crtAt] compound index for O(K) bill queries (skip in-memory hid filtering).
    instance.version(4).stores({
      billsProj: 'id, pId, crtAt, hid, [pId+crtAt], [hid+crtAt]'
    }).upgrade(async (tx) => {
      // Dexie automatically rebuilds the new index; no data migration needed.
    });

    // v5: drop the ledger table. Its primary key [pId+at] was unique, so two
    // events for one person in the same millisecond threw a ConstraintError.
    // Dexie cannot change a primary key in place, so delete then recreate.
    instance.version(5).stores({ ledger: null });

    // v6: recreate ledger with a surrogate auto-increment key; rebuild from bills.
    instance.version(6).stores({
      ledger: '++id, [pId+at], at, billId, kind'
    }).upgrade(async (tx) => {
      const bills = await tx.table('bills').toArray();
      const byBill = new Map();
      for (const r of bills) {
        if (!byBill.has(r.id)) byBill.set(r.id, []);
        byBill.get(r.id).push(r);
      }
      for (const [, revs] of byBill) {
        const pId = revs[0] ? revs[0].pId : null;
        for (const e of billEvents(pId, revs)) {
          await tx.table('ledger').add({
            pId: e.pId,
            at: e.at,
            billId: e.billId,
            kind: e.kind,
            cashDelta: e.cashDelta,
            receivableDelta: e.receivableDelta,
            merchantDelta: e.merchantDelta || 0
          });
        }
      }
    });

    // v7: family heads + part payments. people revisions gain headId (null =
    // own head); peopleProj indexes it. payments = money received by a head
    // (negative amount = correction/refund). allocations = how a payment is
    // split across bills. Both are append-only; ids are explicit on restore.
    instance.version(7).stores({
      peopleProj: 'id, name, mob, [name+mob], lastBillAt, pending, hid, headId',
      payments: '++id, headId, at',
      allocations: '++id, paymentId, billId'
    });

    // v8: ledger is fully derived (see db.derive.js). Add a pId index so a
    // person's rows can be replaced in one indexed delete.
    instance.version(8).stores({
      ledger: '++id, pId, [pId+at], at, billId, kind, payId'
    });

    // v9: indexed reads for whole-lab views (no toArray() full scans).
    instance.version(9).stores({
      billsProj: 'id, pId, crtAt, hid, [pId+crtAt], [hid+crtAt], [hid+payment]',
      allocations: '++id, paymentId, billId, [billId+ak]',
      peopleProj: 'id, name, mob, [name+mob], lastBillAt, pending, hid, headId, [hid+lastBillAt], [hid+pending], [hid+name]',
    });

    // v10: bill delete requests (plain users ask, admin approves/rejects).
    // status: 0 pending, 1 approved, 2 rejected. Workflow data, not a revision fact.
    instance.version(10).stores({
      delReqs: '++id, billId, status, at',
    });
  }

  get APP_VERSION() {
    return APP_VERSION;
  }

  // ---- test/DB switching (used by dev/selftest.js) ----
  async setDbName(name) {
    if (!name || name === this._dbName) return;
    try { this._db.close(); } catch (_) { }
    this._dbName = name;
    this._db = new Dexie(name);
    this._declareSchema(this._db);
    this._openPromise = null;
    this._testsCache = null;
    this._labsCache = null;
    this._doctorsCache = null;
  }
  async deleteDb() {
    try { this._db.close(); } catch (_) { }
    await Dexie.delete(this._dbName);
    this._openPromise = null;
  }

  get raw() {
    return this._db;
  }

  openDb() {
    if (!this._openPromise) {
      this._openPromise = this._db.open().catch(async (err) => {
        // Fresh-start policy: a DB from an older schema can't upgrade in place.
        // Wipe + recreate (no prod data).
        if (err && (err.name === 'VersionError' || err.name === 'UpgradeError')) {
          console.warn('[labtestbook] incompatible schema — dumping then recreating');
          try {
            this._db.close();
          } catch (_) { }
          await new Promise((r) => setTimeout(r, 50));
          let dumpInfo = null;
          try {
            dumpInfo = await this._dumpRawDbToFile(this._dbName);
          } catch (dumpErr) {
            console.error('[labtestbook] pre-wipe backup failed', dumpErr);
            throw dumpErr;
          }
          if (dumpInfo) {
            try {
              const { toast } = await import('../ui/toast.js');
              toast('Old database backed up → ' + dumpInfo.filename + '. Starting fresh.', 'warn');
            } catch (_) { }
            console.info('[labtestbook] pre-wipe backup saved:', dumpInfo.filename);
          }
          await Dexie.delete(this._dbName);
          this._db = new Dexie(this._dbName);
          this._declareSchema(this._db);
          await this._db.open();
          return;
        }
        throw err;
      });
    }
    return this._openPromise;
  }

  _dumpRawDbToFile(name) {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(name);
      req.onerror = () => reject(req.error || new Error('indexedDB.open failed'));
      req.onupgradeneeded = () => {
        if (req.transaction) req.transaction.abort();
      };
      req.onsuccess = () => {
        const raw = req.result;
        const storeNames = Array.from(raw.objectStoreNames);
        if (!storeNames.length) {
          raw.close();
          return resolve(null);
        }
        const dump = {};
        const tx = raw.transaction(storeNames, 'readonly');
        let pending = storeNames.length;
        tx.onerror = () => reject(tx.error || new Error('dump tx failed'));
        for (const sn of storeNames) {
          const store = tx.objectStore(sn);
          const all = store.getAll();
          all.onsuccess = () => {
            dump[sn] = all.result || [];
            if (--pending === 0) {
              raw.close();
              const payload = {
                db: name,
                dumpedAt: new Date().toISOString(),
                stores: dump,
              };
              const filename = 'labtestbook-dump-' + Date.now() + '.json';
              try {
                const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = filename;
                document.body.appendChild(a);
                a.click();
                a.remove();
                setTimeout(() => URL.revokeObjectURL(url), 4000);
              } catch (e) {
                reject(e);
                return;
              }
              resolve({ filename, stores: storeNames });
            }
          };
          all.onerror = () => reject(all.error || new Error('dump store failed: ' + sn));
        }
      };
    });
  }

  // ---- actor ----
  setActor(fn) {
    this._actorFn = typeof fn === 'function' ? fn : null;
  }
  _actor() {
    if (!this._actorFn) return { uId: null, uV: null };
    try {
      const a = this._actorFn();
      return {
        uId: a && a.uId != null ? a.uId : null,
        uV: a && a.uV != null ? a.uV : null,
      };
    } catch (_) {
      return { uId: null, uV: null };
    }
  }

  // ---- catalogs (tests/labs/doctors) ----
  // Current-state tables project the newest *Revs row. Deletes are soft
  // (hid=1); id is the stable ++id. Every write appends one revision.
  // Catalog store -> its revision store (irregular: tests -> testRevs).
  _revsFor(table) {
    if (table === 'tests') return this._db.testRevs;
    if (table === 'labs') return this._db.labRevs;
    if (table === 'doctors') return this._db.doctorRevs;
    return this._db[table + 'Revs'];
  }
  async _appendCatalogRev(table, id, patch, { log = true, crtAt } = {}) {
    const revs = this._revsFor(table);
    const last = await revs
      .where('[id+v]')
      .between([id, Dexie.minKey], [id, Dexie.maxKey])
      .last();
    const v = last ? last.v + 1 : 1;
    const a = this._actor();
    const rev = {
      id,
      v,
      ...patch,
      hid: patch.hid ? 1 : 0,
      crtAt: last ? last.crtAt : crtAt || Date.now(),
      revAt: new Date().toISOString(),
      uId: a.uId,
      uV: a.uV,
    };
    await revs.add(rev);
    // Mirror the current revision number onto the projection row so list views
    // can show the version without a per-row revs lookup. Rebuildable.
    await this._db[table].update(id, { v });
    if (log) this._emitJournal({ kind: table, ...rev });
    return rev;
  }

  async _listCatalog(table) {
    const cacheKey = '_' + table + 'Cache';
    if (this[cacheKey]) return this[cacheKey];
    const rows = await this._db[table].orderBy('name').toArray();
    const visible = rows.filter((r) => !r.hid);
    this[cacheKey] = visible;
    return visible;
  }

  // ---- tests ----
  listTests() {
    return this._listCatalog('tests');
  }
  _invalidateTests() {
    this._testsCache = null;
  }
  getTest(id) {
    return this._db.tests.get(Number(id));
  }
  async addTest({ name, sell, buy, code, sample, info, tat }) {
    const s = (v) => (v == null ? '' : String(v).trim());
    const rec = {
      name: normName(name),
      sell: Number(sell) || 0,
      buy: Number(buy) || 0,
      code: s(code),
      sample: s(sample),
      info: s(info),
      tat: s(tat),
      hid: 0,
    };
    const id = await this._db.tests.add(rec);
    await this._appendCatalogRev('tests', id, rec, { crtAt: Date.now() });
    this._invalidateTests();
    return { ...rec, id };
  }
  async updateTest({ id, name, sell, buy, code, sample, info, tat }) {
    const cur = await this._db.tests.get(Number(id));
    // undefined = keep the stored value; anything else replaces it.
    const keep = (v, k) => (v === undefined ? (cur && cur[k]) || '' : v == null ? '' : String(v).trim());
    const patch = {
      name: normName(name),
      sell: Number(sell) || 0,
      buy: Number(buy) || 0,
      code: keep(code, 'code'),
      sample: keep(sample, 'sample'),
      info: keep(info, 'info'),
      tat: keep(tat, 'tat'),
      hid: 0,
    };
    if (cur && isNoop(cur, patch, ['name', 'sell', 'buy', 'code', 'sample', 'info', 'tat'])) return { ...cur, id: Number(id) };
    await this._db.tests.update(Number(id), patch);
    await this._appendCatalogRev('tests', Number(id), patch);
    this._invalidateTests();
    return { ...patch, id: Number(id) };
  }
  async deleteTest(id) {
    const n = Number(id);
    await this._db.tests.update(n, { hid: 1 });
    await this._appendCatalogRev('tests', n, { hid: 1 });
    this._invalidateTests();
  }

  // ---- labs ----
  listLabs() {
    return this._listCatalog('labs');
  }
  _invalidateLabs() {
    this._labsCache = null;
  }
  getLab(id) {
    return this._db.labs.get(Number(id));
  }
  async addLab({ name }) {
    const rec = { name: normName(name), hid: 0 };
    const id = await this._db.labs.add(rec);
    await this._appendCatalogRev('labs', id, rec, { crtAt: Date.now() });
    this._invalidateLabs();
    return { ...rec, id };
  }
  async updateLab({ id, name }) {
    const patch = { name: normName(name), hid: 0 };
    const cur = await this._db.labs.get(Number(id));
    if (cur && isNoop(cur, patch, ['name'])) return { ...cur, id: Number(id) };
    await this._db.labs.update(Number(id), patch);
    await this._appendCatalogRev('labs', Number(id), patch);
    this._invalidateLabs();
    return { ...patch, id: Number(id) };
  }
  async deleteLab(id) {
    const n = Number(id);
    await this._db.labs.update(n, { hid: 1 });
    await this._appendCatalogRev('labs', n, { hid: 1 });
    this._invalidateLabs();
  }

  // ---- doctors ----
  listDoctors() {
    return this._listCatalog('doctors');
  }
  _invalidateDoctors() {
    this._doctorsCache = null;
  }
  getDoctor(id) {
    return this._db.doctors.get(Number(id));
  }
  async addDoctor({ name }) {
    const rec = { name: normName(name), hid: 0 };
    const id = await this._db.doctors.add(rec);
    await this._appendCatalogRev('doctors', id, rec, { crtAt: Date.now() });
    this._invalidateDoctors();
    return { ...rec, id };
  }
  async updateDoctor({ id, name }) {
    const patch = { name: normName(name), hid: 0 };
    const cur = await this._db.doctors.get(Number(id));
    if (cur && isNoop(cur, patch, ['name'])) return { ...cur, id: Number(id) };
    await this._db.doctors.update(Number(id), patch);
    await this._appendCatalogRev('doctors', Number(id), patch);
    this._invalidateDoctors();
    return { ...patch, id: Number(id) };
  }
  async deleteDoctor(id) {
    const n = Number(id);
    await this._db.doctors.update(n, { hid: 1 });
    await this._appendCatalogRev('doctors', n, { hid: 1 });
    this._invalidateDoctors();
  }

  // ---- defaults ----
  getDefaultLabId() {
    return Promise.resolve(PREFS.num('labId'));
  }
  setDefaultLabId(id) {
    PREFS.set('labId', id != null ? Number(id) : null);
    return Promise.resolve();
  }
  getDefaultDoctorId() {
    return Promise.resolve(PREFS.num('doctorId'));
  }
  setDefaultDoctorId(id) {
    PREFS.set('doctorId', id != null ? Number(id) : null);
    return Promise.resolve();
  }
  getCompanyName() {
    return Promise.resolve(PREFS.get('companyName') || '');
  }
  setCompanyName(name) {
    PREFS.set('companyName', name ? String(name).trim() : '');
    return Promise.resolve();
  }
  getCompanyAddress() {
    return Promise.resolve(PREFS.get('companyAddress') || '');
  }
  setCompanyAddress(v) {
    PREFS.set('companyAddress', v ? String(v).trim() : '');
    return Promise.resolve();
  }

  // ---- user revisions (auth) ----
  async appendUserRevision(user, { log = true } = {}) {
    const id = Number(user.id);
    if (!id) throw new Error('appendUserRevision requires a numeric id');
    const last = await this._db.userRevs
      .where('[id+v]')
      .between([id, Dexie.minKey], [id, Dexie.maxKey])
      .last();
    const v = last ? last.v + 1 : 1;
    const rev = {
      id,
      v,
      username: normName(user.username),
      role: user.role === 'admin' ? 'admin' : 'user',
      disabled: user.disabled ? 1 : 0,
      crtAt: user.crtAt || user.createdAt || new Date().toISOString(),
      revAt: new Date().toISOString(),
    };
    await this._db.userRevs.add(rev);
    if (log) this._emitJournal({ kind: 'user', ...rev });
    return rev;
  }
}

Object.assign(
  DB.prototype,
  readMethods,
  writeMethods,
  exportMethods,
  restoreMethods,
  journalMethods,
  ledgerMethods,
  paymentMethods,
  deriveMethods
);

const db = new DB();
export default db;
