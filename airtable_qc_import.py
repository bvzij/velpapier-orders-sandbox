#!/usr/bin/env python3
"""
Airtable QC photo history import — fix-pack 2026-10-19 (FIX_LOG 3.4)

Moves ~4,800 Airtable packing records (photos + who packed + when) into the
dashboard's QC sheet, with photos copied into Cloudinary.

WHY ON THE VPS: ~6,000 photo transfers don't fit Apps Script's 6-minute
limit, and Airtable's photo links expire. Cloudinary fetches each photo
straight from the Airtable link (nothing is downloaded to the VPS).

REQUIREMENTS: Python 3.9+ standard library only. Environment variables
(the first two already exist in /root/.env for the tiktok-import service):
    VP_API_URL              Apps Script web app URL (…/exec)
    API_TOKEN               the VPS service token (API_TOKEN_SERVICE)
    CLOUDINARY_CLOUD        cloud name        (same values as the Apps
    CLOUDINARY_API_KEY      API key            Script properties of the
    CLOUDINARY_API_SECRET   API secret         same names)

USAGE (export the Airtable CSV the SAME DAY you run this — links expire):
    set -a; . /root/.env; set +a
    export CLOUDINARY_CLOUD=... CLOUDINARY_API_KEY=... CLOUDINARY_API_SECRET=...
    python3 airtable_qc_import.py --csv airtable.csv                 # dry run (default)
    python3 airtable_qc_import.py --csv airtable.csv --live          # real run
    echo "END OF MESSAGE"

SAFE TO RE-RUN: finished records are listed in airtable_progress.jsonl and
skipped; Cloudinary public IDs are deterministic with overwrite=false; the
backend skips any Tracking ID that already has a QC row.

DECISIONS (flagged in FIX_LOG.md — change the constants below if needed):
  - Records packed BEFORE 2026-08-01 00:00 (Mexico City) are "archived":
    no photos are copied; Content1 and Box1 point to one shared ARCHIVADO
    placeholder image.
  - Packer = "Quien Empacó", Surtidor = "Quien Surtí". Names outside the
    dashboard's staff list (Ana, Charli, anything unknown) become BOB.
  - The QC row's TikTok Order IDs come from the matched Orders row (the
    dashboard's shipment grouping), not from Airtable's own text.
"""
import argparse
import base64
import csv
import hashlib
import json
import os
import re
import sys
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone

try:
    from zoneinfo import ZoneInfo
    MX = ZoneInfo("America/Mexico_City")
except Exception:                       # fallback: UTC-6, no DST since 2022
    MX = timezone(timedelta(hours=-6))

ARCHIVE_BEFORE = datetime(2026, 8, 1, 0, 0, tzinfo=MX)
STAFF = {"BOB", "KARIN", "MARTHA", "MAU", "OSU"}
FALLBACK_STAFF = "BOB"
FOLDER = "velpapier/qc/airtable"
PLACEHOLDER_PUBLIC_ID = FOLDER + "/_archivado"
PROGRESS_FILE = "airtable_progress.jsonl"
UNRESOLVED_FILE = "airtable_unresolved.csv"

URL_RE = re.compile(r"\((https?://[^)\s]+)\)")


# ─── small helpers ─────────────────────────────────────────────────────
def norm_header(h):
    h = (h or "").replace("\ufeff", "").strip().lower()
    return "".join(c for c in unicodedata.normalize("NFD", h) if unicodedata.category(c) != "Mn")


def staff_name(raw):
    n = "".join(c for c in unicodedata.normalize("NFD", (raw or "").strip()) if unicodedata.category(c) != "Mn").upper()
    if not n:
        return "", False
    return (n, False) if n in STAFF else (FALLBACK_STAFF, True)


def parse_fecha(raw):
    """'16-10-26 11:53' (dd-mm-yy HH:MM, Mexico City) -> aware datetime or None."""
    m = re.match(r"\s*(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})(?:\s+(\d{1,2}):(\d{2}))?", raw or "")
    if not m:
        return None
    d, mo, y = int(m.group(1)), int(m.group(2)), int(m.group(3))
    y = y + 2000 if y < 100 else y
    try:
        return datetime(y, mo, d, int(m.group(4) or 0), int(m.group(5) or 0), tzinfo=MX)
    except ValueError:
        return None


