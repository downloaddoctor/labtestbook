// Boot: open DB, wire router, wire statusbar (backup/restore/log/test), init pages.

import db from '../core/db.js';
import backup, { hasFsAccess } from '../backup/backup.js';
import Dialog from './dialog.js';
import { Pages } from './pages/index.js';
import { createRouter, routeFromHash, setRouter, ADMIN_ONLY } from './router.js';
import { currentUser, isAdmin } from '../core/auth.js';
import { openModal } from './modals/index.js';
import { toast, toastHistory } from './toast.js';
import { el } from './dom.js';
import { install as installDiag, snapshot as diagSnapshot } from '../core/diag.js';
import { acquireTabLock } from '../core/tabLock.js';
import { requireAuth } from '../core/auth.js';
import { showAuthGate, hideGate } from './auth.js';
import { mkProgress } from './progress.js';

// ---- backup/restore ----

async function doBackup() {
  // No File System Access API -> save a CSV file instead of picking a folder.
  if (!hasFsAccess) {
    try {
      const r = await backup.downloadCsv();
      toast('Backup saved: ' + r.filename, 'ok');
    } catch (err) {
      toast('Backup failed: ' + (err && err.message ? err.message : err), 'err');
    }
    return;
  }
  const prog = mkProgress('Backing up');
  try {
    prog.start('writing…');
    await backup.pickOrBackup();
    prog.done();
    toast('Backup written to folder.', 'ok');
    backup.updateStatus();
  } catch (err) {
    prog.done();
    // User cancelled the folder picker -> fall back to a CSV download.
    if (err && err.name === 'AbortError') {
      try {
        const r = await backup.downloadCsv();
        toast('Backup saved: ' + r.filename, 'ok');
      } catch (e2) {
        toast('Backup failed: ' + (e2 && e2.message ? e2.message : e2), 'err');
      }
      return;
    }
    toast('Backup failed: ' + (err && err.message ? err.message : err), 'err');
  }
}

// Show the backup-source picker as a timeline. Resolves to a chosen entry or
// null. Reads the #details line of each entry for a summary pill row.
async function pickRestoreSource() {
  const st = backup.state();
  const groups = await backup.listBackups();
  const allEntries = [
    ...(groups.latest ? [groups.latest] : []),
    ...groups.daily,
    ...groups.archive,
  ];
  const detailsMap = new Map();
  await Promise.all(
    allEntries.map(async (e) => {
      try {
        detailsMap.set(e, await backup.readDetailsOf(e));
      } catch (_) {
        detailsMap.set(e, null);
      }
    })
  );
  const toItem = (e) => {
    const d = detailsMap.get(e);
    const pills = [];
    if (d) {
      const order = ['bills', 'people', 'tests', 'labs', 'doctors', 'payments', 'allocations', 'users'];
      for (const k of order) {
        if (d[k] != null) pills.push(d[k] + ' ' + k);
      }
    }
    const when = (d && d.date) || e.date;
    return {
      value: e,
      name: e.name,
      version: (d && d.version) || '—',
      when: when ? new Date(when).toLocaleString() : '?',
      pills,
      note: !d && e.size != null ? e.size + ' B' : '',
    };
  };
  const sub = st.folderName ? 'Folder: ' + st.folderName : '';
  return await openModal('restorePicker', {
    sub,
    groups: [
      { title: 'Latest', items: groups.latest ? [toItem(groups.latest)] : [] },
      { title: 'Daily snapshots', items: groups.daily.map(toItem) },
      { title: 'Archived backups', items: groups.archive.map(toItem) },
    ],
  });
}
// Confirm + run a restore from a specific entry.
async function doRestoreFromEntry(entry, router) {
  const d = await backup.readDetailsOf(entry).catch(() => null);
  const summary = d && d.bills != null ? `${d.bills} bills, ${d.people != null ? d.people : '?'} people` : '';
  const ok = await Dialog.confirm(
    'Restore will REPLACE all current bills from this backup. Continue?' +
    (summary ? '\n\n' + entry.name + ' — ' + summary : '\n\n' + entry.name),
    { danger: true, okLabel: 'Restore', title: 'Confirm restore' }
  );
  if (!ok) return;
  // yieldMs: 0 — replay runs inside one IndexedDB transaction; a paint-yield
  // here would drain the tx microtask queue and auto-commit it early.
  const prog = mkProgress('Restoring', { yieldMs: 0 });
  try {
    prog.start();
    const r = await backup.restoreFromEntry(entry, {
      onProgress: ({ processed, total }) => prog.step(processed, total),
    });
    prog.done();
    const tail = r.skipped ? ` (${r.skipped} skipped)` : '';
    toast(`Restored ${r.count} bills${tail}.`, r.skipped ? 'err' : 'ok');
    if (r.skipped && r.skippedRows && r.skippedRows.length) {
      backup.reportRestoreErrors({ source: r.source, folderName: r.folderName, skippedRows: r.skippedRows });
    }
    if (r.legacyNoPayments) {
      toast('No part-payment/advance rows in this backup. Advance will be 0.', 'warn');
    }
    warnDanglingRefs(r.danglingRefs);
    if (router) router.activateTab(router.currentTab, true);
  } catch (err) {
    prog.done();
    if (err && err.name === 'AbortError') return;
    toast('Restore failed: ' + (err && err.message ? err.message : err), 'err');
  }
}

