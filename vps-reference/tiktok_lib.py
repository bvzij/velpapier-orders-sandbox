"""
tiktok_lib.py - Vel Papier TikTok Import Library
"""

import re
import io
import csv
import base64
import fitz
from rapidfuzz import fuzz

COLUMN_MAP = {
    "order_id":    "Order ID",
    "tracking_id": "Tracking ID",
    "username":    "Buyer Username",
    "recipient":   "Recipient",
    "phone":       "Phone #",
    "product":     "Product Name",
    "variation":   "Variation",
    "sku_id":      "SKU ID",
    "quantity":    "Quantity",
    "price":       "Order Amount",
    "state":       "State",
    "city":        "City",
    "zip":         "Zipcode",
}

PADDING            = [107, 2, 100, 5]
SEARCH_TERM_QTY    = "Qty"
SCORE_AUTO_LINK    = 80
SCORE_NEW_CUSTOMER = 75

# Vel Papier logo (trimmed PNG, base64) — embedded so the label-logo
# feature has no external file dependency on the VPS.
# NOTE: actual base64 image data omitted from this reference copy
# (see vps-reference/README.md). Real file on the VPS has it inline here.
_LOGO_B64 = (
)

# Small tulip decoration placed next to the logo (trimmed PNG, base64)
# NOTE: actual base64 image data omitted from this reference copy.
_TULIP_B64 = (
)



# Strips TikTok's "MXN 139.00" style prefix and any stray whitespace/tabs,
# returning a clean float. Blank/None becomes 0.0, never a crash.
def _clean_money(raw) -> float:
    if raw is None:
        return 0.0
    s = str(raw).strip()
    if not s:
        return 0.0
    s = re.sub(r"[^\d.]", "", s)
    try:
        return float(s) if s else 0.0
    except ValueError:
        return 0.0

# TikTok's export embeds stray tab characters inside several fields
# (Order ID, SKU ID, timestamps, Zipcode, Package ID) -- this strips them
# along with ordinary whitespace, WITHOUT altering the actual value.
def _clean_field(raw) -> str:
    if raw is None:
        return ""
    return str(raw).replace("\t", "").strip()

# Builds one "financial detail" record per CSV row, one row per line item,
# matching the CSV's own granularity -- for the TikTok Import History sheet.
def _build_import_history_row(row_dict: dict) -> dict:
    g = lambda key: _clean_field(row_dict.get(key, ""))
    m = lambda key: _clean_money(row_dict.get(key, ""))
    return {
        "order_id":                g("Order ID"),
        "sku_id":                  g("SKU ID"),
        "seller_sku":              g("Seller SKU"),
        "product_name":            g("Product Name"),
        "variation":               g("Variation"),
        "quantity":                g("Quantity"),
        "order_status":            g("Order Status"),
        "order_substatus":         g("Order Substatus"),
        "cancel_return_type":      g("Cancelation/Return Type"),
        "sku_unit_price":          m("SKU Unit Original Price"),
        "sku_subtotal_before":     m("SKU Subtotal Before Discount"),
        "sku_platform_discount":   m("SKU Platform Discount"),
        "sku_seller_discount":     m("SKU Seller Discount"),
        "sku_subtotal_after":      m("SKU Subtotal After Discount"),
        "shipping_fee_after":      m("Shipping Fee After Discount"),
        "shipping_fee_original":   m("Original Shipping Fee"),
        "shipping_fee_seller_disc":   m("Shipping Fee Seller Discount"),
        "shipping_fee_platform_disc": m("Shipping Fee Platform Discount"),
        "payment_platform_discount": m("Payment platform discount"),
        "retail_delivery_fee":     m("Retail Delivery Fee"),
        "order_amount":            m("Order Amount"),
        "order_refund_amount":     m("Order Refund Amount"),
        "created_time":            g("Created Time"),
        "paid_time":               g("Paid Time"),
        "rts_time":                g("RTS Time"),
        "shipped_time":            g("Shipped Time"),
        "delivered_time":          g("Delivered Time"),
        "cancelled_time":          g("Cancelled Time"),
        "cancel_by":               g("Cancel By"),
        "cancel_reason":           g("Cancel Reason"),
        "fulfillment_type":        g("Fulfillment Type"),
        "warehouse_name":          g("Warehouse Name"),
        "tracking_id":             g("Tracking ID"),
        "delivery_option_type":    g("Delivery Option Type"),
        "delivery_option":         g("Delivery Option"),
        "shipping_provider":       g("Shipping Provider Name"),
        "buyer_username":          g("Buyer Username"),
        "payment_method":          g("Payment Method"),
        "weight_kg":               g("Weight(kg)"),
        "product_category":        g("Product Category"),
        "order_channel":           g("Order Channel"),
        "creator_handle":          g("Creator Handle"),
    }


