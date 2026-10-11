// Export + projection rebuild. Attached to DB.prototype via Object.assign.
//
// exportAll() serializes every revision (users, catalogs, people, bills) as
// the log: #details line, #head block, then one row per revision.
// rebuildProj() recovers the projection tables from the revision tables.

import Dexie from 'https://unpkg.com/dexie@4.0.11/dist/modern/dexie.mjs';
import {
  detailsLine,
  csvHeaderLine,
  userRevToLogLine,
  personRevToLogLine,
  billRevToLogLine,
  testRevToLogLine,
  labRevToLogLine,
  doctorRevToLogLine,
  paymentToLogLine,
  allocationToLogLine,
} from '../backup/csv.js';

export const exportMethods = {
  async exportAll() {
    const db = this._db;
    const users = (await db.userRevs.toArray()).sort((a, b) => a.id - b.id || a.v - b.v);
    const people = (await db.people.toArray()).sort((a, b) => a.id - b.id || a.v - b.v);
    const bills = (await db.bills.toArray()).sort((a, b) => a.id - b.id || a.v - b.v);
    const tests = (await db.testRevs.toArray()).sort((a, b) => a.id - b.id || a.v - b.v);
    const labs = (await db.labRevs.toArray()).sort((a, b) => a.id - b.id || a.v - b.v);
    const doctors = (await db.doctorRevs.toArray()).sort((a, b) => a.id - b.id || a.v - b.v);
    const pays0 = (await db.payments.toArray()).sort((a, b) => a.id - b.id);
    const allocs0 = (await db.allocations.toArray()).sort((a, b) => a.id - b.id);
    const lines = [
      detailsLine('v' + this.APP_VERSION, new Date().toISOString(), {
        bills: bills.length,
        people: people.length,
        tests: tests.length,
        labs: labs.length,
        doctors: doctors.length,
        payments: pays0.length,
        allocations: allocs0.length,
        users: users.length,
      }),
      csvHeaderLine(),
    ];
    for (const u of users) lines.push(userRevToLogLine(u));
    for (const t of tests) lines.push(testRevToLogLine(t));
    for (const l of labs) lines.push(labRevToLogLine(l));
    for (const d of doctors) lines.push(doctorRevToLogLine(d));
    for (const p of people) lines.push(personRevToLogLine(p));
    for (const b of bills) lines.push(billRevToLogLine(b));
    for (const p of pays0) lines.push(paymentToLogLine(p));
    for (const a of allocs0) lines.push(allocationToLogLine(a));
    return {
      text: lines.join('\n') + '\n',
      count:
        users.length + tests.length + labs.length + doctors.length +
        people.length + bills.length,
    };
  },

  async rebuildProj() {
    const db = this._db;
    return db.transaction('rw', db.bills, db.billsProj, db.people, db.peopleProj, db.ledger, db.payments, db.allocations, async () => {
      await db.billsProj.clear();
      await db.peopleProj.clear();
      await db.ledger.clear();
      const billIds = new Set();
      await db.bills.each((r) => billIds.add(r.id));
      let count = 0;
      for (const id of billIds) {
        await this._putBillProj(id);
        if (++count % 100 === 0) await Dexie.waitFor(new Promise((r) => setTimeout(r, 0)));
      }
      const personIds = new Set();
      await db.people.each((r) => personIds.add(r.id));
      count = 0;
      for (const id of personIds) {
        await this._putPersonProj(id);
        if (++count % 100 === 0) await Dexie.waitFor(new Promise((r) => setTimeout(r, 0)));
      }

      // Ledger + pending are derived from facts by the single derive engine.
      await this._rederive(Array.from(personIds));

      return { bills: await db.billsProj.count(), people: await db.peopleProj.count() };
    });
  },
};
