// Append-only revision log via File System Access API.
//
// Model: every committed write APPENDS one revision line to
// labtestbook-latest.csv. On the first write of a date the file is snapshotted
// to daily/labtestbook-YYYY-MM-DD.csv (keep 30). Prior full backups are archived
// when the user reselects the folder (keep 30).
//
// Restore reads the log and replays through db.replayLog — the same write path
// that produced it. Log is append-only; one self-describing row per revision;
// delimiter '|'; timestamps epoch-seconds.

import db from '../core/db.js';
import {
  csvHeaderLine,
  testHeadLine,
  detailsLine,
  billRevToLogLine,
  personRevToLogLine,
  userRevToLogLine,
  testRevToLogLine,
  labRevToLogLine,
  doctorRevToLogLine,
  paymentToLogLine,
  allocationToLogLine,
  csvToLog,
  readDetails,
} from './csv.js';
import meta from './meta.js';
import { timeAgo } from '../core/time.js';

const DEFAULT_LATEST = 'labtestbook-latest.csv';
const DAILY_DIR = 'daily';
const ARCHIVE_DIR = 'archive';
const KEEP_DAILY = 30;
const KEEP_ARCHIVES = 30;
const ERROR_LOG = 'error.log';
const FLUSH_DEBOUNCE_MS = 1500;
const HANDLE_KEY = 'dirHandle';

function formatEntry(entry) {
  if (!entry) return '';
  if (entry.kind === 'person') return personRevToLogLine(entry);
  if (entry.kind === 'user') return userRevToLogLine(entry);
  if (entry.kind === 'tests') return testRevToLogLine(entry);
  if (entry.kind === 'labs') return labRevToLogLine(entry);
  if (entry.kind === 'doctors') return doctorRevToLogLine(entry);
  if (entry.kind === 'payment') return paymentToLogLine(entry);
  if (entry.kind === 'allocation') return allocationToLogLine(entry);
  return billRevToLogLine(entry);
}

class Backup {
  constructor() {
    this._dir = null;
    this._pending = [];
    this._dirty = false;
    this._writing = false;
    this._timer = null;
    this._flushPromise = null;
    this._needsHeader = false;
    this._lastAt = '';
    this._lastError = '';
    this._lastErrorName = '';
    this.LATEST = DEFAULT_LATEST;
    // Keep the statusbar label fresh ("3m ago" must tick up over time) and
    // refresh on tab-focus. updateStatus is a no-op before DOM is ready.
    if (typeof window !== 'undefined') {
      window.setInterval(() => this.updateStatus(), 30_000);
      document.addEventListener('visibilitychange', () => {
        if (!document.hidden) this.updateStatus();
      });
    }
  }

  get isSupported() {
    return typeof window !== 'undefined' && 'showDirectoryPicker' in window;
  }

  state() {
    return {
      hasFolder: !!this._dir,
      folderName: this._dir ? this._dir.name : '',
      dirty: this._dirty,
      pending: this._pending.length,
      lastAt: this._lastAt,
      lastError: this._lastError,
      lastErrorName: this._lastErrorName,
      writing: this._writing,
    };
  }

  async init() {
    if (!this.isSupported) return;
    const saved = await meta.get(HANDLE_KEY);
    if (!saved) return;
    try {
      const perm = await saved.queryPermission({ mode: 'readwrite' });
      if (perm === 'granted') {
        this._dir = saved;
        this._needsHeader = !(await this.fileExists(this._dir, this.LATEST));
      } else {
        await meta.del(HANDLE_KEY);
      }
    } catch {
      await meta.del(HANDLE_KEY);
    }
    // Reflect the restored state on the statusbar immediately on boot.
    this.updateStatus();
  }

  async fileExists(dir, name) {
    try {
      await dir.getFileHandle(name);
      return true;
    } catch {
      return false;
    }
  }

  async pickOrBackup() {
    if (!this.isSupported) throw new Error('File System Access API not supported.');
    const dir = await window.showDirectoryPicker({ mode: 'readwrite' });
    await this.setFolder(dir);
    await this.writeFullBackup();
    return dir;
  }

  async setFolder(dir) {
    this._dir = dir;
    await meta.set(HANDLE_KEY, dir);
    this._needsHeader = !(await this.fileExists(dir, this.LATEST));
  }

  async clearFolder() {
    this._dir = null;
    await meta.del(HANDLE_KEY);
  }

  // ---- journal hook ----
  _markDirty = () => {
    this._dirty = true;
    if (!this._dir) return;
    if (this._timer) clearTimeout(this._timer);
    this._timer = setTimeout(() => {
      this._timer = null;
      this.flush().catch(() => { });
    }, FLUSH_DEBOUNCE_MS);
  };

