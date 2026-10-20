// Restore: replay a parsed revision log through the same write path that
// produced it. Attached to DB.prototype via Object.assign in db.js.
//
// Contract: replayLog(ops) clears the revision + projection stores (and
// userRevs — but NOT `users`, whose secrets must survive a restore), then
// applies each op. Bills replay through addBillPreserve so live and restore
// share one write path.
//
// v1: ops carry short keys (id, v, pId, pV, labId, labV, docId, docV, hid,
// crtAt, revAt, uId, uV). Bill items are pins {itemId, itemV, hid}.

import Dexie from 'https://unpkg.com/dexie@4.0.11/dist/modern/dexie.mjs';
import { normPayment } from './norm.js';

// Collect every (kind, id, v) a bill references, for the post-replay check.
// kind is the *Revs store: testRevs / labRevs / doctorRevs / people / userRevs.
function collectRefs(refs, op) {
  if (op.kind !== 'bill') return;
  const push = (kind, id, v) => {
    if (id != null && v != null) refs.push({ kind, id: Number(id), v: Number(v), from: op.id });
  };
  push('people', op.pId, op.pV);
  push('labRevs', op.labId, op.labV);
  push('doctorRevs', op.docId, op.docV);
  push('userRevs', op.uId, op.uV);
  const items = Array.isArray(op.items) ? op.items : [];
  for (const it of items) push('testRevs', it.itemId, it.itemV);
}

// Verify collected refs against the rev tables. Returns the de-duplicated list
// of refs whose [id, v] row is absent. Warn-only: never blocks the restore.
async function verifyRefs(db, refs) {
  const seen = new Set();
  const dangling = [];
  for (const r of refs) {
    const key = r.kind + ':' + r.id + ':' + r.v;
    if (seen.has(key)) continue;
    seen.add(key);
    const table = db[r.kind];
    if (!table) continue;
    const hit = await table.get([r.id, r.v]);
    if (!hit) dangling.push({ kind: r.kind, id: r.id, v: r.v, from: r.from });
  }
  return dangling;
}

