# Vel Papier Dashboard — Architecture

**What this document is:** how the system is built *right now* — its parts, how they connect, and why it is shaped this way. It is not a changelog (see `FIX_LOG.md` and the status reports for that).

**Rule:** whenever the structure changes (a new service, a new sheet or table, a new data flow, a changed decision), update this file in the same session. Sections marked *(planned)* describe agreed work that does not exist yet.

**Never put here:** passwords, tokens, keys, or the VPS IP address. This repository is public.

*Last structural update: 28-10-2026 — Postgres migration started.*

---

## 1. The big picture

Vel Papier is a Mexican art-supply shop selling through TikTok Shop, Shopify and wholesale (Mayoreo). The dashboard is the internal tool for orders, packing (QC), customers, products, wholesale and analytics, used by 4–5 people at the same time from different places.

```
                 Browser (dashboard.velpapier.com, hosted on Vercel)
                                   │
                    every read and write goes through ▼
                 Google Apps Script web app  (/exec URL)
                                   │
                 Google Sheets — 6 spreadsheet files = the database

   Side systems:
   n8n (on the VPS) ── TikTok import & Shopify webhooks ──► Apps Script
   VPS services     ── TikTok CSV/PDF processing, photo/file hosting
```

**Current bottleneck (measured 28-10-2026):** every Apps Script call costs 2.4–7.5 s on the server, regardless of how much data it returns. Even a 2 kB response takes ~2.4 s. Reading the full Orders sheet takes ~7 s. This is the main reason for the move to Postgres (section 7).

---

## 2. Frontend

Static HTML/CSS/JavaScript. No build step, no framework. GitHub → Vercel deploys automatically on every commit.

- **Production URL:** `dashboard.velpapier.com` (sandbox: `velpapier-orders-sandbox.vercel.app`)
- **`common.js`** — shared by every page: login/session, the API wrappers `VP.get` / `VP.post`, formatters (`VP.fmtDate`, money), escaping (`VP.esc`), navigation.
- **One JS file per page:**

| Page | Files | Purpose |
| --- | --- | --- |
| Inicio | `index.html`, `home.js` | Landing / overview |
| Pedidos | `pedidos.html`, `app.js` | Order list and editing |
| Empaque (QC) | `qc.html`, `qc.js`, `uploader.js` | Packing station, photo capture |
| Calidad | `calidad.html`, `calidad.js` | QC review |
| Análisis | `analytics.html`, `analytics.js` | Charts and reports |
| Ajustes | `ajustes.html`, `ajustes.js` | Admin: users, data health, merges, backfill |
| Importar | `import.html`, `import.js` | TikTok CSV + PDF import |
| Productos | `productos.js` (+ page) | Product catalog |

Pages for Clientes, Mayoreo and Listings also exist; their file names should be added here when next touched.

---

## 3. Backend today: Google Apps Script

One file, `apps-script.gs` (~10,500 lines), deployed as a web app bound to the Orders spreadsheet. It is the **only** thing allowed to read or write the Sheets.

- `doGet` = read actions (`orders`, `qc`, `customers`, `health`, …)
- `doPost` = write actions (`save_qc`, `import_tiktok_orders`, `import_shopify_order`, `merge_customers`, `login`, …). Every write runs inside `withWriteLock()` (`LockService.getScriptLock()`) so simultaneous writes can't overwrite each other.
- `getIdentity()` resolves who is calling: a person's session token (`sess_…`, roles admin/staff) or a machine token (role `service`, limited to an allowlist of actions).
- Also holds: importers, merges, nightly triggers (customer reconcile 03:00, Data Health 04:00, backups), one-off scripts.

Deploy ritual: bump `SCRIPT_VERSION` → Manage deployments → Edit → New version (same URL) → check `?action=version`.

---

## 4. Data today: Google Sheets

Six separate spreadsheet files (IDs are constants at the top of `apps-script.gs`):

| File | Tabs |
| --- | --- |
| **Orders** | Orders (~5,800 rows × 84 cols), TikTok Import History (~12,600 rows), Import Log, Fun Facts, Health |
| **Customers** | Customers (~1,700), Shopify Customer Matches, Merge History, Dismissed Duplicates |
| **QC** | Registros QC (~5,100), Pack Log, Sessions (retired) |
| **Audit Log** | Log 2026 (~13,000) — one tab per year |
| **Mayoreo** | Mayoreo Orders, Items, Clientes, Plantillas, Settings |
| **Product Catalog** | Product Parents, Product Variants, Catalog Suggestions, Product Merge History, Dismissed Product Pairs, Listings, Listing Variants, Listing Templates, Listing Exports, Listing History, Product Attributes, Attribute Translations |

Known structural weak spots (each solved by the Postgres design):
- Up to 30 products per order stored as 60 columns (Product 1–30 Catalog ID / Qty).
- Up to 5 + 5 QC photos stored as columns (Content1–5, Box1–5).
- Combined TikTok orders stored as one text cell (`"A + B + C"`).
- IDs can silently turn into numbers (scientific notation) — guarded by `forceTextFormat()`.
- Shipment Count / First Order Date stored and re-synced nightly, so they can drift.

---

## 5. The VPS (Hostinger)

Ubuntu, 2 CPU cores, 8 GB RAM, 96 GB disk (≈85% RAM and 90% disk free on 28-10-2026). Everything runs as Docker containers defined in `/root/docker-compose.yml` (plus `/root/vp-files/docker-compose.yml`). All containers share the Docker network `root_default`, so they reach each other by name. Secrets live in `/root/.env`, never in compose files.

