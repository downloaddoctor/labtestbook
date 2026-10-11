// Shared keyboard row-navigation for list pages.
//
// Two ways to use it:
//   1. Declarative (preferred): put data-list-nav on the <table> and
//      data-list-search on its search input, then call initAll() on mount and
//      destroyAll() on unmount. Actions (Enter/Delete) are named via
//      data-list-enter / data-list-delete and resolved through registerAction().
//   2. Programmatic: createRowNav(cfg) and wire it yourself.
//
// Key model (identical everywhere):
//   - ArrowDown/Up move the highlight; focus stays in the search box so the
//     operator keeps typing. Focus moves onto a row only when the key came from
//     inside the table.
//   - ArrowUp on the first row returns focus to the search box.
//   - Pager handoff: ArrowDown past the last row focuses the pager's Next
//     button (if enabled); ArrowUp on that button reselects the last row.
//   - Home/End jump to first/last; Enter/Space open; Delete removes.
//   - The highlighted row is always scrolled into view (clear of the sticky bar).

import { el, highlightRow, clearHighlight } from '../dom.js';

// ---- action registry (for the declarative path) ----
const ACTIONS = new Map();
export function registerAction(name, fn) {
  ACTIONS.set(name, fn);
}
export function unregisterAction(name) {
  ACTIONS.delete(name);
}

// cfg: { tableId, rowClass, searchId, onEnter(row, index), onDelete(row, index)?,
//        pagerNext?, pagerPrev? }
export function createRowNav(cfg) {
  const { tableId, rowClass, searchId } = cfg;
  const onEnter = cfg.onEnter || (() => { });
  const onDelete = cfg.onDelete || null;
  const onHistory = cfg.onHistory || null;

  let activeRow = -1;

  function rowEls() {
    return Array.from(document.querySelectorAll(`#${tableId} tbody tr.${rowClass}`));
  }
  function searchBox() {
    return searchId ? el(searchId) : null;
  }
  function pagerNext() {
    return cfg.pagerNext ? el(cfg.pagerNext) : null;
  }
  function focusSearch() {
    const s = searchBox();
    if (!s) return;
    s.focus({ preventScroll: true });
    // Keep the search box visible (it may be above the current scroll position).
    s.scrollIntoView({ block: 'nearest' });
  }

  function focusNext() {
    const b = pagerNext();
    if (b && !b.disabled) {
      // Drop the row highlight first so it's clear the button is the target.
      clearActiveRow();
      b.focus();
      return true;
    }
    return false;
  }

  function setActiveRow(i) {
    const rows = rowEls();
    if (!rows.length) {
      activeRow = -1;
      return;
    }
    i = Math.max(0, Math.min(i, rows.length - 1));
    for (let k = 0; k < rows.length; k++) rows[k].classList.toggle('active', k === i);
    activeRow = i;
    rows[i].scrollIntoView({ block: 'nearest' });
  }

  function clearActiveRow() {
    for (const tr of rowEls()) tr.classList.remove('active');
    activeRow = -1;
  }

  function focusRow() {
    const rows = rowEls();
    const tr = rows[activeRow];
    if (!tr) return;
    // A row needs tabindex to accept programmatic focus. Use -1 so it's not in
    // the Tab order, but is focusable.
    if (tr.tabIndex < 0) tr.tabIndex = -1;
    tr.focus({ preventScroll: true });
    tr.scrollIntoView({ block: 'nearest' });
  }

  function onKeydown(e) {
    // A modal owns the keyboard while open: never move the table highlight
    // behind a <dialog>. (showModal() makes the rest of the page inert, but
    // document-level keydown still fires, so guard explicitly.)
    if (document.querySelector('dialog[open]')) return;
    // Let native form controls keep their arrow keys (date/number/select/
    // textarea), except the list's own search box which drives row nav.
    const tt = e.target;
    if (
      tt &&
      tt !== searchBox() &&
      (tt.tagName === 'INPUT' || tt.tagName === 'SELECT' ||
        tt.tagName === 'TEXTAREA' || tt.isContentEditable)
    ) {
      return;
    }
    // Pager handoff: focus on a pager button.
    const nextBtn = pagerNext();
    const prevBtn = cfg.pagerPrev ? el(cfg.pagerPrev) : null;
    const focusOnPager =
      (nextBtn && document.activeElement === nextBtn) ||
      (prevBtn && document.activeElement === prevBtn);
    if (focusOnPager) {
      if (e.key === 'ArrowUp' && nextBtn && document.activeElement === nextBtn) {
        if (rowEls().length) {
          e.preventDefault();
          setActiveRow(rowEls().length - 1);
          focusRow();
        }
        return;
      }
      // On a pager button, ArrowDown should stay put (nothing below it).
      if (e.key === 'ArrowDown' || e.key === 'Home' || e.key === 'End') {
        e.preventDefault();
        return;
      }
    }

    const rows = rowEls();
    if (!rows.length) return;
    const t = e.target;

    // If focus is on a pager button, let the button handle Enter/Space itself
    // (activate Next/Prev) instead of opening the highlighted row.
    const onPager =
      (pagerNext() && document.activeElement === pagerNext()) ||
      (cfg.pagerPrev && document.activeElement === el(cfg.pagerPrev));
    if (onPager && (e.key === 'Enter' || e.key === ' ')) return;

    const fromTable = !!(t && t.closest && t.closest(`#${tableId} tbody`));
    const move = () => {
      if (fromTable) focusRow();
    };

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      // Past the last row -> hand focus to the pager's Next button.
      if (activeRow >= rows.length - 1) {
        if (focusNext()) return;
      }
      setActiveRow(activeRow < 0 ? 0 : activeRow + 1);
      move();
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (activeRow <= 0) {
        clearActiveRow();
        focusSearch();
        return;
      }
      setActiveRow(activeRow - 1);
      move();
      return;
    }
    if (e.key === 'Home') {
      e.preventDefault();
      setActiveRow(0);
      move();
      return;
    }
    if (e.key === 'End') {
      e.preventDefault();
      setActiveRow(rows.length - 1);
      move();
      return;
    }
    if (e.key === 'Enter' || e.key === ' ') {
      // Only act when a row is actually highlighted (activeRow >= 0) AND the key
      // came from the list itself (a row or its search box) — never when focus is
      // elsewhere (e.g. a nav tab), which would otherwise open the first row.
      if (activeRow < 0) return;
      if (!fromTable && t !== searchBox()) return;
      e.preventDefault();
      const row = rows[activeRow];
      if (row) onEnter(row, activeRow);
      return;
    }
    if (onHistory && e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && (e.key === 'h' || e.key === 'H')) {
      const row = rows[activeRow];
      if (!row) return;
      e.preventDefault();
      onHistory(row, activeRow);
      return;
    }
    if (onDelete && (e.key === 'Delete' || e.key === 'Backspace')) {
      const row = rows[activeRow];
      if (!row) return;
      if (t && t.tagName === 'INPUT') return;
      e.preventDefault();
      onDelete(row, activeRow);
    }
  }

  // After a page change, highlight + focus the first row, keeping the search
  // box visible above it (scroll to the table, not the row, so both fit).
  function gotoFirstRow() {
    const rows = rowEls();
    if (!rows.length) return;
    setActiveRow(0);
    const tr = rows[0];
    tr.tabIndex = -1;
    tr.focus({ preventScroll: true });
    // Scroll the search box to the top so it stays visible above the rows.
    const s = searchBox();
    if (s) s.scrollIntoView({ block: 'start' });
    else tr.scrollIntoView({ block: 'nearest' });
  }



  return {
    rowEls,
    setActiveRow,
    clearActiveRow,
    focusRow,
    gotoFirstRow,
    getActive: () => activeRow,

    attach(off) {
      off.on(document, 'keydown', (e) => onKeydown(e));
      // Clear the row highlight when a pager button receives focus (by click,
      // Tab, or arrow handoff) so Enter clearly targets the button.
      const nb = pagerNext();
      if (nb) off.on(nb, 'focus', clearActiveRow);
      const pb = cfg.pagerPrev ? el(cfg.pagerPrev) : null;
      if (pb) off.on(pb, 'focus', clearActiveRow);
    },

  };
}

