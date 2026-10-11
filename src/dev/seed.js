// Dev-only bulk seed / clear. Loaded dynamically by app.js under ?dev=1.
//
// Seeds through the REAL write path (db.addBill) so the people projection,
// personId linking, journal, and local datetime are all correct — no duplicated
// logic. The default (20 bills) is tiny; per-bill writes are fine.
//
// v1: catalogs are revisioned; bills pin items as {itemId,itemV}. Seed looks
// up the latest testV for each chosen test to pin.

import db from '../core/db.js';
import { toLocalInput } from '../core/time.js';
import { normName } from '../core/norm.js';
import { SAMPLE_TESTS, LABS, DOCTORS } from './catalog-data.js';

const FIRST_M = ['Ramesh', 'Suresh', 'Mahesh', 'Rajesh', 'Naresh', 'Dinesh', 'Mukesh', 'Rakesh', 'Ganesh', 'Arjun', 'Karan', 'Rohan', 'Rahul', 'Amit', 'Sumit', 'Nikhil', 'Vikram', 'Manish', 'Sandeep', 'Imran', 'Salman', 'Aamir', 'Rizwan', 'Arif'];
const FIRST_F = ['Priya', 'Anita', 'Sunita', 'Kavita', 'Rekha', 'Meena', 'Geeta', 'Seema', 'Neha', 'Pooja', 'Deepa', 'Rani', 'Nisha', 'Ritu', 'Divya', 'Shreya', 'Tanya', 'Sneha', 'Aarti', 'Swati', 'Zoya', 'Fatima', 'Ayesha', 'Sana'];
const LAST = ['Kumar', 'Sharma', 'Patel', 'Singh', 'Gupta', 'Verma', 'Yadav', 'Joshi', 'Nair', 'Reddy', 'Chauhan', 'Mehta', 'Shah', 'Desai', 'Iyer', 'Rao', 'Bansal', 'Mishra', 'Tiwari', 'Agarwal'];

function randPatient() {
  const gender = Math.random() < 0.5 ? 'M' : 'F';
  const first = pick(gender === 'M' ? FIRST_M : FIRST_F);
  return {
    name: first + ' ' + pick(LAST),
    gender,
    mob: randMobile(),
    age: randInt(1, 85),
    weight: gender === 'M' ? randInt(50, 95) : randInt(40, 80),
  };
}

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}
function randInt(min, max) {
  return min + Math.floor(Math.random() * (max - min + 1));
}
function randMobile() {
  let s = String(randInt(6, 9));
  for (let i = 0; i < 9; i++) s += String(randInt(0, 9));
  return s;
}

// Look up the newest testRevs v for a tests row id.
async function latestTestV(id) {
  const last = await db.raw.testRevs
    .where('[id+v]')
    .between([id, -Infinity], [id, Infinity])
    .last();
  return last ? last.v : 1;
}

