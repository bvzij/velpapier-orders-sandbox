// ═══════════════════════════════════════════════════════════════════════════
// CONFIG
// ═══════════════════════════════════════════════════════════════════════════
// 15-10 MAKING MAJOR CHANGES BY ADDING A AUDIT SHEET

const ORDERS_SHEET_ID = '1ghfPmDU6NvOWhzAdyqMcXap2DH3_j47tv5kTCwh4BTg';
const CUSTOMERS_SHEET_ID = '1lM9RjWq4vvcmXTUwJmi0IbS2tQw31CzjnWsFmMON7ak';
const QC_SHEET_ID = '1HFzeXHMOxQ3dNb8g4wvU1bp-psGlWMZUlXO0tQYWFxc';
const AUDIT_LOG_SHEET_ID = '1J7dMUqj_uj_D24YgR5avCmSTdcbFCUmpU2YpO4uRGwU';

const SCRIPT_VERSION = '2026-10-15.10';

const BACKUP_FOLDER_ID = '1wxkTAqFlGlOc-qMGBv24nQswW7IyYMoL';

// ═══════════════════════════════════════════════════════════════════════════
// SHARED HELPERS — sheet accessors, utilities, ID generation
// ═══════════════════════════════════════════════════════════════════════════

// ─── Sheet accessors ───────────────────────────────────────────────────────────

function getOrdersSheet() {
  return SpreadsheetApp.openById(ORDERS_SHEET_ID).getSheetByName('Orders');
}

// Finds the current year's log tab ("Log 2026", "Log 2027", ...) by name.
// When a new year starts, create the next tab with the same header row --
// nothing in the code needs to change. If that tab doesn't exist yet
// (e.g. right at midnight on Jan 1 before anyone's made it), falls back to
// the most recent "Log <year>" tab that does exist, so logging never hard
// fails for a missing tab -- it just lands in last year's until the new
// one is created.
function getAuditLogSheet() {
  const ss = SpreadsheetApp.openById(AUDIT_LOG_SHEET_ID);
  const year = Utilities.formatDate(new Date(), 'America/Mexico_City', 'yyyy');
  const current = ss.getSheetByName('Log ' + year);
  if (current) return current;

  const fallback = ss.getSheets()
    .filter(sh => /^Log \d{4}$/.test(sh.getName()))
    .sort((a, b) => b.getName().localeCompare(a.getName()))[0];
  return fallback || null;
}

function getShopifyMatchesSheet() {
  return SpreadsheetApp.openById(CUSTOMERS_SHEET_ID).getSheetByName('Shopify Customer Matches');
}

function getCustomersSheet() {
  return SpreadsheetApp.openById(CUSTOMERS_SHEET_ID).getSheetByName('Customers');
}

function getQCSheet() {
  const ss = SpreadsheetApp.openById(QC_SHEET_ID);

  // Fast path: the tab name found last time (cached), as long as it still exists.
  const cache = CacheService.getScriptCache();
  const cachedName = cache.get('qc_sheet_name');
  if (cachedName) {
    const cached = ss.getSheetByName(cachedName);
    if (cached) return cached;
  }

  // This used to be "the first tab", so dragging the Sessions tab to the
  // front would have silently sent every QC record into the Sessions sheet.
  // Identify the QC tab by its header row instead.
  const sheets = ss.getSheets();
  for (let i = 0; i < sheets.length; i++) {
    const sh = sheets[i];
    if (sh.getName() === 'Sessions' || sh.getLastColumn() < 2) continue;
    const h = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
    if (h.indexOf('QC ID') >= 0 && h.indexOf('Tracking ID') >= 0) {
      cache.put('qc_sheet_name', sh.getName(), 21600);
      return sh;
    }
  }
  return sheets[0];   // legacy fallback, same as before
}

// ─── Utilities ─────────────────────────────────────────────────────────────────

function generateUUID() {
  return Utilities.getUuid();
}

function nowISO() {
  return new Date().toISOString();
}

function sheetToObjects(sheet) {
  const data = sheet.getDataRange().getValues();
  if (data.length < 2) return [];
  const headers = data[0];
  return data.slice(1).map((row, i) => {
    const obj = { _rowIndex: i + 2 };
    headers.forEach((h, j) => { obj[h] = row[j]; });
    return obj;
  });
}

function findOrderRow(sheet, orderID) {
  const idColumn = sheet.getRange('A:A');
  const finder = idColumn.createTextFinder(orderID).matchEntireCell(true);
  const found = finder.findNext();
  if (!found) return null;
  return found.getRow();
}

// String.fromCharCode(65 + n) silently produces garbage past column Z
// (index 26 -> '['). The QC sheet is already wide enough for this to
// matter if a column is ever inserted.
function colLetter(index) {
  let n = index + 1, out = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

function jsonResponse(data, status) {
  const output = ContentService.createTextOutput(JSON.stringify(data));
  output.setMimeType(ContentService.MimeType.JSON);
  return output;
}

// ─── Customer ID generator ─────────────────────────────────────────────────────

// Appends one Customers row built BY HEADER NAME, and forces the
// identifier columns to plain text first so Sheets cannot re-parse a long
// Shopify ID into scientific notation or strip the leading zero off a
// CDMX postcode (every ZIP in Mexico City starts with 0).
const CUSTOMER_ID_COLUMNS = ['Customer ID', 'Shopify Customer ID', 'ZIP', 'Phone Partial', 'Phone Full'];

// Writes one customer cell. Identifier-like fields (ZIP, phones, Shopify ID)
// are forced to plain text FIRST: a plain setValue() on a General-format cell
// makes Sheets re-parse '01000' as the number 1000, silently stripping the
// leading zero from every CDMX postcode.
function setCustomerCell(sheet, row1, col1, fieldName, value) {
  const rg = sheet.getRange(row1, col1);
  if (CUSTOMER_ID_COLUMNS.indexOf(fieldName) >= 0) rg.setNumberFormat('@');
  rg.setValue(value);
}

function appendCustomerRowByHeader(sheet, fieldValues) {
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const row = headers.map(h => (fieldValues[h] !== undefined ? fieldValues[h] : ''));
  const startRow = sheet.getLastRow() + 1;
  forceTextFormat(sheet, headers, CUSTOMER_ID_COLUMNS, startRow, 1);
  sheet.getRange(startRow, 1, 1, row.length).setValues([row]);
  return startRow;
}

// One shared rule for "what do we call this customer on screen".
// Falls back through username -> real name -> email, so a Shopify-created
// customer with no TikTok username is never rendered as nameless.
function customerDisplayName(customerId) {
  if (!customerId) return '';
  const cust = sheetToObjects(getCustomersSheet())
    .find(c => String(c['Customer ID']) === String(customerId));
  if (!cust) return '';
  const uname = String(cust['Primary Username'] || '').trim();
  if (uname) return uname;
  const full = [cust['First Name'], cust['Surname']]
    .map(v => String(v || '').trim()).filter(Boolean).join(' ');
  if (full) return full;
  return String(cust['Email'] || '').trim();
}

function generateCustomerID(sheet) {
  const data = sheet.getDataRange().getValues();
  if (data.length < 2) return 'CUST-001';
  // Was hardcoded to column A; now located by header so reordering the
  // Customers sheet cannot make this silently generate 'CUST-001' forever.
  const idCol = Math.max(0, (data[0] || []).indexOf('Customer ID'));
  const ids = data.slice(1)
    .map(r => r[idCol])
    .filter(id => typeof id === 'string' && id.startsWith('CUST-'))
    .map(id => parseInt(id.replace('CUST-', ''), 10))
    .filter(n => !isNaN(n));
  const max = ids.length > 0 ? Math.max(...ids) : 0;
  return 'CUST-' + String(max + 1).padStart(3, '0');
}

// ─── Identity resolution ───────────────────────────────────────────────────────

function normalizeUsername(username) {
  if (!username) return '';
  return String(username)
    .toLowerCase()
    .replace(/^@/, '')
    .replace(/^tiktok\.com\/@?/, '')
    .replace(/\s*\(.*?\)\s*/g, '')
    .trim();
}

function findCustomerByUsername(customers, rawUsername) {
  const normalized = normalizeUsername(rawUsername);
  if (!normalized) return null;

  // Records that have been merged into another customer must never be
  // matched again -- their Primary Username is intentionally stale
  // (e.g. "chinosss16 (merged→CUST-775)") and would otherwise cause the
  // fuzzy-match tier to false-positive against the loser record itself.
  customers = customers.filter(c => !String(c['Primary Username'] || '').includes('(merged→'));

  let match = customers.find(c =>
    normalizeUsername(c['Primary Username']) === normalized
  );
  if (match) return { customer: match, confidence: 'exact' };

  match = customers.find(c => {
    const aliases = (c['Aliases'] || '').split(',').map(a => normalizeUsername(a.trim()));
    return aliases.includes(normalized);
  });
  if (match) return { customer: match, confidence: 'alias' };

  match = customers.find(c => {
    const primary = normalizeUsername(c['Primary Username']);
    const aliases = (c['Aliases'] || '').split(',').map(a => normalizeUsername(a.trim()));
    const all = [primary, ...aliases].filter(Boolean);
    return all.some(name =>
      (name.length > 4 && normalized.startsWith(name.substring(0, name.length - 1))) ||
      (normalized.length > 4 && name.startsWith(normalized.substring(0, normalized.length - 1)))
    );
  });
  if (match) return { customer: match, confidence: 'fuzzy' };

  return null;
}

// ═══════════════════════════════════════════════════════════════════════════
// API ROUTER — GET / POST entry points
// ═══════════════════════════════════════════════════════════════════════════

// ─── GET handler ───────────────────────────────────────────────────────────────

function doGet(e) {
  try {
    const action = e.parameter.action || 'orders';

    // 'ping' is what the frontend's ensureToken() uses to validate a saved
    // token. It previously answered OK *before* the auth check, so ANY
    // token -- wrong, blank, or rotated -- passed validation and the user
    // was never re-prompted. It must be authenticated like everything else.
    if (action === 'version') return jsonResponse({ version: SCRIPT_VERSION });
    const role = getRole(e.parameter.token);
    if (!role) return jsonResponse({ error: 'unauthorized' });
    if (action === 'ping') return jsonResponse({ ok: true, role: role });
    if (action === 'whoami') return jsonResponse({ role: role });
    if (action === 'shopify_matches') return getShopifyMatches(e);
    if (action === 'shopify_matches_review') return getShopifyMatchesReview(e);
    if (action === 'get_upload_signature') return getUploadSignature(e);
    if (action === 'qc') return getQC(e);
    if (action === 'active_session') return getActiveSession(e);
    if (action === 'sessions') return getSessions(e);

    // Ajustes-only tools -- duplicate finders/mergers, product merge
    // search/history. Staff role is a valid token but not allowed here.
    if (action === 'find_duplicate_customers') return requireAdmin(role) ? findDuplicateCustomers(e) : jsonResponse({ error: 'unauthorized' });
    if (action === 'find_duplicate_products') return requireAdmin(role) ? findDuplicateProducts(e) : jsonResponse({ error: 'unauthorized' });
    if (action === 'search_products_for_merge') return requireAdmin(role) ? searchProductsForMerge(e) : jsonResponse({ error: 'unauthorized' });
    if (action === 'manual_product_pair') return requireAdmin(role) ? getManualProductPair(e) : jsonResponse({ error: 'unauthorized' });
    if (action === 'product_merge_history') return requireAdmin(role) ? getProductMergeHistory(e) : jsonResponse({ error: 'unauthorized' });
    if (action === 'merge_history') return requireAdmin(role) ? getMergeHistory(e) : jsonResponse({ error: 'unauthorized' });
    if (action === 'get_roles') return requireAdmin(role) ? getRolesAction(e) : jsonResponse({ error: 'unauthorized' });

    if (action === 'orders') {
      const sheet = getOrdersSheet();
      const data = sheet.getDataRange().getValues();
      if (data.length < 2) return jsonResponse({ records: [] });

            const headers = data[0];
      const statusCol = headers.indexOf('Status');
      const channelCol = headers.indexOf('Channel');
      const customerIdCol = headers.indexOf('Customer ID');
      const createdCol = headers.indexOf('Created Date');

      const statusFilter = e.parameter.status
        ? e.parameter.status.split(',').map(s => s.trim()).filter(Boolean)
        : null;
      const channelFilter = e.parameter.channel || null;
      const customerIdFilter = e.parameter.customer_id || null;

      // Optional fast-path: ?days=30 only returns orders created in the
      // last N days, server-side, so a slim payload can render instantly.
      // Omit entirely (no 'days' param) to get full history, unfiltered,
      // same as before this change.
      const daysFilter = e.parameter.days ? parseInt(e.parameter.days, 10) : null;
      const cutoff = daysFilter ? new Date(Date.now() - daysFilter * 86400000) : null;

      const records = [];
      for (let i = 1; i < data.length; i++) {
        const row = data[i];
        if (statusFilter && !statusFilter.includes(row[statusCol])) continue;
        if (channelFilter && row[channelCol] !== channelFilter) continue;
        if (customerIdFilter && row[customerIdCol] !== customerIdFilter) continue;
        if (cutoff) {
          const cd = row[createdCol] ? new Date(row[createdCol]) : null;
          if (!cd || cd < cutoff) continue;
        }

        const obj = { _rowIndex: i + 1 };
        headers.forEach((h, j) => { obj[h] = row[j]; });
        records.push(obj);
      }

      return jsonResponse({ records: records });
    }

    if (action === 'customers') {
      const sheet = getCustomersSheet();
      const customers = sheetToObjects(sheet);

      if (e.parameter.customer_id) {
        const found = customers.find(c => c['Customer ID'] === e.parameter.customer_id);
        return jsonResponse(found || null);
      }

      if (e.parameter.username) {
        const result = findCustomerByUsername(customers, e.parameter.username);
        return jsonResponse(result || null);
      }

      const visibleCustomers = customers.filter(c => !String(c['Primary Username'] || '').includes('(merged→'));
      return jsonResponse({ records: visibleCustomers });
    }

    return jsonResponse({ error: 'Unknown action' });

  } catch (err) {
    return jsonResponse({ error: err.message });
  }
}

// ─── POST handler ──────────────────────────────────────────────────────────────

// Every POST action mutates a sheet. Several of them (QC finalize, the
// merge/undo actions, the importers) read a whole sheet, change a few
// rows in memory, then write the WHOLE sheet back -- so two overlapping
// requests could silently discard each other's work ("last writer wins").
// The ID generators (CUST-/VAR-/PARENT-/QC-) are "max + 1" scans with the
// same race. Serialising all writes behind one script lock removes both
// problems without restructuring the individual functions.
// 30s is deliberately longer than any single action should take; if it
// is ever exceeded the caller gets a clean, explicit "busy" error rather
// than a half-applied write.
function withWriteLock(fn) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) {
    return jsonResponse({ error: 'Servidor ocupado, intenta de nuevo en unos segundos.' });
  }
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// AUDIT LOG — who changed what, when
// ═══════════════════════════════════════════════════════════════════════════
//
// Phase 1. Two ways to log:
//   logAudit(action, recordType, recordId, field, before, after) -- one
//     field changed. Used inside update-style actions.
//   logAuditEvent(action, recordType, recordId, details) -- something
//     happened with no single before/after to show (a create, a delete
//     snapshot, an import summary). `details` is a plain object, stored
//     as JSON in the Details column.
//
// Both just push an in-memory row; nothing touches the sheet until
// flushAudit() runs. doPost calls flushAudit() once, after the action
// has already returned its result, so a slow or failed log write can
// never block or break the real operation, and the dashboard write
// itself never waits on a cross-spreadsheet call mid-request.
//
// _currentIdentity is set once per request by doPost (see above) and
// read here rather than threaded as a parameter through every one of
// the ~20 mutation functions -- each Apps Script execution handles
// exactly one request, so this is safe.
let _currentIdentity = null;
let _auditBuffer = [];

function logAudit(action, recordType, recordId, field, before, after) {
  _auditBuffer.push({
    action: action, recordType: recordType, recordId: recordId,
    field: field, before: before, after: after, details: null,
  });
}

function logAuditEvent(action, recordType, recordId, details, redoOf) {
  _auditBuffer.push({
    action: action, recordType: recordType, recordId: recordId,
    field: '', before: '', after: '', details: details || null,
    redoOf: redoOf || '',
  });
}

// Writes every buffered entry in ONE setValues() call, so an action that
// changes several fields (or an import logging per-order) costs the
// audit log exactly one extra write, not one per field. Wrapped so a
// failure here (sheet renamed, tab missing, quota) is logged and
// swallowed -- it must never surface as an error on the real operation
// that already succeeded.
function flushAudit() {
  if (!_auditBuffer.length) return;
  const entries = _auditBuffer;
  _auditBuffer = [];
  const identity = _currentIdentity;

  try {
    const sheet = getAuditLogSheet();
    if (!sheet) {
      Logger.log('flushAudit: no "Log <year>" tab found, ' + entries.length + ' entries dropped');
      return;
    }
    const ts = nowISO();
    const person = identity ? identity.name : 'Desconocido';
    const role = identity ? identity.role : '';
    const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];

    // Written by header name, not fixed position -- same convention as
    // the rest of this file -- so this still lands correctly even if
    // someone reorders or inserts a column on the Log sheet later.
    const rows = entries.map(en => {
      const byHeader = {
        'Audit ID': 'LOG-' + Utilities.getUuid().slice(0, 8),
        'Timestamp': ts,
        'Person': person,
        'Role': role,
        'Action': en.action,
        'Record Type': en.recordType,
        'Record ID': en.recordId,
        'Field': en.field,
        'Before': en.before === undefined || en.before === null ? '' : String(en.before),
        'After': en.after === undefined || en.after === null ? '' : String(en.after),
        'Details': en.details ? JSON.stringify(en.details) : '',
        'Undone': '',
        'Redo Of': en.redoOf || '',
      };
      return headers.map(h => (byHeader[h] !== undefined ? byHeader[h] : ''));
    });
    sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, rows[0].length).setValues(rows);
  } catch (err) {
    Logger.log('flushAudit failed: ' + err.message + ' -- ' + entries.length + ' entries dropped');
  }
}

// ─── Undo / redo (one slot per person, diff-style actions only) ───────────
//
// Only these action types are reversible: each is a single field change
// with a real before/after already captured by logAudit(). Event-style
// actions (deletes, merges, imports, photos) are NOT in this list --
// deletes already have their own explicit, deliberate button (the
// failsafe), and the others have no single-field reversal that's safe to
// automate. "Last action" is scoped to the calling person's own rows only
// -- _currentIdentity.name, never anyone else's.
const UNDOABLE_ACTIONS = ['update_order_status', 'update_order', 'add_alias', 'update_packed_date', 'save_qc'];

function getAuditSheetCols(sheet) {
  const h = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  return {
    id: h.indexOf('Audit ID'), ts: h.indexOf('Timestamp'), person: h.indexOf('Person'),
    action: h.indexOf('Action'), recordType: h.indexOf('Record Type'), recordId: h.indexOf('Record ID'),
    field: h.indexOf('Field'), before: h.indexOf('Before'), after: h.indexOf('After'),
    undone: h.indexOf('Undone'), redoOf: h.indexOf('Redo Of'),
  };
}

// Writes `value` into `field` on the sheet/row that owns `recordType` +
// `recordId`. One switch, shared by both undo (writes Before) and redo
// (writes After) -- same routing either direction.
function writeFieldForRecord(recordType, recordId, field, value) {
  if (recordType === 'Order') {
    const sheet = getOrdersSheet();
    const rowIndex = findOrderRow(sheet, recordId);
    if (!rowIndex) return false;
    const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    const col = headers.indexOf(field) + 1;
    if (col <= 0) return false;
    sheet.getRange(rowIndex, col).setValue(value);
    if (field === 'Status') applyStatusSideEffects(sheet, rowIndex, value, headers);
    return true;
  }
  if (recordType === 'Customer') {
    const sheet = getCustomersSheet();
    const customers = sheetToObjects(sheet);
    const customer = customers.find(c => c['Customer ID'] === recordId);
    if (!customer) return false;
    const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    const col = headers.indexOf(field) + 1;
    if (col <= 0) return false;
    sheet.getRange(customer._rowIndex, col).setValue(value);
    return true;
  }
  if (recordType === 'QC') {
    const sheet = getQCSheet();
    const row = findRowByColumn(sheet, 'A', recordId);
    if (!row) return false;
    const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    const col = headers.indexOf(field) + 1;
    if (col <= 0) return false;
    sheet.getRange(row, col).setValue(value);
    return true;
  }
  return false;
}

function undoLastActionAction(body) {
  const identity = _currentIdentity;
  if (!identity) return jsonResponse({ error: 'unauthorized' });

  const sheet = getAuditLogSheet();
  if (!sheet) return jsonResponse({ error: 'No se encontró la hoja de registro.' });
  const data = sheet.getDataRange().getValues();
  const C = getAuditSheetCols(sheet);

  // Most recent (bottom-most) row by this person, of an undoable action
  // type, not already undone.
  let target = -1;
  for (let i = data.length - 1; i >= 1; i--) {
    const row = data[i];
    if (row[C.person] !== identity.name) continue;
    if (UNDOABLE_ACTIONS.indexOf(row[C.action]) === -1) continue;
    if (row[C.undone]) continue;
    target = i;
    break;
  }
  if (target === -1) return jsonResponse({ error: 'No hay nada que deshacer.' });

  const row = data[target];
  const ok = writeFieldForRecord(row[C.recordType], row[C.recordId], row[C.field], row[C.before]);
  if (!ok) return jsonResponse({ error: 'No se pudo deshacer: el registro ya no existe.' });

  sheet.getRange(target + 1, C.undone + 1).setValue(nowISO());
  logAuditEvent('undo_last_action', row[C.recordType], row[C.recordId], {
    undone_audit_id: row[C.id], field: row[C.field], restored_value: row[C.before],
  });

  return jsonResponse({
    result: 'undone', record_type: row[C.recordType], record_id: row[C.recordId],
    field: row[C.field], restored_value: row[C.before],
  });
}

function redoLastActionAction(body) {
  const identity = _currentIdentity;
  if (!identity) return jsonResponse({ error: 'unauthorized' });

  const sheet = getAuditLogSheet();
  if (!sheet) return jsonResponse({ error: 'No se encontró la hoja de registro.' });
  const data = sheet.getDataRange().getValues();
  const C = getAuditSheetCols(sheet);

  // Most recent row this person undid that hasn't already been redone.
  // "Already redone" = a later log row whose Redo Of points at it.
  const undoneIds = new Set();
  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    if (row[C.person] === identity.name && row[C.redoOf]) undoneIds.add(String(row[C.redoOf]));
  }

  let target = -1;
  for (let i = data.length - 1; i >= 1; i--) {
    const row = data[i];
    if (row[C.person] !== identity.name) continue;
    if (!row[C.undone]) continue;
    if (undoneIds.has(String(row[C.id]))) continue; // already redone once
    target = i;
    break;
  }
  if (target === -1) return jsonResponse({ error: 'No hay nada que rehacer.' });

  const row = data[target];
  const ok = writeFieldForRecord(row[C.recordType], row[C.recordId], row[C.field], row[C.after]);
  if (!ok) return jsonResponse({ error: 'No se pudo rehacer: el registro ya no existe.' });

  logAuditEvent('redo_last_action', row[C.recordType], row[C.recordId], {
    redo_of_audit_id: row[C.id], field: row[C.field], restored_value: row[C.after],
  }, row[C.id]);

  return jsonResponse({
    result: 'redone', record_type: row[C.recordType], record_id: row[C.recordId],
    field: row[C.field], restored_value: row[C.after],
  });
}

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    const action = body.action;
    const identity = getIdentity(body.token);
    if (!identity) return jsonResponse({ error: 'unauthorized' });
    const role = identity.role;
    _currentIdentity = identity; // read by logAudit() -- see audit log section
    return withWriteLock(function () {
      const result = dispatchPostAction(action, body, role);
      flushAudit(); // after the real write already succeeded -- never blocks it
      return result;
    });

  } catch (err) {
    return jsonResponse({ error: err.message });
  }
}

function dispatchPostAction(action, body, role) {
    if (action === 'create_order') return createOrder(body);
    if (action === 'create_customer') return createCustomer(body);
    if (action === 'update_order_status') return updateOrderStatus(body);
    if (action === 'add_alias') return addAlias(body);
    if (action === 'update_packed_date') return updatePackedDate(body);
    if (action === 'stamp_customer_ids') { stampCustomerIDs(); return jsonResponse({ result: 'done' }); }
    if (action === 'update_order') return updateOrder(body);
    if (action === 'delete_order') return deleteOrder(body);
    if (action === 'import_tiktok_orders') return importTikTokOrders(body);
    if (action === 'import_shopify_order') return importShopifyOrder(body);
    if (action === 'create_customers_bulk') return createCustomersBulk(body);
    if (action === 'save_qc') return saveQC(body);
    if (action === 'start_session') return startSession(body);
    if (action === 'end_session') return endSession(body);
    if (action === 'update_session_participants') return updateSessionParticipants(body);
    if (action === 'resolve_shopify_match') return resolveShopifyMatchAction(body);
    if (action === 'resolve_shopify_matches_bulk') return resolveShopifyMatchesBulk(body);

    // Ajustes-only tools -- same admin-only boundary as the GET side above.
    if (action === 'merge_customers') return requireAdmin(role) ? mergeCustomersAction(body) : jsonResponse({ error: 'unauthorized' });
    if (action === 'dismiss_duplicate_pair') return requireAdmin(role) ? dismissDuplicatePairAction(body) : jsonResponse({ error: 'unauthorized' });
    if (action === 'undo_merge') return requireAdmin(role) ? undoMergeAction(body) : jsonResponse({ error: 'unauthorized' });
    if (action === 'delete_merged_customer') return requireAdmin(role) ? deleteMergedCustomerAction(body) : jsonResponse({ error: 'unauthorized' });
    if (action === 'dismiss_product_pair') return requireAdmin(role) ? dismissProductPairAction(body) : jsonResponse({ error: 'unauthorized' });
    if (action === 'merge_products') return requireAdmin(role) ? mergeProductsAction(body) : jsonResponse({ error: 'unauthorized' });
    if (action === 'undo_product_merge') return requireAdmin(role) ? undoProductMergeAction(body) : jsonResponse({ error: 'unauthorized' });
    if (action === 'backfill_tiktok_preview') return requireAdmin(role) ? backfillTikTokHistoryPreview(body) : jsonResponse({ error: 'unauthorized' });
    if (action === 'backfill_tiktok_commit') return requireAdmin(role) ? backfillTikTokHistoryCommit(body) : jsonResponse({ error: 'unauthorized' });
    if (action === 'update_role_password') return requireAdmin(role) ? updateRolePasswordAction(body) : jsonResponse({ error: 'unauthorized' });
    if (action === 'undo_last_action') return undoLastActionAction(body);
    if (action === 'redo_last_action') return redoLastActionAction(body);

    return jsonResponse({ error: 'Unknown action' });
}

// ═══════════════════════════════════════════════════════════════════════════
// ORDERS + CUSTOMERS — core CRUD, status changes, shipment counts
// ═══════════════════════════════════════════════════════════════════════════

