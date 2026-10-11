# Lab Test Book

[MIT licensed](LICENSE).

An offline-first **lab billing app for a small diagnostic lab**. Create bills
with a test catalog, print dual-copy (merchant + customer) receipts, track
patients and payment status, and keep an append-only revision logbook backed up
to a folder you choose.

No build step, no framework, no server — plain ES modules running entirely in
the browser. Works offline and installs as a PWA.

## Features

- **New Bill** — pick a lab + referring doctor, add tests from the catalog,
  apply a % or ₹ discount, add GST, choose payment (cash/UPI/unpaid), print.
- **History** — paged bill list with day/month/range filters and search; drill
  into any bill to reprint, edit, change payment, delete, or view its full
  revision history.
- **Patients** — unique patient registry derived from bills; drill-in visit
  timeline.
- **Catalogs** — tests (customer + merchant price), labs, doctors. Names stored
  uppercase.
- **Users** — admin-managed accounts; PBKDF2 passwords; login lockout.
- **Backup** — append-only revision logbook written to a folder you pick (File
  System Access API), with daily snapshots and archived full backups.
- **Offline PWA** — service worker precaches the app shell; `version.txt` is the
  deploy sentinel.

## Data model

Revisioned, append-only entities + a projection per entity.

- **bills** / **people** — append-only revisions keyed `[rootId+v]` (the truth).
- **billsProj** / **peopleProj** — one row per `rootId`: current state + read
  indexes. Rebuildable from revisions via `db.rebuildProj()`.
- **users** / **userRevs** — auth (secrets only in `users`).
- `rootId == bill_no` (immutable; edits never renumber).
- Every write appends a revision AND puts the projection in one transaction.
- `_addBillImpl` (via `db.addBill` / `db.addBillPreserve`) is the only bill
  write path; live saves and restore both use it.

## Log format

Delimiter `|`. A `#details` line, then a `#head` block declaring each schema's
columns, then one row per appended revision (positional, `<schemaNo>|…`).
Timestamps are epoch-seconds at the file boundary. Restore replays through
`db.replayLog`.

## Keyboard shortcuts

| Keys        | Action      |
| ----------- | ----------- |
| `Ctrl+1..7` | Switch tabs |
| `Ctrl+S`    | Save bill   |
| `Ctrl+P`    | Print       |
| `Ctrl+N`    | New bill    |
| `Alt+B`     | Backup      |
| `Alt+L`     | Log dialog  |

## Run locally

```sh
# any static server, then open with ?dev=1 for the dev cluster
npx http-server -c-1
```

## Development notes

- **No build step.** Files are served as-is.
- **Enable the git hook once** (module check + SW asset regen + sentinel bump):

  ```sh
  git config core.hooksPath .githooks
  ```

- **`version.txt`** is the deploy sentinel and must change on every deploy.
- **`src/dev/`** (seed, self-test) is dev-only and never precached.

## License

[MIT](LICENSE) © Lab Test Book contributors.