def parse_csv(csv_bytes: bytes) -> list:
    text = csv_bytes.decode("utf-8-sig", errors="replace")
    reader = csv.DictReader(io.StringIO(text))
    rows = []
    for row in reader:
        r = {}
        for key, col in COLUMN_MAP.items():
            r[key] = (row.get(col) or "").strip()
        r["order_id"] = re.sub(r"[^\d]", "", r["order_id"])
        r["tracking_id"] = r["tracking_id"].strip()
        r["phone_fingerprint"] = _phone_fingerprint(r["phone"])
        r["initials"] = _parse_initials(r["recipient"])
        r["recipient_raw"] = r["recipient"]
        qty = r["quantity"] or "1"
        var = f" ({r['variation']})" if r["variation"] else ""
        r["products_str"] = f"{qty}x {r['product']}{var}" if r["product"] else ""
        r["line_item"] = {
            "sku_id":    r["sku_id"],
            "product":   r["product"],
            "variation": r["variation"],
            "qty":       int(qty) if qty.isdigit() else 1,
        } if r["product"] else None
        r["import_history_row"] = _build_import_history_row(row)
        r["raw_row"] = row
        try:
            r["price_float"] = float(re.sub(r"[^\d.]", "", r["price"]))
        except ValueError:
            r["price_float"] = 0.0
        rows.append(r)
    return rows


def group_shipments(rows: list) -> list:
    groups = {}
    for r in rows:
        tid = r["tracking_id"]
        if not tid:
            continue
        if tid not in groups:
            groups[tid] = {
                "tracking_id":       tid,
                "order_ids":         [],
                "username":          r["username"],
                "phone_fingerprint": r["phone_fingerprint"],
                "initials":          r["initials"],
                "recipient_raw":     r["recipient_raw"],
                "products":          [],
                "line_items":        [],
                "import_history":    [],
                "raw_rows":          [],
                "price":             0.0,
                "address":           {},
            }
        g = groups[tid]
        if r["order_id"] and r["order_id"] not in g["order_ids"]:
            g["order_ids"].append(r["order_id"])
        if r["products_str"]:
            g["products"].append(r["products_str"])
        if r["line_item"]:
            g["line_items"].append(r["line_item"])
        if r.get("import_history_row"):
            g["import_history"].append(r["import_history_row"])
        if r.get("raw_row"):
            g["raw_rows"].append(r["raw_row"])
        g["price"] = max(g["price"], r["price_float"])
    for g in groups.values():
        g["products"] = "; ".join(g["products"])
    return list(groups.values())


# ─── Page-structure walking ─────────────────────────────────────────────
# TikTok's PDF is NOT a strict 2-page-per-shipment file. Each shipment is:
#   1 label page (has "Firma de recepción")
#   followed by 1-or-more packing-slip pages, ending at the page containing
#   "Qty Total:" (large orders overflow the slip onto a 2nd/3rd page).
# Walking with a fixed stride of 2 silently misaligns every shipment after
# the first overflow, corrupting addresses/annotations for everything that
# follows. This walks the real structure instead.