async function doRestoreFromFolder(router) {
  const entry = await pickRestoreSource();
  if (!entry) return;
  await doRestoreFromEntry(entry, router);
}

// File-input restore. The change listener is attached once (lazily) and reuses
// the current `router` via a module-level holder, so repeated clicks don't
// stack handlers the way `input.onchange = ...` would overwrite/leak.
let _restoreRouter = null;
let _restoreListenerAttached = false;

async function _onRestoreFileChange() {
  const input = el('file-restore');
  const f = input.files && input.files[0];
  input.value = '';
  if (!f) return;
  const ok = await Dialog.confirm(
    'Restore will REPLACE all current bills from this file. Continue?',
    { danger: true, okLabel: 'Restore', title: 'Restore from file' }
  );
  if (!ok) return;
  // yieldMs: 0 — see note above (replay is one IndexedDB transaction).
  const prog = mkProgress('Restoring', { yieldMs: 0 });
  try {
    prog.start();
    const r = await backup.restoreFromFileObject(f, {
      onProgress: ({ processed, total }) => prog.step(processed, total),
    });
    prog.done();
    const tail = r.skipped ? ` (${r.skipped} skipped)` : '';
    toast(`Restored ${r.count} bills${tail}.`, r.skipped ? 'err' : 'ok');
    if (r.legacyNoPayments) {
      toast('No part-payment/advance rows in this backup. Advance will be 0.', 'warn');
    }
    warnDanglingRefs(r.danglingRefs);
    const router = _restoreRouter;
    if (router) router.activateTab(router.currentTab, true);
  } catch (err) {
    prog.done();
    toast('Restore failed: ' + (err && err.message ? err.message : err), 'err');
  }
}

async function doRestoreFromFile(router) {
  _restoreRouter = router;
  const input = el('file-restore');
  input.value = '';
  if (!_restoreListenerAttached) {
    input.addEventListener('change', _onRestoreFileChange);
    _restoreListenerAttached = true;
  }
  input.click();
}

