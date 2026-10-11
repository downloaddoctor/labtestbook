// HTML print pipeline. printHtml(html) renders into a hidden #print-root,
// calls window.print(), and cleans up after.
// One entry point for both formats (bill receipt now, report template later).
//
// Screen: #print-root is hidden (see styles.css). Print: only #print-root shows.

let _inflight = false;
// Test hook: when false, printHtml resolves without calling window.print().
// The self-test flips this off so the blocking print dialog can't stall it.
let _printEnabled = true;

export function setPrintEnabled(on) {
  _printEnabled = on !== false;
}

function ensureRoot() {
  let root = document.getElementById('print-root');
  if (!root) {
    root = document.createElement('div');
    root.id = 'print-root';
    root.setAttribute('aria-hidden', 'true');
    document.body.appendChild(root);
  }
  return root;
}

function cleanup(root) {
  if (root) root.replaceChildren();
  _inflight = false;
}

// html: full HTML string (already escaped by the template).
// Returns a Promise that resolves after the print dialog closes.
export function printHtml(html) {
  if (_inflight) return Promise.resolve();
  _inflight = true;

  const root = ensureRoot();
  root.innerHTML = html;

  if (!_printEnabled) {
    cleanup(root);
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      window.removeEventListener('afterprint', finish);
      cleanup(root);
      resolve();
    };
    window.addEventListener('afterprint', finish);

    // 2x rAF so layout settles before the dialog opens (matches old ps behavior).
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        try {
          window.print();
        } catch (err) {
          console.error('[print] window.print() failed:', err);
          finish();
        }
      })
    );
  });
}