// ─── Create order ──────────────────────────────────────────────────────────────

function createOrder(body) {
  const ordersSheet = getOrdersSheet();
  const customersSheet = getCustomersSheet();

  if (body.channel === 'TikTok' && body.tracking_id) {
    const existing = sheetToObjects(ordersSheet);
    const dup = existing.find(o => o['Tracking ID'] === body.tracking_id);
    if (dup) {
      const sameOrderID = dup['Order ID'] === body.order_id;
      return jsonResponse({
        result: 'duplicate',
        certain: sameOrderID,
        message: sameOrderID
          ? 'Exact duplicate — same Tracking ID and Order ID already in sheet.'
          : 'Tracking ID exists but Order ID differs — possible system error. Not imported.',
        existing_row: dup
      });
    }
  }

  const customers = sheetToObjects(customersSheet);
  const resolution = findCustomerByUsername(customers, body.username);
  let customerID = '';
  let primaryUsername = body.username || '';
  let mergeFlag = false;

  // A 'fuzzy' hit is a GUESS (prefix-minus-one-character), e.g. existing
  // "maria" captures incoming "mariana.art". Writing that guess into the
  // order's Customer ID silently attaches one person's order to another
  // person's record. Only exact/alias matches are trusted here; a fuzzy
  // hit is returned as a suggestion for the UI to confirm, and the order
  // is left unlinked so it shows up in the normal review flow.
  let fuzzySuggestion = null;
  if (resolution && resolution.confidence !== 'fuzzy') {
    customerID = resolution.customer['Customer ID'];
    primaryUsername = resolution.customer['Primary Username'];
  } else if (resolution && resolution.confidence === 'fuzzy') {
    mergeFlag = true;
    fuzzySuggestion = {
      customer_id: resolution.customer['Customer ID'],
      primary_username: resolution.customer['Primary Username'],
    };
  }

    let status = body.status || 'No Pagado';
  if (body.channel === 'TikTok') status = 'Pagado';

  const orderID = body.order_id || generateUUID();

  // Built by header name, not fixed position -- a fixed positional array
  // silently shifts every value into the wrong column the moment the sheet
  // gains, loses, or reorders a column (same bug already found and fixed
  // in createCustomer/createCustomersBulk; this function had the same
  // issue and just hadn't been hit yet).
  const oh = ordersSheet.getRange(1, 1, 1, ordersSheet.getLastColumn()).getValues()[0];
  const fieldValues = {
    'Order ID': orderID,
    'Tracking ID': body.tracking_id || '',
    'Customer ID': customerID,
    'Primary Username': primaryUsername,
    'Channel': body.channel || 'Manual',
    'Status': status,
    'Products': body.products || '',
    'Price': body.price || 0,
    'Shopify Order ID': body.shopify_order_id || '',
    'Notes': body.notes || '',
    'Created Date': nowISO(),
    'Packed Date': '',
    'Shipped Date': '',
    'Archive Date': '',
    'Linked Shipment': body.linked_shipment || '',
  };

  const row = oh.map(h => (fieldValues[h] !== undefined ? fieldValues[h] : ''));
  const newRowNum = ordersSheet.getLastRow() + 1;
  forceTextFormat(ordersSheet, oh, ['Order ID', 'Tracking ID'], newRowNum, 1);
  ordersSheet.appendRow(row);
  logAuditEvent('create_order', 'Order', orderID, { customer_id: customerID, channel: body.channel || '', status: status });

  return jsonResponse({
    result: 'created',
    order_id: orderID,
    customer_id: customerID,
    merge_flag: mergeFlag,
    // Set only when the username looked CLOSE to an existing customer but
    // not close enough to trust. The order was saved unlinked; the UI can
    // offer this as a one-click "link to this customer?" suggestion.
    fuzzy_suggestion: fuzzySuggestion,
    status: status
  });
}

// ─── Create customer ───────────────────────────────────────────────────────────

// ─── Create customer ───────────────────────────────────────────────────────────

function createCustomer(body) {
  const sheet = getCustomersSheet();
  const customers = sheetToObjects(sheet);

  if (body.primary_username) {
    const existing = findCustomerByUsername(customers, body.primary_username);
    if (existing && existing.confidence === 'exact') {
      return jsonResponse({
        result: 'exists',
        customer_id: existing.customer['Customer ID'],
        message: 'Customer already exists with this username.'
      });
    }
  }

  const customerID = generateCustomerID(sheet);
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];

  // Built by header name, not fixed position -- this survives future column
  // additions/reorders (e.g. Shopify Customer ID being inserted after
  // Aliases previously broke every fixed-position row-build in this file).
  const fieldValues = {
    'Customer ID': customerID,
    'Primary Username': body.primary_username || '',
    'Aliases': body.aliases || '',
    'First Name': body.first_name || '',
    'Surname': body.surname || '',
    'Initials (TT Format)': body.initials || '',
    'Street + Number': body.street || '',
    'City': body.city || '',
    'State': body.state || '',
    'ZIP': body.zip || '',
    'Phone Partial': body.phone_partial || '',
    'Phone Full': body.phone_full || '',
    'Email': body.email || '',
    'First Order Date': nowISO(),
    'Shipment Count': 0,
    'Notes': body.notes || '',
    'Merge Flag': false,
  };

  const row = headers.map(h => (fieldValues[h] !== undefined ? fieldValues[h] : ''));
  sheet.appendRow(row);
  logAuditEvent('create_customer', 'Customer', customerID, { primary_username: body.primary_username || '' });

  return jsonResponse({
    result: 'created',
    customer_id: customerID
  });
}

// ─── Update order status ───────────────────────────────────────────────────────

function updateOrderStatus(body) {
  const sheet = getOrdersSheet();
  const rowIndex = findOrderRow(sheet, body.order_id);
  if (!rowIndex) return jsonResponse({ error: 'Order not found' });

  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const statusCol = headers.indexOf('Status') + 1;

  const oldStatus = sheet.getRange(rowIndex, statusCol).getValue();
  sheet.getRange(rowIndex, statusCol).setValue(body.status);
  applyStatusSideEffects(sheet, rowIndex, body.status, headers);
  if (String(oldStatus) !== String(body.status)) {
    logAudit('update_order_status', 'Order', body.order_id, 'Status', oldStatus, body.status);
  }

  return jsonResponse({ result: 'updated', order_id: body.order_id, status: body.status });
}

// ─── Recalculate shipment count ────────────────────────────────────────────────

// ─── Narrow sheet I/O helpers ──────────────────────────────────────────────
// The Orders sheet is ~75 columns wide. Reading or rewriting all of it to
// touch one or two columns (what the merge / undo / QC-finalize / shipment
// count code used to do) is slow, holds the write lock longer, and
// re-parses every cell on the way back in -- which is how long numeric IDs
// get corrupted into scientific notation. These helpers touch only the
// columns they actually need.

// Data rows (row 2..last) of ONE column, as a flat array. [] if the column
// does not exist or the sheet is empty.
function readColumn(sheet, colIdx0) {
  const lastRow = sheet.getLastRow();
  if (colIdx0 < 0 || lastRow < 2) return [];
  return sheet.getRange(2, colIdx0 + 1, lastRow - 1, 1).getValues().map(r => r[0]);
}

// Writes back the changed entries of a column previously read with
// readColumn(). Few changes -> touch only those cells. Many changes -> one
// write of the whole column, which is ONLY safe for plain-text columns
// (Customer ID, Catalog ID) because it re-writes the unchanged cells too.
function writeColumnChanges(sheet, colIdx0, flatValues, changedIdxs) {
  if (colIdx0 < 0 || !changedIdxs.length) return;
  if (changedIdxs.length <= 15) {
    changedIdxs.forEach(i => sheet.getRange(i + 2, colIdx0 + 1).setValue(flatValues[i]));
  } else {
    sheet.getRange(2, colIdx0 + 1, flatValues.length, 1).setValues(flatValues.map(v => [v]));
  }
}

// Sets the SAME value on many cells of one column in as few API calls as
// possible. rowIdxs0 are 0-based data-row indexes (as from readColumn()).
function setCellsToValue(sheet, colIdx0, rowIdxs0, value, asText) {
  if (colIdx0 < 0 || !rowIdxs0.length) return;
  try {
    const rl = sheet.getRangeList(rowIdxs0.map(i => colLetter(colIdx0) + (i + 2)));
    if (asText) rl.setNumberFormat('@');
    rl.setValue(value);
  } catch (err) {
    // Fallback: identical result, one cell at a time.
    rowIdxs0.forEach(i => {
      const rg = sheet.getRange(i + 2, colIdx0 + 1);
      if (asText) rg.setNumberFormat('@');
      rg.setValue(value);
    });
  }
}

// Tracks which cells of an in-memory 2D array were changed, so only those
// cells are written back (instead of the whole sheet). textCols are column
// indexes forced to plain text before writing (IDs / SKUs).
function makeCellTracker(data, firstSheetRow) {
  const touched = {};
  const base = firstSheetRow || 1;   // sheet row that data[0] sits on (1 = array includes the header row)
  return {
    set: function (r, c, v) { data[r][c] = v; touched[r + ',' + c] = true; },
    flush: function (sheet, textCols) {
      Object.keys(touched).forEach(k => {
        const parts = k.split(',').map(Number);
        const rg = sheet.getRange(parts[0] + base, parts[1] + 1);
        if ((textCols || []).indexOf(parts[1]) >= 0) rg.setNumberFormat('@');
        rg.setValue(data[parts[0]][parts[1]]);
      });
    },
  };
}

// ─── Shipment count: ONE definition, computed ONE way ──────────────────────
// "How many times has this customer shipped" = TikTok + Shopify orders that
// are Enviado or Archivado. Used by the stored Shipment Count (customer
// badge), by the TikTok import (label: "Nuevo" / "N env") and by the merge
// and undo actions. Three different definitions used to exist (P8); keeping
// exactly one, in exactly one place, is what keeps them from drifting apart
// again. Reads only the three columns it needs.
function buildShippedCountMap(ordersSheet, headers) {
  const cid  = readColumn(ordersSheet, headers.indexOf('Customer ID'));
  const chan = readColumn(ordersSheet, headers.indexOf('Channel'));
  const stat = readColumn(ordersSheet, headers.indexOf('Status'));
  const map = {};
  for (let i = 0; i < cid.length; i++) {
    if (!cid[i]) continue;
    if (chan[i] !== 'TikTok' && chan[i] !== 'Shopify') continue;
    if (stat[i] !== 'Enviado' && stat[i] !== 'Archivado') continue;
    const k = String(cid[i]);
    map[k] = (map[k] || 0) + 1;
  }
  return map;
}

// Refreshes the stored Shipment Count for several customers with ONE read of
// the Orders columns and one cell write per customer.
function recalculateShipmentCountsFor(customerIds) {
  const wanted = {};
  (customerIds || []).forEach(id => { if (id) wanted[String(id)] = true; });
  if (!Object.keys(wanted).length) return;

  const ordersSheet = getOrdersSheet();
  const oh = ordersSheet.getRange(1, 1, 1, ordersSheet.getLastColumn()).getValues()[0];
  const counts = buildShippedCountMap(ordersSheet, oh);

  const cs = getCustomersSheet();
  const ch = cs.getRange(1, 1, 1, cs.getLastColumn()).getValues()[0];
  const idCol = ch.indexOf('Customer ID');
  const countCol = ch.indexOf('Shipment Count');
  if (idCol < 0 || countCol < 0) return;

  readColumn(cs, idCol).forEach((v, i) => {
    const k = String(v);
    if (wanted[k]) cs.getRange(i + 2, countCol + 1).setValue(counts[k] || 0);
  });
}

function recalculateShipmentCount(customerID) {
  recalculateShipmentCountsFor([customerID]);
}

// ─── Add alias ─────────────────────────────────────────────────────────────────

function addAlias(body) {
  const sheet = getCustomersSheet();
  const customers = sheetToObjects(sheet);
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const aliasCol = headers.indexOf('Aliases') + 1;

  const customer = customers.find(c => c['Customer ID'] === body.customer_id);
  if (!customer) return jsonResponse({ error: 'Customer not found' });

  const existing = customer['Aliases'] || '';
  const newAlias = body.alias.trim();
  const updated = existing ? existing + ', ' + newAlias : newAlias;

  sheet.getRange(customer._rowIndex, aliasCol).setValue(updated);
  logAudit('add_alias', 'Customer', body.customer_id, 'Aliases', existing, updated);

  return jsonResponse({ result: 'alias_added', customer_id: body.customer_id, aliases: updated });
}

// ─── Update packed date ────────────────────────────────────────────────────────

function updatePackedDate(body) {
  const sheet = getOrdersSheet();
  const rowIndex = findOrderRow(sheet, body.order_id);
  if (!rowIndex) return jsonResponse({ error: 'Order not found' });

  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const packedCol = headers.indexOf('Packed Date') + 1;

  const newValue = body.packed_date || nowISO();
  const oldValue = sheet.getRange(rowIndex, packedCol).getValue();
  sheet.getRange(rowIndex, packedCol).setValue(newValue);
  logAudit('update_packed_date', 'Order', body.order_id, 'Packed Date', oldValue, newValue);

  return jsonResponse({ result: 'packed_date_updated', order_id: body.order_id });
}

// ─── Migrate order ──────────────────────────────────────────────────────────────

// migrateOrder() removed: it was dead code (no frontend caller) and
// built its row by fixed column position, so it would have corrupted
// the Orders sheet if it had ever been invoked after a column change.

// ─── Stamp customer IDs ──────────────────────────────────────────────────────

function stampCustomerIDs() {
  const ordersSheet = getOrdersSheet();
  const customersSheet = getCustomersSheet();

  const customers = sheetToObjects(customersSheet);
  const orders = sheetToObjects(ordersSheet);
  const headers = ordersSheet.getRange(1, 1, 1, ordersSheet.getLastColumn()).getValues()[0];

  const customerIDCol = headers.indexOf('Customer ID') + 1;

  let stamped = 0;
  let notFound = 0;
  let skippedFuzzy = 0;
  let notFoundList = [];

  // This runs after EVERY alias confirmation and sweeps every unresolved
  // order in the sheet. It previously accepted 'fuzzy' matches and wrote
  // them one cell at a time. A fuzzy match is a guess, so writing it
  // unattended could attach an order to the wrong customer with nothing
  // on screen to review -- only exact and alias matches are written now.
  orders.forEach(order => {
    if (order['Customer ID']) return;

    const username = order['Primary Username'];
    if (!username) return;

    const resolution = findCustomerByUsername(customers, username);

    if (resolution && resolution.confidence !== 'fuzzy') {
      ordersSheet.getRange(order._rowIndex, customerIDCol).setValue(resolution.customer['Customer ID']);
      stamped++;
    } else if (resolution) {
      skippedFuzzy++;
    } else {
      notFound++;
      notFoundList.push(username);
    }
  });

  Logger.log(`Stamped: ${stamped} | Fuzzy skipped: ${skippedFuzzy} | Not found: ${notFound}`);
  Logger.log(`Not found list: ${[...new Set(notFoundList)].join(', ')}`);
}

// ─── Update / delete order ──────────────────────────────────────────────────────

function updateOrder(body) {
  const sheet = getOrdersSheet();
  const rowIndex = findOrderRow(sheet, body.order_id);
  if (!rowIndex) return jsonResponse({ error: 'Order not found' });

  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];

  // One read per changed field before its write, so the log shows a real
  // before/after. A handful of fields per call (this is a manual edit
  // form, not a bulk loop), so the extra reads are cheap here.
  Object.entries(body.fields || {}).forEach(([key, value]) => {
    const col = headers.indexOf(key) + 1;
    if (col > 0) {
      const oldValue = sheet.getRange(rowIndex, col).getValue();
      sheet.getRange(rowIndex, col).setValue(value);
      if (String(oldValue) !== String(value)) {
        logAudit('update_order', 'Order', body.order_id, key, oldValue, value);
      }
    }
  });

  if (body.fields && body.fields['Status']) {
    applyStatusSideEffects(sheet, rowIndex, body.fields['Status'], headers);
  }

  return jsonResponse({ result: 'updated', order_id: body.order_id });
}

function deleteOrder(body) {
  const sheet = getOrdersSheet();
  const rowIndex = findOrderRow(sheet, body.order_id);
  if (!rowIndex) return jsonResponse({ error: 'Order not found' });

  // Snapshot the whole row as {header: value} before it's gone -- this is
  // the only record of a deleted order's contents afterward. Not a
  // restore/undo button yet (Phase 1 is logging only), but the full row
  // lives in the log's Details column if one is built later, or for
  // manual recovery by reading the JSON.
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const rowValues = sheet.getRange(rowIndex, 1, 1, headers.length).getValues()[0];
  const snapshot = {};
  headers.forEach((h, i) => { snapshot[h] = rowValues[i]; });

  sheet.deleteRow(rowIndex);
  logAuditEvent('delete_order', 'Order', body.order_id, { deleted_row: snapshot });
  return jsonResponse({ result: 'deleted', order_id: body.order_id });
}
// ─── Auto-archive ───────────────────────────────────────────────────────────────

function autoArchiveOldOrders() {
  const sheet = getOrdersSheet();
  const data = sheet.getDataRange().getValues();
  if (data.length < 2) return;

  const headers = data[0];
  const statusCol = headers.indexOf('Status');
  const shippedCol = headers.indexOf('Shipped Date');

  const DAYS_MS = 5 * 24 * 60 * 60 * 1000;
  const now = new Date().getTime();

  let archived = 0;

  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    if (row[statusCol] !== 'Enviado') continue;

    const shippedDate = row[shippedCol];
    if (!shippedDate) continue;

    const shippedTime = new Date(shippedDate).getTime();
    if (isNaN(shippedTime)) continue;

    if (now - shippedTime >= DAYS_MS) {
      const rowIndex = i + 1;
      sheet.getRange(rowIndex, statusCol + 1).setValue('Archivado');
      applyStatusSideEffects(sheet, rowIndex, 'Archivado', headers);
      archived++;
    }
  }

  Logger.log(`Auto-archived ${archived} orders.`);
}

// Shared side-effects for ANY status change, regardless of which endpoint caused it.
function applyStatusSideEffects(sheet, rowIndex, newStatus, headers) {
  const shippedCol = headers.indexOf('Shipped Date') + 1;
  const archiveCol = headers.indexOf('Archive Date') + 1;
  const channelCol = headers.indexOf('Channel') + 1;
  const customerIdCol = headers.indexOf('Customer ID') + 1;

  if (newStatus === 'Enviado' && shippedCol > 0) {
    sheet.getRange(rowIndex, shippedCol).setValue(nowISO());
  }
  if (newStatus === 'Archivado' && archiveCol > 0) {
    sheet.getRange(rowIndex, archiveCol).setValue(nowISO());
  }

  const channel = channelCol > 0 ? sheet.getRange(rowIndex, channelCol).getValue() : '';
  const customerID = customerIdCol > 0 ? sheet.getRange(rowIndex, customerIdCol).getValue() : '';
  if ((channel === 'TikTok' || channel === 'Shopify') && customerID) {
    recalculateShipmentCount(customerID);
  }
}

// ONE-TIME REPAIR -- run once by hand from the Apps Script editor (pick this
// function in the dropdown, press Run), then check the log.
//
// Release 2026-10-13.3 wrote the phone number of Shopify-created customers
// into 'Phone Partial' instead of 'Phone Full'. The matcher only reads a
// masked number ("953*****58") from the Partial column, so those customers
// could never be matched on phone again. This moves such numbers to
// 'Phone Full'. It only touches rows whose Notes say they were created from
// Shopify, only when Phone Full is empty, and only when the Partial value
// is a complete (unmasked) number -- so it is safe to run more than once.
function repairShopifyPhoneColumns() {
  const sheet = getCustomersSheet();
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const iPartial = headers.indexOf('Phone Partial');
  const iFull = headers.indexOf('Phone Full');
  const iNotes = headers.indexOf('Notes');
  if (iPartial < 0 || iFull < 0 || iNotes < 0) {
    Logger.log('Missing Phone Partial / Phone Full / Notes column -- nothing done.');
    return 0;
  }

  const partials = readColumn(sheet, iPartial);
  const fulls = readColumn(sheet, iFull);
  const notes = readColumn(sheet, iNotes);
  let moved = 0;

  partials.forEach((p, i) => {
    const value = String(p || '').trim();
    if (!value || value.indexOf('*') >= 0) return;                // empty or masked: leave alone
    if (normalizePhone(value).length < 10) return;                // not a complete number
    if (String(fulls[i] || '').trim()) return;                    // Phone Full already set
    if (String(notes[i] || '').indexOf('Shopify') < 0) return;    // not a Shopify-created customer

    const full = sheet.getRange(i + 2, iFull + 1);
    full.setNumberFormat('@');
    full.setValue(value);
    sheet.getRange(i + 2, iPartial + 1).setValue('');
    moved++;
  });

  Logger.log('Moved ' + moved + ' phone number(s) from Phone Partial to Phone Full.');
  return moved;
}

// Full recompute of every customer's shipment count from scratch.
// Counts TikTok + Shopify orders in Enviado/Archivado. Excludes Manual.
function recalculateAllShipmentCounts() {
  const ordersSheet = getOrdersSheet();
  const data = ordersSheet.getDataRange().getValues();
  const headers = data[0];
  const channelCol = headers.indexOf('Channel');
  const statusCol = headers.indexOf('Status');
  const customerIdCol = headers.indexOf('Customer ID');

  const counts = {};
  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    if (row[channelCol] !== 'TikTok' && row[channelCol] !== 'Shopify') continue;
    if (row[statusCol] !== 'Enviado' && row[statusCol] !== 'Archivado') continue;
    const cid = row[customerIdCol];
    if (!cid) continue;
    counts[cid] = (counts[cid] || 0) + 1;
  }

  const customersSheet = getCustomersSheet();
  const custData = customersSheet.getDataRange().getValues();
  const custHeaders = custData[0];
  const custIdCol = custHeaders.indexOf('Customer ID');
  const countCol = custHeaders.indexOf('Shipment Count');

  const out = [];
  for (let i = 1; i < custData.length; i++) {
    out.push([counts[custData[i][custIdCol]] || 0]);
  }
  if (out.length > 0) {
    customersSheet.getRange(2, countCol + 1, out.length, 1).setValues(out);
  }

  Logger.log('Recalculated counts for ' + out.length + ' customers.');
}

// ═══════════════════════════════════════════════════════════════════════════
// MAINTENANCE — nightly backups, auth
// ═══════════════════════════════════════════════════════════════════════════

// ─── Nightly Backups ───────────────────────────────────────────────────────────

function nightlyBackup() {
  const folder = DriveApp.getFolderById(BACKUP_FOLDER_ID);
  const stamp = Utilities.formatDate(new Date(), 'America/Mexico_City', 'yyyy-MM-dd');
  [['Orders', ORDERS_SHEET_ID], ['Customers', CUSTOMERS_SHEET_ID]].forEach(([name, id]) => {
    try {
      DriveApp.getFileById(id).makeCopy('bk_' + stamp + '_' + name, folder);
    } catch (err) {
      MailApp.sendEmail(Session.getEffectiveUser().getEmail(),
        'VP backup FAILED: ' + name, String(err));
    }
  });
  const cutoff = Date.now() - 30 * 86400000;
  const files = folder.getFiles();
  while (files.hasNext()) {
    const f = files.next();
    if (f.getName().startsWith('bk_') && f.getDateCreated().getTime() < cutoff) {
      f.setTrashed(true);
    }
  }
  Logger.log('Backup complete: ' + stamp);
}

// Returns 'admin', 'staff', or null (invalid/missing token). Replaces the
// old single-secret authOk() -- there are now two valid tokens, each
// mapping to a role, so every call site can tell not just "is this
// allowed in at all" but "allowed to do THIS specific thing".
// Per-person credentials. Property name encodes the person: USER_<NAME>,
// value is "<password>|<role>". Adding/removing a person, or changing
// anyone's password, is a one-line edit in Script Properties -- no
// redeploy needed. API_TOKEN_SERVICE (the VPS's own credential, admin-
// equivalent) and API_TOKEN_SERVICE_STAFF (reserved for a future
// staff-level automated tool) are unaffected by this and checked
// separately below, since those aren't a human's personal password.
function getIdentity(t) {
  if (!t) return null;
  const props = PropertiesService.getScriptProperties().getProperties();

  for (const key in props) {
    if (key.indexOf('USER_') !== 0) continue;
    const parts = String(props[key] || '').split('|');
    const password = parts[0];
    const role = parts[1];
    if (password && t === password) {
      const name = key.slice('USER_'.length);
      return { name: name, role: role === 'admin' ? 'admin' : 'staff' };
    }
  }

  const serviceAdmin = props['API_TOKEN_SERVICE'];
  if (serviceAdmin && t === serviceAdmin) return { name: 'Sistema (VPS)', role: 'admin' };

  const serviceStaff = props['API_TOKEN_SERVICE_STAFF'];
  if (serviceStaff && t === serviceStaff) return { name: 'Sistema (staff)', role: 'staff' };

  // The n8n workflow that receives Shopify's order webhook and calls
  // import_shopify_order -- a separate machine identity from the VPS, so
  // the audit log can tell "a Shopify order came in automatically" apart
  // from "the VPS ran a TikTok import."
  const serviceShopify = props['API_TOKEN_SERVICE_SHOPIFY'];
  if (serviceShopify && t === serviceShopify) return { name: 'Sistema (Shopify webhook)', role: 'admin' };

  return null;
}

// Old role-only shape, kept so every existing doGet/doPost action check
// (if (!role) / requireAdmin(role)) keeps working unchanged.
function getRole(t) {
  const identity = getIdentity(t);
  return identity ? identity.role : null;
}

function authOk(t) {
  return !!getRole(t);
}

// Admin-only actions (duplicate finders/mergers, product merge tools,
// backfill tool) call this instead of / in addition to authOk(). A staff
// token is a VALID token (authOk passes) but not allowed to reach these.
function requireAdmin(role) {
  return role === 'admin';
}

// ─── Roles modal (Ajustes, admin-only) ─────────────────────────────────

// Never returns the actual password values -- only which roles exist and
// whether each one's password is currently set. The modal's "change
// password" action writes a new value but this read side never echoes
// it back, so a password can't leak just by opening the modal.
function getRolesAction(e) {
  const props = PropertiesService.getScriptProperties();
  return jsonResponse({
    roles: [
      {
        id: 'admin',
        label: 'Administrador (tú)',
        description: 'Acceso completo: Inicio, Análisis, Ajustes, y todo lo demás.',
        password_set: !!props.getProperty('API_TOKEN_ADMIN'),
      },
      {
        id: 'staff',
        label: 'Equipo',
        description: 'Pedidos, Empacar, Calidad, Importar. Sin acceso a Inicio, Análisis ni Ajustes.',
        password_set: !!props.getProperty('API_TOKEN_STAFF'),
      },
    ],
  });
}