async function showLog() {
  const st = backup.state();
  const pendingLines = await backup.pendingLines();
  const pendingReason =
    pendingLines.length === 0 ? 'nothing queued'
      : !st.hasFolder ? 'no folder set'
        : st.lastError ? 'last flush error: ' + st.lastError
          : 'idle — debounce pending (1.5s)';
  const sections = [];
  sections.push(
    'PENDING FLUSH (' + pendingLines.length + ') — ' + pendingReason + '\n' +
    '─'.repeat(48) + '\n' +
    (pendingLines.length ? pendingLines.join('\n') : '(none)')
  );
  const hist = toastHistory();
  sections.push(
    'RECENT MESSAGES (' + hist.length + ')\n' +
    '─'.repeat(48) + '\n' +
    (hist.length
      ? hist.map((h) => {
        const t = new Date(h.at).toLocaleTimeString();
        const kind = h.kind ? '[' + h.kind + '] ' : '';
        return t + '  ' + kind + h.text;
      }).join('\n')
      : '(none)')
  );
  let sub = '';
  let text = null;
  try {
    text = st.hasFolder ? await backup.readLatestText() : null;
  } catch (err) {
    text = 'Failed to read log: ' + (err && err.message ? err.message : err);
  }
  if (!text) {
    sections.push(
      'BACKUP LOG\n' +
      '─'.repeat(48) + '\n' +
      (st.hasFolder
        ? '(no backup file yet — click Backup to create one)'
        : '(no backup folder set — click Backup first)')
    );
    sub = st.hasFolder ? st.folderName : 'no folder';
  } else {
    sub = st.folderName + ' / ' + backup.LATEST + ' · ' + text.length + ' bytes';
    const shown = text.length > 200000 ? text.slice(0, 200000) + '\n…(truncated)' : text;
    sections.push('BACKUP LOG\n' + '─'.repeat(48) + '\n' + shown);
  }
  const buttons = [
    {
      label: 'Copy diagnostics',
      onClick: async () => {
        try {
          const t = await diagSnapshot({ db, backup });
          await navigator.clipboard.writeText(t);
          toast('Diagnostics copied to clipboard.', 'ok');
        } catch (e) {
          toast('Copy failed: ' + (e && e.message ? e.message : e), 'err');
        }
      },
    },
  ];
  await openModal('log', { sub, text: sections.join('\n\n'), scrollEnd: true, buttons });
}

async function runTest(router) {
  const opEl = el('work-status');
  const setOp = (text) => {
    if (!opEl) return;
    if (text == null) {
      opEl.hidden = true;
      opEl.textContent = '';
      opEl.classList.remove('work');
    } else {
      opEl.hidden = false;
      opEl.classList.add('work');
      opEl.textContent = 'self-test: ' + text;
    }
  };

  // The self-test drives the REAL UI. Accumulate results while the operator
  // watches the form, then show the full log at the end in a modal.
  setOp('running…');

  const lines = [];
  // Only the failures, prefixed with their stage, so "Copy errors" yields a
  // paste-ready block without the 250+ passing lines.
  const failures = [];
  let currentStage = '';
  const appendLine = (line) => {
    lines.push(line);
  };
  const onProgress = (name, ok, detail, status) => {
    if (name === '#stage') {
      setOp(detail);
      currentStage = detail;
      appendLine('');
      appendLine('=== ' + detail + ' ===');
      return;
    }
    if (name === '#info') {
      appendLine('· ' + detail);
      return;
    }
    const mark = status === 'SKIP' ? '–' : ok ? '✓' : '✗';
    const line = `${mark} ${name}${detail ? '  —  ' + detail : ''}`;
    appendLine(line);
    if (status === 'FAIL') {
      failures.push(currentStage ? `[${currentStage}] ${name}${detail ? '  —  ' + detail : ''}` : line);
    }
  };

  let tally = '';
  try {
    const { runSelfTest } = await import('../dev/selftest.js');
    const res = await runSelfTest({ onProgress, router });
    tally = `${res.passed} passed · ${res.failed} failed${res.skipped ? ' · ' + res.skipped + ' skipped' : ''}`;
  } catch (err) {
    tally = 'error';
    const trace = String(err && err.stack ? err.stack : err);
    appendLine(trace);
    failures.push('[' + (currentStage || 'crash') + '] ' + trace);
  }

  // "Copy errors" copies only the failure block (or a one-line all-clear).
  const errorBlock = failures.length
    ? tally + '\n\n' + failures.join('\n')
    : tally + '\n\nNo failures.';
  const buttons = [
    {
      label: failures.length ? `Copy errors (${failures.length})` : 'Copy result',
      async onClick() {
        try {
          await navigator.clipboard.writeText(errorBlock);
          toast(failures.length ? `Copied ${failures.length} error(s).` : 'Copied result.', 'ok');
        } catch (e) {
          toast('Copy failed: ' + (e && e.message ? e.message : e), 'err');
        }
      },
    },
  ];

  // Done: reveal the full log in a modal.
  setOp(null);
  await openModal('selfTest', {
    sub: tally,
    text: lines.join('\n'),
    scrollEnd: true,
    buttons,
  });
}

