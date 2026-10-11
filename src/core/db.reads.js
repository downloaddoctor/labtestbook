// Reads: current state comes from the projection tables (billsProj /
// peopleProj). The revision tables (bills / people) hold the audit history.
//
// v1: all keys are short (id, pId, pV, hid, crtAt, uId, uV, labId, labV,
// docId, docV, disc_amt, sell, buy). Bill items are pins {itemId,itemV,hid}.
// hydrateBill() joins pins to testRevs so callers get name+sell+buy without
// walking the rev table themselves.

import Dexie from 'https://unpkg.com/dexie@4.0.11/dist/modern/dexie.mjs';
import { normName } from './norm.js';
import { PAYMENT } from './enums.js';

// entity -> append-only revision store (all keyed [id+v]).
const REV_STORE = {
  bill: 'bills',
  person: 'people',
  test: 'testRevs',
  lab: 'labRevs',
  doctor: 'doctorRevs',
  user: 'userRevs',
};

// Fetch a specific testRevs row.
function getTestRev(db, itemId, itemV) {
  if (itemId == null || itemV == null) return Promise.resolve(null);
  return db.testRevs.get([Number(itemId), Number(itemV)]);
}

export const readMethods = {
  // ---- bills ----
  getBill(id) {
    if (id == null) return Promise.resolve(null);
    return this._db.billsProj.get(Number(id));
  },

  async getNextBillNo() {
    const top = await this._db.billsProj.orderBy('id').last();
    if (top && Number.isInteger(top.id) && top.id > 0) return top.id + 1;
    return 1;
  },

  // Join a bill's item pins to testRevs. Returns a shallow copy of the bill
  // with items[] = [{itemId,itemV,hid,name,sell,buy}] (hydrated).
  async hydrateBill(bill) {
    if (!bill) return null;
    const pins = Array.isArray(bill.items) ? bill.items : [];
    const items = [];
    for (const p of pins) {
      const rev = await getTestRev(this._db, p.itemId, p.itemV);
      items.push({
        itemId: Number(p.itemId),
        itemV: Number(p.itemV),
        hid: p.hid ? 1 : 0,
        name: rev ? rev.name : '(deleted)',
        sell: rev ? Number(rev.sell) || 0 : 0,
        buy: rev ? Number(rev.buy) || 0 : 0,
      });
    }
    return { ...bill, items };
  },

  // Resolve a bill's lab/doc/person display names for print + list.
  async hydrateBillRefs(bill) {
    if (!bill) return null;
    const db = this._db;
    const lab = bill.labId ? await db.labs.get(Number(bill.labId)) : null;
    const doc = bill.docId ? await db.doctors.get(Number(bill.docId)) : null;
    const person = bill.pId ? await db.peopleProj.get(Number(bill.pId)) : null;
    return {
      ...bill,
      labName: lab ? lab.name : '',
      docName: doc ? doc.name : '',
      person: person || null,
    };
  },

  async getBillsPage({ offset = 0, limit = 50, filter = {} } = {}) {
    const idRaw = String(filter.billNo || filter.id || '').trim();
    const idNum = idRaw && /^\d+$/.test(idRaw) ? Number(idRaw) : null;
    const nameLower = (filter.name || filter.customerName || '').toLowerCase();
    const fromMs = Number.isFinite(filter.from) ? filter.from : null;
    const toMs = Number.isFinite(filter.to) ? filter.to : null;
    const db = this._db;

    if (idNum != null && !nameLower) {
      const hit = await db.billsProj.get(idNum);
      const t = hit ? (hit.crtAt || 0) : 0;
      const inRange = hit && !hit.hid && (fromMs == null || t >= fromMs) && (toMs == null || t <= toMs);
      return { results: inRange ? [hit] : [], total: inRange ? 1 : 0 };
    }

    let nameMatchIds = null;
    if (nameLower) {
      const nameUpper = nameLower.toUpperCase();
      // O(log P + M) using 'name' index instead of O(P) full scan + includes()
      const people = await db.peopleProj.where('name').startsWith(nameUpper).toArray();
      nameMatchIds = new Set(people.map((p) => p.id));
    }

    let collection;
    const hid = 0;
    if (fromMs != null && toMs != null) {
      collection = db.billsProj.where('[hid+crtAt]').between([hid, fromMs], [hid, toMs]);
    } else if (fromMs != null) {
      collection = db.billsProj.where('[hid+crtAt]').aboveOrEqual([hid, fromMs]);
    } else if (toMs != null) {
      collection = db.billsProj.where('[hid+crtAt]').belowOrEqual([hid, toMs]);
    } else {
      collection = db.billsProj.orderBy('crtAt').filter((b) => !b.hid);
    }

    const all = await collection.reverse().toArray();
    const matched = all.filter((b) => {
      const okId = !idRaw || String(b.id || '').includes(idRaw);
      const okName = !nameLower || (nameMatchIds && nameMatchIds.has(b.pId));
      return okId && okName;
    });

    return { results: matched.slice(offset, offset + limit), total: matched.length };
  },

  async getBillsInRange(fromMs, toMs) {
    const from = Number.isFinite(fromMs) ? fromMs : null;
    const to = Number.isFinite(toMs) ? toMs : null;
    const db = this._db;

    let collection;
    const hid = 0;
    if (from != null && to != null) {
      collection = db.billsProj.where('[hid+crtAt]').between([hid, from], [hid, to]);
    } else if (from != null) {
      collection = db.billsProj.where('[hid+crtAt]').aboveOrEqual([hid, from]);
    } else if (to != null) {
      collection = db.billsProj.where('[hid+crtAt]').belowOrEqual([hid, to]);
    } else {
      collection = db.billsProj.orderBy('crtAt').filter((b) => !b.hid);
    }

    return collection.reverse().toArray();
  },

  summarizeBills(bills, allocMap) {
    let partial = 0;
    let paid = 0;
    let unpaid = 0;
    let cash = 0;
    let upi = 0;
    let unpaidTotal = 0;
    let total = 0;
    let custTotal = 0;
    let merchTotal = 0;
    for (const b of bills || []) {
      const amt = Number(b.cust_payable != null ? b.cust_payable : b.cust_total) || 0;
      total += amt;
      custTotal += Number(b.cust_total) || 0;
      merchTotal += Number(b.merch_total) || 0;
      const p = Number(b.payment);
      if (p === PAYMENT.UNPAID) {
        const got = allocMap ? Math.min(amt, allocMap.get(b.id) || 0) : 0;
        partial += got;
        if (amt - got > 0.004) {
          unpaid += 1;
          unpaidTotal += amt - got;
        } else {
          paid += 1;
        }
      } else {
        paid += 1;
        if (p === PAYMENT.UPI) upi += amt;
        else cash += amt;
      }
    }
    const grossProfit = total - merchTotal;
    const netProfit = grossProfit - unpaidTotal;
    return {
      count: (bills || []).length, paid, unpaid, cash, upi, partial, unpaidTotal, total,
      custTotal, merchTotal, grossProfit, netProfit,
    };
  },

  // Open (unpaid) bills with due>0. Optionally scoped to one person.
  // Returns [{ b, payable, paid, due }], oldest bill first.
  async openBills(pId = null) {
    const db = this._db;
    let bills = await db.billsProj.where('[hid+payment]').equals([0, PAYMENT.UNPAID]).toArray();
    if (pId != null) bills = bills.filter((b) => Number(b.pId) === Number(pId));
    const am = await this.allocationsMap(bills.map((b) => b.id));
    const rows = [];
    for (const b of bills) {
      const payable = Number(b.cust_payable != null ? b.cust_payable : b.cust_total) || 0;
      const paid = Math.min(payable, am.get(b.id) || 0);
      const due = Math.max(0, Math.round((payable - paid) * 100) / 100);
      if (due > 0) rows.push({ b, payable, paid, due });
    }
    rows.sort((a, b) => (a.b.crtAt || 0) - (b.b.crtAt || 0) || a.b.id - b.b.id);
    return rows;
  },

  // ---- people ----
  countPeople() {
    return this._db.peopleProj.where('hid').equals(0).count();
  },
  getPerson(id) {
    if (id == null) return Promise.resolve(null);
    return this._db.peopleProj.get(Number(id));
  },
  async listPeople({ offset = 0, limit = 50 } = {}) {
    const db = this._db;
    // Indexed read via the compound [hid+lastBillAt] index (orderBy requires
    // the ordering field to be part of the index used by where()).
    return await db.peopleProj
      .where('[hid+lastBillAt]')
      .between([0, Dexie.minKey], [0, Dexie.maxKey])
      .reverse()
      .offset(offset)
      .limit(limit)
      .toArray();
  },
  // People with outstanding dues (peopleProj.pending > 0), newest bill first.
  listPeopleDue() {
    return this._db.peopleProj
      .where('[hid+pending]').between([0, 0.0001], [0, Dexie.maxKey])
      .reverse()
      .toArray();
  },

  // Sortable + paged people list. `by` must be an indexed peopleProj field
  // ('lastBillAt' | 'pending' | 'name'); dir 'asc' | 'desc'. Uses indexed
  // sort via orderBy(), then filters hid in memory.
  async sortPeople({ by = 'lastBillAt', dir = 'desc', offset = 0, limit = 50 } = {}) {
    const field = by === 'pending' ? 'pending' : by === 'name' ? 'name' : 'lastBillAt';
    const db = this._db;
    let coll = db.peopleProj.where(`[hid+${field}]`).between([0, Dexie.minKey], [0, Dexie.maxKey]);
    if (dir === 'desc') coll = coll.reverse();
    return coll.offset(offset).limit(limit).toArray();
  },

  searchPeopleByPrefix(q, limit = 8) {
    const s = String(q || '').trim();
    if (!s) return Promise.resolve([]);
    const db = this._db;
    const req = /^\d/.test(s)
      ? db.peopleProj.where('mob').startsWith(s).limit(limit)
      : db.peopleProj.where('name').startsWith(normName(s)).limit(limit);
    return req.toArray().then((rows) => rows.filter((p) => !p.hid));
  },
  billsForPerson(pId) {
    const pid = Number(pId);
    if (!Number.isInteger(pid)) return Promise.resolve([]);
    return this._db.billsProj
      .where('[pId+crtAt]')
      .between([pid, Dexie.minKey], [pid, Dexie.maxKey])
      .reverse()
      .toArray()
      .then((rows) => rows.filter((b) => !b.hid));
  },

  // Total unpaid per person, for the given ids. Returns a Map<personId, amount>.
  // O(K) read from peopleProj (using pre-computed 'pending' field) instead of O(N) billsProj scan.
  async pendingByPerson(pIds) {
    const ids = Array.from(new Set((pIds || []).map(Number).filter(Number.isInteger)));
    const out = new Map();
    if (!ids.length) return out;
    const people = await this._db.peopleProj.where('id').anyOf(ids).toArray();
    for (const p of people) {
      out.set(Number(p.id), Number(p.pending) || 0);
    }
    return out;
  },

  // ---- user activity ----
  async activityForUser(uId, { offset = 0, limit = 50 } = {}) {
    const uid = Number(uId);
    if (!uid) return { items: [], total: 0, hasMore: false };
    const db = this._db;
    const [bills, people] = await Promise.all([
      db.bills.where('uId').equals(uid).toArray(),
      db.people.where('uId').equals(uid).toArray(),
    ]);
    const merged = [
      ...bills.map((r) => ({ kind: 'bill', id: r.id, rev: r })),
      ...people.map((r) => ({ kind: 'person', id: r.id, rev: r })),
    ].sort((a, b) => {
      const ta = a.rev.revAt || a.rev.crtAt || 0;
      const tb = b.rev.revAt || b.rev.crtAt || 0;
      return tb - ta;
    });
    const total = merged.length;
    const off = Math.max(0, Number(offset) || 0);
    const lim = Math.max(1, Number(limit) || 50);
    const slice = merged.slice(off, off + lim);
    for (const e of slice) {
      const table = e.kind === 'bill' ? db.bills : db.people;
      e.prev = e.rev.v > 1 ? await table.get([e.id, e.rev.v - 1]) : null;
    }
    return { items: slice, total, hasMore: off + slice.length < total };
  },

  // ---- revision history ----
  // Generic reader: every appended revision of one entity, oldest first.
  // entity: 'bill' | 'person' | 'test' | 'lab' | 'doctor' | 'user'.
  revisionsOf(entity, id) {
    const n = Number(id);
    if (!Number.isInteger(n)) return Promise.resolve([]);
    const table = REV_STORE[entity];
    if (!table) return Promise.resolve([]);
    return this._db[table]
      .where('[id+v]')
      .between([n, Dexie.minKey], [n, Dexie.maxKey])
      .toArray()
      .then((rows) => rows.sort((a, b) => a.v - b.v));
  },

  // Paged reader: newest revision first, walks backwards by v (cursor).
  // beforeV = null starts at the newest. Returns items (newest-first) each
  // carrying .prev (the v-1 row, or null), plus the next cursor + hasMore.
  async revisionsPage(entity, id, { beforeV = null, limit = 20 } = {}) {
    const n = Number(id);
    const table = REV_STORE[entity];
    if (!Number.isInteger(n) || !table) return { items: [], hasMore: false, nextBeforeV: null };
    const store = this._db[table];
    const upper = beforeV != null ? Number(beforeV) - 1 : Dexie.maxKey;
    const lim = Math.max(1, Number(limit) || 20);
    // Fetch one extra to know if more remain.
    const rows = await store
      .where('[id+v]')
      .between([n, Dexie.minKey], [n, upper])
      .reverse()
      .limit(lim + 1)
      .toArray();
    const hasMore = rows.length > lim;
    const page = hasMore ? rows.slice(0, lim) : rows;
    const items = [];
    for (const rev of page) {
      const prev = rev.v > 1 ? await store.get([n, rev.v - 1]) : null;
      items.push({ rev, prev });
    }
    const nextBeforeV = page.length ? page[page.length - 1].v : null;
    return { items, hasMore, nextBeforeV };
  },
};
