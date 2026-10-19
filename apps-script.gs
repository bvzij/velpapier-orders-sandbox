// ═══════════════════════════════════════════════════════════════════════════
// CONFIG
// ═══════════════════════════════════════════════════════════════════════════

const ORDERS_SHEET_ID = '1ghfPmDU6NvOWhzAdyqMcXap2DH3_j47tv5kTCwh4BTg';
// Caches each spreadsheet handle for the life of ONE request. openById()
// is a real round trip to Google's backend -- a single status update was
// opening Orders, then Customers (shipment count), then the Audit Log
// separately, paying that cost three times for one click. Cleared at the
// top of doPost/doGet so nothing survives between requests.
let _ssCache = {};
function openSheetCached(id) {
  if (!_ssCache[id]) _ssCache[id] = SpreadsheetApp.openById(id);
  return _ssCache[id];
}
const CUSTOMERS_SHEET_ID = '1lM9RjWq4vvcmXTUwJmi0IbS2tQw31CzjnWsFmMON7ak';
const QC_SHEET_ID = '1HFzeXHMOxQ3dNb8g4wvU1bp-psGlWMZUlXO0tQYWFxc';
const AUDIT_LOG_SHEET_ID = '1J7dMUqj_uj_D24YgR5avCmSTdcbFCUmpU2YpO4uRGwU';

const SCRIPT_VERSION = '2026-10-19.3';

// ─── Fix-pack 2026-10-19 settings (see FIX_LOG.md) ─────────────────────────
// Staff tokens receive Orders rows WITHOUT money columns (owner-only data).
const HIDE_PRICES_FROM_STAFF = true;
const STAFF_HIDDEN_ORDER_FIELDS = ['Price'];
// Machine identities (VPS, Shopify webhook) may only call their own actions.
// false = log violations only; flip to true after a week of clean logs.
const SERVICE_ALLOWLIST_ENFORCE = true;
const SERVICE_ALLOW = {
  vps:     ['import_tiktok_orders', 'create_customers_bulk', 'customers', 'orders_index', 'import_qc_history', 'ping', 'whoami'],
  shopify: ['import_shopify_order', 'customers', 'ping', 'whoami'],
};
// Login sessions replace sending the raw password on every request.
const SESSION_DAYS = 30;
// While true, a raw password still works as a token (old saved logins keep
// working). Flip to false once every phone has logged in again after the
// 2026-10-18 deploy -- then only session tokens and service tokens work.
const ALLOW_PASSWORD_AS_TOKEN = false;
// Only these Cloudinary folders can be signed for upload.
const UPLOAD_FOLDERS = ['velpapier/qc'];
const MX_TZ = 'America/Mexico_City';

const BACKUP_FOLDER_ID = '1wxkTAqFlGlOc-qMGBv24nQswW7IyYMoL';

// ═══════════════════════════════════════════════════════════════════════════
// SHARED HELPERS — sheet accessors, utilities, ID generation
// ═══════════════════════════════════════════════════════════════════════════

// ─── Sheet accessors ───────────────────────────────────────────────────────────

function getOrdersSheet() {
  return openSheetCached(ORDERS_SHEET_ID).getSheetByName('Orders');
}

// Finds the current year's log tab ("Log 2026", "Log 2027", ...) by name.
// When a new year starts, create the next tab with the same header row --
// nothing in the code needs to change. If that tab doesn't exist yet
// (e.g. right at midnight on Jan 1 before anyone's made it), falls back to
// the most recent "Log <year>" tab that does exist, so logging never hard
// fails for a missing tab -- it just lands in last year's until the new
// one is created.
function getAuditLogSheet() {
  const ss = openSheetCached(AUDIT_LOG_SHEET_ID);
  const year = Utilities.formatDate(new Date(), 'America/Mexico_City', 'yyyy');
  const current = ss.getSheetByName('Log ' + year);
  if (current) return current;

  const fallback = ss.getSheets()
    .filter(sh => /^Log \d{4}$/.test(sh.getName()))
    .sort((a, b) => b.getName().localeCompare(a.getName()))[0];
  return fallback || null;
}

function getShopifyMatchesSheet() {
  return openSheetCached(CUSTOMERS_SHEET_ID).getSheetByName('Shopify Customer Matches');
}

function getCustomersSheet() {
  return openSheetCached(CUSTOMERS_SHEET_ID).getSheetByName('Customers');
}

const QC_ID_COLUMNS = ['Tracking ID', 'TikTok Order IDs', 'Shopify Order IDs', 'Manual Order IDs'];

function getQCSheet() {
  const ss = openSheetCached(QC_SHEET_ID);

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
  // Previously fell back to sheets[0], silently sending QC writes into
  // whatever tab happened to be first. Failing loudly is safer.
  throw new Error('No se encontró la hoja de QC (encabezados "QC ID" y "Tracking ID").');
}

// ─── Utilities ─────────────────────────────────────────────────────────────────

function generateUUID() {
  return Utilities.getUuid();
}

function nowISO() {
  return new Date().toISOString();
}

// Returns the 0-based index of `name` in row 1, appending it as a new last
// column first if it doesn't exist yet. Lets a fix add a column without
// anyone editing the sheet by hand. Callers must re-read headers after.
function ensureHeader(sheet, name) {
  const lastCol = sheet.getLastColumn();
  const headers = lastCol ? sheet.getRange(1, 1, 1, lastCol).getValues()[0] : [];
  const idx = headers.indexOf(name);
  if (idx >= 0) return idx;
  sheet.getRange(1, lastCol + 1).setValue(name);
  return lastCol;
}

// ─── Platform date parsing ─────────────────────────────────────────────
// TikTok exports dates as text ("16/10/2026 11:53:21" or, depending on the
// account locale, "10/16/2026 11:53:21 AM"). new Date() in the browser
// cannot read the day-first form at all, and Sheets may silently swap
// day and month on write -- so every platform date is parsed HERE, as
// Mexico City local time, and stored as ISO.
//
// detectDayFirst() looks at a whole batch: any value whose first number
// is > 12 proves day-first, any whose second number is > 12 proves
// month-first. Returns null if the batch never disambiguates.
function detectDayFirst(values) {
  let dayFirst = 0, monthFirst = 0;
  (values || []).forEach(v => {
    const m = String(v || '').match(/^\s*(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})/);
    if (!m) return;
    if (Number(m[1]) > 12) dayFirst++;
    else if (Number(m[2]) > 12) monthFirst++;
  });
  if (dayFirst && !monthFirst) return true;
  if (monthFirst && !dayFirst) return false;
  return null;
}

// dayFirst: true / false / null (null = Mexican default, day-first).
// Accepts Date objects (Sheets already converted), ISO strings, and
// d/m/y or m/d/y with optional seconds and AM/PM. Returns Date or null.
function parseTikTokDateTime(v, dayFirst) {
  if (!v) return null;
  if (v instanceof Date) return isNaN(v.getTime()) ? null : v;
  const s = String(v).trim();
  if (/^\d{4}-\d{2}-\d{2}T/.test(s)) {
    const d = new Date(s);
    return isNaN(d.getTime()) ? null : d;
  }
  const m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})(?:[ T]+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp]\.?\s*[Mm]\.?)?)?/);
  if (!m) return null;
  let a = Number(m[1]), b = Number(m[2]);
  let year = Number(m[3]); if (year < 100) year += 2000;
  let day, month;
  if (a > 12) { day = a; month = b; }
  else if (b > 12) { day = b; month = a; }
  else if (dayFirst === false) { day = b; month = a; }
  else { day = a; month = b; }
  let hh = Number(m[4] || 0); const mi = Number(m[5] || 0), ss = Number(m[6] || 0);
  const ampm = (m[7] || '').toLowerCase().replace(/[^ap]/g, '');
  if (ampm === 'p' && hh < 12) hh += 12;
  if (ampm === 'a' && hh === 12) hh = 0;
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const pad = n => String(n).padStart(2, '0');
  try {
    return Utilities.parseDate(year + '-' + pad(month) + '-' + pad(day) + ' ' + pad(hh) + ':' + pad(mi) + ':' + pad(ss),
      MX_TZ, 'yyyy-MM-dd HH:mm:ss');
  } catch (e) { return null; }
}