// Only the staff password can be changed from the website. The admin
// password is intentionally NOT changeable here -- it can only be
// updated directly in the Apps Script editor's Script Properties, so a
// compromised admin session (or a mistake in this modal) can never be
// used to lock the real admin out or reset their own password.
// body.person_name must match a USER_<NAME> Script Property exactly (the
// part after "USER_"). Only ever updates a staff-role person's password --
// admin passwords stay locked to the Apps Script editor itself, same
// restriction as before, now enforced per-person rather than per-role.
// Never logs the password value, only that a change happened.
function updateRolePasswordAction(body) {
  const personName = String(body.person_name || '').trim().toUpperCase();
  const newPassword = String(body.new_password || '').trim();

  if (!personName) return jsonResponse({ error: 'person_name es obligatorio.' });
  if (!newPassword) return jsonResponse({ error: 'La contraseña no puede estar vacía.' });

  const props = PropertiesService.getScriptProperties();
  const propKey = 'USER_' + personName;
  const existing = props.getProperty(propKey);
  if (!existing) return jsonResponse({ error: 'No existe ningún usuario llamado ' + personName + '.' });

  const existingRole = existing.split('|')[1] === 'admin' ? 'admin' : 'staff';
  if (existingRole === 'admin') {
    return jsonResponse({ error: 'La contraseña de administrador solo se puede cambiar directamente en Apps Script.' });
  }

  props.setProperty(propKey, newPassword + '|' + existingRole);
  logAuditEvent('update_role_password', 'User', personName, {});
  return jsonResponse({ result: 'done' });
}
// ═══════════════════════════════════════════════════════════════════════════
// TIKTOK IMPORT
// ═══════════════════════════════════════════════════════════════════════════

function importTikTokOrders(body) {
  const orders = getOrdersSheet();
  const customersSheet = getCustomersSheet();
  const oh = orders.getRange(1, 1, 1, orders.getLastColumn()).getValues()[0];

  // ─── Read orders sheet ONCE ───────────────────────────────────────
  const iTrk = oh.indexOf('Tracking ID');
  const iChanO = oh.indexOf('Channel');
  const iStatO = oh.indexOf('Status');
  const iCustO = oh.indexOf('Customer ID');
  const lastRow = orders.getLastRow();
  const allOrderData = lastRow > 1 ? orders.getRange(2, 1, lastRow - 1, oh.length).getValues() : [];

  const trackingSet = {};
  // Customer ID -> number of shipped (Enviado/Archivado) TikTok+Shopify orders.
  // Built ONCE from the rows already loaded above. It used to be recomputed
  // by re-reading the whole Orders sheet for EVERY shipment in the batch
  // (up to 200 full-sheet reads per request).
  const shippedCountMap = {};
  allOrderData.forEach(r => {
    if (r[iTrk]) trackingSet[String(r[iTrk])] = true;
    const cid = String(r[iCustO] || '');
    if (cid && (r[iChanO] === 'TikTok' || r[iChanO] === 'Shopify') &&
        (r[iStatO] === 'Enviado' || r[iStatO] === 'Archivado')) {
      shippedCountMap[cid] = (shippedCountMap[cid] || 0) + 1;
    }
  });

  // ─── Read customers sheet ONCE into a 2D array ───────────────────
  const custLastRow = customersSheet.getLastRow();
  const custLastCol = customersSheet.getLastColumn();
  const ch = customersSheet.getRange(1, 1, 1, custLastCol).getValues()[0];
  const custData = custLastRow > 1 ? customersSheet.getRange(2, 1, custLastRow - 1, custLastCol).getValues() : [];

  const cCol = {
    id:     ch.indexOf('Customer ID'),
    street: ch.indexOf('Street + Number'),
    city:   ch.indexOf('City'),
    state:  ch.indexOf('State'),
    zip:    ch.indexOf('ZIP'),
    phone:  ch.indexOf('Phone Partial'),
    notes:  ch.indexOf('Notes'),
  };

  // Customer address enrichment below goes through this tracker so only the
  // cells that actually changed are written. This used to write the ENTIRE
  // Customers sheet back on every import that enriched anyone, re-parsing
  // every ZIP (stripping the leading 0 off every CDMX postcode) and every
  // phone number in the sheet on the way in.
  const custTrack = makeCellTracker(custData, 2);
  const custRowMap = {};
  custData.forEach((r, i) => { custRowMap[String(r[cCol.id])] = i; });

  // ─── Resolve ALL line items across ALL shipments in ONE catalog pass ──
  // (only for shipments that aren't duplicates — but we don't know that yet
  // at this point without a second trackingSet lookup, so we resolve for
  // all incoming shipments; resolving a few extra SKUs for a duplicate
  // shipment that gets skipped below is harmless and still cheap.)
  const allLineItems = [];
  (body.shipments || []).forEach(s => {
    (s.line_items || []).forEach(li => allLineItems.push(li));
  });
  const skuToCatalogId = allLineItems.length ? resolveLineItemsBatch(allLineItems) : {};
  // History collection moved below, AFTER the duplicate-tracking-ID check
  // in the main shipments loop (was previously collected here, for ALL
  // incoming shipments regardless of whether they were duplicates -- the
  // root cause of history rows being re-appended on every re-run of a
  // CSV that still contains older, already-imported shipments).

  // ─── Locate the 30 product slot column pairs ──────────────────────
  const PRODUCT_SLOTS = 30;
  const slotCols = [];
  for (let n = 1; n <= PRODUCT_SLOTS; n++) {
    slotCols.push({
      catalogCol: oh.indexOf('Product ' + n + ' Catalog ID'),
      qtyCol: oh.indexOf('Product ' + n + ' Qty'),
    });
  }

  const rows = [], results = [], unresolved = [], allImportHistory = [];
  let customersDirty = false;

  (body.shipments || []).forEach(s => {
    const tid = String(s.tracking_id || '');
    if (!tid) return;

    if (trackingSet[tid]) {
      results.push({ tracking_id: tid, inserted: false, reason: 'duplicate' });
      return;
    }
    trackingSet[tid] = true;
    (s.import_history || []).forEach(h => allImportHistory.push(h));

    let customerID = s.customer_id || '';
    let primary    = s.username || '';
    // null (not 0) means "unknown" -- duplicates and unresolved shipments
    // never had a real customer attached at this point, and the VPS/label
    // code must NOT print "Nuevo" for those; 0 is reserved for a genuine
    // first-time shipment.
    let shipCount  = null;

    if (customerID) {
      shipCount = shippedCountMap[String(customerID)] || 0;  // count BEFORE this order, by design
      const idx = custRowMap[customerID];
      if (idx !== undefined) {
        const addr = s.address || {};
        const pairs = [
          ['street', cCol.street], ['city', cCol.city], ['state', cCol.state],
          ['zip', cCol.zip], ['phone', cCol.phone]
        ];
                const existingNotes = (custData[idx][cCol.notes] || '').toString();
        const noteAdd = [];
        pairs.forEach(([k, colIdx]) => {
          const incoming = (addr[k] || '').toString().trim();
          if (!incoming || colIdx < 0) return;
          const current = (custData[idx][colIdx] || '').toString().trim();
          if (!current) {
            custTrack.set(idx, colIdx, incoming);
            customersDirty = true;
          } else if (current.toLowerCase() !== incoming.toLowerCase()) {
            // Only flag this alternate value if it hasn't already been
            // logged for this customer -- without this check, every future
            // import from the same customer re-appends an identical note,
            // since the mismatch against Phone Partial/City/etc. never
            // resolves itself on its own.
            const noteText = `${k} alt: ${incoming}`;
            if (!existingNotes.includes(noteText)) {
              noteAdd.push(noteText);
            }
          }
        });
        if (noteAdd.length && cCol.notes >= 0) {
          custTrack.set(idx, cCol.notes, (existingNotes ? existingNotes + ' | ' : '') + noteAdd.join('; '));
          customersDirty = true;
        }
      }
    } else if (s.username) {
      unresolved.push(s.username);
    }

    // ─── Build the base row exactly as before ───────────────────────
    const row = new Array(oh.length).fill('');
    row[oh.indexOf('Order ID')] = (s.order_ids || []).join(' + ') || generateUUID();
    row[oh.indexOf('Tracking ID')] = tid;
    row[oh.indexOf('Customer ID')] = customerID;
    row[oh.indexOf('Primary Username')] = primary;
    row[oh.indexOf('Channel')] = 'TikTok';
    row[oh.indexOf('Status')] = 'Pagado';
    row[oh.indexOf('Products')] = s.products || '';
    row[oh.indexOf('Price')] = Number(s.price) || 0;
    row[oh.indexOf('Created Date')] = nowISO();
    row[oh.indexOf('Linked Shipment')] = tid;

    // ─── Populate the 30 product slots from resolved line items ─────
    const lineItems = s.line_items || [];
    for (let i = 0; i < lineItems.length && i < PRODUCT_SLOTS; i++) {
      const li = lineItems[i];
      const skuId = String(li.sku_id || '').trim();
      const catalogId = skuToCatalogId[skuId] || '';
      const slot = slotCols[i];
      if (slot.catalogCol >= 0) row[slot.catalogCol] = catalogId;
      if (slot.qtyCol >= 0) row[slot.qtyCol] = Number(li.qty) || 0;
    }

    rows.push(row);
    results.push({ tracking_id: tid, inserted: true, customer_id: customerID, shipment_count: shipCount });
    logAuditEvent('import_tiktok_order', 'Order', row[oh.indexOf('Order ID')], { tracking_id: tid, channel: 'TikTok' });
  });

  // Duplicates never got a results.push inside the main loop above (they
  // return early) -- give them an explicit "unknown" count too, so the VPS
  // never silently defaults a reprint/duplicate to shipCount 0 ("Nuevo").
  results.forEach(r => {
    if (r.shipment_count === undefined) r.shipment_count = null;
  });

    // ─── Write orders in ONE batch ────────────────────────────────────
  if (rows.length) {
    const startRow = orders.getLastRow() + 1;
    forceTextFormat(orders, oh, ['Order ID', 'Tracking ID'], startRow, rows.length);
    orders.getRange(startRow, 1, rows.length, rows[0].length).setValues(rows);
  }

  // ─── Write TikTok Import History, now AFTER duplicate filtering ───
  // Second layer of protection: even among shipments that passed the
  // tracking-ID check above, dedupe by Order ID + SKU ID against what's
  // already on the sheet (same key convention as the backfill tool's
  // backfillKey()) -- a combined shipment can share an order/SKU with a
  // row that arrived via a different tracking ID on a previous run.
  appendTikTokImportHistoryDeduped(allImportHistory);

  // Shipment Count on the Customers sheet is NOT touched here: it only
  // reflects Enviado/Archivado orders (see buildShippedCountMap), and a
  // freshly-imported order is still Pagado, so there is nothing to add yet.
  // It is refreshed when the order actually ships -- by saveQC (finalize)
  // on the packing page, or by applyStatusSideEffects on a manual status
  // change. That removes the second, conflicting definition of "Shipment
  // Count" that used to live in this function.

  // ─── Write back ONLY the customer cells that changed ──────────────
  if (customersDirty && custData.length > 0) {
    custTrack.flush(customersSheet, [cCol.zip, cCol.phone]);
  }

  return jsonResponse({
    result:     'imported',
    inserted:   rows.length,
    duplicates: results.filter(r => !r.inserted).length,
    unresolved: [...new Set(unresolved)],
    shipments:  results,
  });
}

// ─── Bulk customer creation (fast path for TikTok import) ──────────────────────

function createCustomersBulk(body) {
  const sheet = getCustomersSheet();
  const existing = sheetToObjects(sheet);
  const custLastCol = sheet.getLastColumn();
  const headers = sheet.getRange(1, 1, 1, custLastCol).getValues()[0];

  let maxNum = 0;
  existing.forEach(c => {
    const id = c['Customer ID'];
    if (typeof id === 'string' && id.startsWith('CUST-')) {
      const n = parseInt(id.replace('CUST-', ''), 10);
      if (!isNaN(n) && n > maxNum) maxNum = n;
    }
  });

  // Merged-away records (Primary Username like "name (merged→CUST-775)")
  // must be excluded here. normalizeUsername() strips the "(merged→...)"
  // suffix, so without this filter a new TikTok order for an
  // already-merged customer silently matches the RETIRED record and
  // attaches to a customer ID that is no longer in use, instead of the
  // keeper it was merged into. Same exclusion findCustomerByUsername()
  // already applies. Aliases are checked too -- a customer whose primary
  // is "maria_art" with alias "mariaarts" previously got a duplicate
  // record created when "mariaarts" came in from TikTok.
  const activeExisting = existing.filter(c => !String(c['Primary Username'] || '').includes('(merged→'));

  const rows = [], created = [];
  (body.customers || []).forEach(cust => {
    if (cust.primary_username) {
      const incomingName = normalizeUsername(cust.primary_username);
      const dup = activeExisting.find(c => {
        if (normalizeUsername(c['Primary Username']) === incomingName) return true;
        const aliases = (c['Aliases'] || '').split(',').map(a => normalizeUsername(a.trim()));
        return aliases.includes(incomingName);
      });
      if (dup) {
        created.push({ username: cust.primary_username, customer_id: dup['Customer ID'], existed: true });
        return;
      }
    }
    maxNum++;
    const customerID = 'CUST-' + String(maxNum).padStart(3, '0');

    // Built by header name, not fixed position -- see the matching note in
    // createCustomer() for why this matters.
    const fieldValues = {
      'Customer ID': customerID,
      'Primary Username': cust.primary_username || '',
      'Aliases': cust.aliases || '',
      'First Name': cust.first_name || '',
      'Surname': cust.surname || '',
      'Initials (TT Format)': cust.initials || '',
      'Street + Number': cust.street || '',
      'City': cust.city || '',
      'State': cust.state || '',
      'ZIP': cust.zip || '',
      'Phone Partial': cust.phone_partial || '',
      'Phone Full': cust.phone_full || '',
      'Email': cust.email || '',
      'First Order Date': nowISO(),
      'Shipment Count': 0,
      'Notes': cust.notes || '',
      'Merge Flag': false,
    };

    rows.push(headers.map(h => (fieldValues[h] !== undefined ? fieldValues[h] : '')));
    created.push({ username: cust.primary_username, customer_id: customerID, existed: false });
  });

  if (rows.length) {
    sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, rows[0].length).setValues(rows);
  }
  created.filter(c => !c.existed).forEach(c => {
    logAuditEvent('create_customer', 'Customer', c.customer_id, { primary_username: c.username || '', source: 'bulk_import' });
  });

  return jsonResponse({ result: 'bulk_created', created: created });
}

// ═══════════════════════════════════════════════════════════════════════════
// QC SYSTEM
// ═══════════════════════════════════════════════════════════════════════════

// Signed upload ticket for direct browser->Cloudinary uploads.
// Secrets read from Script Properties: CLOUDINARY_CLOUD, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET
function getUploadSignature(e) {
  const p = PropertiesService.getScriptProperties();
  const timestamp = Math.floor(Date.now() / 1000);
  const folder = (e.parameter.folder || 'velpapier/qc').replace(/[^a-z0-9/_-]/gi, '');
  const secret = p.getProperty('CLOUDINARY_API_SECRET');
  const toSign = 'folder=' + folder + '&timestamp=' + timestamp + secret;
  const digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_1, toSign);
  const sig = digest.map(b => ((b + 256) % 256).toString(16).padStart(2, '0')).join('');
  return jsonResponse({
    cloud:     p.getProperty('CLOUDINARY_CLOUD'),
    api_key:   p.getProperty('CLOUDINARY_API_KEY'),
    timestamp: timestamp,
    folder:    folder,
    signature: sig
  });
}

// Create or update a QC row. First call (no qc_id) creates the row and
// returns qc_id; subsequent calls update photos/notes in place.
// Order-side shipping effects (Packed Date, Linked Shipment, Enviado) only
// fire when finalize=true — that's what the "Enviar" button sends.
//
// Expects body.order_ids as an array of {id, channel} objects, split into
// TikTok / Shopify / Manual columns. Expects body.content_urls and
// body.box_urls as arrays (up to 5 each) — written into Content1..5 /
// Box1..5, left-padded with '' for any unused slots.
function saveQC(body) {
  if (!body.tracking_id) {
    return jsonResponse({ error: 'tracking_id es obligatorio' });
  }

  const qcSheet = getQCSheet();
  const h = qcSheet.getRange(1, 1, 1, qcSheet.getLastColumn()).getValues()[0];
  let qcId = body.qc_id;
  let row;

  if (qcId) {
    row = findRowByColumn(qcSheet, 'A', qcId);
    if (!row) return jsonResponse({ error: 'Registro QC no encontrado' });
  } else {
    const existingRow = findRowByColumn(qcSheet, h.indexOf('Tracking ID') >= 0
      ? colLetter(h.indexOf('Tracking ID')) : 'B', body.tracking_id);
    if (existingRow) {
      row = existingRow;
      qcId = qcSheet.getRange(existingRow, h.indexOf('QC ID') + 1).getValue();
    } else {
      qcId = generateQCID(qcSheet);
      const blank = new Array(h.length).fill('');
      blank[h.indexOf('QC ID')] = qcId;
      blank[h.indexOf('Tracking ID')] = body.tracking_id;
      blank[h.indexOf('Customer ID')] = body.customer_id || '';
      blank[h.indexOf('Primary Username')] = body.username || '';
      blank[h.indexOf('Packer')] = body.packer || '';
      blank[h.indexOf('Timestamp')] = nowISO();
      blank[h.indexOf('Status')] = 'Activo';
      if (h.indexOf('Session ID') >= 0) blank[h.indexOf('Session ID')] = body.session_id || '';
      qcSheet.appendRow(blank);
      row = qcSheet.getLastRow();
    }
  }

  // Build the full row in memory, then write it in ONE setValues call.
  const rowVals = qcSheet.getRange(row, 1, 1, h.length).getValues()[0];
  const set = (col, val) => {
    const idx = h.indexOf(col);
    if (idx >= 0 && val !== undefined) rowVals[idx] = val;
  };
  const get = (col) => {
    const idx = h.indexOf(col);
    return idx >= 0 ? rowVals[idx] : '';
  };

  // Guard: once a row is Enviado (shipped), refuse further photo/content
  // changes unless the caller explicitly confirms via body.confirm_edit_shipped.
  // Prevents one device silently corrupting a shipment another device already
  // finalized — the classic "board the plane after it landed" bug.
  const isAlreadyShipped = get('Status') === 'Enviado';
  const isPhotoOrDataChange = body.add_content || body.remove_content ||
    body.add_box || body.remove_box || body.content_urls || body.box_urls ||
    body.notes !== undefined || body.order_ids;
  if (isAlreadyShipped && isPhotoOrDataChange && !body.confirm_edit_shipped) {
    return jsonResponse({ error: 'already_shipped', qc_id: qcId });
  }

  if (body.session_id) set('Session ID', body.session_id);

  // Split incoming order_ids ([{id, channel}]) into the three channel columns
  if (body.order_ids) {
    const tiktok  = body.order_ids.filter(o => o.channel === 'TikTok').map(o => o.id);
    const shopify = body.order_ids.filter(o => o.channel === 'Shopify').map(o => o.id);
    const manual  = body.order_ids.filter(o => o.channel !== 'TikTok' && o.channel !== 'Shopify').map(o => o.id);
    set('TikTok Order IDs',  tiktok.join(' + '));
    set('Shopify Order IDs', shopify.join(' + '));
    set('Manual Order IDs',  manual.join(' + '));
  }

  // ─── Delta photo operations (preferred path) ──────────────────────────
  // add_content / add_box: append a URL to the first empty slot (1..5).
  // remove_content / remove_box: remove a specific URL, shifting the rest down.
  // These only ever touch ONE group's slots, so two devices adding to
  // different groups (or the same group) can never wipe each other's photos —
  // unlike sending a full array, which overwrites everything unconditionally.
  function applyDelta(prefix, addUrl, removeUrl) {
    const cols = [1, 2, 3, 4, 5].map(n => prefix + n);
    let vals = cols.map(c => get(c));
    if (removeUrl) {
      vals = vals.filter(v => v !== removeUrl);
      while (vals.length < 5) vals.push('');
    }
    if (addUrl) {
      const emptyIdx = vals.indexOf('');
      if (emptyIdx >= 0) vals[emptyIdx] = addUrl;
      // if no empty slot (already 5), silently ignore — UI already blocks this
    }
    cols.forEach((c, i) => set(c, vals[i]));
  }
  if (body.add_content) {
    applyDelta('Content', body.add_content, null);
    logAuditEvent('qc_photo_added', 'QC', qcId, { group: 'Content', url: body.add_content });
  }
  if (body.remove_content) {
    applyDelta('Content', null, body.remove_content);
    logAuditEvent('qc_photo_removed', 'QC', qcId, { group: 'Content', url: body.remove_content });
  }
  if (body.add_box) {
    applyDelta('Box', body.add_box, null);
    logAuditEvent('qc_photo_added', 'QC', qcId, { group: 'Box', url: body.add_box });
  }
  if (body.remove_box) {
    applyDelta('Box', null, body.remove_box);
    logAuditEvent('qc_photo_removed', 'QC', qcId, { group: 'Box', url: body.remove_box });
  }

  // ─── Full-array legacy path (still used by finalize, which submits the
  // deliberate final state as a single confirm action) ───────────────────
  if (body.content_urls) {
    for (let i = 0; i < 5; i++) set('Content' + (i + 1), body.content_urls[i] || '');
  }
  if (body.box_urls) {
    for (let i = 0; i < 5; i++) set('Box' + (i + 1), body.box_urls[i] || '');
  }

  if (body.notes !== undefined && body.notes !== get('Notes')) {
    logAudit('save_qc', 'QC', qcId, 'Notes', get('Notes'), body.notes);
    set('Notes', body.notes);
  }
  if (body.packer && body.packer !== get('Packer')) {
    logAudit('save_qc', 'QC', qcId, 'Packer', get('Packer'), body.packer);
    set('Packer', body.packer);
  }
  // Finalizing marks the QC row itself, so other devices polling QC rows can
  // drop this shipment from their pending list without refetching all orders.
  if (body.finalize) {
    // Validate BEFORE marking anything. This check used to run after the QC
    // row had already been written as 'Enviado', so an incomplete finalize
    // request returned an error while leaving a shipped QC record whose
    // orders had never actually been updated.
    const preOrderIds = (body.order_ids || []).map(o => o.id);
    const prePhotos = [1, 2, 3, 4, 5].map(n => get('Content' + n)).filter(Boolean);
    if (!preOrderIds.length || prePhotos.length === 0) {
      return jsonResponse({ error: 'order_ids y al menos una foto de contenido son obligatorios para finalizar' });
    }
    set('Status', 'Enviado');
  }

  qcSheet.getRange(row, 1, 1, h.length).setValues([rowVals]);

  const result = {
    result: 'saved',
    qc_id: qcId,
    content_urls: [1,2,3,4,5].map(n => get('Content' + n)).filter(Boolean),
    box_urls:     [1,2,3,4,5].map(n => get('Box' + n)).filter(Boolean),
  };

  // Finalize: trigger the real shipping side-effects.
  // Touches ONLY the cells that actually change (Packed Date, Linked
  // Shipment, Status, Shipped Date on the shipped orders). It used to read
  // all ~75 columns of every order and write the WHOLE sheet back: slow
  // (the 7-9s "Enviar" save), and every unrelated cell got re-parsed on the
  // way back in, which is how long numeric IDs were being corrupted.
  if (body.finalize) {
    const allOrderIds = (body.order_ids || []).map(o => o.id);

    const orders = getOrdersSheet();
    const oh = orders.getRange(1, 1, 1, orders.getLastColumn()).getValues()[0];
    const iOrderId = oh.indexOf('Order ID');
    const iPacked  = oh.indexOf('Packed Date');
    const iLink    = oh.indexOf('Linked Shipment');
    const iChan    = oh.indexOf('Channel');
    const iStat    = oh.indexOf('Status');
    const iShipped = oh.indexOf('Shipped Date');
    const iCust    = oh.indexOf('Customer ID');

    // Order ID located by header (it used to be assumed to be column A).
    const idVals   = readColumn(orders, iOrderId);
    const chanVals = readColumn(orders, iChan);
    const custVals = readColumn(orders, iCust);
    const idToRowIdx = {};
    idVals.forEach((v, i) => { idToRowIdx[String(v)] = i; });

    const shipResults = [];
    const shippedRows = [];        // every order being shipped
    const linkRows = [];           // non-TikTok orders get Linked Shipment = tracking ID
    const customersToRecount = [];

    allOrderIds.forEach(id => {
      const idx = idToRowIdx[String(id)];
      if (idx === undefined) { shipResults.push({ order_id: id, result: 'not_found' }); return; }
      shippedRows.push(idx);
      if (iChan >= 0 && iLink >= 0 && chanVals[idx] !== 'TikTok') linkRows.push(idx);
      if ((chanVals[idx] === 'TikTok' || chanVals[idx] === 'Shopify') && custVals[idx]) {
        customersToRecount.push(String(custVals[idx]));
      }
      shipResults.push({ order_id: id, result: 'shipped' });
    });

    const now = nowISO();
    setCellsToValue(orders, iPacked,  shippedRows, now, false);
    setCellsToValue(orders, iLink,    linkRows, body.tracking_id, true);
    setCellsToValue(orders, iStat,    shippedRows, 'Enviado', false);
    setCellsToValue(orders, iShipped, shippedRows, now, false);

    // Shipping is what moves a customer's Shipment Count. Finalize writes
    // Status directly (it does not go through applyStatusSideEffects), so
    // refresh the count here, for just the customers involved.
    SpreadsheetApp.flush();
    SpreadsheetApp.flush();
    recalculateShipmentCountsFor(customersToRecount);
    logAuditEvent('finalize_shipment', 'QC', qcId, {
      tracking_id: body.tracking_id, order_ids: allOrderIds, shipped: shipResults,
    });

    result.result = 'created';
    result.orders = shipResults;
  }

  return jsonResponse(result);
}

// Batch read for thumbnails / order-history views.
// ?tracking_ids=A,B,C  or  ?order_id=X  or  ?session_id=X
function getQC(e) {
  const data = getQCSheet().getDataRange().getValues();
  if (data.length < 2) return jsonResponse({ records: [] });

  const h = data[0];
  const iTrk  = h.indexOf('Tracking ID');
  const iTT   = h.indexOf('TikTok Order IDs');
  const iShop = h.indexOf('Shopify Order IDs');
  const iMan  = h.indexOf('Manual Order IDs');
  const iSess = h.indexOf('Session ID');

  const wantTracking = e.parameter.tracking_ids
    ? e.parameter.tracking_ids.split(',').map(s => s.trim())
    : null;
  const wantOrder = e.parameter.order_id || null;
  const wantSession = e.parameter.session_id || null;

  const records = [];
  for (let r = 1; r < data.length; r++) {
    if (wantTracking && !wantTracking.includes(String(data[r][iTrk]))) continue;
    if (wantSession && String(data[r][iSess]) !== wantSession) continue;
    if (wantOrder) {
      const allIds = [
        ...String(data[r][iTT]   || '').split(' + '),
        ...String(data[r][iShop] || '').split(' + '),
        ...String(data[r][iMan]  || '').split(' + '),
      ].filter(Boolean);
      if (allIds.indexOf(String(wantOrder)) === -1) continue;
    }
    const obj = {};
    h.forEach((k, j) => { obj[k] = data[r][j]; });
    records.push(obj);
  }
  return jsonResponse({ records: records });
}

