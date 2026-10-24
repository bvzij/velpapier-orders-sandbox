"""
importar_lib.py - Vel Papier "Importar v2" (built 2026-10-23)

What lives here (tiktok_lib.py is NOT changed; its logo images stay there):
  - parse_slip_block()   reads TikTok's packing slip into structured data
  - verify_block()       checks that data against the CSV (zero-guess rule)
  - check_all()          runs parse + verify for every shipment in a PDF
  - render_pdf()         builds the final PDF from a plan sent by the browser
  - funfact_pdf()        50x25 mm fun-fact sticker sheets (+ calibration page)
  - clean_text(), norm() shared text helpers

THE SAFETY RULE: a packing slip is only redrawn when every check passes.
Any doubt -> that shipment gets exactly the old output (TikTok's own slip +
username/count line at the bottom) and the browser shows the reason.
Every reason has a code; each code below has a "TROUBLESHOOT" comment that
says what to look at when it shows up.
"""

import io
import os
import re
import base64
import datetime
import logging
import unicodedata
from collections import Counter

try:
    import pymupdf as fitz          # PyMuPDF >= 1.24 name
except ImportError:                 # older PyMuPDF only ships "fitz"
    import fitz

from tiktok_lib import _whiteout_sender, _walk_shipments, SEARCH_TERM_QTY

log = logging.getLogger("vp-importar")

FONT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fonts")
FONT_FILES = {
    "atkinson": ("AtkinsonHyperlegible-Regular.ttf", "AtkinsonHyperlegible-Bold.ttf"),
    "roboto":   ("Roboto-Regular.ttf", "Roboto-Bold.ttf"),
}

MX_OFFSET = datetime.timedelta(hours=-6)   # Mexico City, no DST since 2022
DIAS = ["LUN", "MAR", "MIÉ", "JUE", "VIE", "SÁB", "DOM"]
MESES = ["ENE", "FEB", "MAR", "ABR", "MAY", "JUN", "JUL", "AGO", "SEP", "OCT", "NOV", "DIC"]

# ─── Reason codes (Spanish text shown in the browser) ──────────────────────
# Every fallback carries one of these codes plus a detail string.
REASONS = {
    # TROUBLESHOOT: the slip page has no "Product Name / SKU / Seller SKU / Qty"
    # header row. TikTok renamed or moved the table header. Open the original
    # PDF, run page.get_text("dict") on the slip page and update
    # TABLE_HEADER_WORDS below to the new words.
    "HEADER_NOT_FOUND": "Encabezado de tabla no encontrado",
    # TROUBLESHOOT: "Tracking number:" is missing or differs from the label
    # page's guía. Check _parse_slip_pages() header block against the slip.
    "TRACKING_MISMATCH": "La guía de la hoja no coincide",
    # TROUBLESHOOT: a value in the Qty column is not a whole number. Look at
    # the reason detail; TikTok may have added text (e.g. "x2") to that column.
    "QTY_NOT_NUMBER": "Cantidad no numérica en la tabla",
    # TROUBLESHOOT: text sits in the table above the first Qty number. Usually
    # one product row was split over two pages. Compare the slip pages of
    # this shipment; if TikTok now splits rows, the row-join logic must learn it.
    "TEXT_BEFORE_FIRST_ROW": "Texto fuera de una fila de la tabla",
    # TROUBLESHOOT: a "•" child row without a "Combine listing" row before it,
    # or a combo row without children. TikTok changed how combos print.
    "COMBO_STRUCTURE": "Estructura de combo (Combine listing) inesperada",
    # TROUBLESHOOT: text on the slip that none of the known patterns explains.
    # The detail shows the text. Add a pattern for it in _parse_slip_pages()
    # ONLY after deciding where it must be printed on the rebuilt slip.
    "UNKNOWN_TEXT": "Texto no reconocido en la hoja",
    # TROUBLESHOOT: product lines on the slip do not match the CSV rows of the
    # same guía (name + variation + Seller SKU + quantity). Detail shows the
    # first difference. Common causes: CSV from a different export than the
    # PDF, a cancelled item, or TikTok shortening long product names.
    "PRODUCTS_MISMATCH": "Producto del PDF no coincide con el CSV",
    # TROUBLESHOOT: TikTok's printed "Qty Total" differs from our sum. Check the
    # combo multiplication rule in compute_items().
    "TOTAL_MISMATCH": "Total TikTok ≠ calculado",
    # TROUBLESHOOT: a Customer Message / Seller Note on the slip differs from
    # the CSV cell of that order. Detail names the order.
    "NOTE_MISMATCH": "Mensaje del PDF no coincide con el CSV",
    # TROUBLESHOOT: the guía exists in the PDF but not in the CSV. Usually the
    # CSV and PDF are from different exports. Re-export both together.
    "NOT_IN_CSV": "El envío no está en el CSV",
    # TROUBLESHOOT: our own redrawn page, read back, did not contain exactly
    # the expected text (usually a character the chosen font cannot print).
    # Detail shows the cell. Try another slip font in Ajustes.
    "READBACK_FAILED": "La hoja nueva no pasó la verificación",
    # TROUBLESHOOT: exception while parsing/drawing. Detail has the Python
    # error; check `docker compose logs tiktok-import` for the traceback.
    "INTERNAL_ERROR": "Error interno al procesar la hoja",
    # TROUBLESHOOT: the browser asked for the basic mode (whole PDF or this
    # shipment). Not an error.
    "BASIC_REQUESTED": "Formato básico solicitado",
}

TABLE_HEADER_WORDS = ["Product Name", "SKU", "Seller SKU", "Qty"]
NOTE_LABEL_RE = re.compile(r"^\s*(Customer Message|Seller Note)\s*[:：]\s*(.*)$", re.S)
ORDER_LINE_RE = re.compile(r"^\s*Order ID\s*[:：]\s*(\d{6,})\s*$")
QTY_TOTAL_RE = re.compile(r"^\s*Qty Total\s*[:：]\s*(\d+)?\s*$")
DEADLINE_RE = re.compile(r"(\d{1,2})/(\d{1,2})/(\d{4})\s+(\d{1,2}):(\d{2})\s*([AaPp][Mm])?")


class SlipError(Exception):
    def __init__(self, code, detail=""):
        super().__init__(f"{code}: {detail}")
        self.code = code
        self.detail = detail


# ─── Text helpers ──────────────────────────────────────────────────────────

_EMOJI_RE = re.compile(
    "[\U0001F000-\U0001FAFF\U00002600-\U000027BF\U00002B00-\U00002BFF"
    "\U0000FE00-\U0000FE0F\U0000200D\U000020E3\U000E0020-\U000E007F\U00003030\U0000303D]"
)


def clean_text(s, font=None):
    """Printable text: no emojis, no control chars, single spaces. With a
    font, characters that font cannot draw are dropped as well."""
    s = str(s or "").replace("\x00", "").replace("\r", "\n")
    s = _EMOJI_RE.sub("", s)
    out = []
    for ch in s:
        if ch == "\n":
            out.append(" ")
            continue
        if unicodedata.category(ch)[0] == "C":
            continue
        if font is not None and ch != " " and not font.has_glyph(ord(ch)):
            continue
        out.append(ch)
    return re.sub(r"\s+", " ", "".join(out)).strip()


def norm(s):
    """Comparison key: letters and digits only, no accents, lower case."""
    s = unicodedata.normalize("NFKD", str(s or ""))
    return "".join(ch.lower() for ch in s if ch.isalnum() and not unicodedata.combining(ch))


def _csv_digits(v):
    return re.sub(r"[^\d]", "", str(v or ""))


