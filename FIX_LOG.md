# Fix-pack 2026-10-19 — fix log

Built from the battle plan of 18-10-2026 against the live `main` branch. Every file was patched from its current version (not retyped), syntax-checked, and tested where possible. Apps Script version: **2026-10-19.1**.

## Deploy order (do it in this order)

Every step keeps working with the steps not yet done, so you can pause between steps.

**0. Backups (2 min).** Drive → make a copy of the Orders, Customers and QC spreadsheets.

**1. Apps Script.**
1. Replace the whole main file with `apps-script.gs`.
2. Add a second file: Files "+" → Script → name it `oneoffs`, paste `apps-script-oneoffs.gs`.
3. Deploy: Manage deployments → Edit → New version (same URL). Check `?action=version` shows `2026-10-19.1`, and `?action=health` shows `"ok": true`.
4. From the function dropdown, run in order: `runAllTests` (expect 26 passed, 0 failed) → `installTriggers` (approve the permissions prompt) → `oneoffSetIdColumnsText` → `oneoffCheckDuplicateOrderIds` → `oneoffAuditBackfillFuzzyLinks` → `oneoffBackfillOrderDates`. Read the log after each.
5. If the audit found wrongly linked orders, set `APPLY_UNLINK = true` and run it again. When the Order Date dry run looks right, set `APPLY_ORDER_DATES = true` and run it again.
6. Delete the `oneoffs` file.

**2. Frontend (GitHub).** Upload all frontend files in **one commit** (Add file → Upload files, drop them all): `common.js`, `qc.js`, `uploader.js`, `app.js`, `ajustes.js`, `ajustes.html`, `analytics.js`, `home.js`, `calidad.js`, `import.js`, `qc.html`, `vercel.json`, plus `CONVENTIONS.md`, `FIX_LOG.md` and the `vps-reference/` folder. Then hard-refresh each phone once. Saved logins move to session tokens silently — nobody has to type their password.

**3. VPS.** In the browser terminal:
```
cd /path/to/tiktok-import
curl -s "https://raw.githubusercontent.com/bvzij/velpapier-orders-sandbox/refs/heads/main/vps-reference/vps_patch_2026-10-19.py" -o vps_patch_2026-10-19.py
python3 vps_patch_2026-10-19.py
docker compose build tiktok-import && docker compose up -d --force-recreate tiktok-import
echo "END OF MESSAGE"
```
Expect `RESULT: ALL OK`. A `FAILED` line means the live file differs from the reference copy — nothing was written for that file; paste the output back to Claude. Then delete the patch script on the VPS and re-paste `service.py` / `tiktok_lib.py` into `vps-reference/` (without the base64 blocks).

**4. n8n (manual — see "n8n changes" below).** TikTok webhook token check, Shopify payment status.

**5. After one week of normal use.** In `apps-script.gs`: `ALLOW_PASSWORD_AS_TOKEN = false` and `SERVICE_ALLOWLIST_ENFORCE = true` (first check the audit log for `service_action_outside_allowlist` entries). In `import.js`: `N8N_SEND_LEGACY_TOKEN = false` once n8n checks the session.

**6. Airtable QC import (when ready).** See section "Running the Airtable import".

## Files in this pack

| File | How to apply |
| --- | --- |
| `apps-script.gs` | Replace the whole Apps Script main file |
| `apps-script-oneoffs.gs` | Second Apps Script file; run, then delete |
| `common.js`, `qc.js`, `uploader.js`, `app.js`, `ajustes.js`, `analytics.js`, `home.js`, `calidad.js`, `import.js` | Replace in GitHub |
| `ajustes.html`, `qc.html`, `vercel.json` | Replace in GitHub |
| `vps-reference/vps_patch_2026-10-19.py` | Run once on the VPS |
| `vps-reference/service.py`, `tiktok_lib.py` | Reference copies, already patched — commit to GitHub, never copy to the VPS |
| `vps-reference/airtable_qc_import.py` | Airtable import job |
| `vps-reference/tests/test_helpers.py`, `README.md` | Repo |
| `CONVENTIONS.md`, `FIX_LOG.md` | Repo root |

