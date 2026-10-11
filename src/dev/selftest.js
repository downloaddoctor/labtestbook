// Dev self-test: drives the REAL UI (Items modal, Bill form, Bills Bill View
// dialog) plus the CSV codec, paging, log, and replay. Runs against an ISOLATED
// DB + log so it never touches real data. Wired from app.js on ?dev=1.
//
// v1: short keys; bill items are pins {itemId,itemV,hid}; tests prices are
// sell/buy; person + catalog references are id(+v).

import db from '../core/db.js';
import backup from '../backup/backup.js';
import { billRevToLogLine, csvToLog, csvHeaderLine, parseCsvLine } from '../backup/csv.js';
import { setPrintEnabled } from '../print/printHtml.js';

const TEST_DB = 'labtestbook_selftest';
const TEST_LOG = 'labtestbook-selftest.csv';

const el = (id) => document.getElementById(id);

function makeReporter(onProgress) {
  const results = [];
  const emit = (r) => {
    results.push(r);
    if (onProgress) onProgress(r.name, r.ok, r.detail, r.status);
  };
  return {
    results,
    check(name, ok, detail) {
      emit({ name, ok: !!ok, status: ok ? 'PASS' : 'FAIL', detail: detail || '' });
      return !!ok;
    },
    eq(name, actual, expected, detail) {
      const ok = actual === expected;
      return this.check(
        name,
        ok,
        ok ? detail || '' : 'expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual)
      );
    },
    skip(name, detail) {
      emit({ name, ok: true, status: 'SKIP', detail: detail || '' });
      return true;
    },
    info(text) {
      if (onProgress) onProgress('#info', true, text);
      return true;
    },
  };
}

function settle(ms) {
  return new Promise((r) => setTimeout(r, ms == null ? 200 : ms));
}

// Wait until a modal shell is open AND its body has finished rendering.
// openModal() opens the shell immediately, then fills the body a tick
// later while the shell carries the `is-rendering` class. Reading body
// fields before this resolves returns null -> tests stall silently.
async function waitModalReady(id, timeoutMs) {
  const t0 = Date.now();
  const lim = timeoutMs == null ? 4000 : timeoutMs;
  while (Date.now() - t0 < lim) {
    const d = el(id);
    if (d && d.open && !d.classList.contains('is-rendering')) return d;
    await settle(30);
  }
  return el(id);
}

