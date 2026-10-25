# fixpack-20261019 + importar-v2 2026-10-23 (+ test slip 2026-10-24)
"""
service.py - Vel Papier TikTok Import FastAPI Service
"""

import base64
import io
import json
import os
import logging
import time
import traceback
import zipfile

from pydantic import BaseModel


class EnrichApplyBody(BaseModel):
    items: list = []

import requests
from fastapi import Body, FastAPI, File, Header, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware

import csv as _csv
import io as _io

from tiktok_lib import (
    annotate_pdf,
    build_shipments_csv,
    group_shipments,
    parse_csv,
    parse_pdf_addresses,
    resolve_identity,
)
import importar_lib

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("vp-tiktok")

APP_TOKEN = os.environ["SERVICE_KEY"]
API_URL   = os.environ["API_URL"]
API_TOKEN = os.environ["API_TOKEN"]
BATCH     = 200

app = FastAPI(title="Vel Papier TikTok Import", version="1.0.0")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["POST", "GET"])


@app.get("/health")
def health():
    return {"ok": True}


@app.post("/process")
async def process(
    csv: UploadFile = File(...),
    pdf: UploadFile = File(...),
    x_api_key: str = Header(None),
    x_requested_by: str = Header(None),
):
    if x_api_key != APP_TOKEN:
        raise HTTPException(401, "Unauthorized")

    csv_bytes = await csv.read()
    pdf_bytes = await pdf.read()

    try:
        return await _process_impl(csv_bytes, pdf_bytes, (x_requested_by or "")[:60])
    except HTTPException:
        raise
    except Exception as e:
        tb = traceback.format_exc()
        log.error(f"Unhandled error in /process: {e}\n{tb}")
        raise HTTPException(
            status_code=500,
            detail={
                "error_type":    type(e).__name__,
                "error_message": str(e),
                "where":         "tiktok-import service (unhandled exception)",
            },
        )