## Status of every battle-plan item

Done = implemented and checked. Partial = part done, rest explained. Deferred = not in this pack, reason given. Manual = needs a change outside the repo.

### Phase 0 — Stop the bleeding

| # | Status | What changed | Where |
| --- | --- | --- | --- |
| 0.1 | Done | Backfill accepts only exact/alias customer matches; fuzzy hits stay unlinked, are counted and listed in the preview. One-off audits the orders created on 18-10 | `createMissingOrdersFromBackfill`, `ajustes.js`, `oneoffAuditBackfillFuzzyLinks` |
| 0.2 | Done | `parseTikTokDateTime` + `detectDayFirst` (batch-level day/month detection, Mexico City time). Earliest time compared as dates. One-off repairs existing rows | utilities section, `groupBackfillShipments`, `oneoffBackfillOrderDates` |
| 0.3 | Done | QC ID columns text-formatted before every QC write; whole columns via one-off | `saveQC`, `QC_ID_COLUMNS`, `oneoffSetIdColumnsText` |
| 0.4 | Done | `qc.js` wrappers go through `VP.get` / `VP.post` (throw on errors, `already_shipped` passed through); every failed save shows a toast | `qc.js` |
| 0.5 | Done | One `MAN-` id per capture session (`manualTrackingId`), set when the order opens | `qc.js` |
| 0.6 | Done | `getQCSheet` throws instead of falling back to the first tab | `apps-script.gs` |

### Phase 1 — Security

| # | Status | What changed | Where |
| --- | --- | --- | --- |
| 1.1 | Partial | Frontend sends the session token in `X-VP-Session` (legacy `0924` still sent until n8n is updated); VPS forwards `X-Requested-By`; backend logs `requested_by`. n8n part is manual | `import.js`, VPS patch, `importTikTokOrders` |
| 1.2 | Done | `login` action issues `sess_…` tokens (30 days, stored as `SESS_…` properties). Passwords hashed (salted SHA-256) automatically on first login. Login brake: 20 failures / 10 min. Logout and per-person revoke. Saved password logins migrate silently | `getIdentity`, `loginAction`, `common.js` |
| 1.3 | Done (log-only) | `SERVICE_ALLOW` lists per machine token; violations logged, blocked once `SERVICE_ALLOWLIST_ENFORCE = true` | `serviceActionAllowed` |
| 1.4 | Manual | Shopify HMAC check belongs in n8n — snippet below | n8n |
| 1.5 | Done | Staff tokens get Orders without `Price`; `app.js` shows "—" and hides the price field in the edit form for staff; backend drops any `Price` a staff token sends | `doGet orders`, `updateOrder`, `app.js` |
| 1.6 | Done | Upload signatures only for folders in `UPLOAD_FOLDERS` | `getUploadSignature` |

### Phase 2 — Data integrity

| # | Status | What changed | Where |
| --- | --- | --- | --- |
| 2.1 | Done | New `Order Date` column (created automatically). TikTok: from the VPS's `created_time`. Shopify: from `created_at`. Backfill: parsed TikTok time. Analytics, home and the 30-day server filter use it, falling back to `Created Date` | backend imports, `analytics.js`, `home.js`, VPS patch |
| 2.2 | Done (needs n8n field) | `shopifyStatusFromFinancial`; repeat webhooks move status forward only; refunds/voids flagged in Notes; refunded orders never imported. Without `financial_status`, behaves exactly as before | `importShopifyOrder` |
| 2.3 | Done | `_parse_mxn` keeps the sign (10 tests) | VPS patch |
| 2.4 | Done | `reconcileCustomerAggregates` (counts + First Order Date), nightly at 03:00 and an Ajustes button; `recalculateShipmentCountsFor` batched | `apps-script.gs`, `ajustes.js` |
| 2.5 | Done | Reported by the Data Health check `packed_without_qc` | `runHealthChecks` |
| 2.6 | Done | Orders with more than 30 items get a Notes warning (TikTok, Shopify, backfill) | importers |
| 2.7 | Done | PDF page failures and "47 de 50 etiquetas" reported as import warnings | VPS patch |
| 2.8 | Done | Rows without a tracking ID counted in warnings; duplicate `PER_ITEM_FIELDS` block removed; `stampCustomerIDs` writes one column | VPS patch, `stampCustomerIDs` |