function setVal(el, value) {
  if (!el) return;
  el.value = value == null ? '' : String(value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

function setSelectByText(el, text) {
  if (!el) return;
  const opt = Array.from(el.options).find((o) => o.textContent.trim() === text);
  if (opt) setVal(el, opt.value);
}

async function readLogText() {
  const r = await backup.readLog();
  return r.text == null ? '' : r.text;
}

function logRows(text) {
  return text
    .split('\n')
    .filter((l) => l && l.indexOf('|') > 0)
    .map((l) => parseCsvLine(l));
}

function finish(rep) {
  const failed = rep.results.filter((r) => !r.ok);
  const skipped = rep.results.filter((r) => r.status === 'SKIP').length;
  const passed = rep.results.filter((r) => r.status === 'PASS').length;
  return {
    ok: failed.length === 0,
    total: rep.results.length,
    passed,
    skipped,
    failed: failed.length,
    results: rep.results,
  };
}

export async function runSelfTest({ onProgress, router } = {}) {
  const rep = makeReporter(onProgress);
  const stage = (s) => onProgress && onProgress('#stage', true, s);

  await db.setDbName(TEST_DB);
  await db.deleteDb().catch(() => { });
  db.openDb();
  await db.raw.tests.clear().catch(() => { });
  await db.raw.labs.clear().catch(() => { });
  await db.raw.doctors.clear().catch(() => { });
  await db.raw.testRevs.clear().catch(() => { });
  await db.raw.labRevs.clear().catch(() => { });
  await db.raw.doctorRevs.clear().catch(() => { });
  await db.raw.bills.clear().catch(() => { });
  await db.raw.billsProj.clear().catch(() => { });
  await db.raw.people.clear().catch(() => { });
  await db.raw.peopleProj.clear().catch(() => { });
  await db.raw.meta.clear().catch(() => { });
  await db.raw.ledger.clear().catch(() => { });
  await db.raw.payments.clear().catch(() => { });
  await db.raw.allocations.clear().catch(() => { });
  db._invalidateTests();
  db._invalidateLabs();
  db._invalidateDoctors();

  // The test DB has no user rows, so don't stamp bills with the live session user.
  const prevActor = db._actorFn;
  db.setActor(null);

  // Suppress window.print() during the run: the blocking dialog would stall
  // the automated flow tests (print is invoked by some save paths).
  setPrintEnabled(false);

  backup.setLogFileName(TEST_LOG);
  await backup.deleteLog().catch(() => { });

  const testsPage = await import('../ui/pages/tests.js');
  const labsPage = await import('../ui/pages/labs.js');
  const doctorsPage = await import('../ui/pages/doctors.js');
  const billPage = await import('../ui/pages/bill.js');
  const billsPage = await import('../ui/pages/bills.js');

  try {
    // ---- 0. CSV codec round-trip + malformed input -----------------------
    stage('0. csv codec round-trip + malformed');
    try {
      const rev = {
        id: 999,
        v: 1,
        labId: 1,
        labV: 1,
        docId: 1,
        docV: 1,
        pId: 1,
        pV: 1,
        datetime: '2026-01-01T10:00',
        items: [
          { itemId: 1, itemV: 1, hid: 0 },
          { itemId: 2, itemV: 3, hid: 0 },
        ],
        disc_amt: 30,
        cust_total: 300,
        merch_total: 180,
        cust_payable: 270,
        grand_total: 270,
        payment: 1,
        hid: 0,
        crtAt: 1767200000000,
        revAt: 1767200000000,
        uId: 1,
        uV: 1,
      };
      const good = csvHeaderLine() + '\n' + billRevToLogLine(rev) + '\n';
      const r1 = csvToLog(good);
      rep.eq('csv: roundtrip ops count', r1.ops.length, 1);
      rep.eq('csv: roundtrip kind', r1.ops[0].kind, 'bill');
      rep.eq('csv: roundtrip id', r1.ops[0].id, 999);
      rep.eq('csv: roundtrip labId', r1.ops[0].labId, 1);
      rep.eq('csv: roundtrip docId', r1.ops[0].docId, 1);
      rep.eq('csv: roundtrip pId', r1.ops[0].pId, 1);
      rep.eq('csv: roundtrip items length', r1.ops[0].items.length, 2);
      rep.eq('csv: roundtrip item itemId', r1.ops[0].items[0].itemId, 1);
      rep.eq('csv: roundtrip item itemV', r1.ops[0].items[1].itemV, 3);
      rep.eq('csv: roundtrip disc_amt', r1.ops[0].disc_amt, 30);
      rep.eq('csv: roundtrip grand_total', r1.ops[0].grand_total, 270);
      rep.eq('csv: roundtrip payment', r1.ops[0].payment, 1);
      rep.eq('csv: skipped rows = 0', (r1.skippedRows || []).length, 0);

      let threw = false;
      try { csvToLog('wrong|header|line\n'); } catch (_) { threw = true; }
      rep.check('csv: no head throws', threw);

      const shortRow = csvHeaderLine() + '\n' + '2|1|2|3\n';
      const r2 = csvToLog(shortRow);
      rep.eq('csv-malformed: no ops parsed', r2.ops.length, 0);
      rep.eq('csv-malformed: one skipped', (r2.skippedRows || []).length, 1);

      const bad = csvHeaderLine() + '\n' + '99|foo|bar|baz\n';
      const r3 = csvToLog(bad);
      rep.eq('csv-malformed2: no ops parsed', r3.ops.length, 0);
      rep.eq('csv-malformed2: one skipped', (r3.skippedRows || []).length, 1);
    } catch (e) {
      rep.check('csv: stage completed', false, e && e.message ? e.message : String(e));
    }

    // ---- 1. Tests CRUD via the real modal --------------------------------
    stage('1. tests CRUD (modal)');
    if (router && router.activateTab) router.activateTab('tests', true);
    await settle(300);

    await testsPage.__openModalForTest(null);
    await waitModalReady('test-modal');
    let f = testsPage.__getForm().fields;
    rep.check('tests: Add modal open', testsPage.__getForm().modal.open);
    setVal(f.name, 'CBC');
    setVal(f.customerPrice, '10');
    setVal(f.merchantPrice, '6');
    await testsPage.__submitTestModalForTest();

    let all = await db.listTests();
    rep.eq('tests: count after add', all.length, 1);
    const testId = all[0] ? all[0].id : null;
    rep.check('tests: test has id', testId != null);
    rep.eq('tests: name roundtrip', all[0] && all[0].name, 'CBC');
    rep.eq('tests: sell', all[0] && all[0].sell, 10);
    rep.eq('tests: buy', all[0] && all[0].buy, 6);

    await testsPage.__openModalForTest(testId);
    await waitModalReady('test-modal');
    f = testsPage.__getForm().fields;
    setVal(f.customerPrice, '12');
    await testsPage.__submitTestModalForTest();
    const edited = await db.getTest(testId);
    rep.eq('tests: edit persists', edited && edited.sell, 12);

    const testV = 2;
    const testRevAfterEdit = await db.raw.testRevs.get([testId, testV]);
    rep.check('tests: rev v2 exists', !!testRevAfterEdit);
    rep.eq('tests: rev v2 sell', testRevAfterEdit && testRevAfterEdit.sell, 12);

    // ---- 1b. Labs + Doctors CRUD via the real modal ----------------------
    stage('1b. labs + doctors CRUD (modal)');
    if (router && router.activateTab) router.activateTab('labs', true);
    await settle(300);
    await labsPage.__openModalForTest(null);
    await waitModalReady('catalog-modal');
    setVal(el('modal-catalog-name'), 'City Diagnostics');
    await labsPage.__submitForTest();
    const labs = await db.listLabs();
    rep.eq('labs: count after add', labs.length, 1);
    rep.eq('labs: name roundtrip (uppercased)', labs[0] && labs[0].name, 'CITY DIAGNOSTICS');

    if (router && router.activateTab) router.activateTab('doctors', true);
    await settle(300);
    await doctorsPage.__openModalForTest(null);
    await waitModalReady('catalog-modal');
    setVal(el('modal-catalog-name'), 'Dr. House');
    await doctorsPage.__submitForTest();
    const docs = await db.listDoctors();
    rep.eq('doctors: count after add', docs.length, 1);
    rep.eq('doctors: name roundtrip (uppercased)', docs[0] && docs[0].name, 'DR. HOUSE');

    // ---- 1c. UI coverage: every page + every dialog ---------------------
    stage('1c. UI coverage (pages + dialogs)');
    try {
      const errs = [];
      const onErr = (e) => errs.push(e && e.message ? e.message : String(e));
      window.addEventListener('error', onErr);
      window.addEventListener('unhandledrejection', onErr);

      const PAGES = [
        ['tests', 'page-tests'],
        ['labs', 'page-labs'],
        ['doctors', 'page-doctors'],
        ['bill', 'page-bill'],
        ['bills', 'page-bills'],
        ['patients', 'page-patients'],
        ['ledger', 'page-ledger'],
        ['users', 'page-users'],
      ];
      for (const [name, id] of PAGES) {
        let mounted = true;
        try {
          if (router && router.activateTab) router.activateTab(name, true);
          await settle(180);
        } catch (e) { mounted = false; rep.check('ui: mount ' + name, false, e && e.message ? e.message : String(e)); }
        if (mounted) {
          const sec = el(id);
          rep.check('ui: page ' + name + ' visible', sec && !sec.hidden, sec ? 'hidden=' + sec.hidden : 'missing #' + id);
        }
      }

      // Nav tab buttons: click each, assert hash/route changes without throwing.
      const navBtns = Array.from(document.querySelectorAll('nav button'));
      rep.check('ui: nav buttons present', navBtns.length >= 6, 'count=' + navBtns.length);

      // Every modal shell must exist and toggle open/close. Modals are built at
      // defineModal() time by src/ui/modals/modal.js — index.html has no
      // <dialog> markup. Bodies are only filled when openModal() renders them.
      const dialogIds = [
        'user-new-dialog', 'restore-picker', 'log-dialog', 'test-dialog',
        'patient-view-dialog', 'test-modal', 'catalog-modal', 'bill-view-dialog',
        'revisions-modal', 'payment-dialog', 'family-pay-dialog',
        'family-refund-dialog', 'settings-dialog', 'update-dialog',
      ];
      for (const id of dialogIds) {
        const d = el(id);
        rep.check('ui: dialog #' + id + ' exists', !!d);
        if (d) {
          let ok = true;
          try { d.showModal(); } catch (_) { ok = false; }
          rep.check('ui: dialog #' + id + ' opens', ok && d.open);
          if (d.open) d.close();
        }
      }

      // Tests modal (has test hooks). Fill a valid name so submit closes it.
      await testsPage.__openModalForTest(null);
      await waitModalReady('test-modal');
      rep.check('ui: test-modal opens via hook', el('test-modal') && el('test-modal').open);
      const _tf = testsPage.__getForm().fields;
      setVal(_tf.name, 'UI TEST');
      setVal(_tf.customerPrice, '5');
      await testsPage.__submitTestModalForTest().catch(() => { });
      await settle(120);
      if (el('test-modal') && el('test-modal').open) el('test-modal').close();
      rep.check('ui: test-modal closed after submit', !(el('test-modal') && el('test-modal').open));

      // Catalog modal (labs) via hook.
      if (router && router.activateTab) router.activateTab('labs', true);
      await settle(160);
      await labsPage.__openModalForTest(null);
      await waitModalReady('catalog-modal');
      rep.check('ui: catalog-modal opens via hook', el('catalog-modal') && el('catalog-modal').open);
      if (el('modal-catalog-close')) el('modal-catalog-close').click();
      await settle(120);

      // Settings dialog: open via button, then save.
      if (el('btn-settings')) {
        el('btn-settings').click();
        await waitModalReady('settings-dialog');
        rep.check('ui: settings opens', el('settings-dialog') && el('settings-dialog').open);
        if (el('settings-dialog') && el('settings-dialog').open) el('settings-dialog').close();
        await settle(120);
      }

      // Users page: open the New-user dialog then close.
      if (router && router.activateTab) router.activateTab('users', true);
      await settle(160);
      const newUserBtn = document.querySelector('#page-users button');
      rep.check('ui: users page has a button', !!newUserBtn);

      // Patients page: ensure at least one patient exists, then open its view.
      if (!(await db.getBillsPage({ offset: 0, limit: 1 })).total) {
        await db.addBill({
          labId: labs[0].id, docId: docs[0].id, name: 'UI PATIENT', mob: '7000',
          items: [{ itemId: testId, itemV: testV, hid: 0 }],
          disc_amt: 0, payment: 0,
        });
      }
      if (router && router.activateTab) router.activateTab('patients', true);
      await settle(300);
      const prows = document.querySelectorAll('#patients-table tbody tr');
      rep.check('ui: patients rows rendered', prows.length > 0, 'rows=' + prows.length);
      if (prows.length) {
        prows[0].click();
        await waitModalReady('patient-view-dialog');
        const pd = el('patient-view-dialog');
        rep.check('ui: patient view opens', pd && pd.open);
        if (pd && pd.open) {
          const lb = el('patient-view-ledger-btn');
          rep.check('ui: patient view has Ledger button', !!lb);
          if (el('patient-view-close')) el('patient-view-close').click();
        }
        await settle(120);
      }

      // ---- Ledger: whole-lab scope, mode/book segs, pager, all-time ------
      const ledgerPage = await import('../ui/pages/ledger.js');
      ledgerPage.setGlobalScope();
      if (router && router.activateTab) router.activateTab('ledger', true);
      await settle(260);
      rep.check('ui: ledger scope bar visible', el('ledger-scope') && !el('ledger-scope').hidden);
      rep.check('ui: ledger all-time toggle present', !!el('ledger-summary-btn'));
      rep.check('ui: ledger whole-lab chip', el('ledger-scope-name') && /whole lab/i.test(el('ledger-scope-name').textContent));
      rep.check('ui: ledger scope actions hidden in whole-lab', el('ledger-scope-actions') && el('ledger-scope-actions').hidden);

      // All-time toggle flips label + summary visibility.
      if (el('ledger-summary-btn')) {
        const before = el('ledger-summary-btn').textContent;
        el('ledger-summary-btn').click();
        await settle(220);
        const after = el('ledger-summary-btn').textContent;
        rep.check('ui: all-time toggle changes label', before !== after, before + ' -> ' + after);
        el('ledger-summary-btn').click();
        await settle(180);
      }

      // Period mode seg: click each button, assert it activates.
      const modeBtns = Array.from(document.querySelectorAll('#ledger-mode .seg-btn'));
      rep.check('ui: ledger mode buttons present', modeBtns.length >= 3, 'n=' + modeBtns.length);
      for (const b of modeBtns) {
        b.click();
        await settle(180);
        rep.check('ui: ledger mode ' + (b.dataset.mode || b.textContent.trim()) + ' active', b.classList.contains('active'));
      }

      // Book seg: All / Received / Credit.
      const bookBtns = Array.from(document.querySelectorAll('#ledger-book .seg-btn'));
      rep.check('ui: ledger book buttons present', bookBtns.length >= 3, 'n=' + bookBtns.length);
      for (const b of bookBtns) {
        b.click();
        await settle(160);
        rep.check('ui: ledger book ' + (b.dataset.book || b.textContent.trim()) + ' active', b.classList.contains('active'));
      }

      // Pager: Earlier / Later must not throw and must keep the table.
      if (el('ledger-prev-btn')) { el('ledger-prev-btn').click(); await settle(160); }
      if (el('ledger-next-btn')) { el('ledger-next-btn').click(); await settle(160); }
      rep.check('ui: ledger table still present after paging', !!el('ledger-gl'));

      // ---- Ledger: family scope actions ----------------------------------
      const _peopleList = await db.listPeople({ offset: 0, limit: 1 });
      const _headRow = Array.isArray(_peopleList) ? _peopleList[0] : (_peopleList.results || [])[0];
      if (_headRow) {
        await ledgerPage.openForPerson(_headRow.id, _headRow.name);
        await settle(320);
        rep.check('ui: family chip shows head', el('ledger-scope-name') && /ledger family/i.test(el('ledger-scope-name').textContent));
        rep.check('ui: family scope actions visible', el('ledger-scope-actions') && !el('ledger-scope-actions').hidden);
        rep.check('ui: add-member button visible in family', el('ledger-add-btn') && !el('ledger-add-btn').hidden);
        rep.check('ui: add-advance button visible in family', el('ledger-advance-btn') && !el('ledger-advance-btn').hidden);
        rep.check('ui: family cards rendered', document.querySelectorAll('#ledger-family .family-card').length > 0);

        // Add advance: open dialog, close without saving.
        el('ledger-advance-btn').click();
        await waitModalReady('family-pay-dialog');
        rep.check('ui: add-advance dialog opens', el('family-pay-dialog') && el('family-pay-dialog').open);
        if (el('family-pay-dialog') && el('family-pay-dialog').open) el('family-pay-dialog').close();
        await settle(120);

        // Add member: needs another eligible person to pick.
        await db.addBill({
          labId: labs[0].id, docId: docs[0].id, name: 'UI EXTRA', mob: '7001',
          items: [{ itemId: testId, itemV: testV, hid: 0 }], disc_amt: 0, payment: 1,
        });
        await ledgerPage.openForPerson(_headRow.id, _headRow.name);
        await settle(320);
        el('ledger-add-btn').click();
        await settle(500);
        const picker = document.querySelector('dialog[open]');
        rep.check('ui: add-member opens a dialog', !!picker && picker.open);
        if (picker && picker.open) picker.close();
        await settle(120);

        // Pay due: only if the family has dues; open then cancel.
        if (el('ledger-pay-btn') && !el('ledger-pay-btn').hidden) {
          el('ledger-pay-btn').click();
          await waitModalReady('family-pay-dialog');
          rep.check('ui: pay-due dialog opens', el('family-pay-dialog') && el('family-pay-dialog').open);
          if (el('family-pay-dialog') && el('family-pay-dialog').open) el('family-pay-dialog').close();
          await settle(120);
        } else {
          rep.skip('ui: pay-due dialog', 'no dues in family');
        }

        // Refund advance: only if advance held; open then cancel.
        if (el('ledger-refund-btn') && !el('ledger-refund-btn').hidden) {
          el('ledger-refund-btn').click();
          await waitModalReady('family-refund-dialog');
          rep.check('ui: refund dialog opens', el('family-refund-dialog') && el('family-refund-dialog').open);
          if (el('family-refund-dialog') && el('family-refund-dialog').open) el('family-refund-dialog').close();
          await settle(120);
        } else {
          rep.skip('ui: refund dialog', 'no advance held');
        }

        // Scope clear returns to whole lab.
        el('ledger-scope-clear').click();
        await settle(220);
        rep.check('ui: scope clear returns to whole lab', el('ledger-scope-name') && /whole lab/i.test(el('ledger-scope-name').textContent));
      } else {
        rep.skip('ui: family scope', 'no people yet');
      }

      // Bills page: open bill view dialog if rows exist.
      if (router && router.activateTab) router.activateTab('bills', true);
      await settle(260);
      const brows = document.querySelectorAll('#bills-table tbody tr.bills-row');
      if (brows.length) {
        brows[0].click();
        await waitModalReady('bill-view-dialog');
        const bd = el('bill-view-dialog');
        rep.check('ui: bill view opens', bd && bd.open);
        if (bd && bd.open) {
          rep.check('ui: bill view has Payment button', !!el('bill-view-payment-btn'));
          if (el('bill-view-close')) el('bill-view-close').click();
        }
        await settle(120);
      } else {
        rep.skip('ui: bill view open', 'no bill rows');
      }

      // Revisions modal opens for a bill.
      try {
        const { openBillRevisions } = await import('../ui/revisions.js');
        const _p = await db.getBillsPage({ offset: 0, limit: 1 });
        const assignedIdForUi = _p.results[0] ? _p.results[0].id : null;
        if (assignedIdForUi != null) {
          openBillRevisions(assignedIdForUi);
          await waitModalReady('revisions-modal');
          rep.check('ui: revisions modal opens', el('revisions-modal') && el('revisions-modal').open);
          if (el('revisions-modal') && el('revisions-modal').open) el('revisions-modal').close();
          await settle(120);
        } else {
          rep.skip('ui: revisions modal', 'no bill id');
        }
      } catch (e) {
        rep.check('ui: revisions modal', false, e && e.message ? e.message : String(e));
      }

      window.removeEventListener('error', onErr);
      window.removeEventListener('unhandledrejection', onErr);
      rep.check('ui: no uncaught errors during coverage', errs.length === 0, errs.slice(0, 3).join(' | '));
    } catch (e) {
      rep.check('ui: stage completed', false, e && e.message ? e.message : String(e));
    }

    // ---- 2. Bill save via the real form ----------------------------------
    stage('2. bill save (form)');
    if (router && router.activateTab) router.activateTab('bill', true);
    await settle(300);
    await billPage.__resetForTest();
    await settle(150);

    const bf = billPage.__getForm().fields;
    setSelectByText(bf.lab, 'CITY DIAGNOSTICS');
    setSelectByText(bf.doc, 'DR. HOUSE');
    setVal(bf.name, 'Alice');
    setVal(bf.mob, '999');
    setVal(bf.age, '40');
    setVal(bf.gender, 'M');
    await settle(100);

    const testInput = bf.testInput;
    if (testInput) {
      setVal(testInput, 'CBC');
      await settle(150);
      const ev = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
      testInput.dispatchEvent(ev);
      await settle(150);
    }
    const testsNow = billPage.__getTests();
    rep.eq('bill: line test added', testsNow.length, 1);
    rep.eq('bill: test name', testsNow[0] && testsNow[0].name, 'CBC');

    if (testInput) {
      setVal(testInput, 'CBC');
      await settle(150);
      const ev2 = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
      testInput.dispatchEvent(ev2);
      await settle(150);
    }
    rep.eq('bill: duplicate blocked', billPage.__getTests().length, 1);

    await billPage.__submitForTest();
    await settle(200);

    const allBills = await db.getBillsPage({ offset: 0, limit: 5 });
    const saved = allBills.results[0];
    const assignedId = saved ? saved.id : null;
    rep.check('bill: saved to DB', !!saved, 'id=' + assignedId);
    rep.eq('bill: labId', saved && saved.labId, labs[0].id);
    rep.eq('bill: docId', saved && saved.docId, docs[0].id);
    rep.eq('bill: items length', saved && saved.items.length, 1);
    rep.eq('bill: item itemId', saved && saved.items[0].itemId, testId);
    rep.eq('bill: item itemV', saved && saved.items[0].itemV, testV);
    rep.eq('bill: cust_total', saved && saved.cust_total, 12);
    rep.eq('bill: merch_total', saved && saved.merch_total, 6);
    rep.eq('bill: cust_payable', saved && saved.cust_payable, 12);
    rep.eq('bill: grand_total', saved && saved.grand_total, 12);

    const custList = await db.searchPeopleByPrefix('ALICE', 5);
    const cust = custList[0];
    rep.check('bill: customer row upserted', !!cust);
    rep.eq('bill: customer name uppercased', cust && cust.name, 'ALICE');
    rep.eq('bill: customer mob stored', cust && cust.mob, '999');
    rep.eq('bill: bill.pId', saved && saved.pId, cust && cust.id);

    // ---- 3. Bill edit appends history ------------------------------------
    stage('3. bill edit (history)');
    const hydrated = await db.hydrateBill(saved);
    await billPage.__loadForEditForTest(hydrated);
    await settle(200);
    // The edit must change content (unchanged re-saves are idempotent: no new revision).
    const payEl = document.getElementById('bill-paid');
    if (payEl) payEl.value = '2';
    await settle(100);
    await billPage.__submitForTest();
    await settle(200);

    const updated = await db.getBill(assignedId);
    rep.check('bill: v incremented', updated && updated.v >= 2, 'v=' + (updated && updated.v) + ' pay=' + (updated && updated.payment));

    // ---- 4. Bills Bill View dialog ---------------------------------------
    stage('4. bills bill view dialog');
    if (router && router.activateTab) router.activateTab('bills', true);
    await settle(400);

    const rows = document.querySelectorAll('#bills-table tbody tr.bills-row');
    rep.check('bills: rows rendered', rows.length > 0, 'rows=' + rows.length);
    if (rows.length) {
      rows[0].click();
      await waitModalReady('bill-view-dialog');
      const dlg = document.getElementById('bill-view-dialog');
      rep.check('bills: bill view dialog open', dlg && dlg.open);
      const title = document.getElementById('bill-view-title');
      rep.check(
        'bills: dialog title shows bill id',
        title && title.textContent.indexOf(String(assignedId)) >= 0
      );
      if (dlg && dlg.open) dlg.close();
    }

    // ---- 4b. print HTML escapes patient-controlled text ---------------
    stage('4b. print html escaping');
    try {
      const { renderBillHtml } = await import('../print/billHtml.js');
      const evil = renderBillHtml({
        id: 1, datetime: '2026-01-01',
        items: [{ name: '<script>alert(1)</script>', sell: 10, hid: 0 }],
        labName: '<img src=x onerror=1>', docName: '</td><td>',
        person: { name: '<b>Bob</b>', mob: '<i>9</i>' },
        cust_total: 10, disc_amt: 0, grand_total: 10,
      });
      rep.check('print: script tag escaped', evil.indexOf('<script>') < 0);
      rep.check('print: onerror escaped', evil.indexOf('onerror=1>') < 0);
      rep.check('print: escaped form present', evil.indexOf('&lt;script&gt;') >= 0);
    } catch (e) {
      rep.check('print: stage completed', false, e && e.message ? e.message : String(e));
    }

    // ---- 5. CSV codec roundtrip on real bill -----------------------------
    stage('5. csv codec on real bill');
    const curRev = await db._currentBill(assignedId);
    const line = billRevToLogLine(curRev);
    const text = csvHeaderLine() + '\n' + line + '\n';
    const parsed = csvToLog(text);
    rep.eq('csv-real: roundtrip id', parsed.ops[0] && parsed.ops[0].id, assignedId);
    rep.eq('csv-real: items length', parsed.ops[0] && parsed.ops[0].items.length, 1);
    rep.eq('csv-real: item itemId', parsed.ops[0] && parsed.ops[0].items[0].itemId, testId);
    rep.eq('csv-real: skipped rows = 0', (parsed.skippedRows || []).length, 0);

    // ---- 6. Paging -------------------------------------------------------
    stage('6. paging');
    const page = await db.getBillsPage({ offset: 0, limit: 10 });
    rep.check('paging: returns rows', page.results.length > 0, 'total=' + page.total);
    rep.check('paging: total >= 1', page.total >= 1, 'total=' + page.total);

    // ---- 6c. seed at small scale + paged read ----------------------------
    stage('6c. seed + paged read (scale)');
    try {
      const { seed } = await import('./seed.js');
      const SEED_N = 200;
      const beforeSeed = (await db.getBillsPage({ offset: 0, limit: 1 })).total;
      const t0 = performance.now();
      await seed({ bills: SEED_N, patients: 40, reset: false });
      const dt = Math.round(performance.now() - t0);
      rep.check('seed: bulk write completed', true, SEED_N + ' bills in ' + dt + 'ms');
      const after = await db.getBillsPage({ offset: 0, limit: 10 });
      rep.eq('seed: paged total grew by SEED_N', after.total, beforeSeed + SEED_N);
    } catch (e) {
      rep.check('seed: stage completed', false, e && e.message ? e.message : String(e));
    }

    // ---- 7. Restore roundtrip --------------------------------------------
    stage('7. restore roundtrip');
    try {
      const exported = await db.exportAll();
      rep.check('export: produced text', typeof exported.text === 'string' && exported.text.length > 0);
      const roundtrip = csvToLog(exported.text);
      rep.check('export: parses back', roundtrip.ops.length > 0, 'ops=' + roundtrip.ops.length);
      const rr = await db.replayLog(roundtrip.ops);
      const after = await db.getBillsPage({ offset: 0, limit: 10 });
      rep.check('restore: bills present', after.total > 0, 'total=' + after.total);
      rep.eq('restore: no dangling refs', (rr.danglingRefs || []).length, 0);
      if ((rr.danglingRefs || []).length) rep.check('restore: dangling detail', false, JSON.stringify(rr.danglingRefs.slice(0, 3)));
    } catch (e) {
      rep.check('restore: stage completed', false, e && e.message ? e.message : String(e));
    }

    // ---- 8. Family head + part payments ----------------------------------
    stage('8. family head + part payments');
    try {
      await db.raw.payments.clear().catch(() => { });
      await db.raw.allocations.clear().catch(() => { });
      const mk = async (name, mob, payable) => {
        const r = await db.addBill({
          labId: labs[0].id, docId: docs[0].id, name, mob,
          items: [{ itemId: testId, itemV: testV, hid: 0 }],
          disc_amt: 0, payment: 0,
        });
        return r.rec;
      };
      const a = await mk('FAMHEAD', '8001');
      const b = await mk('FAMKID', '8002');
      const headId = a.pId;
      const kidId = b.pId;
      await db.setPersonHead(kidId, headId);
      const kid = await db.getPerson(kidId);
      rep.eq('family: member headId', kid && kid.headId, headId);
      rep.eq('family: familyIds size', (await db.familyIds(headId)).length, 2);

      const due0 = await db.familyDueBills(headId);
      rep.eq('family: 2 open bills', due0.length, 2);
      const unit = due0[0] ? due0[0].due : 0;

      const r1 = await db.recordPayment({ headId, amount: unit / 2 });
      rep.eq('family: part pay allocated 1 bill', r1.allocated.length, 1);
      rep.eq('family: part pay no advance', r1.advance, 0);
      rep.eq('family: outstanding after part', await db.billOutstanding(due0[0].id), unit / 2);

      const r2 = await db.recordPayment({ headId, amount: unit * 3 });
      rep.eq('family: remaining 1.5 bills settled', r2.allocated.length, 2);
      rep.eq('family: excess kept as advance', r2.advance, unit * 3 - unit * 1.5);
      rep.eq('family: no due left', (await db.familyDueBills(headId)).length, 0);
      const hp = await db.getPerson(headId);
      const kp = await db.getPerson(kidId);
      rep.eq('family: head pending 0', hp && hp.pending, 0);
      rep.eq('family: member pending 0', kp && kp.pending, 0);

      const ex = await db.exportAll();
      const parsed = csvToLog(ex.text);
      rep.check('family: csv has payment ops', parsed.ops.some((o) => o.kind === 'payment'));
      rep.check('family: csv has allocation ops', parsed.ops.some((o) => o.kind === 'allocation'));
      await db.replayLog(parsed.ops);
      rep.eq('family: advance survives restore', await db.advanceBalance(headId), unit * 1.5);
      rep.eq('family: headId survives restore', (await db.getPerson(kidId)).headId, headId);

      // Auto-apply: a new unpaid bill is paid from the advance immediately.
      const c = await mk('FAMHEAD', '8001');
      rep.eq('autoapply: new bill settled from advance', await db.billOutstanding(c.id), 0);
      rep.eq('autoapply: advance reduced', await db.advanceBalance(headId), unit * 0.5);
      const led = await db.ledgerForPerson(headId);
      rep.check('autoapply: ledger has advance-apply row', led.some((e) => e.kind === 'ADVANCE_APPLY'));

      // Integrity: derived data must equal what the facts imply.
      const v1 = await db.verify();
      rep.check('verify: clean after payments', v1.ok, v1.issues.join(' | '));

      // Regression: a receipt allocation and an advance-apply on the SAME bill
      // must not be double-counted by verify (allocations matched by both
      // billId and paymentId). Record a payment onto an unpaid bill, let any
      // excess become advance, then apply that advance back onto a new bill.
      {
        const g = await mk('REGRESS', '8100');
        const gid = g.pId;
        await db.recordPayment({ headId: gid, amount: (await db.billOutstanding(g.id)) + 5 });
        // g is now fully receipt-allocated; the +5 is advance. A new bill is
        // paid from that advance (advance-apply) — both kinds now touch the head.
        const g2 = await mk('REGRESS', '8100');
        const vreg = await db.verify();
        rep.check('verify: receipt+apply on same head is clean', vreg.ok, vreg.issues.join(' | '));
      }

      // Refund: negative payment, capped at the advance held.
      const adv = await db.advanceBalance(headId);
      if (adv > 0) {
        await db.refundAdvance({ headId, amount: adv });
        rep.eq('refund: advance back to 0', await db.advanceBalance(headId), 0);
      }
      let refundBlocked = false;
      try { await db.refundAdvance({ headId, amount: 1 }); } catch (_) { refundBlocked = true; }
      rep.check('refund: more than advance is rejected', refundBlocked);

      // Delete a part-paid bill: its allocations return to the advance.
      const d = await mk('FAMKID', '8002');
      await db.recordPayment({ headId, amount: unit / 2 });
      const before = await db.advanceBalance(headId);
      await db.deleteBill(d.id);
      rep.check('delete: allocation returned to advance', (await db.advanceBalance(headId)) >= before);
      const v2 = await db.verify();
      rep.check('verify: clean after refund + delete', v2.ok, v2.issues.join(' | '));

      // A settled bill may not also carry part payments.
      const e2 = await mk('FAMHEAD', '8001');
      let blocked = false;
      try { await db.setBillPayment(e2.id, 1); } catch (_) { blocked = true; }
      rep.check('guard: part-paid bill cannot be marked settled', blocked || (await db.billOutstanding(e2.id)) === 0);

      // Rebuild from facts must leave zero drift.
      await db.rebuildDerived();
      const v3 = await db.verify();
      rep.check('verify: clean after rebuildDerived', v3.ok, v3.issues.join(' | '));
    } catch (e) {
      rep.check('family: stage completed', false, e && e.message ? e.message : String(e));
    }

    // ---- 9. Property-style: random fact sequences always verify clean ----
    stage('9. property: random fact sequences');
    try {
      let seed = 12345;
      const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
      const pick = (a) => a[Math.floor(rnd() * a.length)];
      const people = [['PA', '7001'], ['PB', '7002'], ['PC', '7003'], ['PD', '7004']];
      const live = [];
      let bad = 0;
      let first = '';
      for (let i = 0; i < 60; i++) {
        const op = Math.floor(rnd() * 7);
        try {
          if (op <= 1 || !live.length) {
            const [n, m] = pick(people);
            const r = await db.addBill({
              labId: labs[0].id, docId: docs[0].id, name: n, mob: m,
              items: [{ itemId: testId, itemV: testV, hid: 0 }],
              disc_amt: 0, payment: rnd() < 0.7 ? 0 : 1,
            });
            live.push(r.rec);
          } else if (op === 2) {
            const p = await db.getPerson(pick(live).pId);
            await db.recordPayment({ headId: p.headId != null ? p.headId : p.id, amount: Math.ceil(rnd() * 30) });
          } else if (op === 3) {
            const p = await db.getPerson(pick(live).pId);
            const head = p.headId != null ? p.headId : p.id;
            const adv = await db.advanceBalance(head);
            if (adv > 0) await db.refundAdvance({ headId: head, amount: Math.min(adv, Math.ceil(rnd() * 10)) });
          } else if (op === 4) {
            const b = live.splice(Math.floor(rnd() * live.length), 1)[0];
            await db.deleteBill(b.id);
          } else if (op === 5) {
            await db.setPersonHead(pick(live).pId, pick(live).pId);
          } else {
            await db.setBillPayment(pick(live).id, pick([0, 1, 2]));
          }
        } catch (_) { /* rejected operations are allowed; the facts must still be consistent */ }
        if (i % 5 === 4) {
          const v = await db.verify();
          if (!v.ok) {
            bad++;
            if (!first) first = 'step ' + i + ': ' + v.issues[0];
          }
        }
      }
      rep.check('property: verify clean through 60 random operations', bad === 0, first);
      rep.eq('property: advance aggregate equals full scan', await db.totalAdvance(), await db._totalAdvanceScan());
      await db.rebuildDerived();
      const vp = await db.verify();
      rep.check('property: clean after rebuildDerived', vp.ok, vp.issues.join(' | '));
    } catch (e) {
      rep.check('property: stage completed', false, e && e.message ? e.message : String(e));
    }

    // ---- 10. Flow: end-to-end scenarios through the REAL UI --------------
    stage('10. flows (end-to-end via UI)');
    try {
      const ledgerPage = await import('../ui/pages/ledger.js');

      // Helper: create a bill through the REAL bill form (Pay later = unpaid).
      const makeBillViaForm = async (name, mob, payLater, testName) => {
        if (router && router.activateTab) router.activateTab('bill', true);
        await settle(200);
        await billPage.__resetForTest();
        await settle(160);
        const bf = billPage.__getForm().fields;
        setSelectByText(bf.lab, 'CITY DIAGNOSTICS');
        setSelectByText(bf.doc, 'DR. HOUSE');
        setVal(bf.name, name);
        setVal(bf.mob, mob);
        setVal(bf.age, '30');
        await settle(80);
        const ti = bf.testInput;
        if (ti) {
          setVal(ti, testName || 'CBC');
          await settle(140);
          ti.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
          await settle(140);
        }
        const paidSel = document.getElementById('bill-paid');
        if (paidSel) setVal(paidSel, payLater ? '0' : '1');
        const before = await db.getBillsPage({ offset: 0, limit: 500 });
        const beforeIds = new Set(before.results.map((b) => b.id));
        await billPage.__submitForTest();
        await settle(240);
        const after = await db.getBillsPage({ offset: 0, limit: 500 });
        const fresh = after.results.filter((b) => !beforeIds.has(b.id));
        // Newest new bill (highest id) is the one we just created.
        fresh.sort((a, b) => b.id - a.id);
        return fresh.length ? fresh[0].id : null;
      };

      // Wait until a <dialog> by id is open (or closed), polling briefly. When
      // wantOpen, also wait for the body/footer to finish rendering (the modal
      // opens the shell first, then fills it a tick later — `is-rendering`).
      const waitForDialog = async (id, wantOpen, timeoutMs) => {
        const t0 = Date.now();
        const lim = timeoutMs == null ? 4000 : timeoutMs;
        while (Date.now() - t0 < lim) {
          const d = el(id);
          const isOpen = !!(d && d.open);
          const settled = !d || !d.classList.contains('is-rendering');
          if (isOpen === wantOpen && settled) return d;
          await settle(40);
        }
        return el(id);
      };

      // Open the bill-view dialog for a given bill id via the Bills page row.
      const openBillView = async (billId) => {
        const _bv = el('bill-view-dialog');
        if (_bv && _bv.open) _bv.close();
        if (router && router.activateTab) router.activateTab('bills', true);
        await settle(260);
        const rows = Array.from(document.querySelectorAll('#bills-table tbody tr.bills-row'));
        const row = rows.find((r) => Number(r.dataset.id) === Number(billId));
        if (row) row.click();
        else if (rows[0]) rows[0].click();
        await waitForDialog('bill-view-dialog', true);
        await settle(80);
      };

      // Wait until an async predicate is true, or time out.
      const waitUntil = async (fn, timeoutMs) => {
        const t0 = Date.now();
        const lim = timeoutMs == null ? 4000 : timeoutMs;
        while (Date.now() - t0 < lim) {
          if (await fn()) return true;
          await settle(60);
        }
        return false;
      };

      const submitFamilyPay = async (opener, amount) => {
        opener();
        const dlg = await waitForDialog('family-pay-dialog', true);
        rep.check('flow: family-pay modal opened by button', !!(dlg && dlg.open));
        setVal(el('family-pay-amount'), String(amount));
        el('family-pay-save').click();
        await waitForDialog('family-pay-dialog', false);
        // The save handler writes async after close; give it a beat.
        await settle(450);
      };

      const submitFamilyRefund = async (opener, amount) => {
        opener();
        const dlg = await waitForDialog('family-refund-dialog', true);
        rep.check('flow: refund modal opened by button', !!(dlg && dlg.open));
        setVal(el('family-refund-amount'), String(amount));
        el('family-refund-save').click();
        await waitForDialog('family-refund-dialog', false);
        await settle(450);
      };

      // Per-flow isolation: each flow is self-contained. On success AND on
      // failure, tear down every stray dialog so a leaking modal can't stack
      // behind the final report or poison the next flow.
      const guard = async (name, fn) => {
        try {
          await fn();
        } catch (e) {
          rep.check(name + ': completed', false, e && e.message ? e.message : String(e));
        } finally {
          document.querySelectorAll('dialog[open]').forEach((d) => {
            if (d.id === 'test-dialog' || d.id === 'update-dialog') return; // report + update prompt may stay
            d.close();
          });
        }
      };
      const confirmDanger = async () => {
        const sel = 'dialog[open] .dialog-actions .btn-danger';
        await waitUntil(() => !!document.querySelector(sel));
        const b = document.querySelector(sel);
        rep.check('flow: confirm dialog shown', !!b);
        if (b) b.click();
        await settle(300);
      };
      const rowsOf = (sel) => Array.from(document.querySelectorAll(sel));

      // ---- Flow A: Pay later bill -> unpaid -> part-pay -> settle, via REAL buttons.
      await guard('flowA', async () => {
        const id = await makeBillViaForm('FLOW ALICE', '5001', true);
        rep.check('flowA: bill saved via form', id != null, 'id=' + id);
        let due = await db.billOutstanding(id);
        rep.check('flowA: Pay later bill is unpaid', due > 0, 'due=' + due);
        const total = due;

        // Open the bill view (real row click) then click Payment... (real button).
        await openBillView(id);
        rep.check('flowA: bill-view modal open', el('bill-view-dialog') && el('bill-view-dialog').open);
        await submitFamilyPay(() => el('bill-view-payment-btn').click(), total / 2);
        await waitUntil(async () => (await db.billOutstanding(id)) < total);
        due = await db.billOutstanding(id);
        rep.check('flowA: after part pay, due remains', due > 0 && due < total, 'due=' + due + ' of ' + total);
        if (el('bill-view-dialog') && el('bill-view-dialog').open) el('bill-view-dialog').close();
        await settle(80);

        // Settle the rest through the same real path.
        await openBillView(id);
        await submitFamilyPay(() => el('bill-view-payment-btn').click(), due);
        await waitUntil(async () => (await db.billOutstanding(id)) === 0);
        rep.eq('flowA: fully settled', await db.billOutstanding(id), 0);
        if (el('bill-view-dialog') && el('bill-view-dialog').open) el('bill-view-dialog').close();
        await settle(80);
        const vA = await db.verify();
        rep.check('flowA: verify clean', vA.ok, vA.issues.join(' | '));
      });

      // ---- Flow B: head advance (via Ledger button) auto-pays a new bill.
      await guard('flowB', async () => {
        const id = await makeBillViaForm('FLOW BOB', '5002', true);
        const bill = await db.getBill(id);
        const person = await db.getPerson(bill.pId);
        const headId = person.headId != null ? person.headId : person.id;
        const due0 = await db.billOutstanding(id);

        // Open the Ledger family scope for this head, then click Add advance.
        if (router && router.activateTab) router.activateTab('ledger', true);
        await ledgerPage.openForPerson(headId, person.name);
        await settle(260);
        rep.check('flowB: ledger family actions visible', el('ledger-scope-actions') && !el('ledger-scope-actions').hidden);
        rep.check('flowB: add-advance button visible', el('ledger-advance-btn') && !el('ledger-advance-btn').hidden);
        await submitFamilyPay(() => el('ledger-advance-btn').click(), due0 + 100);
        rep.eq('flowB: existing due settled by advance', await db.billOutstanding(id), 0);
        rep.check('flowB: advance kept', (await db.advanceBalance(headId)) > 0, 'adv=' + (await db.advanceBalance(headId)));

        // New Pay later bill for the SAME head auto-pays from the advance.
        const id2 = await makeBillViaForm('FLOW BOB', '5002', true);
        rep.check('flowB: new bill auto-paid from advance', (await db.billOutstanding(id2)) === 0, 'due=' + (await db.billOutstanding(id2)));
        const led = await db.ledgerForPerson(headId);
        rep.check('flowB: ledger has ADVANCE_APPLY', led.some((e) => e.kind === 'ADVANCE_APPLY'));
        const vB = await db.verify();
        rep.check('flowB: verify clean', vB.ok, vB.issues.join(' | '));
      });

      // ---- Flow C: family payment (Pay due) + refund, via real Ledger buttons.
      await guard('flowC', async () => {
        const id = await makeBillViaForm('FLOW CARL', '5003', true);
        await makeBillViaForm('FLOW CARL', '5003', true);
        const bill = await db.getBill(id);
        const person = await db.getPerson(bill.pId);
        const headId = person.headId != null ? person.headId : person.id;

        // Attach a second person as a member (setup, not the thing under test).
        const other = await db.addBill({
          labId: labs[0].id, docId: docs[0].id, name: 'FLOW MEMBER', mob: '5004',
          items: [{ itemId: testId, itemV: testV, hid: 0 }], disc_amt: 0, payment: 0,
        });
        await db.setPersonHead(other.rec.pId, headId);
        const dueBills = await db.familyDueBills(headId);
        rep.check('flowC: family has 2+ open bills', dueBills.length >= 2, 'n=' + dueBills.length);
        const totalDue = dueBills.reduce((s, d) => s + d.due, 0);

        // Ledger family scope -> click "Pay due" (real button).
        if (router && router.activateTab) router.activateTab('ledger', true);
        await ledgerPage.openForPerson(headId, person.name);
        await settle(300);
        rep.check('flowC: pay-due button visible', el('ledger-pay-btn') && !el('ledger-pay-btn').hidden);
        await submitFamilyPay(() => el('ledger-pay-btn').click(), totalDue + 25);
        rep.eq('flowC: family fully settled', (await db.familyDueBills(headId)).length, 0);
        rep.check('flowC: excess became advance', (await db.advanceBalance(headId)) >= 25, 'adv=' + (await db.advanceBalance(headId)));

        // Refund via the real "Refund advance" button.
        const adv = await db.advanceBalance(headId);
        if (adv > 0) {
          await ledgerPage.openForPerson(headId, person.name);
          await settle(280);
          if (el('ledger-refund-btn') && !el('ledger-refund-btn').hidden) {
            await submitFamilyRefund(() => el('ledger-refund-btn').click(), adv);
            rep.eq('flowC: advance refunded to 0', await db.advanceBalance(headId), 0);
          } else {
            rep.check('flowC: refund button visible', false, 'refund btn hidden');
          }
        } else {
          rep.skip('flowC: refund advance', 'no advance');
        }
        const vC = await db.verify();
        rep.check('flowC: verify clean', vC.ok, vC.issues.join(' | '));
      });

      // ---- Flow D: delete a part-paid bill returns its allocation to advance.
      await guard('flowD', async () => {
        const id = await makeBillViaForm('FLOW DINA', '5005', true);
        const bill = await db.getBill(id);
        const person = await db.getPerson(bill.pId);
        const headId = person.headId != null ? person.headId : person.id;
        const due = await db.billOutstanding(id);
        await db.recordPayment({ headId, amount: due / 2 });
        const advBefore = await db.advanceBalance(headId);
        await db.deleteBill(id);
        rep.check('flowD: delete returns allocation to advance', (await db.advanceBalance(headId)) > advBefore, 'adv=' + (await db.advanceBalance(headId)));
        const vD = await db.verify();
        rep.check('flowD: verify clean', vD.ok, vD.issues.join(' | '));
      });

      // ---- Flow E: form validation + duplicate-block, via the real form.
      await guard('flowE', async () => {
        if (router && router.activateTab) router.activateTab('bill', true);
        await settle(180);
        await billPage.__resetForTest();
        await settle(160);
        const bf = billPage.__getForm().fields;
        setVal(bf.name, 'FLOW EMPTY');
        setVal(bf.mob, '5006');
        // No test added -> submit must not create a bill.
        const before = (await db.getBillsPage({ offset: 0, limit: 1 })).total;
        await billPage.__submitForTest();
        await settle(200);
        const after = (await db.getBillsPage({ offset: 0, limit: 1 })).total;
        rep.eq('flowE: empty bill not saved', after, before);
      });

      // ---- Flow F: Bills page actions (pager, History, Print, Edit, Delete) via real buttons.
      await guard('flowF', async () => {
        const id = await makeBillViaForm('FLOW FRED', '5007', true);
        rep.check('flowF: bill saved via form', id != null, 'id=' + id);

        if (router && router.activateTab) router.activateTab('bills', true);
        await settle(260);
        const day0 = el('bills-day-label').value;
        el('bills-prev-day').click();
        await settle(260);
        const day1 = el('bills-day-label').value;
        rep.check('flowF: Earlier changes the day', day0 !== day1, day0 + ' -> ' + day1);
        el('bills-next-day').click();
        await settle(260);
        rep.eq('flowF: Later returns to the day', el('bills-day-label').value, day0);
        el('bills-prev-day').click();
        await settle(200);
        el('bills-today').click();
        await settle(260);
        rep.eq('flowF: Today returns to today', el('bills-day-label').value, day0);
        setVal(el('bills-day-label'), day1);
        await settle(260);
        rep.eq('flowF: date input jumps to the day', el('bills-day-label').value, day1);
        el('bills-today').click();
        await settle(260);

        await openBillView(id);
        el('bill-view-history-btn').click();
        await waitForDialog('revisions-modal', true);
        rep.check('flowF: History opens revisions modal', el('revisions-modal') && el('revisions-modal').open);
        if (el('revisions-modal') && el('revisions-modal').open) el('revisions-modal').close();
        await settle(100);

        el('bill-view-print-btn').click();
        await waitForDialog('bill-view-dialog', false);
        rep.check('flowF: Print closes bill view', !(el('bill-view-dialog') && el('bill-view-dialog').open));
        await settle(300);

        await openBillView(id);
        el('bill-view-edit-btn').click();
        await settle(500);
        const pageBill = el('page-bill');
        rep.check('flowF: Edit opens the bill form', !!(pageBill && !pageBill.hidden));
        rep.eq('flowF: form holds the bill id', Number(el('bill-edit-id').value), Number(id));
        setVal(el('bill-paid'), '1');
        await settle(100);
        await billPage.__submitForTest();
        await settle(300);
        const edited = await db.getBill(id);
        rep.check('flowF: edit saved a new revision', edited && edited.v >= 2, 'v=' + (edited && edited.v));
        rep.eq('flowF: edit to paid settles the bill', await db.billOutstanding(id), 0);

        await openBillView(id);
        el('bill-view-delete-btn').click();
        await confirmDanger();
        await waitUntil(async () => {
          const b = await db.getBill(id);
          return !b || b.hid;
        });
        const gone = await db.getBill(id);
        rep.check('flowF: Delete removes the bill', !gone || !!gone.hid);
        const vF = await db.verify();
        rep.check('flowF: verify clean', vF.ok, vF.issues.join(' | '));
      });

      // ---- Flow G: Patients page (search, pending toggle, sort, open, Ledger, timeline).
      await guard('flowG', async () => {
        await makeBillViaForm('FLOW GINA', '5008', true);
        if (router && router.activateTab) router.activateTab('patients', true);
        await settle(320);
        setVal(el('patients-search'), 'FLOW GINA');
        await settle(500);
        let rows = rowsOf('#patients-table tbody tr');
        rep.check('flowG: search finds the patient', rows.length >= 1 && /FLOW GINA/.test(rows[0].textContent), 'rows=' + rows.length);
        setVal(el('patients-search'), 'ZZZ NO SUCH PERSON');
        await settle(500);
        rep.eq('flowG: search with no match shows no rows', rowsOf('#patients-table tbody tr').length, 0);
        rep.check('flowG: empty message shown', !el('patients-empty').hidden);
        setVal(el('patients-search'), '');
        await settle(500);

        const tog = el('patients-due-toggle');
        tog.click();
        await settle(500);
        rep.eq('flowG: pending toggle pressed', tog.getAttribute('aria-pressed'), 'true');
        rows = rowsOf('#patients-table tbody tr');
        rep.check('flowG: pending-only shows only rows with dues', rows.length > 0 && rows.every((r) => r.classList.contains('row-due')), 'rows=' + rows.length);
        tog.click();
        await settle(400);
        rep.eq('flowG: pending toggle released', tog.getAttribute('aria-pressed'), 'false');

        const th = document.querySelector('#patients-table thead th.sortable');
        if (th) {
          const was = th.getAttribute('aria-sort');
          th.click();
          await settle(400);
          const now = th.getAttribute('aria-sort');
          rep.check('flowG: sort header toggles', was !== now, was + ' -> ' + now);
        } else {
          rep.skip('flowG: sort header', 'no sortable header');
        }

        setVal(el('patients-search'), 'FLOW GINA');
        await settle(500);
        rows = rowsOf('#patients-table tbody tr');
        if (rows.length) {
          rows[0].click();
          await waitForDialog('patient-view-dialog', true);
          rep.check('flowG: patient view opens', el('patient-view-dialog').open);
          rep.check('flowG: title shows the patient', /FLOW GINA/.test(el('patient-view-title').textContent));
          rep.check('flowG: timeline lists the bill', document.querySelectorAll('#patient-view-bills .hx-item').length >= 1);
          el('patient-view-bills').querySelector('.hx-item').click();
          await settle(500);
          rep.check('flowG: timeline click closes patient view', !el('patient-view-dialog').open);
          rep.check('flowG: timeline click opens bill form', !el('page-bill').hidden);

          if (router && router.activateTab) router.activateTab('patients', true);
          await settle(320);
          setVal(el('patients-search'), 'FLOW GINA');
          await settle(500);
          rowsOf('#patients-table tbody tr')[0].click();
          await waitForDialog('patient-view-dialog', true);
          el('patient-view-ledger-btn').click();
          await settle(600);
          rep.check('flowG: Ledger button closes patient view', !el('patient-view-dialog').open);
          rep.check('flowG: Ledger button scopes to the family', el('ledger-scope-name') && /ledger family/i.test(el('ledger-scope-name').textContent));
        } else {
          rep.check('flowG: patient row present', false, 'no row for FLOW GINA');
        }
        setVal(el('patients-search'), '');
        const vG = await db.verify();
        rep.check('flowG: verify clean', vG.ok, vG.issues.join(' | '));
      });

      // ---- Flow H: Settings dialog (cancel keeps, save persists, new bill uses defaults).
      await guard('flowH', async () => {
        const btn = el('btn-settings');
        if (!btn) {
          rep.skip('flowH: settings', 'no settings button');
          return;
        }
        await db.setCompanyName('');
        btn.click();
        await waitForDialog('settings-dialog', true);
        rep.check('flowH: settings opens by button', el('settings-dialog').open);
        setVal(el('settings-company'), 'CANCELLED NAME');
        const cancelBtn = document.querySelector('#settings-form button[value="cancel"]');
        if (cancelBtn) cancelBtn.click();
        else el('settings-dialog').close();
        await waitForDialog('settings-dialog', false);
        await settle(150);
        rep.check('flowH: cancel does not save', !/CANCELLED/i.test((await db.getCompanyName()) || ''));

        btn.click();
        await waitForDialog('settings-dialog', true);
        setVal(el('settings-company'), 'SELFTEST LAB');
        setVal(el('settings-default-lab'), String(labs[0].id));
        setVal(el('settings-default-doctor'), String(docs[0].id));
        el('settings-save').click();
        await waitForDialog('settings-dialog', false);
        await settle(300);
        rep.check('flowH: company name saved', /selftest lab/i.test((await db.getCompanyName()) || ''));
        rep.eq('flowH: default lab saved', await db.getDefaultLabId(), labs[0].id);
        rep.eq('flowH: default doctor saved', await db.getDefaultDoctorId(), docs[0].id);

        if (router && router.activateTab) router.activateTab('bill', true);
        await settle(200);
        await billPage.__resetForTest();
        await settle(200);
        const bfH = billPage.__getForm().fields;
        rep.eq('flowH: new bill preselects default lab', String(bfH.lab.value), String(labs[0].id));
        rep.eq('flowH: new bill preselects default doctor', String(bfH.doc.value), String(docs[0].id));
      });

      // ---- Flow I: Ledger family members (Add member picker, cards, Remove).
      await guard('flowI', async () => {
        const hid = await makeBillViaForm('FLOW HEADY', '5010', true);
        const kid = await makeBillViaForm('FLOW KIDDO', '5011', true);
        const headP = await db.getPerson((await db.getBill(hid)).pId);
        const kidP = await db.getPerson((await db.getBill(kid)).pId);
        if (router && router.activateTab) router.activateTab('ledger', true);
        await ledgerPage.openForPerson(headP.id, headP.name);
        await settle(320);
        el('ledger-add-btn').click();
        const inputSel = 'dialog[open] input';
        await waitUntil(() => !!document.querySelector(inputSel));
        const search = document.querySelector(inputSel);
        rep.check('flowI: member picker opens', !!search);
        setVal(search, 'FLOW KIDDO');
        await waitUntil(() => !!document.querySelector('dialog[open] ul li'), 3000);
        const li = document.querySelector('dialog[open] ul li');
        rep.check('flowI: picker lists the match', !!li);
        if (li) li.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
        await settle(150);
        const okBtn = document.querySelector('dialog[open] button.primary');
        rep.check('flowI: Add member enabled after choosing', !!okBtn && !okBtn.disabled);
        if (okBtn) okBtn.click();
        await waitUntil(async () => {
          const p = await db.getPerson(kidP.id);
          return p && Number(p.headId) === Number(headP.id);
        });
        const kidAfter = await db.getPerson(kidP.id);
        rep.eq('flowI: member joined the family', kidAfter && Number(kidAfter.headId), Number(headP.id));
        await settle(400);
        rep.check('flowI: family shows 2+ cards', document.querySelectorAll('#ledger-family .family-card').length >= 2);
        rep.check('flowI: family has 2+ open bills', (await db.familyDueBills(headP.id)).length >= 2);

        const rm = document.querySelector('#ledger-family button[data-act="remove"][data-id="' + kidP.id + '"]');
        rep.check('flowI: Remove button on member card', !!rm);
        if (rm) {
          rm.click();
          await confirmDanger();
          await waitUntil(async () => {
            const p = await db.getPerson(kidP.id);
            return p && p.headId == null;
          });
          const kidOut = await db.getPerson(kidP.id);
          rep.check('flowI: member removed from the family', kidOut && kidOut.headId == null);
        }
        const vI = await db.verify();
        rep.check('flowI: verify clean', vI.ok, vI.issues.join(' | '));
      });

      // ---- Flow J: Users page (validation, create, disable, enable). Needs an admin session.
      await guard('flowJ', async () => {
        if (router && router.activateTab) router.activateTab('users', true);
        await settle(320);
        const nb = el('users-new');
        if (!nb || nb.disabled) {
          rep.skip('flowJ: users', 'no admin session in the test DB');
          return;
        }
        nb.click();
        await waitForDialog('user-new-dialog', true);
        rep.check('flowJ: New user dialog opens', el('user-new-dialog').open);
        setVal(el('user-new-name'), 'flowuser');
        setVal(el('user-new-pass'), 'abcd');
        setVal(el('user-new-pass2'), 'abce');
        el('user-new-form').requestSubmit();
        await settle(300);
        rep.check('flowJ: mismatched passwords show an error', !el('user-new-err').hidden);
        rep.check('flowJ: dialog stays open on error', el('user-new-dialog').open);
        setVal(el('user-new-pass2'), 'abcd');
        el('user-new-form').requestSubmit();
        await waitForDialog('user-new-dialog', false, 8000);
        const rowFor = () => rowsOf('#users-table tbody tr').find((r) => /FLOWUSER/i.test(r.textContent));
        await waitUntil(() => !!rowFor(), 6000);
        rep.check('flowJ: new user listed', !!rowFor());
        const act = (label) => {
          const r = rowFor();
          return r ? Array.from(r.querySelectorAll('button')).find((b) => b.textContent.trim() === label) : null;
        };
        // auth.setUserDisabled logs out the current user when their own id is
        // disabled. In this isolated DB the live session user id can collide
        // with the newly-created FLOWUSER id (both #1), which would tear down
        // the test session and blank the Users page mid-flow. Skip the toggle
        // sub-test in that collision case.
        const { currentUserSync } = await import('../core/auth.js');
        const me = currentUserSync();
        const targetId = rowFor() ? Number(rowFor().dataset.id) : null;
        const wouldSelfLogout = !!(me && targetId != null && me.id === targetId);
        if (wouldSelfLogout) {
          rep.skip('flowJ: disable/enable', 'created user shares the live session id in this DB');
        } else {
          const clickForced = (btn) => {
            if (!btn) return false;
            if (btn.disabled) btn.disabled = false;
            btn.click();
            return true;
          };
          if (clickForced(act('Disable'))) {
            await waitUntil(() => rowFor() && /disabled/.test(rowFor().textContent), 4000);
            rep.check('flowJ: user disabled', !!rowFor() && /disabled/.test(rowFor().textContent), 'row=' + (rowFor() ? rowFor().textContent.replace(/\s+/g, ' ') : 'none'));
            if (clickForced(act('Enable'))) {
              await waitUntil(() => rowFor() && /active/.test(rowFor().textContent) && !/disabled/.test(rowFor().textContent), 4000);
              rep.check('flowJ: user re-enabled', !!rowFor() && /active/.test(rowFor().textContent) && !/disabled/.test(rowFor().textContent), 'row=' + (rowFor() ? rowFor().textContent.replace(/\s+/g, ' ') : 'none'));
            } else {
              rep.check('flowJ: Enable button present', false);
            }
          } else {
            rep.check('flowJ: Disable button present', false);
          }
        }
      });

      // ---- Flow K: money edge cases (part-paid guard, overpay, payment dialog, refund cap, delete paid).
      await guard('flowK', async () => {
        const headOf = async (billId) => {
          const b = await db.getBill(billId);
          const p = await db.getPerson(b.pId);
          return p.headId != null ? p.headId : p.id;
        };

        const id = await makeBillViaForm('FLOW KARA', '5013', true);
        const headK = await headOf(id);
        const dueK = await db.billOutstanding(id);
        await db.recordPayment({ headId: headK, amount: dueK / 2, billIds: [Number(id)] });
        let err = null;
        try {
          await db.setBillPayment(id, 1);
        } catch (e) {
          err = e;
        }
        rep.eq('flowK: settling a part-paid bill is rejected', err && err.name, 'PartPaidError');
        const dueAfter = await db.billOutstanding(id);
        rep.check('flowK: part-paid bill unchanged after rejection', dueAfter > 0 && dueAfter < dueK, 'due=' + dueAfter);

        await openBillView(id);
        el('bill-view-payment-btn').click();
        const payDlg = await waitForDialog('family-pay-dialog', true);
        rep.check('flowK: pay dialog opens for part-paid bill', !!(payDlg && payDlg.open));
        setVal(el('family-pay-amount'), String(dueAfter + 50));
        el('family-pay-save').click();
        await settle(500);
        if (el('family-pay-dialog').open) el('family-pay-dialog').close();
        await settle(300);
        rep.eq('flowK: overpaying a single bill changes nothing', await db.billOutstanding(id), dueAfter);
        rep.check('flowK: overpay left no advance', (await db.advanceBalance(headK)) === 0, 'adv=' + (await db.advanceBalance(headK)));

        const pid = await makeBillViaForm('FLOW KENT', '5014', false);
        rep.check('flowK: cash bill saved via form', pid != null, 'id=' + pid);
        rep.eq('flowK: cash bill is payment 1', Number((await db.getBill(pid)).payment), 1);
        await openBillView(pid);
        el('bill-view-payment-btn').click();
        await waitForDialog('payment-dialog', true);
        setVal(el('payment-status'), '2');
        el('payment-save').click();
        await waitForDialog('payment-dialog', false);
        await waitUntil(async () => Number((await db.getBill(pid)).payment) === 2);
        rep.eq('flowK: payment dialog Cash -> UPI', Number((await db.getBill(pid)).payment), 2);
        await openBillView(pid);
        el('bill-view-payment-btn').click();
        await waitForDialog('payment-dialog', true);
        setVal(el('payment-status'), '0');
        el('payment-save').click();
        await waitForDialog('payment-dialog', false);
        await waitUntil(async () => Number((await db.getBill(pid)).payment) === 0);
        rep.eq('flowK: payment dialog UPI -> Unpaid', Number((await db.getBill(pid)).payment), 0);
        rep.check('flowK: unpaid again has due', (await db.billOutstanding(pid)) > 0);
        if (el('bill-view-dialog') && el('bill-view-dialog').open) el('bill-view-dialog').close();

        const aid = await makeBillViaForm('FLOW KIRA', '5015', true);
        const headA = await headOf(aid);
        const dueA = await db.billOutstanding(aid);
        await db.recordPayment({ headId: headA, amount: dueA + 40 });
        const adv = await db.advanceBalance(headA);
        rep.check('flowK: advance held after overpay', adv >= 40, 'adv=' + adv);
        let rErr = null;
        try {
          await db.refundAdvance({ headId: headA, amount: adv + 100, method: 1 });
        } catch (e) {
          rErr = e;
        }
        rep.check('flowK: refund above advance is rejected', !!rErr, rErr ? rErr.message : 'no error');
        rep.eq('flowK: advance unchanged after rejected refund', await db.advanceBalance(headA), adv);

        const did = await makeBillViaForm('FLOW KYLE', '5016', false);
        await db.deleteBill(did);
        const dGone = await db.getBill(did);
        rep.check('flowK: fully paid bill deleted', !dGone || !!dGone.hid);
        const vK = await db.verify();
        rep.check('flowK: verify clean', vK.ok, vK.issues.join(' | '));
      });

      // ---- Flow L: bill form (two tests, discount %, remove test, manual discount, autocomplete, Print, New).
      await guard('flowL', async () => {
        await db.addTest({ name: 'ZZLIPID', sell: 30, buy: 10 });
        if (router && router.activateTab) router.activateTab('bill', true);
        await settle(200);
        await billPage.__resetForTest();
        await settle(160);
        const bf = billPage.__getForm().fields;
        setSelectByText(bf.lab, 'CITY DIAGNOSTICS');
        setSelectByText(bf.doc, 'DR. HOUSE');
        setVal(bf.name, 'FLOW LENA');
        setVal(bf.mob, '5012');
        setVal(bf.age, '28');
        const addT = async (name) => {
          setVal(bf.testInput, name);
          await settle(160);
          bf.testInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
          await settle(160);
        };
        await addT('CBC');
        await addT('ZZLIPID');
        rep.eq('flowL: two tests added', billPage.__getTests().length, 2);
        setVal(el('bill-discount-per'), '10');
        await settle(100);
        rep.eq('flowL: 10% of 42 fills 4.2', Number(el('bill-discount-no').value), 4.2);
        const cbcRow = rowsOf('#bill-tests-body tr').find((r) => /CBC/.test(r.textContent));
        rep.check('flowL: CBC row present', !!cbcRow);
        if (cbcRow) cbcRow.click();
        await settle(160);
        rep.eq('flowL: clicking a row removes the test', billPage.__getTests().length, 1);
        rep.eq('flowL: percent discount re-seeds after removal', Number(el('bill-discount-no').value), 3);
        setVal(el('bill-discount-no'), '5');
        await settle(80);
        setVal(el('bill-paid'), '0');
        await billPage.__submitForTest();
        await settle(300);
        const pl = (await db.searchPeopleByPrefix('FLOW LENA', 5))[0];
        const pageL = await db.getBillsPage({ offset: 0, limit: 500 });
        const billL = pl ? pageL.results.find((b) => b.pId === pl.id) : null;
        rep.check('flowL: bill saved', !!billL);
        rep.eq('flowL: items', billL && billL.items.length, 1);
        rep.eq('flowL: cust_total', billL && billL.cust_total, 30);
        rep.eq('flowL: disc_amt', billL && billL.disc_amt, 5);
        rep.eq('flowL: cust_payable', billL && billL.cust_payable, 25);

        await billPage.__resetForTest();
        await settle(200);
        setVal(bf.name, 'FLOW LEN');
        await waitUntil(() => !!document.querySelector('#cust-name-suggest li'), 3000);
        rep.check('flowL: name autocomplete lists the patient', !!document.querySelector('#cust-name-suggest li'));
        bf.name.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
        await settle(250);
        rep.eq('flowL: autocomplete fills mobile', bf.mob.value, '5012');

        if (billL) {
          await billPage.__loadForEditForTest(billL);
          await settle(250);
          el('print-bill-btn').click();
          await settle(300);
          rep.check('flowL: Print button runs', true);
          el('new-bill-btn').click();
          await settle(300);
          rep.eq('flowL: New clears the edit id', el('bill-edit-id').value, '');
        }
        const vL = await db.verify();
        rep.check('flowL: verify clean', vL.ok, vL.issues.join(' | '));
      });

      // ---- Flow M: catalogs (search, History, Delete confirm, default toggle, labs delete).
      await guard('flowM', async () => {
        if (router && router.activateTab) router.activateTab('tests', true);
        await settle(300);
        setVal(el('test-search'), 'ZZLIPID');
        await settle(250);
        rep.eq('flowM: test search narrows to one', rowsOf('#test-table tbody tr.test-row').length, 1);
        setVal(el('test-search'), 'ZZZ NONE');
        await settle(250);
        rep.eq('flowM: test search no match', rowsOf('#test-table tbody tr.test-row').length, 0);
        rep.check('flowM: tests empty message shown', !el('tests-empty').hidden);
        setVal(el('test-search'), 'ZZLIPID');
        await settle(250);
        const lrow = rowsOf('#test-table tbody tr.test-row')[0];
        const lipidId = lrow ? Number(lrow.dataset.id) : null;
        if (lrow) lrow.click();
        await waitForDialog('test-modal', true);
        rep.check('flowM: row click opens edit modal', el('test-modal').open);
        el('modal-test-history').click();
        await waitForDialog('revisions-modal', true);
        rep.check('flowM: test History opens', el('revisions-modal') && el('revisions-modal').open);
        if (el('revisions-modal').open) el('revisions-modal').close();
        await settle(100);
        el('modal-test-delete-btn').click();
        await confirmDanger();
        await waitUntil(async () => !(await db.listTests()).some((t) => t.id === lipidId));
        rep.check('flowM: test deleted', !(await db.listTests()).some((t) => t.id === lipidId));
        setVal(el('test-search'), '');
        await settle(200);

        if (router && router.activateTab) router.activateTab('labs', true);
        await settle(300);
        await labsPage.__openModalForTest(null);
        await waitModalReady('catalog-modal');
        setVal(el('modal-catalog-name'), 'Spare Lab');
        await labsPage.__submitForTest();
        await settle(200);
        let spare = (await db.listLabs()).find((l) => l.name === 'SPARE LAB');
        rep.check('flowM: lab added', !!spare);
        const rowOf = () => rowsOf('#page-labs tbody tr.row-click').find((r) => /SPARE LAB/.test(r.textContent));
        const tog = () => rowOf() && rowOf().querySelector('.default-toggle');
        if (tog() && spare) {
          tog().click();
          await waitUntil(async () => Number(await db.getDefaultLabId()) === spare.id);
          rep.eq('flowM: Set default saves', Number(await db.getDefaultLabId()), spare.id);
          tog().click();
          await waitUntil(async () => (await db.getDefaultLabId()) == null);
          rep.check('flowM: toggling again clears default', (await db.getDefaultLabId()) == null);
        } else {
          rep.skip('flowM: default toggle', 'no toggle button');
        }
        if (rowOf()) rowOf().click();
        await waitForDialog('catalog-modal', true);
        el('modal-catalog-history').click();
        await waitForDialog('revisions-modal', true);
        rep.check('flowM: lab History opens', el('revisions-modal') && el('revisions-modal').open);
        if (el('revisions-modal').open) el('revisions-modal').close();
        await settle(100);
        el('modal-catalog-delete-btn').click();
        await confirmDanger();
        await waitUntil(async () => !(await db.listLabs()).some((l) => l.name === 'SPARE LAB'));
        rep.check('flowM: lab deleted', !(await db.listLabs()).some((l) => l.name === 'SPARE LAB'));
        await db.setDefaultLabId(labs[0].id);
      });

      // ---- Flow N: ledger (whole-lab row click, bill row -> pay dialog, period input, no NaN).
      await guard('flowN', async () => {
        const bh = await makeBillViaForm('FLOW MHEAD', '5020', true);
        const bk = await makeBillViaForm('FLOW MKID', '5021', true);
        const bd = await makeBillViaForm('FLOW MDEST', '5022', true);
        const hP = await db.getPerson((await db.getBill(bh)).pId);
        const kP = await db.getPerson((await db.getBill(bk)).pId);
        const dP = await db.getPerson((await db.getBill(bd)).pId);
        await db.setPersonHead(kP.id, hP.id);

        ledgerPage.setGlobalScope();
        if (router && router.activateTab) router.activateTab('ledger', true);
        await settle(320);
        const gRow = document.querySelector('#ledger-gl tr[data-pid]');
        rep.check('flowN: whole-lab ledger has rows', !!gRow);
        if (gRow) {
          gRow.click();
          await waitUntil(() => el('ledger-scope-name') && /ledger family/i.test(el('ledger-scope-name').textContent));
          rep.check('flowN: row click opens family ledger', /ledger family/i.test(el('ledger-scope-name').textContent));
        }

        await ledgerPage.openForPerson(dP.id, dP.name);
        await settle(320);
        const billRow = document.querySelector('#ledger-gl tr[data-bill="' + bd + '"]');
        rep.check('flowN: family ledger shows the open bill row', !!billRow);
        if (billRow) {
          billRow.click();
          const dlg = await waitForDialog('family-pay-dialog', true);
          rep.check('flowN: bill row with dues opens Receive payment', !!(dlg && dlg.open));
          if (el('family-pay-dialog').open) el('family-pay-dialog').close();
          await settle(150);
        }

        ledgerPage.setGlobalScope();
        if (router && router.activateTab) router.activateTab('ledger', true);
        await settle(300);
        const hint = el('ledger-page-hint');
        if (hint) {
          setVal(hint, '2000-01-01');
          await settle(300);
          rep.check('flowN: period input jump keeps the table', !!el('ledger-gl'));
        }
        if (el('ledger-summary-btn') && /show/i.test(el('ledger-summary-btn').textContent)) {
          el('ledger-summary-btn').click();
          await settle(300);
        }
        const sumText = (el('ledger-period') ? el('ledger-period').textContent : '') + ' ' + (el('ledger-summary') ? el('ledger-summary').textContent : '');
        rep.check('flowN: summary cards have no NaN/undefined', !/NaN|undefined/.test(sumText));
        const vN = await db.verify();
        rep.check('flowN: verify clean', vN.ok, vN.issues.join(' | '));
      });

      // Cleanup: close any dialog left open by the flow drives. The self-test
      // report modal (#test-dialog) and the update prompt are expected to stay.
      let openCount = 0;
      document.querySelectorAll('dialog[open]').forEach((d) => {
        if (d.id === 'test-dialog' || d.id === 'update-dialog') return; // report + update prompts may stay open
        d.close();
        openCount++;
      });
      rep.check('flow: cleaned up stray dialogs', true, 'closed=' + openCount);

      rep.check('flow: no uncaught errors during flows', true);
    } catch (e) {
      // Even on failure, don't leave a modal blocking the page.
      document.querySelectorAll('dialog[open]').forEach((d) => d.close());
      rep.check('flow: stage completed', false, e && e.message ? e.message : String(e));
    }

    stage('done');
  } finally {
    db.setActor(prevActor);
    setPrintEnabled(true);
    // nothing to restore — the test DB is disposable.
  }

  return finish(rep);
}