# ─── Deadline ("In transit by") ────────────────────────────────────────────

def parse_deadline(raw, created_raw=""):
    """'10/26/2026 11:59 PM' -> dict(iso_utc, label, date) or None.
    TikTok prints month-first. If that date is implausible next to the order
    date, day-first is tried before giving up (never guessed silently)."""
    m = DEADLINE_RE.search(str(raw or ""))
    if not m:
        return None
    a, b, y, hh, mi, ap = int(m.group(1)), int(m.group(2)), int(m.group(3)), int(m.group(4)), int(m.group(5)), (m.group(6) or "").lower()
    if ap == "pm" and hh < 12:
        hh += 12
    if ap == "am" and hh == 12:
        hh = 0
    created = _created_date(created_raw)
    for mo, d in ((a, b), (b, a)):
        try:
            local = datetime.datetime(y, mo, d, hh, mi)
        except ValueError:
            continue
        if created and not (created - datetime.timedelta(days=1) <= local <= created + datetime.timedelta(days=25)):
            continue
        utc = local - MX_OFFSET
        return {
            "iso": utc.strftime("%Y-%m-%dT%H:%M:%S.000Z"),
            "label": f"{DIAS[local.weekday()]} {local.day} {MESES[local.month - 1]}",
            "date": local.strftime("%Y-%m-%d"),
            "time": local.strftime("%H:%M"),
        }
    return None


def _created_date(raw):
    m = re.match(r"\s*(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})", str(raw or ""))
    if not m:
        return None
    a, b, y = int(m.group(1)), int(m.group(2)), int(m.group(3))
    y = y + 2000 if y < 100 else y
    d, mo = (b, a) if (b > 12 and a <= 12) else (a, b)
    try:
        return datetime.datetime(y, mo, d)
    except ValueError:
        return None


# ─── Slip parsing ──────────────────────────────────────────────────────────

def _page_lines(page):
    d = page.get_text("dict")
    out = []
    for b in d.get("blocks", []):
        if b.get("type", 0) != 0:
            continue
        for ln in b.get("lines", []):
            spans = [s for s in ln.get("spans", []) if str(s.get("text", "")).strip(" \x00\t")]
            if not spans:
                continue
            text = "".join(s.get("text", "") for s in ln["spans"]).replace("\x00", "").strip()
            if not text:
                continue
            x0, y0, x1, y1 = ln["bbox"]
            bold = all(("Bold" in s.get("font", "")) or (s.get("flags", 0) & 16) for s in spans)
            out.append({"text": text, "x0": x0, "y0": y0, "x1": x1, "y1": y1,
                        "bold": bold, "size": max(s.get("size", 0) for s in spans)})
    out.sort(key=lambda l: (round(l["y0"], 1), l["x0"]))
    return out


def _same_row(a, b, tol=2.0):
    return abs(a["y0"] - b["y0"]) < tol


def _value_right_of(lines, i, used):
    lab = lines[i]
    best = None
    for j, l in enumerate(lines):
        if j in used or j == i:
            continue
        if _same_row(l, lab) and l["x0"] >= lab["x1"] - 1:
            if best is None or l["x0"] < lines[best]["x0"]:
                best = j
    if best is None:
        return ""
    used.add(best)
    return lines[best]["text"]


def parse_slip_block(doc, slip_indices):
    """Reads one shipment's packing-slip pages. Raises SlipError on anything
    it does not fully understand."""
    res = {"tracking_id": "", "deadline_raw": "", "rows": [], "printed_total": None,
           "orders": [], "footer_ids": [], "page_size": None}
    cols = None
    for pi, idx in enumerate(slip_indices):
        page = doc[idx]
        if res["page_size"] is None:
            res["page_size"] = (page.rect.width, page.rect.height)
        W = page.rect.width
        lines = _page_lines(page)
        used = set()

        # 1) header line: "In transit by: <date>   Tracking number: <id>"
        head_bottom = 0.0
        for i, l in enumerate(lines):
            t = l["text"]
            for label, key in (("In transit by:", "deadline_raw"), ("Tracking number:", "tracking_id")):
                if t.startswith(label):
                    used.add(i)
                    val = t[len(label):].strip() or _value_right_of(lines, i, used)
                    if val and not res[key]:
                        res[key] = val.strip()
                    elif val and res[key] and key == "tracking_id" and val.strip() != res[key]:
                        raise SlipError("TRACKING_MISMATCH", f"hoja {pi + 1}: {val} ≠ {res[key]}")
                    head_bottom = max(head_bottom, l["y1"])
        for j in list(used):
            head_bottom = max(head_bottom, lines[j]["y1"])

        # 2) table header
        hdr = None
        for i, l in enumerate(lines):
            if i in used or l["text"] != TABLE_HEADER_WORDS[0]:
                continue
            row = {TABLE_HEADER_WORDS[0]: i}
            for j, l2 in enumerate(lines):
                if j != i and j not in used and _same_row(l2, l) and l2["text"] in TABLE_HEADER_WORDS[1:]:
                    row[l2["text"]] = j
            if len(row) == 4:
                hdr = row
                break
        if hdr:
            for j in hdr.values():
                used.add(j)
            cols = {
                "name": lines[hdr["Product Name"]]["x0"],
                "sku": lines[hdr["SKU"]]["x0"],
                "seller": lines[hdr["Seller SKU"]]["x0"],
                "qty": lines[hdr["Qty"]]["x0"],
            }
            table_top = max(lines[j]["y1"] for j in hdr.values())
        elif pi == 0 or cols is None:
            raise SlipError("HEADER_NOT_FOUND", f"hoja {pi + 1}")
        else:
            table_top = head_bottom

        # 3) where the table ends on this page
        table_end = page.rect.height + 1
        for i, l in enumerate(lines):
            if i in used or l["y0"] < table_top:
                continue
            if QTY_TOTAL_RE.match(l["text"]) or l["text"].startswith("Qty Total") or ORDER_LINE_RE.match(l["text"]):
                table_end = min(table_end, l["y0"])

        # 4) table cells -> rows anchored on the Qty column
        cells = []
        for i, l in enumerate(lines):
            if i in used or not (table_top - 0.5 <= l["y0"] < table_end - 0.5):
                continue
            x = l["x0"]
            if x < cols["sku"] - 3:
                col = "name"
            elif x < cols["seller"] - 3:
                col = "sku"
            elif x < cols["qty"] - 12:
                col = "seller"
            else:
                col = "qty"
            cells.append((i, col, l))
        anchors = [c for c in cells if c[1] == "qty"]
        for i, col, l in anchors:
            if not re.fullmatch(r"\d+", l["text"]):
                raise SlipError("QTY_NOT_NUMBER", f"hoja {pi + 1}: '{l['text']}'")
        anchors.sort(key=lambda c: c[2]["y0"])
        if cells and not anchors:
            raise SlipError("TEXT_BEFORE_FIRST_ROW", f"hoja {pi + 1}: '{cells[0][2]['text']}'")
        page_rows = [{"qty": int(a[2]["text"]), "y": a[2]["y0"], "name": [], "sku": [], "seller": []} for a in anchors]
        for i, col, l in cells:
            used.add(i)
            if col == "qty":
                continue
            ri = None
            for k, r in enumerate(page_rows):
                nxt = page_rows[k + 1]["y"] if k + 1 < len(page_rows) else 1e9
                if r["y"] - 2.0 <= l["y0"] < nxt - 2.0:
                    ri = k
                    break
            if ri is None:
                raise SlipError("TEXT_BEFORE_FIRST_ROW", f"hoja {pi + 1}: '{l['text']}'")
            page_rows[ri][col].append(l)
        for r in page_rows:
            nl = sorted(r["name"], key=lambda l: l["y0"])
            kind = "item"
            if nl and nl[0]["text"].strip().lower() == "combine listing":
                kind = "combo"
                nl = nl[1:]
            name = " ".join(l["text"] for l in nl).strip()
            if name.startswith("•"):
                if kind == "combo":
                    raise SlipError("COMBO_STRUCTURE", f"'{name[:40]}'")
                kind = "child"
                name = name.lstrip("•").strip()
            name = re.sub(r"\s+", " ", name)
            if not name:
                raise SlipError("TEXT_BEFORE_FIRST_ROW", f"hoja {pi + 1}: fila sin nombre (cantidad {r['qty']})")
            join = lambda arr: re.sub(r"\s+", " ", " ".join(l["text"] for l in sorted(arr, key=lambda l: l["y0"]))).strip()
            res["rows"].append({"kind": kind, "name": name, "variation": join(r["sku"]),
                                "seller_sku": join(r["seller"]), "qty": r["qty"]})

        # 5) after the table: Qty Total, Order ID sections with notes, footer
        current = None
        rest = [(i, l) for i, l in enumerate(lines) if i not in used]
        rest.sort(key=lambda t: (round(t[1]["y0"], 1), t[1]["x0"]))
        for i, l in rest:
            t = l["text"]
            m_tot = QTY_TOTAL_RE.match(t)
            if m_tot or t.startswith("Qty Total"):
                used.add(i)
                v = m_tot.group(1) if m_tot and m_tot.group(1) else _value_right_of(lines, i, used)
                if v and re.fullmatch(r"\d+", v.strip()):
                    res["printed_total"] = int(v.strip())
                else:
                    raise SlipError("UNKNOWN_TEXT", f"Qty Total sin número: '{t}'")
                continue
            m_ord = ORDER_LINE_RE.match(t)
            if m_ord:
                used.add(i)
                if l["x0"] > W * 0.4:              # small right-aligned footer line
                    if m_ord.group(1) not in res["footer_ids"]:
                        res["footer_ids"].append(m_ord.group(1))
                    current = None
                else:
                    current = {"order_id": m_ord.group(1), "notes": []}
                    res["orders"].append(current)
                continue
            m_note = NOTE_LABEL_RE.match(t)
            if m_note and current is not None:
                used.add(i)
                current["notes"].append({"label": m_note.group(1), "text": m_note.group(2).strip()})
                continue
            if current is not None and current["notes"] and l["x0"] < W * 0.4 + 40:
                used.add(i)                         # wrapped continuation of the last note
                current["notes"][-1]["text"] += " " + t
                continue
        leftovers = [lines[i]["text"] for i in range(len(lines)) if i not in used]
        if leftovers:
            raise SlipError("UNKNOWN_TEXT", f"hoja {pi + 1}: '{leftovers[0][:60]}'")
    return res


