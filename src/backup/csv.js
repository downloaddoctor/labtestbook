// CSV codec for the append-only revision log. Pure (no IO).
//
// Format:
//   #head|schema|schemaNo|col:type[|col:type...]     one line per schema
//   <schemaNo>|<value1>|<value2>|...                  one row per appended revision
//
//   * Positional values, matching that schema's #head column order.
//   * Types: str | int | num | epoch | bool | arr[...]; a `?` suffix = nullable.
//   * Array cols declare element keys inline: arr[k:type+k:type+...].
//     Entry delimiter `,`; field delimiter inside an entry `+`.
//   * Delimiter `|`. Timestamps are epoch-SECONDS at the file boundary.
//   * Every entity is append-only revisions keyed [id+v]. The log carries
//     revisions, not the current state — restoring rebuilds the full chain.
//   * Projections (billsProj/peopleProj) are NOT logged; they are rebuilt.
//   * Unknown schemaNo -> row skipped (forward-compatible).
//   * v1: short col keys; unit conversion (ms<->sec) is the only transform.

const CSV_DELIM = '|';
const ARR_ENTRY_DELIM = ',';
const ARR_FIELD_DELIM = '+';

const SCHEMA_USER = {
  no: 0,
  name: 'user',
  cols: ['id:int', 'v:int', 'username:str', 'role:str', 'disabled:int', 'crtAt:epoch', 'revAt:epoch?'],
};

const SCHEMA_PEOPLE = {
  no: 1,
  name: 'people',
  cols: [
    'id:int', 'v:int', 'name:str', 'mob:str', 'age:int?', 'gender:str?', 'weight:num?',
    'discount_per:num?', 'hid:int', 'crtAt:epoch', 'revAt:epoch?', 'uId:int?', 'uV:int?',
    'headId:int?',
  ],
};

const SCHEMA_BILLS = {
  no: 2,
  name: 'bills',
  cols: [
    'id:int', 'v:int', 'labId:int', 'labV:int?', 'docId:int', 'docV:int?',
    'pId:int', 'pV:int?', 'datetime:str',
    'items:arr[itemId:int+itemV:int+hid:int]',
    'disc_amt:num', 'cust_total:num', 'merch_total:num', 'cust_payable:num', 'grand_total:num',
    'payment:int', 'hid:int',
    'crtAt:epoch', 'revAt:epoch?', 'uId:int?', 'uV:int?',
  ],
};

const SCHEMA_TESTS = {
  no: 3,
  name: 'tests',
  cols: [
    'id:int', 'v:int', 'name:str', 'sell:num', 'buy:num',
    'hid:int', 'crtAt:epoch', 'revAt:epoch?', 'uId:int?', 'uV:int?',
    'code:str?', 'sample:str?', 'info:str?', 'tat:str?',
  ],
};

const SCHEMA_LABS = {
  no: 4,
  name: 'labs',
  cols: [
    'id:int', 'v:int', 'name:str', 'hid:int',
    'crtAt:epoch', 'revAt:epoch?', 'uId:int?', 'uV:int?',
  ],
};

const SCHEMA_DOCTORS = {
  no: 5,
  name: 'doctors',
  cols: [
    'id:int', 'v:int', 'name:str', 'hid:int',
    'crtAt:epoch', 'revAt:epoch?', 'uId:int?', 'uV:int?',
  ],
};

// payments: money received by a family head. amount < 0 = correction/refund.
// method: 1 = cash, 2 = UPI.
const SCHEMA_PAYMENTS = {
  no: 6,
  name: 'payments',
  cols: [
    'id:int', 'headId:int', 'amount:num', 'method:int', 'at:epoch',
    'note:str?', 'uId:int?', 'uV:int?',
  ],
};

// allocations: one slice of a payment applied to one bill.
const SCHEMA_ALLOCATIONS = {
  no: 7,
  name: 'allocations',
  cols: ['id:int', 'paymentId:int', 'billId:int', 'amount:num', 'at:epoch', 'ak:int?'],
};

const SCHEMAS = [
  SCHEMA_USER, SCHEMA_PEOPLE, SCHEMA_BILLS,
  SCHEMA_TESTS, SCHEMA_LABS, SCHEMA_DOCTORS,
  SCHEMA_PAYMENTS, SCHEMA_ALLOCATIONS,
];
const KIND_BY_SCHEMA = {
  user: 'user', people: 'person', bills: 'bill',
  tests: 'test', labs: 'lab', doctors: 'doctor',
  payments: 'payment', allocations: 'allocation',
};