export const restoreMethods = {
  async replayLog(ops, { onProgress = null } = {}) {
    const db = this._db;
    return db.transaction(
      'rw',
      db.bills,
      db.billsProj,
      db.people,
      db.peopleProj,
      db.userRevs,
      db.users,
      db.tests,
      db.testRevs,
      db.labs,
      db.labRevs,
      db.doctors,
      db.doctorRevs,
      db.meta,
      db.ledger,
      db.payments,
      db.allocations,
      db.delReqs,
      async () => {
        await db.payments.clear();
        await db.allocations.clear();
        await db.bills.clear();
        await db.billsProj.clear();
        await db.people.clear();
        await db.peopleProj.clear();
        await db.userRevs.clear();
        await db.tests.clear();
        await db.testRevs.clear();
        await db.labs.clear();
        await db.labRevs.clear();
        await db.doctors.clear();
        await db.doctorRevs.clear();
        await db.ledger.clear();
        await db.delReqs.clear();
        // `users` is NOT cleared — passwords live only there.

        const total = ops.length;
        const PROGRESS_MS = 100;
        let lastTick = 0;
        let processed = 0;
        let restored = 0;
        let skipped = 0;
        const skippedRows = [];
        // References seen in the log, checked after replay. Order-independent:
        // a bill may reference a person revision that appears later in the
        // file, so we only verify once every row has been applied.
        const refs = [];
        const tick = (force) => {
          if (!onProgress) return;
          const now = Date.now();
          if (!force && now - lastTick < PROGRESS_MS) return;
          lastTick = now;
          try {
            onProgress({ processed, total, restored, skipped });
          } catch (_) { }
        };

        for (let i = 0; i < ops.length; i++) {
          const op = ops[i];
          processed++;
          try {
            if (op.kind === 'person') await this._replayPerson(op);
            else if (op.kind === 'bill') await this._replayBill(op);
            else if (op.kind === 'user') await this._replayUser(op);
            else if (op.kind === 'test') await this._replayCatalog('tests', op);
            else if (op.kind === 'lab') await this._replayCatalog('labs', op);
            else if (op.kind === 'doctor') await this._replayCatalog('doctors', op);
            else if (op.kind === 'payment') await db.payments.put({ id: op.id, headId: op.headId, amount: op.amount, method: op.method, at: op.at, note: op.note, uId: op.uId, uV: op.uV });
            else if (op.kind === 'allocation') await db.allocations.put({ id: op.id, paymentId: op.paymentId, billId: op.billId, amount: op.amount, at: op.at, ak: Number(op.ak) === 1 ? 1 : 0 });
            else {
              skipped++;
              skippedRows.push({ lineNo: op.lineNo, reason: 'unknown kind', raw: op.raw || '' });
              tick(false);
              continue;
            }
            restored++;
            collectRefs(refs, op);
          } catch (e) {
            skipped++;
            skippedRows.push({ lineNo: op.lineNo, reason: e.message || String(e), raw: op.raw || '' });
          }
          tick(false);
          // Yield to event loop every 100 records to keep UI responsive
          if (i % 100 === 0) {
            await Dexie.waitFor(new Promise((r) => setTimeout(r, 0)));
          }
        }
        tick(true);

        // Facts are loaded; derive ledger + pending once, from facts only.
        await this._rederive(Array.from(await db.people.orderBy('id').uniqueKeys()));

        // Warn-only reference check: every id+version a bill points at should
        // exist in the log. Dangling refs mean a truncated/corrupt backup, not
        // a fatal error — the bill rows still carry their frozen totals.
        const danglingRefs = await verifyRefs(db, refs);
        // No payment/allocation rows parsed. Either a pre-v7 log (part payments
        // and advance cannot be reconstructed) or a current lab that simply has
        // none — both are safe to restore, so this is a soft hint only.
        const hasMoneyOps = ops.some((o) => o.kind === 'payment' || o.kind === 'allocation');
        const legacyNoPayments = restored > 0 && !hasMoneyOps;
        return { count: restored, skipped, skippedRows, danglingRefs, legacyNoPayments };
      }
    );
  },

  async _replayPerson(op) {
    const db = this._db;
    if (op.id == null || op.v == null) throw new Error('person: missing id/v');
    const exists = await db.people.get([op.id, op.v]);
    if (!exists) {
      await db.people.add({
        id: op.id,
        v: op.v,
        name: op.name || '',
        mob: op.mob || '',
        age: op.age != null ? op.age : null,
        gender: op.gender != null ? op.gender : null,
        weight: op.weight != null ? op.weight : null,
        discount_per: op.discount_per != null ? op.discount_per : null,
        headId: op.headId != null ? op.headId : null,
        hid: op.hid ? 1 : 0,
        crtAt: op.crtAt || Date.now(),
        revAt: op.revAt || op.crtAt || Date.now(),
        uId: op.uId != null ? op.uId : null,
        uV: op.uV != null ? op.uV : null,
      });
    }
    await this._putPersonProj(op.id);
  },

  async _replayBill(op) {
    const db = this._db;
    if (op.id == null || op.v == null) throw new Error('bill: missing id/v');
    if (op.pId == null) throw new Error('bill: missing pId');
    const exists = await db.bills.get([op.id, op.v]);
    if (!exists) {
      const pins = Array.isArray(op.items)
        ? op.items.map((it) => ({
          itemId: Number(it.itemId),
          itemV: Number(it.itemV),
          hid: it.hid ? 1 : 0,
        }))
        : [];
      await db.bills.add({
        id: op.id,
        v: op.v,
        labId: op.labId != null ? Number(op.labId) : 0,
        labV: op.labV != null ? Number(op.labV) : null,
        docId: op.docId != null ? Number(op.docId) : 0,
        docV: op.docV != null ? Number(op.docV) : null,
        pId: op.pId,
        pV: op.pV != null ? Number(op.pV) : null,
        datetime: op.datetime || '',
        items: pins,
        disc_amt: op.disc_amt != null ? op.disc_amt : 0,
        cust_total: op.cust_total != null ? op.cust_total : 0,
        merch_total: op.merch_total != null ? op.merch_total : 0,
        cust_payable: op.cust_payable != null ? op.cust_payable : 0,
        grand_total: op.grand_total != null ? op.grand_total : 0,
        payment: normPayment(op.payment),
        hid: op.hid ? 1 : 0,
        crtAt: op.crtAt || Date.now(),
        revAt: op.revAt || op.crtAt || Date.now(),
        uId: op.uId != null ? op.uId : null,
        uV: op.uV != null ? op.uV : null,
      });
    }
    await this._putBillProj(op.id);
    await this._putPersonProj(op.pId);
  },

  // Replay a catalog revision into <table>Revs and rebuild the current-state
  // row from the newest revision for that id (soft-deleted rows stay hid).
  async _replayCatalog(table, op) {
    const db = this._db;
    if (op.id == null || op.v == null) throw new Error(table + ': missing id/v');
    const revs = table === 'tests' ? db.testRevs : table === 'labs' ? db.labRevs : db.doctorRevs;
    const exists = await revs.get([op.id, op.v]);
    if (!exists) {
      const rev = {
        id: op.id,
        v: op.v,
        name: op.name || '',
        hid: op.hid ? 1 : 0,
        crtAt: op.crtAt || Date.now(),
        revAt: op.revAt || op.crtAt || Date.now(),
        uId: op.uId != null ? op.uId : null,
        uV: op.uV != null ? op.uV : null,
      };
      if (table === 'tests') {
        rev.sell = op.sell != null ? op.sell : 0;
        rev.buy = op.buy != null ? op.buy : 0;
        rev.code = op.code || '';
        rev.sample = op.sample || '';
        rev.info = op.info || '';
        rev.tat = op.tat || '';
      }
      await revs.add(rev);
    }
    const newest = await revs
      .where('[id+v]')
      .between([op.id, Dexie.minKey], [op.id, Dexie.maxKey])
      .last();
    if (newest) {
      const row = { id: op.id, name: newest.name, hid: newest.hid ? 1 : 0 };
      if (table === 'tests') {
        row.sell = newest.sell || 0;
        row.buy = newest.buy || 0;
        row.code = newest.code || '';
        row.sample = newest.sample || '';
        row.info = newest.info || '';
        row.tat = newest.tat || '';
      }
      await db[table].put(row);
    }
  },

  // Replay a user revision into userRevs ONLY. The `users` projection (which
  // holds secrets) is preserved, but role/disabled are synced from the log.
  async _replayUser(op) {
    const db = this._db;
    if (op.id == null || op.v == null) throw new Error('user: missing id/v');
    const exists = await db.userRevs.get([op.id, op.v]);
    if (!exists) {
      await db.userRevs.add({
        id: op.id,
        v: op.v,
        username: op.username || '',
        role: op.role === 'admin' ? 'admin' : 'user',
        disabled: op.disabled ? 1 : 0,
        crtAt: op.crtAt || new Date().toISOString(),
        revAt: op.revAt || op.crtAt || new Date().toISOString(),
      });
    }
    const proj = await db.users.get(op.id);
    if (!proj) {
      await db.users.add({
        id: op.id,
        username: op.username || '',
        role: op.role === 'admin' ? 'admin' : 'user',
        salt: '',
        hash: '',
        iter: 0,
        disabled: op.disabled ? 1 : 0,
        sessionToken: '',
        crtAt: op.crtAt || new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        lastLoginAt: null,
      });
    } else {
      // Sync role and disabled from the log, preserving secrets and session.
      await db.users.update(op.id, {
        username: op.username || proj.username,
        role: op.role === 'admin' ? 'admin' : 'user',
        disabled: op.disabled ? 1 : 0,
      });
    }
  },
};