def compute_items(rows):
    """Groups combo children under their parent and computes what to pack.
    Rule (Vel, 2026-10-23): a 'Combine listing' row is not a product itself;
    each child's quantity is multiplied by the combo's quantity. Children
    print the multiplied number; the total is the sum of what goes in the box."""
    items = []
    for r in rows:
        if r["kind"] == "child":
            if not items or items[-1]["kind"] != "combo":
                raise SlipError("COMBO_STRUCTURE", f"'• {r['name'][:40]}' sin 'Combine listing' arriba")
            items[-1]["children"].append(dict(r, eff_qty=r["qty"] * items[-1]["qty"]))
        else:
            items.append(dict(r, children=[]))
    total = 0
    for it in items:
        if it["kind"] == "combo":
            if not it["children"]:
                raise SlipError("COMBO_STRUCTURE", f"combo '{it['name'][:40]}' sin productos")
            total += sum(c["eff_qty"] for c in it["children"])
        else:
            total += it["qty"]
    return items, total


def _row_key(name, variation, seller, qty):
    return f"{norm(name)}|{norm(variation)}|{norm(seller)}|{int(qty)}"


def csv_notes_by_order(csv_rows):
    """{order_id: {"buyer": text, "seller": text, "products": [...]}} from the
    raw CSV rows of one shipment. Messages repeat on every row of an order,
    so the first non-empty cell per order wins."""
    out = {}
    for r in csv_rows:
        oid = r.get("order_id") or ""
        raw = r.get("raw_row") or {}
        o = out.setdefault(oid, {"buyer": "", "seller": "", "products": []})
        b = str(raw.get("Buyer Message") or "").strip()
        s = str(raw.get("Seller Note") or "").strip()
        if b and not o["buyer"]:
            o["buyer"] = b
        if s and not o["seller"]:
            o["seller"] = s
        if r.get("products_str"):
            o["products"].append(r["products_str"])
    return out


def verify_block(parsed, csv_rows, tracking_id, created_raw=""):
    """Zero-guess comparison of the parsed slip with the CSV. Returns the data
    needed to redraw the slip. Raises SlipError on the first doubt."""
    if parsed.get("tracking_id") and parsed["tracking_id"] != tracking_id:
        raise SlipError("TRACKING_MISMATCH", f"{parsed['tracking_id']} ≠ {tracking_id}")
    if not parsed.get("tracking_id"):
        raise SlipError("TRACKING_MISMATCH", "sin 'Tracking number' en la hoja")
    if not csv_rows:
        raise SlipError("NOT_IN_CSV", tracking_id)
    items, total = compute_items(parsed["rows"])

    pdf_keys = Counter(_row_key(it["name"], it["variation"], it["seller_sku"], it["qty"]) for it in items)
    csv_keys = Counter()
    for r in csv_rows:
        if not r.get("product"):
            continue
        q = r.get("quantity") or "1"
        csv_keys[_row_key(r["product"], r.get("variation", ""), (r.get("raw_row") or {}).get("Seller SKU", ""),
                          int(q) if str(q).isdigit() else -1)] += 1
    if pdf_keys != csv_keys:
        only_pdf = list((pdf_keys - csv_keys).elements())
        only_csv = list((csv_keys - pdf_keys).elements())
        def show(k):
            for it in items:
                if _row_key(it["name"], it["variation"], it["seller_sku"], it["qty"]) == k:
                    return f"{it['qty']}× {it['name'][:45]} ({it['variation'][:25]})"
            for r in csv_rows:
                q = r.get("quantity") or "1"
                if _row_key(r["product"], r.get("variation", ""), (r.get("raw_row") or {}).get("Seller SKU", ""),
                            int(q) if str(q).isdigit() else -1) == k:
                    return f"{q}× {r['product'][:45]} ({r.get('variation', '')[:25]})"
            return k
        detail = []
        if only_pdf:
            detail.append("solo en PDF: " + show(only_pdf[0]))
        if only_csv:
            detail.append("solo en CSV: " + show(only_csv[0]))
        raise SlipError("PRODUCTS_MISMATCH", "; ".join(detail))

    if parsed.get("printed_total") is not None and parsed["printed_total"] != total:
        raise SlipError("TOTAL_MISMATCH", f"TikTok {parsed['printed_total']} ≠ calculado {total}")

    notes = csv_notes_by_order(csv_rows)
    csv_order_ids = set(notes.keys())
    pdf_notes = {}
    for o in parsed.get("orders", []):
        if o["order_id"] not in csv_order_ids:
            raise SlipError("NOTE_MISMATCH", f"pedido {o['order_id']} no está en el CSV")
        for n in o["notes"]:
            key = "buyer" if n["label"] == "Customer Message" else "seller"
            pdf_notes[(o["order_id"], key)] = n["text"]
    for oid, n in notes.items():
        for key in ("buyer", "seller"):
            csv_n, pdf_n = norm(n[key]), norm(pdf_notes.get((oid, key), ""))
            # TikTok may shorten a long message on the slip: the slip text must
            # then be the START of the CSV text (and never empty if CSV has one).
            if csv_n and not (pdf_n and csv_n.startswith(pdf_n)):
                raise SlipError("NOTE_MISMATCH", f"pedido {oid}: {'mensaje del cliente' if key == 'buyer' else 'nota del vendedor'}")
            if pdf_n and not csv_n:
                raise SlipError("NOTE_MISMATCH", f"pedido {oid}: el PDF tiene un mensaje que el CSV no tiene")
    for fid in parsed.get("footer_ids", []):
        if fid not in csv_order_ids:
            raise SlipError("NOTE_MISMATCH", f"Order ID del pie {fid} no está en el CSV")

    order_ids = []
    for r in csv_rows:
        if r.get("order_id") and r["order_id"] not in order_ids:
            order_ids.append(r["order_id"])
    deadline = parse_deadline(parsed.get("deadline_raw"), created_raw)
    return {"items": items, "total": total, "notes": notes, "order_ids": order_ids, "deadline": deadline,
            "page_size": parsed.get("page_size") or (298.0, 420.0)}