// Head line for the tests schema alone. Appended to an existing log whose
// tests head predates code|sample|info|tat; csvToLog lets the last #head win.
export function testHeadLine() {
  return '#head|' + SCHEMA_TESTS.name + '|' + SCHEMA_TESTS.no + '|' + SCHEMA_TESTS.cols.join(CSV_DELIM);
}

export function csvHeaderLine() {
  const lines = ['#head|schema|schemaNo|columns'];
  for (const s of SCHEMAS) lines.push('#head|' + s.name + '|' + s.no + '|' + s.cols.join(CSV_DELIM));
  return lines.join('\n');
}

const DETAIL_KEYS = ['bills', 'people', 'tests', 'labs', 'doctors', 'payments', 'allocations', 'users'];
export function detailsLine(version, dateIso, counts) {
  const c = counts || {};
  const parts = [
    '#details',
    'LabTestBook',
    version || '?',
    dateIso || new Date().toISOString(),
  ];
  for (const k of DETAIL_KEYS) parts.push(k + '=' + (c[k] != null ? c[k] : 0));
  return parts.join(CSV_DELIM);
}

function toEpoch(v) {
  if (v == null || v === '') return '';
  if (typeof v === 'number') return Math.floor(v / 1000);
  const t = Date.parse(v);
  return Number.isFinite(t) ? Math.floor(t / 1000) : '';
}
function fromEpoch(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n * 1000 : null;
}

// Items cell: itemId+itemV+hid,itemId+itemV+hid,... Empty = [].
function encodeItems(items) {
  if (!Array.isArray(items) || items.length === 0) return '';
  const parts = [];
  for (const it of items) {
    const id = it.itemId != null ? Number(it.itemId) : '';
    const v = it.itemV != null ? Number(it.itemV) : '';
    const h = it.hid ? 1 : 0;
    parts.push(id + ARR_FIELD_DELIM + v + ARR_FIELD_DELIM + h);
  }
  return parts.join(ARR_ENTRY_DELIM);
}
function decodeItems(s) {
  if (!s) return [];
  const out = [];
  for (const entry of String(s).split(ARR_ENTRY_DELIM)) {
    if (!entry) continue;
    const f = entry.split(ARR_FIELD_DELIM);
    const itemId = Number(f[0]);
    const itemV = Number(f[1]);
    const hid = Number(f[2]) ? 1 : 0;
    if (!Number.isFinite(itemId) || !Number.isFinite(itemV)) continue;
    out.push({ itemId, itemV, hid });
  }
  return out;
}