async def _process_impl(csv_bytes: bytes, pdf_bytes: bytes, requested_by: str = ""):
    warnings = []

    rows = safe(lambda: parse_csv(csv_bytes), [], "CSV parsing", warnings)
    if not rows:
        raise HTTPException(400, "CSV parse failed or empty")

    csv_fieldnames = safe(
        lambda: _csv.DictReader(_io.StringIO(csv_bytes.decode("utf-8-sig", errors="replace"))).fieldnames,
        [],
        "CSV header read",
        warnings,
    ) or []

    # importar-v2: Buyer Message / Seller Note go into TikTok Import History
    # exactly as the CSV has them (per row; the sheet keeps the raw record).
    for r in rows:
        raw = r.get("raw_row") or {}
        h = r.get("import_history_row")
        if h is not None:
            h["buyer_message"] = importar_lib.clean_text(raw.get("Buyer Message", ""))
            h["seller_note"] = importar_lib.clean_text(raw.get("Seller Note", ""))

    shipments = group_shipments(rows, warnings)
    log.info(f"CSV: {len(rows)} rows -> {len(shipments)} shipments")

    # importar-v2: slip pre-check (parse + verify only, no drawing) and the
    # "In transit by" deadline per guía. Never blocks the import.
    slip_checks = safe(lambda: importar_lib.check_all(pdf_bytes, rows), {}, "Revisión de hojas de empaque", warnings)
    csv_by_tid = importar_lib.group_csv_rows(rows)
    for s in shipments:
        chk = slip_checks.get(s["tracking_id"]) or {}
        s["slip_check"] = chk
        s["ship_by"] = ((chk.get("deadline") or {}).get("iso")) or ""
        notas = []
        for oid, n in importar_lib.csv_notes_by_order(csv_by_tid.get(s["tracking_id"], [])).items():
            for key, source in (("buyer", "Comprador"), ("seller", "Vendedor")):
                txt = importar_lib.clean_text(n.get(key, ""))
                if txt:
                    notas.append({"order_id": oid, "source": source, "text": txt,
                                  "candidates": json.dumps(n.get("items", []), ensure_ascii=False)})
        s["notas"] = notas

    pdf_addresses = safe(lambda: parse_pdf_addresses(pdf_bytes, warnings), {}, "PDF address extraction", warnings)
    log.info(f"PDF: extracted addresses for {len(pdf_addresses)} tracking IDs")
    for s in shipments:
        s["address"] = pdf_addresses.get(s["tracking_id"], {})
        s["address"]["recipient_raw"] = s.get("recipient_raw", "")

    shipments_in_pdf = [s for s in shipments if s["tracking_id"] in pdf_addresses]
    log.info(f"CSV export: {len(shipments_in_pdf)} of {len(shipments)} shipments matched to this PDF")

    existing_customers = _fetch_customers()
    log.info(f"Customers: {len(existing_customers)} records")

    for s in shipments:
        resolution = resolve_identity(
            username           = s["username"],
            phone_fingerprint  = s.get("phone_fingerprint", {}),
            initials           = s.get("initials", []),
            pdf_data           = s["address"],
            existing_customers = existing_customers,
        )
        s["resolution"] = resolution

    new_customer_payloads = []
    for s in shipments:
        if s["resolution"]["tier"] == "new_customer" and s["username"]:
            e = s["resolution"]["enriched_data"]
            new_customer_payloads.append({
                "primary_username": e.get("Primary Username", ""),
                "first_name":       e.get("First Name", ""),
                "surname":          e.get("Surname", ""),
                "street":           e.get("Street + Number", ""),
                "city":             e.get("City", ""),
                "state":            e.get("State", ""),
                "zip":              e.get("ZIP", ""),
                "phone_partial":    e.get("Phone Partial", ""),
                "initials":         e.get("Initials (TT Format)", ""),
            })

    username_to_custid = {}
    new_customers_created = []
    if new_customer_payloads:
        result = safe(lambda: _create_customers_bulk(new_customer_payloads), {"created": []}, "Creating new customers", warnings)
        for c in result.get("created", []):
            username_to_custid[c["username"]] = c["customer_id"]
            if not c.get("existed"):
                new_customers_created.append({
                    "username":    c["username"],
                    "customer_id": c["customer_id"],
                })

    for s in shipments:
        if s["resolution"]["tier"] == "new_customer" and s["username"]:
            cid = username_to_custid.get(s["username"], "")
            if cid:
                s["resolution"]["customer_id"] = cid

    all_results  = []
    inserted     = 0
    duplicates   = 0
    exact_linked = 0

    for i in range(0, len(shipments), BATCH):
        batch = shipments[i : i + BATCH]
        payload = {
            "action":    "import_tiktok_orders",
            "token":     API_TOKEN,
            "requested_by": requested_by,
            "shipments": _build_batch_payload(batch),
        }
        resp = requests.post(API_URL, json=payload, timeout=300)
        if not resp.ok:
            raise HTTPException(502, f"Apps Script error: {resp.status_code}")
        j = resp.json()
        if "error" in j:
            raise HTTPException(502, j["error"])

        inserted     += j.get("inserted", 0)
        duplicates   += j.get("duplicates", 0)
        exact_linked += sum(1 for r in j.get("shipments", []) if r.get("customer_id"))
        all_results  += j.get("shipments", [])

    count_map = {r["tracking_id"]: r.get("shipment_count", 0) for r in all_results}
    res_map = {r["tracking_id"]: r for r in all_results}
    for s in shipments:
        s["shipment_count"] = count_map.get(s["tracking_id"], 0)

    annotation_meta = {
        s["tracking_id"]: {
            "username":       s["username"],
            "shipment_count": s["shipment_count"],
        }
        for s in shipments
    }

    annotated_pdf = safe(lambda: annotate_pdf(pdf_bytes, annotation_meta), pdf_bytes, "PDF annotation (tracking labels / address whiteout)", warnings)
    export_csv    = safe(lambda: build_shipments_csv(shipments_in_pdf, csv_fieldnames), b"", "Packing CSV export", warnings)

    possible_matches = [
        {
            "username":    s["username"],
            "tracking_id": s["tracking_id"],
            "score":       s["resolution"]["match_score"],
            "matched_to":  s["resolution"]["matched_to"],
            "enriched":    s["resolution"]["enriched_data"],
        }
        for s in shipments
        if s["resolution"]["tier"] == "possible_match"
    ]

    return {
        "summary": {
            "shipments_in_csv":      len(shipments),
            "shipments_in_pdf":      len(shipments_in_pdf),
            "inserted":              inserted,
            "duplicates":            duplicates,
            "exact_linked":          exact_linked,
            "possible_matches":      len(possible_matches),
            "new_customers_created": len(new_customers_created),
        },
        "possible_matches": possible_matches,
        "new_customers":    new_customers_created,
        # importar-v2: everything the configure step needs, per shipment
        "shipments_meta":   [_shipment_meta(s, res_map.get(s["tracking_id"], {}), s["tracking_id"] in pdf_addresses)
                             for s in shipments],
        "pdf_base64":       base64.b64encode(annotated_pdf).decode(),
        "csv_base64":       base64.b64encode(export_csv).decode(),
        "warnings":         warnings,
    }


def _shipment_meta(s, res, in_pdf):
    chk = s.get("slip_check") or {}
    return {
        "tracking_id":    s["tracking_id"],
        "order_ids":      s.get("order_ids", []),
        "username":       s.get("username", ""),
        "customer_id":    res.get("customer_id") or (s.get("resolution") or {}).get("customer_id", ""),
        "shipment_count": res.get("shipment_count"),
        "inserted":       bool(res.get("inserted")),
        "tier":           (s.get("resolution") or {}).get("tier", ""),
        "in_pdf":         bool(in_pdf),
        "ship_by":        s.get("ship_by", ""),
        "deadline":       chk.get("deadline"),
        "slip":           {k: chk.get(k) for k in ("ok", "code", "reason", "detail", "total")},
        "products":       s.get("line_items", []),
        "notas":          s.get("notas", []),
    }


