# Vel Papier dashboard — conventions

Paste this file into every AI session that will touch this repo.
Repo: `bvzij/velpapier-orders-sandbox`, branch `main` (the live one).

## How changes are delivered

- Vel edits only through the GitHub web UI and the Apps Script editor.
- Small or medium change: exact find/replace text. Large or structural change: a complete file.
- `apps-script.gs`: one or the other per response, never both.
- Before editing any file, fetch the current version:
  `curl -s "https://raw.githubusercontent.com/bvzij/velpapier-orders-sandbox/refs/heads/main/<FILE>" -o "<FILE>"`
- VPS code: Python patch scripts with exact-string `str.replace()`, count check (must match exactly once), backup, OK/FAILED per edit. Never nano. Never replace `tiktok_lib.py` wholesale (its logo images are stripped from the reference copy).
- VPS rebuild: `docker compose build tiktok-import && docker compose up -d --force-recreate tiktok-import`.
- Apps Script deploy: bump `SCRIPT_VERSION` → Manage deployments → Edit → New version (same URL) → check `?action=version`.
- One-off scripts go in a separate Apps Script file, run once from the dropdown, then get deleted.
- Every terminal command ends with `echo "END OF MESSAGE"`.

## Backend rules (apps-script.gs)

- Write by header name: `oh.indexOf('Column Name')`, never a fixed position.
- Sheets by name: `getSheetByName('Orders')`, never `getSheets()[0]`.
- New column needed? `ensureHeader(sheet, 'Name')`, then re-read the header row.
- Before any write touching Order ID, SKU ID or Tracking ID: `forceTextFormat(sheet, headers, cols, startRow, numRows)`. QC ID columns: `QC_ID_COLUMNS`.
- Batch writes: one `setValues` per range; `readColumn` + `writeColumnChanges` for column edits. No `setValue` in loops.
- Platform dates: `parseTikTokDateTime(value, detectDayFirst(allValues))`, store ISO. `Created Date` = when the row entered the dashboard; `Order Date` = real platform order time.
- Customer matching on writes: exact or alias only. `findCustomerByUsername` fuzzy hits are suggestions, never written unattended.
- Merged customers contain `(merged→` in Primary Username and are excluded from all matching.
- Coerce sheet values with `String(v || '')` before string operations.
- Every mutation logs: `logAudit(action, type, id, field, before, after)` or `logAuditEvent(action, type, id, details)`.
- Bulk or destructive operations get a dry-run / preview first.
- Shipment count definition: `buildShippedCountMap()` only. Recompute with `reconcileCustomerAggregates()`.
- Status only moves forward: `STATUS_RANK` (No Pagado → Pagado → Enviado → Archivado).
- Admin-only actions: `requireAdmin(role)` in the dispatcher. Machine tokens: add the action to `SERVICE_ALLOW`.
- Staff never receive or write `Price` (`HIDE_PRICES_FROM_STAFF`).

## Frontend rules

- Every page loads `common.js` first; shared helpers live on `window.VP`.
- API: `VP.get(qs)` / `VP.post(data, {passErrors: [...]})`. They throw on backend errors with Spanish text; the raw code is on `err.code`.
- Escaping: `VP.esc(value)` for every value placed into `innerHTML`.
- Dates and money: `VP.fmtDate` (18/10/2026), `VP.fmtTime` (15:30), `VP.fmtDateTime`, `VP.fmtRel` (hace 3 h), `VP.mxHour()`, `VP.mxn` / `VP.mxnExact` (−$120 for refunds). Always Mexico City time, always 24-hour.
- Messages: `VP.toast(msg, isError)`.
- UI copy in Spanish, informal *tú*, buttons named by what they do.
- Reuse existing classes (`aj-card`, `aj-row`, `refresh-btn`, `status-pill`, `modal`); colors from CSS variables (`--green-text`, `--amber-bg`, …).

## Sheets

Orders, Customers, TikTok Import History, Health (Orders spreadsheet) · QC (QC spreadsheet) · Product Parents, Product Variants, Catalog Suggestions, Product Merge History, Dismissed Product Pairs (catalog spreadsheet) · Merge History, Dismissed Duplicates, Shopify Customer Matches · `Log <year>` (audit spreadsheet). The Data Health check `missing_headers` lists the columns the code relies on (`REQUIRED_HEADERS`).