function csvEscape(v) {
  const s = v == null ? '' : String(v);
  if (s.includes(CSV_DELIM) || s.includes('"') || s.includes('\n') || s.includes('\r')) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

export function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else q = false;
      } else cur += ch;
    } else if (ch === '"') {
      q = true;
    } else if (ch === CSV_DELIM) {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

function encVal(type, v) {
  if (v == null || v === '') return '';
  if (type === 'epoch') return toEpoch(v);
  return v;
}

// Parse a col spec: 'id:int?' or 'items:arr[itemId:int+itemV:int+hid:int]'.
// Returns { key, type, nullable, arr: [{key,type}] | null }.
function parseColSpec(spec) {
  const nullable = spec.endsWith('?');
  const base = nullable ? spec.slice(0, -1) : spec;
  const colon = base.indexOf(':');
  const key = colon === -1 ? base : base.slice(0, colon);
  let type = colon === -1 ? 'str' : base.slice(colon + 1);
  let arr = null;
  if (type.startsWith('arr[') && type.endsWith(']')) {
    const inner = type.slice(4, -1);
    arr = inner.split(ARR_FIELD_DELIM).map((p) => {
      const c = p.indexOf(':');
      return c === -1
        ? { key: p, type: 'str' }
        : { key: p.slice(0, c), type: p.slice(c + 1) };
    });
    type = 'arr';
  }
  return { key, type, nullable, arr };
}

function rowForLine(schema, row) {
  const values = [];
  for (let i = 0; i < schema.cols.length; i++) {
    const { key, type } = parseColSpec(schema.cols[i]);
    let v = row[key];
    if (key === 'items') v = encodeItems(v);
    if (type === 'int') v = v == null || v === '' ? '' : Number(v);
    if (type === 'num') v = v == null || v === '' ? '' : Number(v);
    if (key === 'hid') v = v ? 1 : 0;
    if (key === 'payment') v = v === 0 || v === 2 ? v : 1;
    values.push(csvEscape(encVal(type, v)));
  }
  return schema.no + CSV_DELIM + values.join(CSV_DELIM);
}

export function userRevToLogLine(u) {
  return rowForLine(SCHEMA_USER, u);
}
export function personRevToLogLine(p) {
  return rowForLine(SCHEMA_PEOPLE, p);
}
export function billRevToLogLine(b) {
  return rowForLine(SCHEMA_BILLS, b);
}
export function testRevToLogLine(t) {
  return rowForLine(SCHEMA_TESTS, t);
}
export function labRevToLogLine(l) {
  return rowForLine(SCHEMA_LABS, l);
}
export function doctorRevToLogLine(d) {
  return rowForLine(SCHEMA_DOCTORS, d);
}
export function paymentToLogLine(p) {
  return rowForLine(SCHEMA_PAYMENTS, p);
}
export function allocationToLogLine(a) {
  return rowForLine(SCHEMA_ALLOCATIONS, a);
}

function decodeVal(type, v) {
  if (v === '' || v == null) return null;
  if (type === 'int') {
    const n = Number(v);
    return Number.isFinite(n) ? Math.trunc(n) : null;
  }
  if (type === 'num') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  if (type === 'epoch') return fromEpoch(v);
  if (type === 'bool') return v === '1' || v === 'true' ? 1 : 0;
  return String(v);
}

export function csvToLog(text) {
  // Split into logical lines while respecting quoted fields (a quoted value may
  // contain newlines). A naive split on \n corrupts rows whose note/name has one.
  const lines = [];
  {
    let cur = '';
    let q = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (ch === '"') q = !q;
      if ((ch === '\n' || ch === '\r') && !q) {
        lines.push(cur);
        cur = '';
        if (ch === '\r' && text[i + 1] === '\n') i++;
      } else {
        cur += ch;
      }
    }
    if (cur !== '') lines.push(cur);
  }
  const heads = [];
  const body = [];
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (raw === '') continue;
    if (raw.startsWith('#head')) {
      heads.push(parseCsvLine(raw));
      continue;
    }
    if (raw.startsWith('#')) continue;
    body.push({ lineNo: i + 1, raw });
  }
  if (!heads.length) throw new Error('Not a LabTestBook revision log (no #head lines).');

  const schemaMap = new Map();
  for (const f of heads) {
    if (f.length < 4) continue;
    const sName = f[1];
    const sNo = Number(f[2]);
    const cols = f.slice(3).map((spec) => parseColSpec(spec));
    schemaMap.set(sNo, { no: sNo, name: sName, cols });
  }
  if (!schemaMap.size) throw new Error('Not a LabTestBook revision log (empty #head block).');

  const ops = [];
  const skippedRows = [];
  for (const { lineNo, raw } of body) {
    const f = parseCsvLine(raw);
    const sNo = Number(f[0]);
    const schema = schemaMap.get(sNo);
    if (!schema) {
      skippedRows.push({ lineNo, reason: 'unknown schemaNo ' + f[0], raw });
      continue;
    }
    let need = schema.cols.length;
    while (need > 0 && schema.cols[need - 1].nullable) need--;
    if (f.length - 1 < need) {
      skippedRows.push({ lineNo, reason: `short row (${f.length - 1} fields, expected ${schema.cols.length})`, raw });
      continue;
    }
    const kind = KIND_BY_SCHEMA[schema.name] || 'bill';
    const row = { kind, schemaNo: sNo, lineNo, raw };
    for (let i = 0; i < schema.cols.length; i++) {
      const { key, type } = schema.cols[i];
      const rawVal = f[i + 1];
      if (key === 'items') row.items = decodeItems(rawVal);
      else row[key] = decodeVal(type, rawVal);
    }
    ops.push(row);
  }
  return { ops, skippedRows };
}

export function readDetails(text) {
  if (!text) return null;
  const lines = text.split(/\r?\n/);
  for (const l of lines) {
    if (!l) continue;
    if (!l.startsWith('#details')) continue;
    const f = parseCsvLine(l);
    const out = { version: f[2] || '', date: f[3] || null, bills: null, people: null };
    for (let i = 4; i < f.length; i++) {
      const [k, v] = String(f[i]).split('=');
      if (k) out[k] = Number(v);
    }
    return out;
  }
  return null;
}
