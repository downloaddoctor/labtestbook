// Write path: THE only place bills and people are written. Every write appends
// a revision AND refreshes the projection row, in the same Dexie transaction.
//
// v1: bill items are pins {itemId, itemV, hid}. Prices are resolved from
// testRevs at write time to compute totals; the bill stores only the totals,
// not the prices. People carry discount_per only; the bill carries a frozen
// disc_amt. lab/doc/person references are id+v.

import Dexie from 'https://unpkg.com/dexie@4.0.11/dist/modern/dexie.mjs';
import { computeBillTotals } from './billing.js';
import { normName, normMob, normPayment } from './norm.js';
import { diffValues, contentKeys, BILL_SKIP } from './diff.js';
import { PAYMENT } from './enums.js';

function numOrNull(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// Fetch the exact testRevs row for a pin, or the newest row for an itemId.
async function _revAt(db, table, id, v) {
  if (id == null || v == null) return null;
  return db[table + 'Revs'].get([Number(id), Number(v)]);
}
async function _latestRev(db, table, id) {
  if (id == null) return null;
  return db[table + 'Revs']
    .where('[id+v]')
    .between([Number(id), Dexie.minKey], [Number(id), Dexie.maxKey])
    .last();
}

export class NeedsItemVChoiceError extends Error {
  constructor({ itemId, prevItemV, latestItemV }) {
    super(`itemId ${itemId} needs an itemV choice (prev=${prevItemV}, latest=${latestItemV})`);
    this.name = 'NeedsItemVChoiceError';
    this.itemId = itemId;
    this.prevItemV = prevItemV;
    this.latestItemV = latestItemV;
  }
}

export const writeMethods = {
  addBill(input) {
    return this._addBillImpl(input, { preserve: null });
  },
  addBillPreserve(input, preserve) {
    return this._addBillImpl(input, { preserve });
  },

  // ---- revision helpers ----
  async _currentPerson(id) {
    if (id == null) return null;
    return this._db.people
      .where('[id+v]')
      .between([id, Dexie.minKey], [id, Dexie.maxKey])
      .last();
  },
  async _currentBill(id) {
    if (id == null) return null;
    return this._db.bills
      .where('[id+v]')
      .between([id, Dexie.minKey], [id, Dexie.maxKey])
      .last();
  },

  // ---- resolve a bill's priced items from pins ----
  // Returns [{itemId, itemV, hid, name, sell, buy}]. Throws if a pin misses.
  async _hydratePins(pins) {
    const out = [];
    for (const p of pins || []) {
      const rev = await _revAt(this._db, 'test', p.itemId, p.itemV);
      if (!rev) throw new Error(`test pin missing: id=${p.itemId} v=${p.itemV}`);
      out.push({
        itemId: Number(p.itemId),
        itemV: Number(p.itemV),
        hid: p.hid ? 1 : 0,
        name: rev.name,
        sell: Number(rev.sell) || 0,
        buy: Number(rev.buy) || 0,
      });
    }
    return out;
  },

  // Resolve a single item add. If the itemId is already present (any revision)
  // in the bill's history and the caller did not pin an itemV, throw so the UI
  // can ask the operator: keep old price (prevItemV) or use current (latest).
  async _resolveItemPin({ itemId, itemV, billHistory }) {
    const id = Number(itemId);
    if (itemV != null) return { itemId: id, itemV: Number(itemV), hid: 0 };
    const latest = await _latestRev(this._db, 'test', id);
    if (!latest) throw new Error('test not found: ' + id);
    const prev = (billHistory || []).find((it) => Number(it.itemId) === id);
    if (prev && Number(prev.itemV) !== Number(latest.v)) {
      throw new NeedsItemVChoiceError({
        itemId: id,
        prevItemV: Number(prev.itemV),
        latestItemV: Number(latest.v),
      });
    }
    return { itemId: id, itemV: Number(latest.v), hid: 0 };
  },

  // ---- projections ----
  async _putPersonProj(id) {
    const db = this._db;
    const cur = await this._currentPerson(id);
    if (!cur) {
      await db.peopleProj.delete(id);
      return null;
    }
    const bills = await db.billsProj.where('pId').equals(id).toArray();
    let count = 0;
    let lastBillAt = null;
    let pending = 0;
    for (const b of bills) {
      if (b.hid) continue;
      count++;
      const t = b.crtAt || null;
      if (t && (!lastBillAt || t > lastBillAt)) lastBillAt = t;
      if (Number(b.payment) === PAYMENT.UNPAID) {
        const pay = Number(b.cust_payable != null ? b.cust_payable : b.cust_total) || 0;
        const got = await this._allocatedForBill(b.id);
        pending += Math.max(0, Math.round((pay - got) * 100) / 100);
      }
    }
    const row = {
      id,
      v: cur.v,
      name: cur.name,
      mob: cur.mob,
      age: cur.age != null ? cur.age : null,
      gender: cur.gender != null ? cur.gender : null,
      weight: cur.weight != null ? cur.weight : null,
      discount_per: cur.discount_per != null ? cur.discount_per : null,
      headId: cur.headId != null ? cur.headId : null,
      billsCount: count,
      pending,
      advance: await this.advanceBalance(id),
      lastBillAt,
      hid: cur.hid ? 1 : 0,
      updatedAt: Date.now(),
    };
    await db.peopleProj.put(row);
    return row;
  },

  async _putBillProj(id) {
    const db = this._db;
    const cur = await this._currentBill(id);
    if (!cur) {
      await db.billsProj.delete(id);
      return null;
    }
    const revs = await db.bills
      .where('[id+v]')
      .between([id, Dexie.minKey], [id, Dexie.maxKey])
      .toArray();
    const history = [];
    for (let i = 1; i < revs.length; i++) {
      const changes = this._diffBill(revs[i - 1], revs[i]);
      if (Object.keys(changes).length > 0) {
        history.push({ at: revs[i].revAt || revs[i].crtAt, changes });
      }
    }
    const row = {
      id,
      v: cur.v,
      labId: cur.labId,
      labV: cur.labV != null ? cur.labV : null,
      docId: cur.docId,
      docV: cur.docV != null ? cur.docV : null,
      pId: cur.pId,
      pV: cur.pV != null ? cur.pV : null,
      datetime: cur.datetime,
      items: cur.items,
      disc_amt: cur.disc_amt,
      cust_total: cur.cust_total,
      merch_total: cur.merch_total,
      cust_payable: cur.cust_payable,
      grand_total: cur.grand_total,
      payment: normPayment(cur.payment),
      hid: cur.hid ? 1 : 0,
      history,
      crtAt: cur.crtAt,
      updatedAt: cur.revAt || cur.crtAt,
      uId: cur.uId != null ? cur.uId : null,
      uV: cur.uV != null ? cur.uV : null,
    };
    await db.billsProj.put(row);
    return row;
  },

  _diffBill(prev, next) {
    const changes = {};
    for (const c of diffValues(prev, next, contentKeys(prev, next, BILL_SKIP))) {
      changes[c.key] = { from: c.from, to: c.to };
    }
    return changes;
  },

  async _appendPersonRev(rec) {
    if (!rec.revAt) rec.revAt = Date.now();
    if (rec.uId == null && rec.uV == null) {
      const a = this._actor();
      rec.uId = a.uId;
      rec.uV = a.uV;
    }
    await this._db.people.add(rec);
    await this._putPersonProj(rec.id);
    this._emitJournal({ kind: 'person', ...rec });
    return rec;
  },

  async _appendBillRev(rec) {
    if (!rec.revAt) rec.revAt = Date.now();
    if (rec.uId == null && rec.uV == null) {
      const a = this._actor();
      rec.uId = a.uId;
      rec.uV = a.uV;
    }
    await this._assertSettlement(rec);
    await this._db.bills.add(rec);
    await this._putBillProj(rec.id);
    this._emitJournal({ kind: 'bill', ...rec });
    // Ledger + pending are derived from facts (db.derive.js), never written here.
    await this._derive(rec.pId);
    return rec;
  },

  async _resolvePerson({ id, name, mob, age, gender, weight, discount_per }, nowMs) {
    const db = this._db;
    name = normName(name);
    mob = normMob(mob);
    gender = gender == null ? null : String(gender).trim() || null;

    let current = null;
    if (id != null) current = await this._currentPerson(id);
    if (!current) {
      const hit = await db.peopleProj.where('[name+mob]').equals([name, mob]).first();
      if (hit) {
        id = hit.id;
        current = await this._currentPerson(id);
      }
    }

    if (!current) {
      const last = await db.people.orderBy('id').last();
      id = (last && last.id ? last.id : 0) + 1;
      const rec = {
        id,
        v: 1,
        name,
        mob,
        age: age == null || age === '' ? null : Number(age),
        gender,
        weight: weight == null || weight === '' ? null : Number(weight),
        discount_per: discount_per != null ? discount_per : null,
        hid: 0,
        crtAt: nowMs,
        revAt: nowMs,
      };
      await this._appendPersonRev(rec);
      return { id, v: 1, created: true };
    }

    const same =
      current.name === name &&
      current.mob === mob &&
      (age == null || age === '' ? current.age == null : Number(age) === current.age) &&
      (gender == null ? current.gender == null : gender === current.gender) &&
      (weight == null || weight === '' ? current.weight == null : Number(weight) === current.weight) &&
      (discount_per == null ? current.discount_per == null : Number(discount_per) === current.discount_per);
    if (same) return { id, v: current.v, created: false };

    const next = {
      ...current,
      v: current.v + 1,
      name,
      mob,
      age: age == null || age === '' ? null : Number(age),
      gender: gender == null ? current.gender : gender,
      weight: weight == null || weight === '' ? current.weight : Number(weight),
      discount_per: discount_per != null ? discount_per : current.discount_per,
      hid: current.hid ? 1 : 0,
      crtAt: nowMs,
      revAt: undefined,
    };
    await this._appendPersonRev(next);
    return { id, v: next.v, created: false };
  },

  // ---- _addBillImpl ----
  async _addBillImpl(input, { preserve }) {
    const now = Date.now();

    const billNo = input.id != null ? Number(input.id) : null;
    const date = input.datetime || '';
    let pId = input.pId ? Number(input.pId) : null;
    const name = normName(input.name);
    const mob = normMob(input.mob);
    const age = numOrNull(input.age);
    const gender = String(input.gender || '').trim();
    const weight = numOrNull(input.weight);

    const db = this._db;
    const actor = this._actor();

    return this._moneyTx(async () => {
      if (preserve) {
        pId = preserve.pId != null ? Number(preserve.pId) : null;
        if (pId == null) {
          const e = new Error('Restore row missing pId.');
          e.name = 'MissingPIdError';
          throw e;
        }
        const exists = await db.peopleProj.get(pId);
        if (!exists) {
          await this._appendPersonRev({
            id: pId,
            v: 1,
            name,
            mob,
            age,
            gender,
            weight,
            discount_per: input.discount_per != null ? input.discount_per : null,
            hid: 0,
            crtAt: preserve.crtAt || now,
            revAt: preserve.crtAt || now,
          });
        }
        const id = billNo != null ? billNo : await this.getNextBillNo();
        const pins = Array.isArray(input.items) ? input.items.map((it) => ({
          itemId: Number(it.itemId), itemV: Number(it.itemV), hid: it.hid ? 1 : 0,
        })) : [];
        const priced = await this._hydratePins(pins);
        const totals = computeBillTotals({ items: priced, disc_amt: input.disc_amt });
        const rec = {
          id,
          v: input.v != null ? Number(input.v) : 1,
          labId: Number(input.labId) || 0,
          labV: input.labV != null ? Number(input.labV) : null,
          docId: Number(input.docId) || 0,
          docV: input.docV != null ? Number(input.docV) : null,
          pId,
          pV: input.pV != null ? Number(input.pV) : null,
          datetime: date,
          items: pins,
          disc_amt: totals.disc_amt,
          cust_total: totals.cust_total,
          merch_total: totals.merch_total,
          cust_payable: totals.cust_payable,
          grand_total: totals.grand_total,
          payment: normPayment(input.payment),
          hid: input.hid ? 1 : 0,
          crtAt: preserve.crtAt || now,
          revAt: input.revAt || preserve.updatedAt || preserve.crtAt || now,
          uId: input.uId != null ? input.uId : null,
          uV: input.uV != null ? input.uV : null,
        };
        await this._appendBillRev(rec);
        await this._putPersonProj(pId);
        const person = await db.peopleProj.get(pId);
        const proj = await db.billsProj.get(id);
        return { rec: proj, created: false, person, prevPerson: null };
      }

      const person = await this._resolvePerson(
        { id: pId, name, mob, age, gender, weight, discount_per: numOrNull(input.discount_per) },
        now
      );
      pId = person.id;

      const id = billNo != null ? billNo : await this.getNextBillNo();
      if (await db.billsProj.get(id)) {
        const e = new Error('Bill ' + id + ' already exists.');
        e.name = 'DuplicateBillError';
        throw e;
      }
      const v = 1;
      const rawPins = Array.isArray(input.items) ? input.items : [];
      const pins = [];
      for (const it of rawPins) {
        const pin = await this._resolveItemPin({
          itemId: it.itemId,
          itemV: it.itemV,
          billHistory: [],
        });
        pin.hid = it.hid ? 1 : 0;
        pins.push(pin);
      }

      const priced = await this._hydratePins(pins);
      const totals = computeBillTotals({ items: priced, disc_amt: input.disc_amt });

      const rec = {
        id,
        v,
        labId: Number(input.labId) || 0,
        labV: input.labV != null ? Number(input.labV) : null,
        docId: Number(input.docId) || 0,
        docV: input.docV != null ? Number(input.docV) : null,
        pId,
        pV: person.v,
        datetime: date,
        items: pins,
        disc_amt: totals.disc_amt,
        cust_total: totals.cust_total,
        merch_total: totals.merch_total,
        cust_payable: totals.cust_payable,
        grand_total: totals.grand_total,
        payment: normPayment(input.payment),
        hid: 0,
        crtAt: input.crtAt != null ? Number(input.crtAt) : now,
        revAt: now,
        uId: actor.uId,
        uV: actor.uV,
      };
      await this._appendBillRev(rec);
      if (Number(rec.payment) === PAYMENT.UNPAID) await this._applyAdvance(pId);
      const personRow = await db.peopleProj.get(pId);
      const proj = await db.billsProj.get(id);
      return { rec: proj, created: true, person: personRow, prevPerson: null };
    });
  },

  async updateBill(partial) {
    const db = this._db;
    const id = Number(partial.id != null ? partial.id : partial.id);
    if (!Number.isInteger(id)) throw new Error('updateBill requires id');
    return this._moneyTx(async () => {
      const existing = await db.billsProj.get(id);
      if (!existing) throw new Error('Bill not found: ' + id);
      const cur = await this._currentBill(id);
      if (!cur) throw new Error('Bill revision not found: ' + id);

      const priorItems = cur.items || [];
      const rawPins = Array.isArray(partial.items) ? partial.items : priorItems;
      const pins = [];
      for (const it of rawPins) {
        const pin = await this._resolveItemPin({
          itemId: it.itemId,
          itemV: it.itemV,
          billHistory: priorItems,
        });
        pin.hid = it.hid ? 1 : 0;
        pins.push(pin);
      }
      const priced = await this._hydratePins(pins);
      const disc_amt = partial.disc_amt != null ? partial.disc_amt : cur.disc_amt;
      const totals = computeBillTotals({ items: priced, disc_amt });

      // Resolve (and possibly bump) the person so age/weight/name edits persist
      // and pV advances — a person revision is written in the same tx. Bills do
      // not denormalize person fields, so fall back to the current person row.
      const prevPId = existing.pId;
      const curPerson = await this._currentPerson(prevPId);
      const person = await this._resolvePerson(
        {
          id: prevPId,
          name: partial.name != null ? partial.name : curPerson && curPerson.name,
          mob: partial.mob != null ? partial.mob : curPerson && curPerson.mob,
          age: partial.age != null ? partial.age : curPerson && curPerson.age,
          gender: partial.gender != null ? partial.gender : curPerson && curPerson.gender,
          weight: partial.weight != null ? partial.weight : curPerson && curPerson.weight,
          discount_per: partial.discount_per != null ? partial.discount_per : curPerson && curPerson.discount_per,
        },
        Date.now()
      );
      const pId = person.id;
      const actor = this._actor();
      const next = {
        ...cur,
        v: cur.v + 1,
        labId: partial.labId != null ? Number(partial.labId) : cur.labId,
        labV: partial.labV != null ? Number(partial.labV) : cur.labV,
        docId: partial.docId != null ? Number(partial.docId) : cur.docId,
        docV: partial.docV != null ? Number(partial.docV) : cur.docV,
        pId,
        pV: person.v,
        datetime: partial.datetime != null ? partial.datetime : cur.datetime,
        items: pins,
        disc_amt: totals.disc_amt,
        cust_total: totals.cust_total,
        merch_total: totals.merch_total,
        cust_payable: totals.cust_payable,
        grand_total: totals.grand_total,
        payment: partial.payment != null ? normPayment(partial.payment) : cur.payment,
        hid: cur.hid ? 1 : 0,
      };
      delete next.history;
      // Idempotent: no content change (and no person-version bump) -> no write.
      const contentChanged =
        diffValues(cur, next, contentKeys(cur, next, BILL_SKIP)).length > 0;
      if (!contentChanged) {
        const proj = await db.billsProj.get(id);
        return { rec: proj, created: false, person: curPerson, prevPerson: null, unchanged: true };
      }
      next.revAt = undefined;
      next.uId = actor.uId;
      next.uV = actor.uV;
      await this._appendBillRev(next);
      if (prevPId != null && prevPId !== pId) await this._derive(prevPId);
      if (Number(next.payment) === PAYMENT.UNPAID) await this._applyAdvance(pId);
      const personRow = await db.peopleProj.get(pId);
      const proj = await db.billsProj.get(id);
      return { rec: proj, created: false, person: personRow, prevPerson: null };
    });
  },

  async setBillPayment(billId, payment) {
    const db = this._db;
    const id = Number(billId);
    return this._moneyTx(async () => {
      const cur = await this._currentBill(id);
      if (!cur) throw new Error('Bill not found: ' + id);
      const nextPay = normPayment(payment);
      if (normPayment(cur.payment) === nextPay) return await db.billsProj.get(id);
      const actor = this._actor();
      const rec = {
        ...cur,
        v: cur.v + 1,
        payment: nextPay,
        revAt: undefined,
        uId: actor.uId,
        uV: actor.uV,
      };
      await this._appendBillRev(rec);
      if (nextPay === PAYMENT.UNPAID) await this._applyAdvance(cur.pId);
      return await db.billsProj.get(id);
    });
  },

  async deleteBill(id) {
    const db = this._db;
    const bid = Number(id);
    return this._moneyTx(async () => {
      const cur = await this._currentBill(bid);
      if (!cur) return;
      const actor = this._actor();
      const rec = {
        ...cur,
        v: cur.v + 1,
        hid: 1,
        revAt: undefined,
        uId: actor.uId,
        uV: actor.uV,
      };
      await this._appendBillRev(rec);
      // Allocations on this bill return to the head's advance automatically:
      // advanceBalance and _computeLedger both skip allocations on hidden bills.
    });
  },

  // ---- delete requests (a plain user asks; an admin approves or rejects) ----
  async requestBillDelete(id, reason) {
    const db = this._db;
    const bid = Number(id);
    const cur = await db.billsProj.get(bid);
    if (!cur || cur.hid) return null;
    const dup = await db.delReqs
      .where('billId')
      .equals(bid)
      .filter((r) => r.status === 0)
      .first();
    if (dup) return { ...dup, duplicate: true };
    const a = this._actor();
    const rec = {
      billId: bid,
      status: 0,
      at: Date.now(),
      uId: a.uId,
      reason: String(reason || '').slice(0, 200),
    };
    rec.id = await db.delReqs.add(rec);
    return rec;
  },

  async listDeleteRequests(status = 0) {
    const db = this._db;
    const rows = await db.delReqs.where('status').equals(status).toArray();
    rows.sort((x, y) => x.at - y.at);
    for (const r of rows) {
      const u = r.uId != null ? await db.users.get(r.uId) : null;
      r.username = u ? u.username : '';
      const b = await db.billsProj.get(r.billId);
      r.billGone = !b || !!b.hid;
      r.total = b ? b.cust_total : null;
      const p = b && b.pId != null ? await db.peopleProj.get(b.pId) : null;
      r.pname = p ? p.name : '';
    }
    return rows;
  },

  async pendingDeleteCount() {
    return this._db.delReqs.where('status').equals(0).count();
  },

  async resolveDeleteRequest(id, approve) {
    const db = this._db;
    const r = await db.delReqs.get(Number(id));
    if (!r || r.status !== 0) return null;
    if (approve) await this.deleteBill(r.billId);
    const a = this._actor();
    await db.delReqs.update(r.id, { status: approve ? 1 : 2, doneAt: Date.now(), doneBy: a.uId });
    return true;
  },
};