def iso_utc(dt):
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")


def http_json(url, data=None, timeout=120, retries=3):
    last = None
    for attempt in range(1, retries + 1):
        try:
            if data is None:
                req = urllib.request.Request(url)
            else:
                body = data if isinstance(data, bytes) else json.dumps(data).encode("utf-8")
                ctype = "application/x-www-form-urlencoded" if isinstance(data, bytes) else "text/plain;charset=utf-8"
                req = urllib.request.Request(url, data=body, headers={"Content-Type": ctype})
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return json.loads(r.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            last = f"HTTP {e.code}: {e.read()[:300]!r}"
        except Exception as e:                 # network blip -> retry
            last = f"{type(e).__name__}: {e}"
        time.sleep(2 ** attempt)
    raise RuntimeError(last)


# ─── Cloudinary (signed upload by remote URL) ──────────────────────────
class Cloudinary:
    def __init__(self):
        self.cloud = os.environ.get("CLOUDINARY_CLOUD", "")
        self.key = os.environ.get("CLOUDINARY_API_KEY", "")
        self.secret = os.environ.get("CLOUDINARY_API_SECRET", "")

    def ready(self):
        return all([self.cloud, self.key, self.secret])

    def upload(self, file_value, public_id):
        """file_value: a remote URL or a data: URI. Returns secure_url.
        overwrite=false + deterministic public_id => re-runs reuse the asset."""
        ts = str(int(time.time()))
        signed = {"overwrite": "false", "public_id": public_id, "timestamp": ts}
        to_sign = "&".join(f"{k}={signed[k]}" for k in sorted(signed)) + self.secret
        sig = hashlib.sha1(to_sign.encode("utf-8")).hexdigest()
        form = dict(signed, file=file_value, api_key=self.key, signature=sig)
        res = http_json(f"https://api.cloudinary.com/v1_1/{self.cloud}/image/upload",
                        urllib.parse.urlencode(form).encode("utf-8"), timeout=90)
        if "secure_url" not in res:
            raise RuntimeError(f"Cloudinary: {res}")
        return res["secure_url"]

    def placeholder(self):
        svg = ('<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="1280">'
               '<rect width="100%" height="100%" fill="#000"/>'
               '<text x="50%" y="48%" fill="#fff" font-family="Arial, sans-serif" font-size="120" '
               'font-weight="700" text-anchor="middle">ARCHIVADO</text>'
               '<text x="50%" y="58%" fill="#bbb" font-family="Arial, sans-serif" font-size="44" '
               'text-anchor="middle">Foto no conservada en Airtable</text></svg>')
        uri = "data:image/svg+xml;base64," + base64.b64encode(svg.encode()).decode()
        url = self.upload(uri, PLACEHOLDER_PUBLIC_ID)
        return re.sub(r"\.svg$", ".jpg", url)     # deliver as JPEG like every QC photo


# ─── main job ──────────────────────────────────────────────────────────
def load_csv(path):
    with open(path, encoding="utf-8-sig", newline="") as f:
        reader = csv.DictReader(f)
        cols = {norm_header(h): h for h in reader.fieldnames or []}
        need = {"order id": None, "customer": None, "quien surti": None, "quien empaco": None,
                "fecha empacar": None, "photo contents": None, "closed box": None}
        for k in need:
            need[k] = cols.get(k)
        missing = [k for k, v in need.items() if v is None]
        if missing:
            sys.exit(f"CSV is missing columns: {missing}. Found: {list(cols.values())}")
        rows = []
        for i, r in enumerate(reader, 2):
            rows.append({
                "line": i,
                "order_cell": (r[need["order id"]] or "").strip(),
                "customer": (r[need["customer"]] or "").strip(),
                "surti": r[need["quien surti"]] or "",
                "empaco": r[need["quien empaco"]] or "",
                "fecha": r[need["fecha empacar"]] or "",
                "content": URL_RE.findall(r[need["photo contents"]] or ""),
                "box": URL_RE.findall(r[need["closed box"]] or ""),
            })
        return rows


def fetch_orders_index(api, token):
    url = api + "?" + urllib.parse.urlencode({"action": "orders_index", "token": token})
    res = http_json(url, timeout=180)
    if "error" in res:
        sys.exit(f"orders_index failed: {res['error']} (is the 2026-10-19 Apps Script deployed?)")
    comp = {}
    for o in res.get("records", []):
        for part in str(o.get("Order ID", "")).split("+"):
            pid = re.sub(r"\D", "", part)
            if pid:
                comp.setdefault(pid, o)
    return comp


def resolve(rows, comp):
    plan, unresolved, notes = [], [], {"partial": 0, "staff_fallback": 0, "username_mismatch": 0}
    for r in rows:
        ids = [re.sub(r"\D", "", p) for p in r["order_cell"].split("+")]
        ids = [x for x in ids if x]
        key = "+".join(sorted(ids)) or f"line{r['line']}"
        dt = parse_fecha(r["fecha"])
        found = [comp[x] for x in ids if x in comp]
        trks = {str(o.get("Tracking ID", "")).strip() for o in found}
        reason = None
        if not ids:
            reason = "sin_order_id"
        elif not dt:
            reason = "fecha_invalida"
        elif not found:
            reason = "no_esta_en_orders"
        elif len(trks) > 1:
            reason = "repartido_en_varias_guias"
        elif not next(iter(trks)):
            reason = "pedido_sin_guia"
        if reason:
            unresolved.append({"line": r["line"], "order_id": r["order_cell"], "customer": r["customer"],
                               "fecha": r["fecha"], "reason": reason})
            continue
        if len(found) < len(ids):
            notes["partial"] += 1
        o = found[0]
        packer, fb1 = staff_name(r["empaco"])
        surtidor, fb2 = staff_name(r["surti"])
        notes["staff_fallback"] += int(fb1) + int(fb2)
        if r["customer"] and r["customer"].lstrip("@").lower() != str(o.get("Primary Username", "")).lstrip("@").lower():
            notes["username_mismatch"] += 1
        plan.append({
            "key": key,
            "tracking_id": next(iter(trks)),
            "tiktok_order_ids": [re.sub(r"\D", "", p) for p in str(o.get("Order ID", "")).split("+") if re.sub(r"\D", "", p)],
            "customer_id": o.get("Customer ID", ""),
            "username": o.get("Primary Username", ""),
            "packer": packer,
            "surtidor": surtidor,
            "timestamp": iso_utc(dt),
            "archived": dt < ARCHIVE_BEFORE,
            "src_content": r["content"][:5],
            "src_box": r["box"][:5],
            "too_many_photos": len(r["content"]) > 5 or len(r["box"]) > 5,
        })
    return plan, unresolved, notes


def load_progress():
    done = set()
    if os.path.exists(PROGRESS_FILE):
        with open(PROGRESS_FILE, encoding="utf-8") as f:
            for line in f:
                try:
                    done.add(json.loads(line)["key"])
                except Exception:
                    pass
    return done


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--csv", required=True)
    ap.add_argument("--live", action="store_true", help="really upload photos and write QC rows")
    ap.add_argument("--batch", type=int, default=100)
    ap.add_argument("--workers", type=int, default=8)
    ap.add_argument("--placeholder-url", default="", help="reuse an existing ARCHIVADO image instead of creating one")
    args = ap.parse_args()

    api, token = os.environ.get("VP_API_URL", ""), os.environ.get("API_TOKEN", "")
    if not api or not token:
        sys.exit("Set VP_API_URL and API_TOKEN (e.g. set -a; . /root/.env; set +a).")

    rows = load_csv(args.csv)
    print(f"CSV rows: {len(rows)}")
    comp = fetch_orders_index(api, token)
    print(f"Orders index: {len(comp)} TikTok order IDs")
    plan, unresolved, notes = resolve(rows, comp)

    with open(UNRESOLVED_FILE, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=["line", "order_id", "customer", "fecha", "reason"])
        w.writeheader()
        w.writerows(unresolved)

    archived = sum(1 for p in plan if p["archived"])
    photos = sum(len(p["src_content"]) + len(p["src_box"]) for p in plan if not p["archived"])
    reasons = {}
    for u in unresolved:
        reasons[u["reason"]] = reasons.get(u["reason"], 0) + 1
    print(f"Resolved: {len(plan)}  (archived: {archived}, with real photos: {len(plan) - archived}, photos to copy: {photos})")
    print(f"Unresolved: {len(unresolved)} -> {UNRESOLVED_FILE}  {reasons}")
    print(f"Notes: partial matches {notes['partial']}, staff names mapped to {FALLBACK_STAFF} {notes['staff_fallback']}, "
          f"customer name differs from Orders {notes['username_mismatch']}, >5 photos (truncated) {sum(p['too_many_photos'] for p in plan)}")

    done = load_progress()
    todo = [p for p in plan if p["key"] not in done]
    print(f"Already done (progress file): {len(plan) - len(todo)}  |  To process now: {len(todo)}")

    if not args.live:
        # Server-side dry run: tells how many already have a QC row.
        skipped = inserted = 0
        for i in range(0, len(todo), 500):
            chunk = [{"airtable_key": p["key"], "tracking_id": p["tracking_id"]} for p in todo[i:i + 500]]
            res = http_json(api, {"action": "import_qc_history", "token": token, "dry_run": True, "records": chunk})
            if "error" in res:
                sys.exit(f"Backend dry run failed: {res['error']}")
            inserted += res.get("inserted", 0)
            skipped += res.get("skipped", 0)
        print(f"Backend dry run: would insert {inserted}, would skip {skipped} (QC row already exists)")
        print("Nothing was uploaded or written. Re-run with --live when the numbers look right.")
        return

    cld = Cloudinary()
    if not cld.ready():
        sys.exit("Set CLOUDINARY_CLOUD, CLOUDINARY_API_KEY and CLOUDINARY_API_SECRET.")
    placeholder = args.placeholder_url or cld.placeholder()
    print(f"Archived placeholder: {placeholder}")

    def copy_photos(p):
        if p["archived"]:
            return dict(p, content=[placeholder], box=[placeholder], errors=[])
        out, errors = {"content": [], "box": []}, []
        base = p["tiktok_order_ids"][0] if p["tiktok_order_ids"] else p["tracking_id"]
        for group, src in (("content", p["src_content"]), ("box", p["src_box"])):
            for n, url in enumerate(src, 1):
                try:
                    out[group].append(cld.upload(url, f"{FOLDER}/{base}/{group}-{n}"))
                except Exception as e:
                    errors.append(f"{group}-{n}: {e}")
        return dict(p, content=out["content"], box=out["box"], errors=errors)

    total_ins = total_skip = total_err = 0
    started = time.time()
    with open(PROGRESS_FILE, "a", encoding="utf-8") as prog, ThreadPoolExecutor(args.workers) as pool:
        for i in range(0, len(todo), args.batch):
            chunk = list(pool.map(copy_photos, todo[i:i + args.batch]))
            failed = [c for c in chunk if c["errors"]]
            good = [c for c in chunk if not c["errors"]]
            for c in failed:
                print(f"  photo copy failed, will retry on next run: {c['key']} {c['errors'][:2]}")
            total_err += len(failed)
            if good:
                payload = [{
                    "airtable_key": c["key"], "tracking_id": c["tracking_id"],
                    "tiktok_order_ids": c["tiktok_order_ids"], "customer_id": c["customer_id"],
                    "username": c["username"], "packer": c["packer"], "surtidor": c["surtidor"],
                    "timestamp": c["timestamp"], "content": c["content"], "box": c["box"],
                    "archived": c["archived"],
                } for c in good]
                res = http_json(api, {"action": "import_qc_history", "token": token, "records": payload}, timeout=300)
                if "error" in res:
                    sys.exit(f"Backend error on batch starting at {i}: {res['error']} — re-run to resume.")
                total_ins += res.get("inserted", 0)
                total_skip += res.get("skipped", 0)
                for c in good:
                    prog.write(json.dumps({"key": c["key"], "tracking_id": c["tracking_id"]}) + "\n")
                prog.flush()
            done_n = min(i + args.batch, len(todo))
            rate = done_n / max(time.time() - started, 1)
            print(f"[{done_n}/{len(todo)}] inserted {total_ins}, skipped {total_skip}, photo errors {total_err} "
                  f"— ~{int((len(todo) - done_n) / max(rate, 0.01) / 60)} min left")

    print(f"DONE. Inserted {total_ins}, skipped (already had QC) {total_skip}, records with photo errors {total_err}.")
    if total_err:
        print("Re-run the same command to retry only the failed records (finished ones are skipped).")


if __name__ == "__main__":
    main()
