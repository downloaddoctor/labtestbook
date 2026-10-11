// Ledger: a true cash book + receivables ledger, driven by the bills
// revision table (not the projection). Every revision is an EVENT, timestamped
// at revAt (when it was recorded), except the very first revision of a bill,
// whose crtAt is the moment the credit/cash was first posted.
//
// Event model (per bill revision, diffing prev -> cur):
//   rev 1   : post at crtAt.
//             payment===0  -> +receivable cust_payable
//             payment 1|2  -> +cash       cust_payable
//   rev N>1 : post at revAt, as a delta vs prev.
//     - payment flipped 0 -> 1|2 : +cash (cur.payable), -receivable (prev.payable)
//     - payment flipped 1|2 -> 0 : -cash (prev.payable), +receivable (cur.payable)
//     - payable changed, payment unchanged & 0 : +receivable (delta)
//     - payable changed, payment unchanged & 1|2 : +cash (delta)
//     - hid flipped 0 -> 1 : reverse whatever the bill carried (prev)
//     - hid flipped 1 -> 0 : re-post whatever cur carries
// Amounts are cust_payable (net of discount).
//
// The ledger never rewrites history: a payment on an old bill posts today,
// as an adjustment row on today's ledger.

import Dexie from 'https://unpkg.com/dexie@4.0.11/dist/modern/dexie.mjs';
import { dayKey, monthKey, yearKey, weekKey, periodKey, periodBounds } from './time.js';
import { kindName, PAYMENT } from './enums.js';

// Stored ledger rows carry an int kind; readers get the readable name.
const withKindName = (r) => ({ ...r, kind: typeof r.kind === 'number' ? kindName(r.kind) : r.kind });

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const payableOf = (r) => round2(r && r.cust_payable != null ? r.cust_payable : r && r.cust_total);
// Merchant cost owed for a bill revision (what the lab charges us).
const merchOf = (r) => round2(r && r.merch_total);

// Emit ledger events for a single bill's revision chain (prev,cur) pairs.
// Each event: { billId, at, cashDelta, receivableDelta, kind, ref }.
//   kind: 'sale-cash' | 'sale-credit' | 'pay' | 'unpay' | 'adjust' | 'delete' | 'restore'
export function billEvents(pId, revs) {
  const out = [];
  if (!revs || !revs.length) return out;
  const sorted = revs.slice().sort((a, b) => a.v - b.v);

  // rev 1: initial posting.
  {
    const cur = sorted[0];
    const at = cur.crtAt != null ? cur.crtAt : cur.revAt;
    const pay = Number(cur.payment);
    const amt = payableOf(cur);
    if (cur.hid) {
      // Created already-deleted: nothing to post.
    } else if (pay === PAYMENT.UNPAID) {
      out.push({ billId: cur.id, pId, at, cashDelta: 0, receivableDelta: amt, merchantDelta: merchOf(cur), kind: 'SALE_CREDIT', ref: { v: cur.v } });
    } else {
      out.push({ billId: cur.id, pId, at, cashDelta: amt, receivableDelta: 0, merchantDelta: merchOf(cur), kind: 'SALE_CASH', ref: { v: cur.v } });
    }
  }

  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const cur = sorted[i];
    const at = cur.revAt != null ? cur.revAt : cur.crtAt;
    const pv = payableOf(prev);
    const cv = payableOf(cur);
    const prevPay = Number(prev.payment);
    const curPay = Number(cur.payment);
    const prevHid = prev.hid ? 1 : 0;
    const curHid = cur.hid ? 1 : 0;

    const prevCash = !prevHid && prevPay !== 0 ? pv : 0;
    const prevRecv = !prevHid && prevPay === 0 ? pv : 0;
    const curCash = !curHid && curPay !== 0 ? cv : 0;
    const curRecv = !curHid && curPay === 0 ? cv : 0;
    const cashDelta = round2(curCash - prevCash);
    const recvDelta = round2(curRecv - prevRecv);
    // Merchant payable follows the bill's existence: +cost when live, 0 when
    // hidden. A pure payment flip does not change the merchant cost.
    const prevMerch = prevHid ? 0 : merchOf(prev);
    const curMerch = curHid ? 0 : merchOf(cur);
    const merchDelta = round2(curMerch - prevMerch);
    if (cashDelta === 0 && recvDelta === 0 && merchDelta === 0) continue;

    let kind = 'ADJUST';
    if (prevHid && !curHid) kind = 'RESTORE';
    else if (!prevHid && curHid) kind = 'DELETE';
    else if (prevPay === 0 && curPay !== 0) kind = 'PAY';
    else if (prevPay !== 0 && curPay === 0) kind = 'UNPAY';
    out.push({ billId: cur.id, pId, at, cashDelta, receivableDelta: recvDelta, merchantDelta: merchDelta, kind, ref: { v: cur.v, prevV: prev.v } });
  }
  return out;
}

