#!/usr/bin/env python3
"""
VPS patch — fix-pack 2026-10-19 (see FIX_LOG.md, items 1.1, 2.1, 2.3, 2.7, 2.8)

Run it FROM THE FOLDER that contains service.py and tiktok_lib.py
(the folder the tiktok-import Dockerfile builds from):

    cd /path/to/tiktok-import
    python3 vps_patch_2026-10-19.py
    docker compose build tiktok-import && docker compose up -d --force-recreate tiktok-import
    echo "END OF MESSAGE"

Rules (house convention):
  - every edit is an exact string match that must occur EXACTLY once;
  - a file is only written if ALL its edits match (all-or-nothing per file);
  - each original is backed up as <file>.bak-20261019 before writing;
  - prints OK / FAILED per edit. Re-running after success reports
    "already applied" instead of breaking anything.
After a successful run, delete this script (house rule for one-offs).
"""
import os
import shutil
import sys

MARK = "fixpack-20261019"

EDITS = {
    "tiktok_lib.py": [
        # 2.1 read TikTok's Created Time so the real order time reaches Orders
        ("    \"zip\":         \"Zipcode\",\n}",
         "    \"zip\":         \"Zipcode\",\n    \"created_time\": \"Created Time\",\n}"),

        # 2.3 money keeps its sign (refunds were landing as positive numbers)
        ("""# Strips TikTok's "MXN 139.00" style prefix and any stray whitespace/tabs,
# returning a clean float. Blank/None becomes 0.0, never a crash.
def _clean_money(raw) -> float:
    if raw is None:
        return 0.0
    s = str(raw).strip()
    if not s:
        return 0.0
    s = re.sub(r"[^\\d.]", "", s)
    try:
        return float(s) if s else 0.0
    except ValueError:
        return 0.0""",
         """# fixpack-20261019: one signed money parser for every price field.
# "MXN -120.00" -> -120.0, "-MXN 1,072.88" -> -1072.88, "(50.00)" -> -50.0,
# Unicode minus handled. Blank/None/garbage -> 0.0, never a crash.
# (The old version stripped every non-digit, so refunds became positive.)
def _parse_mxn(raw) -> float:
    if raw is None:
        return 0.0
    s = str(raw).replace("\\t", "").strip()
    if not s:
        return 0.0
    neg = (s.startswith("-") or s.startswith("\\u2212")
           or ("(" in s and ")" in s)
           or bool(re.search(r"[A-Za-z$\\s]\\s*[-\\u2212]\\s*\\d", s)))
    digits = re.sub(r"[^\\d.]", "", s)
    if not digits:
        return 0.0
    try:
        v = float(digits)
    except ValueError:
        return 0.0
    return -v if neg else v


def _clean_money(raw) -> float:
    return _parse_mxn(raw)"""),

        ("            r[\"price_float\"] = float(re.sub(r\"[^\\d.]\", \"\", r[\"price\"]))",
         "            r[\"price_float\"] = _parse_mxn(r[\"price\"])"),

        # 2.1 + 2.8 grouping: earliest created_time per shipment, and count
        # rows skipped for having no Tracking ID instead of dropping silently
        ("""def group_shipments(rows: list) -> list:
    groups = {}
    for r in rows:
        tid = r["tracking_id"]
        if not tid:
            continue""",
         """def _created_sort_key(raw: str):
    # fixpack-20261019: sortable (y, m, d, H, M, S) from "dd/mm/yyyy hh:mm:ss"
    # or "mm/dd/yyyy hh:mm:ss AM"; day-first unless the first number can't be
    # a month. Only used to pick the EARLIEST row of a shipment; Apps Script
    # does the authoritative parse (batch-level day/month detection).
    m = re.match(r"\\s*(\\d{1,2})[/\\-.](\\d{1,2})[/\\-.](\\d{2,4})(?:\\s+(\\d{1,2}):(\\d{2})(?::(\\d{2}))?\\s*([AaPp])?)?", raw or "")
    if not m:
        return None
    a, b, y = int(m.group(1)), int(m.group(2)), int(m.group(3))
    y = y + 2000 if y < 100 else y
    d, mo = (b, a) if (b > 12 and a <= 12) else (a, b)
    hh = int(m.group(4) or 0)
    ap = (m.group(7) or "").lower()
    if ap == "p" and hh < 12:
        hh += 12
    if ap == "a" and hh == 12:
        hh = 0
    return (y, mo, d, hh, int(m.group(5) or 0), int(m.group(6) or 0))


def group_shipments(rows: list, warnings: list = None) -> list:
    groups = {}
    skipped_no_tracking = 0
    for r in rows:
        tid = r["tracking_id"]
        if not tid:
            skipped_no_tracking += 1
            continue"""),

        ("""                "price_by_order":    {},
                "address":           {},
            }""",
         """                "price_by_order":    {},
                "address":           {},
                "created_time":      "",
                "_created_key":      None,
            }"""),

        ("""        oid = r["order_id"]
        if oid:
            g["price_by_order"][oid] = max(g["price_by_order"].get(oid, 0.0), r["price_float"])
    for g in groups.values():
        g["products"] = "; ".join(g["products"])
        g["price"] = round(sum(g["price_by_order"].values()), 2)
        del g["price_by_order"]
    return list(groups.values())""",
         """        oid = r["order_id"]
        if oid:
            g["price_by_order"][oid] = max(g["price_by_order"].get(oid, 0.0), r["price_float"])
        ct = r.get("created_time", "")
        key = _created_sort_key(ct)
        if key and (g["_created_key"] is None or key < g["_created_key"]):
            g["_created_key"] = key
            g["created_time"] = ct
    for g in groups.values():
        g["products"] = "; ".join(g["products"])
        g["price"] = round(sum(g["price_by_order"].values()), 2)
        del g["price_by_order"]
        del g["_created_key"]
    if warnings is not None and skipped_no_tracking:
        warnings.append(f"{skipped_no_tracking} fila(s) del CSV sin guía se omitieron")
    return list(groups.values())"""),

        # 2.7 a label page that fails to parse is reported, not swallowed
        ("""def parse_pdf_addresses(pdf_bytes: bytes) -> dict:
    doc = fitz.open(stream=pdf_bytes, filetype="pdf")
    results = {}
    for label_idx, slip_indices in _walk_shipments(doc):
        try:
            data = _extract_label_page(doc[label_idx])
            tid = data.get("tracking_id")
            if tid:
                results[tid] = data
        except Exception:
            pass
    doc.close()
    return results""",
         """def parse_pdf_addresses(pdf_bytes: bytes, warnings: list = None) -> dict:
    doc = fitz.open(stream=pdf_bytes, filetype="pdf")
    results = {}
    labels = 0
    for label_idx, slip_indices in _walk_shipments(doc):
        labels += 1
        try:
            data = _extract_label_page(doc[label_idx])
            tid = data.get("tracking_id")
            if tid:
                results[tid] = data
            elif warnings is not None:
                warnings.append(f"PDF página {label_idx + 1}: no se encontró la guía")
        except Exception as e:
            if warnings is not None:
                warnings.append(f"PDF página {label_idx + 1}: {type(e).__name__}: {e}")
    doc.close()
    if warnings is not None and labels and len(results) < labels:
        warnings.append(f"Direcciones extraídas: {len(results)} de {labels} etiquetas")
    return results"""),

        # 2.8 remove the duplicated PER_ITEM_FIELDS block (second copy)
        ("""
        # Product-level fields are also per-line-item, not per-shipment --
        # base[raw_rows[0]] only carries the first item's SKU/name/qty,
        # so a 2nd or 3rd product in a combined shipment was silently
        # dropped from the exported row. Join every raw row's value for
        # each such field instead, same " + " convention as above.
        PER_ITEM_FIELDS = [
            "SKU ID", "Seller SKU", "Product Name", "Variation", "Quantity",
        ]
        for field in PER_ITEM_FIELDS:
            if field not in fieldnames:
                continue
            values = [(rr.get(field) or "").strip() for rr in raw_rows]
            values = [v for v in values if v]
            base[field] = " + ".join(values)

        writer.writerow(base)""",
         """
        writer.writerow(base)"""),
    ],

    "service.py": [
        # 1.1 the person who ran the import travels to the audit log
        ("""    x_api_key: str = Header(None),
):""",
         """    x_api_key: str = Header(None),
    x_requested_by: str = Header(None),
):"""),
        ("        return await _process_impl(csv_bytes, pdf_bytes)",
         "        return await _process_impl(csv_bytes, pdf_bytes, (x_requested_by or \"\")[:60])"),
        ("async def _process_impl(csv_bytes: bytes, pdf_bytes: bytes):",
         "async def _process_impl(csv_bytes: bytes, pdf_bytes: bytes, requested_by: str = \"\"):"),
        # 2.8 / 2.7 warnings collected instead of swallowed
        ("    shipments = group_shipments(rows)",
         "    shipments = group_shipments(rows, warnings)"),
        ("safe(lambda: parse_pdf_addresses(pdf_bytes), {}, \"PDF address extraction\", warnings)",
         "safe(lambda: parse_pdf_addresses(pdf_bytes, warnings), {}, \"PDF address extraction\", warnings)"),
        ("""            "action":    "import_tiktok_orders",
            "token":     API_TOKEN,""",
         """            "action":    "import_tiktok_orders",
            "token":     API_TOKEN,
            "requested_by": requested_by,"""),
        # 2.1 real TikTok order time per shipment
        ("""            "price":       s["price"],
            "address": {""",
         """            "price":       s["price"],
            "created_time": s.get("created_time", ""),
            "address": {"""),
    ],
}