// ---- declarative path ----

let _instances = [];
let _off = null;

function resolveAction(name) {
  if (!name) return null;
  const fn = ACTIONS.get(name);
  return fn || null;
}

// Scan the document (or `root`) for [data-list-nav] tables and wire each.
// Returns the created rowNav instances. Call destroyAll() on unmount.
export function initAll(root = document) {
  destroyAll();
  _off = collectOff();
  root.querySelectorAll('table[data-list-nav]').forEach((table) => {
    const tableId = table.id;
    if (!tableId) return;
    const rowClass = table.dataset.rowClass || 'row-click';
    const searchId = table.dataset.search || null;
    const enterFn = resolveAction(table.dataset.enter);
    const deleteFn = resolveAction(table.dataset.delete);
    const historyFn = resolveAction(table.dataset.history);
    const nav = createRowNav({
      tableId,
      rowClass,
      searchId,
      pagerNext: table.dataset.pagerNext || null,
      pagerPrev: table.dataset.pagerPrev || null,
      onEnter: enterFn ? (row, i) => enterFn(row, i, nav) : () => { },
      onDelete: deleteFn ? (row, i) => deleteFn(row, i, nav) : null,
      onHistory: historyFn ? (row, i) => historyFn(row, i, nav) : null,
    });
    nav.attach(_off);
    _instances.push(nav);
  });
  return _instances;
}