// QC-ID generator: QC-0001-a1b2 (row-based + short random suffix)
function generateQCID(sheet) {
  const last = sheet.getLastRow();
  return 'QC-' + String(last).padStart(4, '0') + '-' + Utilities.getUuid().slice(0, 4);
}

// Generic single-column exact-match finder, reused for QC dedup.
function columnLetterToIndex(letters) {
  let n = 0;
  String(letters).toUpperCase().split('').forEach(ch => { n = n * 26 + (ch.charCodeAt(0) - 64); });
  return n;
}

// Generic single-column exact-match finder, reused for QC dedup.
// Accepts multi-letter column names ('AA', 'AB', ...). The previous version
// only understood a single letter, so a column past Z silently pointed at
// the wrong column.
function findRowByColumn(sheet, columnLetters, value) {
  const colIdx = columnLetterToIndex(columnLetters);
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return null;
  const vals = sheet.getRange(2, colIdx, lastRow - 1, 1).getValues();
  for (let i = 0; i < vals.length; i++) {
    if (String(vals[i][0]) === String(value)) return i + 2;
  }
  return null;
}

// ═══════════════════════════════════════════════════════════════════════════
// PACKING SESSIONS
// ═══════════════════════════════════════════════════════════════════════════

function getSessionsSheet() {
  return SpreadsheetApp.openById(QC_SHEET_ID).getSheetByName('Sessions');
}

// Returns the currently open session, if any, or null.
function getActiveSession(e) {
  const sheet = getSessionsSheet();
  const rows = sheetToObjects(sheet);
  const active = rows.find(r => r['Status'] === 'Activa');
  return jsonResponse({ session: active || null });
}

// List all sessions, most recent first. Each includes its own summary stats
// (recomputed live, not cached) so history stays accurate even if QC rows
// are edited after a session ends.
function getSessions(e) {
  const sheet = getSessionsSheet();
  const rows = sheetToObjects(sheet);
  rows.sort((a, b) => String(b['Start Time']).localeCompare(String(a['Start Time'])));
  return jsonResponse({ records: rows });
}

// Start a new session. Fails if one is already active (only one at a time).
function startSession(body) {
  // The script lock is now taken centrally by withWriteLock() in doPost.
  // Re-acquiring it here would deadlock this execution against its own
  // outer hold, so the inner lock has been removed. The guarantee it
  // provided (no two devices creating duplicate sessions) is unchanged.
  try {
    const sheet = getSessionsSheet();
    const rows = sheetToObjects(sheet);
    const existingActive = rows.find(r => r['Status'] === 'Activa');
    if (existingActive) {
      return jsonResponse({
        result: 'already_active',
        session_id: existingActive['Session ID'],
        session: existingActive
      });
    }

    const todayStr = Utilities.formatDate(new Date(), 'America/Mexico_City', 'yyyyMMdd');
    const todayCount = rows.filter(r => String(r['Session ID']).startsWith('SES-' + todayStr)).length;
    const sessionId = 'SES-' + todayStr + '-' + (todayCount + 1);

    sheet.appendRow([sessionId, nowISO(), '', 'Activa', '', '', '']);
    logAuditEvent('start_session', 'Session', sessionId, {});

    return jsonResponse({ result: 'started', session_id: sessionId });
  } finally {
    // no-op: the script lock is released by withWriteLock() in doPost.
  }
}

// End the active session: stamps End Time, computes Participants /
// Total Packages / Total Items from every linked QC row, flips to Finalizada.
// Live-update the Participants column while a session is running, so every
// device shows the same checked-packer list instead of each device having
// its own local copy that only gets "decided" by whichever device ends it.
function updateSessionParticipants(body) {
  if (!body.session_id) return jsonResponse({ error: 'session_id es obligatorio' });
  const sheet = getSessionsSheet();
  const row = findRowByColumn(sheet, 'A', body.session_id);
  if (!row) return jsonResponse({ error: 'Sesión no encontrada' });

  const h = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const idx = h.indexOf('Participants') + 1;
  if (idx > 0) {
    sheet.getRange(row, idx).setValue((body.participants || []).join(', '));
  }
  return jsonResponse({ result: 'updated' });
}

function endSession(body) {
  if (!body.session_id) return jsonResponse({ error: 'session_id es obligatorio' });

  const sheet = getSessionsSheet();
  const row = findRowByColumn(sheet, 'A', body.session_id);
  if (!row) return jsonResponse({ error: 'Sesión no encontrada' });

  const qcSheet = getQCSheet();
  const qcRows = sheetToObjects(qcSheet).filter(r => r['Session ID'] === body.session_id);

  const packers = [...new Set(qcRows.map(r => r['Packer']).filter(Boolean))];
  const totalPackages = qcRows.length;

  // Item count: parse "Nx " prefixes from linked orders' Products field where
  // available (TikTok convention). Falls back to 1 item per order id if the
  // Products text can't be parsed (e.g. legacy Shopify orders).
  const ordersSheet = getOrdersSheet();
  const allOrders = sheetToObjects(ordersSheet);
  let totalItems = 0;
  qcRows.forEach(qcRow => {
    const allIds = [
      ...String(qcRow['TikTok Order IDs']  || '').split(' + '),
      ...String(qcRow['Shopify Order IDs'] || '').split(' + '),
      ...String(qcRow['Manual Order IDs']  || '').split(' + '),
    ].filter(Boolean);
    allIds.forEach(id => {
      const order = allOrders.find(o => o['Order ID'] === id);
      if (!order || !order['Products']) { totalItems += 1; return; }
      const lines = String(order['Products']).split(/[\n;]+/).map(l => l.trim()).filter(Boolean);
      if (lines.length === 0) { totalItems += 1; return; }
      lines.forEach(line => {
        const m = line.match(/^(\d+)\s*x\s*/i);
        totalItems += m ? parseInt(m[1], 10) : 1;
      });
    });
  });

  const h = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const rowVals = sheet.getRange(row, 1, 1, h.length).getValues()[0];
  const set = (col, val) => {
    const idx = h.indexOf(col);
    if (idx >= 0) rowVals[idx] = val;
  };

  // Merge auto-detected packers with any manually-added participants
  // Merge auto-detected packers with the live Participants field (kept in
  // sync by every device via update_session_participants as checkboxes are
  // toggled — this is the one true list, not just whichever device happens
  // to click "end session").
  const liveParticipants = String(rowVals[h.indexOf('Participants')] || '')
    .split(',').map(s => s.trim()).filter(Boolean);
  const manualParticipants = (body.participants || []).filter(Boolean);
  const allParticipants = [...new Set([...packers, ...liveParticipants, ...manualParticipants])];

  set('End Time', nowISO());
  set('Status', 'Finalizada');
  set('Participants', allParticipants.join(', '));
  set('Total Packages', totalPackages);
  set('Total Items', totalItems);
  const startMs = Date.parse(rowVals[h.indexOf('Start Time')]);
  if (!isNaN(startMs) && h.indexOf('Duration (min)') >= 0) {
    set('Duration (min)', Math.round((Date.now() - startMs) / 60000));
  }
  sheet.getRange(row, 1, 1, h.length).setValues([rowVals]);
  logAuditEvent('end_session', 'Session', body.session_id, {
    participants: allParticipants, total_packages: totalPackages, total_items: totalItems,
  });

  return jsonResponse({
    result: 'ended',
    session_id: body.session_id,
    participants: allParticipants,
    total_packages: totalPackages,
    total_items: totalItems,
    start_time: rowVals[h.indexOf('Start Time')],
  });
}
// ═══════════════════════════════════════════════════════════════════════════
// PRODUCT CATALOG — accessors + resolution logic
// ═══════════════════════════════════════════════════════════════════════════

const PRODUCT_CATALOG_SHEET_ID = '1XZY9Azw-YizHC6D3l54IMCMKIAFT9qqcVkg4FGf2vSA';

function getProductParentsSheet() {
  return SpreadsheetApp.openById(PRODUCT_CATALOG_SHEET_ID).getSheetByName('Product Parents');
}

function getProductVariantsSheet() {
  return SpreadsheetApp.openById(PRODUCT_CATALOG_SHEET_ID).getSheetByName('Product Variants');
}

function getCatalogSuggestionsSheet() {
  return SpreadsheetApp.openById(PRODUCT_CATALOG_SHEET_ID).getSheetByName('Catalog Suggestions');
}

function generateParentID(existingParents) {
  let maxNum = 0;
  existingParents.forEach(p => {
    const id = String(p.parentId || '');
    if (id.startsWith('PARENT-')) {
      const n = parseInt(id.replace('PARENT-', ''), 10);
      if (!isNaN(n) && n > maxNum) maxNum = n;
    }
  });
  return 'PARENT-' + String(maxNum + 1).padStart(3, '0');
}

function generateCatalogID(existingVariants) {
  let maxNum = 0;
  existingVariants.forEach(v => {
    const id = String(v.catalogId || '');
    if (id.startsWith('VAR-')) {
      const n = parseInt(id.replace('VAR-', ''), 10);
      if (!isNaN(n) && n > maxNum) maxNum = n;
    }
  });
  return 'VAR-' + String(maxNum + 1).padStart(3, '0');
}

// Simple string similarity (0-1) using normalized Levenshtein distance.
// Used only for the fuzzy Parent-name fallback (Step 3 of resolution).
function stringSimilarity(a, b) {
  a = (a || '').toLowerCase().trim();
  b = (b || '').toLowerCase().trim();
  if (a === b) return 1;
  if (!a.length || !b.length) return 0;

  const matrix = [];
  for (let i = 0; i <= b.length; i++) matrix[i] = [i];
  for (let j = 0; j <= a.length; j++) matrix[0][j] = j;

  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b.charAt(i - 1) === a.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1,
          matrix[i][j - 1] + 1,
          matrix[i - 1][j] + 1
        );
      }
    }
  }
  const distance = matrix[b.length][a.length];
  const maxLen = Math.max(a.length, b.length);
  return 1 - (distance / maxLen);
}

const FUZZY_PARENT_THRESHOLD = 0.82; // tune if too many/few suggestions appear

// ─── Main resolution entry point ────────────────────────────────────────────
// Takes the raw line_items array from one shipment (as sent by the
// tiktok-import service) and returns an array of { catalogId, qty } pairs,
// creating new Parent/Variant rows and logging fuzzy suggestions as needed.
//
// Call this ONCE per import batch (not per shipment) for performance —
// pass ALL line items from ALL shipments in the batch, get back a map.
function resolveLineItemsBatch(allLineItems) {
  const parentsSheet = getProductParentsSheet();
  const variantsSheet = getProductVariantsSheet();
  const suggestionsSheet = getCatalogSuggestionsSheet();

  // ─── Load existing catalog data ONCE ──────────────────────────────
  const pData = parentsSheet.getDataRange().getValues();
  const pHeaders = pData[0] || ['Parent ID', 'Parent Name', 'Created Date'];
  const iPId = pHeaders.indexOf('Parent ID');
  const iPName = pHeaders.indexOf('Parent Name');

  // Merged-away parents/variants keep their names and their TikTok SKU
  // IDs, and the SKU lookup below is "last row wins" -- the loser usually
  // sits lower in the sheet, so future imports were routing straight back
  // onto the dead variant and quietly re-splitting what was just merged.
  const parents = pData.slice(1).map((r, i) => ({
    rowIndex: i + 2,
    parentId: r[iPId],
    parentName: r[iPName],
  })).filter(p => !String(p.parentName || '').includes('(merged→'));

  const vData = variantsSheet.getDataRange().getValues();
  const vHeaders = vData[0] || ['Catalog ID', 'Parent ID', 'Variant Name', 'Your SKU', 'TikTok SKU IDs', 'Notes', 'Created Date'];
  const iVId = vHeaders.indexOf('Catalog ID');
  const iVParent = vHeaders.indexOf('Parent ID');
  const iVName = vHeaders.indexOf('Variant Name');
  const iVSkus = vHeaders.indexOf('TikTok SKU IDs');

  const variants = vData.slice(1).map((r, i) => ({
    rowIndex: i + 2,
    catalogId: r[iVId],
    parentId: r[iVParent],
    variantName: r[iVName],
    tiktokSkuIds: String(r[iVSkus] || '').split(',').map(s => s.trim()).filter(Boolean),
  })).filter(v => !String(v.variantName || '').includes('(merged→'));

  const sData = suggestionsSheet.getDataRange().getValues();
  const sHeaders = sData[0] || ['New Parent Name Suggested', 'Suggested Parent ID', 'Similarity Score', 'Decision', 'Decided Date'];
  const iSName = sHeaders.indexOf('New Parent Name Suggested');
  const iSParent = sHeaders.indexOf('Suggested Parent ID');
  const iSDecision = sHeaders.indexOf('Decision');

  const rejectedPairs = new Set();
  sData.slice(1).forEach(r => {
    if (r[iSDecision] === 'Rejected') {
      rejectedPairs.add(r[iSName] + '||' + r[iSParent]);
    }
  });

  // Fast lookup maps
  const skuToVariant = {};       // TikTok SKU ID -> variant object
  variants.forEach(v => {
    v.tiktokSkuIds.forEach(sku => { skuToVariant[sku] = v; });
  });

  const nameVarToVariant = {};   // "ParentName||VariantName" -> variant object
  variants.forEach(v => {
    const parent = parents.find(p => p.parentId === v.parentId);
    if (parent) {
      nameVarToVariant[parent.parentName + '||' + v.variantName] = v;
    }
  });

  const newParentRows = [];
  const newVariantRows = [];
  const newSuggestionRows = [];
  const skuAdditions = {}; // variant.rowIndex -> [newSkuIds to append]

  const resultMap = {}; // sku_id -> catalogId (for every line item across the batch)

  allLineItems.forEach(item => {
    const skuId = String(item.sku_id || '').trim();
    const productName = String(item.product || '').trim();
    const variationName = String(item.variation || '').trim();
    if (!skuId || !productName) return;
    if (resultMap[skuId]) return; // already resolved earlier in this same batch

    // ─── Step 1: SKU ID already known ─────────────────────────────
    if (skuToVariant[skuId]) {
      resultMap[skuId] = skuToVariant[skuId].catalogId;
      return;
    }

    // ─── Step 2: Name + Variation exact match ─────────────────────
    const nameVarKey = productName + '||' + variationName;
    if (nameVarToVariant[nameVarKey]) {
      const v = nameVarToVariant[nameVarKey];
      resultMap[skuId] = v.catalogId;
      skuToVariant[skuId] = v; // so later items in this batch also hit Step 1
      if (!skuAdditions[v.rowIndex]) skuAdditions[v.rowIndex] = [];
      skuAdditions[v.rowIndex].push(skuId);
      return;
    }

    // ─── Step 3: fuzzy-match Product Name against existing Parents ─
    let bestParent = null;
    let bestScore = 0;
    parents.forEach(p => {
      const score = stringSimilarity(productName, p.parentName);
      if (score > bestScore) { bestScore = score; bestParent = p; }
    });

    let parentId;
    if (bestParent && bestScore === 1) {
      // Exact name match (case/whitespace-normalized) — certain, no suggestion needed.
      parentId = bestParent.parentId;
    } else if (bestParent && bestScore >= FUZZY_PARENT_THRESHOLD) {
      const pairKey = productName + '||' + bestParent.parentId;
      if (!rejectedPairs.has(pairKey)) {
        parentId = bestParent.parentId;
        newSuggestionRows.push([
          productName, bestParent.parentId, bestScore.toFixed(2), 'Pending', ''
        ]);
      }
    }

    // ─── Step 4: no match at all -> brand new Parent ───────────────
    if (!parentId) {
      parentId = generateParentID(parents);
      const newParent = { rowIndex: null, parentId: parentId, parentName: productName };
      parents.push(newParent);
      newParentRows.push([parentId, productName, nowISO()]);
    }

    // Create the new Variant under the resolved Parent
    const catalogId = generateCatalogID(variants);
    const newVariant = {
      rowIndex: null,
      catalogId: catalogId,
      parentId: parentId,
      variantName: variationName,
      tiktokSkuIds: [skuId],
    };
    variants.push(newVariant);
    newVariantRows.push([catalogId, parentId, variationName, '', skuId, '', nowISO()]);

    resultMap[skuId] = catalogId;
    skuToVariant[skuId] = newVariant;
    nameVarToVariant[nameVarKey] = newVariant;
  });

  // ─── Write everything back in batches ─────────────────────────────
  if (newParentRows.length) {
    parentsSheet.getRange(parentsSheet.getLastRow() + 1, 1, newParentRows.length, newParentRows[0].length)
      .setValues(newParentRows);
  }
  if (newVariantRows.length) {
    // 19-digit TikTok SKU IDs land here. Without plain-text format Sheets
    // rounds them into scientific notation, the next import can no longer
    // find the SKU by ID, and it falls through to name matching -- which
    // is how duplicate variants were being created in the first place.
    const vStart = variantsSheet.getLastRow() + 1;
    forceTextFormat(variantsSheet, vHeaders, ['Catalog ID', 'Parent ID', 'TikTok SKU IDs'], vStart, newVariantRows.length);
    variantsSheet.getRange(vStart, 1, newVariantRows.length, newVariantRows[0].length)
      .setValues(newVariantRows);
  }
  if (newSuggestionRows.length) {
    suggestionsSheet.getRange(suggestionsSheet.getLastRow() + 1, 1, newSuggestionRows.length, newSuggestionRows[0].length)
      .setValues(newSuggestionRows);
  }

  // Append new SKU IDs to existing variants (Step 2 matches, i.e. relists)
  const skuRowIndexes = Object.keys(skuAdditions);
  if (skuRowIndexes.length) {
    skuRowIndexes.forEach(rowIndexStr => {
      const rowIndex = parseInt(rowIndexStr, 10);
      const currentVal = variantsSheet.getRange(rowIndex, iVSkus + 1).getValue();
      const currentList = String(currentVal || '').split(',').map(s => s.trim()).filter(Boolean);
      const merged = currentList.concat(skuAdditions[rowIndexStr]);
      variantsSheet.getRange(rowIndex, iVSkus + 1).setNumberFormat('@');
      variantsSheet.getRange(rowIndex, iVSkus + 1).setValue(merged.join(', '));
    });
  }

  return resultMap; // { sku_id: catalogId, ... }
}
// ═══════════════════════════════════════════════════════════════════════════
// SHOPIFY CUSTOMER RESOLUTION
// ═══════════════════════════════════════════════════════════════════════════

const SHOPIFY_SCORE_THRESHOLD = 30; // below this, treat as "no reasonable guess" -> straight to new_customer

// Simple Levenshtein-based similarity, 0-1. Same shape as the Product
// Catalog's stringSimilarity() above, kept as a separate copy so this
// section stays self-contained.
function shopifyStringSimilarity(a, b) {
  a = (a || '').toLowerCase().trim();
  b = (b || '').toLowerCase().trim();
  if (a === b) return 1;
  if (!a.length || !b.length) return 0;

  const matrix = [];
  for (let i = 0; i <= b.length; i++) matrix[i] = [i];
  for (let j = 0; j <= a.length; j++) matrix[0][j] = j;

  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b.charAt(i - 1) === a.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1,
          matrix[i][j - 1] + 1,
          matrix[i - 1][j] + 1
        );
      }
    }
  }
  const distance = matrix[b.length][a.length];
  const maxLen = Math.max(a.length, b.length);
  return 1 - (distance / maxLen);
}

function normalizePhone(phone) {
  return String(phone || '').replace(/[^\d]/g, '');
}

// Compares a full Shopify phone against a customer's Phone Full or
// redacted Phone Partial (e.g. "(+52)953*****58"). Returns 0-100.
function phoneMatchScore(shopifyPhoneFull, customerPhoneFull, customerPhonePartial) {
  const incoming = normalizePhone(shopifyPhoneFull);
  if (!incoming) return 0;

  const fullOnFile = normalizePhone(customerPhoneFull);
  if (fullOnFile && fullOnFile === incoming) return 100;

  const partial = String(customerPhonePartial || '');
  const prefixM = partial.match(/(\d+)\*/);
  const suffixM = partial.match(/\*(\d+)$/);
  const prefix = prefixM ? prefixM[1] : '';
  const suffix = suffixM ? suffixM[1] : '';

  if (prefix && suffix && incoming.startsWith(prefix) && incoming.endsWith(suffix)) {
    return 100; // both ends line up with the redacted number
  }
  if (suffix && incoming.endsWith(suffix)) return 50;
  if (prefix && incoming.startsWith(prefix)) return 40;
  return 0;
}

function scoreShopifyMatch(incoming, customer) {
  let score = 0;

  // Phone — 35%
  const phoneScore = phoneMatchScore(
    incoming.phone,
    customer['Phone Full'],
    customer['Phone Partial']
  );
  score += phoneScore * 0.35;

  // Full name — 20%
  const customerFullName = `${customer['First Name'] || ''} ${customer['Surname'] || ''}`.trim();
  if (incoming.fullName && customerFullName) {
    score += shopifyStringSimilarity(incoming.fullName, customerFullName) * 100 * 0.20;
  }

  // Email contains name — 15%
  // Checks whether the customer's on-file first/last name appears inside
  // the incoming email's local part (e.g. "karelycampos7@gmail.com"
  // contains both "karely" and "campos"). Catches cases where the shipping
  // name differs (e.g. ordering for someone else) but the account owner's
  // email still gives it away.
  if (incoming.email && (customer['First Name'] || customer['Surname'])) {
    const localPart = incoming.email.split('@')[0].toLowerCase();
    const first = (customer['First Name'] || '').toLowerCase().trim();
    const last = (customer['Surname'] || '').toLowerCase().trim();
    let emailScore = 0;
    if (first && first.length >= 3 && localPart.includes(first)) emailScore += 50;
    if (last && last.length >= 3 && localPart.includes(last)) emailScore += 50;
    score += Math.min(emailScore, 100) * 0.15;
  }

  // Username (optional, from the 'company' field) — 15%
  if (incoming.username) {
    const candidates = [customer['Primary Username'] || ''].concat(
      String(customer['Aliases'] || '').split(',').map(a => a.trim())
    ).filter(Boolean);
    let bestUsernameScore = 0;
    candidates.forEach(cand => {
      const s = shopifyStringSimilarity(normalizeUsername(incoming.username), normalizeUsername(cand));
      if (s > bestUsernameScore) bestUsernameScore = s;
    });
    score += bestUsernameScore * 100 * 0.15;
  }

  // ZIP exact — flat 10
  if (incoming.zip && customer['ZIP'] && String(incoming.zip) === String(customer['ZIP'])) {
    score += 10;
  }

  // City fuzzy — 5%
  if (incoming.city && customer['City']) {
    score += shopifyStringSimilarity(incoming.city, customer['City']) * 100 * 0.05;
  }

  return Math.round(Math.min(score, 100));
}

// ─── Main entry point ────────────────────────────────────────────────────
// incoming = {
//   shopifyCustomerId, fullName, phone, username, email, city, state, zip
// }
// Returns: { tier: 'auto'|'review'|'new', customerId, matchRow }
function resolveShopifyCustomer(incoming) {
  const customersSheet = getCustomersSheet();
  // A merged-away loser keeps its Shopify Customer ID, so without this
  // filter Tier 1 below can link a brand new Shopify order straight onto
  // a retired record. Tier 2 scoring had the same hole.
  const customers = sheetToObjects(customersSheet)
    .filter(c => !String(c['Primary Username'] || '').includes('(merged→'));

  // ─── Tier 1: Shopify Customer ID exact match ──────────────────────
  if (incoming.shopifyCustomerId) {
    const found = customers.find(c => {
      const ids = String(c['Shopify Customer ID'] || '').split('/').map(s => s.trim()).filter(Boolean);
      return ids.includes(String(incoming.shopifyCustomerId));
    });
    if (found) {
      return { tier: 'auto', customerId: found['Customer ID'] };
    }
  }

  // ─── Tier 2: weighted scoring against all customers ───────────────
  let bestScore = 0, bestCustomer = null;
  customers.forEach(c => {
    const s = scoreShopifyMatch(incoming, c);
    if (s > bestScore) { bestScore = s; bestCustomer = c; }
  });

  if (bestScore >= SHOPIFY_SCORE_THRESHOLD && bestCustomer) {
    return {
      tier: 'review',
      customerId: '',
      suggestedCustomerId: bestCustomer['Customer ID'],
      suggestedCustomerName: bestCustomer['Primary Username'] || `${bestCustomer['First Name']} ${bestCustomer['Surname']}`,
      score: bestScore,
    };
  }

  // ─── Tier 3: no reasonable match ───────────────────────────────────
  return { tier: 'new', customerId: '' };
}

// Logs a Tier 2 "review" case as a durable row in Shopify Customer Matches.
// This is what makes the flag survive page reloads -- it lives in the Sheet,
// not just in a one-time API response.
function logShopifyMatch(incoming, resolution, shopifyOrderId, orderName) {
  const sheet = getShopifyMatchesSheet();
  const row = [
    'MATCH-' + Utilities.getUuid().slice(0, 8),      // Match ID
    shopifyOrderId,                                   // Shopify Order ID
    incoming.shopifyCustomerId || '',                 // Shopify Customer ID
    orderName || '',                                  // Order Name/Number
    incoming.fullName || '',                          // Incoming Name
    incoming.phone || '',                             // Incoming Phone
    incoming.username || '',                          // Incoming Username
    incoming.email || '',                             // Incoming Email
    [incoming.city, incoming.state, incoming.zip].filter(Boolean).join(' / '), // Incoming Address
    resolution.suggestedCustomerId || '',             // Suggested Customer ID
    resolution.suggestedCustomerName || '',           // Suggested Customer Name
    resolution.score || 0,                            // Match Score
    'Pending',                                        // Decision
    '',                                                // Linked Customer ID
    '',                                                // Decided Date
    nowISO(),                                          // Created Date
  ];
  sheet.appendRow(row);
  return row[0]; // return the Match ID
}