def _is_label_page(text: str) -> bool:
    return "Firma de recepción" in text


def _is_slip_end_page(text: str) -> bool:
    return "Qty Total:" in text


def _walk_shipments(doc):
    """
    Yields (label_idx, [slip_idx, ...]) for each shipment in document order.
    slip_idx list has 1 entry for a normal shipment, 2+ for an overflowed one.
    """
    n = len(doc)
    i = 0
    while i < n:
        text = doc[i].get_text()
        if not _is_label_page(text):
            i += 1
            continue
        label_idx = i
        slip_indices = []
        j = i + 1
        while j < n:
            slip_text = doc[j].get_text()
            slip_indices.append(j)
            j += 1
            if _is_slip_end_page(slip_text):
                break
            # Safety valve: if we hit another label page before finding
            # "Qty Total:", the slip-end marker is missing/unexpected —
            # stop here rather than silently swallowing the next shipment.
            if j < n and _is_label_page(doc[j].get_text()):
                break
        yield label_idx, slip_indices
        i = j


def parse_pdf_addresses(pdf_bytes: bytes) -> dict:
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
    return results


def _extract_label_page(page) -> dict:
    words = page.get_text("words")
    text  = page.get_text()
    r = {}

    trk = re.search(r"\b(JMX\d{10,})\b", text)
    if trk:
        r["tracking_id"] = trk.group(1)

    nombre_words = [w for w in words if w[4] == "Nombre:"]
    if nombre_words:
        ry = nombre_words[0][1]
        name_parts = sorted(
            [w for w in words if abs(w[1] - ry) < 3 and w[0] > nombre_words[0][2]],
            key=lambda w: w[0]
        )
        r["full_name"] = " ".join(w[4] for w in name_parts)

    cp_words  = [w for w in words if w[4] == "C.P:"]
    tel_words = [w for w in words if w[4] == "Tel:"]
    cp_y = None
    if cp_words and tel_words:
        cp_y  = cp_words[0][1]
        tel_x = tel_words[0][0]
        zip_ws = [w for w in words if abs(w[1] - cp_y) < 4
                  and w[0] > cp_words[0][2] and w[0] < tel_x]
        r["zip"] = " ".join(w[4] for w in zip_ws)

    if tel_words:
        tel_y = tel_words[0][1]
        ph_ws = sorted(
            [w for w in words if abs(w[1] - tel_y) < 4 and w[0] > tel_words[0][2]],
            key=lambda w: w[0]
        )
        raw_phone = " ".join(w[4] for w in ph_ws)
        r["phone_partial"] = raw_phone
        r["phone_fingerprint"] = _phone_fingerprint(raw_phone)

    if cp_y is not None:
        st_ws = sorted(
            [w for w in words if cp_y + 5 < w[1] < cp_y + 40],
            key=lambda w: w[0]
        )
        r["street"] = " ".join(w[4] for w in st_ws)

    if cp_y is not None:
        geo_ws = sorted(
            [w for w in words if cp_y + 40 < w[1] < cp_y + 60],
            key=lambda w: w[0]
        )
        groups = _group_words_by_gap(geo_ws, min_gap=20)
        if len(groups) >= 3:
            r["colonia"] = groups[0]
            r["city"]    = groups[1]
            r["state"]   = groups[2]
        elif len(groups) == 2:
            r["city"]  = groups[0]
            r["state"] = groups[1]

    return r


def _group_words_by_gap(words, min_gap=20) -> list:
    groups, current = [], []
    for i, w in enumerate(words):
        if i == 0:
            current.append(w[4])
        else:
            gap = words[i][0] - words[i - 1][2]
            if gap > min_gap:
                groups.append(" ".join(current))
                current = [w[4]]
            else:
                current.append(w[4])
    if current:
        groups.append(" ".join(current))
    return groups


