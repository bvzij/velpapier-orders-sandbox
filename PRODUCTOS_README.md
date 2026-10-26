# Productos & Archivos — how it fits together (built 2026-10-25)

## Pages
- `productos.html` — tabs: **Fichas** (listings editor + export, `listados.js`), **Fotos del catálogo** (`productos.js`, unchanged), **Plantillas** (TikTok templates), **Ajustes**. Admin-only.
- `archivos.html` / `archivos.js` — team file sharing on the VPS. All roles.
- `exportadores.js` — `VPExport`: parse/fill TikTok .xlsx templates (edits TikTok's original XML so dropdowns/validations survive), build Shopify CSV. Needs JSZip (cdnjs).

## Backend (Apps Script)
- `products.gs` = second file in the same Apps Script project. Every function starts with `prod`. All actions `prod_*`, admin-only, routed from `doGet`/`doPost` in apps-script.gs (POST routing happens before the global lock; writers take the lock themselves, AI/image upload don't).
- Actions: GET `prod_bootstrap`, `prod_template_file`, `prod_catalog` · POST `prod_save`, `prod_archive`, `prod_template_save`, `prod_template_toggle`, `prod_export_done`, `prod_settings_save`, `prod_upload_image`, `prod_ai` (mode `copy` | `attributes`).
- Script Properties: `ANTHROPIC_API_KEY` (AI on/off), optional `AI_MODEL` (default `claude-sonnet-5-5`), `PROD_SETTINGS` (JSON, written by the Ajustes tab), `PROD_TEMPLATES_FOLDER_ID` (auto), existing `IMAGE_SERVICE_KEY`.
- TikTok template files live in Drive folder "Vel Papier — Plantillas de productos" (auto-created).

## Sheets (Product Catalog spreadsheet, auto-created on first use)
- **Listings** — one row per product listing (LST-0001). Arrays/objects stored as JSON (Images, Tags, TikTok Props, Attributes). `Shopify Product ID` / `TikTok Product ID` reserved for the future API sync.
- **Listing Variants** — one row per variant, keyed by Listing ID + Catalog ID.
- **Listing Templates** — uploaded TikTok templates (config JSON = columns, mandatory flags, dropdown options).
- **Listing Exports** — log of every export file.
- **Listing History** — JSON snapshot on every save (manual undo source).
- **Product Attributes** — long format for analysis: Parent ID · Listing ID · Attribute · Value · Value Number · Source. One row per value (lists = several rows). Join to Orders via Product N Catalog ID → Product Variants → Parent ID.

## Catalog links
- Saving a new listing creates the Parent + Variant rows in Product Parents / Product Variants (Notes = "Creado en Productos (LST-…)").
- Blank SKUs are generated on save: `CODE-<parent number>-NN` (code per template in Ajustes). SKUs must be unique across the catalog.
- The listing's SKU and photos are written back to Product Variants / Product Parents (`Your SKU`, `Image URL`, `Full Image URL`).
- `resolveLineItemsBatch()` Step 1b: TikTok "Seller SKU" (and Shopify line-item `sku`) = Your SKU → links the order to that variant and stores the new TikTok SKU ID. Needs the VPS patch `patch_seller_sku_2026-10-25.sh` (tiktok_lib line_item carries `seller_sku`).
- Merged catalog variants are followed automatically ("(merged→VAR-x)").

## VPS
- `vps-reference/vp-files/` — container `vp-files` (FastAPI, SQLite, Pillow, ffmpeg) at `https://files.srv2017849.hstgr.cloud`. Install/update: `curl -fsSL https://raw.githubusercontent.com/bvzij/velpapier-orders-sandbox/main/vps-reference/vp-files/install.sh | bash`. Data in `/root/vp-files/data`. Copies image-service's Traefik labels (renamed); never touches other containers.
- Auth = dashboard token, checked via Apps Script `whoami` (cached 5 min).
- Public folders: links work without login (needed for TikTok/Shopify photo URLs). Private folders: team only. Trash 30 days; empty trash = admin.
- Backups: `/root/vp-files/backup.sh` nightly 09:00 UTC via cron, dormant until rclone has a remote named `vpbackup`.

## Future: API sync
Listings already store everything the Shopify Admin API needs (handle, SEO, variants with SKU/price/stock/barcode, image URLs). A `prod_shopify_push` action can be added to products.gs that reads a listing and writes back `Shopify Product ID` / `Shopify Variant ID`; the TikTok channel app then links by SKU.