function importShopifyOrder(body) {
  // The script lock is now taken centrally by withWriteLock() in doPost,
  // which returns its own "servidor ocupado" error if the wait times out.
  // Re-acquiring the lock here would deadlock this execution against its
  // own outer hold, so the inner lock and its busy branch were removed.
  try {
    const shopifyOrderId = String(body.shopify_order_id || '');
    const orderName = body.order_name || '';

        const ordersSheet = getOrdersSheet();
    const oh = ordersSheet.getRange(1, 1, 1, ordersSheet.getLastColumn()).getValues()[0];

    // ─── Dedup check: has this Shopify order already been imported? ───
    const existing = sheetToObjects(ordersSheet);
    const dup = existing.find(o => String(o['Shopify Order ID'] || '') === shopifyOrderId);
    if (dup) {
      return jsonResponse({
        result: 'duplicate',
        message: 'This Shopify Order ID has already been imported.',
        existing_row: dup,
      });
    }

    // ─── Build the "incoming" shape resolveShopifyCustomer() expects ──
    const incoming = {
      shopifyCustomerId: body.shopify_customer_id || '',
      fullName:          body.full_name || '',
      phone:             body.phone || '',
      username:          body.username || '',   // from the 'company' field, optional
      email:             body.email || '',
      city:              body.city || '',
      state:             body.state || '',
      zip:               body.zip || '',
    };

    const resolution = resolveShopifyCustomer(incoming);

    let customerID = '';
    let matchId = '';

    if (resolution.tier === 'auto') {
      customerID = resolution.customerId;

    } else if (resolution.tier === 'review') {
      matchId = logShopifyMatch(incoming, resolution, shopifyOrderId, orderName);

    } else if (resolution.tier === 'new') {
      const customersSheet = getCustomersSheet();
      const nameParts = (incoming.fullName || '').split(' ');
      const firstName = nameParts[0] || '';
      const surname   = nameParts.slice(1).join(' ');

      customerID = generateCustomerID(customersSheet);
      // Built by header name, not a fixed 18-slot array -- the positional
      // version silently shifted every value one column the moment the
      // Customers sheet gained or reordered a column.
      appendCustomerRowByHeader(customersSheet, {
        'Customer ID': customerID,
        'Primary Username': incoming.username || '',
        'Shopify Customer ID': incoming.shopifyCustomerId || '',
        'First Name': firstName,
        'Surname': surname,
        'City': incoming.city || '',
        'State': incoming.state || '',
        'ZIP': incoming.zip || '',
        'Phone Full': incoming.phone || '',
        'Email': incoming.email || '',
        'First Order Date': nowISO(),
        'Shipment Count': 0,
        'Notes': 'Auto-created from Shopify order ' + orderName,
        'Merge Flag': false,
      });
    }

    // ─── Write the Orders row (always, regardless of tier) ────────────
    const row = new Array(oh.length).fill('');
    row[oh.indexOf('Order ID')] = generateUUID();
    row[oh.indexOf('Shopify Order ID')] = shopifyOrderId;
    row[oh.indexOf('Shopify Order Number')] = orderName;
    row[oh.indexOf('Customer ID')] = customerID;
    // "SIN NOMBRE" root cause: this used incoming.username, which comes
    // from Shopify's "company" field and is almost always blank -- so an
    // order that auto-linked perfectly still showed as nameless in every
    // list that groups by the order-level username. Pull the matched
    // customer's real display name instead, with a sensible fallback
    // chain, and fall back to the Shopify order number as a last resort
    // so a row is never completely unlabelled.
    row[oh.indexOf('Primary Username')] = customerID
      ? (customerDisplayName(customerID) || incoming.username || orderName || '')
      : (incoming.username || '');
    row[oh.indexOf('Channel')] = 'Shopify';
    row[oh.indexOf('Status')] = 'Pagado';
    row[oh.indexOf('Products')] = body.products || '';
    row[oh.indexOf('Price')] = Number(body.price) || 0;
    row[oh.indexOf('Created Date')] = nowISO();

    const PRODUCT_SLOTS = 30;
    const lineItems = body.line_items || [];
    const allLineItems = lineItems.map(li => ({
      sku_id:    li.sku_id || li.variant_id || '',
      product:   li.product || li.title || '',
      variation: li.variation || li.variant_title || '',
      qty:       li.qty || li.quantity || 1,
    }));
    const skuToCatalogId = allLineItems.length ? resolveLineItemsBatch(allLineItems) : {};

    for (let i = 0; i < allLineItems.length && i < PRODUCT_SLOTS; i++) {
      const li = allLineItems[i];
      const catalogId = skuToCatalogId[String(li.sku_id)] || '';
      const catalogCol = oh.indexOf('Product ' + (i + 1) + ' Catalog ID');
      const qtyCol = oh.indexOf('Product ' + (i + 1) + ' Qty');
      if (catalogCol >= 0) row[catalogCol] = catalogId;
      if (qtyCol >= 0) row[qtyCol] = Number(li.qty) || 0;
    }

      ordersSheet.appendRow(row);
    logAuditEvent('import_shopify_order', 'Order', row[oh.indexOf('Order ID')], {
      shopify_order_id: shopifyOrderId, order_name: orderName, tier: resolution.tier,
    });

    return jsonResponse({
      result: 'imported',
      order_id: row[oh.indexOf('Order ID')],
      customer_id: customerID,
      tier: resolution.tier,
      match_id: matchId,
    });

  } finally {
    // no-op: the script lock is released by withWriteLock() in doPost.
  }
}
// ═══════════════════════════════════════════════════════════════════════════
// RESOLVE SHOPIFY MATCH — endpoint the merge/review UI calls
// ═══════════════════════════════════════════════════════════════════════════

// body = {
//   match_id: 'MATCH-xxxx',
//   decision: 'confirm' | 'relink' | 'new',
//   customer_id: '...'   // required for 'relink' (which customer to link to instead)
// }
function resolveShopifyMatchAction(body) {
  const matchesSheet = getShopifyMatchesSheet();
  const matches = sheetToObjects(matchesSheet);
  const match = matches.find(m => m['Match ID'] === body.match_id);
  if (!match) return jsonResponse({ error: 'Match not found' });
  // Without this, a double-click (or a retried request) runs the whole
  // decision twice -- and for decision 'new' that means two customer
  // records created for the same person.
  if (String(match['Decision'] || '').trim() !== 'Pending') {
    return jsonResponse({ error: 'Esta coincidencia ya fue resuelta (' + match['Decision'] + ').' });
  }

  const mh = matchesSheet.getRange(1, 1, 1, matchesSheet.getLastColumn()).getValues()[0];
  const setMatchField = (col, val) => {
    const idx = mh.indexOf(col);
    if (idx >= 0) matchesSheet.getRange(match._rowIndex, idx + 1).setValue(val);
  };

  let linkedCustomerId = '';

  if (body.decision === 'confirm') {
    linkedCustomerId = match['Suggested Customer ID'];
    if (!linkedCustomerId) return jsonResponse({ error: 'No suggested customer to confirm' });
    appendShopifyIdToCustomer(linkedCustomerId, match['Shopify Customer ID']);
    enrichCustomerFromMatch(linkedCustomerId, match);
    setMatchField('Decision', 'Confirmed-Suggested');

  } else if (body.decision === 'relink') {
    linkedCustomerId = body.customer_id;
    if (!linkedCustomerId) return jsonResponse({ error: 'customer_id is required for relink' });
    appendShopifyIdToCustomer(linkedCustomerId, match['Shopify Customer ID']);
    enrichCustomerFromMatch(linkedCustomerId, match);
    setMatchField('Decision', 'Confirmed-Different');

  } else if (body.decision === 'new') {
    const customersSheet = getCustomersSheet();
    const nameParts = String(match['Incoming Name'] || '').split(' ');
    const firstName = nameParts[0] || '';
    const surname = nameParts.slice(1).join(' ');

    const addrParts = String(match['Incoming Address'] || '').split(' / ');
    linkedCustomerId = generateCustomerID(customersSheet);
    // Built by header name, not a fixed 18-slot array (see the matching
    // note in importShopifyOrder).
    appendCustomerRowByHeader(customersSheet, {
      'Customer ID': linkedCustomerId,
      'Primary Username': match['Incoming Username'] || '',
      'Shopify Customer ID': match['Shopify Customer ID'] || '',
      'First Name': firstName,
      'Surname': surname,
      'City': addrParts[0] || '',
      'State': addrParts[1] || '',
      'ZIP': addrParts[2] || '',
      'Phone Full': match['Incoming Phone'] || '',
      'Email': match['Incoming Email'] || '',
      'First Order Date': nowISO(),
      'Shipment Count': 0,
      'Notes': 'Created from Shopify match review (' + match['Match ID'] + ')',
      'Merge Flag': false,
    });
    setMatchField('Decision', 'Created-New');

  } else {
    return jsonResponse({ error: 'Unknown decision: ' + body.decision });
  }

  setMatchField('Linked Customer ID', linkedCustomerId);
  setMatchField('Decided Date', nowISO());
  logAuditEvent('resolve_shopify_match', 'ShopifyMatch', body.match_id, {
    decision: body.decision,
    linked_customer_id: linkedCustomerId,
    shopify_customer_id: match['Shopify Customer ID'] || '',
  });

  // ─── Backfill the Orders row that was waiting on this match ───────
  const ordersSheet = getOrdersSheet();
  const oh = ordersSheet.getRange(1, 1, 1, ordersSheet.getLastColumn()).getValues()[0];
  const rowIndex = findOrderRow(ordersSheet, findOrderIdByShopifyId(ordersSheet, oh, match['Shopify Order ID']));
  if (rowIndex) {
    const custCol = oh.indexOf('Customer ID') + 1;
    const userCol = oh.indexOf('Primary Username') + 1;
    ordersSheet.getRange(rowIndex, custCol).setValue(linkedCustomerId);
    // Pull the now-confirmed customer's real Primary Username onto the order.
    const custData = sheetToObjects(getCustomersSheet());
    const cust = custData.find(c => c['Customer ID'] === linkedCustomerId);
    if (cust && userCol > 0) {
      ordersSheet.getRange(rowIndex, userCol).setValue(cust['Primary Username'] || '');
    }
  }

  return jsonResponse({ result: 'resolved', customer_id: linkedCustomerId });
}

// Appends a Shopify Customer ID to a customer's existing list, if not already present.
function appendShopifyIdToCustomer(customerId, newShopifyId) {
  if (!newShopifyId) return;
  const sheet = getCustomersSheet();
  const data = sheet.getDataRange().getValues();
  const headers = data[0];
  const idCol = headers.indexOf('Customer ID');
  const shopCol = headers.indexOf('Shopify Customer ID');

  for (let i = 1; i < data.length; i++) {
    if (String(data[i][idCol]) === String(customerId)) {
      const current = String(data[i][shopCol] || '').split('/').map(s => s.trim()).filter(Boolean);
      if (!current.includes(String(newShopifyId))) {
        current.push(String(newShopifyId));
        setCustomerCell(sheet, i + 1, shopCol + 1, 'Shopify Customer ID', current.join('/'));
      }
      return;
    }
  }
}

// Fills in any BLANK fields on the customer record using the incoming
// match data -- never overwrites something already on file, only adds
// what's genuinely missing (e.g. Phone Full, Email, First/Surname if empty).
function enrichCustomerFromMatch(customerId, match) {
  const sheet = getCustomersSheet();
  const data = sheet.getDataRange().getValues();
  const headers = data[0];
  const idCol = headers.indexOf('Customer ID');

  const fieldsToFill = {
    'Phone Full': match['Incoming Phone'],
    'Email': match['Incoming Email'],
  };
  const nameParts = String(match['Incoming Name'] || '').split(' ').filter(Boolean);
  if (nameParts.length) {
    fieldsToFill['First Name'] = nameParts[0];
    fieldsToFill['Surname'] = nameParts.slice(1).join(' ');
  }

  for (let i = 1; i < data.length; i++) {
    if (String(data[i][idCol]) !== String(customerId)) continue;
    Object.keys(fieldsToFill).forEach(field => {
      const colIdx = headers.indexOf(field);
      const newVal = fieldsToFill[field];
      if (colIdx >= 0 && newVal && !String(data[i][colIdx] || '').trim()) {
        setCustomerCell(sheet, i + 1, colIdx + 1, field, newVal);
      }
    });
    return;
  }
}

// Finds the Order ID whose Shopify Order ID matches, so we can locate its row.
function findOrderIdByShopifyId(ordersSheet, headers, shopifyOrderId) {
  const iShop = headers.indexOf('Shopify Order ID');
  const iOrderId = headers.indexOf('Order ID');
  const lastRow = ordersSheet.getLastRow();
  if (lastRow < 2) return null;
  const data = ordersSheet.getRange(2, 1, lastRow - 1, headers.length).getValues();
  for (const row of data) {
    if (String(row[iShop]) === String(shopifyOrderId)) return row[iOrderId];
  }
  return null;
}
// ═══════════════════════════════════════════════════════════════════════════
// GET SHOPIFY MATCHES — review UI / pending-count badge
// ═══════════════════════════════════════════════════════════════════════════

function getShopifyMatches(e) {
  const matches = sheetToObjects(getShopifyMatchesSheet());
  const statusFilter = e.parameter.decision || 'Pending';
  const filtered = statusFilter === 'all'
    ? matches
    : matches.filter(m => m['Decision'] === statusFilter);
  return jsonResponse({ records: filtered });
}
// ═══════════════════════════════════════════════════════════════════════════
// TIKTOK IMPORT HISTORY — accessor + writer
// ═══════════════════════════════════════════════════════════════════════════

function getTikTokImportHistorySheet() {
  return SpreadsheetApp.openById(ORDERS_SHEET_ID).getSheetByName('TikTok Import History');
}

// Column order matches the sheet's header row exactly. Writing by explicit
// header lookup (not fixed array position) so this stays correct even if
// columns get reordered later.
const TIKTOK_HISTORY_FIELD_MAP = {
  'Order ID':                       'order_id',
  'SKU ID':                         'sku_id',
  'Seller SKU':                     'seller_sku',
  'Product Name':                   'product_name',
  'Variation':                      'variation',
  'Quantity':                       'quantity',
  'Order Status':                   'order_status',
  'Order Substatus':                'order_substatus',
  'Cancelation/Return Type':        'cancel_return_type',
  'SKU Unit Price':                 'sku_unit_price',
  'SKU Subtotal Before Discount':   'sku_subtotal_before',
  'SKU Platform Discount':          'sku_platform_discount',
  'SKU Seller Discount':            'sku_seller_discount',
  'SKU Subtotal After Discount':    'sku_subtotal_after',
  'Shipping Fee After Discount':    'shipping_fee_after',
  'Original Shipping Fee':          'shipping_fee_original',
  'Shipping Fee Seller Discount':   'shipping_fee_seller_disc',
  'Shipping Fee Platform Discount': 'shipping_fee_platform_disc',
  'Payment Platform Discount':      'payment_platform_discount',
  'Retail Delivery Fee':            'retail_delivery_fee',
  'Order Amount':                   'order_amount',
  'Order Refund Amount':            'order_refund_amount',
  'Created Time':                   'created_time',
  'Paid Time':                      'paid_time',
  'RTS Time':                       'rts_time',
  'Shipped Time':                   'shipped_time',
  'Delivered Time':                 'delivered_time',
  'Cancelled Time':                 'cancelled_time',
  'Cancel By':                      'cancel_by',
  'Cancel Reason':                  'cancel_reason',
  'Fulfillment Type':               'fulfillment_type',
  'Warehouse Name':                 'warehouse_name',
  'Tracking ID':                    'tracking_id',
  'Delivery Option Type':           'delivery_option_type',
  'Delivery Option':                'delivery_option',
  'Shipping Provider':              'shipping_provider',
  'Buyer Username':                 'buyer_username',
  'Payment Method':                 'payment_method',
  'Weight (kg)':                    'weight_kg',
  'Product Category':               'product_category',
  'Order Channel':                  'order_channel',
  'Creator Handle':                 'creator_handle',
};

// Appends one row per history record (already one-per-line-item from the
// Python side) to the TikTok Import History sheet, in ONE batched write.
// Call once per import batch with every shipment's import_history combined,
// same performance pattern as resolveLineItemsBatch.
// ─── Force plain-text format on ID-like columns before writing ────────────
// Google Sheets can still auto-convert a cell to a number even when Apps
// Script sends a genuine JS string, if the string looks fully numeric.
// For most IDs this only affects display (scientific notation), but for
// very large integers (18+ digits, as TikTok's Order/SKU/Tracking IDs are)
// JS/Sheets number representation has an actual precision ceiling -- IDs
// happening to end in 3+ zeros are especially likely to have their true
// trailing digits silently replaced by rounding. Explicitly forcing the
// column's number format to "@" (plain text) BEFORE the write stops Sheets
// from ever attempting the conversion, preserving the exact digits.
// startRow/numRows describe the range to format (1-indexed, header-exclusive).
function forceTextFormat(sheet, headers, columnNames, startRow, numRows) {
  if (numRows <= 0) return;
  columnNames.forEach(name => {
    const col = headers.indexOf(name);
    if (col >= 0) {
      sheet.getRange(startRow, col + 1, numRows, 1).setNumberFormat('@');
    }
  });
}

const TIKTOK_ID_COLUMNS = ['Order ID', 'SKU ID', 'Tracking ID'];

function appendTikTokImportHistory(allHistoryRecords) {
  if (!allHistoryRecords || !allHistoryRecords.length) return;

  const sheet = getTikTokImportHistorySheet();
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];

  const rows = allHistoryRecords.map(rec => {
    return headers.map(h => {
      if (h === 'Imported Date') return nowISO();
      const key = TIKTOK_HISTORY_FIELD_MAP[h];
      return key ? (rec[key] !== undefined ? rec[key] : '') : '';
    });
  });

  const startRow = sheet.getLastRow() + 1;
  forceTextFormat(sheet, headers, TIKTOK_ID_COLUMNS, startRow, rows.length);
  sheet.getRange(startRow, 1, rows.length, rows[0].length).setValues(rows);
}

// Wraps appendTikTokImportHistory() with an Order ID + SKU ID dedupe
// check against rows already on the sheet, using the same backfillKey()
// convention as the historical backfill tool. Called by the DAILY import
// (importTikTokOrders) -- the backfill tool has its own separate,
// already-correct dedupe logic and does not use this wrapper.
function appendTikTokImportHistoryDeduped(allHistoryRecords) {
  if (!allHistoryRecords || !allHistoryRecords.length) return;

  const sheet = getTikTokImportHistorySheet();
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const orderIdCol = headers.indexOf('Order ID');
  const skuIdCol   = headers.indexOf('SKU ID');

  const existingKeys = {};
  if (orderIdCol >= 0 && skuIdCol >= 0 && sheet.getLastRow() > 1) {
    const existing = sheet.getRange(2, 1, sheet.getLastRow() - 1, headers.length).getValues();
    existing.forEach(r => {
      existingKeys[backfillKey(r[orderIdCol], r[skuIdCol])] = true;
    });
  }

  // Also guard against duplicates WITHIN this same incoming batch (e.g.
  // the same order/SKU appearing twice in one CSV payload).
  const seenThisRun = {};
  const toWrite = [];
  allHistoryRecords.forEach(rec => {
    const key = backfillKey(rec.order_id, rec.sku_id);
    if (existingKeys[key] || seenThisRun[key]) return;
    seenThisRun[key] = true;
    toWrite.push(rec);
  });

  appendTikTokImportHistory(toWrite);
}

// ─── HISTORICAL / BACKFILL CSV IMPORT ──────────────────────────────────────
//
// Standalone tool (Ajustes page). Enriches TikTok Import History ONLY --
// never touches Orders or QC, by design (see To-Do list for full scoping).
//
// Match key: Order ID + SKU ID (trimmed -- TikTok's export pads these with
// a stray trailing tab character, same whitespace-trim convention used
// everywhere else in this file).
//
// Per matched row:
//   - 'Order Status' / 'Order Substatus' are ALWAYS overwritten with the
//     incoming CSV value (these are live lifecycle fields expected to
//     change run over run).
//   - Shipped Time / Delivered Time / Cancelled Time / Cancel By /
//     Cancel Reason are filled ONLY IF CURRENTLY BLANK (one-time facts,
//     never overwritten once set -- protects against a stale re-upload).
// Unmatched rows are inserted fresh with whatever fields are present.
//
// Records with substatus 'Awaiting shipment' or 'Unpaid' should already be
// filtered out client-side before this is ever called (no Tracking ID yet,
// not useful), but this function silently skips them too as a safety net
// in case the frontend filter is ever bypassed.

const BACKFILL_SKIP_SUBSTATUSES = ['Awaiting shipment', 'Unpaid'];
const BACKFILL_FILL_ONLY_FIELDS = [
  'Shipped Time', 'Delivered Time', 'Cancelled Time', 'Cancel By', 'Cancel Reason'
];

// order_id is digits-only here, matching the VPS's own cleaning
// (tiktok_lib.py: re.sub(r"[^\d]", "", ...)) -- previously this only
// .trim()'d whitespace, which happened to work because TikTok's stray
// character has so far always been a trailing tab on Order ID, but any
// other stray non-digit character there would make the VPS-cleaned and
// Apps-Script-cleaned versions of the same order ID diverge and silently
// fail to match. sku_id is left as trim-only, same as the VPS -- SKU IDs
// are not digit-stripped on that side, so stripping them here would
// break matching for any SKU ID containing non-digit characters.
function backfillKey(orderId, skuId) {
  return String(orderId || '').replace(/\D/g, '') + '||' + String(skuId || '').trim();
}

// Shared by both preview and commit so the two can never drift apart.
// dryRun = true -> compute counts only, no writes.
function runTikTokBackfill(records, dryRun) {
  const sheet = getTikTokImportHistorySheet();
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const iOrderId = headers.indexOf('Order ID');
  const iSkuId = headers.indexOf('SKU ID');

  const lastRow = sheet.getLastRow();
  const existingData = lastRow > 1 ? sheet.getRange(2, 1, lastRow - 1, headers.length).getValues() : [];

  // Build a lookup: "orderId||skuId" -> row index into existingData
  const rowIndexByKey = {};
  existingData.forEach((row, i) => {
    rowIndexByKey[backfillKey(row[iOrderId], row[iSkuId])] = i;
  });

  let updatedCount = 0, insertedCount = 0, skippedCount = 0;
  const newRows = [];
  const touchedRowIndexes = {};  // dedupe -- only meaningful for the summary

  records.forEach(rec => {
    const substatus = String(rec.order_substatus || '').trim();
    if (BACKFILL_SKIP_SUBSTATUSES.indexOf(substatus) !== -1) {
      skippedCount++;
      return;
    }

    const orderId = String(rec.order_id || '').trim();
    const skuId = String(rec.sku_id || '').trim();
    if (!orderId || !skuId) { skippedCount++; return; }

    const key = backfillKey(orderId, skuId);
    const rowIdx = rowIndexByKey[key];

    if (rowIdx !== undefined) {
      // ─── Found: overwrite status fields, fill-only the lifecycle fields ──
      if (!touchedRowIndexes[rowIdx]) { updatedCount++; touchedRowIndexes[rowIdx] = true; }
      if (dryRun) return;

      headers.forEach((h, colIdx) => {
        if (h === 'Order Status' || h === 'Order Substatus') {
          const mapKey = TIKTOK_HISTORY_FIELD_MAP[h];
          const incoming = rec[mapKey];
          if (incoming !== undefined && incoming !== '') {
            existingData[rowIdx][colIdx] = incoming;
          }
        } else if (BACKFILL_FILL_ONLY_FIELDS.indexOf(h) !== -1) {
          const mapKey = TIKTOK_HISTORY_FIELD_MAP[h];
          const incoming = rec[mapKey];
          const current = String(existingData[rowIdx][colIdx] || '').trim();
          if (!current && incoming !== undefined && incoming !== '') {
            existingData[rowIdx][colIdx] = incoming;
          }
        }
      });
    } else {
      // ─── Not found: insert fresh row, all available fields ────────────
      insertedCount++;
      if (dryRun) return;

      const newRow = headers.map(h => {
        if (h === 'Imported Date') return nowISO();
        const mapKey = TIKTOK_HISTORY_FIELD_MAP[h];
        return mapKey ? (rec[mapKey] !== undefined ? rec[mapKey] : '') : '';
      });
      newRows.push(newRow);
    }
  });

  if (!dryRun) {
    // Write back only the rows that changed (existingData was mutated in place),
    // then append any brand-new rows -- both in single batched calls.
    if (existingData.length) {
            // Only the 7 columns this tool can change are written back, not the whole sheet
      ['Order Status', 'Order Substatus'].concat(BACKFILL_FILL_ONLY_FIELDS).forEach(name => {
        const c = headers.indexOf(name);
        if (c < 0) return;
        sheet.getRange(2, c + 1, existingData.length, 1).setValues(existingData.map(r => [r[c]]));
      });
            // (full-sheet rewrite removed: too slow at 12k+ rows)
    }
    if (newRows.length) {
      const startRow = sheet.getLastRow() + 1;
      forceTextFormat(sheet, headers, TIKTOK_ID_COLUMNS, startRow, newRows.length);
      sheet.getRange(startRow, 1, newRows.length, headers.length).setValues(newRows);
    }
  }

  return {
    updated: updatedCount,
    inserted: insertedCount,
    skipped: skippedCount,
    total: records.length,
  };
}

function backfillTikTokHistoryPreview(body) {
  const result = runTikTokBackfill(body.records || [], true);
  return jsonResponse(result);
}

function backfillTikTokHistoryCommit(body) {
  const result = runTikTokBackfill(body.records || [], false);
  logAuditEvent('backfill_tiktok_commit', 'TikTokImportHistory', '', result);
  return jsonResponse(result);
}

// ═══════════════════════════════════════════════════════════════════════════
// PRODUCT CATALOG DUPLICATE DETECTION + MERGE + UNDO
// ═══════════════════════════════════════════════════════════════════════════
//
// Mirrors the Customer duplicate-finder/merge tool's shape (threshold scan,
// dismiss, merge, undo) but is a two-level merge: Parents match by fuzzy
// name similarity, then each of the losing Parent's Variants must be
// individually paired against a Variant on the keeper Parent (or left
// unmapped as genuinely unique) before anything is written. This is
// necessary because Orders references Catalog IDs (Variant-level), not
// Parent IDs -- a Parent-only merge with no variant reconciliation would
// leave Orders pointing at orphaned or duplicate Catalog IDs.
//
// New sheet tabs required (same workbook as Product Parents/Variants,
// i.e. PRODUCT_CATALOG_SHEET_ID):
//   "Dismissed Product Pairs" -- columns: Parent ID A | Parent ID B | Dismissed Date
//   "Product Merge History" -- columns: Merge ID | Kept Parent ID |
//     Kept Parent Name | Merged Parent ID | Merged Parent Name |
//     Variant Pairs (JSON) | Orders Repointed | Status | Merged Date |
//     Undone Date | Keeper Snapshot (JSON)
// Vel: please create both tabs with these exact header rows before this
// code is used.

function getDismissedProductPairsSheet() {
  return SpreadsheetApp.openById(PRODUCT_CATALOG_SHEET_ID).getSheetByName('Dismissed Product Pairs');
}

function getProductMergeHistorySheet() {
  return SpreadsheetApp.openById(PRODUCT_CATALOG_SHEET_ID).getSheetByName('Product Merge History');
}

function dismissedProductPairKey(idA, idB) {
  return [String(idA), String(idB)].sort().join('|');
}

const PRODUCT_DUPLICATE_SCORE_THRESHOLD = 55; // same default as customer duplicates