export async function seed({ bills = 1000, patients = 50, onProgress = null, reset = true } = {}) {
  await db.openDb();
  const raw = db.raw;
  // Progress display + event-loop yielding are owned by the injected onProgress
  // (see ui/progress.js). Tick every bill and await the result; the progress
  // object yields to the painter on its own ~100ms budget.
  const tick = (processed, phase) => {
    if (onProgress) return onProgress({ phase, processed, total: bills });
    return null;
  };

  if (reset) {
    await raw.transaction(
      'rw',
      raw.bills, raw.billsProj, raw.people, raw.peopleProj, raw.ledger, raw.payments, raw.allocations,
      async () => {
        await raw.payments.clear();
        await raw.allocations.clear();
        await raw.bills.clear();
        await raw.billsProj.clear();
        await raw.people.clear();
        await raw.peopleProj.clear();
        await raw.ledger.clear();
      }
    );
  }

  await tick(0, 'catalog');

  // Names are stored UPPERCASE (normName), so match against the normalized form
  // — otherwise every seed run appends a duplicate row.
  for (const t of SAMPLE_TESTS) {
    const found = await raw.tests.where('name').equals(normName(t.name)).first();
    if (!found) await db.addTest(t);
  }
  for (const name of LABS) {
    const found = await raw.labs.where('name').equals(normName(name)).first();
    if (!found) await db.addLab({ name });
  }
  for (const name of DOCTORS) {
    const found = await raw.doctors.where('name').equals(normName(name)).first();
    if (!found) await db.addDoctor({ name });
  }
  const allTests = await db.listTests();
  if (!allTests.length) return { bills: 0 };

  const allLabs = await db.listLabs();
  const allDoctors = await db.listDoctors();

  // Pin each test to its latest rev once (testV).
  const testPins = [];
  for (const t of allTests) {
    testPins.push({ id: t.id, v: await latestTestV(t.id) });
  }
  const labPins = [];
  for (const l of allLabs) labPins.push({ id: l.id });
  const docPins = [];
  for (const d of allDoctors) docPins.push({ id: d.id });

  const now = Date.now();
  const existingTop = await raw.billsProj.orderBy('id').last();
  const startNo = existingTop && existingTop.id > 0 ? existingTop.id + 1 : 1;

  const poolSize = Math.max(1, Math.min(patients || Math.ceil(bills * 0.6), bills));
  const pool = [];
  for (let p = 0; p < poolSize; p++) pool.push(randPatient());

  for (let i = 0; i < bills; i++) {
    const chosen = testPins.slice().sort(() => Math.random() - 0.5).slice(0, randInt(1, 4));
    const items = chosen.map((p) => ({ itemId: p.id, itemV: p.v, hid: 0 }));

    const patient = pick(pool);
    const created = now - i * randInt(2, 4) * 3600_000;
    const d = new Date(created);
    // Random business hour 9–18, but never in the future: cap today's hour at
    // the current time so recent bills don't read as "just now"/future.
    let hh = randInt(9, 18);
    let mm = randInt(0, 59);
    const today = new Date();
    if (d.toDateString() === today.toDateString()) {
      const curH = today.getHours();
      const curM = today.getMinutes();
      if (hh > curH) { hh = curH; mm = randInt(0, curM); }
      else if (hh === curH && mm > curM) { mm = randInt(0, curM); }
    }
    d.setHours(hh, mm, 0, 0);

    const r = Math.random();
    const discount_per = r < 0.72 ? null : r < 0.85 ? 5 : r < 0.95 ? 10 : 15;

    const rp = Math.random();
    const payment = rp < 0.3 ? 0 : rp < 0.65 ? 1 : 2;

    const lab = pick(labPins);
    const doc = pick(docPins);

    await db.addBill({
      id: startNo + i,
      labId: lab.id,
      docId: doc.id,
      name: patient.name,
      mob: patient.mob,
      age: patient.age,
      gender: patient.gender,
      weight: patient.weight,
      datetime: toLocalInput(d),
      crtAt: d.getTime(),
      items,
      discount_per,
      payment,
    });
    await tick(i, 'bills');
  }
  await tick(bills, 'bills');
  return { bills, patients: pool.length };
}

// Defaults for seed(); a blank/non-numeric prompt keeps the default per field.
export const SEED_CONFIG = { bills: 1000, patients: 700 };

// Prompt for seed size. Blank/non-numeric keeps the default; null if cancelled.
// Kept in the dev module so the UI layer stays free of seeding policy.
export function promptSeedConfig() {
  const ask = (label, def) => {
    const raw = window.prompt(`${label} (default ${def})`, String(def));
    if (raw === null) return null; // cancelled
    const s = raw.trim();
    if (s === '') return def;
    const n = Math.floor(Number(s));
    return Number.isFinite(n) && n > 0 ? n : def;
  };
  const bills = ask('Bills to generate', SEED_CONFIG.bills);
  if (bills === null) return null;
  const patients = ask('Patient pool size', SEED_CONFIG.patients);
  if (patients === null) return null;
  return { bills, patients };
}

export async function clearAll() {
  await db.openDb();
  const raw = db.raw;
  await raw.transaction(
    'rw',
    raw.tests, raw.labs, raw.doctors,
    raw.testRevs, raw.labRevs, raw.doctorRevs,
    raw.bills, raw.billsProj, raw.people, raw.peopleProj, raw.ledger, raw.payments, raw.allocations,
    async () => {
      await raw.payments.clear();
      await raw.allocations.clear();
      await raw.tests.clear();
      await raw.labs.clear();
      await raw.doctors.clear();
      await raw.testRevs.clear();
      await raw.labRevs.clear();
      await raw.doctorRevs.clear();
      await raw.bills.clear();
      await raw.billsProj.clear();
      await raw.people.clear();
      await raw.peopleProj.clear();
      await raw.ledger.clear();
    }
  );
  db._invalidateTests();
  db._invalidateLabs();
  db._invalidateDoctors();
}