// Minimal off-collector so initAll is self-contained.
function collectOff() {
  const fns = [];
  return {
    on(target, type, fn, opts) {
      target.addEventListener(type, fn, opts);
      fns.push([target, type, fn, opts]);
    },
    off() {
      for (const [target, type, fn, opts] of fns) target.removeEventListener(type, fn, opts);
      fns.length = 0;
    },
  };
}

export function destroyAll() {
  if (_off) _off.off();
  _off = null;
  _instances = [];
}

// ---- DOM-list navigation (non-table lists, e.g. the revisions timeline) ----
// cfg: {
//   getRows, getBody, activeClass?, search?, pagerPrev?, pagerNext?,
//   isOpen?, canNav?, onEnter?, onEscape?
// }
export function createListNav(cfg) {
  const getRows = cfg.getRows;
  const activeClass = cfg.activeClass || 'active';
  let active = -1;

  const search = () => (cfg.search ? cfg.search() : null);
  const pagerNext = () => (cfg.pagerNext ? cfg.pagerNext() : null);
  const pagerPrev = () => (cfg.pagerPrev ? cfg.pagerPrev() : null);
  const rowEls = () => getRows();

  function syncTabIndex() {
    const rows = rowEls();
    const keep = active >= 0 ? active : 0;
    for (let i = 0; i < rows.length; i++) rows[i].tabIndex = i === keep ? 0 : -1;
  }

  function setActive(i) {
    active = highlightRow(rowEls(), i, activeClass);
    syncTabIndex();
  }

  function clear() {
    clearHighlight(rowEls(), activeClass);
    active = -1;
    syncTabIndex();
  }

  function focusRow() {
    const rows = rowEls();
    const tr = rows[active];
    if (!tr) return;
    if (tr.tabIndex < 0) tr.tabIndex = -1;
    tr.focus({ preventScroll: true });
    tr.scrollIntoView({ block: 'nearest' });
  }

  function focusSearch() {
    const s = search();
    if (!s) return false;
    s.focus({ preventScroll: true });
    s.scrollIntoView({ block: 'nearest' });
    return true;
  }

  function keydown(e) {
    if (cfg.isOpen && !cfg.isOpen()) return;
    // Let native form controls keep their arrow keys, except the search box.
    const tt = e.target;
    if (
      tt &&
      tt !== search() &&
      (tt.tagName === 'INPUT' || tt.tagName === 'SELECT' ||
        tt.tagName === 'TEXTAREA' || tt.isContentEditable)
    ) {
      return;
    }
    const rows = rowEls();
    if (!rows.length) return;
    if (cfg.canNav && !cfg.canNav(e)) return;

    const t = e.target;
    const nextBtn = pagerNext();
    const prevBtn = pagerPrev();
    const onPager =
      (nextBtn && document.activeElement === nextBtn) ||
      (prevBtn && document.activeElement === prevBtn);
    if (onPager) {
      if (e.key === 'ArrowUp' && nextBtn && document.activeElement === nextBtn) {
        e.preventDefault();
        setActive(rows.length - 1);
        focusRow();
        return;
      }
      if (e.key === 'ArrowDown' || e.key === 'Home' || e.key === 'End') {
        e.preventDefault();
        return;
      }
      if (e.key === 'Enter' || e.key === ' ') return;
    }

    const body = cfg.getBody ? cfg.getBody() : null;
    const fromBody = !!(t && body && body.contains(t));
    const move = () => {
      if (fromBody) focusRow();
    };

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (active >= rows.length - 1) {
        const b = nextBtn;
        if (b && !b.disabled) {
          clear();
          b.focus();
        }
        return;
      }
      setActive(active < 0 ? 0 : active + 1);
      move();
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (active <= 0) {
        if (focusSearch()) clear();
        else setActive(0);
        return;
      }
      setActive(active - 1);
      move();
      return;
    }
    if (e.key === 'Home') {
      e.preventDefault();
      setActive(0);
      move();
      return;
    }
    if (e.key === 'End') {
      e.preventDefault();
      setActive(rows.length - 1);
      move();
      return;
    }
    if (e.key === 'Enter' || e.key === ' ') {
      // Only act when a row is highlighted and focus is in the list body/search.
      if (active < 0) return;
      if (!fromBody && t !== search()) return;
      e.preventDefault();
      const row = rows[active];
      if (row && cfg.onEnter) cfg.onEnter(row, active);
      return;
    }
    if (e.key === 'Escape') {
      if (cfg.onEscape) {
        const handled = cfg.onEscape(rows, active);
        if (handled === false) return;
      }
      e.preventDefault();
    }
  }

  return {
    keydown,
    setActive,
    clear,
    refresh: syncTabIndex,
    rowEls,
    getActive: () => active,
    focusRow,
    focusSearch,
  };
}

