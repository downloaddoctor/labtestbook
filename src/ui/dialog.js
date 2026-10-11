// Promise-based alert/confirm/prompt using the native <dialog> element.
// Focus trap + Escape dismiss + focus restore are handled by <dialog> itself.
//
// Re-entrancy: callers may open a new dialog as soon as the previous one
// resolves (e.g. a multi-step wizard). Because <dialog>.close() fires its
// 'close' event ASYNCHRONOUSLY, a naive shared listener would let a stale
// close resolve the NEXT dialog. We therefore bind a FRESH 'close' listener
// per open and remove it as soon as that open resolves.

class DialogImpl {
  constructor() {
    this._el = null;
    this._resolver = null;
    this._cancelValue = undefined;
    this._closeHandler = null;
    this._backdropHandler = null;
  }

  _build() {
    if (this._el) return;
    const dlg = document.createElement('dialog');
    dlg.className = 'modal-dialog';
    dlg.innerHTML = [
      '<form method="dialog" class="modal-card">',
      '  <header class="modal-head">',
      '    <div><h2 class="dialog-title"></h2></div>',
      '  </header>',
      '  <div class="modal-body"><p class="dialog-message"></p></div>',
      '  <footer class="modal-actions dialog-actions"></footer>',
      '</form>',
    ].join('');
    document.body.appendChild(dlg);
    this._el = dlg;
  }

  // Resolve the current open exactly once (idempotent), removing its listeners.
  _resolve(value) {
    if (!this._resolver) return;
    const fn = this._resolver;
    this._resolver = null;
    if (this._closeHandler) {
      this._el.removeEventListener('close', this._closeHandler);
      this._closeHandler = null;
    }
    if (this._backdropHandler) {
      this._el.removeEventListener('click', this._backdropHandler);
      this._backdropHandler = null;
    }
    fn(value);
  }

  _open(opts) {
    this._build();

    // If a dialog is still visually open, close it and resolve the prior open.
    if (this._el.open) {
      this._resolve(this._cancelValue);
      this._el.close();
    }

    return new Promise((resolve) => {
      this._resolver = resolve;

      const kind = opts.kind || 'alert';
      const title = opts.title || (kind === 'confirm' ? 'Confirm' : 'Notice');
      const message = opts.message || '';

      this._el.querySelector('.dialog-title').textContent = title;
      this._el.querySelector('.dialog-message').textContent = message;

      const body = this._el.querySelector('.modal-body');
      body.querySelectorAll('.dialog-input-row').forEach((n) => n.remove());

      const actions = this._el.querySelector('.dialog-actions');
      actions.replaceChildren();

      const okLabel = opts.okLabel || 'OK';
      const okClass = opts.danger ? 'btn-danger' : 'primary';

      const cancel = document.createElement('button');
      cancel.type = 'button';
      cancel.className = 'btn-secondary';
      cancel.textContent = opts.cancelLabel || 'Cancel';

      const ok = document.createElement('button');
      ok.type = 'button';
      ok.className = okClass;
      ok.textContent = okLabel;

      let input = null;
      if (kind === 'prompt') {
        const row = document.createElement('div');
        row.className = 'dialog-input-row';
        input = document.createElement('input');
        input.type = opts.inputType || 'text';
        if (opts.min != null) input.min = String(opts.min);
        if (opts.step != null) input.step = String(opts.step);
        input.value = opts.defaultValue != null ? String(opts.defaultValue) : '';
        row.append(input);
        body.append(row);
        input.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            ok.click();
          }
        });
      }

      // Esc / programmatic close -> resolve as cancel, for THIS open only.
      this._closeHandler = () => this._resolve(this._cancelValue);
      this._el.addEventListener('close', this._closeHandler);

      // Backdrop click -> close (triggers 'close' above).
      this._backdropHandler = (e) => {
        if (e.target === this._el) this._el.close();
      };
      this._el.addEventListener('click', this._backdropHandler);

      cancel.addEventListener('click', () => {
        this._cancelValue = kind === 'prompt' ? null : kind === 'confirm' ? false : undefined;
        this._el.close(); // 'close' handler resolves
      });

      ok.addEventListener('click', () => {
        const val = kind === 'prompt' ? (input ? input.value : '') : undefined;
        // Resolve BEFORE closing so the next open can proceed cleanly.
        this._resolve(kind === 'confirm' ? true : kind === 'prompt' ? val : undefined);
        this._el.close();
      });

      if (kind === 'confirm' || kind === 'prompt') {
        this._cancelValue = kind === 'prompt' ? null : false;
        actions.append(cancel, ok);
      } else {
        this._cancelValue = undefined;
        actions.append(ok);
      }

      this._el.showModal();
      if (input) input.focus();
      else ok.focus();
    });
  }

  alert(message, opts) {
    return this._open(Object.assign({ kind: 'alert', message }, opts));
  }
  confirm(message, opts) {
    return this._open(Object.assign({ kind: 'confirm', message }, opts));
  }
  // Resolves the entered string, or null if cancelled.
  prompt(message, opts) {
    return this._open(Object.assign({ kind: 'prompt', message }, opts));
  }
  isOpen() {
    return !!this._el && this._el.open;
  }
}

const Dialog = new DialogImpl();

export default Dialog;
