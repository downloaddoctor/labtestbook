// Bulk test import modal: paste text or load a CSV file.
//   openModal('testBulk') -> 'saved' | null
// Two input shapes (comma, tab or | separated, quotes + multi-line cells OK):
//   1. With a header row containing 'Test Name' and a '...Price' column
//      (e.g. Test Code,Test Name,Sample Instruction,...,Corp-JPR Price).
//      That price is the MERCHANT price; customer price stays 0 until set.
//   2. Plain lines: name, merchant price, price (optional).
// Blank customer price -> 0, so it can be filled in later from the Tests page.

import db from '../../core/db.js';
import { toast } from '../toast.js';
import { normName } from '../../core/norm.js';
import { defineModal } from './modal.js';

const num = (s) => {
  if (s === undefined || s === null || String(s).trim() === '') return null;
  return Number(String(s).replace(/[\u20b9,\s]/g, ''));
};

function detectSep(text) {
  const first = (text.split(/\r?\n/).find((l) => l.trim()) || '');
  if (first.includes('\t')) return '\t';
  if (first.includes('|') && !first.includes(',')) return '|';
  return ',';
}

// Quote-aware CSV tokenizer. Returns array of cell arrays; blank rows dropped.
function csvRows(text, sep) {
  const rows = [];
  let row = [];
  let cell = '';
  let q = false;
  const push = () => {
    row.push(cell.trim());
    cell = '';
  };
  const endRow = () => {
    push();
    if (row.some((c) => c !== '')) rows.push(row);
    row = [];
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else q = false;
      } else cell += ch;
    } else if (ch === '"' && cell.trim() === '') {
      q = true;
      cell = '';
    } else if (ch === sep) push();
    else if (ch === '\n') endRow();
    else if (ch !== '\r') cell += ch;
  }
  endRow();
  return rows;
}

export function parseTests(text) {
  const src = String(text || '');
  const out = { rows: [], bad: [] };
  if (!src.trim()) return out;
  const table = csvRows(src, detectSep(src));
  if (!table.length) return out;

  const head = table[0].map((c) => c.toLowerCase());
  const nameIdx = head.findIndex((c) => /^(test\s*)?name$/.test(c));
  const priceIdx = head.findIndex((c) => /price/.test(c));
  const sampleIdx = head.findIndex((c) => /sample/.test(c));
  const codeIdx = head.findIndex((c) => /code/.test(c));
  const infoIdx = head.findIndex((c) => /description|clinical|information/.test(c));
  const tatIdx = head.findIndex((c) => /reporting|turn/.test(c));
  const hasHeader = nameIdx >= 0 && priceIdx >= 0;

  const seen = new Map();
  table.forEach((r, i) => {
    if (i === 0 && hasHeader) return;
    let name;
    let buy;
    let sell = 0;
    let sample = '';
    let code = '';
    let info = '';
    let tat = '';
    if (hasHeader) {
      const short = r.length < head.length; // malformed row: code+name merged
      name = normName(short ? r[0] : r[nameIdx]);
      buy = num(short ? r[r.length - 1] : r[priceIdx]);
      sample = short ? r[1] || '' : r[sampleIdx] || '';
      if (buy === null) buy = 0;
      if (!short) {
        code = codeIdx >= 0 ? r[codeIdx] || '' : '';
        info = infoIdx >= 0 ? r[infoIdx] || '' : '';
        tat = tatIdx >= 0 ? r[tatIdx] || '' : '';
      } else tat = r[r.length - 2] || '';
    } else {
      name = normName(r[0]);
      buy = num(r[1]);
      const s = num(r[2]);
      if (i === 0 && buy === null && /^(name|test)/i.test(r[0])) return;
      if (s !== null) {
        if (Number.isNaN(s) || s < 0) buy = NaN;
        else sell = s;
      }
    }
    if (!name || buy === null || Number.isNaN(buy) || buy < 0) {
      out.bad.push(i + 1);
      return;
    }
    // Same name, different price in one file (e.g. Serum vs CSF): tell apart by sample.
    if (hasHeader && seen.has(name) && seen.get(name) !== buy && sample) {
      name = normName(name + ' (' + sample + ')');
    }
    if (!seen.has(name)) seen.set(name, buy);
    out.rows.push({ name, buy, sell, code, sample, info, tat });
  });
  return out;
}

defineModal('testBulk', {
  id: 'test-bulk-modal',
  closeId: 'modal-bulk-close',
  title: 'Bulk add tests',
  sub: 'Paste a CSV with a header (Test Name + Price column) or lines: name, merchant price, price (optional).',
  wide: true,
  body: () =>
    '<label class="modal-field">CSV file <input type="file" id="modal-bulk-file" accept=".csv,.txt,text/csv,text/plain" /></label>' +
    '<label class="modal-field">Tests <textarea id="modal-bulk-text" rows="12" style="width:100%;font-family:monospace" ' +
    'placeholder="CBC, 120, 300&#10;LIPID PROFILE, 250&#10;TSH, 90"></textarea></label>' +
    '<p id="modal-bulk-info" class="hint"></p>',
  footer: [
    { label: 'Cancel', id: 'modal-bulk-cancel-btn', onClick: (ctx) => ctx.close(null) },
    {
      label: 'Import',
      id: 'modal-bulk-save-btn',
      kind: 'primary',
      async onClick(ctx) {
        const { rows, bad } = parseTests(ctx.$('#modal-bulk-text').value);
        if (!rows.length) {
          ctx.$('#modal-bulk-info').textContent = 'Nothing to import.';
          return;
        }
        const have = new Set((await db.listTests()).map((t) => t.name));
        let added = 0;
        let dup = 0;
        for (const r of rows) {
          if (have.has(r.name)) {
            dup++;
            continue;
          }
          await db.addTest(r);
          have.add(r.name);
          added++;
        }
        const extra = (dup ? ', ' + dup + ' duplicate skipped' : '') + (bad.length ? ', ' + bad.length + ' invalid skipped' : '');
        toast(added + ' test' + (added === 1 ? '' : 's') + ' added' + extra + '.', 'ok');
        ctx.close('saved');
      },
    },
  ],
  onOpen(ctx) {
    const ta = ctx.$('#modal-bulk-text');
    const info = ctx.$('#modal-bulk-info');
    const update = () => {
      const { rows, bad } = parseTests(ta.value);
      const noPrice = rows.filter((r) => !r.sell).length;
      info.textContent = ta.value.trim()
        ? rows.length + ' ready' + (noPrice ? ' (' + noPrice + ' without customer price)' : '') + (bad.length ? ' · invalid rows: ' + bad.slice(0, 10).join(', ') : '')
        : '';
    };
    ta.addEventListener('input', update);
    ctx.$('#modal-bulk-file').addEventListener('change', async (e) => {
      const f = e.target.files && e.target.files[0];
      if (!f) return;
      const txt = await f.text();
      ta.value = ta.value.trim() ? ta.value.trim() + '\n' + txt : txt;
      update();
    });
    ta.focus();
  },
});