def annotate_pdf(pdf_bytes: bytes, shipment_meta: dict) -> bytes:
    """
    Annotate PDF with username + shipment count on packing slips,
    whiteout sender address on label pages.
    Output is sorted Z->A by username so physical stack is A->Z from top.
    shipment_meta keyed by tracking_id: {username, shipment_count}

    Handles overflowed packing slips (label + 2+ slip pages) by keeping
    every page of a shipment together as one block when sorting/reassembling,
    instead of assuming a fixed 2-page pair.
    """
    src = fitz.open(stream=pdf_bytes, filetype="pdf")

    # Build list of shipment blocks (label + all its slip pages) for sorting
    blocks = []
    for label_idx, slip_indices in _walk_shipments(src):
        tracking_id = None
        if slip_indices:
            text = src[slip_indices[0]].get_text()
            trk_match = re.search(r"Tracking number:\s*(\S+)", text)
            if trk_match:
                tracking_id = trk_match.group(1)

        meta     = shipment_meta.get(tracking_id, {}) if tracking_id else {}
        username = meta.get("username", "")

        blocks.append({
            "label_idx":      label_idx,
            "slip_indices":   slip_indices,
            "username":       username,
            "shipment_count": meta.get("shipment_count", 0),
            "tracking_id":    tracking_id,
        })

    # Sort Z->A by username (case-insensitive)
    blocks.sort(key=lambda b: b["username"].lower(), reverse=True)

    # Build output PDF in sorted order
    out = fitz.open()
    for block in blocks:
        # Label page — copy and whiteout sender
        out.insert_pdf(src, from_page=block["label_idx"], to_page=block["label_idx"])
        new_label = out[-1]
        _whiteout_sender(new_label)

        # Packing slip page(s) — copy and annotate EACH one (username/count
        # label on every page of a multi-page slip; qty red-dots apply
        # per-page since each page has its own "Qty" column)
        for slip_idx in block["slip_indices"]:
            out.insert_pdf(src, from_page=slip_idx, to_page=slip_idx)
            new_slip = out[-1]
            _annotate_packing_slip(new_slip, block["username"], block["shipment_count"])

    buf = io.BytesIO()
    out.save(buf)
    out.close()
    src.close()
    return buf.getvalue()


def _whiteout_sender(page):
    search_term = "Taj\u00edn"
    for inst in page.search_for(search_term):
        rect = fitz.Rect(
            inst.x0 - PADDING[0], inst.y0 - PADDING[1],
            inst.x1 + PADDING[2], inst.y1 + PADDING[3]
        )
        page.draw_rect(rect, color=(1, 1, 1), fill=(1, 1, 1))
    _insert_logo(page)


def _insert_logo(page):
    """
    Places the Vel Papier logo + a small tulip decoration in the clear
    whitespace at the bottom-left of the label page, below "Comentarios:"
    and clear of the vertical barcode strip on the right. Fails silently —
    a missing/bad image should never block the whole import.
    """
    try:
        logo_bytes = base64.b64decode(_LOGO_B64)
        logo_target = fitz.Rect(15, 325, 213, 405)
        logo_w, logo_h = 1875, 789  # trimmed logo's native pixel size
        lscale = min(logo_target.width / logo_w, logo_target.height / logo_h)
        lfw, lfh = logo_w * lscale, logo_h * lscale
        lcx = logo_target.x0 + logo_target.width / 2
        lcy = logo_target.y0 + logo_target.height / 2
        logo_final = fitz.Rect(lcx - lfw / 2, lcy - lfh / 2, lcx + lfw / 2, lcy + lfh / 2)
        page.insert_image(logo_final, stream=logo_bytes)
    except Exception:
        pass

    try:
        tulip_bytes = base64.b64decode(_TULIP_B64)
        tulip_target = fitz.Rect(218, 325, 290, 405)
        tulip_w, tulip_h = 813, 990  # trimmed tulip's native pixel size
        tscale = min(tulip_target.width / tulip_w, tulip_target.height / tulip_h)
        tfw, tfh = tulip_w * tscale, tulip_h * tscale
        tcx = tulip_target.x0 + tulip_target.width / 2
        tcy = tulip_target.y0 + tulip_target.height / 2
        tulip_final = fitz.Rect(tcx - tfw / 2, tcy - tfh / 2, tcx + tfw / 2, tcy + tfh / 2)
        page.insert_image(tulip_final, stream=tulip_bytes)
    except Exception:
        pass


