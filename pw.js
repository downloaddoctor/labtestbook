/* Lab Test Book PWA bootstrap — registers the service worker and wires the
   update-consent UX. Loaded by index.html; no-op when unsupported.

   Update policy: the SW only *detects* a new deploy and posts
   'labtestbook-update-available'. Nothing is applied until the user accepts the
   prompt. A plain reload never picks up the new version by itself. */
(function () {
  'use strict';

  if (!('serviceWorker' in navigator)) return;

  var isDev = /(?:\?|&)dev=1(?:&|$)/.test(location.search)
  var FORCE_UPDATE = /(?:\?|&)forceUpdate=1(?:&|$)/.test(location.search);
  if (isDev) {
    navigator.serviceWorker.getRegistrations().then(function (regs) {
      regs.forEach(function (r) { r.unregister(); });
    }).catch(function () { });
    if (window.caches && caches.keys) {
      caches.keys().then(function (keys) {
        keys.forEach(function (k) { caches.delete(k); });
      }).catch(function () { });
    }
    return;
  }

  // localStorage flag so the status-bar indicator survives reloads.
  var PENDING_KEY = 'ltb.update.pending';

  function readPending() {
    try { return localStorage.getItem(PENDING_KEY) === '1'; } catch (e) { return false; }
  }
  function setPending(on) {
    try {
      if (on) localStorage.setItem(PENDING_KEY, '1');
      else localStorage.removeItem(PENDING_KEY);
    } catch (e) { /* ignore */ }
  }

  function showIndicator() {
    var el = document.getElementById('update-status');
    if (el) {
      el.hidden = false;
      el.textContent = 'update available';
    }
  }
  function hideIndicator() {
    var el = document.getElementById('update-status');
    if (el) el.hidden = true;
  }

  function openDialog() {
    // The update prompt lives in src/ui/modals/update.js. Fire a DOM event so
    // the app can open it; fall back to nothing when the app isn't wired yet.
    window.dispatchEvent(new CustomEvent('ltb:update-prompt'));
  }

  function applyNow() {
    var sw = navigator.serviceWorker.controller;
    var send = function (c) { if (c) c.postMessage({ type: 'labtestbook-apply-update' }); };
    if (sw) {
      send(sw);
    } else {
      navigator.serviceWorker.ready.then(function () {
        send(navigator.serviceWorker.controller);
      });
    }
  }

  window.addEventListener('load', function () {
    navigator.serviceWorker
      .register('./sw.js')
      .then(function () {
        // Restore the indicator if an update was pending from a prior session.
        if (readPending()) showIndicator();
        if (!FORCE_UPDATE) return;
        var sw = navigator.serviceWorker.controller;
        var check = function (c) { if (c) c.postMessage({ type: 'labtestbook-check-update' }); };
        if (sw) check(sw);
        else navigator.serviceWorker.ready.then(function () {
          check(navigator.serviceWorker.controller);
        });
      })
      .catch(function (err) {
        if (window.console && console.warn) {
          console.warn('[labtestbook] SW registration failed:', err);
        }
      });
  });

  navigator.serviceWorker.addEventListener('message', function (event) {
    var d = event.data;
    if (!d || !d.type) return;

    if (d.type === 'labtestbook-update-available') {
      setPending(true);
      showIndicator();
      return;
    }

    if (d.type === 'labtestbook-update-applied') {
      setPending(false);
      hideIndicator();
      window.location.reload();
    }
  });

  // Expose helpers for the app status bar to drive the update prompt.
  window.__ltbUpdate = {
    pending: readPending,
    openDialog: openDialog,
    applyNow: applyNow,
    dismiss: function () { /* keep pending; indicator stays */ },
  };
})();