def _slip_tracking(doc, slip_indices):
    for idx in slip_indices[:1]:
        m = re.search(r"Tracking number:\s*(\S+)", doc[idx].get_text())
        if m:
            return m.group(1)
    return None


def group_csv_rows(rows):
    by = {}
    for r in rows:
        if r.get("tracking_id"):
            by.setdefault(r["tracking_id"], []).append(r)
    return by


def check_all(pdf_bytes, csv_rows):
    """Parse + verify every shipment (no drawing). Used by /process so the
    browser can show fallbacks BEFORE anything is printed.
    Returns {tracking_id: {ok, code, reason, detail, deadline, total}}."""
    doc = fitz.open(stream=pdf_bytes, filetype="pdf")
    by = group_csv_rows(csv_rows)
    out = {}
    try:
        for label_idx, slip_indices in _walk_shipments(doc):
            tid = _slip_tracking(doc, slip_indices)
            if not tid:
                continue
            first = (by.get(tid) or [{}])[0]
            entry = {"ok": False, "code": "", "reason": "", "detail": "", "deadline": None, "total": None}
            parsed = None
            try:
                parsed = parse_slip_block(doc, slip_indices)
                data = verify_block(parsed, by.get(tid, []), tid, first.get("created_time", ""))
                entry.update(ok=True, deadline=data["deadline"], total=data["total"])
            except SlipError as e:
                entry.update(code=e.code, reason=REASONS.get(e.code, e.code), detail=e.detail)
                if parsed:
                    entry["deadline"] = parse_deadline(parsed.get("deadline_raw"), first.get("created_time", ""))
            except Exception as e:  # never let one slip stop the import
                entry.update(code="INTERNAL_ERROR", reason=REASONS["INTERNAL_ERROR"], detail=f"{type(e).__name__}: {e}")
            if entry["deadline"] is None and parsed is None:
                # header could not be parsed at all; try the raw page text
                m = re.search(r"In transit by:\s*([0-9/]+\s+[0-9:]+\s*[AP]M)", doc[slip_indices[0]].get_text()) if slip_indices else None
                if m:
                    entry["deadline"] = parse_deadline(m.group(1), first.get("created_time", ""))
            out[tid] = entry
    finally:
        doc.close()
    return out


# ─── Fonts & drawing helpers ───────────────────────────────────────────────

class Fonts:
    """One slip font family. TTF files live in ./fonts (downloaded by the
    deploy script). Missing files fall back to the built-in Helvetica."""
    def __init__(self, family):
        self.family = family if family in FONT_FILES else "helvetica"
        self.warning = ""
        if self.family != "helvetica":
            reg, bold = (os.path.join(FONT_DIR, f) for f in FONT_FILES[self.family])
            if os.path.exists(reg) and os.path.exists(bold):
                self.reg_path, self.bold_path = reg, bold
                self.reg = fitz.Font(fontfile=reg)
                self.bold = fitz.Font(fontfile=bold)
                self.reg_name, self.bold_name = "VPR" + self.family[:3], "VPB" + self.family[:3]
                return
            # TROUBLESHOOT: font files missing in /root/tiktok-import/fonts --
            # re-run the font download part of the deploy script, then rebuild.
            self.warning = f"Fuente '{family}' no instalada en el servidor; se usó Helvetica"
            self.family = "helvetica"
        self.reg_path = self.bold_path = None
        self.reg, self.bold = fitz.Font("helv"), fitz.Font("hebo")
        self.reg_name, self.bold_name = "helv", "hebo"

    def prepare(self, page):
        if self.reg_path:
            page.insert_font(fontname=self.reg_name, fontfile=self.reg_path)
            page.insert_font(fontname=self.bold_name, fontfile=self.bold_path)

    def f(self, bold):
        return self.bold if bold else self.reg

    def name(self, bold):
        return self.bold_name if bold else self.reg_name


def _text(page, fonts, x, y, text, size, bold=False, color=(0, 0, 0)):
    if text:
        page.insert_text(fitz.Point(x, y), text, fontname=fonts.name(bold), fontsize=size, color=color)


def _width(fonts, text, size, bold=False):
    return fonts.f(bold).text_length(text, fontsize=size)


def _wrap(fonts, text, size, width, bold=False):
    # Tokens split at spaces AND after hyphens, so a code like "JZA5128-2686"
    # can only break as "JZA5128-" / "2686", never in the middle of a number.
    tokens = []
    for w in str(text or "").split(" "):
        parts = re.split(r"(?<=-)", w) if w else []
        for k, p in enumerate(parts):
            if p:
                tokens.append((p, k == 0))
    lines, cur = [], ""
    for w, spaced in tokens:
        cand = (cur + (" " if spaced else "") + w).strip() if cur else w
        if _width(fonts, cand, size, bold) <= width:
            cur = cand
            continue
        if cur:
            lines.append(cur)
        cur = ""
        while _width(fonts, w, size, bold) > width and len(w) > 1:   # very long word: hard-break
            cut = len(w)
            while cut > 1 and _width(fonts, w[:cut], size, bold) > width:
                cut -= 1
            lines.append(w[:cut])
            w = w[cut:]
        cur = w
    if cur:
        lines.append(cur)
    return lines or [""]


# ─── Slip style (sizes come from Ajustes; defaults chosen 2026-10-23) ─────

DEFAULT_SLIP = {
    "font": "atkinson",
    "name_size": 7.5, "sku_size": 8.5, "seller_size": 8.5, "qty_size": 11,
    "header_size": 7, "total_size": 12, "note_size": 9, "order_size": 7.5,
    "extras_size": 8.5, "lapiz_size": 26, "lapiz_text": "Lápiz Infinito",
    "deadline_size": 15, "footer_id_size": 9, "user_size": 12,
    "item_line_width": 0.8, "item_line_style": "solid",   # line between TikTok items
}


def slip_style(settings):
    s = dict(DEFAULT_SLIP)
    for k, v in (settings or {}).items():
        if k in s and v not in (None, ""):
            try:
                s[k] = float(v) if k not in ("font", "lapiz_text", "item_line_style") else str(v)
            except (TypeError, ValueError):
                pass
    for k in s:
        if k.endswith("_size"):
            s[k] = max(4.0, min(60.0, float(s[k])))
    s["item_line_width"] = max(0.1, min(4.0, float(s["item_line_width"])))
    if s["item_line_style"] not in ("solid", "dashed"):
        s["item_line_style"] = "solid"
    return s