function isDev() {
  return /(?:\?|&)dev=1(?:&|$)/.test(location.search);
}

async function wireDevCluster(router) {
  const cluster = el('dev-cluster');
  if (!cluster) return;
  // Dev tools (Clear / Seed) are admin-only; applySessionToShell runs first.
  cluster.hidden = !sessionIsAdmin;

  {
    const btnSeed = el('btn-seed');
    const runSeed = async (cfg) => {
      btnSeed.disabled = true;
      const prog = mkProgress('Seeding');
      try {
        prog.start();
        const { seed } = await import('../dev/seed.js');
        const r = await seed({
          ...cfg,
          onProgress: ({ phase, processed, total }) =>
            phase === 'catalog' ? prog.update('catalog…') : prog.step(processed, total),
        });
        prog.done();
        toast(`Seeded ${r.bills} bills · ${r.patients} patients.`, 'ok');
        if (router) router.activateTab(router.currentTab, true);
      } catch (e) {
        prog.done();
        toast('Seed failed: ' + (e && e.message ? e.message : e), 'err');
      } finally {
        btnSeed.disabled = false;
      }
    };
    // Single click seeds defaults; double click opens the config prompt. The
    // browser fires click-then-dblclick, so delay the single-click action and
    // cancel it if a second click arrives within the threshold.
    let seedClickTimer = null;
    btnSeed.title = 'Click: seed defaults. Double-click: configure.';
    btnSeed.addEventListener('click', () => {
      if (seedClickTimer) return; // second click of a double-click
      seedClickTimer = setTimeout(async () => {
        seedClickTimer = null;
        const { SEED_CONFIG } = await import('../dev/seed.js');
        runSeed(SEED_CONFIG);
      }, 260);
    });
    btnSeed.addEventListener('dblclick', async () => {
      if (seedClickTimer) {
        clearTimeout(seedClickTimer);
        seedClickTimer = null;
      }
      const { promptSeedConfig } = await import('../dev/seed.js');
      const cfg = promptSeedConfig();
      if (cfg === null) return; // cancelled
      runSeed(cfg);
    });
  }

  el('btn-clear').addEventListener('click', async () => {
    const ok = await Dialog.confirm('Clear ALL tests and bills? This cannot be undone.', {
      danger: true,
      okLabel: 'Clear',
      title: 'Clear data',
    });
    if (!ok) return;
    const { clearAll } = await import('../dev/seed.js');
    await clearAll();
    toast('Cleared.', 'ok');
    if (router) router.activateTab(router.currentTab, true);
  });
}

// Skip link: focus #main on click/Enter (native anchor jumps, but we also move
// focus for screen readers).
function wireSkipLink() {
  const link = document.querySelector('.skip-link');
  const main = el('main');
  if (!link || !main) return;
  link.addEventListener('click', (e) => {
    e.preventDefault();
    main.focus();
  });
}

