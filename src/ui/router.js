// Router: tab activation, hash sync, keyboard shortcuts.
// Owns nav-tab clicks, hashchange, keydown. Calls pages[name].mount/unmount.

export const ROUTES = ['bill', 'bills', 'patients', 'ledger', 'tests', 'labs', 'doctors', 'users'];

// Routes a plain 'user' may open: New Bill and Bills only.
export const USER_ROUTES = new Set(['bill', 'bills']);
// Everything else is admin-only. Non-admins are bounced to 'bill'.
export const ADMIN_ONLY = new Set(ROUTES.filter((r) => !USER_ROUTES.has(r)));

// Primary input focused on Ctrl+1..6. Missing -> no focus change.
const FOCUS_ON_ACTIVATE = {
  bill: 'bill-cust-name',
  bills: 'bills-search',
  patients: 'patients-search',
  tests: 'test-search',
  labs: 'lab-search',
  doctors: 'doctor-search',
  ledger: null,
  users: null,
};

// Module holder so pages can switch tabs without threading a reference.
let _router = null;
export function setRouter(r) {
  _router = r;
}
export function getRouter() {
  return _router;
}

const PAGE_ID = {
  tests: 'page-tests',
  labs: 'page-labs',
  doctors: 'page-doctors',
  bill: 'page-bill',
  bills: 'page-bills',
  ledger: 'page-ledger',
  patients: 'page-patients',
  users: 'page-users',
};

function pageEl(name) {
  return document.getElementById(PAGE_ID[name] || 'page-' + name);
}

function setActiveNav(name) {
  document.querySelectorAll('.tabs .nav-tab').forEach((btn) => {
    const on = btn.dataset.route === name;
    btn.classList.toggle('active', on);
    if (on) btn.setAttribute('aria-current', 'page');
    else btn.removeAttribute('aria-current');
  });
}

export function routeFromHash() {
  const h = (location.hash || '').replace(/^#\/?/, '');
  return ROUTES.includes(h) ? h : 'bill';
}

export function createRouter({ pages, canAccess } = {}) {
  let currentTab = null;
  const allowed = typeof canAccess === 'function' ? canAccess : () => true;

  function activateTab(name, force = false, syncHash = true) {
    if (!ROUTES.includes(name)) name = 'bill';
    // Admin-only route requested by a non-admin -> bounce to bill.
    if (ADMIN_ONLY.has(name) && !allowed(name)) {
      name = 'bill';
      syncHash = true;
    }
    if (currentTab === name && !force) return;

    if (currentTab && pages[currentTab] && pages[currentTab].unmount) pages[currentTab].unmount();
    for (const r of ROUTES) {
      const n = pageEl(r);
      if (n) n.hidden = r !== name;
    }
    currentTab = name;
    setActiveNav(name);
    if (syncHash) location.hash = '#/' + name;
    if (pages[name] && pages[name].mount) pages[name].mount();
    // Focus is owned by each page's mount() (bill -> Customer Name, bills ->
    // Bill No, tests/labs/doctors/patients -> their search box). Do NOT move
    // focus here: an async mount() focuses a moment later, so focusing the
    // region now would cause a visible two-step focus flicker.
  }

  function wire() {
    document.querySelectorAll('.tabs .nav-tab').forEach((btn) => {
      btn.addEventListener('click', () => activateTab(btn.dataset.route));
    });

    window.addEventListener('hashchange', () => activateTab(routeFromHash(), false, false));

    window.addEventListener('keydown', (e) => {
      // Ctrl/Cmd + 1..4  OR  Alt + 1..4  -> switch tab (and focus primary input).
      const isCtrl = (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey;
      const isAlt = e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey;
      if (!isCtrl && !isAlt) return;
      const n = Number(e.key);
      if (!Number.isInteger(n) || n < 1 || n > ROUTES.length) return;
      e.preventDefault();
      const name = ROUTES[n - 1];
      if (ADMIN_ONLY.has(name) && !allowed(name)) return;
      if (name !== currentTab) activateTab(name);
      const id = FOCUS_ON_ACTIVATE[name];
      const target = id && document.getElementById(id);
      if (target) target.focus();
    });
  }

  return {
    activateTab,
    wire,
    get currentTab() {
      return currentTab;
    },
  };
}
