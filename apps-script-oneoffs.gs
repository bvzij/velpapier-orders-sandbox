// ═══════════════════════════════════════════════════════════════════════════
// ONE-OFF SCRIPTS — fix-pack 2026-10-19
// ═══════════════════════════════════════════════════════════════════════════
//
// HOW TO USE
//   1. In the Apps Script editor: Files "+" -> Script -> name it "oneoffs".
//   2. Paste this whole file into it. It shares the main file's functions
//      and constants (Apps Script files share one global scope).
//   3. Run each function from the function dropdown IN THE ORDER BELOW.
//      Read the Execution log after each. Every function is READ-ONLY
//      unless its APPLY flag is set to true.
//   4. When finished, delete this file (house rule: one-offs don't stay).
//
// ORDER
//   a. oneoffSetIdColumnsText          (writes formats only, always safe)
//   b. oneoffCheckDuplicateOrderIds    (read-only)
//   c. oneoffAuditBackfillFuzzyLinks   (read-only; APPLY_UNLINK to fix)
//   d. oneoffBackfillOrderDates        (read-only; APPLY_ORDER_DATES to write)
//   e. installTriggers                 (in the MAIN file; schedules nightly jobs)
//   f. runAllTests                     (in the MAIN file; expect 0 failed)
// ═══════════════════════════════════════════════════════════════════════════

const APPLY_UNLINK = false;        // c: set true to blank Customer ID on flagged orders
const APPLY_ORDER_DATES = false;   // d: set true to write the Order Date column

// a. Plain-text format on every ID column, whole column, so new rows
//    inherit it. Prevents 18-digit IDs turning into numbers (FIX_LOG 0.3).
function oneoffSetIdColumnsText() {
  const targets = [
    [getQCSheet(), QC_ID_COLUMNS],
    [getOrdersSheet(), ['Order ID', 'Tracking ID', 'Linked Shipment']],
    [getTikTokImportHistorySheet(), TIKTOK_ID_COLUMNS],
  ];
  targets.forEach(([sheet, cols]) => {
    const h = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    cols.forEach(c => {
      const i = h.indexOf(c);
      if (i < 0) { Logger.log('skip (no column): ' + sheet.getName() + ' / ' + c); return; }
      sheet.getRange(2, i + 1, Math.max(sheet.getMaxRows() - 1, 1), 1).setNumberFormat('@');
      Logger.log('text format set: ' + sheet.getName() + ' / ' + c);
    });
  });
}

// b. Any TikTok order ID appearing in more than one Orders row.
//    (Unique IDs dropped 6,718 -> 6,715 on 18-10-2026 with no row change.)
function oneoffCheckDuplicateOrderIds() {
  const sheet = getOrdersSheet();
  const data = sheet.getDataRange().getValues();
  const h = data[0];
  const iId = h.indexOf('Order ID'), iTrk = h.indexOf('Tracking ID'), iCh = h.indexOf('Channel'), iSt = h.indexOf('Status');
  const seen = {}, blanks = [], numeric = [];
  data.slice(1).forEach((r, i) => {
    const row = i + 2;
    const cell = r[iId];
    if (typeof cell === 'number') numeric.push(row);
    const s = String(cell || '').trim();
    if (!s) { blanks.push(row); return; }
    s.split('+').map(x => x.trim()).filter(Boolean).forEach(id => {
      (seen[id] = seen[id] || []).push(row + ' [' + r[iTrk] + ' · ' + r[iCh] + ' · ' + r[iSt] + ']');
    });
  });
  const dups = Object.keys(seen).filter(k => seen[k].length > 1);
  Logger.log('Rows: ' + (data.length - 1) + ' | unique component IDs: ' + Object.keys(seen).length);
  Logger.log('Duplicated IDs: ' + dups.length);
  dups.slice(0, 50).forEach(id => Logger.log('  ' + id + ' -> rows ' + seen[id].join(' | ')));
  Logger.log('Blank Order ID rows: ' + blanks.length + (blanks.length ? ' -> ' + blanks.slice(0, 50).join(', ') : ''));
  Logger.log('Order ID stored as NUMBER (digits lost): ' + numeric.length + (numeric.length ? ' -> ' + numeric.slice(0, 50).join(', ') : ''));
}