  // Called by db.setJournal(). `entry` = the full revision row + `kind`.
  markDirty(entry) {
    this._pending.push(entry);
    this._markDirty();
  }

  async readLatest(dir) {
    try {
      const fh = await dir.getFileHandle(this.LATEST);
      const f = await fh.getFile();
      return await f.text();
    } catch {
      return null;
    }
  }

  async appendText(dir, name, text) {
    const fh = await dir.getFileHandle(name, { create: true });
    const file = await fh.getFile();
    const w = await fh.createWritable({ keepExistingData: true });
    await w.seek(file.size);
    await w.write(text);
    await w.close();
  }

  async writeText(dir, name, text) {
    const fh = await dir.getFileHandle(name, { create: true });
    const w = await fh.createWritable();
    await w.write(text);
    await w.close();
  }

  async _headerPayload() {
    let counts = { bills: 0, people: 0, tests: 0, labs: 0, doctors: 0, payments: 0, allocations: 0, users: 0 };
    try {
      counts = {
        bills: await db.raw.bills.count(),
        people: await db.raw.people.count(),
        tests: await db.raw.tests.count(),
        labs: await db.raw.labs.count(),
        doctors: await db.raw.doctors.count(),
        payments: await db.raw.payments.count(),
        allocations: await db.raw.allocations.count(),
        users: await db.raw.users.count(),
      };
    } catch (_) { }
    return (
      detailsLine('v' + db.APP_VERSION, new Date().toISOString(), counts) + '\n' +
      csvHeaderLine() + '\n'
    );
  }