// Snapshot the DB before an update is applied so a schema-affecting deploy
// can never land without a fallback copy. Returns true on success, false on
// failure (the caller asks the user whether to proceed regardless).
async function backupBeforeUpdate() {
  const prog = mkProgress('Backup before update');
  try {
    prog.start('saving…');
    if (backup.state().hasFolder) {
      await backup.archiveFull();
      prog.update('archived to folder');
    } else {
      await backup.downloadFullCsv();
      prog.update('downloaded CSV backup');
    }
    prog.done();
    return true;
  } catch (e) {
    prog.done();
    toast('Pre-update backup failed: ' + (e && e.message ? e.message : e), 'warn');
    return false;
  }
}

// Warn (don't block) when a restore produced bills whose id+version references
// point at rows missing from the log — a truncated or corrupt backup.
function warnDanglingRefs(dangling) {
  if (!dangling || !dangling.length) return;
  const kinds = {};
  for (const d of dangling) kinds[d.kind] = (kinds[d.kind] || 0) + 1;
  const summary = Object.entries(kinds).map(([k, n]) => `${n} ${k}`).join(', ');
  toast(`Restore warning: ${dangling.length} missing reference(s) — ${summary}.`, 'warn');
}

function wireStatusbar(router) {
  // Update-available indicator -> modal. The service worker fires
  // 'ltb:update-prompt' when it detects a new version; the status-bar button
  // opens the same modal so the user can also trigger it manually.
  const openUpdate = () => {
    openModal('update', {
      onNow: async () => {
        const ok = await backupBeforeUpdate();
        const proceed = await Dialog.confirm(
          ok
            ? 'Backup done. Proceed with the update? The app will reload.'
            : 'Backup could not be saved. Proceed with the update anyway? The app will reload.',
          { okLabel: 'Proceed', title: 'Backup done' }
        );
        if (!proceed) return;
        if (window.__ltbUpdate && window.__ltbUpdate.applyNow) window.__ltbUpdate.applyNow();
      },
    });
  };
  el('update-status')?.addEventListener('click', openUpdate);
  window.addEventListener('ltb:update-prompt', openUpdate);
  el('btn-backup')?.addEventListener('click', doBackup);
  el('btn-restore')?.addEventListener('click', () => {
    if (backup.state().hasFolder) doRestoreFromFolder(router);
    else doRestoreFromFile(router);
  });
  el('btn-log')?.addEventListener('click', showLog);
  el('btn-test')?.addEventListener('click', () => runTest(router));

  // Global Alt hotkeys:
  //   Alt+B — backup
  //   Alt+L — on the Bill tab with a customer: open that person's ledger;
  //           otherwise: the diagnostic log (admin only)
  //   Alt+N — from anywhere: start a fresh bill on the Bill tab
  window.addEventListener('keydown', (e) => {
    if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    const k = e.key.toLowerCase();
    if (k === 'b') {
      e.preventDefault();
      doBackup();
    } else if (k === 'n') {
      e.preventDefault();
      import('./pages/bill.js')
        .then((m) => m.newBill())
        .catch((err) => toast('New bill failed: ' + (err && err.message ? err.message : err), 'err'));
    } else if (k === 'l') {
      e.preventDefault();
      // 1) Patient-view modal open (from any tab): that patient's ledger.
      const pv = document.getElementById('patient-view-dialog');
      if (pv && pv.open && pv.dataset.patientId) {
        const id = Number(pv.dataset.patientId);
        pv.close();
        import('./pages/ledger.js')
          .then((m) => m.openForPerson(id))
          .catch((err) => toast('Ledger failed: ' + (err && err.message ? err.message : err), 'err'));
        return;
      }
      // 2) Bill tab with a customer attached: that customer's ledger.
      const billPage = document.getElementById('page-bill');
      if (billPage && !billPage.hidden) {
        import('./pages/bill.js')
          .then((m) => m.openCustomerLedger())
          .catch((err) => toast('Ledger failed: ' + (err && err.message ? err.message : err), 'err'));
        return;
      }
      // 3) Patients tab with a row focused: that patient's ledger.
      const patientsPage = document.getElementById('page-patients');
      if (patientsPage && !patientsPage.hidden) {
        import('./pages/patients.js')
          .then(async (m) => {
            const ok = await m.openActivePatientLedger();
            if (!ok) toast('Focus a patient row first — then Alt+L opens their ledger.', 'info');
          })
          .catch((err) => toast('Ledger failed: ' + (err && err.message ? err.message : err), 'err'));
        return;
      }
      // 4) Fallback: diagnostic log (admin only).
      if (sessionIsAdmin) showLog();
    }
  });
}

