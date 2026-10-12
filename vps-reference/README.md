# VPS reference copies

Read-only snapshots of the code running in the `tiktok-import` Docker
container on the Hostinger VPS. These are NOT deployed from here —
the VPS pulls from its own local files via `docker compose build`.

**Whenever you edit code on the VPS, manually re-paste the updated
file here too**, the same way apps-script.gs is kept in sync with
the Apps Script editor.

## Files
- `service.py` — FastAPI entry point: /process endpoint, batches orders
  to Apps Script, fetches customers, orchestrates the import.
- `tiktok_lib.py` — CSV parsing, PDF label/packing-slip parsing and
  annotation, fuzzy identity resolution, combined-orders CSV export.
  Two base64 image constants (`_LOGO_B64`, `_TULIP_B64`) had their actual
  image data stripped before upload — they're ~340KB combined and add
  no debugging value as text. The real values live only on the VPS.

## Known leftover files NOT copied here
Several one-off `patch_*.py` scripts exist on the VPS
(`patch_service_csv_fieldnames.py`, `patch_add_csv_export.py`,
`patch_fix_buyer_message.py`, `patch_fix_csv_export.py`). These already
ran successfully and patched service.py/tiktok_lib.py directly — per
project convention, one-off scripts get deleted after a successful run.
They were left on the VPS as of 2026-10-12 but contain no additional
logic beyond what's already reflected in the two files above.

Last synced: 2026-10-12