def apply(folder: str) -> bool:
    all_ok = True
    for fname, edits in EDITS.items():
        path = os.path.join(folder, fname)
        if not os.path.exists(path):
            print(f"FAILED {fname}: file not found in {folder}")
            all_ok = False
            continue
        src = open(path, encoding="utf-8").read()
        if MARK in src:
            print(f"SKIP   {fname}: already applied ({MARK} marker present)")
            continue
        out = src
        file_ok = True
        for i, (old, new) in enumerate(edits, 1):
            n = out.count(old)
            if n == 1:
                out = out.replace(old, new)
                print(f"OK     {fname} edit {i}")
            else:
                print(f"FAILED {fname} edit {i}: anchor found {n} times -> {old.strip().splitlines()[0][:70]!r}")
                file_ok = False
        if not file_ok:
            print(f"       {fname} NOT written (all-or-nothing). Paste the FAILED lines back to Claude.")
            all_ok = False
            continue
        if MARK not in out:
            out = f"# {MARK}\n" + out
        shutil.copy2(path, path + ".bak-20261019")
        open(path, "w", encoding="utf-8").write(out)
        print(f"WROTE  {fname} (backup: {fname}.bak-20261019)")
    return all_ok


if __name__ == "__main__":
    folder = sys.argv[1] if len(sys.argv) > 1 else "."
    ok = apply(folder)
    print("RESULT:", "ALL OK" if ok else "SOME EDITS FAILED")
    sys.exit(0 if ok else 1)