def _annotate_packing_slip(page, username: str, shipment_count: int):
    if username:
        count_label = "Nuevo" if not shipment_count else f"{shipment_count} env"
        label = f"{username}  {count_label}"
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
            if word.isdigit() and int(word) > 1:
                if qty_col.x0 - 10 <= w[0] <= qty_col.x1 + 10:
                    line_rect = fitz.Rect(0, w[1] - 2, page.rect.width, w[3] + 2)
                    if "total" not in page.get_text("text", clip=line_rect).lower():
                        dot = fitz.Point(w[0] - 12, (w[1] + w[3]) / 2)
                        page.draw_circle(dot, 4, color=(1, 0, 0), fill=(1, 0, 0))


def resolve_identity(username, phone_fingerprint, initials, pdf_data, existing_customers):
    if username:
        for c in existing_customers:
            all_names = [str(c.get("Primary Username", "") or "")]
            aliases = [a.strip() for a in str(c.get("Aliases", "") or "").split(",") if a.strip()]
            all_names.extend(aliases)
            if username.lower() in [n.lower() for n in all_names if n]:
                return {
                    "tier":          "exact",
                    "customer_id":   c.get("Customer ID", ""),
                    "match_score":   100,
                    "matched_to":    c.get("Primary Username", ""),
                    "enriched_data": _build_enriched_data(pdf_data, username, initials),
                }

    best_score, best_match = 0, None
    for c in existing_customers:
        score = _fuzzy_score(phone_fingerprint, initials, pdf_data, c, username)
        if score > best_score:
            best_score = score
            best_match = c

    enriched = _build_enriched_data(pdf_data, username, initials)

    if best_score >= SCORE_AUTO_LINK and best_match:
        return {
            "tier":          "possible_match",
            "customer_id":   "",
            "match_score":   best_score,
            "matched_to":    best_match.get("Primary Username", ""),
            "enriched_data": enriched,
        }
    else:
        return {
            "tier":          "new_customer",
            "customer_id":   "",
            "match_score":   best_score,
            "matched_to":    best_match.get("Primary Username", "") if best_match else "",
            "enriched_data": enriched,
        }


def _fuzzy_score(phone_fp, initials, pdf_data, customer, username):
    score = 0
    c_phone_fp = _phone_fingerprint(customer.get("Phone Partial", "") or customer.get("Phone Full", ""))
    score += int(_phone_fp_score(phone_fp, c_phone_fp) * 0.50)

    pdf_name = pdf_data.get("full_name", "")
    c_initials_str = customer.get("Initials (TT Format)", "")
    if pdf_name and c_initials_str:
        pdf_initials = _name_initials(pdf_name)
        c_initials   = [ch for ch in c_initials_str.upper() if ch.isalpha()]
        if pdf_initials and c_initials:
            matched = sum(1 for ci in c_initials if ci in pdf_initials)
            score += int((matched / max(len(c_initials), len(pdf_initials))) * 100 * 0.25)
    elif initials:
        c_initials_str2 = customer.get("Initials (TT Format)", "")
        c_initials2 = [ch for ch in c_initials_str2.upper() if ch.isalpha()]
        if c_initials2:
            matched = sum(1 for ci in c_initials2 if ci in initials)
            score += int((matched / max(len(c_initials2), len(initials))) * 100 * 0.25)

    incoming_zip = pdf_data.get("zip", "")
    c_zip = str(customer.get("ZIP", "")).strip()
    if incoming_zip and c_zip and incoming_zip == c_zip:
        score += 15

    incoming_city = pdf_data.get("city", "")
    c_city = str(customer.get("City", "")).strip()
    if incoming_city and c_city:
        score += int((fuzz.ratio(incoming_city.lower(), c_city.lower()) / 100) * 10)

    return min(score, 100)