// ─── Scan: find likely-duplicate PARENTS ───────────────────────────────────
// Fuzzy-matches every non-merged Parent Name against every other, using the
// same stringSimilarity() already used for SKU->Parent resolution. Returns
// each pair already bundled with both Parents' Variants AND a suggested
// variant-to-variant pairing (see suggestVariantPairs below), so the
// frontend can render the whole merge screen from one call.
function findDuplicateProducts(e) {
  const threshold = e.parameter.threshold
    ? Math.max(0, Math.min(100, parseInt(e.parameter.threshold, 10) || PRODUCT_DUPLICATE_SCORE_THRESHOLD))
    : PRODUCT_DUPLICATE_SCORE_THRESHOLD;

  const parents = sheetToObjects(getProductParentsSheet())
    .filter(p => !String(p['Parent Name'] || '').includes('(merged→'));

  const allVariants = sheetToObjects(getProductVariantsSheet())
    .filter(v => !String(v['Variant Name'] || '').includes('(merged→'));

  const variantsByParent = {};
  allVariants.forEach(v => {
    const pid = String(v['Parent ID'] || '');
    if (!variantsByParent[pid]) variantsByParent[pid] = [];
    variantsByParent[pid].push(v);
  });

  const dismissed = new Set(
    sheetToObjects(getDismissedProductPairsSheet())
      .map(d => dismissedProductPairKey(d['Parent ID A'], d['Parent ID B']))
  );

  const pairs = [];
  for (let i = 0; i < parents.length; i++) {
    for (let j = i + 1; j < parents.length; j++) {
      const a = parents[i], b = parents[j];
      const pairKey = dismissedProductPairKey(a['Parent ID'], b['Parent ID']);
      if (dismissed.has(pairKey)) continue;

      const score = stringSimilarity(String(a['Parent Name'] || ''), String(b['Parent Name'] || ''));
      const scorePct = Math.round(score * 100);
      if (scorePct < threshold) continue;

      const variantsA = variantsByParent[a['Parent ID']] || [];
      const variantsB = variantsByParent[b['Parent ID']] || [];

      pairs.push({
        parent_a: a,
        parent_b: b,
        score: scorePct,
        variants_a: variantsA,
        variants_b: variantsB,
        suggested_variant_pairs: suggestVariantPairs(variantsA, variantsB),
      });
    }
  }

  pairs.sort((x, y) => y.score - x.score);
  return jsonResponse({ pairs: pairs });
}

// For each Variant in list B, finds its best fuzzy match (by Variant Name)
// in list A above a modest threshold, greedily and without letting two B
// variants claim the same A variant. Returns an array parallel to
// variants_b: { b_catalog_id, suggested_a_catalog_id | null }. The frontend
// pre-fills each B row's dropdown with this suggestion but the human always
// confirms/changes it before anything is written -- this is a starting
// point, not an auto-merge.
const VARIANT_SUGGEST_THRESHOLD = 0.5;

function suggestVariantPairs(variantsA, variantsB) {
  const claimedA = new Set();
  return variantsB.map(vb => {
    let best = null, bestScore = 0;
    variantsA.forEach(va => {
      if (claimedA.has(va['Catalog ID'])) return;
      const score = stringSimilarity(String(vb['Variant Name'] || ''), String(va['Variant Name'] || ''));
      if (score > bestScore) { bestScore = score; best = va; }
    });
    if (best && bestScore >= VARIANT_SUGGEST_THRESHOLD) {
      claimedA.add(best['Catalog ID']);
      return { b_catalog_id: vb['Catalog ID'], suggested_a_catalog_id: best['Catalog ID'] };
    }
    return { b_catalog_id: vb['Catalog ID'], suggested_a_catalog_id: null };
  });
}

// ─── Manual search-and-pick (alternative to the automatic fuzzy scan) ─────
// Returns every non-merged Parent with its total units sold across ALL its
// variants combined (summed from Orders' Product N Qty slots, matched by
// Catalog ID) so Vel can visually spot an obvious split product (e.g. two
// near-identical Parent Names each with a modest unit count that should
// really be one line with the combined total). Computed once per call by
// scanning Orders a single time and building one Catalog-ID -> qty map,
// not per-Parent, since a per-Parent Orders scan would be far too slow.
// The frontend filters this list client-side as the user types, avoiding a
// server round-trip per keystroke.
function searchProductsForMerge(e) {
  const parents = sheetToObjects(getProductParentsSheet())
    .filter(p => !String(p['Parent Name'] || '').includes('(merged→'));

  const allVariants = sheetToObjects(getProductVariantsSheet())
    .filter(v => !String(v['Variant Name'] || '').includes('(merged→'));

  const variantsByParent = {};
  const parentIdByCatalogId = {};
  allVariants.forEach(v => {
    const pid = String(v['Parent ID'] || '');
    if (!variantsByParent[pid]) variantsByParent[pid] = [];
    variantsByParent[pid].push(v);
    parentIdByCatalogId[String(v['Catalog ID'])] = pid;
  });

  // ─── One pass over Orders to sum Qty per Catalog ID ─────────────────
  const qtyByCatalogId = {};
  const ordersSheet = getOrdersSheet();
  const oLastRow = ordersSheet.getLastRow();
  if (oLastRow > 1) {
    const oLastCol = ordersSheet.getLastColumn();
    const oh = ordersSheet.getRange(1, 1, 1, oLastCol).getValues()[0];
    const oData = ordersSheet.getRange(2, 1, oLastRow - 1, oLastCol).getValues();
    const PRODUCT_SLOTS = 30;
    const slotCols = [];
    for (let n = 1; n <= PRODUCT_SLOTS; n++) {
      slotCols.push({
        catalogCol: oh.indexOf('Product ' + n + ' Catalog ID'),
        qtyCol: oh.indexOf('Product ' + n + ' Qty'),
      });
    }
    oData.forEach(row => {
      slotCols.forEach(slot => {
        if (slot.catalogCol < 0 || slot.qtyCol < 0) return;
        const cid = String(row[slot.catalogCol] || '');
        if (!cid) return;
        const qty = Number(row[slot.qtyCol]) || 0;
        qtyByCatalogId[cid] = (qtyByCatalogId[cid] || 0) + qty;
      });
    });
  }

  // ─── Sum each Parent's total from its variants' Catalog IDs ─────────
  const results = parents.map(p => {
    const variants = variantsByParent[p['Parent ID']] || [];
    const totalUnitsSold = variants.reduce((sum, v) => sum + (qtyByCatalogId[String(v['Catalog ID'])] || 0), 0);
    return {
      parent: p,
      variant_count: variants.length,
      total_units_sold: totalUnitsSold,
    };
  });

  results.sort((a, b) => b.total_units_sold - a.total_units_sold);
  return jsonResponse({ products: results });
}

// Given two Parent IDs (chosen manually), returns the same shape
// findDuplicateProducts would have produced for that pair -- so the
// existing merge screen can render it without any special-casing for
// "how this pair was found."
function getManualProductPair(e) {
  const idA = e.parameter.parent_id_a;
  const idB = e.parameter.parent_id_b;
  if (!idA || !idB) return jsonResponse({ error: 'parent_id_a and parent_id_b are required' });

  const parents = sheetToObjects(getProductParentsSheet());
  const a = parents.find(p => String(p['Parent ID']) === String(idA));
  const b = parents.find(p => String(p['Parent ID']) === String(idB));
  if (!a || !b) return jsonResponse({ error: 'One or both parents not found' });

  const allVariants = sheetToObjects(getProductVariantsSheet())
    .filter(v => !String(v['Variant Name'] || '').includes('(merged→'));
  const variantsA = allVariants.filter(v => String(v['Parent ID']) === String(idA));
  const variantsB = allVariants.filter(v => String(v['Parent ID']) === String(idB));

  return jsonResponse({
    pair: {
      parent_a: a,
      parent_b: b,
      score: null,
      variants_a: variantsA,
      variants_b: variantsB,
      suggested_variant_pairs: suggestVariantPairs(variantsA, variantsB),
    }
  });
}

function dismissProductPairAction(body) {
  const idA = body.parent_id_a;
  const idB = body.parent_id_b;
  if (!idA || !idB) return jsonResponse({ error: 'parent_id_a and parent_id_b are required' });

  getDismissedProductPairsSheet().appendRow([idA, idB, nowISO()]);
  logAuditEvent('dismiss_product_pair', 'Product', idA, { other_id: idB });
  return jsonResponse({ result: 'dismissed' });
}

// ─── Merge ──────────────────────────────────────────────────────────────
//
// body shape:
// {
//   keep_parent_id, lose_parent_id,
//   variant_pairs: [ { keep_catalog_id, lose_catalog_id } , ... ]
//     -- one entry per PAIRED variant (both sides confirmed as the same).
//        Any variant NOT listed here (on either side) is treated as
//        genuinely unique and is simply re-pointed to the surviving
//        Parent ID without being touched otherwise.
// }
//
// For each paired entry: unions TikTok SKU IDs onto the keeper variant,
// backfills blank Your SKU/Notes from the loser, repoints every Orders row
// across all 30 Product N Catalog ID slots from the loser's Catalog ID to
// the keeper's, and marks the loser variant with a (merged→...) sentinel.
// Every OTHER variant belonging to the losing Parent (paired or not) has
// its Parent ID updated to the surviving Parent ID. Finally the losing
// Parent itself is marked (merged→...), never deleted, mirroring the
// customer-merge convention.
function mergeProductsAction(body) {
  const keepParentId = body.keep_parent_id;
  const loseParentId = body.lose_parent_id;
  const variantPairs = body.variant_pairs || [];
  if (!keepParentId || !loseParentId || keepParentId === loseParentId) {
    return jsonResponse({ error: 'keep_parent_id and lose_parent_id (different) are required' });
  }

  // ─── Load Parents ────────────────────────────────────────────────────
  const parentsSheet = getProductParentsSheet();
  const pData = parentsSheet.getDataRange().getValues();
  const pHeaders = pData[0];
  const pIdCol = pHeaders.indexOf('Parent ID');
  const pNameCol = pHeaders.indexOf('Parent Name');

  let keepParentRow = -1, loseParentRow = -1;
  for (let i = 1; i < pData.length; i++) {
    if (String(pData[i][pIdCol]) === String(keepParentId)) keepParentRow = i;
    if (String(pData[i][pIdCol]) === String(loseParentId)) loseParentRow = i;
  }
  if (keepParentRow === -1 || loseParentRow === -1) {
    return jsonResponse({ error: 'One or both parents not found' });
  }
  const keepParentName = String(pData[keepParentRow][pNameCol] || '');
  const loseParentName = String(pData[loseParentRow][pNameCol] || '');

  // ─── Load Variants ───────────────────────────────────────────────────
  const variantsSheet = getProductVariantsSheet();
  const vData = variantsSheet.getDataRange().getValues();
  const vHeaders = vData[0];
  const vCatalogCol = vHeaders.indexOf('Catalog ID');
  const vParentCol = vHeaders.indexOf('Parent ID');
  const vNameCol = vHeaders.indexOf('Variant Name');
  const vYourSkuCol = vHeaders.indexOf('Your SKU');
  const vTiktokSkusCol = vHeaders.indexOf('TikTok SKU IDs');
  const vNotesCol = vHeaders.indexOf('Notes');

  const variantRowByCatalogId = {};
  for (let i = 1; i < vData.length; i++) {
    variantRowByCatalogId[String(vData[i][vCatalogCol])] = i;
  }

  // Every change to the variants goes through this tracker so that ONLY the
  // cells that changed are written back. This function used to write the
  // entire Product Variants sheet back with setValues(), which re-parses
  // every cell -- including every 19-digit TikTok SKU ID -- on the way in.
  const vTrack = makeCellTracker(vData);
  const setCell = vTrack.set;

  // Snapshot every variant belonging to the LOSING parent, before any
  // mutation, so undo can fully restore Parent ID / SKU unions / names.
  const loserVariantCatalogIds = [];
  for (let i = 1; i < vData.length; i++) {
    if (String(vData[i][vParentCol]) === String(loseParentId)) {
      loserVariantCatalogIds.push(String(vData[i][vCatalogCol]));
    }
  }
  const variantSnapshot = {};
  loserVariantCatalogIds.forEach(cid => {
    const row = variantRowByCatalogId[cid];
    variantSnapshot[cid] = {
      parentId: String(vData[row][vParentCol] || ''),
      variantName: String(vData[row][vNameCol] || ''),
    };
  });
  const keeperVariantSnapshot = {}; // for paired keeper variants: pre-merge field values

  // ─── Apply each confirmed variant pair ────────────────────────────────
  const catalogIdRepointMap = {}; // loser Catalog ID -> keeper Catalog ID (only for paired variants)

  variantPairs.forEach(pair => {
    const keepRow = variantRowByCatalogId[pair.keep_catalog_id];
    const loseRow = variantRowByCatalogId[pair.lose_catalog_id];
    if (keepRow === undefined || loseRow === undefined) return;

    keeperVariantSnapshot[pair.keep_catalog_id] = {
      yourSku: String(vData[keepRow][vYourSkuCol] || ''),
      tiktokSkus: String(vData[keepRow][vTiktokSkusCol] || ''),
      notes: String(vData[keepRow][vNotesCol] || ''),
    };

    // Union TikTok SKU IDs
    const keepSkus = String(vData[keepRow][vTiktokSkusCol] || '').split(',').map(s => s.trim()).filter(Boolean);
    const loseSkus = String(vData[loseRow][vTiktokSkusCol] || '').split(',').map(s => s.trim()).filter(Boolean);
    const mergedSkus = [...new Set([...keepSkus, ...loseSkus])];
    setCell(keepRow, vTiktokSkusCol, mergedSkus.join(', '));

    // Backfill blank fields from loser
    if (!String(vData[keepRow][vYourSkuCol] || '').trim() && vData[loseRow][vYourSkuCol]) {
      setCell(keepRow, vYourSkuCol, vData[loseRow][vYourSkuCol]);
    }
    const keeperNotes = String(vData[keepRow][vNotesCol] || '');
    const loserNotes = String(vData[loseRow][vNotesCol] || '');
    if (loserNotes && !keeperNotes.includes(loserNotes)) {
      setCell(keepRow, vNotesCol, keeperNotes ? keeperNotes + ' | ' + loserNotes : loserNotes);
    }

    // Mark the losing variant as merged (kept, not deleted)
    setCell(loseRow, vNameCol, String(vData[loseRow][vNameCol] || '') + ` (merged→${pair.keep_catalog_id})`);

    catalogIdRepointMap[pair.lose_catalog_id] = pair.keep_catalog_id;
  });

  // ─── Every OTHER variant of the losing Parent (unpaired, genuinely
  //     unique) simply moves under the surviving Parent ID ───────────────
  const pairedLoserCatalogIds = new Set(variantPairs.map(p => p.lose_catalog_id));
  loserVariantCatalogIds.forEach(cid => {
    if (pairedLoserCatalogIds.has(cid)) return; // already handled above
    const row = variantRowByCatalogId[cid];
    setCell(row, vParentCol, keepParentId);
  });

  vTrack.flush(variantsSheet, [vTiktokSkusCol, vYourSkuCol, vCatalogCol, vParentCol]);

  // ─── Repoint Orders across the 30 Product N Catalog ID slots ──────────
  // Reads only those 30 columns (plus Order ID) and writes back only the
  // columns that changed -- never the whole ~75-column sheet. Every cell
  // that moves is recorded (order + slot + original Catalog ID) so undo can
  // revert exactly those cells and nothing else.
  const ordersSheet = getOrdersSheet();
  const oh = ordersSheet.getRange(1, 1, 1, ordersSheet.getLastColumn()).getValues()[0];
  let ordersRepointed = 0;
  const movedCells = [];     // 'orderId|slot|originalCatalogId'

  if (ordersSheet.getLastRow() > 1 && Object.keys(catalogIdRepointMap).length) {
    const orderIdVals = readColumn(ordersSheet, oh.indexOf('Order ID'));
    const touchedRows = new Set();
    for (let n = 1; n <= 30; n++) {
      const col = oh.indexOf('Product ' + n + ' Catalog ID');
      if (col < 0) continue;
      const vals = readColumn(ordersSheet, col);
      const changed = [];
      vals.forEach((v, i) => {
        const cur = String(v || '');
        if (catalogIdRepointMap[cur]) {
          vals[i] = catalogIdRepointMap[cur];
          changed.push(i);
          touchedRows.add(i);
          movedCells.push(String(orderIdVals[i]) + '|' + n + '|' + cur);
        }
      });
      writeColumnChanges(ordersSheet, col, vals, changed);
    }
    ordersRepointed = touchedRows.size;
  }

  // ─── Mark the losing Parent (kept, not deleted) ────────────────────────
  pData[loseParentRow][pNameCol] = loseParentName + ` (merged→${keepParentId})`;
  parentsSheet.getRange(loseParentRow + 1, pNameCol + 1).setValue(pData[loseParentRow][pNameCol]);

  // Store exactly which order cells moved, so undo can revert those and
  // nothing else -- as long as it fits in one cell (50,000 character cap).
  const mergeSnapshot = { keeperVariantSnapshot: keeperVariantSnapshot, loserVariantSnapshot: variantSnapshot };
  if (JSON.stringify(mergeSnapshot).length + JSON.stringify(movedCells).length < 45000) {
    mergeSnapshot.movedCells = movedCells;
  } else {
    mergeSnapshot.movedCellsOverflow = movedCells.length;
  }

  logProductMergeHistory(
    keepParentId, keepParentName, loseParentId, loseParentName,
    variantPairs, ordersRepointed,
    mergeSnapshot
  );
  logAuditEvent('merge_products', 'Product', keepParentId, {
    merged_id: loseParentId, merged_name: loseParentName,
    variants_merged: variantPairs.length, orders_repointed: ordersRepointed,
  });

  return jsonResponse({
    result: 'merged',
    kept_parent_id: keepParentId,
    merged_parent_id: loseParentId,
    variants_merged: variantPairs.length,
    variants_reassigned: loserVariantCatalogIds.length - variantPairs.length,
    orders_repointed: ordersRepointed,
  });
}

function logProductMergeHistory(keepId, keptName, loseId, loserName, variantPairs, ordersRepointed, snapshot) {
  getProductMergeHistorySheet().appendRow([
    'PMERGE-' + Utilities.getUuid().slice(0, 8),
    keepId,
    keptName,
    loseId,
    loserName,
    JSON.stringify(variantPairs),
    ordersRepointed,
    'Activo',
    nowISO(),
    '',
    JSON.stringify(snapshot),
  ]);
}

function getProductMergeHistory(e) {
  return jsonResponse({ records: sheetToObjects(getProductMergeHistorySheet()) });
}

// ─── Undo ──────────────────────────────────────────────────────────────
// Reverses a product merge: restores the loser Parent's original name,
// restores every loser Variant's original Parent ID and Variant Name
// (undoing the (merged→...) sentinel), restores the keeper Variants'
// pre-merge Your SKU/TikTok SKU IDs/Notes from the snapshot, and repoints
// Orders rows back to the original (loser) Catalog IDs. Refuses if already
// undone.
function undoProductMergeAction(body) {
  const mergeId = body.merge_id;
  if (!mergeId) return jsonResponse({ error: 'merge_id is required' });

  const historySheet = getProductMergeHistorySheet();
  const hData = historySheet.getDataRange().getValues();
  const hHeaders = hData[0];
  const iMergeId = hHeaders.indexOf('Merge ID');
  const iKeepId = hHeaders.indexOf('Kept Parent ID');
  const iLoseId = hHeaders.indexOf('Merged Parent ID');
  const iVariantPairs = hHeaders.indexOf('Variant Pairs (JSON)');
  const iStatus = hHeaders.indexOf('Status');
  const iUndoneDate = hHeaders.indexOf('Undone Date');
  const iSnapshot = hHeaders.indexOf('Keeper Snapshot (JSON)');

  let historyRow = -1, record = null;
  for (let i = 1; i < hData.length; i++) {
    if (String(hData[i][iMergeId]) === String(mergeId)) { historyRow = i; record = hData[i]; break; }
  }
  if (historyRow === -1) return jsonResponse({ error: 'Merge record not found' });
  if (record[iStatus] === 'Deshecho') return jsonResponse({ error: 'This merge was already undone' });

  const keepId = record[iKeepId];
  const loseId = record[iLoseId];
  const variantPairs = JSON.parse(record[iVariantPairs] || '[]');
  const snapshot = JSON.parse(record[iSnapshot] || '{}');
  const keeperVariantSnapshot = snapshot.keeperVariantSnapshot || {};
  const loserVariantSnapshot = snapshot.loserVariantSnapshot || {};

  // Checked BEFORE anything is changed, so a refusal never leaves a
  // half-undone merge behind.
  if (snapshot.movedCellsOverflow) {
    return jsonResponse({ error: 'Este merge movió demasiados pedidos (' + snapshot.movedCellsOverflow +
      ') para deshacerse de forma segura y automática. No se cambió nada.' });
  }

  // ─── Restore Parent ────────────────────────────────────────────────
  const parentsSheet = getProductParentsSheet();
  const pData = parentsSheet.getDataRange().getValues();
  const pIdCol = pData[0].indexOf('Parent ID');
  const pNameCol = pData[0].indexOf('Parent Name');
  for (let i = 1; i < pData.length; i++) {
    if (String(pData[i][pIdCol]) === String(loseId)) {
      const original = String(pData[i][pNameCol] || '').replace(` (merged→${keepId})`, '');
      parentsSheet.getRange(i + 1, pNameCol + 1).setValue(original);
      break;
    }
  }

  // ─── Restore Variants ────────────────────────────────────────────────
  const variantsSheet = getProductVariantsSheet();
  const vData = variantsSheet.getDataRange().getValues();
  const vHeaders = vData[0];
  const vCatalogCol = vHeaders.indexOf('Catalog ID');
  const vParentCol = vHeaders.indexOf('Parent ID');
  const vNameCol = vHeaders.indexOf('Variant Name');
  const vYourSkuCol = vHeaders.indexOf('Your SKU');
  const vTiktokSkusCol = vHeaders.indexOf('TikTok SKU IDs');
  const vNotesCol = vHeaders.indexOf('Notes');

  const rowByCatalogId = {};
  for (let i = 1; i < vData.length; i++) rowByCatalogId[String(vData[i][vCatalogCol])] = i;

  // Only changed cells are written back (see the matching note in
  // mergeProductsAction) -- never the whole Product Variants sheet.
  const vTrack = makeCellTracker(vData);
  const setCell = vTrack.set;

  // Restore every loser variant's Parent ID + Variant Name
  Object.keys(loserVariantSnapshot).forEach(cid => {
    const row = rowByCatalogId[cid];
    if (row === undefined) return;
    setCell(row, vParentCol, loserVariantSnapshot[cid].parentId);
    setCell(row, vNameCol, loserVariantSnapshot[cid].variantName);
  });

  // Restore keeper variants' pre-merge field values (undoes the SKU union)
  Object.keys(keeperVariantSnapshot).forEach(cid => {
    const row = rowByCatalogId[cid];
    if (row === undefined) return;
    setCell(row, vYourSkuCol, keeperVariantSnapshot[cid].yourSku);
    setCell(row, vTiktokSkusCol, keeperVariantSnapshot[cid].tiktokSkus);
    setCell(row, vNotesCol, keeperVariantSnapshot[cid].notes);
  });

  vTrack.flush(variantsSheet, [vTiktokSkusCol, vYourSkuCol, vCatalogCol, vParentCol]);

  // ─── Repoint Orders back to the loser's Catalog IDs ───────────────────
  const ordersSheet = getOrdersSheet();
  const oh = ordersSheet.getRange(1, 1, 1, ordersSheet.getLastColumn()).getValues()[0];
  let ordersReverted = 0;

  if (ordersSheet.getLastRow() > 1 && variantPairs.length) {
    const forwardMap = {};   // loser Catalog ID  -> keeper Catalog ID
    const reverseMap = {};   // keeper Catalog ID -> loser Catalog ID
    variantPairs.forEach(p => {
      forwardMap[p.lose_catalog_id] = p.keep_catalog_id;
      reverseMap[p.keep_catalog_id] = p.lose_catalog_id;
    });
    const touchedRows = new Set();

    if (Array.isArray(snapshot.movedCells)) {
      // Exact revert: ONLY the cells this merge moved. The previous version
      // reverted EVERY order pointing at the keeper variant -- including
      // orders that belonged to the keeper long before the merge -- so
      // undoing a merge of a 500-order variant with a 20-order duplicate
      // would have moved all 520 orders onto the duplicate.
      const orderIdVals = readColumn(ordersSheet, oh.indexOf('Order ID'));
      const rowById = {};
      orderIdVals.forEach((v, i) => { rowById[String(v)] = i; });
      const colState = {};   // column index -> { vals, changed }

      snapshot.movedCells.forEach(entry => {
        const parts = String(entry).split('|');
        const rowIdx = rowById[parts[0]];
        const slot = parseInt(parts[1], 10);
        const original = parts[2];
        if (rowIdx === undefined) return;               // order deleted since the merge
        const col = oh.indexOf('Product ' + slot + ' Catalog ID');
        if (col < 0) return;
        if (!colState[col]) colState[col] = { vals: readColumn(ordersSheet, col), changed: [] };
        const st = colState[col];
        // Only revert a cell that STILL holds the keeper ID this merge wrote;
        // if someone has since edited that order, leave it alone.
        if (String(st.vals[rowIdx] || '') !== forwardMap[original]) return;
        st.vals[rowIdx] = original;
        st.changed.push(rowIdx);
        touchedRows.add(rowIdx);
      });

      Object.keys(colState).forEach(col => {
        writeColumnChanges(ordersSheet, Number(col), colState[col].vals, colState[col].changed);
      });
    } else {
      // Merge logged before moved cells were recorded: original behaviour
      // (reverts every order currently pointing at a merged keeper variant).
      for (let n = 1; n <= 30; n++) {
        const col = oh.indexOf('Product ' + n + ' Catalog ID');
        if (col < 0) continue;
        const vals = readColumn(ordersSheet, col);
        const changed = [];
        vals.forEach((v, i) => {
          const cur = String(v || '');
          if (reverseMap[cur]) {
            vals[i] = reverseMap[cur];
            changed.push(i);
            touchedRows.add(i);
          }
        });
        writeColumnChanges(ordersSheet, col, vals, changed);
      }
    }
    ordersReverted = touchedRows.size;
  }

  historySheet.getRange(historyRow + 1, iStatus + 1).setValue('Deshecho');
  if (iUndoneDate >= 0) historySheet.getRange(historyRow + 1, iUndoneDate + 1).setValue(nowISO());
  logAuditEvent('undo_product_merge', 'Product', keepId, { merge_id: mergeId, restored_id: loseId, orders_reverted: ordersReverted });

  return jsonResponse({ result: 'undone', merge_id: mergeId, orders_reverted: ordersReverted });
}

// ═══════════════════════════════════════════════════════════════════════════
// DUPLICATE CUSTOMER DETECTION
// ═══════════════════════════════════════════════════════════════════════════

// ─── Duplicate finder: how pairs are found and scored ──────────────────────
//
// WHY THIS WAS REWRITTEN. The previous finder only compared customers who
// shared the exact same City string, so a real duplicate was never even
// looked at if one record said "Querétaro", the other "Queretaro" and a
// third had no city. Its phone comparison could not compare a masked TikTok
// number ("953*****58") against a full Shopify number at all, and treated
// "+52 953..." and "953..." as different people. Customers imported from the
// original spreadsheet only carry a phone + an initial, which could just
// barely reach the threshold and never exceed it.
//
// HOW IT WORKS NOW
//  1. Each customer is normalised ONCE (accents stripped, ZIPs padded back
//     to 5 digits, phones reduced to comparable digits, initials derived).
//  2. Candidate pairs are generated from SEVERAL independent keys (same
//     phone ending, ZIP, email, Shopify ID, similar username, same name) --
//     any shared key makes two customers worth comparing. City is no longer
//     a gate.
//  3. Each pair is scored only on the signals BOTH records actually have.
//     A signal that is missing on either side is skipped, not counted as a
//     mismatch, and a pair with very little to compare is scaled down so a
//     single coincidence can't look like a certainty.
//  4. A few decisive identifiers (same Shopify ID, same email, same
//     username/alias, same full phone) set a minimum score.
//  5. Every pair carries a plain-language list of WHY it matched.
// This only SUGGESTS pairs. Nothing is merged without a human decision.