// ---- boot ----

// Full-screen 'already open' screen. No shell, no DB touched.
function showTabBlockedScreen(onRetry) {
  document.body.classList.add('auth-locked');
  const main = document.getElementById('main');
  if (main) main.hidden = true;
  const topbar = document.querySelector('.topbar');
  if (topbar) topbar.hidden = true;
  const statusbar = document.getElementById('statusbar');
  if (statusbar) statusbar.hidden = true;
  const wrap = document.createElement('div');
  wrap.className = 'auth-wrap';
  const card = document.createElement('div');
  card.className = 'auth-card';
  const h = document.createElement('h1');
  h.className = 'auth-title';
  h.textContent = 'Lab Test Book is already open';
  const p = document.createElement('p');
  p.className = 'auth-sub';
  p.textContent = 'Only one tab can use Lab Test Book at a time. Close the other tab, then retry.';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'primary auth-submit';
  btn.textContent = 'Retry';
  btn.addEventListener('click', () => onRetry());
  card.append(h, p, btn);
  wrap.appendChild(card);
  document.body.appendChild(wrap);
  btn.focus();
}

// Everything that runs ONLY when a session exists. Split out of boot() so the
// auth gate can drive the same sequence after login / create-admin.
// Cached 'current session is admin'. Read synchronously by the router's
// canAccess predicate. Refreshed before every route activation.
let sessionIsAdmin = false;

async function applySessionToShell() {
  const me = await currentUser();
  sessionIsAdmin = isAdmin(me);
  // Plain users see only New Bill + Bills; every other tab is admin-only.
  document.querySelectorAll('.tabs .nav-tab').forEach((btn) => {
    btn.hidden = !sessionIsAdmin && ADMIN_ONLY.has(btn.dataset.route);
  });
  const navUsers = document.getElementById('nav-users');
  if (navUsers && !sessionIsAdmin) navUsers.hidden = true;
  else if (navUsers) navUsers.hidden = false;
  // Plain users get the Backup button only (no Restore / Log / Test / Settings / dev tools).
  for (const id of ['btn-restore', 'btn-log', 'btn-test', 'btn-settings']) {
    const b = document.getElementById(id);
    if (b) b.hidden = !sessionIsAdmin;
  }
  const devCluster = document.getElementById('dev-cluster');
  if (devCluster && !sessionIsAdmin) devCluster.hidden = true;
  const whoami = document.getElementById('whoami');
  if (whoami) whoami.textContent = me ? me.username + (sessionIsAdmin ? ' · admin' : ' · user') : '';
  const btnLogout = document.getElementById('btn-logout');
  if (btnLogout && !btnLogout._wired) {
    btnLogout._wired = true;
    btnLogout.addEventListener('click', async () => {
      const { logout } = await import('../core/auth.js');
      await logout();
      location.reload();
    });
  }
}

// Settings dialog: pick the default lab (Affiliated By) + default doctor
// (Referred By) applied to new bills. Stored in meta via db.setDefault*Id.
function wireSettings() {
  const btn = el('btn-settings');
  if (!btn || btn._wired) return;
  btn._wired = true;
  btn.addEventListener('click', () => openModal('settings'));
}

