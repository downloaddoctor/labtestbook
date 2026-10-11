// Generic modal component. Every dialog shares the same shell (header with
// title/sub/close, scrolling body, footer buttons, Esc + backdrop dismiss,
// focus restore). A modal only supplies what differs: title, body, footer.
//
// defineModal(name, config) registers a modal once (shell is built right away).
// openModal(name, data)     opens it from ANY page with the same data shape and
//                           resolves with the value passed to ctx.close(value)
//                           (null when dismissed). No tab or page owns a modal.
//
// config = {
//   id?: string,           element id of the <dialog> (keeps legacy hooks working)
//   closeId?: string,      id of the X button
//   title: string | (data) => string,
//   sub?: string | (data) => string,
//   wide?: boolean,
//   enterSubmits?: boolean, Enter in an input/select clicks the primary footer button
//   header?: (data, ctx) => Node[],   extra header controls (e.g. a History button)
//   body: (data, ctx) => Node | string | void | Promise,
//   footer?: Array<{ label, id?, kind?: 'primary'|'danger', onClick(ctx, e), hidden?(data) }>
//          | (data, ctx) => same array,
//   onOpen?(ctx), onClose?(ctx), onKey?(e, ctx),
// }
// ctx = { el, data, body, $(sel), close(value), setTitle(t), setSub(s), render(), s }

const registry = new Map();
const built = new Map();

export function defineModal(name, config) {
  registry.set(name, config);
  if (typeof document !== 'undefined' && document.body) shell(name);
}

function str(v, data) {
  return typeof v === 'function' ? v(data) : v == null ? '' : v;
}

function shell(name) {
  let rec = built.get(name);
  if (rec) return rec;
  const cfg = registry.get(name) || {};
  const dlg = document.createElement('dialog');
  dlg.id = cfg.id || 'modal-' + name;
  dlg.className = 'modal-dialog';
  dlg.innerHTML =
    '<div class="modal-card">' +
    '<header class="modal-head"><div>' +
    '<h2 class="m-title"' + (cfg.titleId ? ' id="' + cfg.titleId + '"' : '') + '></h2>' +
    '<p class="hint m-sub"' + (cfg.subId ? ' id="' + cfg.subId + '"' : '') + '></p>' +
    '</div>' +
    '<span class="m-head-extra"></span>' +
    '<button type="button" class="modal-close" aria-label="Close"' +
    (cfg.closeId ? ' id="' + cfg.closeId + '"' : '') +
    '>\u00d7</button></header>' +
    '<div class="modal-scroll"><div class="modal-body m-body"></div></div>' +
    '<footer class="modal-actions m-foot"></footer></div>';
  document.body.appendChild(dlg);
  rec = { dlg, ctx: null, resolve: null, result: null };
  built.set(name, rec);
  dlg.addEventListener('click', (e) => {
    if (e.target === dlg) dlg.close();
  });
  dlg.querySelector('.modal-close').addEventListener('click', () => dlg.close());
  dlg.addEventListener('keydown', (e) => {
    const c = registry.get(name);
    if (!rec.ctx || !c) return;
    if (e.key === 'Enter' && c.enterSubmits && e.target.matches('input, select')) {
      e.preventDefault();
      const p = dlg.querySelector('.m-foot .primary');
      if (p) p.click();
      return;
    }
    if (c.onKey) c.onKey(e, rec.ctx);
  });
  dlg.addEventListener('close', () => {
    const c = registry.get(name);
    const ctx = rec.ctx;
    const res = rec.resolve;
    const val = rec.result;
    rec.ctx = null;
    rec.resolve = null;
    rec.result = null;
    if (c && c.onClose && ctx) c.onClose(ctx);
    if (res) res(val);
  });
  return rec;
}

export function openModal(name, data) {
  const cfg = registry.get(name);
  if (!cfg) return Promise.reject(new Error('Unknown modal: ' + name));
  const rec = shell(name);
  const dlg = rec.dlg;
  if (dlg.open) dlg.close();
  const q = (s) => dlg.querySelector(s);
  const ctx = {
    el: dlg,
    data,
    body: q('.m-body'),
    s: {},
    $: q,
    close(value) {
      rec.result = value === undefined ? null : value;
      dlg.close();
    },
    setTitle(t) {
      q('.m-title').textContent = t;
    },
    setSub(s) {
      q('.m-sub').textContent = s;
    },
    async render() {
      ctx.setTitle(str(cfg.title, data));
      ctx.setSub(str(cfg.sub, data));
      const extra = q('.m-head-extra');
      extra.replaceChildren(...(cfg.header ? cfg.header(data, ctx) || [] : []));
      const b = await cfg.body(data, ctx);
      if (b instanceof Node) ctx.body.replaceChildren(b);
      else if (typeof b === 'string') ctx.body.innerHTML = b;
      const foot = q('.m-foot');
      foot.replaceChildren();
      const items = typeof cfg.footer === 'function' ? cfg.footer(data, ctx) : cfg.footer || [];
      for (const f of items) {
        if (f.hidden && f.hidden(data)) continue;
        const btn = document.createElement('button');
        btn.type = 'button';
        // f.html takes precedence — lets a footer button carry a <kbd> hint
        // (e.g. "Ledger <kbd>Alt+L</kbd>") like header buttons do.
        if (f.html) btn.innerHTML = f.html;
        else btn.textContent = f.label;
        if (f.id) btn.id = f.id;
        if (f.kind === 'primary') btn.className = 'primary';
        else if (f.kind === 'danger') btn.className = 'btn-danger';
        btn.addEventListener('click', (e) => f.onClick(ctx, e));
        foot.appendChild(btn);
      }
    },
  };
  dlg.classList.toggle('modal-wide', !!cfg.wide);
  rec.ctx = ctx;
  return new Promise((resolve) => {
    rec.resolve = resolve;
    rec.result = null;
    // Option A: open the shell immediately so callers and tests observe
    // dlg.open right away; the body/footer fill in a tick later while
    // `is-rendering` is set. `is-rendering` is cleared in finally() so a
    // throwing body doesn't leave the dialog permanently "busy".
    dlg.classList.add('is-rendering');
    if (!dlg.open) dlg.showModal();
    ctx.render()
      .then(() => {
        if (cfg.onOpen) cfg.onOpen(ctx);
      })
      .finally(() => {
        dlg.classList.remove('is-rendering');
      });
  });
}

export function isModalOpen(name) {
  const rec = built.get(name);
  return !!rec && rec.dlg.open;
}
