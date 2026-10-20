PROJECT DIRECTORY
 src/
  core/ — DB, auth, billing, ledger, diff, norm, money, enums, diag, time, util, version, tabLock, store
  ui/ — app boot, router, auth gate, pages, modals, dialog, dom, toast, payment, progress, revisions
  ui/modals/ — generic modal component + one file per modal; index.js registers all
  ui/pages/ — bill, bills, patients, ledger, tests, labs, doctors, users, catalog, index (registry), listNav (row nav)
  backup/ — FS Access API backup/restore, CSV codec, meta store
  print/ — billHtml, printHtml
  dev/ — seed, selftest, catalog-data
 scripts/ — check-modules.sh, gen-shell-assets.sh

ENTRY-POINTS
 index.html — main HTML shell
 src/ui/app.js — main application boot, router wiring, auth gate
 sw.js — service worker for offline shell caching and update detection
 pw.js — PWA bootstrap, SW registration, update UI wiring

MODULES
 src/core/db.js — Dexie wrapper, schema v1..v10, revision/append-only model, projection rebuild, catalog CRUD + catalog revs (testRevs/labRevs/doctorRevs), default lab/doctor + companyName in Store ('ltb.defaults') via getCompanyName/setCompanyName
 src/core/db.write.js — THE write path: _addBillImpl (rejects duplicate id), updateBill, setBillPayment, deleteBill; delete requests: requestBillDelete, listDeleteRequests, pendingDeleteCount, resolveDeleteRequest
 src/core/db.reads.js — Projection reads, bill hydration, people search, revisions, openBills (indexed [hid+payment]), sortPeople/listPeopleDue (indexed [hid+*]), summarizeBills, activityForUser. listPeople uses compound [hid+lastBillAt] (orderBy needs the order field in the where index)
 src/core/db.export.js — CSV export of all revisions, rebuildProj
 src/core/db.restore.js — Replay log into DB, clearing rev/proj stores (keeping users); returns legacyNoPayments hint
 src/core/db.journal.js — Transaction-bound journal buffer for backup.js
 src/core/db.ledger.js — Cash book + receivables ledger, O(1) indexed reads via ledger table; ledgerOverview({headId}) = admin summary (sales, received, collected %, margin, dues aging, top debtors, advance, flow); ledgerForFamily(headId), familyBills(headId) = whole family group
 src/core/db.derive.js — SINGLE writer of derived data: _derive/_rederive (ledger + pending + advance), _moneyTx, verify()/verifyRecent()/_verifyPersons(), rebuildDerived(); facts -> derived, never the reverse. Boot runs verifyRecent (recent persons); full verify on demand. Ledger row identity (kind|billId|payId|at) compared, not just totals. Allocations deduped by id.
 src/core/db.payments.js — Family head part payments: familyIds, recordPayment (FIFO split, excess -> advance), advanceBalance, familyDueBills (scoped allocations), setPersonHead, _applyAdvance, refundAdvance
 src/core/auth.js — Client-side PBKDF2 auth, session management, throttling, inactivity auto-logout
 src/core/billing.js — Bill totals computation (cust_total, merch_total, disc_amt, cust_payable); ctcFloor({cust_total,merch_total}) = cost floor, maxDiscount() = largest ₹ discount keeping grand_total >= CTC (margin floored at 0)
 src/core/diff.js — Generic field-diff primitive for revisions
 src/core/norm.js — Normalizers for name (UPPERCASE), mobile, billNo, payment
 src/core/time.js — Time formatting utilities (fixed TZ offset, day/month bounds)
 src/core/util.js — Debounce utility
 src/core/version.js — APP_VERSION constant (20)
 src/core/tabLock.js — Web Locks API single-tab guard
 src/core/store.js — LocalStorage wrapper with namespace
 src/core/money.js — money/money0 formatters (2-dp, whole-rupee)
 src/core/enums.js — int enums (PAYMENT, ALLOC, LEDGER_KIND) + kindCode/kindName; never renumber
 src/core/diag.js — console.warn/error ring buffer + snapshot() for Copy diagnostics; install() idempotent
 src/print/billHtml.js — dual-copy receipt HTML (merchant left / customer right); pure, hydrated bill in. Ink-saving: no fills, hairline rules only (pr-rule), no copy labels. Both copies: centered company (bill.companyName from Settings, fallback 'LAB TEST BOOK') + Referred By (docName). Merchant adds Bill No/Date + Patient Name + Age/Sex rows. Customer adds company sub-heading header (bill.companyAddress; richText allows only attribute-free b/i/em/strong/u/br, newline→br), c-meta 2-col block (Receipt No | Date, Patient Name | Age / Sex, Mobile No | Referred By), Sr.No|Test Name|Charges table (full grid: outer box + vertical rules, same as merchant copy), totals (separate .c-totals table): Sub Total + Discount (only when disc_amt > 0) + Grand Total (always); ✓ before Grand Total when paid (payment != UNPAID); table has 4mm gap above, th forced #000; date via fmtDt (T→space). Merchant copy shows Bill No/Date row above the test table; footer row 'Total Tests: N' (count of printed tests). Dates print as '11 Oct 2026, 03:45 PM' (fmtDt, hand-parsed, zero-padded day and hour, no TZ shift). CSS .print-receipt in styles.css; page size A5 landscape (@page A5 landscape, receipt 210x148mm), bills with >16 tests (>14 when disc_amt > 0) get class pr-tall → named @page pr-a4 (A4, height 297mm); pr-tick forced #000 in @media print
 src/print/printHtml.js — printHtml(html) into hidden #print-root, window.print(), cleanup
 src/dev/seed.js — dev seed (?dev=1)
 src/dev/selftest.js — in-UI self-test suite (references modal element ids; modal bodies exist only after openModal)
 src/dev/catalog-data.js — dev-only sample tests/labs/doctors; never imported from prod paths
 src/backup/backup.js — FS Access API append-only log (labtestbook-latest.csv; daily/labtestbook-YYYY-MM-DD.csv; archive/labtestbook-<ts>.csv), daily snapshots, archive pruning, restore, re-queue on flush failure. Status line: 'backup: [N pending · ]<timeAgo ago|ready|no folder (Alt+B)|CSV download only>' with ok/err class; updateStatus ticks every 30s + on tab-focus. Downloads: labtestbook-<ts>.csv, labtestbook-backup-<ts>.csv, labtestbook-restore-errors-<ts>.log. setLogFileName swaps LATEST (self-test uses labtestbook-selftest.csv).
 src/backup/csv.js — CSV codec for revision log (schema 0-7); quote-aware line split
 src/backup/meta.js — Separate IndexedDB for storing FS DirectoryHandle
 src/ui/app.js — Boot sequence, auth gate, router init, statusbar, dev tools, drift banner. pickRestoreSource/showLog/runTest call openModal('restorePicker'|'log'|'selfTest'); the update prompt opens via openModal('update', {onNow}) from #update-status and the pw.js 'ltb:update-prompt' event. Settings opens openModal('settings')
 src/ui/router.js — Tab activation, hash sync, keyboard shortcuts (Ctrl/Alt+1..8 follow ROUTES order: bill, bills, patients, ledger, tests, labs, doctors, users); USER_ROUTES = bill, bills (all a plain 'user' may open); ADMIN_ONLY = every other route; app.js hides those nav tabs for non-admins, plus Restore/Log/Test/Settings buttons (plain users keep Backup + Logout only)
 src/ui/auth.js — Full-screen login / create-admin gate
 src/ui/pages/bill.js — Bill creation/editing, test selection, discount logic, print. Admin-only CTC button (#bill-discount-ctc, hidden for non-admins) in the discount row sets ₹ to maxDiscount (customer pays cost-to-cost, zero margin); clampDiscountToCtc() caps the ₹ field + applyPercentToAmount + save for admins so discount never exceeds CTC
 src/ui/pages/bills.js — Delete: admin deletes directly (confirm); plain user gets 'Request delete' (prompt reason -> db.requestBillDelete); admin-only 'Delete requests' button (#bills-requests, pending count) opens openModal('deleteRequests'). Row click -> openModal('billView', {bill, onAction}); billAction dispatches print/payment/edit/delete/history to the existing helpers (billPayment holds the receive/payment flow). Bills list for ONE day: day-cursor pager (bills-prev-day/next-day/today, bills-day-label = date input). Payment badge 3-state: Settled, Partial, Unpaid; derived from billOutstanding.
 src/ui/pages/patients.js — Patients list, search, pending dues, history, family head picker; patient timeline via openModal('patientView', {id, onBeforeShow, onClose}); receive-payment/refund-advance via familyPay modals; bill timeline badge shows Settled/Partial/Unpaid
 src/ui/modals/ — generic modal system; modal.js = shell (defineModal(name, cfg) + openModal(name, data) -> Promise<close value|null>, built lazily, tab-independent). cfg: id, closeId, title, sub, wide, enterSubmits, header, body, footer[], onOpen, onClose, onKey. ctx = {el, data, body, $, close, setTitle, setSub, render, s}. Files: patientView.js (patient timeline), payment.js (bill payment picker), familyMoney.js (familyPay/familyRefund), userNew.js, settings.js (company name + sub heading + default lab/doctor; Export/Import JSON, lab/doctor matched by name), textView.js (log + selfTest), restorePicker.js, update.js, testEdit.js (modal-test-*; price optional, blank -> 0), testBulk.js (modal-bulk-*; bulk add tests from pasted text/CSV file: header mode (Test Name + '*Price' col -> merchant price, customer price 0; same name + different price -> name gets '(sample)' suffix) or plain lines name, merchant price, price optional; quote-aware multi-line CSV; parseTests exported; dup names skipped; opened from #test-bulk-btn on Tests page), catalogEdit.js (modal-catalog-*), billView.js, deleteRequests.js, revisions.js. index.js imports every file and re-exports openModal/defineModal/isModalOpen. index.html now carries NO <dialog> markup.
 src/ui/familyPay.js — thin wrapper over the familyPay/familyRefund modals; receiveFamilyPayment(person) -> Promise<bool>; also addFamilyAdvance, refundFamilyAdvance, receiveBillPayment; used by patients.js + ledger.js + bills.js
 src/ui/pages/ledger.js — Row click: whole-lab -> openForPerson (member -> head, family scope); family scope -> bill with dues opens Receive payment; family scope shows head + member cards (#ledger-family, renderFamily). Family scope = head + members (ledgerForFamily, familyBills). Ledger: header = family scope chip row (#ledger-scope, only in family view, ✕ Whole lab) + .ledger-toolbar; layout top-down: scope row (#ledger-scope: name chip, ✕ Whole lab, Show/Hide all-time button on the right) -> family cards -> all-time summary (#ledger-summary) -> .ledger-toolbar; top admin summary (db.ledgerOverview -> cards Sales/Money in hand/To collect/Profit/Dues by age/Top dues; .admin-sum CSS; hidden by default, toggle button "Show all-time"), period cards (#ledger-period, .admin-sum: Sales/Money in/To collect/Profit + 3 flow trees How sales became money/Where the money came and went/How profit is made; always visible, built in render()), day/week/month/year pager (Earlier/Later + #ledger-page-hint period input: date/week/month/number by mode, change jumps to latest period at or before pick). Table cols: When/What happened/Money received/Unpaid/Lab cost/Profit. Scope: whole lab or one person. Uses .admin-sum CSS.
 src/ui/pages/tests.js — Test catalog page (customer + merchant price; name cell shows code · sample · tat hint, row title = info; search matches name/code/sample; row.dataset.name = plain name; bill.js typeahead matches name/code and shows hint); edit via openModal('testEdit', {id}) from modals/index.js
 src/ui/pages/labs.js, doctors.js — thin catalog pages via createCatalogPage (catalog.js)
 src/ui/pages/catalog.js — createCatalogPage(cfg): shared name-only catalog UX; edit via openModal('catalogEdit', {kind, id, labels, api, onDelete})
 src/ui/pages/users.js — User management (admin); new-user via openModal('userNew')
 src/ui/pages/index.js — Pages registry; router.activateTab looks up Pages[name].{mount,unmount}
 src/ui/pages/listNav.js — shared keyboard row-nav (data-list-nav); registerAction/unregisterAction; initAll/destroyAll
 src/ui/dialog.js, toast.js, dom.js, payment.js, progress.js — UI primitives (Dialog.confirm/prompt still used for simple confirmations). revisions.js = revision timeline + user activity; openRevisions/openBillRevisions/openUserActivity open the shell via openModal('revisions')

ARCHITECTURE
 Client-only PWA, no backend server.
 Data model is append-only revisioned entities (bills, people, tests, labs, doctors, users) + projection tables (billsProj, peopleProj) for O(1) current-state reads.
 Writes append a revision AND update the projection AND ledger table in the same Dexie transaction.
 Backup is an append-only CSV log via File System Access API, flushed via a debounced journal hook tied to Dexie transaction completion.
 Restore clears revision and projection stores (except `users` to preserve secrets) and replays the CSV log through the same write paths.
 Single-tab enforcement via Web Locks API prevents concurrent IndexedDB corruption.
 Read paths use compound indexes ([hid+payment], [hid+lastBillAt], [hid+pending], [hid+name]); no full-table scans for list views.
 Modal system: every dialog is built by src/ui/modals/modal.js at defineModal() time and opened from any page/tab via openModal(name, data). No tab or page owns a modal; index.html carries no <dialog> markup.

SCHEMA
 DB: 'labtestbook' (Dexie v10; APP_VERSION 20 in core/version.js)
 tables (projection + revision stores):
  users: ++id, &username, role, disabled
  userRevs: [id+v], id, v, username, role, disabled, crtAt, revAt
  people: [id+v], id, v, [name+mob], uId
  peopleProj: id, name, mob, [name+mob], lastBillAt, pending, hid, headId, [hid+lastBillAt], [hid+pending], [hid+name]  # headId null = own head; also billsCount, advance
  payments: ++id, headId, at # append-only; amount<0 = refund/correction
  delReqs: ++id, billId, status, at # v10; requestBillDelete/listDeleteRequests/pendingDeleteCount/resolveDeleteRequest
  allocations: ++id, paymentId, billId, [billId+ak] # payment slice applied to a bill
  peopleRevs: [id+v], id, v, name, mob, age, gender, weight, discount_per, hid, crtAt, revAt, uId, uV
  bills: [id+v], id, v, pId, uId
  billsProj: id, pId, crtAt, hid, [pId+crtAt], [hid+crtAt], [hid+payment]
  billsRevs: [id+v], id, v, labId, labV, docId, docV, pId, pV, datetime, items, disc_amt, cust_total, merch_total, cust_payable, grand_total, payment, hid, crtAt, revAt, uId, uV
  tests: ++id, name, hid
  testRevs: [id+v], id, v, name, sell, buy, hid, crtAt, revAt, uId, uV  # plus unindexed code, sample, info, tat (strings, '' when unset); also on tests rows; CSV tests schema (no 3) appends code|sample|info|tat; trailing nullable cols may be absent in old rows; backup.js appends testHeadLine() once to an older log (last #head wins)
  labs: ++id, name, hid
  labRevs: [id+v], id, v, name, hid, crtAt, revAt, uId, uV
  doctors: ++id, name, hid
  doctorRevs: [id+v], id, v, name, hid, crtAt, revAt, uId, uV
  meta: key
  delReqs: ++id, billId, status, at # bill delete requests (0 pending, 1 approved, 2 rejected); workflow data, not a revision; cleared on restore; plain user asks (requestBillDelete), admin resolves (resolveDeleteRequest -> deleteBill)
  ledger: ++id, pId, [pId+at], at, billId, kind, payId # fully derived; kind is an int enum; surrogate key (same-ms events collided on unique [pId+at])

 CSV Log Schema (backup/csv.js):
  Delimiter '|'; timestamps epoch-SECONDS (DB keeps ms). Quote-aware line split (newlines in notes survive).
  Array cols inline: 'items:arr[itemId:int+itemV:int+hid:int]' -> cell form 'itemId+itemV+hid,...' (empty = []).
  schemaNo 6 = payments, 7 = allocations; people schema gains trailing headId:int?.
  Unknown schemaNo -> row skipped (forward-compatible). Renaming/reordering cols is BREAKING; only APPEND.

ENV
 No build step. Vanilla JS served statically.
 PWA requires HTTPS or localhost for Service Worker and File System Access API.
 Version sentinel: version.txt (must be bumped on deploy to trigger SW update).

INVARIANTS
 FACTS (truth): bills revs, people revs, payments, allocations. DERIVED: ledger rows, peopleProj.pending, peopleProj.advance (per-head aggregate, checked by verify; db.totalAdvance sums it). Startup verify = verifyRecent (recent persons) + #drift-banner with manual Rebuild; full verify() is on-demand. Only db.derive.js writes ledger.
 Every money write runs in _moneyTx; refund = negative payment; allocation.ak = receipt|advance-apply.
 A bill with allocations cannot be saved as settled (cash/UPI): _assertSettlement.
 verify() must report zero drift after any operation or restore (row identity + totals).
 Writes append a revision AND put the projection row, in the SAME tx.
 Revision rows are never mutated; projection rows are mutated freely.
 _addBillImpl is the ONLY bill write path; live and restore use it. addBill rejects a duplicate id.
 hid is soft-delete; projections filter hidden rows out.
 Names are stored UPPERCASE in place (no name_upper column).
 rebuildProj() recovers projections from revisions. Idempotent.
 crtAt / revAt are epoch-milliseconds in the DB; seconds in the CSV log.
 `users` table is NEVER cleared during restore to preserve password hashes.
 Paid state is derived from allocations, not from billsProj.payment: a pay-later bill stays payment=0 but shows Settled/Partial via billOutstanding.

DEPENDENCIES
 Dexie 4.0.11 (via unpkg.com)
 Google Fonts (via fonts.googleapis.com)

BUILD
 No bundler. scripts/gen-shell-assets.sh generates SHELL_ASSETS list in sw.js via .githooks/pre-commit.

TESTING
 src/dev/selftest.js — comprehensive self-test suite triggered from UI (?dev=1 -> Test). Stages: csv codec, tests/labs/doctors CRUD, UI coverage (mounts all 8 pages, toggles all 14 dialogs, exercises ledger scope/mode/book/pager + family actions), bill form save/edit, bill view, print escaping, paging, seed scale, restore roundtrip, family head + part payments, random-fact property test, and FLOWS. Flows drive the REAL UI: click the real button → waitForDialog(open) → fill → submit → waitForDialog(close), then assert DB + verify(). Scenarios: pay-later bill via form → bill-view Payment… part-pay → settle; Ledger Add advance → new pay-later bill auto-pays from advance (ADVANCE_APPLY); Ledger Pay due → family FIFO + excess→advance; Ledger Refund advance; delete part-paid bill returns allocation; empty-bill validation; F Bills page (day pager, History, Print, Edit, Delete confirm); G Patients page (search, pending toggle, sort, open, timeline, Ledger button); H Settings (cancel vs save, defaults preselected on new bill); I Ledger members (Add member picker, Remove confirm); J Users (validation, create, disable/enable; skipped without admin session). K money edges (PartPaidError guard, overpay single bill, payment dialog Cash/UPI/Unpaid, refund above advance rejected, delete paid bill); L bill form (two tests, discount %, row-click remove, manual discount, name autocomplete, Print, New); M catalogs (search, History, Delete confirm, default toggle); N ledger (row click, bill row -> pay dialog, period input, no NaN). Helpers guard/confirmDanger/rowsOf. Helpers waitUntil/waitForDialog/waitForDialog; cleanup closes stray dialogs. Uses isolated DB + log and setPrintEnabled(false) to suppress blocking window.print().
 src/dev/seed.js — seed data generator for dev/testing.