### Phase 3 — Rebuild and Airtable import

| # | Status | What changed |
| --- | --- | --- |
| 3.1 | Done | One-offs for duplicates, text formats, fuzzy links, dates |
| 3.2 | Guidance | Still recommended: no wholesale Orders wipe |
| 3.3 | Manual | QC wipe: delete data rows (keep headers) in QC; Sessions tab can now be deleted; then run `oneoffSetIdColumnsText` |
| 3.4 | Done | `airtable_qc_import.py` (dry-run default, resumable, Cloudinary fetches photos straight from Airtable) + backend `orders_index` and `import_qc_history` (skips existing QC rows, own QC ID counter, fills blank Packed Date, `Surtidor` column created automatically) |
| 3.5 | Done | Post-checks are the Data Health report |

### Phase 4 — Shared frontend foundation

| # | Status | What changed |
| --- | --- | --- |
| 4.1 | Done | `VP.fmtDate` / `fmtTime` / `fmtDateTime` / `fmtRel` / `mxHour`: Mexico City, 24-hour, 18/10/2026. Money shows −$120 for refunds. Private copies in `app.js`, `calidad.js`, `home.js` now delegate |
| 4.2 | Done | `VP.esc` escapes `'` too and renders 0 correctly; the three local helpers delegate to it |
| 4.3 | Partial | `qc.js` and `uploader.js` use `VP.get` / `VP.post`. `app.js` keeps its own wrappers (they already check errors); merging them is a larger refactor — deferred |
| 4.4 | Partial | New Ajustes modals close with Escape. Replacing the three `showToast` copies and all ad-hoc modals: deferred (no behavior bug, pure consolidation) |
| 4.5 | Done | Backend error codes shown as plain Spanish (`VP.errText`); expired session clears itself; Shopify duplicate message translated |
| 4.6 | Deferred | Moving inline styles to `style.css` — cosmetic, best done page by page later |
| 4.7 | Done | `vercel.json` sends `no-cache` for JS/CSS/HTML |
| 4.8 | Done | Catch-all rewrite removed |

### Phase 5 — Packing station

| # | Status | What changed |
| --- | --- | --- |
| 5.1 | Done (corrected) | Enviar waits up to 15 s for background photo saves; a late "blocked" reply no longer flips the screen into edit mode; asks to confirm if there is no box photo |
| 5.2 | Done | `uploader.js` rewritten: null-blob guard, `<img>` fallback, bitmap freed, 30 s timeout, 3 attempts, 1280 px / 82% |
| 5.3 | Partial | Upload retries + server ignores a photo URL already saved. Offline IndexedDB queue: deferred (needs on-device testing) |
| 5.4 | Deferred | Scan-to-pack — new feature, needs camera testing on the packing phones |
| 5.5 | Done | Packing buttons 52–56 px tall, focus ring, screen stays awake while packing |

### Phase 6 — Backend structure