export const ledgerMethods = {
  // All ledger events for the whole DB, ascending by `at`.
  // O(E) read via indexed `at` column.
  async ledgerAll() {
    const events = (await this._db.ledger.orderBy('at').toArray()).map(withKindName);
    let cash = 0, recv = 0, merch = 0;
    for (const e of events) {
      cash = round2(cash + e.cashDelta);
      recv = round2(recv + e.receivableDelta);
      merch = round2(merch + (e.merchantDelta || 0));
      e.runningCash = cash;
      e.runningReceivable = recv;
      e.runningMerchant = merch;
    }
    return events;
  },

  // Ledger events for one person only, ascending by `at`.
  // O(E) read via compound index `[pId+at]`.
  async ledgerForPerson(pId) {
    const pid = Number(pId);
    if (!Number.isInteger(pid)) return [];
    const events = await this._db.ledger
      .where('[pId+at]')
      .between([pid, Dexie.minKey], [pid, Dexie.maxKey])
      .toArray()
      .then((rows) => rows.map(withKindName));

    let cash = 0, recv = 0, merch = 0;
    for (const e of events) {
      cash = round2(cash + e.cashDelta);
      recv = round2(recv + e.receivableDelta);
      merch = round2(merch + (e.merchantDelta || 0));
      e.runningCash = cash;
      e.runningReceivable = recv;
      e.runningMerchant = merch;
    }
    return events;
  },

  // Ledger events for a whole family group (head + members), ascending by `at`.
  async ledgerForFamily(headId) {
    const ids = await this.familyIds(headId);
    const lists = await Promise.all(ids.map((id) => this.ledgerForPerson(id)));
    // Money this family's head paid toward bills of people who moved out.
    const idSet = new Set(ids.map(Number));
    const pays = await this._db.payments.where('headId').equals(Number(headId)).primaryKeys();
    let moved = [];
    if (pays.length) {
      moved = (await this._db.ledger.where('payId').anyOf(pays).toArray())
        .filter((r) => !idSet.has(Number(r.pId)))
        .map((r) => ({ ...withKindName(r), movedOut: true }));
    }
    const events = [...lists.flat(), ...moved].sort((a, b) => a.at - b.at || (a.id || 0) - (b.id || 0));
    let cash = 0, recv = 0, merch = 0;
    for (const e of events) {
      cash = round2(cash + e.cashDelta);
      recv = round2(recv + e.receivableDelta);
      merch = round2(merch + (e.merchantDelta || 0));
      e.runningCash = cash;
      e.runningReceivable = recv;
      e.runningMerchant = merch;
    }
    return events;
  },

  // Live bills of a whole family group (head + members), newest first.
  async familyBills(headId) {
    const out = [];
    for (const id of await this.familyIds(headId)) out.push(...(await this.billsForPerson(id)));
    return out.sort((a, b) => (b.crtAt || 0) - (a.crtAt || 0) || b.id - a.id);
  },

  // Group events into periods. Returns { rows, opening, closing } where
  // each row = { key, from, to, cashIn, cashOut, netCash, creditGiven,
  //              creditSettled, netReceivable, openingCash, openingReceivable,
  //              closingCash, closingReceivable, events }.
  // mode: 'day' | 'week' | 'month' | 'year'.
  // Person-scoped: pass pId to scope the ledger.
  async ledgerPeriods({ mode = 'day', pId = null } = {}) {
    const events = pId != null ? await this.ledgerForPerson(pId) : await this.ledgerAll();
    const buckets = new Map();
    for (const e of events) {
      const k = periodKey(e.at, mode);
      if (!buckets.has(k)) buckets.set(k, []);
      buckets.get(k).push(e);
    }
    const keys = Array.from(buckets.keys()).sort();
    const rows = [];
    let openCash = 0;
    let openRecv = 0;
    let openMerch = 0;
    for (const k of keys) {
      const list = buckets.get(k);
      let cashIn = 0;
      let cashOut = 0;
      let creditGiven = 0;
      let creditSettled = 0;
      let merchantCost = 0;
      for (const e of list) {
        if (e.cashDelta > 0) cashIn += e.cashDelta;
        else if (e.cashDelta < 0) cashOut += -e.cashDelta;
        if (e.receivableDelta > 0) creditGiven += e.receivableDelta;
        else if (e.receivableDelta < 0) creditSettled += -e.receivableDelta;
        if (e.merchantDelta) merchantCost += e.merchantDelta;
      }
      const closeCash = list[list.length - 1].runningCash;
      const closeRecv = list[list.length - 1].runningReceivable;
      const closeMerch = list[list.length - 1].runningMerchant || 0;
      const { from, to } = periodBounds(list[0].at, mode);
      rows.push({
        key: k, from, to,
        cashIn: round2(cashIn), cashOut: round2(cashOut),
        netCash: round2(cashIn - cashOut),
        creditGiven: round2(creditGiven), creditSettled: round2(creditSettled),
        netReceivable: round2(creditGiven - creditSettled),
        merchantCost: round2(merchantCost),
        openingCash: openCash, openingReceivable: openRecv,
        openingMerchant: openMerch,
        closingCash: closeCash, closingReceivable: closeRecv,
        closingMerchant: closeMerch,
        events: list,
      });
      openCash = closeCash;
      openRecv = closeRecv;
      openMerch = closeMerch;
    }
    return {
      rows,
      openingCash: 0,
      openingReceivable: 0,
      openingMerchant: 0,
      closingCash: rows.length ? rows[rows.length - 1].closingCash : 0,
      closingReceivable: rows.length ? rows[rows.length - 1].closingReceivable : 0,
      closingMerchant: rows.length ? rows[rows.length - 1].closingMerchant : 0,
      events,
    };
  },

  // Admin overview for a scope: everything an owner wants on one screen.
  // opts: { headId = null } -> family scope, else whole lab.
  // Returns { bills, money, mix, dues, aging, top, advance, flow }.
  async ledgerOverview({ headId = null, now = Date.now() } = {}) {
    const db = this._db;
    const DAY = 86400000;
    const bills = headId != null
      ? await this.familyBills(headId)
      : await db.billsProj.where('hid').equals(0).toArray();
    const unpaidIds = bills.filter((b) => Number(b.payment) === PAYMENT.UNPAID).map((b) => b.id);
    const am = await this.allocationsMap(unpaidIds);
    const sum = this.summarizeBills(bills, am);

    // Open dues, aging buckets and top debtors (by person).
    const aging = { d0_7: 0, d8_30: 0, d31_90: 0, d90p: 0 };
    const byPerson = new Map();
    let oldest = 0;
    for (const b of bills) {
      if (Number(b.payment) !== PAYMENT.UNPAID) continue;
      const amt = payableOf(b);
      const left = round2(amt - Math.min(amt, am.get(b.id) || 0));
      if (left <= 0.004) continue;
      const age = Math.max(0, Math.floor((now - (b.crtAt || now)) / DAY));
      if (age <= 7) aging.d0_7 += left;
      else if (age <= 30) aging.d8_30 += left;
      else if (age <= 90) aging.d31_90 += left;
      else aging.d90p += left;
      if (age > oldest) oldest = age;
      byPerson.set(b.pId, round2((byPerson.get(b.pId) || 0) + left));
    }
    for (const k of Object.keys(aging)) aging[k] = round2(aging[k]);
    const top = [];
    for (const [pId, due] of [...byPerson.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)) {
      const p = await this.getPerson(pId);
      top.push({ pId, name: p ? p.name : '#' + pId, due });
    }

    // Cash-book flow from ledger rows (all time, scoped).
    const ev = headId != null ? await this.ledgerForFamily(headId) : await this.ledgerAll();
    let cashIn = 0, refunds = 0, collected = 0, advanceIn = 0, deletedBills = 0;
    for (const e of ev) {
      const c = Number(e.cashDelta) || 0;
      const d = Number(e.receivableDelta) || 0;
      if (c > 0) cashIn += c; else refunds -= c;
      if (e.kind === 'ADVANCE' && c > 0) advanceIn += c;
      if (e.kind === 'PAY' || e.kind === 'PAY_PART' || e.kind === 'ADVANCE_APPLY') collected -= d;
      if (e.kind === 'DELETE') deletedBills += 1;
    }
    const advance = headId != null ? await this.advanceBalance(headId) : await this.totalAdvance();
    const dueCount = bills.filter((b) => Number(b.payment) === PAYMENT.UNPAID).length;
    const avg = sum.count ? round2(sum.total / sum.count) : 0;
    const received = round2(sum.cash + sum.upi + sum.partial);
    return {
      sum,
      avgBill: avg,
      received,
      collectedPct: sum.total > 0 ? Math.round((received / sum.total) * 100) : 0,
      discount: round2(sum.custTotal - sum.total),
      margin: sum.total > 0 ? Math.round((sum.grossProfit / sum.total) * 100) : 0,
      aging,
      top,
      oldestDueDays: oldest,
      openBills: sum.unpaid,
      dueCount,
      advance: round2(advance),
      flow: { cashIn: round2(cashIn), refunds: round2(refunds), collected: round2(collected), advanceIn: round2(advanceIn), deletedBills },
    };
  },

  // Current receivable: sum of pending dues across people (O(K) via 'pending' index).
  async currentReceivable() {
    const rows = await this._db.peopleProj.where('pending').above(0).toArray();
    let sum = 0;
    for (const p of rows) {
      if (!p.hid) sum += Number(p.pending) || 0;
    }
    return round2(sum);
  },
};

export { round2, payableOf, merchOf };