// c. Orders created by the 18-10-2026 backfill whose customer was matched
//    by the crude fuzzy tier (FIX_LOG 0.1). Compares the order's username
//    with the linked customer's Primary Username + Aliases.
function oneoffAuditBackfillFuzzyLinks() {
  const auditSs = SpreadsheetApp.openById(AUDIT_LOG_SHEET_ID);
  const created = [];   // { orderIdCell, customerId }
  auditSs.getSheets().filter(sh => /^Log \d{4}$/.test(sh.getName())).forEach(sh => {
    const d = sh.getDataRange().getValues();
    const h = d[0];
    const iA = h.indexOf('Action'), iR = h.indexOf('Record ID'), iD = h.indexOf('Details');
    d.slice(1).forEach(r => {
      if (r[iA] !== 'backfill_create_order') return;
      let det = {}; try { det = JSON.parse(r[iD] || '{}'); } catch (e) {}
      created.push({ orderIdCell: String(r[iR] || ''), customerId: String(det.customer_id || ''), tracking: det.tracking_id || '' });
    });
  });
  Logger.log('backfill_create_order entries: ' + created.length);

  const customers = {};
  sheetToObjects(getCustomersSheet()).forEach(c => { customers[String(c['Customer ID'])] = c; });
  const orders = getOrdersSheet();
  const oh = orders.getRange(1, 1, 1, orders.getLastColumn()).getValues()[0];
  const iTrk = oh.indexOf('Tracking ID'), iCust = oh.indexOf('Customer ID'), iUser = oh.indexOf('Primary Username');
  const trkVals = readColumn(orders, iTrk), custVals = readColumn(orders, iCust), userVals = readColumn(orders, iUser);

  const flagged = [];
  created.forEach(c => {
    const i = trkVals.findIndex(t => String(t) === String(c.tracking));
    if (i < 0 || !custVals[i]) return;
    const cust = customers[String(custVals[i])];
    if (!cust) return;
    const orderUser = normalizeUsername(userVals[i]);
    const names = [normalizeUsername(cust['Primary Username'])]
      .concat(String(cust['Aliases'] || '').split(',').map(a => normalizeUsername(a.trim())))
      .filter(Boolean);
    if (orderUser && names.indexOf(orderUser) < 0) {
      flagged.push({ row: i, tracking: c.tracking, orderUser: userVals[i], customer: custVals[i], customerUser: cust['Primary Username'] });
    }
  });

  Logger.log('Fuzzy-linked orders found: ' + flagged.length);
  flagged.forEach(f => Logger.log('  ' + f.tracking + ': order user "' + f.orderUser + '" linked to ' + f.customer + ' ("' + f.customerUser + '")'));

  if (APPLY_UNLINK && flagged.length) {
    flagged.forEach(f => { custVals[f.row] = ''; });
    writeColumnChanges(orders, iCust, custVals, flagged.map(f => f.row));
    _currentIdentity = { name: 'Sistema (one-off)', role: 'admin' };
    flagged.forEach(f => logAudit('oneoff_unlink_fuzzy', 'Order', f.tracking, 'Customer ID', f.customer, ''));
    flushAudit();
    Logger.log('Unlinked ' + flagged.length + ' orders. Re-link them from Pedidos.');
  }
}

// d. Fill the new 'Order Date' column for existing rows (FIX_LOG 2.1).
//    TikTok rows: earliest Created Time of any component order in History.
//    Other channels: copy Created Date (Shopify arrives in real time).
//    Only blank Order Date cells are filled.
function oneoffBackfillOrderDates() {
  const orders = getOrdersSheet();
  ensureHeader(orders, 'Order Date');
  const oh = orders.getRange(1, 1, 1, orders.getLastColumn()).getValues()[0];
  const iOD = oh.indexOf('Order Date'), iId = oh.indexOf('Order ID'), iCh = oh.indexOf('Channel'), iCD = oh.indexOf('Created Date');

  const hist = getTikTokImportHistorySheet();
  const hd = hist.getDataRange().getValues();
  const hh = hd[0];
  const iHO = hh.indexOf('Order ID'), iHC = hh.indexOf('Created Time');
  const rawTimes = hd.slice(1).map(r => r[iHC]);
  const dayFirst = detectDayFirst(rawTimes);
  Logger.log('History Created Time sample: "' + rawTimes.find(Boolean) + '" -> dayFirst=' + dayFirst);

  const earliest = {};
  hd.slice(1).forEach(r => {
    const oid = String(r[iHO] || '').replace(/\D/g, '');
    const d = parseTikTokDateTime(r[iHC], dayFirst);
    if (oid && d && (!earliest[oid] || d.getTime() < earliest[oid])) earliest[oid] = d.getTime();
  });

  const odVals = readColumn(orders, iOD), idVals = readColumn(orders, iId), chVals = readColumn(orders, iCh), cdVals = readColumn(orders, iCD);
  const changed = [];
  let tiktokFilled = 0, otherFilled = 0, unresolved = 0;

  // The 18-10-2026 backfill wrote raw TikTok text into Created Date. Any
  // Created Date that is a non-ISO string gets converted to ISO.
  const cdChanged = [];
  cdVals.forEach((v, i) => {
    if (!v || v instanceof Date) return;
    const s = String(v);
    if (/^\d{4}-\d{2}-\d{2}T/.test(s)) return;
    const d = parseTikTokDateTime(s, dayFirst);
    if (d) { cdVals[i] = d.toISOString(); cdChanged.push(i); }
  });
  Logger.log('Created Date cells with raw text to normalize: ' + cdChanged.length);

  idVals.forEach((cell, i) => {
    if (odVals[i]) return;
    if (chVals[i] === 'TikTok') {
      let best = 0;
      String(cell || '').split('+').map(x => x.replace(/\D/g, '')).filter(Boolean).forEach(oid => {
        if (earliest[oid] && (!best || earliest[oid] < best)) best = earliest[oid];
      });
      if (best) { odVals[i] = new Date(best).toISOString(); changed.push(i); tiktokFilled++; }
      else unresolved++;
    } else if (cdVals[i]) {
      const d = cdVals[i] instanceof Date ? cdVals[i] : new Date(cdVals[i]);
      if (!isNaN(d.getTime())) { odVals[i] = d.toISOString(); changed.push(i); otherFilled++; }
    }
  });
  Logger.log('Would fill: TikTok ' + tiktokFilled + ', other channels ' + otherFilled + ', TikTok rows with no History match ' + unresolved);
  if (APPLY_ORDER_DATES && (changed.length || cdChanged.length)) {
    writeColumnChanges(orders, iOD, odVals, changed);
    writeColumnChanges(orders, iCD, cdVals, cdChanged);
    Logger.log('Order Date written for ' + changed.length + ' rows; Created Date normalized for ' + cdChanged.length + '.');
  } else if (!APPLY_ORDER_DATES) {
    Logger.log('Dry run. Set APPLY_ORDER_DATES = true and run again to write.');
  }
}