// Drift banner: verify() found derived money data that disagrees with the facts.
// Shown until the user rebuilds from records or dismisses it.
function showDriftBanner(issues) {
  const bar = document.getElementById('drift-banner');
  if (!bar) return;
  const txt = document.getElementById('drift-banner-text');
  const rebuild = document.getElementById('drift-banner-rebuild');
  const dismiss = document.getElementById('drift-banner-dismiss');
  txt.textContent = 'Money data does not match the records (' + issues.length + ' difference' + (issues.length === 1 ? '' : 's') + '). Rebuild to fix it.';
  bar.hidden = false;
  rebuild.onclick = async () => {
    rebuild.disabled = true;
    try {
      await db.rebuildDerived();
      const again = await db.verify();
      if (again.ok) {
        bar.hidden = true;
        toast('Money data rebuilt from records.', 'ok');
      } else {
        console.warn('[labtestbook] drift remains:', again.issues);
        txt.textContent = 'Still inconsistent after rebuild (' + again.issues.length + '). Export a backup and check the Log.';
      }
    } catch (e) {
      toast(e && e.message ? e.message : String(e), 'err');
    } finally {
      rebuild.disabled = false;
    }
  };
  dismiss.onclick = () => { bar.hidden = true; };
}

async function bootAuthed(router) {
  hideGate();
  await applySessionToShell();
  wireSettings();
  // Actor hook: every bill write is stamped with the current user's id + v.
  // Wired once (the hook reads live state, so no re-wiring needed).
  if (!bootAuthed._actorWired) {
    bootAuthed._actorWired = true;
    const { currentUserSync } = await import('../core/auth.js');
    db.setActor(() => {
      const u = currentUserSync();
      return u ? { uId: u.id, uV: u.v != null ? u.v : 1 } : { uId: null, uV: null };
    });
  }
  wireSkipLink();
  if (isDev()) await wireDevCluster(router);
  backup.updateStatus();
  // Cheap integrity check on recently-touched persons. Full verify() runs
  // from the drift banner / selftest, never on the boot path.
  try {
    const v = await db.verifyRecent();
    if (!v.ok) {
      console.warn('[labtestbook] verify drift:', v.issues);
      showDriftBanner(v.issues);
    }
  } catch (e) {
    console.warn('[labtestbook] verify failed:', e);
  }
  // A non-admin left on an admin-only route is bounced to bill.
  if (!sessionIsAdmin && ADMIN_ONLY.has(router.currentTab)) router.activateTab('bill');
  router.activateTab(routeFromHash(), true, false);
}

async function boot() {
  // FIRST: single-tab guard. Must run before db.openDb() so a second tab never
  // touches IndexedDB.
  const lock = await acquireTabLock();
  if (!lock.ok) {
    showTabBlockedScreen(() => location.reload());
    return;
  }

  // Capture warn/error lines for the Log dialog's 'Copy diagnostics' button.
  installDiag();
  try {
    await db.openDb();
  } catch (err) {
    toast('Database failed to open: ' + (err && err.message ? err.message : err), 'err');
    return;
  }

  try {
    await backup.init();
    db.setJournal((entry) => backup.markDirty(entry));
  } catch (err) {
    console.warn('[labtestbook] backup.init failed:', err);
  }

  // Build the router now (it wires tab clicks + hashchange) but do NOT activate
  // a tab until auth succeeds. The gate hides the shell; bootAuthed un-hides it.
  const router = createRouter({
    pages: Pages,
    // Admin-only routes (users) refuse to mount for non-admins.
    canAccess: (name) => sessionIsAdmin || !ADMIN_ONLY.has(name),
  });
  setRouter(router);
  router.wire();
  wireStatusbar(router);

  // Auth gate: create-admin | login | authed.
  const gate = await requireAuth();
  if (gate.state === 'authed') {
    await bootAuthed(router);
  } else {
    await showAuthGate({ onAuthed: () => bootAuthed(router) });
  }
}

boot().catch((err) => {
  const msg = err && err.message ? err.message : String(err);
  toast('Startup error: ' + msg, 'err');
  console.error(err);
});