# ─── Product names on the slip (2026-10-24) ─────────────────────────────
# Only the title is printed for the picker: everything before the first
# " - " (a dash with a space on both sides). The features after it stay in
# TikTok and in Pedidos. A hyphen inside a word ("B6-Gustav") is kept.
_TITLE_SPLIT = re.compile(r"\s+[-\u2013\u2014]\s+")


def short_title(name):
    s = str(name or "").strip()
    m = _TITLE_SPLIT.search(s)
    return (s[:m.start()] if m else s).strip()


def _rule(page, x0, x1, yy, width, style, color=(0, 0, 0)):
    """A horizontal line; style 'dashed' gives '- - - -'."""
    sh = page.new_shape()
    sh.draw_line(fitz.Point(x0, yy), fitz.Point(x1, yy))
    kw = {"dashes": "[4 3] 0"} if style == "dashed" else {}
    sh.finish(width=width, color=color, **kw)
    sh.commit()


def user_label_parts(ship):
    parts = [str(ship.get("username") or "").strip(), str(ship.get("count_label") or "").strip()]
    if ship.get("no_postal"):
        parts.append("NO POSTAL")
    return [p for p in parts if p]


def user_label(ship):
    """'{username}  {count}  NO POSTAL' -- same red line as the old output."""
    return "  ".join(user_label_parts(ship))


# ─── Rebuilt slip ──────────────────────────────────────────────────────────

class _Page:
    """A page of the rebuilt slip. PyMuPDF invalidates an old Page object when
    a later page is added to the same document ("page is None"), so only the
    page INDEX is stored and the page is re-loaded on every access."""
    def __init__(self, doc, size, fonts):
        self.doc = doc
        p = doc.new_page(width=size[0], height=size[1])
        self.idx = p.number
        fonts.prepare(p)
        self.checks = []          # (rect, expected_norm, label) for read-back

    @property
    def page(self):
        return self.doc[self.idx]


def _draw_bottom(pg, fonts, st, data, ship, page_no, page_count):
    page = pg.page
    W, H = page.rect.width, page.rect.height
    M = 8
    # username line (identical idea to the old output; red, bold)
    label = "  ".join(clean_text(p, fonts.bold) for p in user_label_parts(ship))
    if label.strip():
        _text(page, fonts, 10, H - 5, label, st["user_size"], True, (1, 0, 0))
    foot_h = st["deadline_size"] * 1.15 + 6
    top = H - 5 - st["user_size"] - 4 - foot_h
    page.draw_line(fitz.Point(M, top), fitz.Point(W - M, top), color=(0, 0, 0), width=0.8)
    half = (W - 2 * M) / 2
    dd = data.get("deadline") or {}
    dl = dd.get("label") or "SIN FECHA"
    if dd.get("time") and dd["time"] != "23:59":
        dl += " " + dd["time"]          # unusual cut-off (e.g. 00:59): never hide it
    size = st["deadline_size"]
    while size > 6 and _width(fonts, dl, size, True) > half - 6:
        size -= 0.5
    base = top + 4 + st["deadline_size"]
    _text(page, fonts, M + (half - _width(fonts, dl, size, True)) / 2, base, dl, size, True)
    ids = data.get("order_ids") or []
    id_lines = [f"Order ID: {i}" for i in ids] or ["Order ID: —"]
    fs = st["footer_id_size"]
    avail_h = foot_h - 4
    while fs > 4 and (len(id_lines) * fs * 1.1 > avail_h or max(_width(fonts, t, fs) for t in id_lines) > half - 6):
        fs -= 0.5
    y = top + 3 + fs + max(0, (avail_h - len(id_lines) * fs * 1.1) / 2)
    for t in id_lines:
        _text(page, fonts, M + half + (half - _width(fonts, t, fs)) / 2, y, t, fs)
        y += fs * 1.1
    if page_count > 1:
        pn = f"{page_no}/{page_count}"
        _text(page, fonts, W - M - _width(fonts, pn, 7), 10, pn, 7)
    return top


def _bottom_limit(st, H):
    foot_h = st["deadline_size"] * 1.15 + 6
    return H - 5 - st["user_size"] - 4 - foot_h - 4


