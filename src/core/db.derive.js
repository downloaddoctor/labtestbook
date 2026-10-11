// Derived-data engine. Facts in, projections out.
//
// FACTS (truth, append-only): bills revisions, payments, allocations, people
// revisions. DERIVED (never written elsewhere): `ledger` rows and the money
// fields on peopleProj (pending). This file is the ONLY writer of `ledger`.
//
//   _computeLedger(pIds) -> rows        pure read of facts, no writes
//   _rederive(pIds)                     delete + regenerate rows, refresh pending
//   _derive(pId) / _beginBatch/_endBatch  single-call or deferred (restore) path
//   verify()                            recompute from facts, diff vs stored
//   rebuildDerived()                    repair: regenerate everything
//
// Money maths uses integer paise internally (toP/fromP).

import { billEvents } from './db.ledger.js';
import { ALLOC, PAYMENT, kindCode, kindName } from './enums.js';

const toP = (n) => Math.round((Number(n) || 0) * 100);
const fromP = (p) => p / 100;
const payableOf = (b) => (b.cust_payable != null ? b.cust_payable : b.cust_total);

export const deriveMethods = {
  // One transaction scope for every money-touching write.
  _moneyTx(fn, ...extra) {
    const db = this._db;
    return db.transaction(
      'rw',
      db.people, db.peopleProj, db.bills, db.billsProj, db.testRevs,
      db.ledger, db.payments, db.allocations, ...extra, fn
    );
  },

  // Head + every member of the family a person belongs to.
  async _familyOf(pId) {
    const id = Number(pId);
    const cur = await this._currentPerson(id);
    if (!cur) return [id];
    const head = cur.headId != null ? Number(cur.headId) : Number(cur.id);
    const kids = await this._db.peopleProj.where('headId').equals(head).primaryKeys();
    return Array.from(new Set([head, ...kids.map(Number)]));
  },

  // A bill revision may not be "settled" (cash/UPI) while it carries
  // allocations: that would count the same money twice.
  async _assertSettlement(rec) {
    if (rec.hid || Number(rec.payment) === PAYMENT.UNPAID) return;
    const n = await this._db.allocations.where('billId').equals(Number(rec.id)).count();
    if (n) {
      const e = new Error('Bill ' + rec.id + ' already has part payments. Use Receive payment for the rest.');
      e.name = 'PartPaidError';
      throw e;
    }
  },

  _beginBatch() {
    this._batch = new Set();
  },
  async _endBatch() {
    const dirty = this._batch ? [...this._batch] : [];
    this._batch = null;
    const all = new Set();
    for (const id of dirty) for (const m of await this._familyOf(id)) all.add(m);
    await this._rederive([...all]);
  },

  // Mark persons dirty: derive now, or later if a batch is open.
  async _derive(...pIds) {
    const ids = pIds.filter((x) => x != null).map(Number).filter(Number.isInteger);
    if (this._batch) {
      for (const id of ids) this._batch.add(id);
      return;
    }
    const all = new Set();
    for (const id of ids) for (const m of await this._familyOf(id)) all.add(m);
    await this._rederive([...all]);
  },

  // Pure: ledger rows implied by the facts, for the given persons.
  async _computeLedger(personIds) {
    const db = this._db;
    const set = new Set(personIds.map(Number));
    const rows = [];
    const billIds = new Set();
    await db.bills.where('pId').anyOf([...set]).each((r) => billIds.add(r.id));
    for (const id of billIds) {
      const revs = (await db.bills.where('id').equals(id).toArray()).sort((a, b) => a.v - b.v);
      if (!revs.length || !set.has(Number(revs[0].pId))) continue;
      const pId = Number(revs[0].pId);
      const last = revs[revs.length - 1];
      for (const e of billEvents(pId, revs)) {
        rows.push({
          pId: e.pId, at: e.at, billId: e.billId, kind: e.kind,
          cashDelta: e.cashDelta, receivableDelta: e.receivableDelta,
          merchantDelta: e.merchantDelta || 0,
        });
      }
      const als = await db.allocations.where('billId').equals(id).toArray();
      for (const a of als) {
        const amt = Number(a.amount) || 0;
        const receipt = a.ak !== ALLOC.APPLY;
        rows.push({
          pId, at: a.at, billId: null, kind: receipt ? 'PAY_PART' : 'ADVANCE_APPLY',
          cashDelta: receipt ? amt : 0, receivableDelta: -amt, merchantDelta: 0,
          payId: a.paymentId, forBill: id,
        });
        if (last.hid) {
          // Deleted bill: its allocations go back to the head's advance.
          rows.push({
            pId, at: last.revAt || a.at, billId: null, kind: 'ALLOC_RETURN',
            cashDelta: 0, receivableDelta: amt, merchantDelta: 0,
            payId: a.paymentId, forBill: id,
          });
        }
      }
    }
    const pays = await db.payments.where('headId').anyOf([...set]).toArray();
    for (const p of pays) {
      const als = await db.allocations.where('paymentId').equals(p.id).toArray();
      let receipts = 0;
      for (const a of als) if (a.ak !== ALLOC.APPLY) receipts += toP(a.amount);
      const left = toP(p.amount) - receipts;
      if (left !== 0) {
        rows.push({
          pId: Number(p.headId), at: p.at, billId: null,
          kind: Number(p.amount) < 0 ? 'REFUND' : 'ADVANCE',
          cashDelta: fromP(left), receivableDelta: 0, merchantDelta: 0, payId: p.id,
        });
      }
    }
    return rows;
  },

  // The single ledger writer.
  async _rederive(pIds) {
    const ids = Array.from(new Set(pIds.map(Number).filter(Number.isInteger)));
    if (!ids.length) return;
    const db = this._db;
    await db.ledger.where('pId').anyOf(ids).delete();
    const rows = await this._computeLedger(ids);
    // kind is stored as an int enum (see enums.js); readers map it back.
    if (rows.length) await db.ledger.bulkAdd(rows.map((r) => ({ ...r, kind: kindCode(r.kind) })));
    for (const id of ids) await this._putPersonProj(id);
  },

  // Repair: regenerate every derived row from facts.
  async rebuildDerived() {
    return this._moneyTx(async () => {
      const db = this._db;
      await db.ledger.clear();
      const ids = await db.people.orderBy('id').uniqueKeys();
      await this._rederive(ids);
      return { persons: ids.length };
    });
  },

  // Cheap boot check: verify only persons touched in the last `sinceMs`.
  async verifyRecent(sinceMs = 7 * 86400000) {
    if (this._batch) return { ok: true, issues: [] };
    const cutoff = Date.now() - sinceMs;
    const ids = [];
    await this._db.peopleProj.each((p) => { if ((p.updatedAt || 0) >= cutoff) ids.push(Number(p.id)); });
    if (!ids.length) return { ok: true, issues: [] };
    return this._verifyPersons(ids);
  },

  // Recompute everything from facts and compare with what is stored.
  // Returns { ok, issues: [string] }. Never writes.
  async verify() {
    const ids = (await this._db.people.orderBy('id').uniqueKeys()).map(Number);
    return this._verifyPersons(ids);
  },

  // Shared verify body, scoped to the given persons.
  async _verifyPersons(ids) {
    const db = this._db;
    if (this._batch) return { ok: true, issues: [] };
    const issues = [];
    const idSet = new Set(ids.map(Number));

    // 1. Ledger totals per person: stored vs recomputed.
    const expected = await this._computeLedger(ids);
    const stored = await db.ledger.where('pId').anyOf([...idSet]).toArray();
    const fold = (rows) => {
      const m = new Map();
      for (const r of rows) {
        const o = m.get(r.pId) || { c: 0, r: 0, m: 0, n: 0 };
        o.c += toP(r.cashDelta);
        o.r += toP(r.receivableDelta);
        o.m += toP(r.merchantDelta);
        o.n += 1;
        m.set(r.pId, o);
      }
      return m;
    };
    const em = fold(expected);
    const sm = fold(stored);
    // Row identity (not just totals): a compensating pair of wrong rows must fail.
    // `kind` is a string on expected rows and an int on stored rows — normalize
    // both to the int domain via kindName (idempotent) then kindCode.
    const keyOf = (r) => `${kindCode(kindName(r.kind))}|${r.billId == null ? '' : r.billId}|${r.payId == null ? '' : r.payId}|${r.at}`;
    const sigOf = (rows) => rows.map(keyOf).sort().join('\n');
    if (sigOf(expected) !== sigOf(stored)) {
      issues.push('ledger rows differ from facts (not just totals)');
    }
    for (const k of new Set([...em.keys(), ...sm.keys()])) {
      const a = em.get(k) || { c: 0, r: 0, m: 0, n: 0 };
      const b = sm.get(k) || { c: 0, r: 0, m: 0, n: 0 };
      if (a.c !== b.c || a.r !== b.r || a.m !== b.m || a.n !== b.n) {
        issues.push(`ledger drift for person ${k}: expected cash ${fromP(a.c)} due ${fromP(a.r)} (${a.n} rows), stored cash ${fromP(b.c)} due ${fromP(b.r)} (${b.n} rows)`);
      }
    }

    // 2. Pending per person (scoped).
    const projRows = await db.peopleProj.where('id').anyOf([...idSet]).toArray();
    const bills = await db.billsProj.where('pId').anyOf([...idSet]).toArray();
    const billIds = bills.map((b) => b.id);
    const am = await this.allocationsMap(billIds);
    const billById = new Map(bills.map((b) => [b.id, b]));
    const pend = new Map();
    for (const b of bills) {
      if (b.hid || Number(b.payment) !== PAYMENT.UNPAID) continue;
      const d = Math.max(0, toP(payableOf(b)) - toP(am.get(b.id) || 0));
      pend.set(Number(b.pId), (pend.get(Number(b.pId)) || 0) + d);
    }
    for (const p of projRows) {
      if (toP(p.pending) !== (pend.get(Number(p.id)) || 0)) {
        issues.push(`pending drift for person ${p.id}: expected ${fromP(pend.get(Number(p.id)) || 0)}, stored ${p.pending}`);
      }
    }

    // 3. Fact invariants (scoped to these persons' heads + bills).
    const pays = await db.payments.where('headId').anyOf([...idSet]).toArray();
    const payIds = new Set(pays.map((p) => p.id));
    // Union (by id) of: allocations on these persons' bills, and allocations of
    // these persons' payments. A row can match both — dedupe so it counts once.
    const allocById = new Map();
    for (const a of await db.allocations.where('billId').anyOf(billIds).toArray()) allocById.set(a.id, a);
    for (const a of await db.allocations.toArray()) if (payIds.has(a.paymentId)) allocById.set(a.id, a);
    const allocs = [...allocById.values()];
    const byPay = new Map();
    for (const a of allocs) {
      const b = billById.get(a.billId);
      if (b && !b.hid) byPay.set(a.paymentId, (byPay.get(a.paymentId) || 0) + toP(a.amount));
      if (!b) issues.push(`allocation ${a.id} points at missing bill ${a.billId}`);
      else if (!b.hid && Number(b.payment) !== PAYMENT.UNPAID) issues.push(`bill ${b.id} is settled AND has allocation ${a.id}`);
    }
    const advance = new Map();
    for (const p of pays) {
      const used = byPay.get(p.id) || 0;
      if (toP(p.amount) > 0 && used > toP(p.amount)) issues.push(`payment ${p.id} over-allocated: ${fromP(used)} of ${p.amount}`);
    }
    for (const p of pays) advance.set(Number(p.headId), (advance.get(Number(p.headId)) || 0) + toP(p.amount));
    for (const a of allocs) {
      const b = billById.get(a.billId);
      const p = pays.find((x) => x.id === a.paymentId);
      if (b && !b.hid && p) advance.set(Number(p.headId), (advance.get(Number(p.headId)) || 0) - toP(a.amount));
    }
    for (const p of projRows) {
      const want = advance.get(Number(p.id)) || 0;
      if (toP(p.advance) !== want) issues.push(`advance drift for person ${p.id}: expected ${fromP(want)}, stored ${p.advance}`);
    }
    for (const [h, v] of advance) if (v < 0) issues.push(`head ${h} has negative advance ${fromP(v)}`);
    for (const b of bills) {
      if (b.hid) continue;
      if (toP(am.get(b.id) || 0) > toP(payableOf(b))) issues.push(`bill ${b.id} over-allocated`);
    }
    return { ok: issues.length === 0, issues };
  },
};