// Airtable "Fecha Empacar" is "dd-mm-yy HH:MM" -- same parser, day-first.
function toISOorEmpty(d) { return d ? d.toISOString() : ''; }

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
  const _tFind = Date.now();
  try { return _findOrderRowInner(sheet, orderID); } finally { tmark('find_order_row_ms', _tFind); }
}
function _findOrderRowInner(sheet, orderID) {
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
    _ssCache = {};
    const action = e.parameter.action || 'orders';

    // 'ping' is what the frontend's ensureToken() uses to validate a saved
    // token. It previously answered OK *before* the auth check, so ANY
    // token -- wrong, blank, or rotated -- passed validation and the user
    // was never re-prompted. It must be authenticated like everything else.
    if (action === 'version') return jsonResponse({ version: SCRIPT_VERSION });
    // Public, data-free health probe for the VPS / n8n / uptime checks.
    if (action === 'health') return healthProbeAction();
    const identity = getIdentity(e.parameter.token);
    if (!identity) return jsonResponse({ error: 'unauthorized' });
    const role = identity.role;
    if (!serviceActionAllowed(identity, action)) return jsonResponse({ error: 'unauthorized' });
    if (action === 'ping') return jsonResponse({ ok: true, role: role, name: identity.name });
    if (action === 'whoami') return jsonResponse({ role: role, name: identity.name });
    if (action === 'shopify_matches') return getShopifyMatches(e);
    if (action === 'shopify_matches_review') return getShopifyMatchesReview(e);
    if (action === 'get_upload_signature') return getUploadSignature(e);
    if (action === 'qc') return getQC(e);

    // Ajustes-only tools -- duplicate finders/mergers, product merge
    // search/history. Staff role is a valid token but not allowed here.
    if (action === 'find_duplicate_customers') return requireAdmin(role) ? findDuplicateCustomers(e) : jsonResponse({ error: 'unauthorized' });
    if (action === 'find_duplicate_products') return requireAdmin(role) ? findDuplicateProducts(e) : jsonResponse({ error: 'unauthorized' });
    if (action === 'search_products_for_merge') return requireAdmin(role) ? searchProductsForMerge(e) : jsonResponse({ error: 'unauthorized' });
    if (action === 'manual_product_pair') return requireAdmin(role) ? getManualProductPair(e) : jsonResponse({ error: 'unauthorized' });
    if (action === 'product_merge_history') return requireAdmin(role) ? getProductMergeHistory(e) : jsonResponse({ error: 'unauthorized' });
    if (action === 'merge_history') return requireAdmin(role) ? getMergeHistory(e) : jsonResponse({ error: 'unauthorized' });
    if (action === 'get_roles') return requireAdmin(role) ? getRolesAction(e) : jsonResponse({ error: 'unauthorized' });
    if (action === 'orders_index') return requireAdmin(role) ? ordersIndexAction(e) : jsonResponse({ error: 'unauthorized' });
    if (action === 'health_report') return requireAdmin(role) ? healthReportAction(e) : jsonResponse({ error: 'unauthorized' });
    if (action === 'undo_redo_status') return undoRedoStatusAction(e);
    if (action === 'audit_trail') return getAuditTrailAction(e);

    if (action === 'orders') {
      const sheet = getOrdersSheet();
      const data = sheet.getDataRange().getValues();
      if (data.length < 2) return jsonResponse({ records: [] });

            const headers = data[0];
      const statusCol = headers.indexOf('Status');
      const channelCol = headers.indexOf('Channel');
      const customerIdCol = headers.indexOf('Customer ID');
      const createdCol = headers.indexOf('Created Date');
      const orderDateCol = headers.indexOf('Order Date');   // real platform time (FIX_LOG 2.1)

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
          const rawDate = (orderDateCol >= 0 && row[orderDateCol]) || row[createdCol];
          const cd = rawDate ? new Date(rawDate) : null;
          if (!cd || cd < cutoff) continue;
        }

        const obj = { _rowIndex: i + 1 };
        headers.forEach((h, j) => { obj[h] = row[j]; });
        // Owner-only money data: a staff token never receives these fields,
        // so hiding the Análisis page is no longer the only protection.
        if (HIDE_PRICES_FROM_STAFF && role !== 'admin') {
          STAFF_HIDDEN_ORDER_FIELDS.forEach(f => { delete obj[f]; });
        }
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
  const _tLock = Date.now();
  const _gotLock = lock.tryLock(30000);
  tmark('lock_wait_ms', _tLock);
  if (!_gotLock) {
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
// Per-request step timings, merged into the response's _timings by doPost.
let _stepTimings = {};
function tmark(label, t0) { _stepTimings[label] = (_stepTimings[label] || 0) + (Date.now() - t0); }
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

// Pushes this request's buffered entries into the script cache instead of
// writing them to the sheet inline -- the sheet write is what cost
// flush_audit_ms (800ms+) on the critical path of every save (found
// 2026-10-18 chasing the 6s Guardar Pedido delay). A 1-minute trigger
// (flushAuditQueueFromCache, installed once via installAuditQueueTrigger)
// drains the cache in one batch. Entries carry an identity snapshot since
// the cache outlives this execution -- _currentIdentity won't exist when
// the trigger runs later.
function queueAuditEntries() {
  if (!_auditBuffer.length) return;
  const entries = _auditBuffer;
  _auditBuffer = [];
  const identity = _currentIdentity;
  const stamped = entries.map(en => Object.assign({}, en, {
    _person: identity ? identity.name : 'Desconocido',
    _role: identity ? identity.role : '',
    _ts: nowISO(),
  }));
  try {
    const cache = CacheService.getScriptCache();
    const key = 'audit_pending_' + Utilities.getUuid();
    cache.put(key, JSON.stringify(stamped), 300); // 5 min TTL, safety net
    const idxRaw = cache.get('audit_pending_index');
    const idx = idxRaw ? JSON.parse(idxRaw) : [];
    idx.push(key);
    cache.put('audit_pending_index', JSON.stringify(idx), 300);
  } catch (e) {
    // Cache full or unavailable -- fall back to writing inline so the
    // entries are never silently lost.
    Logger.log('queueAuditEntries failed, falling back to inline flush: ' + e.message);
    _auditBuffer = entries;
    flushAudit();
  }
}

// Runs every 1 minute via trigger (see installAuditQueueTrigger). Drains
// everything queueAuditEntries() has stashed in the cache and writes it
// to the Log sheet in one batch, same as flushAudit() does inline.
function flushAuditQueueFromCache() {
  const cache = CacheService.getScriptCache();
  const idxRaw = cache.get('audit_pending_index');
  if (!idxRaw) return;
  const keys = JSON.parse(idxRaw);
  if (!keys.length) return;
  cache.remove('audit_pending_index');

  const all = [];
  keys.forEach(k => {
    const raw = cache.get(k);
    if (!raw) return; // expired before we got to it -- acceptable, audit log is forensic
    cache.remove(k);
    JSON.parse(raw).forEach(en => all.push(en));
  });
  if (!all.length) return;

  try {
    const sheet = getAuditLogSheet();
    if (!sheet) {
      Logger.log('flushAuditQueueFromCache: no "Log <year>" tab found, ' + all.length + ' entries dropped');
      return;
    }
    const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    const rows = all.map(en => {
      const byHeader = {
        'Audit ID': 'LOG-' + Utilities.getUuid().slice(0, 8),
        'Timestamp': en._ts,
        'Person': en._person,
        'Role': en._role,
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
    Logger.log('flushAuditQueueFromCache failed: ' + err.message + ' -- ' + all.length + ' entries lost');
  }
}

// One-time setup: run this once manually from the Apps Script editor
// (select installAuditQueueTrigger in the function dropdown, click Run).
// Creates the single standing 1-minute trigger. Safe to re-run -- clears
// any existing trigger of the same name first so it never duplicates.
function installAuditQueueTrigger() {
  ScriptApp.getProjectTriggers().forEach(t => {
    if (t.getHandlerFunction() === 'flushAuditQueueFromCache') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('flushAuditQueueFromCache').timeBased().everyMinutes(1).create();
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

function undoRedoStatusAction(e) {
  const identity = getIdentity(e.parameter.token);
  if (!identity) return jsonResponse({ error: 'unauthorized' });

  const sheet = getAuditLogSheet();
  if (!sheet) return jsonResponse({ can_undo: false, can_redo: false });
  const data = sheet.getDataRange().getValues();
  const C = getAuditSheetCols(sheet);

  let canUndo = false;
  for (let i = data.length - 1; i >= 1; i--) {
    const row = data[i];
    if (row[C.person] !== identity.name) continue;
    if (UNDOABLE_ACTIONS.indexOf(row[C.action]) === -1) continue;
    if (row[C.undone]) continue;
    canUndo = true;
    break;
  }

  const undoneIds = new Set();
  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    if (row[C.person] === identity.name && row[C.redoOf]) undoneIds.add(String(row[C.redoOf]));
  }
  let canRedo = false;
  for (let i = data.length - 1; i >= 1; i--) {
    const row = data[i];
    if (row[C.person] !== identity.name) continue;
    if (!row[C.undone]) continue;
    if (undoneIds.has(String(row[C.id]))) continue;
    canRedo = true;
    break;
  }

  return jsonResponse({ can_undo: canUndo, can_redo: canRedo });
}

// Timeline for the Calidad detail modal: every logged action touching this
// QC row OR any of its linked Order IDs (import, status changes, QC saves,
// finalize) across every available Log <year> tab -- a shipment can span
// a year boundary (packed in January, imported in December). Returned
// oldest-first so the modal can render it as a simple top-to-bottom story.
function getAuditTrailAction(e) {
  const identity = getIdentity(e.parameter.token);
  if (!identity) return jsonResponse({ error: 'unauthorized' });

  const qcId = String(e.parameter.qc_id || '').trim();
  const orderIds = String(e.parameter.order_ids || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!qcId && !orderIds.length) return jsonResponse({ entries: [] });

  const wantIds = new Set([qcId, ...orderIds].filter(Boolean));
  const ss = openSheetCached(AUDIT_LOG_SHEET_ID);
  const entries = [];

  ss.getSheets().filter(sh => /^Log \d{4}$/.test(sh.getName())).forEach(sheet => {
    const data = sheet.getDataRange().getValues();
    if (data.length < 2) return;
    const C = getAuditSheetCols(sheet);
    for (let i = 1; i < data.length; i++) {
      const row = data[i];
      if (!wantIds.has(String(row[C.recordId]))) continue;
      entries.push({
        timestamp: row[C.ts], person: row[C.person], action: row[C.action],
        record_type: row[C.recordType], field: row[C.field],
        before: row[C.before], after: row[C.after],
        details: row[C.details] ? (function () { try { return JSON.parse(row[C.details]); } catch (e) { return null; } })() : null,
      });
    }
  });

  entries.sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)));
  return jsonResponse({ entries: entries });
}

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    const action = body.action;
    // login is the one POST that runs before authentication: it is how a
    // password becomes a session token.
    if (action === 'login') return loginAction(body);
    _ssCache = {};
    _stepTimings = {};
    const _tAuth = Date.now();
    const identity = getIdentity(body.token);
    if (!identity) return jsonResponse({ error: 'unauthorized' });
    const role = identity.role;
    _currentIdentity = identity; // read by logAudit() -- see audit log section
    tmark('auth_ms', _tAuth);
    if (!serviceActionAllowed(identity, action)) { flushAudit(); return jsonResponse({ error: 'unauthorized' }); }
    return withWriteLock(function () {
      const _tDispatch = Date.now();
      const result = dispatchPostAction(action, body, role);
      const dispatchMs = Date.now() - _tDispatch;
      const _tFlush = Date.now();
      queueAuditEntries(); // cache write only -- real sheet write happens on the 1-min trigger
      const flushMs = Date.now() - _tFlush;
      // Merged onto the response itself -- Apps Script's own log viewer is
      // no longer available, so timing has to travel back to the browser
      // to be inspected at all.
      if (result && typeof result.getContent === 'function') {
        try {
          const parsed = JSON.parse(result.getContent());
          parsed._timings = parsed._timings || {};
          parsed._timings.dispatch_total_ms = dispatchMs;
          parsed._timings.flush_audit_ms = flushMs;
          Object.assign(parsed._timings, _stepTimings);
          return jsonResponse(parsed);
        } catch (e) { /* not JSON for some reason, fall through unmodified */ }
      }
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
    if (action === 'stamp_customer_ids') { stampCustomerIDs(); return jsonResponse({ result: 'done' }); }
    if (action === 'update_order') return updateOrder(body);
    if (action === 'delete_order') return deleteOrder(body);
    if (action === 'import_tiktok_orders') return importTikTokOrders(body);
    if (action === 'import_shopify_order') return importShopifyOrder(body);
    if (action === 'create_customers_bulk') return createCustomersBulk(body);
    if (action === 'save_qc') return saveQC(body);
    if (action === 'logout') return logoutAction(body);
    if (action === 'import_qc_history') return requireAdmin(role) ? importQcHistoryAction(body) : jsonResponse({ error: 'unauthorized' });
    if (action === 'run_health_checks') return requireAdmin(role) ? runHealthChecksAction(body) : jsonResponse({ error: 'unauthorized' });
    if (action === 'reconcile_customers') return requireAdmin(role) ? jsonResponse(reconcileCustomerAggregates()) : jsonResponse({ error: 'unauthorized' });
    if (action === 'revoke_user_sessions') return requireAdmin(role) ? revokeUserSessionsAction(body) : jsonResponse({ error: 'unauthorized' });
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
  const _tSheets = Date.now();
  const ordersSheet = getOrdersSheet();
  const customersSheet = getCustomersSheet();
  tmark('get_sheets_ms', _tSheets);

  if (body.channel === 'TikTok' && body.tracking_id) {
    const _tDupCheck = Date.now();
    const existing = sheetToObjects(ordersSheet);
    const dup = existing.find(o => o['Tracking ID'] === body.tracking_id);
    tmark('tiktok_dup_check_ms', _tDupCheck);
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

  const _tCustRead = Date.now();
  const customers = sheetToObjects(customersSheet);
  tmark('customers_full_read_ms', _tCustRead);
  const _tResolve = Date.now();
  const resolution = findCustomerByUsername(customers, body.username);
  tmark('resolve_customer_ms', _tResolve);
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

  const _tBuild = Date.now();
  const row = oh.map(h => (fieldValues[h] !== undefined ? fieldValues[h] : ''));
  const newRowNum = ordersSheet.getLastRow() + 1;
  forceTextFormat(ordersSheet, oh, ['Order ID', 'Tracking ID'], newRowNum, 1);
  tmark('row_build_ms', _tBuild);
  const _tAppend = Date.now();
  ordersSheet.appendRow(row);
  tmark('append_row_ms', _tAppend);
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
  const _tRow = Date.now();
  const sheet = getOrdersSheet();
  const rowIndex = findOrderRow(sheet, body.order_id);
  tmark('find_order_row_ms', _tRow);
  if (!rowIndex) return jsonResponse({ error: 'Order not found' });

  const _tFields = Date.now();
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const statusCol = headers.indexOf('Status') + 1;

  const oldStatus = sheet.getRange(rowIndex, statusCol).getValue();

  // Same Anotado rules as update_order (see normalizeAnotadoFields), so the
  // undo button can never leave a stale link or an unlinked Anotado.
  const fields = { Status: body.status };
  const anotadoError = normalizeAnotadoFields(sheet, rowIndex, headers, fields, oldStatus);
  if (anotadoError) return jsonResponse({ error: anotadoError });

  sheet.getRange(rowIndex, statusCol).setValue(fields.Status);
  if (fields['Linked Shipment'] !== undefined) {
    const linkCol = headers.indexOf('Linked Shipment') + 1;
    if (linkCol > 0) {
      const oldLink = sheet.getRange(rowIndex, linkCol).getValue();
      sheet.getRange(rowIndex, linkCol).setValue(fields['Linked Shipment']);
      if (String(oldLink) !== String(fields['Linked Shipment'])) {
        logAudit('update_order_status', 'Order', body.order_id, 'Linked Shipment', oldLink, fields['Linked Shipment']);
      }
    }
  }
  tmark('field_writes_ms', _tFields);

  applyStatusSideEffects(sheet, rowIndex, fields.Status, headers, oldStatus);
  if (String(oldStatus) !== String(fields.Status)) {
    logAudit('update_order_status', 'Order', body.order_id, 'Status', oldStatus, fields.Status);
  }

  return jsonResponse({ result: 'updated', order_id: body.order_id, status: fields.Status });
}

// ─── Anotado ───────────────────────────────────────────────────────────────────
// Anotado = a Shopify/Manual order written on a TikTok shipment's label,
// physically waiting to leave inside that package. Linked Shipment holds
// the TikTok TRACKING ID. The Empacar finalize (saveQC) later moves it to
// Enviado together with the TikTok order. Rules enforced here so every page
// behaves identically:
//   - Anotado needs a Linked Shipment (sent now or already on the row)
//   - TikTok orders can never be Anotado (they ARE the shipment)
//   - Anotado to a shipment that already left saves as Enviado instead
//   - Anotado -> Pagado / No Pagado clears the link
// Mutates fields in place. Returns an error string, or null when fine.
function normalizeAnotadoFields(sheet, rowIndex, headers, fields, oldStatus) {
  if (!fields || !fields['Status']) return null;
  const iLink = headers.indexOf('Linked Shipment');
  const iChan = headers.indexOf('Channel');
  const newStatus = String(fields['Status']);

  if (newStatus === 'Anotado') {
    const chan = iChan >= 0 ? String(sheet.getRange(rowIndex, iChan + 1).getValue()) : '';
    if (chan === 'TikTok') return 'Un pedido de TikTok no puede quedar como Anotado';
    const link = String(fields['Linked Shipment'] !== undefined
      ? fields['Linked Shipment']
      : (iLink >= 0 ? sheet.getRange(rowIndex, iLink + 1).getValue() : '')).trim();
    if (!link) return 'Anotado requiere un envío de TikTok vinculado';
    if (isTrackingShipped(sheet, headers, link)) fields['Status'] = 'Enviado';
  } else if (String(oldStatus) === 'Anotado' &&
             (newStatus === 'Pagado' || newStatus === 'No Pagado') &&
             fields['Linked Shipment'] === undefined) {
    fields['Linked Shipment'] = '';
  }
  return null;
}

// True when any TikTok order carrying this tracking ID is already
// Enviado/Archivado. TextFinder on the Tracking ID column only -- no full
// sheet read.
function isTrackingShipped(sheet, headers, trackingId) {
  const iTid = headers.indexOf('Tracking ID');
  const iStat = headers.indexOf('Status');
  const iChan = headers.indexOf('Channel');
  if (iTid < 0 || iStat < 0 || sheet.getLastRow() < 2) return false;
  const col = sheet.getRange(2, iTid + 1, sheet.getLastRow() - 1, 1);
  const hits = col.createTextFinder(String(trackingId)).matchEntireCell(true).findAll();
  return hits.some(h => {
    const r = h.getRow();
    if (iChan >= 0 && String(sheet.getRange(r, iChan + 1).getValue()) !== 'TikTok') return false;
    const s = String(sheet.getRange(r, iStat + 1).getValue());
    return s === 'Enviado' || s === 'Archivado';
  });
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

  // One read and one column write, instead of one setValue per customer.
  const ids = readColumn(cs, idCol);
  const vals = readColumn(cs, countCol);
  const changed = [];
  ids.forEach((v, i) => {
    const k = String(v);
    if (!wanted[k]) return;
    const fresh = counts[k] || 0;
    if (Number(vals[i]) !== fresh) { vals[i] = fresh; changed.push(i); }
  });
  if (changed.length) writeColumnChanges(cs, countCol, vals, changed);
}

function recalculateShipmentCount(customerID) {
  recalculateShipmentCountsFor([customerID]);
}

// Adds a per-customer delta to the existing Shipment Count rather than
// rebuilding it from a full sheet scan -- safe only when the caller is
// certain the delta is correct (finalize: these orders were definitely
// not counted before, since they're being shipped right now). One
// targeted write per affected customer row, not a scan of every order.
// TextFinder per customer (always 1-2 for a finalize) instead of reading
// the whole Customer ID column -- same fix, same reasoning as the order
// lookup above.
function incrementShipmentCounts(incrementByCustomer) {
  const ids = Object.keys(incrementByCustomer);
  if (!ids.length) return;

  const cs = getCustomersSheet();
  const ch = cs.getRange(1, 1, 1, cs.getLastColumn()).getValues()[0];
  const idCol = ch.indexOf('Customer ID');
  const countCol = ch.indexOf('Shipment Count');
  if (idCol < 0 || countCol < 0) return;

  const custIdColumn = cs.getRange(2, idCol + 1, Math.max(cs.getLastRow() - 1, 1), 1);
  ids.forEach(id => {
    const finder = custIdColumn.createTextFinder(id).matchEntireCell(true);
    const found = finder.findNext();
    if (!found) return;
    const cell = cs.getRange(found.getRow(), countCol + 1);
    const current = Number(cell.getValue()) || 0;
    cell.setValue(current + incrementByCustomer[id]);
  });
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
  const stampChanges = [];   // written in one column write below

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
      stampChanges.push({ row: order._rowIndex, id: resolution.customer['Customer ID'] });
      stamped++;
    } else if (resolution) {
      skippedFuzzy++;
    } else {
      notFound++;
      notFoundList.push(username);
    }
  });

  if (stampChanges.length && customerIDCol > 0) {
    const colVals = ordersSheet.getRange(2, customerIDCol, ordersSheet.getLastRow() - 1, 1).getValues();
    stampChanges.forEach(c => { colVals[c.row - 2][0] = c.id; });
    ordersSheet.getRange(2, customerIDCol, colVals.length, 1).setValues(colVals);
  }
  Logger.log(`Stamped: ${stamped} | Fuzzy skipped: ${skippedFuzzy} | Not found: ${notFound}`);
  Logger.log(`Not found list: ${[...new Set(notFoundList)].join(', ')}`);
}

// ─── Update / delete order ──────────────────────────────────────────────────────

function updateOrder(body) {
  // Staff never receive prices (HIDE_PRICES_FROM_STAFF), so a price sent by
  // a staff token is never a deliberate edit -- drop it rather than let a
  // blank or 0 overwrite the real amount.
  if (HIDE_PRICES_FROM_STAFF && _currentIdentity && _currentIdentity.role !== 'admin' && body.fields) {
    STAFF_HIDDEN_ORDER_FIELDS.forEach(f => { delete body.fields[f]; });
  }
  const sheet = getOrdersSheet();
  const rowIndex = findOrderRow(sheet, body.order_id);
  if (!rowIndex) return jsonResponse({ error: 'Order not found' });

  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];

  // Captured before the write loop below touches Status, so
  // applyStatusSideEffects can diff old vs new without a full rescan.
  const statusColForOld = headers.indexOf('Status') + 1;
  const oldStatusForSideEffects = statusColForOld > 0 ? sheet.getRange(rowIndex, statusColForOld).getValue() : null;

  const anotadoError = normalizeAnotadoFields(sheet, rowIndex, headers, body.fields, oldStatusForSideEffects);
  if (anotadoError) return jsonResponse({ error: anotadoError });

  // One read per changed field before its write, so the log shows a real
  // before/after. A handful of fields per call (this is a manual edit
  // form, not a bulk loop), so the extra reads are cheap here.
  const _tFields = Date.now();
  Object.entries(body.fields || {}).forEach(([key, value]) => {
    const col = headers.indexOf(key) + 1;
    if (col > 0) {
      const oldValue = sheet.getRange(rowIndex, col).getValue();
      // Linked Shipment holds a tracking ID -- same corruption risk as the
      // Tracking ID column itself (FIX: forceTextFormat principle).
      if (key === 'Linked Shipment') sheet.getRange(rowIndex, col).setNumberFormat('@');
      sheet.getRange(rowIndex, col).setValue(value);
      if (String(oldValue) !== String(value)) {
        logAudit('update_order', 'Order', body.order_id, key, oldValue, value);
      }
    }
  });

  tmark('field_writes_ms', _tFields);
  if (body.fields && body.fields['Status']) {
    applyStatusSideEffects(sheet, rowIndex, body.fields['Status'], headers, oldStatusForSideEffects);
  }

  return jsonResponse({ result: 'updated', order_id: body.order_id, status: body.fields ? body.fields['Status'] : undefined });
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

  // Deleting a Shopify order used to leave its match row sitting at
  // Pending forever, so the "Shopify pendiente" badge kept counting an
  // order that no longer exists and nothing in the UI could clear it.
  const matchesClosed = closePendingMatchesForShopifyOrder(snapshot['Shopify Order ID']);

  logAuditEvent('delete_order', 'Order', body.order_id, { deleted_row: snapshot, matches_closed: matchesClosed });
  return jsonResponse({ result: 'deleted', order_id: body.order_id, matches_closed: matchesClosed });
}

// Marks any still-Pending Shopify match rows for this Shopify Order ID as
// Order-Deleted, rather than removing them, so the record of what came in
// and what happened to it stays readable. No-op for TikTok/manual orders,
// which have no Shopify Order ID. Returns how many rows were closed.
function closePendingMatchesForShopifyOrder(shopifyOrderId) {
  const id = String(shopifyOrderId || '').trim();
  if (!id) return 0;
  const mSheet = getShopifyMatchesSheet();
  if (!mSheet) return 0;
  const data = mSheet.getDataRange().getValues();
  if (data.length < 2) return 0;

  const h = data[0];
  const iOrder = h.indexOf('Shopify Order ID');
  const iDecision = h.indexOf('Decision');
  const iDecided = h.indexOf('Decided Date');
  if (iOrder < 0 || iDecision < 0) return 0;

  let closed = 0;
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][iOrder] || '').trim() !== id) continue;
    if (String(data[i][iDecision] || '').trim() !== 'Pending') continue;
    mSheet.getRange(i + 1, iDecision + 1).setValue('Order-Deleted');
    if (iDecided >= 0) mSheet.getRange(i + 1, iDecided + 1).setValue(nowISO());
    closed++;
  }
  return closed;
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
// oldStatus is optional: when the caller already knows it, we can do a
// cheap +1/-1 delta instead of rescanning every Orders row just to
// recompute one customer's count (that full-column scan was costing
// 9+ seconds per status change once the sheet grew). Pass null when the
// old status isn't known yet -- falls back to the safe full recalc.
function applyStatusSideEffects(sheet, rowIndex, newStatus, headers, oldStatus) {
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
    const wasCounted = oldStatus === 'Enviado' || oldStatus === 'Archivado';
    const nowCounted = newStatus === 'Enviado' || newStatus === 'Archivado';
    if (oldStatus == null) {
      recalculateShipmentCount(customerID); // old status unknown -- safe full recalc
    } else if (nowCounted && !wasCounted) {
      incrementShipmentCounts({ [customerID]: 1 });
    } else if (!nowCounted && wasCounted) {
      incrementShipmentCounts({ [customerID]: -1 });
    }
    // nowCounted === wasCounted (e.g. No Pagado -> Pagado): no change, skip entirely
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
  // QC and the audit log added 2026-10-19: QC photos/links are the packing
  // evidence and were previously not backed up at all.
  [['Orders', ORDERS_SHEET_ID], ['Customers', CUSTOMERS_SHEET_ID], ['QC', QC_SHEET_ID], ['AuditLog', AUDIT_LOG_SHEET_ID]].forEach(([name, id]) => {
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
// ─── Credentials ───────────────────────────────────────────────────────
// USER_<NAME> = "<password>|<role>" (legacy plain text, still accepted so
// Vel can always type a new password straight into Script Properties) or
// "sha256$<salt>$<hex>|<role>" (written automatically on first login).
function hashPassword(salt, pw) {
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, salt + pw, Utilities.Charset.UTF_8);
  return bytes.map(b => ((b + 256) % 256).toString(16).padStart(2, '0')).join('');
}

function parseUserProp(v) {
  const parts = String(v || '').split('|');
  const cred = parts[0] || '';
  const role = parts[1] === 'admin' ? 'admin' : 'staff';
  if (cred.indexOf('sha256$') === 0) {
    const bits = cred.split('$');
    return { role: role, salt: bits[1] || '', hash: bits[2] || '' };
  }
  return { role: role, password: cred };
}

function passwordMatches(parsed, t) {
  if (!parsed || !t) return false;
  if (parsed.hash) return hashPassword(parsed.salt, t) === parsed.hash;
  return !!parsed.password && parsed.password === t;
}

// Finds which USER_ a password belongs to. Returns { key, name, role, parsed } or null.
function findUserByPassword(props, t) {
  for (const key in props) {
    if (key.indexOf('USER_') !== 0) continue;
    const parsed = parseUserProp(props[key]);
    if (passwordMatches(parsed, t)) return { key: key, name: key.slice(5), role: parsed.role, parsed: parsed };
  }
  return null;
}

function getIdentity(t) {
  if (!t) return null;
  t = String(t);
  const props = PropertiesService.getScriptProperties().getProperties();

  // 1. Session tokens (issued by the login action). Checked first: after
  //    the 2026-10-19 change this is what every browser sends instead of
  //    the raw password.
  if (t.indexOf('sess_') === 0) {
    const sess = props['SESS_' + t];
    if (!sess) return null;
    const p = sess.split('|');               // name|role|expiresMs
    if (Number(p[2]) < Date.now()) return null;
    return { name: p[0], role: p[1] === 'admin' ? 'admin' : 'staff', session: true };
  }

  // 2. Personal passwords (legacy direct use, kept during migration).
  if (ALLOW_PASSWORD_AS_TOKEN) {
    const user = findUserByPassword(props, t);
    if (user) return { name: user.name, role: user.role };
  }

  // 3. Machine identities. role stays 'admin' so existing requireAdmin()
  //    checks keep working; SERVICE_ALLOW narrows what each may call.
  const serviceAdmin = props['API_TOKEN_SERVICE'];
  if (serviceAdmin && t === serviceAdmin) return { name: 'Sistema (VPS)', role: 'admin', service: 'vps' };

  const serviceStaff = props['API_TOKEN_SERVICE_STAFF'];
  if (serviceStaff && t === serviceStaff) return { name: 'Sistema (staff)', role: 'staff' };

  // The n8n workflow that receives Shopify's order webhook and calls
  // import_shopify_order -- a separate machine identity from the VPS, so
  // the audit log can tell "a Shopify order came in automatically" apart
  // from "the VPS ran a TikTok import."
  const serviceShopify = props['API_TOKEN_SERVICE_SHOPIFY'];
  if (serviceShopify && t === serviceShopify) return { name: 'Sistema (Shopify webhook)', role: 'admin', service: 'shopify' };

  return null;
}

// true if this identity may call `action`. Humans: always true here (role
// checks happen per action). Machines: must be on their SERVICE_ALLOW
// list; violations are logged, and only blocked once ENFORCE is on.
function serviceActionAllowed(identity, action) {
  if (!identity || !identity.service) return true;
  const allow = SERVICE_ALLOW[identity.service] || [];
  if (allow.indexOf(action) >= 0) return true;
  Logger.log('service_action_outside_allowlist: ' + identity.service + ' -> ' + action);
  try { logAuditEvent('service_action_outside_allowlist', 'Service', identity.service, { action: action, enforced: SERVICE_ALLOWLIST_ENFORCE }); } catch (e) {}
  return !SERVICE_ALLOWLIST_ENFORCE;
}

// ─── Login sessions ────────────────────────────────────────────────────
// POST { action:'login', password } -> { token, role, name, expires }.
// The browser stores the session token, never the password. On the first
// successful login a plain-text password is upgraded to a salted hash.
function loginAction(body) {
  const pw = String(body.password || '');
  if (!pw) return jsonResponse({ error: 'unauthorized' });
  // Simple brake on password guessing: 20 failed logins in 10 minutes
  // pauses logins for everyone until the window passes.
  const cache = CacheService.getScriptCache();
  const fails = Number(cache.get('login_fails') || 0);
  if (fails >= 20) return jsonResponse({ error: 'Demasiados intentos fallidos. Espera 10 minutos.' });
  const store = PropertiesService.getScriptProperties();
  const props = store.getProperties();
  const user = findUserByPassword(props, pw);
  if (!user) { cache.put('login_fails', String(fails + 1), 600); return jsonResponse({ error: 'unauthorized' }); }

  if (!user.parsed.hash) {
    const salt = Utilities.getUuid().replace(/-/g, '').slice(0, 16);
    store.setProperty(user.key, 'sha256$' + salt + '$' + hashPassword(salt, pw) + '|' + user.role);
  }

  // Drop expired sessions so Script Properties never fills up.
  const now = Date.now();
  Object.keys(props).forEach(k => {
    if (k.indexOf('SESS_') !== 0) return;
    const exp = Number(String(props[k]).split('|')[2]);
    if (!exp || exp < now) store.deleteProperty(k);
  });

  capSessionsFor(user.name, 2);

  const token = 'sess_' + Utilities.getUuid().replace(/-/g, '');
  const expires = now + SESSION_DAYS * 86400000;
  store.setProperty('SESS_' + token, user.name + '|' + user.role + '|' + expires);

  _currentIdentity = { name: user.name, role: user.role };
  logAuditEvent('login', 'User', user.name, {});
  flushAudit();
  return jsonResponse({ token: token, role: user.role, name: user.name, expires: new Date(expires).toISOString() });
}

function logoutAction(body) {
  const t = String(body.token || '');
  if (t.indexOf('sess_') === 0) PropertiesService.getScriptProperties().deleteProperty('SESS_' + t);
  return jsonResponse({ result: 'logged_out' });
}

// Deletes every session belonging to one person (password change, lost phone).
function revokeSessionsFor(personName) {
  const store = PropertiesService.getScriptProperties();
  const props = store.getProperties();
  let n = 0;
  Object.keys(props).forEach(k => {
    if (k.indexOf('SESS_') === 0 && String(props[k]).split('|')[0] === personName) { store.deleteProperty(k); n++; }
  });
  return n;
}

// Keeps at most `keep` existing sessions for this person (oldest dropped
// first), making room for the new one about to be created. Expiry time
// (the 3rd field) is used as a proxy for login recency.
function capSessionsFor(personName, keep) {
  const store = PropertiesService.getScriptProperties();
  const props = store.getProperties();
  const mine = Object.keys(props)
    .filter(k => k.indexOf('SESS_') === 0 && String(props[k]).split('|')[0] === personName)
    .sort((a, b) => Number(String(props[a]).split('|')[2]) - Number(String(props[b]).split('|')[2]));
  while (mine.length > keep) store.deleteProperty(mine.shift());
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
  // Lists real people (USER_<NAME> properties). Never returns a password or
  // hash. The old version read API_TOKEN_ADMIN / API_TOKEN_STAFF, which no
  // longer exist since per-person logins replaced them.
  const props = PropertiesService.getScriptProperties().getProperties();
  const now = Date.now();
  const sessions = {};
  Object.keys(props).forEach(k => {
    if (k.indexOf('SESS_') !== 0) return;
    const p = String(props[k]).split('|');
    if (Number(p[2]) > now) sessions[p[0]] = (sessions[p[0]] || 0) + 1;
  });
  const users = Object.keys(props).filter(k => k.indexOf('USER_') === 0).map(k => {
    const parsed = parseUserProp(props[k]);
    const name = k.slice(5);
    return {
      name: name,
      role: parsed.role,
      password_set: !!(parsed.hash || parsed.password),
      hashed: !!parsed.hash,
      active_sessions: sessions[name] || 0,
    };
  }).sort((a, b) => (a.role === b.role ? a.name.localeCompare(b.name) : (a.role === 'admin' ? -1 : 1)));
  return jsonResponse({ users: users });
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

  if (newPassword.length < 4) return jsonResponse({ error: 'La contraseña debe tener al menos 4 caracteres.' });
  // Two people with the same password would log in as whoever is listed
  // first -- refuse it.
  const clash = findUserByPassword(props.getProperties(), newPassword);
  if (clash && clash.key !== propKey) return jsonResponse({ error: 'Esa contraseña ya la usa otra persona. Elige otra.' });

  const salt = Utilities.getUuid().replace(/-/g, '').slice(0, 16);
  props.setProperty(propKey, 'sha256$' + salt + '$' + hashPassword(salt, newPassword) + '|' + existingRole);
  const revoked = revokeSessionsFor(personName);
  logAuditEvent('update_role_password', 'User', personName, { sessions_revoked: revoked });
  return jsonResponse({ result: 'done', sessions_revoked: revoked });
}

function revokeUserSessionsAction(body) {
  const personName = String(body.person_name || '').trim().toUpperCase();
  if (!personName) return jsonResponse({ error: 'person_name es obligatorio.' });
  const n = revokeSessionsFor(personName);
  logAuditEvent('revoke_user_sessions', 'User', personName, { sessions_revoked: n });
  return jsonResponse({ result: 'done', sessions_revoked: n });
}
// ═══════════════════════════════════════════════════════════════════════════
// TIKTOK IMPORT
// ═══════════════════════════════════════════════════════════════════════════

function importTikTokOrders(body) {
  const orders = getOrdersSheet();
  ensureHeader(orders, 'Order Date');   // real platform order time (see FIX_LOG 2.1)
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
  // created_time arrives raw from the VPS; decide day/month order once per batch.
  const createdDayFirst = detectDayFirst((body.shipments || []).map(s => s.created_time));
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
    const orderDate = parseTikTokDateTime(s.created_time, createdDayFirst);
    if (oh.indexOf('Order Date') >= 0) row[oh.indexOf('Order Date')] = toISOorEmpty(orderDate);

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

    if (lineItems.length > PRODUCT_SLOTS && oh.indexOf('Notes') >= 0) {
      row[oh.indexOf('Notes')] = '⚠ Más de ' + PRODUCT_SLOTS + ' productos — ver TikTok Import History';
    }

    rows.push(row);
    results.push({ tracking_id: tid, inserted: true, customer_id: customerID, shipment_count: shipCount });
    logAuditEvent('import_tiktok_order', 'Order', row[oh.indexOf('Order ID')], {
      tracking_id: tid, channel: 'TikTok', requested_by: body.requested_by || '',
    });
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
  if (UPLOAD_FOLDERS.indexOf(folder) < 0) return jsonResponse({ error: 'Carpeta de fotos no permitida: ' + folder });
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
      // Real logged-in identity, not whatever the client sends (previously
      // always the frontend's hardcoded default) -- same fix as the update
      // path below, needed here too since a brand-new row's first save
      // never reaches that code.
      blank[h.indexOf('Packer')] = _currentIdentity ? _currentIdentity.name : (body.packer || '');
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
    // Skip a URL that's already in a slot: a retried upload call must
    // never store the same photo twice.
    if (addUrl && vals.indexOf(addUrl) < 0) {
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
  // Packer is now the real logged-in identity, not whatever the client
  // sent (previously always the frontend's hardcoded default). The audit
  // log already had this right per-action; the QC row itself did not.
  const packerName = _currentIdentity ? _currentIdentity.name : (body.packer || '');
  if (packerName && packerName !== get('Packer')) {
    logAudit('save_qc', 'QC', qcId, 'Packer', get('Packer'), packerName);
    set('Packer', packerName);
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

  // A single-order shipment writes a pure 18-digit TikTok ID here; without
  // text format Sheets stores it as a number and the last digits are lost.
  forceTextFormat(qcSheet, h, QC_ID_COLUMNS, row, 1);
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
    const _t0 = Date.now();
    const _timings = {};
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
    _timings.headers_read_ms = Date.now() - _t0;

    // A finalize ships 1-2 orders (occasionally a few more for a combined
    // shipment), so reading all ~5000 Orders rows just to find them was
    // the actual bottleneck (confirmed: ~4.9s of a ~7s request). TextFinder
    // looks each one up directly instead -- same mechanism findOrderRow()
    // already uses elsewhere, just against the real Order ID column
    // (found by header) rather than assuming column A. One finder call
    // plus one 1-row read per order id, not a full-column read.
    const _t1 = Date.now();
    const orderIdColumn = orders.getRange(2, iOrderId + 1, Math.max(orders.getLastRow() - 1, 1), 1);
    const shipResults = [];
    const shippedRows = [];        // every order being shipped
    const linkRows = [];           // non-TikTok orders get Linked Shipment = tracking ID
    const customersToRecount = [];

    allOrderIds.forEach(id => {
      const finder = orderIdColumn.createTextFinder(id).matchEntireCell(true);
      const found = finder.findNext();
      if (!found) { shipResults.push({ order_id: id, result: 'not_found' }); return; }
      const idx = found.getRow() - 2; // back to the same 0-based "data row" indexing the rest of this block expects
      shippedRows.push(idx);
      const chan = orders.getRange(idx + 2, iChan + 1).getValue();
      const cust = orders.getRange(idx + 2, iCust + 1).getValue();
      if (iChan >= 0 && iLink >= 0 && chan !== 'TikTok') linkRows.push(idx);
      if ((chan === 'TikTok' || chan === 'Shopify') && cust) {
        customersToRecount.push(String(cust));
      }
      shipResults.push({ order_id: id, result: 'shipped' });
    });
    _timings.order_lookup_ms = Date.now() - _t1;
    _timings.orders_looked_up = allOrderIds.length;

    const _t2 = Date.now();
    const now = nowISO();
    setCellsToValue(orders, iPacked,  shippedRows, now, false);
    setCellsToValue(orders, iLink,    linkRows, body.tracking_id, true);
    setCellsToValue(orders, iStat,    shippedRows, 'Enviado', false);
    setCellsToValue(orders, iShipped, shippedRows, now, false);
    _timings.set_cells_ms = Date.now() - _t2;

    // Shipping is what moves a customer's Shipment Count. Previously this
    // called recalculateShipmentCountsFor(), which re-reads and re-scans
    // EVERY row of the entire Orders sheet to rebuild counts from scratch
    // -- increasingly slow as the sheet grows, and almost certainly the
    // biggest single cost in this request. We already know exactly which
    // orders were just shipped and by whom (customersToRecount, one entry
    // per shipped TikTok/Shopify order), so each affected customer's count
    // just needs +1 per order of theirs in this batch -- no full rescan.
    const _t3 = Date.now();
    const incrementByCustomer = {};
    customersToRecount.forEach(id => { incrementByCustomer[id] = (incrementByCustomer[id] || 0) + 1; });
    incrementShipmentCounts(incrementByCustomer);
    _timings.increment_counts_ms = Date.now() - _t3;

    const _t4 = Date.now();
    logAuditEvent('finalize_shipment', 'QC', qcId, {
      tracking_id: body.tracking_id, order_ids: allOrderIds, shipped: shipResults,
    });
    _timings.log_audit_buffer_ms = Date.now() - _t4;

    result.result = 'created';
    result.orders = shipResults;
    _timings.total_finalize_ms = Date.now() - _t0;
    result._timings = _timings;
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

// PACKING SESSIONS: removed 2026-10-19 (no page called start/end/update_session,
// sessions or active_session since the Sessions feature was retired). The
// 'Session ID' column on the QC sheet is kept and simply stays blank.

// ═══════════════════════════════════════════════════════════════════════════
// PRODUCT CATALOG — accessors + resolution logic
// ═══════════════════════════════════════════════════════════════════════════

const PRODUCT_CATALOG_SHEET_ID = '1XZY9Azw-YizHC6D3l54IMCMKIAFT9qqcVkg4FGf2vSA';

function getProductParentsSheet() {
  return openSheetCached(PRODUCT_CATALOG_SHEET_ID).getSheetByName('Product Parents');
}

function getProductVariantsSheet() {
  return openSheetCached(PRODUCT_CATALOG_SHEET_ID).getSheetByName('Product Variants');
}

function getCatalogSuggestionsSheet() {
  return openSheetCached(PRODUCT_CATALOG_SHEET_ID).getSheetByName('Catalog Suggestions');
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

// Shopify financial_status -> dashboard Status. Absent -> 'Pagado' so the
// webhook keeps working exactly as before until n8n sends the field.
// 'CANCELLED' is an internal marker: never written as a Status.
function shopifyStatusFromFinancial(fs) {
  const f = String(fs || '').toLowerCase();
  if (!f) return 'Pagado';
  if (f === 'paid' || f === 'partially_refunded') return 'Pagado';
  if (f === 'pending' || f === 'authorized' || f === 'partially_paid') return 'No Pagado';
  if (f === 'refunded' || f === 'voided' || f === 'expired') return 'CANCELLED';
  return 'Pagado';
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
    ensureHeader(ordersSheet, 'Order Date');
    const oh = ordersSheet.getRange(1, 1, 1, ordersSheet.getLastColumn()).getValues()[0];
    const financial = String(body.financial_status || '').toLowerCase();
    const targetStatus = shopifyStatusFromFinancial(financial);

    // ─── Dedup check: has this Shopify order already been imported? ───
    // A repeat delivery (orders/paid, orders/updated, or a webhook retry)
    // may carry a newer payment state: move Status FORWARD only, and flag
    // refunds/voids in Notes without touching Status.
    const existing = sheetToObjects(ordersSheet);
    const dup = existing.find(o => String(o['Shopify Order ID'] || '') === shopifyOrderId);
    if (dup) {
      if (financial) {
        const statusCol = oh.indexOf('Status');
        const notesCol = oh.indexOf('Notes');
        if (targetStatus === 'CANCELLED') {
          const marker = '⚠ Shopify: ' + financial;
          const before = String(dup['Notes'] || '');
          if (notesCol >= 0 && before.indexOf(marker) < 0) {
            const after = (before ? before + ' | ' : '') + marker + ' (' + Utilities.formatDate(new Date(), MX_TZ, 'dd/MM/yyyy') + ')';
            ordersSheet.getRange(dup._rowIndex, notesCol + 1).setValue(after);
            logAudit('shopify_status_sync', 'Order', dup['Order ID'], 'Notes', before, after);
          }
          return jsonResponse({ result: 'duplicate_flagged', financial_status: financial, order_id: dup['Order ID'] });
        }
        const current = String(dup['Status'] || 'No Pagado');
        if (statusCol >= 0 && (STATUS_RANK[targetStatus] || 0) > (STATUS_RANK[current] || 0)) {
          ordersSheet.getRange(dup._rowIndex, statusCol + 1).setValue(targetStatus);
          logAudit('shopify_status_sync', 'Order', dup['Order ID'], 'Status', current, targetStatus);
          return jsonResponse({ result: 'status_updated', from: current, to: targetStatus, order_id: dup['Order ID'] });
        }
      }
      return jsonResponse({
        result: 'duplicate',
        message: 'Este pedido de Shopify ya estaba importado.',
        existing_row: dup,
      });
    }

    // A refunded / voided order that was never imported has nothing to pack.
    if (targetStatus === 'CANCELLED') {
      return jsonResponse({ result: 'skipped_cancelled', financial_status: financial, shopify_order_id: shopifyOrderId });
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
    row[oh.indexOf('Status')] = targetStatus;   // was hardcoded 'Pagado'
    if (oh.indexOf('Order Date') >= 0) {
      const od = body.created_at ? new Date(body.created_at) : null;
      row[oh.indexOf('Order Date')] = od && !isNaN(od.getTime()) ? od.toISOString() : nowISO();
    }
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

    if (allLineItems.length > PRODUCT_SLOTS && oh.indexOf('Notes') >= 0) {
      row[oh.indexOf('Notes')] = '⚠ Más de ' + PRODUCT_SLOTS + ' productos — ver el pedido en Shopify';
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
  return openSheetCached(ORDERS_SHEET_ID).getSheetByName('TikTok Import History');
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
// Standalone tool (Ajustes page). Two jobs, in this order:
//
//   1. TikTok Import History: update-if-exists / insert-if-new.
//        - 'Order Status' / 'Order Substatus' ALWAYS overwritten with the
//          incoming CSV value (live lifecycle fields, expected to change).
//        - Shipped/Delivered/Cancelled Time, Cancel By, Cancel Reason are
//          filled ONLY IF CURRENTLY BLANK (one-time facts, never
//          overwritten -- protects against a stale re-upload).
//        - Unmatched rows inserted fresh with whatever fields are present.
//
//   2. Orders: for records whose substatus means the courier already has
//      the package (or is about to collect it), make sure an Orders row
//      actually EXISTS -- creating it if it does not.
//
// Job 2 is the fix for a silent, long-standing gap: this tool used to be
// history-only by design, so a general TikTok export run through it would
// log real shipped/delivered orders into History and leave Orders with no
// corresponding row, forever, with nothing surfaced to the operator. An
// order that has a Tracking ID but no Orders row is by definition an
// anomaly -- better to create it and have it show up as unpacked work in
// the dashboard than to swallow it silently.
//
// Substatus routing:
//   Unpaid / Awaiting shipment -> History only (no Tracking ID yet; these
//       are also already dropped client-side before they reach us).
//   Canceled                   -> History only, never an Orders row.
//   Awaiting collection        -> History + Orders, Status 'Pagado'
//       (label printed, box packed, courier simply hasn't collected yet).
//   In transit / Delivered     -> History + Orders, Status 'Enviado'.
//   Completed                  -> History + Orders, Status 'Archivado'.
//
// Combined shipments: one physical package can carry several TikTok order
// IDs under ONE Tracking ID, and the CSV repeats that Tracking ID on every
// line-item row of every order in it. Orders rows are therefore built per
// TRACKING ID, with Order ID stored " + "-joined -- the same convention
// importTikTokOrders() uses. Price must be summed per UNIQUE ORDER ID
// (Order Amount is the per-order total, repeated on each of that order's
// SKU rows) -- never per row, which would multiply the total by the line
// item count, and never once per shipment, which would drop every order
// but one.

const BACKFILL_SKIP_SUBSTATUSES = ['Awaiting shipment', 'Unpaid'];
const BACKFILL_FILL_ONLY_FIELDS = [
  'Shipped Time', 'Delivered Time', 'Cancelled Time', 'Cancel By', 'Cancel Reason'
];

// Maps a TikTok Order Substatus to the dashboard's own Status, for orders
// that were never packed through this dashboard (pre-migration backlog,
// or any future backfill of historical data). Status only ever moves
// FORWARD along STATUS_FLOW order (No Pagado -> Pagado -> Enviado ->
// Archivado) -- never backward, so a record that's behind an order's
// current real status can't accidentally downgrade it.
//
// Keys are lowercased at lookup time (see backfillTargetStatus) because
// TikTok's casing for these values has not proven stable across exports.
const BACKFILL_SUBSTATUS_TO_STATUS = {
  'awaiting collection': 'Pagado',
  'in transit':          'Enviado',
  'delivered':           'Enviado',
  'completed':           'Archivado',
};
const STATUS_RANK = { 'No Pagado': 0, 'Pagado': 1, 'Anotado': 1.5, 'Enviado': 2, 'Archivado': 3 };

function backfillTargetStatus(substatus) {
  return BACKFILL_SUBSTATUS_TO_STATUS[String(substatus || '').trim().toLowerCase()] || '';
}

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

// Combined shipments store a " + "-joined Order ID (see importTikTokOrders).
// One component order having a given substatus means the whole physical
// shipment has it, so this maps every individual TikTok order_id to the
// Orders row that contains it, however that row's Order ID is joined.
function buildOrderIdComponentIndex(ordersSheet, oh) {
  const iOrderId = oh.indexOf('Order ID');
  const lastRow = ordersSheet.getLastRow();
  if (lastRow < 2 || iOrderId < 0) return {};
  const idVals = readColumn(ordersSheet, iOrderId);
  const index = {};
  idVals.forEach((v, i) => {
    String(v || '').split(' + ').forEach(part => {
      const p = part.trim();
      if (p) index[p] = i; // 0-based data row index
    });
  });
  return index;
}

// ─── HISTORY PASS ──────────────────────────────────────────────────────────
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
  // Guard against the same order/SKU appearing twice in ONE incoming file:
  // without this, both copies miss rowIndexByKey and get inserted, which is
  // exactly how duplicate history rows accumulated across past runs.
  const seenThisRun = {};

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
    } else if (seenThisRun[key]) {
      // Second copy of a key that is brand new to the sheet but already
      // queued for insert by an earlier row in this same file.
      skippedCount++;
      return;
    } else {
      // ─── Not found: insert fresh row, all available fields ────────────
      seenThisRun[key] = true;
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

// ─── ORDERS PASS: grouping ─────────────────────────────────────────────────
// Groups Orders-eligible records into one entry per Tracking ID, mirroring
// the VPS's group_shipments() (tiktok_lib.py) so both import paths build
// Orders rows from identically-shaped data.
//
// Price: order_amount is the per-ORDER total, repeated on every SKU row of
// that order. We therefore take it once per unique order_id (max, so a
// divergent row can never silently lower the total) and sum those per-order
// figures across the shipment.
function groupBackfillShipments(records) {
  const groups = {};
  // Decide day/month order once for the whole file (FIX_LOG 0.2).
  const dayFirst = detectDayFirst(records.map(r => r.created_time));

  records.forEach(rec => {
    const targetStatus = backfillTargetStatus(rec.order_substatus);
    if (!targetStatus) return;                       // Canceled / Unpaid / Awaiting shipment / unmapped

    const tid = String(rec.tracking_id || '').trim();
    if (!tid) return;                                // no label yet -- cannot be an Orders row

    const orderId = String(rec.order_id || '').replace(/\D/g, '');
    if (!orderId) return;

    if (!groups[tid]) {
      groups[tid] = {
        tracking_id:     tid,
        order_ids:       [],
        username:        '',
        products:        [],
        line_items:      [],
        price_by_order:  {},
        best_status:     'No Pagado',
        created_ms:      0,
      };
    }
    const g = groups[tid];

    if (g.order_ids.indexOf(orderId) === -1) g.order_ids.push(orderId);

    // First non-empty buyer username wins; every row of a shipment carries
    // the same buyer, so this is stable.
    if (!g.username) g.username = String(rec.buyer_username || '').trim();

    // Earliest Created Time across the shipment's rows, as a plain string
    // compare -- TikTok's format sorts correctly lexicographically within a
    // single export, and this is only ever used as a display/record date.
    // Earliest real Created Time across the shipment's rows, compared as
    // dates. (Was a plain string compare, which picks the wrong "earliest"
    // across months for day-first text.)
    const ctDate = parseTikTokDateTime(rec.created_time, dayFirst);
    if (ctDate && (!g.created_ms || ctDate.getTime() < g.created_ms)) g.created_ms = ctDate.getTime();

    const qtyRaw = String(rec.quantity || '').trim();
    const qty = /^\d+$/.test(qtyRaw) ? parseInt(qtyRaw, 10) : 1;
    const name = String(rec.product_name || '').trim();
    const variation = String(rec.variation || '').trim();
    if (name) {
      g.products.push(qty + 'x ' + name + (variation ? ' (' + variation + ')' : ''));
      g.line_items.push({
        sku_id:    String(rec.sku_id || '').trim(),
        product:   name,
        variation: variation,
        qty:       qty,
      });
    }

    // Per-unique-order price. rec.order_amount is already a number (the
    // frontend strips the "MXN " prefix and comma separators before send).
    const amt = Number(rec.order_amount) || 0;
    const prev = g.price_by_order[orderId];
    g.price_by_order[orderId] = (prev === undefined || amt > prev) ? amt : prev;

    // Status for the whole shipment = the furthest-along status any of its
    // component orders reports (never moves backward).
    if (STATUS_RANK[targetStatus] > STATUS_RANK[g.best_status]) {
      g.best_status = targetStatus;
    }
  });

  return Object.keys(groups).map(tid => {
    const g = groups[tid];
    let total = 0;
    Object.keys(g.price_by_order).forEach(oid => { total += g.price_by_order[oid]; });
    g.price = Math.round(total * 100) / 100;
    g.products_str = g.products.join('; ');
    delete g.price_by_order;
    delete g.products;
    return g;
  });
}

// ─── ORDERS PASS: create the missing rows ──────────────────────────────────
// Only ever CREATES rows that are absent. A shipment whose Tracking ID --
// or any of whose component Order IDs -- is already represented in Orders
// is left completely alone here; moving an existing row's status forward is
// syncOrderStatusFromBackfill()'s job, not this one.
//
// Customer resolution is username-only (exact -> alias -> fuzzy, via the
// shared findCustomerByUsername), because this path has no shipping-label
// PDF and therefore no address/phone to match on. An unrecognised username
// gets a bare stub customer (username only, no address) -- acceptable
// because the Customers sheet is already rich enough that genuine new
// stubs are rare, and they enrich naturally on the customer's next normal
// order.
function createMissingOrdersFromBackfill(records, dryRun) {
  const shipments = groupBackfillShipments(records);
  if (!shipments.length) {
    return { orders_created: 0, customers_created: 0, orders_skipped_existing: 0, fuzzy_count: 0, fuzzy_review: [] };
  }

  const orders = getOrdersSheet();
  if (!dryRun) ensureHeader(orders, 'Order Date');
  const oh = orders.getRange(1, 1, 1, orders.getLastColumn()).getValues()[0];
  const componentIndex = buildOrderIdComponentIndex(orders, oh);

  const iTrk = oh.indexOf('Tracking ID');
  const trackingSet = {};
  if (iTrk >= 0 && orders.getLastRow() > 1) {
    readColumn(orders, iTrk).forEach(v => {
      const t = String(v || '').trim();
      if (t) trackingSet[t] = true;
    });
  }

  // Which shipments genuinely need a new row?
  const toCreate = [];
  let skippedExisting = 0;
  shipments.forEach(s => {
    if (trackingSet[s.tracking_id]) { skippedExisting++; return; }
    const anyKnown = s.order_ids.some(oid => componentIndex[oid] !== undefined);
    if (anyKnown) { skippedExisting++; return; }
    toCreate.push(s);
  });

  if (!toCreate.length) {
    return { orders_created: 0, customers_created: 0, orders_skipped_existing: skippedExisting, fuzzy_count: 0, fuzzy_review: [] };
  }

  // ─── Resolve customers (username-only: exact or alias ONLY) ───────────────
  // A 'fuzzy' hit (prefix-minus-one-character) is a guess: existing "maria"
  // would capture "mariana.art". Same rule as createOrder() and
  // stampCustomerIDs(): never written unattended. Fuzzy hits are left
  // unlinked (no stub either -- that would duplicate the near-match) and
  // returned in fuzzy_review for a human to confirm.
  const customersSheet = getCustomersSheet();
  const customers = sheetToObjects(customersSheet);

  let maxNum = 0;
  customers.forEach(c => {
    const id = c['Customer ID'];
    if (typeof id === 'string' && id.indexOf('CUST-') === 0) {
      const n = parseInt(id.replace('CUST-', ''), 10);
      if (!isNaN(n) && n > maxNum) maxNum = n;
    }
  });

  const newCustomerRows = [];
  const newCustomerLog = [];
  const resolvedByUsername = {};   // normalized username -> Customer ID ('' = left unlinked)
  const fuzzyReview = [];

  toCreate.forEach(s => {
    if (!s.username) { s.customer_id = ''; return; }
    const norm = normalizeUsername(s.username);
    if (resolvedByUsername[norm] !== undefined) {
      s.customer_id = resolvedByUsername[norm];
      return;
    }
    const hit = findCustomerByUsername(customers, s.username);
    if (hit && hit.customer && hit.customer['Customer ID'] && hit.confidence !== 'fuzzy') {
      s.customer_id = hit.customer['Customer ID'];
      resolvedByUsername[norm] = s.customer_id;
      return;
    }
    if (hit && hit.confidence === 'fuzzy') {
      s.customer_id = '';
      resolvedByUsername[norm] = '';
      fuzzyReview.push({
        tracking_id: s.tracking_id, username: s.username,
        suggested_customer_id: hit.customer['Customer ID'],
        suggested_username: hit.customer['Primary Username'] || '',
      });
      return;
    }
    // No match anywhere -- create a bare stub.
    maxNum++;
    const newId = 'CUST-' + String(maxNum).padStart(3, '0');
    s.customer_id = newId;
    resolvedByUsername[norm] = newId;
    newCustomerLog.push({ customer_id: newId, username: s.username });
    newCustomerRows.push({ customer_id: newId, username: s.username });
  });

  // ─── Resolve SKUs to Catalog IDs in ONE pass, as the live import does ───
  const allLineItems = [];
  toCreate.forEach(s => { (s.line_items || []).forEach(li => allLineItems.push(li)); });
  const skuToCatalogId = (!dryRun && allLineItems.length) ? resolveLineItemsBatch(allLineItems) : {};

  if (dryRun) {
    return {
      orders_created: toCreate.length,
      customers_created: newCustomerRows.length,
      orders_skipped_existing: skippedExisting,
      fuzzy_count: fuzzyReview.length,
      fuzzy_review: fuzzyReview.slice(0, 50),
    };
  }

  // ─── Write the new customer stubs ──────────────────────────────────────
  if (newCustomerRows.length) {
    const ch = customersSheet.getRange(1, 1, 1, customersSheet.getLastColumn()).getValues()[0];
    const rows = newCustomerRows.map(nc => {
      const fieldValues = {
        'Customer ID':          nc.customer_id,
        'Primary Username':     nc.username,
        'Aliases':              '',
        'First Name':           '',
        'Surname':              '',
        'Initials (TT Format)': '',
        'Street + Number':      '',
        'City':                 '',
        'State':                '',
        'ZIP':                  '',
        'Phone Partial':        '',
        'Phone Full':           '',
        'Email':                '',
        'First Order Date':     nowISO(),
        'Shipment Count':       0,
        'Notes':                'Creado por la importación histórica de TikTok (sin dirección)',
        'Merge Flag':           false,
      };
      return ch.map(h => (fieldValues[h] !== undefined ? fieldValues[h] : ''));
    });
    customersSheet.getRange(customersSheet.getLastRow() + 1, 1, rows.length, rows[0].length).setValues(rows);
    newCustomerLog.forEach(c => {
      logAuditEvent('create_customer', 'Customer', c.customer_id, {
        primary_username: c.username || '',
        source: 'tiktok_backfill',
      });
    });
  }

  // ─── Build the Orders rows ─────────────────────────────────────────────
  const PRODUCT_SLOTS = 30;
  const slotCols = [];
  for (let n = 1; n <= PRODUCT_SLOTS; n++) {
    slotCols.push({
      catalogCol: oh.indexOf('Product ' + n + ' Catalog ID'),
      qtyCol:     oh.indexOf('Product ' + n + ' Qty'),
    });
  }

  const rows = [];
  toCreate.forEach(s => {
    const row = new Array(oh.length).fill('');
    const joinedOrderIds = s.order_ids.join(' + ') || generateUUID();

    row[oh.indexOf('Order ID')]         = joinedOrderIds;
    row[oh.indexOf('Tracking ID')]      = s.tracking_id;
    row[oh.indexOf('Customer ID')]      = s.customer_id || '';
    row[oh.indexOf('Primary Username')] = s.username || '';
    row[oh.indexOf('Channel')]          = 'TikTok';
    row[oh.indexOf('Status')]           = s.best_status;
    row[oh.indexOf('Products')]         = s.products_str || '';
    row[oh.indexOf('Price')]            = Number(s.price) || 0;
    // Created Date = when it entered the dashboard (same meaning as every
    // other import path). The real TikTok order time goes to Order Date.
    row[oh.indexOf('Created Date')]     = nowISO();
    if (oh.indexOf('Order Date') >= 0) row[oh.indexOf('Order Date')] = s.created_ms ? new Date(s.created_ms).toISOString() : '';
    if (lineItemsTooMany(s) && oh.indexOf('Notes') >= 0) row[oh.indexOf('Notes')] = '⚠ Más de 30 productos — ver TikTok Import History';
    row[oh.indexOf('Linked Shipment')]  = s.tracking_id;

    const lineItems = s.line_items || [];
    for (let i = 0; i < lineItems.length && i < PRODUCT_SLOTS; i++) {
      const li = lineItems[i];
      const catalogId = skuToCatalogId[String(li.sku_id || '').trim()] || '';
      const slot = slotCols[i];
      if (slot.catalogCol >= 0) row[slot.catalogCol] = catalogId;
      if (slot.qtyCol >= 0)     row[slot.qtyCol] = Number(li.qty) || 0;
    }

    rows.push(row);
  });

  if (rows.length) {
    const startRow = orders.getLastRow() + 1;
    forceTextFormat(orders, oh, ['Order ID', 'Tracking ID'], startRow, rows.length);
    orders.getRange(startRow, 1, rows.length, rows[0].length).setValues(rows);

    toCreate.forEach(s => {
      logAuditEvent('backfill_create_order', 'Order', s.order_ids.join(' + '), {
        tracking_id: s.tracking_id,
        channel:     'TikTok',
        status:      s.best_status,
        customer_id: s.customer_id || '',
        source:      'tiktok_backfill',
      });
    });
  }

  return {
    orders_created:          rows.length,
    customers_created:       newCustomerRows.length,
    orders_skipped_existing: skippedExisting,
    fuzzy_count:             fuzzyReview.length,
    fuzzy_review:            fuzzyReview.slice(0, 50),
  };
}

function lineItemsTooMany(s) { return (s.line_items || []).length > 30; }

// ─── ORDERS PASS: move EXISTING rows' status forward ───────────────────────
// Called once per backfill commit, after runTikTokBackfill. Separate pass
// over the SAME records, writing only to Orders' Status column -- the
// import history write above is unaffected either way.
function syncOrderStatusFromBackfill(records) {
  const ordersSheet = getOrdersSheet();
  const oh = ordersSheet.getRange(1, 1, 1, ordersSheet.getLastColumn()).getValues()[0];
  const iStatus = oh.indexOf('Status');
  if (iStatus < 0) return { status_updated: 0 };

  const componentIndex = buildOrderIdComponentIndex(ordersSheet, oh);
  const statusVals = readColumn(ordersSheet, iStatus);
  const changed = [];
  const changeLog = []; // { rowIdx, orderId, before, after }

  records.forEach(rec => {
    const targetStatus = backfillTargetStatus(rec.order_substatus);
    if (!targetStatus) return; // Unpaid / Awaiting shipment / Canceled / unmapped -- do nothing

    const orderId = String(rec.order_id || '').trim();
    if (!orderId) return;
    const rowIdx = componentIndex[orderId];
    if (rowIdx === undefined) return; // not in Orders -- createMissingOrders handles it

    const current = String(statusVals[rowIdx] || 'No Pagado');
    const currentRank = STATUS_RANK[current] !== undefined ? STATUS_RANK[current] : 0;
    const targetRank = STATUS_RANK[targetStatus];
    if (targetRank <= currentRank) return; // never move backward, never a no-op write

    statusVals[rowIdx] = targetStatus;
    changed.push(rowIdx);
    changeLog.push({ rowIdx: rowIdx, before: current, after: targetStatus });
  });

  if (changed.length) {
    writeColumnChanges(ordersSheet, iStatus, statusVals, changed);
    // Order ID column re-read only for the rows that actually changed, to
    // log real IDs rather than row indexes.
    const idVals = readColumn(ordersSheet, oh.indexOf('Order ID'));
    changeLog.forEach(c => {
      logAudit('backfill_status_sync', 'Order', idVals[c.rowIdx], 'Status', c.before, c.after);
    });
  }

  return { status_updated: changed.length };
}

// ─── ENTRY POINTS ──────────────────────────────────────────────────────────

function backfillTikTokHistoryPreview(body) {
  const records = body.records || [];
  const history = runTikTokBackfill(records, true);
  const ordersPreview = createMissingOrdersFromBackfill(records, true);
  return jsonResponse(Object.assign({}, history, ordersPreview));
}

function backfillTikTokHistoryCommit(body) {
  const records = body.records || [];

  // Order matters: history first (cheap, self-contained), then create any
  // missing Orders rows, and only then sync statuses -- so a row created
  // moments ago is already at its correct status and the sync pass finds
  // nothing left to do for it.
  const history = runTikTokBackfill(records, false);
  const ordersResult = createMissingOrdersFromBackfill(records, false);
  const statusResult = syncOrderStatusFromBackfill(records);

  const combined = Object.assign({}, history, ordersResult, statusResult);
  logAuditEvent('backfill_tiktok_commit', 'TikTokImportHistory', '', combined);
  return jsonResponse(combined);
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
  return openSheetCached(PRODUCT_CATALOG_SHEET_ID).getSheetByName('Dismissed Product Pairs');
}

function getProductMergeHistorySheet() {
  return openSheetCached(PRODUCT_CATALOG_SHEET_ID).getSheetByName('Product Merge History');
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
  return openSheetCached(CUSTOMERS_SHEET_ID).getSheetByName('Dismissed Duplicates');
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
  // FIX_LOG 2026-10-18 (found via live testing): dupBlockingKeys() can
  // return the same key twice for ONE customer (e.g. username "farlirod"
  // and alias "farlirod2.0" both produce 'up:farli') -- without this Set,
  // that customer's own index lands in the bucket twice, and the pairing
  // loop below then compares that customer against itself, scoring 100%.
  // Deduping per customer here is correct regardless of which key type
  // causes the repeat, current or future.
  const buckets = {};
  const addKey = (k, i) => { (buckets[k] || (buckets[k] = new Set())).add(i); };
  feats.forEach((f, i) => new Set(dupBlockingKeys(f)).forEach(k => addKey(k, i)));
  Object.keys(buckets).forEach(k => { buckets[k] = Array.from(buckets[k]); });

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
    } else if (item.decision === 'ignore') {
      // Closes the match out without creating or linking a customer and
      // without touching any order row -- for test or junk orders that
      // shouldn't become a customer at all. Returns before the shared tail
      // below, which assumes a real target customer exists.
      pending.forEach(r => { matchChanges.push({ r: r, decision: 'Ignored', linked: '' }); });
      results.push({ key: key, ok: true, customer_id: '', matches_resolved: pending.length, orders_updated: 0, ignored: true });
      logAuditEvent('resolve_shopify_match', 'ShopifyMatch', String(key), {
        decision: 'ignore', matches_resolved: pending.length, orders_updated: 0,
      });
      return;
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
  return openSheetCached(CUSTOMERS_SHEET_ID).getSheetByName('Merge History');
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

function diagnoseOrphanedHistory() {
  const orders = getOrdersSheet();
  const oh = orders.getRange(1, 1, 1, orders.getLastColumn()).getValues()[0];
  const iOrderId = oh.indexOf('Order ID');
  const ordersLastRow = orders.getLastRow();
  const ordersData = ordersLastRow > 1 ? orders.getRange(2, 1, ordersLastRow - 1, oh.length).getValues() : [];

  // Build a set of every individual Order ID that appears ANYWHERE in Orders,
  // including inside "+"-joined combined-shipment cells.
  const ordersIdSet = {};
  ordersData.forEach(r => {
    const raw = String(r[iOrderId] || '');
    raw.split('+').map(s => s.trim()).filter(Boolean).forEach(id => { ordersIdSet[id] = true; });
  });

  const history = getTikTokImportHistorySheet();
  const hh = history.getRange(1, 1, 1, history.getLastColumn()).getValues()[0];
  const iHistOrderId = hh.indexOf('Order ID');
  const iHistStatus = hh.indexOf('Order Status');
  const iHistSubstatus = hh.indexOf('Order Substatus');
  const histLastRow = history.getLastRow();
  const histData = histLastRow > 1 ? history.getRange(2, 1, histLastRow - 1, hh.length).getValues() : [];

  // ── Duplicate-row check within History itself ──
  const keyCounts = {};
  const iHistSku = hh.indexOf('SKU ID');
  histData.forEach(r => {
    const key = String(r[iHistOrderId] || '').trim() + '||' + String(r[iHistSku] || '').trim();
    keyCounts[key] = (keyCounts[key] || 0) + 1;
  });
  const dupKeys = Object.keys(keyCounts).filter(k => keyCounts[k] > 1);
  const dupRowSurplus = dupKeys.reduce((sum, k) => sum + (keyCounts[k] - 1), 0);

  // ── Orphan check: History order IDs with no match anywhere in Orders ──
  const orphanRows = [];
  const uniqueOrphanOrderIds = {};
  histData.forEach(r => {
    const oid = String(r[iHistOrderId] || '').trim();
    if (!oid) return;
    if (!ordersIdSet[oid]) {
      uniqueOrphanOrderIds[oid] = true;
      orphanRows.push({
        order_id: oid,
        status: r[iHistStatus],
        substatus: r[iHistSubstatus]
      });
    }
  });

  // Breakdown of orphans by status, so we know how many are "real" (Shipped/
  // Delivered) vs legitimately-excluded (Cancelled/Unpaid/Awaiting shipment).
  const statusBreakdown = {};
  orphanRows.forEach(o => {
    const key = (o.status || '(blank)') + ' / ' + (o.substatus || '(blank)');
    statusBreakdown[key] = (statusBreakdown[key] || 0) + 1;
  });

  Logger.log('=== ORDERS SHEET ===');
  Logger.log('Total Orders rows: ' + ordersData.length);
  Logger.log('Unique individual Order IDs found in Orders (incl. "+"-joined): ' + Object.keys(ordersIdSet).length);

  Logger.log('=== IMPORT HISTORY SHEET ===');
  Logger.log('Total History rows: ' + histData.length);
  Logger.log('Duplicate Order ID + SKU ID keys in History: ' + dupKeys.length + ' (surplus rows: ' + dupRowSurplus + ')');

  Logger.log('=== ORPHAN CHECK (History order IDs missing from Orders) ===');
  Logger.log('Total orphaned History rows: ' + orphanRows.length);
  Logger.log('Unique orphaned Order IDs: ' + Object.keys(uniqueOrphanOrderIds).length);
  Logger.log('--- Breakdown by Status/Substatus ---');
  Object.keys(statusBreakdown).sort((a, b) => statusBreakdown[b] - statusBreakdown[a]).forEach(k => {
    Logger.log(k + ': ' + statusBreakdown[k]);
  });

  Logger.log('--- First 20 orphaned order IDs (for spot-checking) ---');
  orphanRows.slice(0, 20).forEach(o => Logger.log(o.order_id + ' | ' + o.status + ' / ' + o.substatus));
}

function recomputeAllShipmentCounts() {
  const ordersSheet = getOrdersSheet();
  const oh = ordersSheet.getRange(1, 1, 1, ordersSheet.getLastColumn()).getValues()[0];

  // Single shared definition: TikTok/Shopify orders in Enviado or Archivado.
  const counts = buildShippedCountMap(ordersSheet, oh);

  const cs = getCustomersSheet();
  const ch = cs.getRange(1, 1, 1, cs.getLastColumn()).getValues()[0];
  const idCol = ch.indexOf('Customer ID');
  const countCol = ch.indexOf('Shipment Count');
  if (idCol < 0 || countCol < 0) {
    Logger.log('ERROR: Customer ID or Shipment Count column not found.');
    return;
  }

  const idVals = readColumn(cs, idCol);
  const oldVals = readColumn(cs, countCol);

  let changedCount = 0, zeroedCount = 0;
  const newVals = idVals.map((v, i) => {
    const k = String(v || '');
    const fresh = k ? (counts[k] || 0) : 0;
    const prev = Number(oldVals[i]) || 0;
    if (fresh !== prev) {
      changedCount++;
      if (fresh === 0 && prev > 0) zeroedCount++;
    }
    return [fresh];
  });

  // One batched write for the whole column, not a cell at a time.
  if (newVals.length) {
    cs.getRange(2, countCol + 1, newVals.length, 1).setValues(newVals);
  }

  Logger.log('Customers scanned: ' + newVals.length);
  Logger.log('Counts changed: ' + changedCount);
  Logger.log('Dropped to zero (had shipments before, none now): ' + zeroedCount);
  Logger.log('Customers with at least 1 shipment: ' +
    newVals.filter(r => r[0] > 0).length);
}

// ═══════════════════════════════════════════════════════════════════════════
// FIX-PACK 2026-10-19 — reconcile, health, Airtable QC import, triggers, tests
// ═══════════════════════════════════════════════════════════════════════════

// ─── Customer aggregates: the one authoritative recompute (FIX_LOG 2.4) ────
// Shipment Count: buildShippedCountMap() (TikTok/Shopify, Enviado/Archivado).
// First Order Date: earliest Order Date (fallback Created Date) per customer.
// Only cells that actually differ are written. Runs nightly (installTriggers)
// and on demand from Ajustes (action reconcile_customers).
function reconcileCustomerAggregates() {
  const ordersSheet = getOrdersSheet();
  const oh = ordersSheet.getRange(1, 1, 1, ordersSheet.getLastColumn()).getValues()[0];
  const counts = buildShippedCountMap(ordersSheet, oh);

  const cidCol = readColumn(ordersSheet, oh.indexOf('Customer ID'));
  const odCol = oh.indexOf('Order Date') >= 0 ? readColumn(ordersSheet, oh.indexOf('Order Date')) : [];
  const cdCol = readColumn(ordersSheet, oh.indexOf('Created Date'));
  const firstMap = {};
  for (let i = 0; i < cidCol.length; i++) {
    const k = String(cidCol[i] || '');
    if (!k) continue;
    const raw = odCol[i] || cdCol[i];
    const d = raw instanceof Date ? raw : (raw ? new Date(raw) : null);
    if (!d || isNaN(d.getTime())) continue;
    if (!firstMap[k] || d.getTime() < firstMap[k]) firstMap[k] = d.getTime();
  }

  const cs = getCustomersSheet();
  const ch = cs.getRange(1, 1, 1, cs.getLastColumn()).getValues()[0];
  const iId = ch.indexOf('Customer ID'), iCount = ch.indexOf('Shipment Count'), iFirst = ch.indexOf('First Order Date');
  if (iId < 0 || iCount < 0) return { error: 'Customers sheet is missing Customer ID or Shipment Count.' };

  const ids = readColumn(cs, iId);
  const countVals = readColumn(cs, iCount);
  const firstVals = iFirst >= 0 ? readColumn(cs, iFirst) : [];
  const countChanged = [], firstChanged = [];
  let zeroed = 0;

  ids.forEach((v, i) => {
    const k = String(v || '');
    if (!k) return;
    const fresh = counts[k] || 0;
    if (Number(countVals[i]) !== fresh) {
      if (fresh === 0 && Number(countVals[i]) > 0) zeroed++;
      countVals[i] = fresh; countChanged.push(i);
    }
    if (iFirst >= 0 && firstMap[k]) {
      const cur = firstVals[i] instanceof Date ? firstVals[i].getTime() : (firstVals[i] ? Date.parse(firstVals[i]) : NaN);
      if (isNaN(cur) || Math.abs(cur - firstMap[k]) > 60000) {
        firstVals[i] = new Date(firstMap[k]).toISOString(); firstChanged.push(i);
      }
    }
  });

  writeColumnChanges(cs, iCount, countVals, countChanged);
  if (iFirst >= 0) writeColumnChanges(cs, iFirst, firstVals, firstChanged);

  const summary = {
    customers: ids.length, shipment_counts_changed: countChanged.length,
    dropped_to_zero: zeroed, first_order_dates_changed: firstChanged.length,
    ran_at: nowISO(),
  };
  PropertiesService.getScriptProperties().setProperty('LAST_RECONCILE_AT', summary.ran_at);
  Logger.log(JSON.stringify(summary));
  return summary;
}

// ─── Public health probe (no data, booleans only) ───────────────────────
function healthProbeAction() {
  const out = { version: SCRIPT_VERSION, ok: true, sheets: {} };
  const check = (label, fn) => { try { out.sheets[label] = !!fn(); } catch (e) { out.sheets[label] = false; } };
  check('orders', getOrdersSheet);
  check('customers', getCustomersSheet);
  check('qc', getQCSheet);
  check('history', getTikTokImportHistorySheet);
  Object.keys(out.sheets).forEach(k => { if (!out.sheets[k]) out.ok = false; });
  const p = PropertiesService.getScriptProperties();
  out.last_reconcile_at = p.getProperty('LAST_RECONCILE_AT') || null;
  out.last_health_at = p.getProperty('LAST_HEALTH_AT') || null;
  return jsonResponse(out);
}

// ─── Orders index for machine jobs (Airtable QC import) ─────────────────
// Slim: one entry per Orders row with the fields needed to resolve a
// TikTok order ID to its shipment. No money fields.
function ordersIndexAction(e) {
  const sheet = getOrdersSheet();
  const data = sheet.getDataRange().getValues();
  if (data.length < 2) return jsonResponse({ records: [] });
  const h = data[0];
  const pick = ['Order ID', 'Tracking ID', 'Customer ID', 'Primary Username', 'Status', 'Channel', 'Packed Date'];
  const idx = pick.map(c => h.indexOf(c));
  const records = data.slice(1).map(r => {
    const o = {};
    pick.forEach((c, j) => { if (idx[j] >= 0) o[c] = r[idx[j]] instanceof Date ? r[idx[j]].toISOString() : String(r[idx[j]] || ''); });
    return o;
  });
  return jsonResponse({ records: records });
}

// ─── Airtable QC history import (FIX_LOG 3.4) ───────────────────────────
// Called in batches by vps-reference/airtable_qc_import.py with the VPS
// service token. Body: { records: [...], dry_run?: bool }. Each record:
// { airtable_key, tracking_id, tiktok_order_ids[], customer_id, username,
//   packer, surtidor, timestamp (ISO), content[], box[], archived }.
// Skips any Tracking ID that already has a QC row, so re-sending a batch is
// safe. Fills Orders 'Packed Date' only where it is blank.
function importQcHistoryAction(body) {
  const recs = body.records || [];
  const dryRun = !!body.dry_run;
  const qcSheet = getQCSheet();
  if (!dryRun) ensureHeader(qcSheet, 'Surtidor');
  const h = qcSheet.getRange(1, 1, 1, qcSheet.getLastColumn()).getValues()[0];
  const iTrk = h.indexOf('Tracking ID');

  const existing = {};
  readColumn(qcSheet, iTrk).forEach(v => { const t = String(v || '').trim(); if (t) existing[t] = true; });

  const orders = getOrdersSheet();
  const oh = orders.getRange(1, 1, 1, orders.getLastColumn()).getValues()[0];
  const iTrkO = oh.indexOf('Tracking ID'), iPacked = oh.indexOf('Packed Date');
  const orderRowByTrk = {};
  readColumn(orders, iTrkO).forEach((v, i) => { const t = String(v || '').trim(); if (t && orderRowByTrk[t] === undefined) orderRowByTrk[t] = i; });
  const packedVals = iPacked >= 0 ? readColumn(orders, iPacked) : [];
  const packedChanged = [];

  let base = qcSheet.getLastRow();   // QC ID number base; incremented in memory
  const rows = [], skipped = [], seen = {};

  recs.forEach(r => {
    const tid = String(r.tracking_id || '').trim();
    if (!tid) { skipped.push({ key: r.airtable_key, reason: 'sin_guia' }); return; }
    if (existing[tid] || seen[tid]) { skipped.push({ key: r.airtable_key, reason: 'qc_ya_existe' }); return; }
    seen[tid] = true;
    base++;
    const row = new Array(h.length).fill('');
    const set = (c, v) => { const i = h.indexOf(c); if (i >= 0) row[i] = v; };
    set('QC ID', 'QC-' + String(base).padStart(4, '0') + '-' + Utilities.getUuid().slice(0, 4));
    set('Tracking ID', tid);
    set('TikTok Order IDs', (r.tiktok_order_ids || []).join(' + '));
    set('Customer ID', r.customer_id || '');
    set('Primary Username', r.username || '');
    set('Packer', r.packer || '');
    set('Surtidor', r.surtidor || '');
    set('Timestamp', r.timestamp || '');
    (r.content || []).slice(0, 5).forEach((u, i) => set('Content' + (i + 1), u));
    (r.box || []).slice(0, 5).forEach((u, i) => set('Box' + (i + 1), u));
    set('Status', 'Enviado');
    set('Notes', r.archived ? 'Importado de Airtable (fotos archivadas)' : 'Importado de Airtable');
    rows.push(row);

    const oi = orderRowByTrk[tid];
    if (iPacked >= 0 && r.timestamp && oi !== undefined && !packedVals[oi]) {
      packedVals[oi] = r.timestamp; packedChanged.push(oi);
    }

    logAuditEvent('import_qc_history', 'QC', tid, {
      source: 'airtable', packer: r.packer || '', surtidor: r.surtidor || '', timestamp: r.timestamp || '',
    });
  });

  if (!dryRun && rows.length) {
    const start = qcSheet.getLastRow() + 1;
    forceTextFormat(qcSheet, h, QC_ID_COLUMNS, start, rows.length);
    qcSheet.getRange(start, 1, rows.length, h.length).setValues(rows);
  }
  if (!dryRun && packedChanged.length) writeColumnChanges(orders, iPacked, packedVals, packedChanged);

  return jsonResponse({
    dry_run: dryRun, inserted: rows.length, packed_date_filled: packedChanged.length,
    skipped: skipped.length, skipped_detail: skipped.slice(0, 100),
  });
}

// ─── Data Health (FIX_LOG 7.1) ──────────────────────────────────────────
// One function per check. runHealthChecks() runs them all, stores the
// result in the 'Health' tab of the Orders spreadsheet, and returns it.
// GET health_report reads the stored run; POST run_health_checks re-runs.
const REQUIRED_HEADERS = {
  'Orders': ['Order ID', 'Tracking ID', 'Customer ID', 'Primary Username', 'Channel', 'Status', 'Price', 'Created Date', 'Order Date', 'Packed Date'],
  'QC': ['QC ID', 'Tracking ID', 'TikTok Order IDs', 'Packer', 'Timestamp', 'Content1', 'Box1', 'Status'],
  'Customers': ['Customer ID', 'Primary Username', 'Aliases', 'Shipment Count', 'First Order Date'],
};

function runHealthChecks() {
  const started = Date.now();
  const orders = getOrdersSheet();
  const odata = orders.getDataRange().getValues();
  const oh = odata[0] || [];
  const orows = odata.slice(1);
  const col = name => oh.indexOf(name);
  const qc = getQCSheet();
  const qdata = qc.getDataRange().getValues();
  const qh = qdata[0] || [];
  const qrows = qdata.slice(1);
  const cs = getCustomersSheet();
  const cdata = cs.getDataRange().getValues();
  const chh = cdata[0] || [];
  const crows = cdata.slice(1);

  const results = [];
  const add = (id, label, severity, items) => results.push({
    id: id, label: label, severity: items.length ? severity : 'ok', count: items.length, examples: items.slice(0, 10),
  });

  // 1. Missing headers
  const missing = [];
  [['Orders', oh], ['QC', qh], ['Customers', chh]].forEach(([name, hdr]) => {
    (REQUIRED_HEADERS[name] || []).forEach(c => { if (hdr.indexOf(c) < 0) missing.push(name + ' → ' + c); });
  });
  add('missing_headers', 'Columnas que faltan o cambiaron de nombre', 'red', missing);

  // 2. Duplicate component Order IDs / Tracking IDs in Orders
  const seenId = {}, dupIds = [], seenTrk = {}, dupTrk = [];
  orows.forEach((r, i) => {
    String(r[col('Order ID')] || '').split('+').map(x => x.trim()).filter(Boolean).forEach(id => {
      if (seenId[id] !== undefined) dupIds.push(id + ' (filas ' + (seenId[id] + 2) + ' y ' + (i + 2) + ')');
      else seenId[id] = i;
    });
    const t = String(r[col('Tracking ID')] || '').trim();
    if (t) { if (seenTrk[t] !== undefined) dupTrk.push(t + ' (filas ' + (seenTrk[t] + 2) + ' y ' + (i + 2) + ')'); else seenTrk[t] = i; }
  });
  add('dup_order_ids', 'Order ID repetido en más de un pedido', 'red', dupIds);
  add('dup_tracking_ids', 'Guía repetida en más de un pedido', 'red', dupTrk);

  // 3. IDs stored as numbers (precision already lost or about to be)
  const numericIds = [];
  orows.forEach((r, i) => {
    ['Order ID', 'Tracking ID'].forEach(c => { const v = r[col(c)]; if (typeof v === 'number') numericIds.push('Orders fila ' + (i + 2) + ' ' + c); });
  });
  qrows.forEach((r, i) => {
    const v = r[qh.indexOf('TikTok Order IDs')]; if (typeof v === 'number') numericIds.push('QC fila ' + (i + 2) + ' TikTok Order IDs');
  });
  add('numeric_ids', 'IDs guardados como número (pierden dígitos)', 'red', numericIds);

  // 4. Shipped/delivered TikTok orders in History with no Orders row
  const hist = getTikTokImportHistorySheet();
  const hdata = hist.getDataRange().getValues();
  const hh = hdata[0] || [];
  const orphanSet = {};
  hdata.slice(1).forEach(r => {
    const oid = String(r[hh.indexOf('Order ID')] || '').replace(/\D/g, '');
    const target = backfillTargetStatus(r[hh.indexOf('Order Substatus')]);
    if (oid && target && seenId[oid] === undefined) orphanSet[oid] = r[hh.indexOf('Order Substatus')];
  });
  add('history_orphans', 'Pedidos enviados en TikTok que no están en Orders', 'red',
    Object.keys(orphanSet).map(k => k + ' (' + orphanSet[k] + ')'));

  // 5. Stored Shipment Count vs computed
  const counts = buildShippedCountMap(orders, oh);
  const drift = [];
  crows.forEach(r => {
    const id = String(r[chh.indexOf('Customer ID')] || '');
    if (!id || String(r[chh.indexOf('Primary Username')] || '').indexOf('(merged→') >= 0) return;
    const stored = Number(r[chh.indexOf('Shipment Count')]) || 0;
    if (stored !== (counts[id] || 0)) drift.push(id + ': guardado ' + stored + ', real ' + (counts[id] || 0));
  });
  add('shipment_count_drift', 'Conteo de envíos desactualizado', 'amber', drift);

  // 6. Packed Date without a QC row; 7. shipped QC rows without a box photo
  const qcTrk = {};
  qrows.forEach(r => { const t = String(r[qh.indexOf('Tracking ID')] || '').trim(); if (t) qcTrk[t] = r; });
  const packedNoQc = [];
  orows.forEach((r, i) => {
    const t = String(r[col('Tracking ID')] || '').trim();
    if (r[col('Packed Date')] && t && !qcTrk[t]) packedNoQc.push(t + ' (fila ' + (i + 2) + ')');
  });
  add('packed_without_qc', 'Marcado como empacado sin registro de calidad', 'amber', packedNoQc);
  const noBox = [];
  qrows.forEach(r => {
    if (String(r[qh.indexOf('Status')]) === 'Enviado' && !r[qh.indexOf('Box1')]) noBox.push(String(r[qh.indexOf('Tracking ID')] || r[qh.indexOf('QC ID')]));
  });
  add('qc_without_box', 'Enviado sin foto de caja cerrada', 'amber', noBox);

  // 8. Orders pointing at merged-away customers
  const merged = {};
  crows.forEach(r => { if (String(r[chh.indexOf('Primary Username')] || '').indexOf('(merged→') >= 0) merged[String(r[chh.indexOf('Customer ID')])] = true; });
  const mergedRefs = [];
  orows.forEach((r, i) => { const c = String(r[col('Customer ID')] || ''); if (merged[c]) mergedRefs.push(c + ' (fila ' + (i + 2) + ')'); });
  add('merged_customer_refs', 'Pedidos apuntando a un cliente fusionado', 'amber', mergedRefs);

  // 9. Paid but not packed for more than 48 h (stuck orders, FIX_LOG 7.3)
  const stuck = [];
  const cutoff = Date.now() - 48 * 3600000;
  orows.forEach(r => {
    if (String(r[col('Status')]) !== 'Pagado') return;
    const t = String(r[col('Tracking ID')] || '').trim();
    if (t && qcTrk[t]) return;
    const raw = (col('Order Date') >= 0 && r[col('Order Date')]) || r[col('Created Date')];
    const d = raw instanceof Date ? raw : new Date(raw);
    if (!isNaN(d.getTime()) && d.getTime() < cutoff) stuck.push((t || String(r[col('Order ID')])) + ' · ' + String(r[col('Primary Username')] || ''));
  });
  add('stuck_paid', 'Pagado hace más de 48 h y sin empacar', 'amber', stuck);

  const report = { ran_at: nowISO(), duration_ms: Date.now() - started, checks: results };
  storeHealthReport(report);
  PropertiesService.getScriptProperties().setProperty('LAST_HEALTH_AT', report.ran_at);
  return report;
}

function getHealthSheet() {
  const ss = openSheetCached(ORDERS_SHEET_ID);
  return ss.getSheetByName('Health') || ss.insertSheet('Health');
}

function storeHealthReport(report) {
  const sh = getHealthSheet();
  sh.clear();
  const rows = [['Run At', 'Check', 'Label', 'Severity', 'Count', 'Examples']];
  report.checks.forEach(c => rows.push([report.ran_at, c.id, c.label, c.severity, c.count, JSON.stringify(c.examples)]));
  sh.getRange(1, 1, rows.length, rows[0].length).setValues(rows);
}

function healthReportAction(e) {
  const sh = getHealthSheet();
  const data = sh.getDataRange().getValues();
  if (data.length < 2) return jsonResponse({ ran_at: null, checks: [] });
  const checks = data.slice(1).map(r => ({
    id: r[1], label: r[2], severity: r[3], count: Number(r[4]) || 0,
    examples: (() => { try { return JSON.parse(r[5] || '[]'); } catch (x) { return []; } })(),
  }));
  const ranAt = data[1][0] instanceof Date ? data[1][0].toISOString() : String(data[1][0]);
  return jsonResponse({ ran_at: ranAt, checks: checks });
}

function runHealthChecksAction(body) {
  return jsonResponse(runHealthChecks());
}

// ─── Scheduled jobs ─────────────────────────────────────────────────────
// Run installTriggers() ONCE from the editor's function dropdown. It
// removes any existing triggers for these handlers first, so running it
// again never creates duplicates.
function installTriggers() {
  const jobs = [['nightlyBackup', 2], ['reconcileCustomerAggregates', 3], ['runHealthChecks', 4]];
  const names = jobs.map(j => j[0]);
  ScriptApp.getProjectTriggers().forEach(t => {
    if (names.indexOf(t.getHandlerFunction()) >= 0) ScriptApp.deleteTrigger(t);
  });
  jobs.forEach(([fn, hour]) => {
    ScriptApp.newTrigger(fn).timeBased().everyDays(1).atHour(hour).inTimezone(MX_TZ).create();
  });
  Logger.log('Triggers installed: ' + names.join(', '));
}

// ─── Tests: run runAllTests() from the function dropdown ────────────────
// Pure functions only -- nothing here reads or writes a sheet.
function runAllTests() {
  let pass = 0, fail = 0;
  const eq = (name, got, want) => {
    const ok = JSON.stringify(got) === JSON.stringify(want);
    ok ? pass++ : fail++;
    Logger.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : ' — got ' + JSON.stringify(got) + ', want ' + JSON.stringify(want)));
  };
  const iso = d => d ? d.toISOString() : null;

  eq('normalizeUsername strips @ and case', normalizeUsername('@Maria.Art'), 'maria.art');
  eq('normalizeUsername strips merged suffix', normalizeUsername('chino (merged→CUST-775)'), 'chino');
  eq('backfillKey digit-strips order id', backfillKey('5866\t', ' SKU1 '), '5866||SKU1');
  eq('backfillTargetStatus delivered', backfillTargetStatus('Delivered'), 'Enviado');
  eq('backfillTargetStatus awaiting collection', backfillTargetStatus('awaiting collection'), 'Pagado');
  eq('backfillTargetStatus canceled', backfillTargetStatus('Canceled'), '');

  eq('detectDayFirst day-first', detectDayFirst(['16/10/2026 11:00:00', '01/02/2026']), true);
  eq('detectDayFirst month-first', detectDayFirst(['10/16/2026 11:00:00 AM']), false);
  eq('detectDayFirst ambiguous', detectDayFirst(['01/02/2026']), null);
  // Mexico City is UTC-6 all year since 2022.
  eq('parse dd/mm 24h', iso(parseTikTokDateTime('16/10/2026 11:53:21', true)), '2026-10-16T17:53:21.000Z');
  eq('parse mm/dd PM', iso(parseTikTokDateTime('10/16/2026 01:53:21 PM', false)), '2026-10-16T19:53:21.000Z');
  eq('parse airtable dd-mm-yy', iso(parseTikTokDateTime('16-10-26 11:53', true)), '2026-10-16T17:53:00.000Z');
  eq('parse ISO passthrough', iso(parseTikTokDateTime('2026-10-16T17:53:00.000Z')), '2026-10-16T17:53:00.000Z');
  eq('parse garbage', parseTikTokDateTime('mañana'), null);

  eq('shopify paid', shopifyStatusFromFinancial('paid'), 'Pagado');
  eq('shopify pending', shopifyStatusFromFinancial('pending'), 'No Pagado');
  eq('shopify refunded', shopifyStatusFromFinancial('refunded'), 'CANCELLED');
  eq('shopify absent', shopifyStatusFromFinancial(''), 'Pagado');

  const parsedPlain = parseUserProp('abc|staff');
  eq('password plain match', passwordMatches(parsedPlain, 'abc'), true);
  const hashed = parseUserProp('sha256$salt$' + hashPassword('salt', 'pw1') + '|admin');
  eq('password hash match', passwordMatches(hashed, 'pw1'), true);
  eq('password hash mismatch', passwordMatches(hashed, 'pw2'), false);
  eq('password hash role', hashed.role, 'admin');

  // Price counted once per unique order id, summed across the shipment.
  const recs = [];
  for (let i = 0; i < 6; i++) recs.push({ order_substatus: 'Delivered', tracking_id: 'JMX1', order_id: '586600000000000001', order_amount: 100, product_name: 'p' + i, quantity: '1', sku_id: 's' + i, created_time: '16/10/2026 10:00:00' });
  for (let i = 0; i < 12; i++) recs.push({ order_substatus: 'Delivered', tracking_id: 'JMX1', order_id: '586600000000000002', order_amount: 250, product_name: 'q' + i, quantity: '2', sku_id: 't' + i, created_time: '15/10/2026 09:00:00' });
  const g = groupBackfillShipments(recs);
  eq('grouping one shipment', g.length, 1);
  eq('grouping price per order', g[0] && g[0].price, 350);
  eq('grouping both order ids', g[0] && g[0].order_ids.length, 2);
  eq('grouping earliest created', g[0] ? iso(new Date(g[0].created_ms)) : null, '2026-10-15T15:00:00.000Z');

  // Regression test for the 2026-10-18 self-pairing bug: a customer whose
  // username and an alias share a 5-char prefix (e.g. "farlirod" /
  // "farlirod2.0") must never be paired against themselves.
  const selfPairCustomers = [
    { 'Customer ID': 'TEST-A', 'Primary Username': 'farlirod', 'Aliases': 'farlirod2.0, other', 'Phone Partial': '', 'ZIP': '', 'City': '', 'Shopify Customer ID': '' },
  ];
  const selfPairFeats = selfPairCustomers.map(dupFeatures);
  const selfPairBuckets = {};
  selfPairFeats.forEach((f, i) => new Set(dupBlockingKeys(f)).forEach(k => {
    (selfPairBuckets[k] || (selfPairBuckets[k] = new Set())).add(i);
  }));
  const anySelfPairBucket = Object.values(selfPairBuckets).some(s => s.size > 1);
  eq('duplicate finder never buckets one customer twice (self-pair bug)', anySelfPairBucket, false);

  Logger.log('Tests: ' + pass + ' passed, ' + fail + ' failed');
  return { pass: pass, fail: fail };
}


// ═══════════════════════════════════════════════════════════════════════════
// ONE-OFF MIGRATION -- Enviado -> Anotado. Run migrateAnotadoPreview() first
// and read the log. If the list is right, run migrateAnotadoApply(). Then
// DELETE this whole block (both functions + helper) and redeploy.
// Finds Shopify/Manual orders marked Enviado whose Linked Shipment points at
// a TikTok shipment that has NOT shipped yet (all its TikTok orders still
// Pagado / No Pagado) -- i.e. written on a label, not actually gone.
// ═══════════════════════════════════════════════════════════════════════════
function _anotadoMigrationCandidates() {
  const sheet = getOrdersSheet();
  const data = sheet.getDataRange().getValues();
  const h = data[0];
  const iId = h.indexOf('Order ID'), iChan = h.indexOf('Channel'), iStat = h.indexOf('Status');
  const iTid = h.indexOf('Tracking ID'), iLink = h.indexOf('Linked Shipment'), iCust = h.indexOf('Customer ID');
  const iUser = h.indexOf('Primary Username');
  const tiktokByTid = {};
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][iChan]) !== 'TikTok') continue;
    const tid = String(data[i][iTid] || '').trim();
    if (!tid) continue;
    (tiktokByTid[tid] = tiktokByTid[tid] || []).push(String(data[i][iStat]));
  }
  const out = [];
  for (let i = 1; i < data.length; i++) {
    const r = data[i];
    if (String(r[iChan]) === 'TikTok' || String(r[iStat]) !== 'Enviado') continue;
    const link = String(r[iLink] || '').trim();
    const tk = tiktokByTid[link];
    if (!link || !tk || !tk.length) continue;
    if (tk.some(s => s === 'Enviado' || s === 'Archivado')) continue;
    out.push({ row: i + 1, id: String(r[iId]), channel: String(r[iChan]), user: String(r[iUser] || ''), link, cust: String(r[iCust] || '') });
  }
  return { sheet, headers: h, rows: out };
}

function migrateAnotadoPreview() {
  const c = _anotadoMigrationCandidates();
  Logger.log(`${c.rows.length} pedido(s) pasarían de Enviado a Anotado:`);
  c.rows.forEach(r => Logger.log(`  ${r.id} · ${r.channel} · ${r.user} · envío ${r.link}`));
}

function migrateAnotadoApply() {
  const c = _anotadoMigrationCandidates();
  const iStat = c.headers.indexOf('Status'), iShipped = c.headers.indexOf('Shipped Date');
  const decrement = {};
  c.rows.forEach(r => {
    c.sheet.getRange(r.row, iStat + 1).setValue('Anotado');
    if (iShipped >= 0) c.sheet.getRange(r.row, iShipped + 1).setValue('');
    logAudit('migrate_anotado', 'Order', r.id, 'Status', 'Enviado', 'Anotado');
    // Enviado counted toward Shipment Count for Shopify; Anotado does not.
    if (r.channel === 'Shopify' && r.cust) decrement[r.cust] = (decrement[r.cust] || 0) - 1;
  });
  if (Object.keys(decrement).length) incrementShipmentCounts(decrement);
  flushAudit();
  Logger.log(`${c.rows.length} pedido(s) cambiados a Anotado.`);
}