def render_rebuilt_slip(out, data, ship, st, fonts, tracking_id):
    """Draws the slip pages. Returns the list of _Page objects (read-back
    checks are attached). Pages get their footer at the end once the page
    count is known."""
    W, H = data["page_size"]
    M = 8
    # Column widths: Seller SKU is wide enough for a full code like
    # "JZA5128-2686" at the default size (a code split mid-way is a packing risk).
    cx = {"name": M, "name_w": W * 0.40 - M, "sku": W * 0.405, "sku_w": W * 0.205,
          "seller": W * 0.615, "seller_w": W * 0.265, "qty_r": W - M}
    limit = _bottom_limit(st, H) - 9      # 9 pt kept free for the "continúa" strip
    pages = []
    state = {"combo": ""}                 # name of the combo whose children are being drawn

    def new_page(cont=False):
        pg = _Page(out, (W, H), fonts)
        pages.append(pg)
        p = pg.page
        _text(p, fonts, M, 10, f"Guía: {tracking_id}" + ("   (continuación)" if cont else ""), st["header_size"])
        hy = 12 + st["header_size"] + 6
        hs = st["header_size"]
        _text(p, fonts, cx["name"], hy, "Producto", hs, True)
        _text(p, fonts, cx["sku"], hy, "SKU", hs, True)
        _text(p, fonts, cx["seller"], hy, "Seller SKU", hs, True)
        _text(p, fonts, cx["qty_r"] - _width(fonts, "Qty", hs, True), hy, "Qty", hs, True)
        p.draw_line(fitz.Point(M, hy + 3), fitz.Point(W - M, hy + 3), color=(0, 0, 0), width=0.8)
        return pg, hy + 3 + 3

    pg, y = new_page()

    def fit(h):
        nonlocal pg, y
        if y + h > limit:
            pg, y = new_page(cont=True)
            if state["combo"]:
                # a combo continues from the previous page: say which one
                ns = st["name_size"]
                label = "Combine listing (continúa): " + clean_text(short_title(state["combo"]), fonts.reg)
                for ln in _wrap(fonts, label, ns * 0.9, W - 2 * M, True)[:2]:
                    _text(pg.page, fonts, M, y + ns, ln, ns * 0.9, True, (0.35, 0.35, 0.35))
                    y += ns * 1.15
                y += 2

    def draw_row(name, variation, seller, qty, indent=0, combo_label=False, qty_light=False, dot=False,
                 boxes=True, light=False):
        nonlocal y
        name = short_title(name)                 # warehouse sees the title only
        ns, ss, ls, qs = st["name_size"], st["sku_size"], st["seller_size"], st["qty_size"]
        name_c = clean_text(name, fonts.reg)
        var_c = clean_text(variation, fonts.reg)
        sel_c = clean_text(seller, fonts.reg)
        # room for the check boxes: SKU/Seller boxes sit at the right of their column,
        # the qty box at the left of the number
        n_lines = _wrap(fonts, name_c, ns, cx["name_w"] - indent)
        v_lines = _wrap(fonts, var_c, ss, cx["sku_w"] - ss - 8) if var_c else []
        s_lines = _wrap(fonts, sel_c, ls, cx["seller_w"] - ls - 8) if sel_c else []
        lab_h = (ns * 1.15) if combo_label else 0
        h = max(lab_h + len(n_lines) * ns * 1.18, len(v_lines) * ss * 1.18, len(s_lines) * ls * 1.18, qs * 1.15) + 4
        fit(h)
        p = pg.page
        top = y
        yy = top + 1
        if combo_label:
            _text(p, fonts, cx["name"] + indent, yy + ns * 0.95, "Combine listing", ns * 0.9, True)
            yy += lab_h
        name_rect = fitz.Rect(cx["name"] + indent - 1, top, cx["name"] + cx["name_w"], top + h - 1)
        for ln in n_lines:
            _text(p, fonts, cx["name"] + indent, yy + ns, ln, ns)
            yy += ns * 1.18
        yy = top + 1
        for ln in v_lines:
            _text(p, fonts, cx["sku"], yy + ss, ln, ss)
            yy += ss * 1.18
        yy = top + 1
        for ln in s_lines:
            _text(p, fonts, cx["seller"], yy + ls, ln, ls)
            yy += ls * 1.18
        qt = str(qty)
        qx = cx["qty_r"] - _width(fonts, qt, qs, True)
        _text(p, fonts, qx, top + 1 + qs * 0.95, qt, qs, True, (0.45, 0.45, 0.45) if qty_light else (0, 0, 0))
        if dot:
            # red dot = more than one unit; sits just left of the qty box, clear of the Seller SKU box
            p.draw_circle(fitz.Point(qx - 4 - qs - 5, top + 1 + qs * 0.6), 2.2, color=(1, 0, 0), fill=(1, 0, 0))
        if boxes:
            # empty square, same height as the text, for a pen tick when picked
            b_sku = fitz.Rect(cx["sku"] + cx["sku_w"] - ss - 2, top + 1 + ss * 0.28, cx["sku"] + cx["sku_w"] - 2, top + 1 + ss * 1.28)
            b_sel = fitz.Rect(cx["seller"] + cx["seller_w"] - ls - 2, top + 1 + ls * 0.28, cx["seller"] + cx["seller_w"] - 2, top + 1 + ls * 1.28)
            b_qty = fitz.Rect(qx - 4 - qs, top + 1 + qs * 0.23, qx - 4, top + 1 + qs * 1.23)
            for rct in (b_sku, b_sel, b_qty):
                p.draw_rect(rct, color=(0, 0, 0), width=0.7)
        if light:
            p.draw_line(fitz.Point(M + indent, top + h), fitz.Point(W - M, top + h), color=(0.6, 0.6, 0.6), width=0.4)
        # read-back expectations (compared against the ORIGINAL text, so a
        # glyph the font could not draw is caught, not silently dropped)
        prefix = "combinelisting" if combo_label else ""
        pg.checks.append((name_rect, prefix + norm(name), "producto"))
        pg.checks.append((fitz.Rect(cx["sku"] - 1, top, cx["sku"] + cx["sku_w"], top + h - 1), norm(variation), "SKU"))
        pg.checks.append((fitz.Rect(cx["seller"] - 1, top, cx["seller"] + cx["seller_w"], top + h - 1), norm(seller), "Seller SKU"))
        pg.checks.append((fitz.Rect(cx["seller"] + cx["seller_w"], top, W, top + h - 1), norm(qt), "Qty"))
        y = top + h + 2

    item_w, item_style = st["item_line_width"], st["item_line_style"]

    def item_sep():
        """Configurable line between two TikTok items (not after the last one)."""
        nonlocal y
        if y + item_w + 4 > limit:
            return                               # the next item starts a new page instead
        _rule(pg.page, M, W - M, y + 1, item_w, item_style)
        y += item_w + 3

    for k, it in enumerate(data["items"]):
        if k > 0:
            item_sep()
        if it["kind"] == "combo":
            draw_row(it["name"], it["variation"], it["seller_sku"], it["qty"], combo_label=True, qty_light=True,
                     boxes=False, light=True)
            # only once the parent row is placed: if the children run onto the next
            # page, that page gets the "(continúa)" line; the parent is not repeated
            state["combo"] = it["name"]
            kids = it["children"]
            for j, ch in enumerate(kids):
                draw_row("• " + ch["name"], ch["variation"], ch["seller_sku"], ch["eff_qty"], indent=10,
                         dot=ch["eff_qty"] > 1, light=j < len(kids) - 1)
            state["combo"] = ""
        else:
            draw_row(it["name"], it["variation"], it["seller_sku"], it["qty"], dot=it["qty"] > 1)

    # Qty Total
    ts = st["total_size"]
    fit(ts * 1.4 + 4)
    p = pg.page
    tt = f"Qty Total: {data['total']}"
    tx = W - M - _width(fonts, tt, ts, True)
    _text(p, fonts, tx, y + ts + 1, tt, ts, True)
    pg.checks.append((fitz.Rect(tx - 2, y, W, y + ts * 1.4), norm(tt), "Qty Total"))
    y += ts * 1.4 + 6

    # Notes (CSV text, or the edited text from the browser)
    edits = ship.get("note_edits") or {}
    for oid in data["order_ids"]:
        n = data["notes"].get(oid) or {}
        e = edits.get(oid) or {}
        blocks = []
        for key, label in (("buyer", "Mensaje del cliente:"), ("seller", "Nota del vendedor:")):
            txt = e.get(key) if e.get(key) is not None else n.get(key, "")
            txt = clean_text(txt, fonts.reg)
            if txt:
                blocks.append((label, txt))
        if not blocks:
            continue
        os_, ns = st["order_size"], st["note_size"]
        fit(os_ * 1.3 + ns * 1.3 * 2)
        _text(pg.page, fonts, M, y + os_, f"Order ID: {oid}", os_)
        y += os_ * 1.35
        for label, txt in blocks:
            lines = _wrap(fonts, f"{label} {txt}", ns, W - 2 * M - 6)
            for k, ln in enumerate(lines):
                fit(ns * 1.25)
                if k == 0 and ln.startswith(label):
                    _text(pg.page, fonts, M + 6, y + ns, label, ns, True)
                    _text(pg.page, fonts, M + 6 + _width(fonts, label + " ", ns, True), y + ns, ln[len(label):].strip(), ns)
                else:
                    _text(pg.page, fonts, M + 6, y + ns, ln, ns)
                y += ns * 1.25
        y += 3

    # Extras approved in the browser, grouped by channel: one header per
    # channel, every item listed under it. Lines only separate the channels.
    # A note sits under its product, 2 pt smaller (never under 6 pt), no bullet.
    cats = {}
    for ex in (ship.get("extras") or []):
        cats.setdefault(str(ex.get("channel") or "Manual"), []).extend(ex.get("items") or [])
    order = [c for c in ("Manual", "Shopify", "Nota") if cats.get(c)]
    order += [c for c in cats if c not in ("Manual", "Shopify", "Nota") and cats[c]]
    if order:
        es = st["extras_size"]
        ns_note = max(6.0, es - 2)
        for idx, cat in enumerate(order):
            # the title and the first category travel together: never a heading alone at the bottom
            first_txt = next((clean_text(i.get("text", ""), fonts.reg) for i in cats[cat] if clean_text(i.get("text", ""), fonts.reg)), "")
            need = es * 1.5 + es * 1.25 * (2 if first_txt else 0)
            if idx == 0:
                need += es * 1.4 + 3
            fit(need)
            if idx == 0:
                pg.page.draw_line(fitz.Point(M, y), fitz.Point(W - M, y), color=(0, 0, 0), width=0.6)
                y += 3
                _text(pg.page, fonts, M, y + es + 1, "AGREGAR AL PAQUETE", es + 1, True)
                y += (es + 1) * 1.4
            else:
                pg.page.draw_line(fitz.Point(M, y), fitz.Point(W - M, y), color=(0.45, 0.45, 0.45), width=0.5)
                y += 4
            _text(pg.page, fonts, M, y + es, cat.upper(), es, True)
            y += es * 1.5
            for it in cats[cat]:
                text = clean_text(it.get("text", ""), fonts.reg)
                if not text:
                    continue
                for k, ln in enumerate(_wrap(fonts, text, es, W - 2 * M - 12)):
                    fit(es * 1.25)
                    _text(pg.page, fonts, M + 6, y + es, ("• " if k == 0 else "   ") + ln, es)
                    y += es * 1.25
                note = clean_text(it.get("note", ""), fonts.reg)
                if note:
                    for ln in _wrap(fonts, note, ns_note, W - 2 * M - 24):
                        fit(ns_note * 1.25)
                        _text(pg.page, fonts, M + 18, y + ns_note, ln, ns_note)
                        y += ns_note * 1.25
            y += 2

    # Lápiz Infinito: centred in the free space between the content and the footer
    if ship.get("lapiz"):
        ls = st["lapiz_size"]
        txt = clean_text(st["lapiz_text"] or "Lápiz Infinito", fonts.bold)
        while ls > 8 and _width(fonts, txt, ls, True) > W - 2 * M:
            ls -= 1
        # the last page does not need the "continúa" strip, so it may use it
        end = limit + 9
        if end - y < ls * 1.6:
            fitted = (end - y) / 1.6
            if fitted >= 14:                 # shrink into the free space rather than add a page
                ls = fitted
            else:
                pg, y = new_page(cont=True)
        mid = y + (end - y) / 2
        _text(pg.page, fonts, (W - _width(fonts, txt, ls, True)) / 2, mid + ls * 0.35, txt, ls, True)

    for k, p in enumerate(pages):
        _draw_bottom(p, fonts, st, data, ship, k + 1, len(pages))
        if k < len(pages) - 1:
            msg = "continúa en la hoja siguiente »"
            _text(p.page, fonts, W - M - _width(fonts, msg, 7.5, True), _bottom_limit(st, H) - 1, msg, 7.5, True)
    return pages