# ─── importar-v2: JSON endpoint behind the n8n "importar-api" workflow ─────
# ops: "render"   -> final PDF from the browser's plan (csv + pdf re-sent)
#      "funfacts" -> sticker PDF (or calibration page with test=true)
#      "check"    -> slip pre-check only (used when an import is re-opened)
# Logic errors come back as {"error": ...} with HTTP 200 so n8n passes them on.
@app.post("/importar")
async def importar(body: dict = Body(...), x_api_key: str = Header(None)):
    if x_api_key != APP_TOKEN:
        raise HTTPException(401, "Unauthorized")
    op = str(body.get("op") or "")
    try:
        if op == "render":
            pdf = base64.b64decode(body.get("pdf_base64") or "")
            csvb = base64.b64decode(body.get("csv_base64") or "")
            if not pdf:
                # TROUBLESHOOT: the browser lost the original PDF (page reloaded
                # mid-import). Re-open the import from Historial, which reloads it.
                return {"error": "Falta el PDF original"}
            t0 = time.time()
            out, report = importar_lib.render_pdf(pdf, csvb, body.get("plan") or {}, body.get("settings") or {})
            report["ms"] = int((time.time() - t0) * 1000)
            log.info(f"render: {report['rebuilt']} rebuilt, {report['basic']} basic, {report['pages']} pages, {report['ms']} ms")
            return {"pdf_base64": base64.b64encode(out).decode(), "report": report}
        if op == "funfacts":
            out, info = importar_lib.funfact_pdf(body.get("fact") or {}, body.get("copies") or 0,
                                                 (body.get("settings") or {}).get("sticker") or {}, bool(body.get("test")))
            return {"pdf_base64": base64.b64encode(out).decode(), "info": info}
        if op == "check":
            pdf = base64.b64decode(body.get("pdf_base64") or "")
            csvb = base64.b64decode(body.get("csv_base64") or "")
            return {"checks": importar_lib.check_all(pdf, parse_csv(csvb))}
        if op == "test_slip":
            # Ajustes -> "Hoja de prueba": look-and-feel sample, nothing stored or uploaded.
            out, info = importar_lib.test_slip_pdf(body.get("mode") or "single",
                                                   (body.get("settings") or {}).get("slip") or {})
            return {"pdf_base64": base64.b64encode(out).decode(), "info": info}
        if op == "version":
            return {"importar": "2026-10-23", "pymupdf": getattr(importar_lib.fitz, "VersionBind", "?"),
                    "fonts": sorted(os.listdir(importar_lib.FONT_DIR)) if os.path.isdir(importar_lib.FONT_DIR) else []}
        return {"error": f"Operación desconocida: {op}"}
    except Exception as e:
        log.error(f"/importar {op} failed: {e}\n{traceback.format_exc()}")
        # TROUBLESHOOT: read `docker compose logs tiktok-import --tail 80` for the traceback.
        return {"error": f"{type(e).__name__}: {e}", "where": f"importar/{op}"}


def _build_batch_payload(batch):
    out = []
    for s in batch:
        resolution = s.get("resolution", {})
        out.append({
            "tracking_id": s["tracking_id"],
            "order_ids":   s["order_ids"],
            "username":    s["username"],
            "customer_id": resolution.get("customer_id", ""),
            "products":    s["products"],
            "line_items":  s.get("line_items", []),
            "import_history": s.get("import_history", []),
            "price":       s["price"],
            "created_time": s.get("created_time", ""),
            "ship_by":     s.get("ship_by", ""),
            "notas":       s.get("notas", []),
            "address": {
                "street": s["address"].get("street", ""),
                "city":   s["address"].get("city", ""),
                "state":  s["address"].get("state", ""),
                "zip":    s["address"].get("zip", ""),
                "phone":  s["address"].get("phone_partial", ""),
            },
        })
    return out


def _fetch_customers():
    last_error = None
    for attempt in range(1, 4):
        try:
            resp = requests.get(
                API_URL,
                params={"action": "customers", "token": API_TOKEN},
                timeout=60,
            )
            if not resp.text.strip():
                raise ValueError("empty response body")
            data = resp.json()
            records = data.get("records", [])
            if attempt > 1:
                log.info(f"_fetch_customers succeeded on attempt {attempt}, {len(records)} records")
            return records
        except Exception as e:
            last_error = e
            log.warning(f"_fetch_customers attempt {attempt} failed: {e}")
            if attempt < 3:
                time.sleep(2 * attempt)

    log.error(f"_fetch_customers failed after 3 attempts, giving up: {last_error}")
    return []


def _create_customers_bulk(customers):
    resp = requests.post(
        API_URL,
        json={
            "action":    "create_customers_bulk",
            "token":     API_TOKEN,
            "customers": customers,
        },
        timeout=120,
    )
    return resp.json()


# warnings, if given a list, gets a human-readable entry appended whenever
# fn() fails -- so a caller can still return the safe fallback (never crash
# the whole import over one failed step) while making sure the failure
# isn't silently invisible to whoever reads the response. label identifies
# which step failed (e.g. "PDF address extraction").
def safe(fn, fallback, label=None, warnings=None):
    try:
        return fn()
    except Exception as e:
        log.warning(f"safe() caught [{label or 'unknown step'}]: {e}")
        if warnings is not None:
            warnings.append(f"{label or 'Unknown step'} failed: {e}")
        return fallback
