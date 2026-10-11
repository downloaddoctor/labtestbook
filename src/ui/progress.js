// Generic progress for long operations (seed, restore, backup, tests).
//
// Owns two concerns so callers don't duplicate them:
//   1. Statusbar display — live progress goes to the status bar only (never a
//      toast; start() fires one toast so the operator notices the op began).
//   2. Event-loop yielding — step() returns a promise that resolves only when
//      the browser has had a chance to paint. It yields on a ~100ms budget:
//      cheap DOM writes every call, but at most ~10 paints/sec. Yielding every
//      call would add ~4ms/call of setTimeout clamping for no benefit; never
//      yielding collapses every update into a single final frame.
//
// Usage:
//   const prog = mkProgress('Seeding');
//   prog.start();
//   for (const x of xs) { ...; await prog.step(i, xs.length); }
//   prog.done();

import { el } from './dom.js';
import { toast } from './toast.js';

const YIELD_MS = 100;

function fmtCount(processed, total) {
  const pct = total > 0 ? ((processed / total) * 100).toFixed(1) : '0.0';
  return `${processed}/${total} (${pct}%)`;
}

export function mkProgress(label, { yieldMs = YIELD_MS } = {}) {
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
      opEl.textContent = label.toLowerCase() + ': ' + text;
    }
  };

  let lastYield = performance.now();

  return {
    start(text) {
      lastYield = performance.now();
      setOp(text || '…');
      toast(`${label}…`, 'warn');
    },
    update(text) {
      setOp(text);
    },
    // Report `${processed}/${total} (${pct}%)`.
    //
    // With yieldMs > 0: returns a promise that resolves after the browser has
    // had a chance to paint (yields on the budget). Await the result; safe to
    // call every iteration.
    //
    // With yieldMs = 0: renders synchronously and returns null. This is the
    // mode for work running INSIDE a Dexie/IndexedDB transaction (e.g.
    // db.replayLog) — awaiting a microtask there would drain the tx queue and
    // auto-commit the transaction early. In this mode do NOT await step().
    step(processed, total) {
      setOp(fmtCount(processed, total));
      if (!yieldMs) return null;
      const now = performance.now();
      if (now - lastYield >= yieldMs) {
        lastYield = now;
        return new Promise((r) => setTimeout(r, 0));
      }
      return null;
    },
    done() {
      setOp(null);
    },
  };
}