| # | Status | What changed |
| --- | --- | --- |
| 6.1 | Deferred | Splitting `apps-script.gs` — deliberately not combined with this many logic changes |
| 6.2 | Done | Sessions feature (5 actions, 6 functions) and `updatePackedDate` removed |
| 6.3 | Done | Product-merge history with Deshacer in Ajustes |
| 6.4 | Deferred | Single action table — after 6.1 |
| 6.5 | Done | `runAllTests()` (26 tests) + `vps-reference/tests/test_helpers.py` (14 checks) |
| 6.6 | Done | Public `health` probe; nightly backup now includes QC and the audit log; `installTriggers()` |
| 6.7 | Partial | `CONVENTIONS.md` added. `SCHEMA.md` deferred — `REQUIRED_HEADERS` in the health check covers the critical columns |

### Phase 7 — Tools

| # | Status | What changed |
| --- | --- | --- |
| 7.1 | Done | Data Health: 10 checks (missing headers, duplicate order IDs, duplicate tracking IDs, IDs stored as numbers, shipped orders missing from Orders, stale shipment counts, packed without QC, shipped without box photo, orders on merged customers, paid >48 h and not packed). Nightly at 04:00 + "Revisar ahora" in Ajustes |
| 7.2 | Done | Users card: list, change staff password (revokes their sessions), close sessions |
| 7.3 | Done (in Health) | Stuck paid orders are a health check; a home-page card is deferred |
| 7.4–7.10 | Deferred | Search, order drawer, giveaway, denylist UI, Shopify reconciliation, cleanup queue, stock |

### Phase 8 — Analytics

The page now buckets by the real order date. Pre-aggregation, heatmap, creators, delivery times, cohorts and settlement remain on the roadmap.

## Found while building (not in the plan)

1. **The Análisis page was broken in production.** `analytics.js` declared `gotCache` twice (a duplicated block that also referenced the retired `rSessions`). That is a syntax error, so the page could not load at all. Duplicate removed.
2. **`getRolesAction` read properties that no longer exist** (`API_TOKEN_ADMIN` / `API_TOKEN_STAFF`). Rewritten to list the real `USER_` people.
3. **Hiding prices would have caused data loss.** `app.js` turned a missing price into 0 and the edit form saved it. Fixed in three layers before it could happen.
4. **The nightly backup skipped the QC sheet and the audit log.** Both added.
5. **`generateQCID` repeats numbers inside a batch.** The Airtable import uses its own counter.
6. **The 30-day server filter used import time.** Now uses Order Date.

## Corrections to the battle plan

- **5.1 was overstated.** Uploads already disabled Enviar, and finalize sends the full photo list, so no photo was being lost. The real issues were the manual-order duplicate-row race (0.5) and a spurious edit-mode toggle — both fixed.
- **5.5:** the packing page's own buttons were already 44–50 px; the "32 px" figure applied to the generic `.btn`.

## Decisions I made — please check

1. **Staff can't see prices** (`HIDE_PRICES_FROM_STAFF = true`). Set to `false` to undo.
2. **Machine-token limits are log-only** for now (`SERVICE_ALLOWLIST_ENFORCE = false`).
3. **Old saved passwords keep working** until you set `ALLOW_PASSWORD_AS_TOKEN = false`.
4. **Passwords get hashed on first login.** You can no longer read them in Script Properties; you can always type a new plain password there and it works (and gets hashed on next login).
5. **Login brake** is global (20 failures in 10 minutes), because Apps Script can't see IP addresses.
6. **Shopify refunded / voided / expired:** never written as a status. New ones are skipped; existing ones get "⚠ Shopify: refunded (fecha)" in Notes. No new "Cancelado" status was added. Missing `financial_status` → "Pagado", as before.
7. **Fuzzy backfill matches** stay unlinked with no stub customer.
8. **`Created Date` now always means import time;** `Order Date` holds the real platform time. The charts read the real time.
9. **Shipping without a box photo** asks for confirmation; it is not blocked.
10. **Photo compression** 1280 px / 82% (the documented standard; the code had 1600 / 80%).
11. **Airtable import:** archived = packed before 01/08/2026 00:00 Mexico City; Surtidor gets a new column; unknown staff names (Ana, Charli, others) become BOB — for both Packer and Surtidor; QC order IDs come from the matched Orders row; Packed Date filled only where blank; dry run unless `--live`; records whose photos fail to copy are skipped and retried on the next run.
12. **Health results** are stored in a new `Health` tab in the Orders spreadsheet (created automatically).
13. **Removed** `updatePackedDate` and the Sessions feature. The `Session ID` column on QC stays (blank).
14. **`vercel.json` catch-all rewrite removed;** Vercel serves `index.html` at `/` on its own.
15. **`import.js` still sends `0924`** until you flip `N8N_SEND_LEGACY_TOKEN` — otherwise TikTok imports would stop before n8n is updated.