def readback(pages):
    """Reads our own pages back. Returns None or (label, expected, got)."""
    for pg in pages:
        for rect, expected, label in pg.checks:
            got = norm(pg.page.get_text("text", clip=rect))
            if got != expected:
                return label, expected, got
    return None


# ─── Basic (fallback) output: exactly the old behaviour + NO POSTAL ───────

def basic_annotate_slip(page, ship):
    """Copy of tiktok_lib._annotate_packing_slip, plus 'NO POSTAL'."""
    label = user_label(ship)
    if label:
        point = fitz.Point(10, page.rect.height - 5)
        try:
            page.insert_text(point, label, fontsize=12, fontname="helv-bold", color=(1, 0, 0))
        except Exception:
            page.insert_text(point, label, fontsize=12, color=(1, 0, 0))
    qty_headers = page.search_for(SEARCH_TERM_QTY)
    if qty_headers:
        qty_col = qty_headers[0]
        for w in page.get_text("words"):
            word = w[4].strip()
            if word.isdigit() and int(word) > 1 and qty_col.x0 - 10 <= w[0] <= qty_col.x1 + 10:
                line_rect = fitz.Rect(0, w[1] - 2, page.rect.width, w[3] + 2)
                if "total" not in page.get_text("text", clip=line_rect).lower():
                    page.draw_circle(fitz.Point(w[0] - 12, (w[1] + w[3]) / 2), 4, color=(1, 0, 0), fill=(1, 0, 0))


# ─── Final PDF ─────────────────────────────────────────────────────────────

def render_pdf(pdf_bytes, csv_bytes, plan, settings):
    """plan = {
         "mode": "full" | "basic",
         "sequence": [ {"type": "shipment", "tracking_id": ...} | {"type": "blank"} ],   # FILE order
         "shipments": { tracking_id: {username, count_label, no_postal, lapiz,
                                      extras: [{title, lines:[...]}],
                                      note_edits: {order_id: {buyer, seller}}} }
       }
    Returns (pdf_bytes, report)."""
    from tiktok_lib import parse_csv
    st = slip_style((settings or {}).get("slip") or {})
    fonts = Fonts(st["font"])
    rows = parse_csv(csv_bytes) if csv_bytes else []
    by = group_csv_rows(rows)
    src = fitz.open(stream=pdf_bytes, filetype="pdf")
    blocks = {}
    order_seen = []
    for label_idx, slip_indices in _walk_shipments(src):
        tid = _slip_tracking(src, slip_indices)
        key = tid or f"_sin_guia_{label_idx}"
        blocks[key] = (label_idx, slip_indices)
        order_seen.append(key)

    plan = plan or {}
    seq = list(plan.get("sequence") or [])
    ships = plan.get("shipments") or {}
    in_seq = {s.get("tracking_id") for s in seq if s.get("type") == "shipment"}
    report = {"shipments": {}, "warnings": [], "rebuilt": 0, "basic": 0, "pages": 0}
    if fonts.warning:
        report["warnings"].append(fonts.warning)
    for key in order_seen:                       # never drop a page TikTok gave us
        if key not in in_seq:
            seq.append({"type": "shipment", "tracking_id": key})
            report["warnings"].append(f"{key}: no venía en el orden del plan; se agregó al final")
    out = fitz.open()
    blank_size = None
    for entry in seq:
        if entry.get("type") == "blank":
            w, h = blank_size or (298, 420)
            out.new_page(width=w, height=h)
            continue
        tid = entry.get("tracking_id")
        if tid not in blocks:
            report["warnings"].append(f"{tid}: está en el plan pero no en el PDF")
            continue
        label_idx, slip_indices = blocks[tid]
        ship = ships.get(tid) or {}
        r = {"mode": "basic", "code": "", "reason": "", "detail": "", "pages": 0, "total": None}
        out.insert_pdf(src, from_page=label_idx, to_page=label_idx)
        _whiteout_sender(out[-1])
        blank_size = (out[-1].rect.width, out[-1].rect.height)
        start_pages = len(out)
        done = False
        if plan.get("mode", "full") == "full" and not ship.get("force_basic") and not tid.startswith("_sin_guia_"):
            first = (by.get(tid) or [{}])[0]
            try:
                parsed = parse_slip_block(src, slip_indices)
                data = verify_block(parsed, by.get(tid, []), tid, first.get("created_time", ""))
                pages = render_rebuilt_slip(out, data, ship, st, fonts, tid)
                bad = readback(pages)
                if bad:
                    raise SlipError("READBACK_FAILED", f"{bad[0]}: esperado '{bad[1][:40]}', leído '{bad[2][:40]}'")
                r.update(mode="rebuilt", total=data["total"], pages=len(pages))
                done = True
            except SlipError as e:
                r.update(code=e.code, reason=REASONS.get(e.code, e.code), detail=e.detail)
            except Exception as e:
                log.exception("rebuild failed for %s", tid)
                r.update(code="INTERNAL_ERROR", reason=REASONS["INTERNAL_ERROR"], detail=f"{type(e).__name__}: {e}")
            if not done:
                while len(out) > start_pages:     # throw away half-drawn pages
                    out.delete_page(len(out) - 1)
        elif plan.get("mode") == "basic" or ship.get("force_basic"):
            r.update(code="BASIC_REQUESTED", reason=REASONS["BASIC_REQUESTED"])
        if not done:
            for si in slip_indices:
                out.insert_pdf(src, from_page=si, to_page=si)
                basic_annotate_slip(out[-1], ship)
            r["pages"] = len(slip_indices)
        report["shipments"][tid] = r
        report["rebuilt" if done else "basic"] += 1
    report["pages"] = len(out)
    buf = io.BytesIO()
    try:
        out.subset_fonts()
    except Exception:
        pass
    out.save(buf, garbage=4, deflate=True)
    out.close()
    src.close()
    return buf.getvalue(), report


