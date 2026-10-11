// Family-head payments (FACTS). Attached to DB.prototype via Object.assign.
//
// A head pays any amount; it is split FIFO across the family's oldest unpaid
// bills. The rest stays as the head's advance and is spent automatically on
// later bills. Rows are append-only. A refund is a negative payment.
// This file never writes `ledger` or pending: it appends facts, then calls
// _derive() (db.derive.js), the single writer of derived data.
//
// advance(head)    = SUM(payments.amount) - SUM(allocations on live bills)
// outstanding(bill) = cust_payable - SUM(allocations for the bill)
// allocation.kind  = 'receipt' (part of a fresh payment) | 'advance-apply'

import { ALLOC, PAYMENT } from './enums.js';

const toP = (n) => Math.round((Number(n) || 0) * 100);
const fromP = (p) => p / 100;
const payableOf = (b) => (b.cust_payable != null ? b.cust_payable : b.cust_total);

export const paymentMethods = {
  // Head id + every member whose headId points at it.
  async familyIds(headId) {
    const h = Number(headId);
    const kids = await this._db.peopleProj.where('headId').equals(h).primaryKeys();
    return Array.from(new Set([h, ...kids.map(Number)]));
  },

  async _allocatedForBill(billId) {
    let s = 0;
    await this._db.allocations.where('billId').equals(Number(billId)).each((a) => { s += toP(a.amount); });
    return fromP(s);
  },

  // Map<billId, total allocated> across all payments (one table scan).
  async allocationsMap(billIds) {
    const m = new Map();
    const add = (a) => m.set(a.billId, fromP(toP(m.get(a.billId) || 0) + toP(a.amount)));
    if (Array.isArray(billIds)) {
      const ids = [...new Set(billIds.map(Number))];
      if (!ids.length) return m;
      await this._db.allocations.where('billId').anyOf(ids).each(add);
      return m;
    }
    await this._db.allocations.each(add);
    return m;
  },

  async billOutstanding(billId) {
    const b = await this._db.billsProj.get(Number(billId));
    if (!b || b.hid || Number(b.payment) !== PAYMENT.UNPAID) return 0;
    return Math.max(0, fromP(toP(payableOf(b)) - toP(await this._allocatedForBill(b.id))));
  },

  // Total advance held across every family head (one pass over payments + allocations).
  async totalAdvance() {
    let s = 0;
    await this._db.peopleProj.each((p) => { s += toP(p.advance); });
    return fromP(s);
  },

  // Full-scan reference, used to cross-check the per-head aggregate.
  async _totalAdvanceScan() {
    const db = this._db;
    const pays = await db.payments.toArray();
    const headOf = new Map(pays.map((p) => [p.id, Number(p.headId)]));
    const sum = new Map();
    for (const p of pays) sum.set(Number(p.headId), (sum.get(Number(p.headId)) || 0) + toP(p.amount));
    const allocs = await db.allocations.toArray();
    const live = new Map();
    for (const bid of new Set(allocs.map((a) => a.billId))) {
      const bl = await db.billsProj.get(bid);
      live.set(bid, !!bl && !bl.hid);
    }
    for (const a of allocs) {
      if (!live.get(a.billId)) continue;
      const h = headOf.get(a.paymentId);
      if (h != null) sum.set(h, (sum.get(h) || 0) - toP(a.amount));
    }
    let total = 0;
    for (const v of sum.values()) total += v;
    return fromP(total);
  },

  async advanceBalance(headId) {
    const db = this._db;
    let s = 0;
    const pays = await db.payments.where('headId').equals(Number(headId)).toArray();
    for (const p of pays) {
      s += toP(p.amount);
      for (const a of await db.allocations.where('paymentId').equals(p.id).toArray()) {
        const bl = await db.billsProj.get(a.billId);
        if (bl && !bl.hid) s -= toP(a.amount);
      }
    }
    return fromP(s);
  },

  // Open bills of a family, oldest first, each with its outstanding amount.
  async familyDueBills(headId) {
    const out = [];
    const billIds = [];
    for (const m of await this.familyIds(headId)) {
      const bills = await this._db.billsProj.where('pId').equals(m).toArray();
      for (const b of bills) {
        if (b.hid || Number(b.payment) !== PAYMENT.UNPAID) continue;
        billIds.push(b.id);
        out.push({ id: b.id, pId: b.pId, crtAt: b.crtAt, payable: Number(payableOf(b)) });
      }
    }
    const am = await this.allocationsMap(billIds);
    const due = [];
    for (const r of out) {
      const left = fromP(toP(r.payable) - toP(am.get(r.id) || 0));
      if (left > 0) due.push({ ...r, due: left });
    }
    due.sort((a, b) => a.crtAt - b.crtAt || a.id - b.id);
    return due;
  },

  // Link a person to a family head (headId null = own head).
  async setPersonHead(pId, headId) {
    const id = Number(pId);
    const head = headId == null || headId === '' || Number(headId) === id ? null : Number(headId);
    return this._moneyTx(async () => {
      const cur = await this._currentPerson(id);
      if (!cur) throw new Error('Person not found: ' + id);
      if (head != null) {
        const h = await this._currentPerson(head);
        if (!h) throw new Error('Family head not found: ' + head);
        if (h.headId != null) throw new Error('That person is already a family member, pick the head.');
        const kids = await this._db.peopleProj.where('headId').equals(id).count();
        if (kids) throw new Error('This person is a family head with members; move the members first.');
      }
      const oldHead = cur.headId != null ? Number(cur.headId) : null;
      if (oldHead === head) return cur;
      const next = { ...cur, v: cur.v + 1, headId: head, crtAt: Date.now(), revAt: undefined };
      await this._appendPersonRev(next);
      await this._derive(id, oldHead, head);
      await this._applyAdvance(head != null ? head : id);
      return next;
    });
  },

  // Spend the head's advance on the family's open bills, oldest first.
  // Slices are allocations of kind 'advance-apply'. Runs inside a money tx.
  async _applyAdvance(pId) {
    const db = this._db;
    const cur = await this._currentPerson(Number(pId));
    if (!cur) return [];
    const head = cur.headId != null ? Number(cur.headId) : Number(cur.id);
    let cap = toP(await this.advanceBalance(head));
    if (cap <= 0) return [];
    const pays = (await db.payments.where('headId').equals(head).toArray())
      .filter((p) => Number(p.amount) > 0)
      .sort((a, b) => a.at - b.at || a.id - b.id);
    const credit = [];
    for (const p of pays) {
      let left = toP(p.amount);
      for (const a of await db.allocations.where('paymentId').equals(p.id).toArray()) {
        const bl = await db.billsProj.get(a.billId);
        if (bl && !bl.hid) left -= toP(a.amount);
      }
      if (left > 0) credit.push({ id: p.id, left });
    }
    const due = await this.familyDueBills(head);
    const applied = [];
    const touched = new Set();
    const now = Date.now();
    for (const d of due) {
      const already = toP(await this._allocatedForBill(d.id));
      const payable = toP(payableOf({ cust_payable: d.payable, cust_total: d.payable }));
      let need = Math.max(0, payable - already);
      while (need > 0 && cap > 0 && credit.length) {
        const c = credit[0];
        const a = Math.min(need, c.left, cap);
        if (a <= 0) { credit.shift(); continue; }
        const arow = { paymentId: c.id, billId: d.id, amount: fromP(a), at: now, ak: ALLOC.APPLY };
        const aid = await db.allocations.add(arow);
        this._emitJournal({ kind: 'allocation', id: aid, ...arow });
        applied.push({ billId: d.id, amount: fromP(a) });
        touched.add(Number(d.pId));
        c.left -= a;
        need -= a;
        cap -= a;
        if (c.left <= 0) credit.shift();
      }
      if (cap <= 0 || !credit.length) break;
    }
    if (touched.size) await this._derive(...touched);
    return applied;
  },

  // Record money received from a head. billIds (optional) = manual order/choice.
  // Returns { paymentId, allocated: [{billId, amount}], applied, advance }.
  async recordPayment({ headId, amount, method = 1, note = null, billIds = null }) {
    const head = Number(headId);
    const amt = toP(amount);
    if (!Number.isInteger(head)) throw new Error('recordPayment requires headId');
    if (!(amt > 0)) throw new Error('Payment amount must be greater than 0');
    const m = Number(method) === 2 ? 2 : 1;
    return this._moneyTx(async () => {
      const db = this._db;
      const hp = await this._currentPerson(head);
      if (!hp) throw new Error('Family head not found: ' + head);
      if (hp.headId != null) throw new Error('Payments go to the family head, not a member.');
      const now = Date.now();
      const actor = this._actor();
      let due = await this.familyDueBills(head);
      if (Array.isArray(billIds) && billIds.length) {
        const order = billIds.map(Number);
        due = order.map((id) => due.find((d) => d.id === id)).filter(Boolean);
      }
      const row = {
        headId: head, amount: fromP(amt), method: m, at: now,
        note: note || null, uId: actor.uId, uV: actor.uV,
      };
      const paymentId = await db.payments.add(row);
      this._emitJournal({ kind: 'payment', id: paymentId, ...row });

      let left = amt;
      const allocated = [];
      const touched = new Set([head]);
      for (const d of due) {
        if (left <= 0) break;
        const a = Math.min(left, toP(d.due));
        if (a <= 0) continue;
        const arow = { paymentId, billId: d.id, amount: fromP(a), at: now, ak: ALLOC.RECEIPT };
        const aid = await db.allocations.add(arow);
        this._emitJournal({ kind: 'allocation', id: aid, ...arow });
        allocated.push({ billId: d.id, amount: fromP(a) });
        touched.add(Number(d.pId));
        left -= a;
      }
      await this._derive(...touched);
      const applied = await this._applyAdvance(head);
      return { paymentId, allocated, applied, advance: await this.advanceBalance(head) };
    });
  },

  // Give advance money back: a NEGATIVE payment. Cannot exceed the advance.
  async refundAdvance({ headId, amount, method = 1, note = null }) {
    const head = Number(headId);
    const amt = toP(amount);
    if (!Number.isInteger(head)) throw new Error('refundAdvance requires headId');
    if (!(amt > 0)) throw new Error('Refund amount must be greater than 0');
    return this._moneyTx(async () => {
      const have = toP(await this.advanceBalance(head));
      if (amt > have) throw new Error('Refund is more than the advance held (' + fromP(have) + ').');
      const actor = this._actor();
      const row = {
        headId: head, amount: -fromP(amt), method: Number(method) === 2 ? 2 : 1,
        at: Date.now(), note: note || 'Refund', uId: actor.uId, uV: actor.uV,
      };
      const id = await this._db.payments.add(row);
      this._emitJournal({ kind: 'payment', id, ...row });
      await this._derive(head);
      return { paymentId: id, advance: await this.advanceBalance(head) };
    });
  },
};