def _phone_fingerprint(raw) -> dict:
    if not raw:
        return {}
    clean = re.sub(r"[^\d*]", "", str(raw))
    prefix_m = re.match(r"(\d+)\*", clean)
    suffix_m = re.search(r"\*(\d+)$", clean)
    if not prefix_m and not suffix_m:
        return {}
    return {
        "prefix": prefix_m.group(1) if prefix_m else "",
        "suffix": suffix_m.group(1) if suffix_m else "",
        "digits": (prefix_m.group(1) if prefix_m else "") + (suffix_m.group(1) if suffix_m else ""),
    }


def _phone_fp_score(fp1, fp2) -> int:
    if not fp1 or not fp2:
        return 0
    if fp1.get("prefix") == fp2.get("prefix") and fp1.get("suffix") == fp2.get("suffix"):
        return 100
    if fp1.get("suffix") and fp1.get("suffix") == fp2.get("suffix"):
        return 50
    if fp1.get("prefix") and fp1.get("prefix") == fp2.get("prefix"):
        return 40
    return 0


def _parse_initials(redacted: str) -> list:
    return re.findall(r"([A-ZAEIOUN])\*+", redacted)


def _name_initials(full_name: str) -> list:
    return [w[0].upper() for w in full_name.split() if w]


def _build_enriched_data(pdf_data: dict, username: str, initials: list = None) -> dict:
    name_parts = (pdf_data.get("full_name", "") or "").split()
    first   = name_parts[0] if name_parts else ""
    surname = " ".join(name_parts[1:]) if len(name_parts) > 1 else ""
    recipient_raw = pdf_data.get("recipient_raw", "")
    return {
        "Primary Username":      username or "",
        "First Name":            first,
        "Surname":               surname,
        "Street + Number":       pdf_data.get("street", ""),
        "City":                  pdf_data.get("city", ""),
        "State":                 pdf_data.get("state", ""),
        "ZIP":                   pdf_data.get("zip", ""),
        "Phone Partial":         pdf_data.get("phone_partial", ""),
        "Initials (TT Format)":  recipient_raw,
    }


# ─── Combined-orders CSV export ─────────────────────────────────────────
# Builds one CSV row per shipment, using the shipment's original raw CSV
# row (verbatim, all columns TikTok's export contains) as the base --
# never a hand-maintained field list, so it can't silently drop columns.
# The only field overwritten is "Order ID", which becomes all of that
# shipment's order IDs joined with " + " -- the same convention already
# used for the Orders sheet. Only intended to be called with an already-
# FILTERED shipments list (e.g. restricted to tracking IDs actually found
# in a given PDF batch) -- this function itself does no filtering.
def build_shipments_csv(shipments: list, fieldnames: list) -> bytes:
    out = io.StringIO()
    writer = csv.DictWriter(out, fieldnames=fieldnames, extrasaction="ignore")
    writer.writeheader()

    for s in shipments:
        raw_rows = s.get("raw_rows") or []
        base = dict(raw_rows[0]) if raw_rows else {}
        base["Order ID"] = " + ".join(s.get("order_ids", []))

        # Buyer Message is per-line-item, not shared across a shipment's
        # rows the way address/tracking fields are -- a message can land
        # on any one order within a combined shipment (whichever order
        # the buyer happened to type it on), not necessarily the first.
        # Collect every non-empty message across all raw rows instead of
        # trusting raw_rows[0], or a message on order 2 of 3 silently
        # vanishes.
        messages = []
        for rr in raw_rows:
            msg = (rr.get("Buyer Message") or "").strip()
            if msg and msg not in messages:
                messages.append(msg)
        base["Buyer Message"] = " + ".join(messages)

        writer.writerow(base)

    return out.getvalue().encode("utf-8-sig")