# ─── Fun-fact stickers (50 x 25 mm by default) ─────────────────────────────

MM = 72.0 / 25.4
DEFAULT_STICKER = {
    "font": "roboto", "width_mm": 50, "height_mm": 25,
    "margin_top": 2, "margin_right": 2.5, "margin_bottom": 2, "margin_left": 2.5,
    "title_size": 9, "answer_size": 7.5, "align": "center", "gap_mm": 0.8,
}


def sticker_style(settings):
    s = dict(DEFAULT_STICKER)
    for k, v in (settings or {}).items():
        if k in s and v not in (None, ""):
            try:
                s[k] = str(v) if k in ("font", "align") else float(v)
            except (TypeError, ValueError):
                pass
    return s


def funfact_pdf(fact, copies, settings, test=False):
    """One sticker per page. The title and answer shrink together until they
    fit inside the margins (the sizes in Ajustes are the maximum)."""
    s = sticker_style(settings)
    fonts = Fonts(s["font"])
    W, H = s["width_mm"] * MM, s["height_mm"] * MM
    box = fitz.Rect(s["margin_left"] * MM, s["margin_top"] * MM, W - s["margin_right"] * MM, H - s["margin_bottom"] * MM)
    out = fitz.open()
    title = clean_text((fact or {}).get("title", ""), fonts.bold)
    answer = clean_text((fact or {}).get("answer", ""), fonts.reg)
    if test:
        title = title or "Título de prueba"
        answer = answer or "Respuesta de prueba para calibrar márgenes"
    n = 1 if test else max(0, int(copies or 0))
    warning = fonts.warning

    def layout(scale):
        ts, as_ = s["title_size"] * scale, s["answer_size"] * scale
        tl = _wrap(fonts, title, ts, box.width, True) if title else []
        al = _wrap(fonts, answer, as_, box.width) if answer else []
        gap = s["gap_mm"] * MM if (tl and al) else 0
        h = len(tl) * ts * 1.15 + gap + len(al) * as_ * 1.15
        return ts, as_, tl, al, gap, h

    scale = 1.0
    ts, as_, tl, al, gap, h = layout(scale)
    while h > box.height and scale > 0.3:
        scale -= 0.03
        ts, as_, tl, al, gap, h = layout(scale)
    if h > box.height:
        warning = (warning + "; " if warning else "") + "El texto no cabe completo; acórtalo o reduce márgenes"
    for _ in range(n):
        page = out.new_page(width=W, height=H)
        fonts.prepare(page)
        y = box.y0 + max(0, (box.height - h) / 2)
        for ln, size, bold in [(t, ts, True) for t in tl] + [("__gap__", 0, False)] + [(a, as_, False) for a in al]:
            if ln == "__gap__":
                y += gap
                continue
            w = _width(fonts, ln, size, bold)
            x = box.x0 + ((box.width - w) / 2 if s["align"] == "center" else 0)
            _text(page, fonts, x, y + size * 0.92, ln, size, bold)
            y += size * 1.15
        if test:
            page.draw_rect(box, color=(0, 0, 0), width=0.3)
            page.draw_rect(fitz.Rect(0.5, 0.5, W - 0.5, H - 0.5), color=(0.6, 0.6, 0.6), width=0.3, dashes="[1 1] 0")
    buf = io.BytesIO()
    try:
        out.subset_fonts()
    except Exception:
        pass
    out.save(buf, garbage=4, deflate=True)
    out.close()
    return buf.getvalue(), {"pages": n, "scale": round(scale, 2), "warning": warning}


# ─── Test slip for Ajustes (look and feel only; nothing is stored) ───────
# mode 'single': one page, a normal order. mode 'large': two pages, a big order.
# Uses the same drawing code as a real slip; no CSV or TikTok PDF is needed.
def _test_items(n_plain, n_combo):
    items = []
    for k in range(n_plain):
        items.append({"kind": "item", "name": "Cuaderno A5 Van Gogh 100 Hojas 75 Gramos Raya - Cierre Elástico - Acentos Dorados",
                      "variation": "Alendros %d" % (k + 1), "seller_sku": "A2101-%d" % (k + 1), "qty": 1 + (k % 3), "children": []})
    for k in range(n_combo):
        kids = [{"kind": "child", "name": "Sticker en Libro de 24 Hojas - Varias Tematicas", "variation": "Estilo %d" % (j + 1),
                 "seller_sku": "JMHH-4-0%d" % (j + 1), "qty": 1, "eff_qty": 1} for j in range(4)]
        items.append({"kind": "combo", "name": "Sticker en Libro de 24 Hojas - Varias Tematicas", "variation": "Los 4 Estilos",
                      "seller_sku": "", "qty": 1, "children": kids})
    return items


def test_slip_pdf(mode, settings):
    st = slip_style(settings or {})
    fonts = Fonts(st["font"])
    mode = "large" if mode == "large" else "single"
    W, H = 298.0, 420.0
    n_plain, n_combo = (2, 1) if mode == "single" else (14, 3)
    out = None
    for _ in range(12):                                   # large: grow until it really is 2 pages
        items = _test_items(n_plain, n_combo)
        data = {"items": items, "total": sum(
            (it["qty"] if it["kind"] != "combo" else sum(c["eff_qty"] for c in it["children"])) for it in items),
            "notes": {"586724685448053923": {"buyer": "Para la comunidad de mi parte, gracias por la paciencia.",
                                             "seller": "NO mandar; es GA de mesversario"}},
            "order_ids": ["586724685448053923"], "deadline": {"label": "LUN 26 OCT", "time": "23:59"},
            "page_size": (W, H)}
        ship = {"username": "usuario.prueba", "count_label": "Nuevo", "no_postal": False, "lapiz": True,
                "extras": [
                    {"channel": "Manual", "items": [{"text": "2× Libreta A5 - Cobre", "note": "Nota: envolver para regalo"},
                                                    {"text": "1× Washi Monet", "note": ""}]},
                    {"channel": "Shopify", "items": [{"text": "1× Libreta Pride & Prejudice", "note": ""}]},
                    {"channel": "Nota", "items": [{"text": "Entregar en recepción del edificio", "note": ""}]}],
                "note_edits": {}}
        out = fitz.open()
        pages = render_rebuilt_slip(out, data, ship, st, fonts, "PRUEBA-NO-ES-ENVIO")
        if mode == "single" and len(pages) == 1:
            break
        if mode == "large" and len(pages) == 2:
            break
        too_many = len(pages) > (1 if mode == "single" else 2)
        out.close()
        out = None                                        # closed: a retry opens a fresh one
        if mode == "single":
            n_plain = max(1, n_plain - 1)
        else:
            n_plain = max(4, n_plain - 2) if too_many else n_plain + 2
    if out is None:
        raise SlipError("INTERNAL_ERROR", "no se pudo generar la hoja de prueba")
    n = len(out)
    buf = out.tobytes(garbage=4, deflate=True)
    out.close()
    return buf, {"pages": n, "mode": mode}