const DUPLICATE_SCORE_THRESHOLD = 55;
const DUP_MAX_PAIRS = 1000;       // cap on how many pairs one scan returns
const DUP_MAX_BUCKET = 250;       // a key shared by more customers than this is too common to be useful
const DUP_WEIGHTS = { phone: 30, username: 15, street: 15, name: 10, initials: 10, zip: 10, city: 5, email: 5 };
const DUP_REQUIRED_WEIGHT = 60;   // below this much comparable evidence, scores are scaled down
const DUP_STREET_NOISE = ['calle', 'col', 'colonia', 'av', 'avenida', 'no', 'num', 'numero', 'int',
  'interior', 'ext', 'exterior', 'fracc', 'fraccionamiento', 'cp', 'sn', 's', 'n'];

function dupStripAccents(s) {
  return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

// lowercase, no accents, punctuation -> spaces, single spaces
function dupNorm(s) {
  return dupStripAccents(s).toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

// Mexican postcodes are 5 digits and every CDMX one starts with 0. If a
// sheet ever stored one as a number (01000 -> 1000), put the zero back.
function dupZip(z) {
  const d = String(z || '').replace(/\D/g, '');
  if (!d) return '';
  return d.length < 5 ? d.padStart(5, '0') : d.slice(0, 5);
}

// Similarity 0..1 for short free text (street, name): the better of
// character-level similarity and word overlap, so word order doesn't matter.
function dupTextSim(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const ta = a.split(' ').filter(Boolean), tb = b.split(' ').filter(Boolean);
  const setA = new Set(ta);
  let inter = 0;
  new Set(tb).forEach(t => { if (setA.has(t)) inter++; });
  const union = new Set(ta.concat(tb)).size;
  const jaccard = union ? inter / union : 0;
  const ratio = Math.min(a.length, b.length) / Math.max(a.length, b.length);
  const lev = ratio < 0.5 ? 0 : shopifyStringSimilarity(a, b);
  return Math.max(lev, jaccard);
}

// Similarity 0..1 for single-token handles. Anything under 0.75 is not
// worth reporting, so skip the expensive comparison when lengths rule it out.
function dupFastSim(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (Math.min(a.length, b.length) / Math.max(a.length, b.length) < 0.75) return 0;
  return shopifyStringSimilarity(a, b);
}

// A phone reduced to what can be compared: a full 10-digit number
// (country code removed) and/or the digits TikTok leaves visible around the
// mask ("(+52)953*****58" -> prefix 52953, suffix 58).
function dupPhoneFeatures(partial, full) {
  const out = { full10: '', prefix: '', suffix: '' };
  const toTen = d => (d.length > 10 ? d.slice(-10) : d);

  const f = normalizePhone(full);
  if (f.length >= 10) out.full10 = toTen(f);

  const p = String(partial || '');
  if (p.indexOf('*') === -1) {
    // Not masked: a complete number that ended up in the "partial" column.
    const pd = normalizePhone(p);
    if (!out.full10 && pd.length >= 10) out.full10 = toTen(pd);
    return out;
  }
  const digits = p.replace(/[^\d*]/g, '');
  const pm = digits.match(/^(\d+)\*/);
  const sm = digits.match(/\*(\d+)$/);
  let prefix = pm ? pm[1] : '';
  if (prefix.length >= 4 && prefix.indexOf('52') === 0) prefix = prefix.slice(2);   // drop country code
  out.prefix = prefix;
  out.suffix = sm ? sm[1] : '';
  return out;
}

// Turns "does the visible start match / does the visible end match" into a
// similarity. A contradiction in either part means different numbers.
// A match on both parts is strong but not certain (only ~5 digits are
// visible); a match on one part alone is weak evidence.
function dupPartialScore(prefixOk, suffixOk) {
  if (prefixOk === false || suffixOk === false) return 0;
  if (prefixOk && suffixOk) return 0.85;
  if (suffixOk) return 0.4;
  if (prefixOk) return 0.25;
  return null;   // nothing comparable
}

// 0..1, or null when the two records don't have comparable phone data.
function dupPhoneSim(A, B) {
  const hasA = A.full10 || A.prefix || A.suffix;
  const hasB = B.full10 || B.prefix || B.suffix;
  if (!hasA || !hasB) return null;

  if (A.full10 && B.full10) return A.full10 === B.full10 ? 1 : 0;

  const full = A.full10 ? A : (B.full10 ? B : null);
  if (full) {
    // one full number, one masked number
    const part = (full === A) ? B : A;
    const f10 = full.full10;
    const prefixOk = part.prefix ? f10.indexOf(part.prefix) === 0 || ('52' + f10).indexOf(part.prefix) === 0 : null;
    const suffixOk = part.suffix ? f10.slice(-part.suffix.length) === part.suffix : null;
    return dupPartialScore(prefixOk, suffixOk);
  }

  // both masked
  const prefixOk = (A.prefix && B.prefix) ? A.prefix === B.prefix : null;
  const suffixOk = (A.suffix && B.suffix) ? A.suffix === B.suffix : null;
  return dupPartialScore(prefixOk, suffixOk);
}

// The letters of the recipient's name that are visible on a TikTok label
// ("J*** N***" -> J, N), or the first letters of the real name when the
// customer has one.
function dupInitials(c, first, sur) {
  const tt = String(c['Initials (TT Format)'] || '').trim();
  let letters = [];
  if (tt.indexOf('*') >= 0) {
    const re = /([A-Za-z\u00C0-\u017F])\*+/g;
    let m;
    while ((m = re.exec(tt)) !== null) letters.push(dupStripAccents(m[1]).toUpperCase());
  } else if (tt) {
    const words = dupNorm(tt).split(' ').filter(Boolean);
    letters = (words.length === 1 && words[0].length <= 3)
      ? words[0].toUpperCase().split('')
      : words.map(w => w[0].toUpperCase());
  }
  if (!letters.length) {
    letters = (first + ' ' + sur).trim().split(' ').filter(Boolean).map(w => w[0].toUpperCase());
  }
  return letters;
}

function dupFeatures(c) {
  const names = [normalizeUsername(c['Primary Username'])]
    .concat(String(c['Aliases'] || '').split(',').map(a => normalizeUsername(a.trim())))
    .filter(Boolean);
  const first = dupNorm(c['First Name']);
  const sur = dupNorm(c['Surname']);
  const street = dupNorm(c['Street + Number']).split(' ')
    .filter(t => t && DUP_STREET_NOISE.indexOf(t) < 0).join(' ');
  return {
    c: c,
    names: Array.from(new Set(names)),
    fullName: (first + ' ' + sur).trim(),
    initials: dupInitials(c, first, sur),
    street: street,
    streetNums: street.match(/\d+/g) || [],
    zip: dupZip(c['ZIP']),
    city: dupNorm(c['City']),
    email: String(c['Email'] || '').trim().toLowerCase(),
    phone: dupPhoneFeatures(c['Phone Partial'], c['Phone Full']),
    shopifyIds: String(c['Shopify Customer ID'] || '').split('/').map(s => s.trim()).filter(Boolean),
  };
}

// Scores one pair of normalised customers. Returns { score 0-100, reasons[] }.
function dupScorePair(fa, fb) {
  const reasons = [];
  let wsum = 0, avail = 0, floor = 0;
  const add = (key, sim) => {
    if (sim === null || sim === undefined) return;
    wsum += DUP_WEIGHTS[key] * sim;
    avail += DUP_WEIGHTS[key];
  };

  // ── decisive identifiers ──
  if (fa.shopifyIds.some(id => fb.shopifyIds.indexOf(id) >= 0)) {
    floor = Math.max(floor, 100); reasons.push('Mismo ID de Shopify');
  }
  if (fa.email && fa.email === fb.email) {
    floor = Math.max(floor, 95); reasons.push('Mismo correo'); add('email', 1);
  }
  const sharedName = fa.names.some(n => fb.names.indexOf(n) >= 0);
  if (sharedName) {
    floor = Math.max(floor, 95); reasons.push('Mismo usuario o alias'); add('username', 1);
  }

  // ── phone ──
  const phoneSim = dupPhoneSim(fa.phone, fb.phone);
  add('phone', phoneSim);
  if (fa.phone.full10 && fa.phone.full10 === fb.phone.full10) {
    floor = Math.max(floor, 85); reasons.push('Mismo teléfono');
  } else if (phoneSim !== null && phoneSim >= 0.85) {
    reasons.push('Teléfono parcial coincide');
  } else if (phoneSim === 0) {
    reasons.push('Teléfono distinto');
  }

  // ── usernames: only counted when similar (two accounts of one person
  //    normally have DIFFERENT usernames, so a difference proves nothing) ──
  if (!sharedName && fa.names.length && fb.names.length) {
    let best = 0;
    for (let i = 0; i < fa.names.length; i++) {
      for (let j = 0; j < fb.names.length; j++) {
        const s = dupFastSim(fa.names[i], fb.names[j]);
        if (s > best) best = s;
      }
    }
    if (best >= 0.75) { add('username', best); reasons.push('Usuarios parecidos (' + Math.round(best * 100) + '%)'); }
  }

  // ── real name ──
  if (fa.fullName && fb.fullName) {
    const s = dupTextSim(fa.fullName, fb.fullName);
    add('name', s);
    if (s >= 0.8) reasons.push('Nombre parecido');
  }

  // ── initials ──
  let initSim = null;
  if (fa.initials.length && fb.initials.length) {
    const sa = new Set(fa.initials), sb = new Set(fb.initials);
    let inter = 0;
    sa.forEach(x => { if (sb.has(x)) inter++; });
    initSim = inter / Math.max(sa.size, sb.size);
    add('initials', initSim);
    if (initSim >= 0.5) reasons.push('Iniciales coinciden');
  }

  // ── street (a different house number on a similar street is NOT a match) ──
  if (fa.street.length >= 4 && fb.street.length >= 4) {
    let s = dupTextSim(fa.street, fb.street);
    if (fa.streetNums.length && fb.streetNums.length &&
        !fa.streetNums.some(n => fb.streetNums.indexOf(n) >= 0)) s *= 0.5;
    add('street', s);
    if (s >= 0.8) reasons.push('Dirección parecida');
  }

  // ── ZIP / city ──
  let zipDiffers = false, cityDiffers = false;
  if (fa.zip && fb.zip) {
    const same = fa.zip === fb.zip;
    add('zip', same ? 1 : 0);
    if (same) reasons.push('Mismo código postal'); else { zipDiffers = true; reasons.push('Código postal distinto'); }
  }
  if (fa.city && fb.city) {
    const cs = fa.city === fb.city ? 1 : dupTextSim(fa.city, fb.city);
    add('city', cs >= 0.8 ? cs : 0);
    if (cs >= 0.8) reasons.push('Misma ciudad'); else cityDiffers = cs < 0.5;
  }

  // ── combine ──
  let score = 0;
  if (avail > 0) score = (wsum / avail) * 100 * Math.min(1, avail / DUP_REQUIRED_WEIGHT);

  // A matching masked phone together with IDENTICAL visible initials is
  // worth flagging even when little else is known -- unless the addresses
  // contradict each other. Masked numbers only show ~5 digits, so on their
  // own they coincide by chance between strangers; requiring every visible
  // initial to match as well (not just the first) is what keeps that
  // coincidence rate low while still catching the same person's two
  // accounts, whose recipient name is masked identically.
  if (phoneSim !== null && phoneSim >= 0.85 && initSim !== null && initSim >= 0.99 &&
      !zipDiffers && !cityDiffers) {
    floor = Math.max(floor, 60);
  }

  return { score: Math.round(Math.min(100, Math.max(score, floor))), reasons: reasons };
}

function getDismissedDuplicatesSheet() {
  return SpreadsheetApp.openById(CUSTOMERS_SHEET_ID).getSheetByName('Dismissed Duplicates');
}

// Order-independent key so A|B and B|A always match the same dismissal.
function dismissedPairKey(idA, idB) {
  return [String(idA), String(idB)].sort().join('|');
}

// The keys by which two customers are considered worth comparing. Shared by
// the duplicate finder and the Shopify bulk-review tool so both look for
// candidates exactly the same way.
function dupBlockingKeys(f) {
  const keys = [];
  if (f.phone.full10) {
    keys.push('pf:' + f.phone.full10);
    keys.push('ps:' + f.phone.full10.slice(-2));
  } else if (f.phone.suffix.length >= 2) {
    keys.push('ps:' + f.phone.suffix.slice(-2));
  }
  if (f.zip) keys.push('z:' + f.zip);
  if (f.email) keys.push('e:' + f.email);
  f.shopifyIds.forEach(id => keys.push('s:' + id));
  f.names.forEach(n => {
    keys.push('u:' + n);
    if (n.length >= 5) keys.push('up:' + n.slice(0, 5));
  });
  if (f.fullName.indexOf(' ') > 0) keys.push('n:' + f.fullName);
  return keys;
}

function findDuplicateCustomers(e) {
  const threshold = e.parameter.threshold
    ? Math.max(0, Math.min(100, parseInt(e.parameter.threshold, 10) || DUPLICATE_SCORE_THRESHOLD))
    : DUPLICATE_SCORE_THRESHOLD;

  const customers = sheetToObjects(getCustomersSheet())
    .filter(c => !String(c['Primary Username'] || '').includes('(merged→'));

  const dismissed = new Set(
    sheetToObjects(getDismissedDuplicatesSheet())
      .map(d => dismissedPairKey(d['Customer ID A'], d['Customer ID B']))
  );

  const feats = customers.map(dupFeatures);

  // Candidate generation: two customers are compared if they share ANY key.
  const buckets = {};
  const addKey = (k, i) => { (buckets[k] || (buckets[k] = [])).push(i); };
  feats.forEach((f, i) => dupBlockingKeys(f).forEach(k => addKey(k, i)));

  const seen = new Set();
  const pairs = [];
  let skippedKeys = 0;

  Object.keys(buckets).forEach(k => {
    const idxs = buckets[k];
    if (idxs.length < 2) return;
    if (idxs.length > DUP_MAX_BUCKET) { skippedKeys++; return; }
    for (let x = 0; x < idxs.length; x++) {
      for (let y = x + 1; y < idxs.length; y++) {
        const ia = idxs[x], ib = idxs[y];
        const pk = ia < ib ? ia + ',' + ib : ib + ',' + ia;
        if (seen.has(pk)) continue;
        seen.add(pk);

        const a = feats[ia].c, b = feats[ib].c;
        if (dismissed.has(dismissedPairKey(a['Customer ID'], b['Customer ID']))) continue;

        const res = dupScorePair(feats[ia], feats[ib]);
        if (res.score >= threshold) {
          pairs.push({ customer_a: a, customer_b: b, score: res.score, reasons: res.reasons });
        }
      }
    }
  });

  pairs.sort((p, q) => q.score - p.score);

  return jsonResponse({
    pairs: pairs.slice(0, DUP_MAX_PAIRS),
    total_matches: pairs.length,
    truncated: pairs.length > DUP_MAX_PAIRS,
    skipped_common_keys: skippedKeys,
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// SHOPIFY PENDING MATCHES — BULK REVIEW (Ajustes page)
// ═══════════════════════════════════════════════════════════════════════════
//
// WHY: every Shopify order whose customer can't be matched logs its own
// "Pending" row. One person with five orders (or the same person arriving
// under a new Shopify ID) therefore becomes five separate chores in the
// Pedidos tab. This tool lists the pending rows GROUPED BY PERSON, shows the
// evidence for each suggested customer, and applies the decisions in bulk.
//
// It is a REVIEW tool, never an auto-linker: nothing is written until the
// user applies it, and the user can change any suggestion first. (Shopify
// identity matching is suggest-only by design.)

const SMB_MAX_CANDIDATES = 3;          // alternatives offered per person
const SMB_MIN_CANDIDATE_SCORE = 30;    // below this a candidate is just noise
const SMB_MAX_ITEMS_PER_REQUEST = 60;  // the page sends smaller batches than this

// Splits the "city / state / zip" text stored in the matches sheet. Fields
// that were blank when it was written are simply absent, so the postcode is
// recognised by its shape rather than by position.
function shopifyParseAddress(text) {
  const parts = String(text || '').split(' / ').map(s => s.trim()).filter(Boolean);
  const zip = parts.find(p => /^\d{4,5}$/.test(p)) || '';
  const rest = parts.filter(p => p !== zip);
  return { city: rest[0] || '', state: rest[1] || '', zip: zip };
}

// One entry per PERSON: pending rows sharing a Shopify Customer ID are the
// same person's orders. Guest checkouts have no Shopify ID, so those are
// grouped by e-mail, then by phone, otherwise they stay on their own.
function shopifyPendingGroups(matches) {
  const groups = {}, order = [];
  matches.forEach(m => {
    const sid = String(m['Shopify Customer ID'] || '').trim();
    const email = String(m['Incoming Email'] || '').trim().toLowerCase();
    const phone = normalizePhone(m['Incoming Phone']);
    const key = sid ? 'sid:' + sid
              : email ? 'em:' + email
              : phone.length >= 10 ? 'ph:' + phone.slice(-10)
              : 'm:' + m['Match ID'];
    if (!groups[key]) { groups[key] = { key: key, shopify_customer_id: sid, matches: [] }; order.push(key); }
    groups[key].matches.push(m);
  });
  return order.map(k => groups[k]);
}

// Latest non-empty value of a field across a person's pending rows.
function shopifyGroupField(g, field) {
  for (let i = g.matches.length - 1; i >= 0; i--) {
    const v = String(g.matches[i][field] || '').trim();
    if (v) return v;
  }
  return '';
}

// The incoming person, shaped like a Customers row so the same scoring
// engine as the duplicate finder can compare it with real customers.
function shopifyIncomingAsCustomer(g) {
  const nameParts = shopifyGroupField(g, 'Incoming Name').split(' ').filter(Boolean);
  const addr = shopifyParseAddress(shopifyGroupField(g, 'Incoming Address'));
  return {
    'Primary Username': shopifyGroupField(g, 'Incoming Username'),
    'First Name': nameParts[0] || '',
    'Surname': nameParts.slice(1).join(' '),
    'Phone Full': shopifyGroupField(g, 'Incoming Phone'),
    'Email': shopifyGroupField(g, 'Incoming Email'),
    'City': addr.city, 'State': addr.state, 'ZIP': addr.zip,
    'Shopify Customer ID': g.shopify_customer_id,
    'Aliases': '', 'Street + Number': '', 'Initials (TT Format)': '', 'Phone Partial': '',
  };
}

// GET ?action=shopify_matches_review
function getShopifyMatchesReview(e) {
  const matches = sheetToObjects(getShopifyMatchesSheet())
    .filter(m => String(m['Decision'] || '').trim() === 'Pending');
  if (!matches.length) return jsonResponse({ groups: [], total_matches: 0 });

  // Merged-away customers must never be offered as a target.
  const customers = sheetToObjects(getCustomersSheet())
    .filter(c => !String(c['Primary Username'] || '').includes('(merged→'));
  const feats = customers.map(dupFeatures);

  const indexById = {};
  feats.forEach((f, i) => { indexById[String(f.c['Customer ID'])] = i; });
  const keyIndex = {};
  feats.forEach((f, i) => dupBlockingKeys(f).forEach(k => { (keyIndex[k] || (keyIndex[k] = [])).push(i); }));

  const groups = shopifyPendingGroups(matches).map(g => {
    const incoming = shopifyIncomingAsCustomer(g);
    const fi = dupFeatures(incoming);

    // Candidates: whatever the original matcher suggested, plus anyone who
    // shares a phone ending, ZIP, e-mail, Shopify ID or name with the person.
    const cand = new Set();
    g.matches.forEach(m => {
      const id = String(m['Suggested Customer ID'] || '');
      if (id && indexById[id] !== undefined) cand.add(indexById[id]);
    });
    dupBlockingKeys(fi).forEach(k => {
      const list = keyIndex[k];
      if (list && list.length <= DUP_MAX_BUCKET) list.forEach(i => cand.add(i));
    });

    const scored = Array.from(cand).map(i => {
      const res = dupScorePair(fi, feats[i]);
      const c = feats[i].c;
      return {
        customer_id: String(c['Customer ID']),
        username: String(c['Primary Username'] || ''),
        name: [c['First Name'], c['Surname']].filter(Boolean).join(' '),
        phone: String(c['Phone Full'] || c['Phone Partial'] || ''),
        email: String(c['Email'] || ''),
        city: String(c['City'] || ''),
        shopify_ids: String(c['Shopify Customer ID'] || ''),
        shipment_count: c['Shipment Count'],
        score: res.score,
        reasons: res.reasons,
        same_shopify_id: fi.shopifyIds.some(id => feats[i].shopifyIds.indexOf(id) >= 0),
      };
    }).filter(c => c.score >= SMB_MIN_CANDIDATE_SCORE || c.same_shopify_id)
      .sort((a, b) => (b.same_shopify_id - a.same_shopify_id) || (b.score - a.score))
      .slice(0, SMB_MAX_CANDIDATES);

    const orderNameKey = Object.keys(g.matches[0]).find(k => /^order name/i.test(k));
    return {
      key: g.key,
      shopify_customer_id: g.shopify_customer_id,
      match_ids: g.matches.map(m => String(m['Match ID'])),
      order_names: g.matches.map(m => String(orderNameKey ? m[orderNameKey] : '')).filter(Boolean),
      incoming: {
        name: shopifyGroupField(g, 'Incoming Name'),
        username: shopifyGroupField(g, 'Incoming Username'),
        phone: shopifyGroupField(g, 'Incoming Phone'),
        email: shopifyGroupField(g, 'Incoming Email'),
        city: incoming['City'], state: incoming['State'], zip: incoming['ZIP'],
      },
      // BUG FIXED 2026-10-14: this used to mean "the pending rows are stale
      // leftovers from before this ID was linked" and was treated as a sure
      // thing needing no review. That reasoning only holds when this
      // candidate reached the list BECAUSE its Shopify ID matched the
      // incoming group's ID. It does NOT hold when the candidate instead
      // reached the list via phone/ZIP/e-mail/name (dupBlockingKeys) and
      // merely HAPPENS to already carry this exact ID among possibly
      // several Shopify IDs on file -- that is the same person ordering
      // under two different Shopify accounts (a known, legitimate pattern:
      // guest checkout once, logged in another time), and it is new
      // evidence the reviewer should see, not a leftover to wave through.
      // same_shopify_id itself is correct; only the wording/certainty was
      // wrong, so it is kept, just reported honestly as "same_shopify_id"
      // (frontend shows it as corroborating evidence, not a "no review
      // needed" badge).
      candidates: scored,
    };
  });

  // Certain ones first, then grouped by target customer, best score first.
  // Groups whose top candidate already carries this exact Shopify ID sort
  // first (strongest possible evidence), then grouped by target customer,
  // best score first.
  groups.sort((a, b) => {
    const sa = a.candidates[0] && a.candidates[0].same_shopify_id ? 1 : 0;
    const sb = b.candidates[0] && b.candidates[0].same_shopify_id ? 1 : 0;
    if (sa !== sb) return sb - sa;
    const ta = a.candidates[0] ? a.candidates[0].customer_id : '~';
    const tb = b.candidates[0] ? b.candidates[0].customer_id : '~';
    if (ta !== tb) return ta < tb ? -1 : 1;
    return (b.candidates[0] ? b.candidates[0].score : 0) - (a.candidates[0] ? a.candidates[0].score : 0);
  });

  return jsonResponse({ groups: groups, total_matches: matches.length });
}

// POST { action:'resolve_shopify_matches_bulk',
//        items:[{ key, match_ids:[...], decision:'link'|'new', customer_id }] }
// 'link' = these orders belong to customer_id: the Shopify ID(s) are added to
// that customer, their blank fields are enriched, and the orders are re-pointed.
// 'new'  = create ONE new customer for the whole group.
// Reads each sheet once and writes only the cells that change, so a batch of
// dozens of people takes seconds instead of re-reading every sheet per order.
function resolveShopifyMatchesBulk(body) {
  const items = body.items || [];
  if (!items.length) return jsonResponse({ error: 'No hay nada que aplicar.' });
  if (items.length > SMB_MAX_ITEMS_PER_REQUEST) {
    return jsonResponse({ error: 'Demasiados elementos en una sola petición (máximo ' + SMB_MAX_ITEMS_PER_REQUEST + ').' });
  }

  // ── matches sheet ──
  const mSheet = getShopifyMatchesSheet();
  const mData = mSheet.getDataRange().getValues();
  const mh = mData[0];
  const M = {
    id: mh.indexOf('Match ID'), shopOrder: mh.indexOf('Shopify Order ID'), shopCust: mh.indexOf('Shopify Customer ID'),
    name: mh.indexOf('Incoming Name'), phone: mh.indexOf('Incoming Phone'), user: mh.indexOf('Incoming Username'),
    email: mh.indexOf('Incoming Email'), addr: mh.indexOf('Incoming Address'), sugg: mh.indexOf('Suggested Customer ID'),
    decision: mh.indexOf('Decision'), linked: mh.indexOf('Linked Customer ID'), decided: mh.indexOf('Decided Date'),
  };
  const matchRowById = {};
  for (let i = 1; i < mData.length; i++) matchRowById[String(mData[i][M.id])] = i;

  // ── customers sheet (read once; edits tracked cell by cell) ──
  const cSheet = getCustomersSheet();
  const cData = cSheet.getDataRange().getValues();
  const ch = cData[0];
  const C = {
    id: ch.indexOf('Customer ID'), user: ch.indexOf('Primary Username'), shop: ch.indexOf('Shopify Customer ID'),
    first: ch.indexOf('First Name'), sur: ch.indexOf('Surname'), phoneFull: ch.indexOf('Phone Full'), email: ch.indexOf('Email'),
  };
  const cTrack = makeCellTracker(cData, 1);          // cData includes the header row
  const custRowById = {};
  let maxNum = 0;
  for (let i = 1; i < cData.length; i++) {
    const id = String(cData[i][C.id]);
    const n = parseInt(id.replace('CUST-', ''), 10);
    if (id.indexOf('CUST-') === 0 && !isNaN(n) && n > maxNum) maxNum = n;
    if (!String(cData[i][C.user] || '').includes('(merged→')) custRowById[id] = i;
  }

  // ── orders: only the four columns needed ──
  const oSheet = getOrdersSheet();
  const oh = oSheet.getRange(1, 1, 1, oSheet.getLastColumn()).getValues()[0];
  const O = { shop: oh.indexOf('Shopify Order ID'), cust: oh.indexOf('Customer ID'), user: oh.indexOf('Primary Username') };
  const oShop = readColumn(oSheet, O.shop);
  const ordersByShopId = {};
  oShop.forEach((v, i) => { if (v !== '') (ordersByShopId[String(v)] || (ordersByShopId[String(v)] = [])).push(i); });

  const displayName = (ci) => {
    const row = cData[ci];
    const u = String(row[C.user] || '').trim();
    if (u) return u;
    const full = [row[C.first], row[C.sur]].map(v => String(v || '').trim()).filter(Boolean).join(' ');
    return full || String(row[C.email] || '').trim();
  };

  const matchChanges = [];            // { r, decision, linked }
  const orderChanges = {};            // 'custId|name' -> { cust, name, rows:[] }
  const recount = [];
  const results = [];
  const now = nowISO();

  items.forEach(item => {
    const key = item.key;
    const rows = (item.match_ids || []).map(id => matchRowById[String(id)]).filter(r => r !== undefined);
    const pending = rows.filter(r => String(mData[r][M.decision] || '').trim() === 'Pending');
    if (!pending.length) { results.push({ key: key, ok: false, error: 'Ya estaba resuelto o no existe.' }); return; }
    const latest = mData[pending[pending.length - 1]];

    let targetId = '', ci;
    if (item.decision === 'link') {
      targetId = String(item.customer_id || '');
      ci = custRowById[targetId];
      if (ci === undefined) { results.push({ key: key, ok: false, error: 'El cliente ' + targetId + ' no existe o ya fue fusionado.' }); return; }

      // Shopify ID(s) of this person -> the customer's list ("/"-separated, as text)
      const have = String(cData[ci][C.shop] || '').split('/').map(s => s.trim()).filter(Boolean);
      const add = Array.from(new Set(pending.map(r => String(mData[r][M.shopCust] || '').trim()).filter(Boolean)))
        .filter(id => have.indexOf(id) < 0);
      if (add.length && C.shop >= 0) cTrack.set(ci, C.shop, have.concat(add).join('/'));

      // Fill blank fields only (never overwrite what is already on file)
      const fill = (col, val) => { if (col >= 0 && val && !String(cData[ci][col] || '').trim()) cTrack.set(ci, col, val); };
      fill(C.phoneFull, String(latest[M.phone] || '').trim());
      fill(C.email, String(latest[M.email] || '').trim());
      const np = String(latest[M.name] || '').split(' ').filter(Boolean);
      if (np.length) { fill(C.first, np[0]); fill(C.sur, np.slice(1).join(' ')); }

    } else if (item.decision === 'new') {
      const np = String(latest[M.name] || '').split(' ').filter(Boolean);
      const addr = shopifyParseAddress(latest[M.addr]);
      maxNum++;
      targetId = 'CUST-' + String(maxNum).padStart(3, '0');
      const shopIds = Array.from(new Set(pending.map(r => String(mData[r][M.shopCust] || '').trim()).filter(Boolean)));
      const newRowNum = appendCustomerRowByHeader(cSheet, {
        'Customer ID': targetId,
        'Primary Username': String(latest[M.user] || ''),
        'Shopify Customer ID': shopIds.join('/'),
        'First Name': np[0] || '', 'Surname': np.slice(1).join(' '),
        'City': addr.city, 'State': addr.state, 'ZIP': addr.zip,
        'Phone Full': String(latest[M.phone] || ''), 'Email': String(latest[M.email] || ''),
        'First Order Date': nowISO(), 'Shipment Count': 0,
        'Notes': 'Created from Shopify bulk review (' + pending.length + ' pending order(s))',
        'Merge Flag': false,
      });
      // make the new row visible to displayName()
      cData[newRowNum - 1] = ch.map(h => ({ 'Customer ID': targetId, 'Primary Username': String(latest[M.user] || ''),
        'First Name': np[0] || '', 'Surname': np.slice(1).join(' '), 'Email': String(latest[M.email] || '') }[h] || ''));
      ci = newRowNum - 1;
      custRowById[targetId] = ci;
    } else {
      results.push({ key: key, ok: false, error: 'Decisión desconocida: ' + item.decision }); return;
    }

    // matches + orders
    const name = displayName(ci);
    let ordersUpdated = 0;
    pending.forEach(r => {
      const decision = item.decision === 'new' ? 'Created-New'
        : (String(mData[r][M.sugg] || '') === targetId ? 'Confirmed-Suggested' : 'Confirmed-Different');
      matchChanges.push({ r: r, decision: decision, linked: targetId });
      (ordersByShopId[String(mData[r][M.shopOrder])] || []).forEach(oi => {
        const k = targetId + '|' + name;
        (orderChanges[k] || (orderChanges[k] = { cust: targetId, name: name, rows: [] })).rows.push(oi);
        ordersUpdated++;
      });
    });
    recount.push(targetId);
    results.push({ key: key, ok: true, customer_id: targetId, matches_resolved: pending.length, orders_updated: ordersUpdated });
    logAuditEvent('resolve_shopify_match', 'Customer', targetId, {
      decision: item.decision, matches_resolved: pending.length, orders_updated: ordersUpdated, bulk: true,
    });
  });

  // ── write phase: only the cells that changed ──
  cTrack.flush(cSheet, [C.shop, C.phoneFull]);

  // Each API call has a fixed round-trip cost, and this whole request runs
  // while holding the write lock (other people's saves wait for it). So the
  // writes are few and wide instead of many and tiny:
  //  - matches sheet: Decision / Linked Customer ID / Decided Date are small
  //    plain-text columns -> one write each (3 calls in total)
  //  - orders: the Customer ID column holds plain-text IDs -> one write
  //  - orders: Primary Username can hold numeric-looking handles, so it is
  //    written only for the cells that change, one call per distinct name
  matchChanges.forEach(c => {
    mData[c.r][M.decision] = c.decision;
    mData[c.r][M.linked] = c.linked;
    mData[c.r][M.decided] = now;
  });
  if (matchChanges.length) {
    [M.decision, M.linked, M.decided].forEach(col => {
      if (col >= 0) mSheet.getRange(2, col + 1, mData.length - 1, 1).setValues(mData.slice(1).map(r => [r[col]]));
    });
  }

  const oCustVals = readColumn(oSheet, O.cust);
  const oCustChanged = [];
  Object.keys(orderChanges).forEach(k => {
    orderChanges[k].rows.forEach(oi => { oCustVals[oi] = orderChanges[k].cust; oCustChanged.push(oi); });
  });
  writeColumnChanges(oSheet, O.cust, oCustVals, oCustChanged);
  Object.keys(orderChanges).forEach(k => {
    const oc = orderChanges[k];
    if (oc.name) setCellsToValue(oSheet, O.user, oc.rows, oc.name, /^\d+$/.test(oc.name));
  });

  // The orders may already be shipped, so the customers' counts can change.
  SpreadsheetApp.flush();
  recalculateShipmentCountsFor(recount);

  return jsonResponse({
    result: 'bulk_resolved',
    applied: results.filter(r => r.ok).length,
    failed: results.filter(r => !r.ok).length,
    results: results,
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// CUSTOMER MERGE + UNDO + CLEANUP
// ═══════════════════════════════════════════════════════════════════════════

// Fields backfilled from the loser into the keeper only when the keeper's
// own value is blank -- the keeper's existing data always wins if both
// sides have it. Shared between merge (to know what to snapshot/backfill)
// and undo (to know what to restore).
const MERGE_BACKFILL_FIELDS = [
  'First Name', 'Surname', 'Initials (TT Format)',
  'Street + Number', 'City', 'State', 'ZIP',
  'Phone Partial', 'Phone Full', 'Email',
];

// Merges loseId into keepId: backfills any of the keeper's blank fields from
// the loser (so information is never lost just because the loser happens to
// be the one getting retired), recomputes Shipment Count from the keeper's orders, unions
// Aliases (also stripping the keeper's own username out of that list, in
// case it was already recorded as an alias of the loser), repoints every
// order pointing at the loser's Customer ID over to the winner, and marks
// (does not delete) the loser's row. A snapshot of the keeper's pre-merge
// state is logged to Merge History so undoMergeAction can fully reverse
// the backfill/shipment-count changes, not just the alias/username ones.
function mergeCustomersAction(body) {
  const keepId = body.keep_id;
  const loseId = body.merge_id;
  if (!keepId || !loseId || keepId === loseId) {
    return jsonResponse({ error: 'keep_id and merge_id (different) are required' });
  }

  const sheet = getCustomersSheet();
  const data = sheet.getDataRange().getValues();
  const headers = data[0];
  const idCol = headers.indexOf('Customer ID');
  const usernameCol = headers.indexOf('Primary Username');
  const aliasesCol = headers.indexOf('Aliases');
  const shopifyIdCol = headers.indexOf('Shopify Customer ID');
  const notesCol = headers.indexOf('Notes');
  const shipmentCountCol = headers.indexOf('Shipment Count');

  let keepRow = -1, loseRow = -1;
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][idCol]) === String(keepId)) keepRow = i;
    if (String(data[i][idCol]) === String(loseId)) loseRow = i;
  }
  if (keepRow === -1 || loseRow === -1) {
    return jsonResponse({ error: 'One or both customers not found' });
  }

  const loserUsername = String(data[loseRow][usernameCol] || '').trim();
  const keeperUsername = String(data[keepRow][usernameCol] || '').trim();
  const keeperUsernameNorm = normalizeUsername(keeperUsername);

  // ─── Snapshot the keeper's pre-merge state, for undo ───────────────
  const keeperSnapshot = {
    aliases: String(data[keepRow][aliasesCol] || ''),
    shopifyCustomerId: shopifyIdCol >= 0 ? String(data[keepRow][shopifyIdCol] || '') : null,
    shipmentCount: shipmentCountCol >= 0 ? (parseInt(data[keepRow][shipmentCountCol], 10) || 0) : null,
    fields: {},
  };
  MERGE_BACKFILL_FIELDS.forEach(field => {
    const col = headers.indexOf(field);
    if (col >= 0) keeperSnapshot.fields[field] = String(data[keepRow][col] || '');
  });

  // ─── Backfill blank keeper fields from the loser ───────────────────
  MERGE_BACKFILL_FIELDS.forEach(field => {
    const col = headers.indexOf(field);
    if (col < 0) return;
    const keeperVal = String(data[keepRow][col] || '').trim();
    const loserVal = String(data[loseRow][col] || '').trim();
    if (!keeperVal && loserVal) {
      setCustomerCell(sheet, keepRow + 1, col + 1, field, loserVal);
    }
  });

  // Shipment Count is recomputed from the orders after they are repointed
  // (below), instead of adding the two stored numbers together -- adding
  // would carry forward any drift already present in either stored value.

  // ─── Union aliases (loser's username + loser's own aliases) into the
  //     keeper's Aliases, deduped, with the keeper's own username scrubbed
  //     out in case it was already an alias of the loser. ───────────────
  const loserAliases = String(data[loseRow][aliasesCol] || '').split(',').map(s => s.trim()).filter(Boolean);
  const newAliasCandidates = [loserUsername, ...loserAliases].filter(Boolean);

  const currentAliases = String(data[keepRow][aliasesCol] || '').split(',').map(s => s.trim()).filter(Boolean);
  const mergedAliases = [...new Set([...currentAliases, ...newAliasCandidates])]
    .filter(a => normalizeUsername(a) !== keeperUsernameNorm);
  if (aliasesCol >= 0) sheet.getRange(keepRow + 1, aliasesCol + 1).setValue(mergedAliases.join(', '));

  const loserShopifyIds = String(data[loseRow][shopifyIdCol] || '').split('/').map(s => s.trim()).filter(Boolean);
  if (loserShopifyIds.length && shopifyIdCol >= 0) {
    loserShopifyIds.forEach(sid => appendShopifyIdToCustomer(keepId, sid));
  }

  const ordersSheet = getOrdersSheet();
  const oLastRow = ordersSheet.getLastRow();
  const oLastCol = ordersSheet.getLastColumn();
  const oh = ordersSheet.getRange(1, 1, 1, oLastCol).getValues()[0];
  const oCustCol = oh.indexOf('Customer ID');
  let ordersRepointed = 0;
  const movedOrderIds = [];

  // Reads only the Customer ID and Order ID columns and writes back only
  // the Customer ID column (plain text, safe to rewrite). It used to read
  // all ~75 columns and write the whole sheet back. The Order ID of every
  // order that moves is recorded so undo can move back exactly those.
  if (oLastRow > 1 && oCustCol >= 0) {
    const custVals = readColumn(ordersSheet, oCustCol);
    const idVals = readColumn(ordersSheet, oh.indexOf('Order ID'));
    const changed = [];
    custVals.forEach((v, i) => {
      if (String(v) === String(loseId)) {
        custVals[i] = keepId;
        changed.push(i);
        if (idVals[i] !== undefined && idVals[i] !== '') movedOrderIds.push(String(idVals[i]));
      }
    });
    ordersRepointed = changed.length;
    writeColumnChanges(ordersSheet, oCustCol, custVals, changed);
  }

  // The keeper's Shipment Count now reflects the orders it actually owns.
  SpreadsheetApp.flush();
  recalculateShipmentCountsFor([keepId]);

  if (usernameCol >= 0) {
    sheet.getRange(loseRow + 1, usernameCol + 1).setValue(`${loserUsername} (merged→${keepId})`);
  }
  if (notesCol >= 0) {
    const existingNotes = String(data[loseRow][notesCol] || '');
    sheet.getRange(loseRow + 1, notesCol + 1).setValue(
      (existingNotes ? existingNotes + ' | ' : '') + `Merged into ${keepId} on ${nowISO()}`
    );
  }

  // Keep the exact list of moved orders for undo, as long as it fits in a
  // single cell (Sheets caps a cell at 50,000 characters). If a customer had
  // an enormous number of orders, undo falls back to the older heuristic.
  if (JSON.stringify(movedOrderIds).length <= 40000) {
    keeperSnapshot.movedOrderIds = movedOrderIds;
  } else {
    keeperSnapshot.movedOrderIdsOverflow = movedOrderIds.length;
  }

  logMergeHistory(keepId, keeperUsername, loseId, loserUsername, ordersRepointed, keeperSnapshot);
  logAuditEvent('merge_customers', 'Customer', keepId, {
    merged_id: loseId, merged_username: loserUsername, orders_repointed: ordersRepointed,
  });

  return jsonResponse({
    result: 'merged',
    keep_id: keepId,
    merge_id: loseId,
    orders_repointed: ordersRepointed,
  });
}

// Persists a "not a duplicate" decision so this pair stops being suggested
// on future scans. Order-independent: dismissing A/B also covers B/A.
function dismissDuplicatePairAction(body) {
  const idA = body.customer_id_a;
  const idB = body.customer_id_b;
  if (!idA || !idB) return jsonResponse({ error: 'customer_id_a and customer_id_b are required' });

  const sheet = getDismissedDuplicatesSheet();
  sheet.appendRow([idA, idB, nowISO()]);
  logAuditEvent('dismiss_duplicate_pair', 'Customer', idA, { other_id: idB });

  return jsonResponse({ result: 'dismissed' });
}

function getMergeHistorySheet() {
  return SpreadsheetApp.openById(CUSTOMERS_SHEET_ID).getSheetByName('Merge History');
}

function getMergeHistory(e) {
  const records = sheetToObjects(getMergeHistorySheet());
  return jsonResponse({ records: records });
}

// Logs one merge event. keeperSnapshot captures the keeper's pre-merge
// Aliases, Shipment Count, and any backfillable fields, serialized to JSON,
// so undoMergeAction can restore the keeper to its exact pre-merge state
// rather than guessing.
//
// Sheet columns expected, in order: Merge ID | Kept Customer ID |
// Kept Username | Merged Customer ID | Merged Username | Orders Repointed |
// Status | Merged Date | Undone Date | Keeper Snapshot
function logMergeHistory(keepId, keptUsername, loseId, loserUsername, ordersRepointed, keeperSnapshot) {
  const sheet = getMergeHistorySheet();
  sheet.appendRow([
    'MERGE-' + Utilities.getUuid().slice(0, 8),
    keepId,
    keptUsername,
    loseId,
    loserUsername,
    ordersRepointed,
    'Activo',
    nowISO(),
    '',
    JSON.stringify(keeperSnapshot || {}),
  ]);
}

// ═══════════════════════════════════════════════════════════════════════════
// SHEET FORMATTING — center-align all data
// ═══════════════════════════════════════════════════════════════════════════

// Re-centers every populated cell (header row included) across every main
// sheet. Run manually any time from the Apps Script editor's function
// dropdown, or set up a time-based trigger (Triggers > Add Trigger >
// centerAlignAllSheets > Time-driven) to run this automatically, e.g. once
// a night, so new imports/writes never sit left-aligned for long.
function centerAlignAllSheets() {
  const sheets = [
    getOrdersSheet(),
    getCustomersSheet(),
    getQCSheet(),
    getShopifyMatchesSheet(),
    getSessionsSheet(),
    getProductParentsSheet(),
    getProductVariantsSheet(),
    getCatalogSuggestionsSheet(),
    getTikTokImportHistorySheet(),
    getDismissedDuplicatesSheet(),
    getMergeHistorySheet(),
  ];

  let centered = 0;
  sheets.forEach(sheet => {
    if (!sheet) return;
    const lastRow = sheet.getLastRow();
    const lastCol = sheet.getLastColumn();
    if (lastRow < 1 || lastCol < 1) return;
    sheet.getRange(1, 1, lastRow, lastCol).setHorizontalAlignment('center');
    centered++;
  });

  Logger.log('Center-aligned ' + centered + ' sheets.');
}

// Reverses a merge: restores the loser's original Primary Username, restores
// the keeper's pre-merge Aliases/Shipment Count/backfilled fields from the
// logged snapshot, and repoints any orders that were moved back to the
// loser's Customer ID. Marks the history row as undone rather than deleting
// it. Refuses if the merge was already undone, or if the merged customer's
// row was already permanently deleted via deleteMergedCustomerAction.
function undoMergeAction(body) {
  const mergeId = body.merge_id;
  if (!mergeId) return jsonResponse({ error: 'merge_id is required' });

  const historySheet = getMergeHistorySheet();
  const hData = historySheet.getDataRange().getValues();
  const hHeaders = hData[0];
  const iMergeId = hHeaders.indexOf('Merge ID');
  const iKeepId = hHeaders.indexOf('Kept Customer ID');
  const iLoseId = hHeaders.indexOf('Merged Customer ID');
  const iLoseUsername = hHeaders.indexOf('Merged Username');
  const iStatus = hHeaders.indexOf('Status');
  const iUndoneDate = hHeaders.indexOf('Undone Date');
  const iSnapshot = hHeaders.indexOf('Keeper Snapshot');

  let historyRow = -1;
  let record = null;
  for (let i = 1; i < hData.length; i++) {
    if (String(hData[i][iMergeId]) === String(mergeId)) {
      historyRow = i;
      record = hData[i];
      break;
    }
  }
  if (historyRow === -1) return jsonResponse({ error: 'Merge record not found' });
  if (record[iStatus] === 'Deshecho') return jsonResponse({ error: 'This merge was already undone' });
  if (record[iStatus] === 'Limpiado') return jsonResponse({ error: 'The merged customer was already permanently deleted; this merge can no longer be undone' });

  const keepId = record[iKeepId];
  const loseId = record[iLoseId];
  const originalLoserUsername = record[iLoseUsername];

  let snapshot = null;
  if (iSnapshot >= 0 && record[iSnapshot]) {
    try { snapshot = JSON.parse(record[iSnapshot]); } catch (e) { snapshot = null; }
  }

  const custSheet = getCustomersSheet();
  const cData = custSheet.getDataRange().getValues();
  const cHeaders = cData[0];
  const cIdCol = cHeaders.indexOf('Customer ID');
  const cUsernameCol = cHeaders.indexOf('Primary Username');
  const cAliasesCol = cHeaders.indexOf('Aliases');
  const cNotesCol = cHeaders.indexOf('Notes');
  const cShipmentCountCol = cHeaders.indexOf('Shipment Count');

  let keepRow = -1, loseRow = -1;
  for (let i = 1; i < cData.length; i++) {
    if (String(cData[i][cIdCol]) === String(keepId)) keepRow = i;
    if (String(cData[i][cIdCol]) === String(loseId)) loseRow = i;
  }

  if (loseRow >= 0) {
    custSheet.getRange(loseRow + 1, cUsernameCol + 1).setValue(originalLoserUsername);
    if (cNotesCol >= 0) {
      const existing = String(cData[loseRow][cNotesCol] || '');
      custSheet.getRange(loseRow + 1, cNotesCol + 1).setValue(
        existing.replace(new RegExp('\\s*\\|?\\s*Merged into ' + keepId + '.*'), '')
      );
    }
  }

  if (keepRow >= 0 && snapshot) {
    // Snapshot-based restore: puts every backfilled field, Shipment Count,
    // Aliases, and Shopify Customer ID back exactly as they were before
    // the merge.
    if (cAliasesCol >= 0 && snapshot.aliases !== undefined) {
      custSheet.getRange(keepRow + 1, cAliasesCol + 1).setValue(snapshot.aliases);
    }
    const cShopifyIdCol = cHeaders.indexOf('Shopify Customer ID');
    if (cShopifyIdCol >= 0 && snapshot.shopifyCustomerId !== null && snapshot.shopifyCustomerId !== undefined) {
      setCustomerCell(custSheet, keepRow + 1, cShopifyIdCol + 1, 'Shopify Customer ID', snapshot.shopifyCustomerId);
    }
    if (cShipmentCountCol >= 0 && snapshot.shipmentCount !== null && snapshot.shipmentCount !== undefined) {
      custSheet.getRange(keepRow + 1, cShipmentCountCol + 1).setValue(snapshot.shipmentCount);
    }
    if (snapshot.fields) {
      MERGE_BACKFILL_FIELDS.forEach(field => {
        const col = cHeaders.indexOf(field);
        if (col >= 0 && snapshot.fields[field] !== undefined) {
          setCustomerCell(custSheet, keepRow + 1, col + 1, field, snapshot.fields[field]);
        }
      });
    }
  } else if (keepRow >= 0 && cAliasesCol >= 0) {
    // Fallback for merges logged before the snapshot existed: best-effort
    // alias-only revert, same as the original behavior.
    const currentAliases = String(cData[keepRow][cAliasesCol] || '')
      .split(',').map(s => s.trim()).filter(Boolean)
      .filter(a => a !== originalLoserUsername);
    custSheet.getRange(keepRow + 1, cAliasesCol + 1).setValue(currentAliases.join(', '));
  }

  const ordersSheet = getOrdersSheet();
  const oLastRow = ordersSheet.getLastRow();
  const oLastCol = ordersSheet.getLastColumn();
  const oh = ordersSheet.getRange(1, 1, 1, oLastCol).getValues()[0];
  const oCustCol = oh.indexOf('Customer ID');
  const oUsernameCol = oh.indexOf('Primary Username');
  let ordersReverted = 0;

  if (oLastRow > 1 && oCustCol >= 0) {
    const custVals = readColumn(ordersSheet, oCustCol);
    const changed = [];

    if (snapshot && Array.isArray(snapshot.movedOrderIds)) {
      // Exact revert: ONLY the orders this specific merge moved. The old
      // approach matched on username, which also pulled back any order
      // created AFTER the merge under the loser's old TikTok username (those
      // now correctly belong to the keeper).
      const moved = new Set(snapshot.movedOrderIds.map(String));
      const idVals = readColumn(ordersSheet, oh.indexOf('Order ID'));
      custVals.forEach((v, i) => {
        if (String(v) === String(keepId) && moved.has(String(idVals[i]))) {
          custVals[i] = loseId;
          changed.push(i);
        }
      });
    } else {
      // Merge logged before moved orders were recorded (or too many to
      // store): best-effort revert by username, as before.
      const userVals = readColumn(ordersSheet, oUsernameCol);
      custVals.forEach((v, i) => {
        if (String(v) === String(keepId) && userVals[i] === originalLoserUsername) {
          custVals[i] = loseId;
          changed.push(i);
        }
      });
    }

    ordersReverted = changed.length;
    writeColumnChanges(ordersSheet, oCustCol, custVals, changed);
  }

  // Both customers' Shipment Counts are recomputed from their real orders
  // (this supersedes the count restored from the snapshot above, which
  // could be stale).
  SpreadsheetApp.flush();
  recalculateShipmentCountsFor([keepId, loseId]);

  historySheet.getRange(historyRow + 1, iStatus + 1).setValue('Deshecho');
  if (iUndoneDate >= 0) historySheet.getRange(historyRow + 1, iUndoneDate + 1).setValue(nowISO());
  logAuditEvent('undo_merge', 'Customer', keepId, { merge_id: mergeId, restored_id: loseId, orders_reverted: ordersReverted });

  return jsonResponse({ result: 'undone', merge_id: mergeId, orders_reverted: ordersReverted });
}

// Permanently deletes a merged-away customer's row from the Customers sheet.
// Only allowed when the Merge History record is still 'Activo' -- i.e. the
// merge was never undone. This is a one-way cleanup step for after a merge
// has been confirmed correct; it does not touch orders or the winning
// customer's data, since those were already migrated at merge time.
function deleteMergedCustomerAction(body) {
  const mergeId = body.merge_id;
  if (!mergeId) return jsonResponse({ error: 'merge_id is required' });

  const historySheet = getMergeHistorySheet();
  const hData = historySheet.getDataRange().getValues();
  const hHeaders = hData[0];
  const iMergeId = hHeaders.indexOf('Merge ID');
  const iLoseId = hHeaders.indexOf('Merged Customer ID');
  const iStatus = hHeaders.indexOf('Status');

  let historyRow = -1;
  let record = null;
  for (let i = 1; i < hData.length; i++) {
    if (String(hData[i][iMergeId]) === String(mergeId)) { historyRow = i; record = hData[i]; break; }
  }
  if (!record) return jsonResponse({ error: 'Merge record not found' });
  if (record[iStatus] !== 'Activo') {
    return jsonResponse({ error: 'Only an active (non-undone) merge can be cleaned up' });
  }

  const loseId = record[iLoseId];
  const custSheet = getCustomersSheet();
  const cData = custSheet.getDataRange().getValues();
  const cIdCol = cData[0].indexOf('Customer ID');
  const cUsernameCol = cData[0].indexOf('Primary Username');

  let loseRow = -1;
  for (let i = 1; i < cData.length; i++) {
    if (String(cData[i][cIdCol]) === String(loseId)) { loseRow = i; break; }
  }
  if (loseRow === -1) return jsonResponse({ error: 'Merged customer row not found (already deleted?)' });

  const deletedUsername = String(cData[loseRow][cUsernameCol] || '');
  const cHeaders = cData[0];
  const deletedSnapshot = {};
  cHeaders.forEach((h, i) => { deletedSnapshot[h] = cData[loseRow][i]; });

  custSheet.deleteRow(loseRow + 1);
  historySheet.getRange(historyRow + 1, iStatus + 1).setValue('Limpiado');
  logAuditEvent('delete_merged_customer', 'Customer', loseId, { merge_id: mergeId, deleted_row: deletedSnapshot });

  return jsonResponse({ result: 'deleted', merge_id: mergeId, customer_id: loseId, username: deletedUsername });
}