## n8n changes (manual)

**TikTok import webhook (`/webhook/tiktok-import`)**
1. After the Webhook node, add an HTTP Request node: GET `<Apps Script URL>?action=whoami&token={{ $json.headers["x-vp-session"] }}`.
2. Add an IF node: continue when that response has a `role`. During step 1 of the switch, also accept the old check (`x-vp-token` equals `0924`) as an OR condition.
3. In the node that calls the VPS `/process`, add the header `X-Requested-By: {{ <whoami node>.json.name }}`.
4. When this works, flip `N8N_SEND_LEGACY_TOKEN = false` in `import.js`, remove the OR condition, and change the webhook path (the old URL is public in git history).

**Shopify order webhook**
1. In the node that builds the `import_shopify_order` body, add `financial_status: {{ $json.body.financial_status }}` and `created_at: {{ $json.body.created_at }}`.
2. In Shopify (Settings → Notifications → Webhooks), add `Order payment` (orders/paid) and `Order update` (orders/updated) pointing at the same n8n URL.
3. Optional HMAC check: enable "Raw body" on the Webhook node, then a Code node: `const crypto = require('crypto'); const sig = crypto.createHmac('sha256', $env.SHOPIFY_WEBHOOK_SECRET).update($binary.data ? Buffer.from($binary.data.data, 'base64') : '').digest('base64'); if (sig !== $json.headers['x-shopify-hmac-sha256']) throw new Error('bad signature'); return $input.all();` (exact access to the raw body depends on the n8n version — test with one real order).

## Running the Airtable import

Runs on the VPS or on your PC (Python 3.9+, no installs). Photos travel from Airtable straight to Cloudinary, so your own internet speed doesn't matter.

1. Export the Airtable CSV **the same day** (photo links expire).
2. Set environment variables. On Windows PowerShell:
   `$env:VP_API_URL="<the /exec URL in common.js>"; $env:API_TOKEN="<API_TOKEN_SERVICE from Script Properties>"; $env:CLOUDINARY_CLOUD="..."; $env:CLOUDINARY_API_KEY="..."; $env:CLOUDINARY_API_SECRET="..."`
   (Never paste these values into a chat.)
3. Dry run: `python airtable_qc_import.py --csv airtable.csv` — prints resolved / archived / unresolved counts and writes `airtable_unresolved.csv`.
4. Real run: add `--live`. If it stops, run the same command again; finished records are skipped.

## Verification done

- `apps-script.gs` + `apps-script-oneoffs.gs`: syntax OK together; no duplicate functions or constants; `runAllTests` 26/26 under Node with Apps Script mocks (dates, hashing, Shopify mapping, price-per-order grouping).
- All 9 frontend JS files: syntax OK (the original `analytics.js` failed). Shared formatters tested at runtime.
- VPS patch: all 15 edits matched the reference copies; second run reports "already applied"; Python compiles; 14/14 helper tests.
- Airtable script: 9/9 checks on your real sample rows (two-photo cell, combined order IDs, Mexico City time, archive cutoff, Ana/Charli → BOB, unresolved reasons).
- Not tested here: anything needing the live Google Sheets, n8n, Cloudinary or a phone camera.