| Container | Role | Public? |
| --- | --- | --- |
| `traefik` | Reverse proxy: HTTPS certificates and routing by subdomain | Ports 80/443 |
| `n8n` | Automation: TikTok import webhook, Shopify order webhook | Own subdomain |
| `tiktok-import` | Python/FastAPI: parses TikTok CSV + label PDF, sends batches to Apps Script | No |
| `image-service` | Public image hosting | Own subdomain |
| `vp-files` | File/photo hosting for Archivos (`files.srv2017849.hstgr.cloud`) | Own subdomain |
| `postgres` | PostgreSQL 17 — the future database *(empty, schema not applied yet)* | **No** — no ports exposed |
| `adminer` | Database browser | **No** — `127.0.0.1:8080`, reached through a VS Code SSH tunnel |

**Access:** SSH with key only (password login disabled). Work is done through VS Code Remote-SSH. Hostinger's browser console remains the emergency fallback. **Before any large change, take a fresh Hostinger snapshot** (they expire after about a day).

---

## 6. Main data flows

- **Page load:** page JS → `VP.get('<action>')` → Apps Script reads Sheets → JSON back. Some pages cache in `sessionStorage`; Análisis currently refetches on every visit.
- **TikTok import:** Importar page → n8n webhook (checks the user's session) → `tiktok-import` on the VPS parses CSV + PDF → posts batches to Apps Script `import_tiktok_orders` (machine token) → rows in Orders, Customers, TikTok Import History.
- **Shopify order:** Shopify webhook → n8n → Apps Script `import_shopify_order`. Status follows Shopify's `financial_status`, moving forward only.
- **Packing:** Empaque page → photos compressed in the browser and uploaded → `save_qc` writes the QC row; "Enviar" finalizes and stamps Packed Date on the order.
- **Mayoreo:** wholesale orders live in the Mayoreo file and are **mirrored** into Orders (channel `Mayoreo`, ID `MAY-…`) so packing treats them like any order.

---

## 7. Migration to PostgreSQL *(in progress)*

**Why:** remove Apps Script from the request path. Postgres answers in milliseconds; the API runs next to it on the VPS.

**Target design:**

```
Browser ──► FastAPI (new, on the VPS, own HTTPS subdomain via Traefik)
                 └──► PostgreSQL (same VPS, private)
```

**Tools:** PostgreSQL 17 (Docker) · FastAPI + psycopg (Python, plain SQL) · Alembic for schema migrations (versioned files in this repo) · Adminer now, NocoDB later for a spreadsheet-like view · nightly `pg_dump` copied off the VPS · nightly export back to Sheets as a readable backup.

**Plan — staged cutover:**
1. Build schema, API and a per-action switch in `VP.get` / `VP.post`.
2. A sync job copies Sheets → Postgres every few minutes. **Sheets stays the single source of truth**; Postgres is a copy. No writing to both systems.
3. Two weeks of daily comparisons (row counts, shipment counts, packed dates, page numbers) against pass criteria agreed beforehand.
4. Cutover on a quiet day: reads and writes move together for linked areas (Orders + QC + Customers move as one).
5. Sheets kept as backup (nightly export) and rollback option.

**Standing rule during and after migration:** any new column, tab or sheet added in Google Sheets **must** get a matching Postgres change (migration + sync update) at the same time. Nothing is copied automatically.

**Status (28-10-2026):** Postgres + Adminer running. Schema drafted in three stages (core · history/audit · feature areas), not yet applied. Next: repo on the VPS (deploy key), `api/` folder with FastAPI + Alembic, first migration.

### Schema design decisions

| Decision | Why |
| --- | --- |
| Every ID is `TEXT` | Ends the scientific-notation problem permanently |
| Product slots → `order_lines` table | No 30-item limit; simple product analytics |
| QC photo columns → `qc_photos` table | No 5-photo limit; easy "missing box photo" checks |
| `"A + B"` TikTok IDs → `order_tiktok_ids` | Exact lookups instead of text matching |
| Customer aliases → own table | Indexed, fast matching |
| Merged customers → `merged_into` column | Replaces the `(merged→ …)` text marker |
| Shipment Count / First Order Date → computed view (`customer_stats`) | Can never drift; no reconcile job. Per-channel counts available |
| One `audit_log` table | No yearly tabs |
| Status fields locked to known values (orders, QC, pick, Mayoreo, pack log) | Typos can't create new statuses |
| TikTok statuses and audit actions stay free text | Their vocabulary grows outside our control |
| Mayoreo clients = profiles on existing customers | One identity per person |
| Mirror of Mayoreo orders into `orders` kept | Same behavior as today; replace with a link later |
| Orders get an internal numeric key | Order ID is not stable (joined IDs, UUIDs, Shopify before label) |

---

## 8. Open decisions

- **Notes as orders:** buyer messages / seller notes are stored as order rows with channel `Nota`. Kept for the migration; future option is a separate `order_notes` table.
- **Shipment Count default:** today TikTok + Shopify; wanted: TikTok by default with per-channel and combined options (analytics page).
- **Product Categories:** code exists, but the Sheets tab/columns were never created. Tables are in the schema, empty. Intended for analytics.
- **Mayoreo cancellations:** currently done by deleting the order (history is lost). Likely future: a `Cancelado` status.
- **Listing Variants → Stock:** unused; live stock is Product Variants → Stock.

---

## 9. Related documents

- `CONVENTIONS.md` — coding rules and shared helpers
- `FIX_LOG.md` — what changed in each fix-pack and how to deploy it
- `vps-reference/` — reference copies of the VPS Python code