  // Append queued revision lines to latest.csv.
  async flush() {
    if (this._flushPromise) return this._flushPromise;
    if (!this._dir) return null;
    if (!this._pending.length) {
      this._dirty = false;
      this._lastAt = new Date().toISOString();
      this._lastError = '';
      this._lastErrorName = '';
      return null;
    }
    this._flushPromise = (async () => {
      this._writing = true;
      this.updateStatus();
      try {
        let perm;
        try {
          perm = await this._dir.queryPermission({ mode: 'readwrite' });
        } catch (e) {
          if (e.name === 'NotFoundError' || e.name === 'NotAllowedError') {
            throw new Error('Backup folder was moved or deleted. Please select a new folder.');
          }
          throw e;
        }
        if (perm !== 'granted') {
          const req = await this._dir.requestPermission({ mode: 'readwrite' });
          if (req !== 'granted') throw new Error('Permission denied.');
        }
        const batch = this._pending.slice();
        this._pending = [];

        let payload = '';
        if (this._needsHeader) payload += await this._headerPayload();
        else if (!this._headUpgraded) {
          try {
            const cur = (await this.readLatest(this._dir)) || '';
            const m = cur.match(/^#head\|tests\|3\|.*$/m);
            if (m && !m[0].includes('tat:str?')) payload += testHeadLine() + '\n';
            this._headUpgraded = true;
          } catch (_) { }
        }
        for (const entry of batch) {
          const line = formatEntry(entry);
          if (line) payload += line + '\n';
        }
        if (!payload) {
          this._dirty = false;
          this._lastAt = new Date().toISOString();
          return;
        }

        let beforeSize = 0;
        try {
          const fh = await this._dir.getFileHandle(this.LATEST);
          beforeSize = (await fh.getFile()).size;
        } catch {
          beforeSize = 0;
        }
        await this.appendText(this._dir, this.LATEST, payload);
        let afterSize = -1;
        try {
          const fh = await this._dir.getFileHandle(this.LATEST);
          afterSize = (await fh.getFile()).size;
        } catch {
          afterSize = -1;
        }
        const expectedLen = beforeSize + new Blob([payload]).size;
        if (afterSize !== expectedLen) {
          this._lastError = 'append verification failed';
          return;
        }
        this._needsHeader = false;
        await this.snapshotDaily();
        this._dirty = false;
        this._lastAt = new Date().toISOString();
        this._lastError = '';
        this._lastErrorName = '';
      } catch (e) {
        // Re-queue the batch so a transient FS error does not silently drop
        // revision lines from the live log. Header state is left as-is.
        this._pending = batch.concat(this._pending);
        this._lastError = e && e.message ? e.message : String(e);
        this._lastErrorName = e && e.name ? e.name : '';
      } finally {
        this._writing = false;
        this._flushPromise = null;
        this.updateStatus();
      }
    })();
    return this._flushPromise;
  }

  async backupNow() {
    this._dirty = true;
    return this.flush();
  }

  async readLatestText() {
    if (!this._dir) return null;
    return this.readLatest(this._dir);
  }

  setLogFileName(name) {
    this.LATEST = name || DEFAULT_LATEST;
    this._needsHeader = false;
  }

  async deleteLog() {
    if (!this._dir) return false;
    try {
      await this._dir.removeEntry(this.LATEST);
      this._needsHeader = true;
      return true;
    } catch {
      return false;
    }
  }

  // Unflushed journal entries as raw log lines (no header). Read-only.
  pendingLines() {
    return this._pending.map(formatEntry).filter(Boolean);
  }

  async readLog() {
    if (!this._dir) return { text: null, source: 'no-folder' };
    try {
      const text = await this.readLatest(this._dir);
      if (text != null) return { text, source: this.LATEST };
      return { text: null, source: 'empty' };
    } catch (e) {
      return { text: null, source: 'error', error: e && e.message ? e.message : String(e) };
    }
  }

  // ---- full export ----
  async writeFullBackup() {
    if (!this._dir) throw new Error('No backup folder set.');
    await this.archiveLatest();
    const data = await db.exportAll();
    await this.writeText(this._dir, this.LATEST, data.text);
    this._needsHeader = false;
    this._pending = [];
    this._dirty = false;
    this._lastAt = new Date().toISOString();
    this._lastError = '';
    this.updateStatus();
    await this.snapshotDaily();
  }

  // Pre-update safety snapshot: flush pending revisions, then write the FULL
  // revision log into archive/labtestbook-<ts>.csv (pruned). Does NOT touch
  // latest.csv or the pending journal beyond flushing them in.
  async archiveFull() {
    if (!this._dir) throw new Error('No backup folder set.');
    await this.flush();
    const data = await db.exportAll();
    const adir = await this._dir.getDirectoryHandle(ARCHIVE_DIR, { create: true });
    const ts = new Date().toISOString().replace(/[:T]/g, '-').replace(/\..+$/, '');
    const name = `labtestbook-${ts}.csv`;
    await this.writeText(adir, name, data.text);
    await this.pruneArchives(adir);
    return name;
  }

  // Pre-update safety snapshot when NO folder is set: download the full
  // revision log as a CSV file the user can restore from later.
  async downloadFullCsv() {
    const data = await db.exportAll();
    const ts = new Date().toISOString().replace(/[:T]/g, '-').replace(/\..+$/, '');
    const filename = `labtestbook-backup-${ts}.csv`;
    const blob = new Blob([data.text], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    return filename;
  }

  async archiveLatest() {
    try {
      const existing = await this._dir.getFileHandle(this.LATEST);
      if (!existing) return null;
      const adir = await this._dir.getDirectoryHandle(ARCHIVE_DIR, { create: true });
      const ts = new Date().toISOString().replace(/[:T]/g, '-').replace(/\..+$/, '');
      const name = `labtestbook-${ts}.csv`;
      const src = await existing.getFile();
      await this.writeText(adir, name, await src.text());
      await this._dir.removeEntry(this.LATEST);
      await this.pruneArchives(adir);
      return name;
    } catch {
      return null;
    }
  }

  async pruneArchives(adir) {
    const entries = [];
    for await (const [name, handle] of adir.entries()) {
      if (handle.kind !== 'file' || !/^labtestbook-.*\.csv$/.test(name)) continue;
      let mtime = 0;
      try { mtime = (await handle.getFile()).lastModified || 0; } catch (_) { }
      entries.push({ name, mtime });
    }
    if (entries.length <= KEEP_ARCHIVES) return;
    entries.sort((a, b) => a.mtime - b.mtime);
    for (const e of entries.slice(0, entries.length - KEEP_ARCHIVES)) {
      try { await adir.removeEntry(e.name); } catch (_) { }
    }
  }

  async snapshotDaily() {
    if (!this._dir) return;
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const day = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    const name = `labtestbook-${day}.csv`;
    const ddir = await this._dir.getDirectoryHandle(DAILY_DIR, { create: true });
    let exists = true;
    try {
      await ddir.getFileHandle(name);
    } catch {
      exists = false;
    }
    if (exists) return;
    const full = await this.readLatest(this._dir);
    if (full != null) await this.writeText(ddir, name, full);
    await this.pruneDaily(ddir);
  }

  async pruneDaily(ddir) {
    const entries = [];
    for await (const [name, handle] of ddir.entries()) {
      if (handle.kind !== 'file' || !/^labtestbook-\d{4}-\d{2}-\d{2}\.csv$/.test(name)) continue;
      let mtime = 0;
      try { mtime = (await handle.getFile()).lastModified || 0; } catch (_) { }
      entries.push({ name, mtime });
    }
    if (entries.length <= KEEP_DAILY) return;
    entries.sort((a, b) => a.mtime - b.mtime);
    for (const e of entries.slice(0, entries.length - KEEP_DAILY)) {
      try { await ddir.removeEntry(e.name); } catch (_) { }
    }
  }

  // ---- restore ----
  async restoreFromFolder({ onProgress = null } = {}) {
    if (!this._dir) throw new Error('No backup folder set.');
    const perm = await this._dir.queryPermission({ mode: 'readwrite' });
    if (perm !== 'granted') {
      const req = await this._dir.requestPermission({ mode: 'readwrite' });
      if (req !== 'granted') throw new Error('Permission denied.');
    }
    let text = await this.readLatest(this._dir);
    let source = this.LATEST;
    if (!text) {
      text = await this.readNewestDaily(this._dir);
      source = 'daily';
      if (!text) throw new Error('No backup files in that folder.');
    }
    const parsed = csvToLog(text);
    this._pending = [];
    this._dirty = false;
    const r = await db.replayLog(parsed.ops, { onProgress });
    return {
      source,
      count: r.count,
      skipped: r.skipped,
      skippedRows: (parsed.skippedRows || []).concat(r.skippedRows || []),
      danglingRefs: r.danglingRefs || [],
      folderName: this._dir.name || '',
      legacyNoPayments: r.legacyNoPayments || false,
    };
  }

  async restoreFromFileObject(file, { onProgress = null } = {}) {
    const text = await file.text();
    const parsed = csvToLog(text);
    this._pending = [];
    this._dirty = false;
    const r = await db.replayLog(parsed.ops, { onProgress });
    return {
      mode: 'upload',
      filename: file.name,
      count: r.count,
      skipped: r.skipped,
      skippedRows: (parsed.skippedRows || []).concat(r.skippedRows || []),
      danglingRefs: r.danglingRefs || [],
      legacyNoPayments: r.legacyNoPayments || false,
    };
  }

  async readNewestDaily(dir) {
    let newestName = '';
    try {
      const ddir = await dir.getDirectoryHandle(DAILY_DIR);
      for await (const [name, handle] of ddir.entries()) {
        if (handle.kind !== 'file') continue;
        if (!/^labtestbook-\d{4}-\d{2}-\d{2}\.csv$/.test(name)) continue;
        if (name > newestName) newestName = name;
      }
      if (!newestName) return null;
      const fh = await ddir.getFileHandle(newestName);
      return await (await fh.getFile()).text();
    } catch {
      return null;
    }
  }

  // ---- restore-source picker support ----
  async listBackups() {
    const out = { latest: null, daily: [], archive: [] };
    if (!this._dir) return out;
    try {
      const fh = await this._dir.getFileHandle(this.LATEST);
      const f = await fh.getFile();
      out.latest = { name: this.LATEST, dir: this._dir, path: this.LATEST, date: f.lastModified ? new Date(f.lastModified).toISOString() : null, size: f.size, handle: fh };
    } catch (_) { }
    try {
      const ddir = await this._dir.getDirectoryHandle(DAILY_DIR);
      for await (const [name, handle] of ddir.entries()) {
        if (handle.kind !== 'file' || !/^labtestbook-\d{4}-\d{2}-\d{2}\.csv$/.test(name)) continue;
        const f = await handle.getFile();
        out.daily.push({ name, dir: ddir, path: DAILY_DIR + '/' + name, date: f.lastModified ? new Date(f.lastModified).toISOString() : null, size: f.size, handle });
      }
    } catch (_) { }
    out.daily.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    try {
      const adir = await this._dir.getDirectoryHandle(ARCHIVE_DIR);
      for await (const [name, handle] of adir.entries()) {
        if (handle.kind !== 'file' || !/^labtestbook-.*\.csv$/.test(name)) continue;
        const f = await handle.getFile();
        out.archive.push({ name, dir: adir, path: ARCHIVE_DIR + '/' + name, date: f.lastModified ? new Date(f.lastModified).toISOString() : null, size: f.size, handle });
      }
    } catch (_) { }
    out.archive.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    return out;
  }

  async readDetailsOf(entry) {
    if (!entry || !entry.handle) return null;
    try {
      const f = await entry.handle.getFile();
      const head = await f.slice(0, 512).text();
      return readDetails(head);
    } catch (_) {
      return null;
    }
  }

  async restoreFromEntry(entry, { onProgress = null } = {}) {
    if (!entry || !entry.handle) throw new Error('No backup file selected.');
    if (!this._dir) throw new Error('No backup folder set.');
    const perm = await this._dir.queryPermission({ mode: 'readwrite' });
    if (perm !== 'granted') {
      const req = await this._dir.requestPermission({ mode: 'readwrite' });
      if (req !== 'granted') throw new Error('Permission denied.');
    }
    const f = await entry.handle.getFile();
    const text = await f.text();
    const parsed = csvToLog(text);
    this._pending = [];
    this._dirty = false;
    const r = await db.replayLog(parsed.ops, { onProgress });
    return {
      source: entry.path,
      count: r.count,
      skipped: r.skipped,
      skippedRows: (parsed.skippedRows || []).concat(r.skippedRows || []),
      danglingRefs: r.danglingRefs || [],
      legacyNoPayments: r.legacyNoPayments || false,
      folderName: this._dir.name || '',
    };
  }

  // ---- error log ----
  async writeErrorLog(text) {
    if (!this._dir) return false;
    const MAX = 1024 * 1024;
    try {
      const fh = await this._dir.getFileHandle(ERROR_LOG, { create: true });
      const file = await fh.getFile();
      const bytes = new Blob([text]).size;
      if (file.size + bytes > MAX) {
        try { await this._dir.removeEntry(ERROR_LOG + '.1'); } catch (_) { }
        try { await fh.move(this._dir, ERROR_LOG + '.1'); } catch (_) { }
      }
      const fh2 = await this._dir.getFileHandle(ERROR_LOG, { create: true });
      const file2 = await fh2.getFile();
      const w = await fh2.createWritable({ keepExistingData: true });
      await w.seek(file2.size);
      await w.write(text);
      await w.close();
      return true;
    } catch {
      return false;
    }
  }

  downloadErrorLog(text) {
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const stamp =
      `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_` +
      `${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
    const filename = `labtestbook-restore-errors-${stamp}.log`;
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.rel = 'noopener';
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.addEventListener('beforeunload', () => {
      try { URL.revokeObjectURL(url); } catch (_) { }
    }, { once: true });
    return filename;
  }

  reportRestoreErrors({ source, folderName, skippedRows }) {
    if (!skippedRows || !skippedRows.length) return null;
    const lines = [];
    lines.push(`=== Restore ${new Date().toISOString()} · source=${source || '?'}${folderName ? ' · folder=' + folderName : ''} ===`);
    for (const r of skippedRows) {
      lines.push(`line ${r.lineNo != null ? r.lineNo : '?'}: ${r.reason}`);
      if (r.raw) lines.push(`  raw: ${r.raw}`);
    }
    lines.push('');
    const text = lines.join('\n');
    this.writeErrorLog(text).catch(() => { });
    let filename = null;
    try {
      filename = this.downloadErrorLog(text);
    } catch {
      filename = null;
    }
    return { text, filename };
  }

  async downloadCsv() {
    const data = await db.exportAll();
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const stamp =
      `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}` +
      '_' +
      `${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
    const filename = `labtestbook-${stamp}.csv`;
    const blob = new Blob([data.text], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.rel = 'noopener';
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.addEventListener('beforeunload', () => {
      try { URL.revokeObjectURL(url); } catch (_) { }
    }, { once: true });
    return { filename, count: data.count || 0 };
  }

  updateStatus() {
    const el = document.getElementById('backup-status');
    if (!el) return;
    if (!hasFsAccess) {
      el.textContent = 'backup: CSV download only';
      el.className = 'status';
      return;
    }
    if (!this._dir) {
      el.textContent = 'backup: no folder (Alt+B)';
      el.className = 'status';
      return;
    }
    if (this._lastError) {
      el.textContent = 'backup error: ' + this._lastError;
      el.className = 'status err';
      return;
    }
    const hasQueued = this._pending.length > 0 || this._dirty || this._writing;
    const queued = this._pending.length;
    const ago = this._lastAt ? timeAgo(this._lastAt) : 'ready';
    const queuedStr = queued ? queued + ' pending · ' : '';
    el.textContent = 'backup: ' + queuedStr + ago;
    el.title = this._dir.name ? 'Folder: ' + this._dir.name : '';
    // Green only when the last write actually landed and nothing is queued.
    el.className = 'status ' + (hasQueued || !this._lastAt ? '' : 'ok');
  }
}

export default new Backup();
export const hasFsAccess = typeof window !== 'undefined' && 'showDirectoryPicker' in window;
