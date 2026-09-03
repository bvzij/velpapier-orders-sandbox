// ═══════════════════════════════════════════════════════════════════════════
// CONFIG
// ═══════════════════════════════════════════════════════════════════════════

const ORDERS_SHEET_ID = '1ghfPmDU6NvOWhzAdyqMcXap2DH3_j47tv5kTCwh4BTg';
const CUSTOMERS_SHEET_ID = '1lM9RjWq4vvcmXTUwJmi0IbS2tQw31CzjnWsFmMON7ak';
const QC_SHEET_ID = '1HFzeXHMOxQ3dNb8g4wvU1bp-psGlWMZUlXO0tQYWFxc';

const SCRIPT_VERSION = '2026-09-03.6';

const BACKUP_FOLDER_ID = '1wxkTAqFlGlOc-qMGBv24nQswW7IyYMoL';

// ═══════════════════════════════════════════════════════════════════════════
// SHARED HELPERS — sheet accessors, utilities, ID generation
// ═══════════════════════════════════════════════════════════════════════════

// ─── Sheet accessors ───────────────────────────────────────────────────────────

function getOrdersSheet() {
  return SpreadsheetApp.openById(ORDERS_SHEET_ID).getSheetByName('Orders');
}

function getShopifyMatchesSheet() {
  return SpreadsheetApp.openById(CUSTOMERS_SHEET_ID).getSheetByName('Shopify Customer Matches');
}

function getCustomersSheet() {
  return SpreadsheetApp.openById(CUSTOMERS_SHEET_ID).getSheetByName('Customers');
}

function getQCSheet() {
  return SpreadsheetApp.openById(QC_SHEET_ID).getSheets()[0];
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

function jsonResponse(data, status) {
  const output = ContentService.createTextOutput(JSON.stringify(data));
  output.setMimeType(ContentService.MimeType.JSON);
  return output;
}

// ─── Customer ID generator ─────────────────────────────────────────────────────

function generateCustomerID(sheet) {
  const data = sheet.getDataRange().getValues();
  if (data.length < 2) return 'CUST-001';
  const ids = data.slice(1)
    .map(r => r[0])
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

    if (action === 'ping') return jsonResponse({ ok: true });
    if (action !== 'version' && !authOk(e.parameter.token)) return jsonResponse({ error: 'unauthorized' });
    if (action === 'shopify_matches') return getShopifyMatches(e);
    if (action === 'version') return jsonResponse({ version: SCRIPT_VERSION });
    if (action === 'get_upload_signature') return getUploadSignature(e);
    if (action === 'qc') return getQC(e);
    if (action === 'active_session') return getActiveSession(e);
    if (action === 'sessions') return getSessions(e);
    if (action === 'find_duplicate_customers') return findDuplicateCustomers(e);
    if (action === 'find_duplicate_products') return findDuplicateProducts(e);
    if (action === 'search_products_for_merge') return searchProductsForMerge(e);
    if (action === 'manual_product_pair') return getManualProductPair(e);
    if (action === 'product_merge_history') return getProductMergeHistory(e);
    if (action === 'merge_history') return getMergeHistory(e);

    if (action === 'orders') {
      const sheet = getOrdersSheet();
      const data = sheet.getDataRange().getValues();
      if (data.length < 2) return jsonResponse({ records: [] });

      const headers = data[0];
      const statusCol = headers.indexOf('Status');
      const channelCol = headers.indexOf('Channel');
      const customerIdCol = headers.indexOf('Customer ID');

      const statusFilter = e.parameter.status
        ? e.parameter.status.split(',').map(s => s.trim()).filter(Boolean)
        : null;
      const channelFilter = e.parameter.channel || null;
      const customerIdFilter = e.parameter.customer_id || null;

      const records = [];
      for (let i = 1; i < data.length; i++) {
        const row = data[i];
        if (statusFilter && !statusFilter.includes(row[statusCol])) continue;
        if (channelFilter && row[channelCol] !== channelFilter) continue;
        if (customerIdFilter && row[customerIdCol] !== customerIdFilter) continue;

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

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    const action = body.action;
    if (!authOk(body.token)) return jsonResponse({ error: 'unauthorized' });

    if (action === 'create_order') return createOrder(body);
    if (action === 'create_customer') return createCustomer(body);
    if (action === 'update_order_status') return updateOrderStatus(body);
    if (action === 'add_alias') return addAlias(body);
    if (action === 'update_packed_date') return updatePackedDate(body);
    if (action === 'migrate_order') return migrateOrder(body);
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
    if (action === 'merge_customers') return mergeCustomersAction(body);
    if (action === 'dismiss_duplicate_pair') return dismissDuplicatePairAction(body);
    if (action === 'undo_merge') return undoMergeAction(body);
    if (action === 'delete_merged_customer') return deleteMergedCustomerAction(body);
    if (action === 'dismiss_product_pair') return dismissProductPairAction(body);
    if (action === 'merge_products') return mergeProductsAction(body);
    if (action === 'undo_product_merge') return undoProductMergeAction(body);
    if (action === 'backfill_tiktok_preview') return backfillTikTokHistoryPreview(body);
    if (action === 'backfill_tiktok_commit') return backfillTikTokHistoryCommit(body);
    

    return jsonResponse({ error: 'Unknown action' });

  } catch (err) {
    return jsonResponse({ error: err.message });
  }
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

  if (resolution) {
    customerID = resolution.customer['Customer ID'];
    primaryUsername = resolution.customer['Primary Username'];
    if (resolution.confidence === 'fuzzy') mergeFlag = true;
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

  return jsonResponse({
    result: 'created',
    order_id: orderID,
    customer_id: customerID,
    merge_flag: mergeFlag,
    status: status
  });
}

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

  sheet.getRange(rowIndex, statusCol).setValue(body.status);
  applyStatusSideEffects(sheet, rowIndex, body.status, headers);

  return jsonResponse({ result: 'updated', order_id: body.order_id, status: body.status });
}

// ─── Recalculate shipment count ────────────────────────────────────────────────

function recalculateShipmentCount(customerID) {
  const ordersSheet = getOrdersSheet();
  const data = ordersSheet.getDataRange().getValues();
  const headers = data[0];

  const channelCol = headers.indexOf('Channel');
  const statusCol = headers.indexOf('Status');
  const customerIdCol = headers.indexOf('Customer ID');

  let count = 0;
  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    if (row[customerIdCol] !== customerID) continue;
    if (row[channelCol] !== 'TikTok' && row[channelCol] !== 'Shopify') continue;
    if (row[statusCol] === 'Enviado' || row[statusCol] === 'Archivado') count++;
  }

  const customersSheet = getCustomersSheet();
  const custData = customersSheet.getDataRange().getValues();
  const custHeaders = custData[0];
  const custIdCol = custHeaders.indexOf('Customer ID');
  const countCol = custHeaders.indexOf('Shipment Count');

  for (let i = 1; i < custData.length; i++) {
    if (custData[i][custIdCol] === customerID) {
      customersSheet.getRange(i + 1, countCol + 1).setValue(count);
      break;
    }
  }
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

  return jsonResponse({ result: 'alias_added', customer_id: body.customer_id, aliases: updated });
}

// ─── Update packed date ────────────────────────────────────────────────────────

function updatePackedDate(body) {
  const sheet = getOrdersSheet();
  const rowIndex = findOrderRow(sheet, body.order_id);
  if (!rowIndex) return jsonResponse({ error: 'Order not found' });

  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const packedCol = headers.indexOf('Packed Date') + 1;

  sheet.getRange(rowIndex, packedCol).setValue(body.packed_date || nowISO());

  return jsonResponse({ result: 'packed_date_updated', order_id: body.order_id });
}

// ─── Migrate order ──────────────────────────────────────────────────────────────

function migrateOrder(body) {
  const ordersSheet = getOrdersSheet();

  const row = [
    body.order_id || generateUUID(),
    body.tracking_id || '',
    '',
    body.username || '',
    body.channel || 'Manual',
    body.status || 'No Pagado',
    body.products || '',
    body.price || 0,
    body.shopify_order_id || '',
    body.notes || '',
    body.created_date || nowISO(),
    body.packed_date || '',
    body.shipped_date || '',
    body.archive_date || '',
    ''
  ];

  ordersSheet.appendRow(row);
  return jsonResponse({ result: 'migrated', order_id: row[0] });
}

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
  let notFoundList = [];

  orders.forEach(order => {
    if (order['Customer ID']) return;

    const username = order['Primary Username'];
    if (!username) return;

    const resolution = findCustomerByUsername(customers, username);

    if (resolution) {
      ordersSheet.getRange(order._rowIndex, customerIDCol).setValue(resolution.customer['Customer ID']);
      stamped++;
    } else {
      notFound++;
      notFoundList.push(username);
    }
  });

  Logger.log(`Stamped: ${stamped} | Not found: ${notFound}`);
  Logger.log(`Not found list: ${[...new Set(notFoundList)].join(', ')}`);
}

// ─── Update / delete order ──────────────────────────────────────────────────────

function updateOrder(body) {
  const sheet = getOrdersSheet();
  const rowIndex = findOrderRow(sheet, body.order_id);
  if (!rowIndex) return jsonResponse({ error: 'Order not found' });

  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];

  Object.entries(body.fields || {}).forEach(([key, value]) => {
    const col = headers.indexOf(key) + 1;
    if (col > 0) {
      sheet.getRange(rowIndex, col).setValue(value);
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

  sheet.deleteRow(rowIndex);
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

function authOk(t) {
  const want = PropertiesService.getScriptProperties().getProperty('API_TOKEN');
  return !!want && t === want;
}
// ═══════════════════════════════════════════════════════════════════════════
// TIKTOK IMPORT
// ═══════════════════════════════════════════════════════════════════════════

function importTikTokOrders(body) {
  Logger.log('DEBUG shipments[0]: ' + JSON.stringify((body.shipments || [])[0]));
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
  const shipCountMap = {};  // Customer ID -> count of ALL their TikTok orders ever (status-agnostic)
  allOrderData.forEach(r => {
    if (r[iTrk]) trackingSet[String(r[iTrk])] = true;
    const cid = String(r[iCustO] || '');
    if (cid && r[iChanO] === 'TikTok') {
      shipCountMap[cid] = (shipCountMap[cid] || 0) + 1;
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

  const custRowMap = {};
  custData.forEach((r, i) => { custRowMap[String(r[cCol.id])] = i; });

  // ─── Resolve ALL line items across ALL shipments in ONE catalog pass ──
  // (only for shipments that aren't duplicates — but we don't know that yet
  // at this point without a second trackingSet lookup, so we resolve for
  // all incoming shipments; resolving a few extra SKUs for a duplicate
  // shipment that gets skipped below is harmless and still cheap.)
  const allLineItems = [];
  const allImportHistory = [];
  (body.shipments || []).forEach(s => {
    (s.line_items || []).forEach(li => allLineItems.push(li));
    (s.import_history || []).forEach(h => allImportHistory.push(h));
  });
  const skuToCatalogId = allLineItems.length ? resolveLineItemsBatch(allLineItems) : {};
  appendTikTokImportHistory(allImportHistory);

  // ─── Locate the 30 product slot column pairs ──────────────────────
  const PRODUCT_SLOTS = 30;
  const slotCols = [];
  for (let n = 1; n <= PRODUCT_SLOTS; n++) {
    slotCols.push({
      catalogCol: oh.indexOf('Product ' + n + ' Catalog ID'),
      qtyCol: oh.indexOf('Product ' + n + ' Qty'),
    });
  }

  const rows = [], results = [], unresolved = [];
  let customersDirty = false;
  const touchedCustomerCounts = {};  // Customer ID -> new total TikTok count, for the Customers sheet write

  (body.shipments || []).forEach(s => {
    const tid = String(s.tracking_id || '');
    if (!tid) return;

    if (trackingSet[tid]) {
      results.push({ tracking_id: tid, inserted: false, reason: 'duplicate' });
      return;
    }
    trackingSet[tid] = true;

    let customerID = s.customer_id || '';
    let primary    = s.username || '';
    let shipCount  = 0;

    if (customerID) {
      shipCountMap[customerID] = (shipCountMap[customerID] || 0) + 1;  // this new order counts too
      shipCount = shipCountMap[customerID];
      touchedCustomerCounts[customerID] = shipCount;
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
            custData[idx][colIdx] = incoming;
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
          custData[idx][cCol.notes] = (existingNotes ? existingNotes + ' | ' : '') + noteAdd.join('; ');
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
  });

    // ─── Write orders in ONE batch ────────────────────────────────────
  if (rows.length) {
    const startRow = orders.getLastRow() + 1;
    forceTextFormat(orders, oh, ['Order ID', 'Tracking ID'], startRow, rows.length);
    orders.getRange(startRow, 1, rows.length, rows[0].length).setValues(rows);
  }

  // ─── Write updated Shipment Counts (TikTok orders per customer) ───
  const cCountCol = ch.indexOf('Shipment Count');
  if (cCountCol >= 0) {
    Object.keys(touchedCustomerCounts).forEach(cid => {
      const idx = custRowMap[cid];
      if (idx !== undefined) {
        custData[idx][cCountCol] = touchedCustomerCounts[cid];
        customersDirty = true;
      }
    });
  }

  // ─── Write modified customers back in ONE batch ───────────────────
  if (customersDirty && custData.length > 0) {
    customersSheet.getRange(2, 1, custData.length, custLastCol).setValues(custData);
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

  const rows = [], created = [];
  (body.customers || []).forEach(cust => {
    if (cust.primary_username) {
      const dup = existing.find(c =>
        normalizeUsername(c['Primary Username']) === normalizeUsername(cust.primary_username)
      );
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
      ? String.fromCharCode(65 + h.indexOf('Tracking ID')) : 'B', body.tracking_id);
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
  if (body.add_content || body.remove_content) {
    applyDelta('Content', body.add_content, body.remove_content);
  }
  if (body.add_box || body.remove_box) {
    applyDelta('Box', body.add_box, body.remove_box);
  }

  // ─── Full-array legacy path (still used by finalize, which submits the
  // deliberate final state as a single confirm action) ───────────────────
  if (body.content_urls) {
    for (let i = 0; i < 5; i++) set('Content' + (i + 1), body.content_urls[i] || '');
  }
  if (body.box_urls) {
    for (let i = 0; i < 5; i++) set('Box' + (i + 1), body.box_urls[i] || '');
  }

  if (body.notes !== undefined) set('Notes', body.notes);
  if (body.packer) set('Packer', body.packer);
  // Finalizing marks the QC row itself, so other devices polling QC rows can
  // drop this shipment from their pending list without refetching all orders.
  if (body.finalize) set('Status', 'Enviado');

  qcSheet.getRange(row, 1, 1, h.length).setValues([rowVals]);

  const result = {
    result: 'saved',
    qc_id: qcId,
    content_urls: [1,2,3,4,5].map(n => get('Content' + n)).filter(Boolean),
    box_urls:     [1,2,3,4,5].map(n => get('Box' + n)).filter(Boolean),
  };

  // Finalize: trigger the real shipping side-effects (batched — no per-order
  // full-sheet re-reads, which was the main cause of the 7-9s save time).
  if (body.finalize) {
    const allOrderIds = (body.order_ids || []).map(o => o.id);
    const finalContentUrls = result.content_urls;
    if (!allOrderIds.length || finalContentUrls.length === 0) {
      return jsonResponse({ error: 'order_ids y al menos una foto de contenido son obligatorios para finalizar' });
    }

    const orders = getOrdersSheet();
    const oLastCol = orders.getLastColumn();
    const oh = orders.getRange(1, 1, 1, oLastCol).getValues()[0];
    const iPacked = oh.indexOf('Packed Date');
    const iLink   = oh.indexOf('Linked Shipment');
    const iChan   = oh.indexOf('Channel');
    const iStat   = oh.indexOf('Status');

    const oLastRow = orders.getLastRow();
    const oData = oLastRow > 1 ? orders.getRange(2, 1, oLastRow - 1, oLastCol).getValues() : [];
    const idToRowIdx = {};  // Order ID -> index into oData
    oData.forEach((r, i) => { idToRowIdx[String(r[0])] = i; });  // col A = Order ID

    const shipResults = [];

    allOrderIds.forEach(id => {
      const idx = idToRowIdx[String(id)];
      if (idx === undefined) { shipResults.push({ order_id: id, result: 'not_found' }); return; }
      const r = oData[idx];
      if (iPacked >= 0) r[iPacked] = nowISO();
      if (iChan >= 0 && iLink >= 0 && r[iChan] !== 'TikTok') r[iLink] = body.tracking_id;
      if (iStat >= 0) {
        r[iStat] = 'Enviado';
        const shippedIdx = oh.indexOf('Shipped Date');
        if (shippedIdx >= 0) r[shippedIdx] = nowISO();
      }
      shipResults.push({ order_id: id, result: 'shipped' });
    });

    // Write all order row changes back in ONE batch
    if (oData.length > 0) {
      orders.getRange(2, 1, oData.length, oLastCol).setValues(oData);
    }

    // Shipment Count is no longer touched here — it's set once at TikTok
    // import time (see importTikTokOrders) based on cancellation being rare
    // enough (~1-in-4000) that "imported" is treated as "will ship."
    // This keeps the Enviar save fast: no per-shipment recalculation.

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
function findRowByColumn(sheet, colLetter, value) {
  const colIdx = colLetter.charCodeAt(0) - 64; // 'A' -> 1
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
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);  // wait up to 10s for exclusive access — prevents two devices creating duplicate sessions
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

    return jsonResponse({ result: 'started', session_id: sessionId });
  } finally {
    lock.releaseLock();
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

  const parents = pData.slice(1).map((r, i) => ({
    rowIndex: i + 2,
    parentId: r[iPId],
    parentName: r[iPName],
  }));

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
  }));

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
    variantsSheet.getRange(variantsSheet.getLastRow() + 1, 1, newVariantRows.length, newVariantRows[0].length)
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
  const customers = sheetToObjects(customersSheet);

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
  const lock = LockService.getScriptLock();
  const gotLock = lock.tryLock(30000); // wait up to 30s for exclusive access
  if (!gotLock) {
    // Another order is mid-write and we waited too long -- fail loudly rather
    // than risk a silent corrupt write. N8N should retry on a non-2xx-ish
    // error response, so tell the caller plainly that this needs a retry.
    return jsonResponse({
  result: 'error',
  error: 'busy_try_again',
  message: 'Server was busy processing another order. Please retry.',
  _retryCount: body._retryCount || 0,
});
  }

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
      customersSheet.appendRow([
        customerID,
        incoming.username || '',
        '',
        incoming.shopifyCustomerId || '',
        firstName,
        surname,
        '',
        '',
        incoming.city || '',
        incoming.state || '',
        incoming.zip || '',
        '',
        incoming.phone || '',
        incoming.email || '',
        nowISO(),
        0,
        'Auto-created from Shopify order ' + orderName,
        false,
      ]);
    }

    // ─── Write the Orders row (always, regardless of tier) ────────────
    const row = new Array(oh.length).fill('');
    row[oh.indexOf('Order ID')] = generateUUID();
    row[oh.indexOf('Shopify Order ID')] = shopifyOrderId;
    row[oh.indexOf('Shopify Order Number')] = orderName;
    row[oh.indexOf('Customer ID')] = customerID;
    row[oh.indexOf('Primary Username')] = (resolution.tier === 'auto') ? (incoming.username || '') : '';
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

    return jsonResponse({
      result: 'imported',
      order_id: row[oh.indexOf('Order ID')],
      customer_id: customerID,
      tier: resolution.tier,
      match_id: matchId,
    });

  } finally {
    lock.releaseLock();
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

    linkedCustomerId = generateCustomerID(customersSheet);
    customersSheet.appendRow([
      linkedCustomerId,
      match['Incoming Username'] || '',
      '',
      match['Shopify Customer ID'] || '',
      firstName,
      surname,
      '',
      '',
      (match['Incoming Address'] || '').split(' / ')[0] || '',
      (match['Incoming Address'] || '').split(' / ')[1] || '',
      (match['Incoming Address'] || '').split(' / ')[2] || '',
      '',
      match['Incoming Phone'] || '',
      match['Incoming Email'] || '',
      nowISO(),
      0,
      'Created from Shopify match review (' + match['Match ID'] + ')',
      false,
    ]);
    setMatchField('Decision', 'Created-New');

  } else {
    return jsonResponse({ error: 'Unknown decision: ' + body.decision });
  }

  setMatchField('Linked Customer ID', linkedCustomerId);
  setMatchField('Decided Date', nowISO());

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
        sheet.getRange(i + 1, shopCol + 1).setValue(current.join('/'));
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
        sheet.getRange(i + 1, colIdx + 1).setValue(newVal);
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
  sheet.getRange(startRow, 1, rows.length, headers.length).setValues(rows);
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

function backfillKey(orderId, skuId) {
  return String(orderId || '').trim() + '||' + String(skuId || '').trim();
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
      forceTextFormat(sheet, headers, TIKTOK_ID_COLUMNS, 2, existingData.length);
      sheet.getRange(2, 1, existingData.length, headers.length).setValues(existingData);
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
    vData[keepRow][vTiktokSkusCol] = mergedSkus.join(', ');

    // Backfill blank fields from loser
    if (!String(vData[keepRow][vYourSkuCol] || '').trim() && vData[loseRow][vYourSkuCol]) {
      vData[keepRow][vYourSkuCol] = vData[loseRow][vYourSkuCol];
    }
    const keeperNotes = String(vData[keepRow][vNotesCol] || '');
    const loserNotes = String(vData[loseRow][vNotesCol] || '');
    if (loserNotes && !keeperNotes.includes(loserNotes)) {
      vData[keepRow][vNotesCol] = keeperNotes ? keeperNotes + ' | ' + loserNotes : loserNotes;
    }

    // Mark the losing variant as merged (kept, not deleted)
    vData[loseRow][vNameCol] = String(vData[loseRow][vNameCol] || '') + ` (merged→${pair.keep_catalog_id})`;

    catalogIdRepointMap[pair.lose_catalog_id] = pair.keep_catalog_id;
  });

  // ─── Every OTHER variant of the losing Parent (unpaired, genuinely
  //     unique) simply moves under the surviving Parent ID ───────────────
  const pairedLoserCatalogIds = new Set(variantPairs.map(p => p.lose_catalog_id));
  loserVariantCatalogIds.forEach(cid => {
    if (pairedLoserCatalogIds.has(cid)) return; // already handled above
    const row = variantRowByCatalogId[cid];
    vData[row][vParentCol] = keepParentId;
  });

  variantsSheet.getRange(2, 1, vData.length - 1, vHeaders.length).setValues(vData.slice(1));

  // ─── Repoint every Orders row across all 30 Product N Catalog ID slots ─
  const ordersSheet = getOrdersSheet();
  const oLastRow = ordersSheet.getLastRow();
  const oLastCol = ordersSheet.getLastColumn();
  let ordersRepointed = 0;

  if (oLastRow > 1 && Object.keys(catalogIdRepointMap).length) {
    const oh = ordersSheet.getRange(1, 1, 1, oLastCol).getValues()[0];
    const oData = ordersSheet.getRange(2, 1, oLastRow - 1, oLastCol).getValues();
    const PRODUCT_SLOTS = 30;
    const catalogCols = [];
    for (let n = 1; n <= PRODUCT_SLOTS; n++) {
      const col = oh.indexOf('Product ' + n + ' Catalog ID');
      if (col >= 0) catalogCols.push(col);
    }

    let touchedAnyRow = false;
    oData.forEach(row => {
      let touchedThisRow = false;
      catalogCols.forEach(col => {
        const current = String(row[col] || '');
        if (catalogIdRepointMap[current]) {
          row[col] = catalogIdRepointMap[current];
          touchedThisRow = true;
        }
      });
      if (touchedThisRow) { ordersRepointed++; touchedAnyRow = true; }
    });

    if (touchedAnyRow) {
      ordersSheet.getRange(2, 1, oData.length, oLastCol).setValues(oData);
    }
  }

  // ─── Mark the losing Parent (kept, not deleted) ────────────────────────
  pData[loseParentRow][pNameCol] = loseParentName + ` (merged→${keepParentId})`;
  parentsSheet.getRange(loseParentRow + 1, pNameCol + 1).setValue(pData[loseParentRow][pNameCol]);

  logProductMergeHistory(
    keepParentId, keepParentName, loseParentId, loseParentName,
    variantPairs, ordersRepointed,
    { keeperVariantSnapshot: keeperVariantSnapshot, loserVariantSnapshot: variantSnapshot }
  );

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

  // Restore every loser variant's Parent ID + Variant Name
  Object.keys(loserVariantSnapshot).forEach(cid => {
    const row = rowByCatalogId[cid];
    if (row === undefined) return;
    vData[row][vParentCol] = loserVariantSnapshot[cid].parentId;
    vData[row][vNameCol] = loserVariantSnapshot[cid].variantName;
  });

  // Restore keeper variants' pre-merge field values (undoes the SKU union)
  Object.keys(keeperVariantSnapshot).forEach(cid => {
    const row = rowByCatalogId[cid];
    if (row === undefined) return;
    vData[row][vYourSkuCol] = keeperVariantSnapshot[cid].yourSku;
    vData[row][vTiktokSkusCol] = keeperVariantSnapshot[cid].tiktokSkus;
    vData[row][vNotesCol] = keeperVariantSnapshot[cid].notes;
  });

  variantsSheet.getRange(2, 1, vData.length - 1, vHeaders.length).setValues(vData.slice(1));

  // ─── Repoint Orders back to the loser's Catalog IDs ───────────────────
  const ordersSheet = getOrdersSheet();
  const oLastRow = ordersSheet.getLastRow();
  const oLastCol = ordersSheet.getLastColumn();
  let ordersReverted = 0;

  if (oLastRow > 1 && variantPairs.length) {
    const reverseMap = {}; // keeper Catalog ID -> loser Catalog ID
    variantPairs.forEach(p => { reverseMap[p.keep_catalog_id] = p.lose_catalog_id; });

    const oh = ordersSheet.getRange(1, 1, 1, oLastCol).getValues()[0];
    const oData = ordersSheet.getRange(2, 1, oLastRow - 1, oLastCol).getValues();
    const PRODUCT_SLOTS = 30;
    const catalogCols = [];
    for (let n = 1; n <= PRODUCT_SLOTS; n++) {
      const col = oh.indexOf('Product ' + n + ' Catalog ID');
      if (col >= 0) catalogCols.push(col);
    }

    // NOTE: this reverts EVERY row currently pointing at a keeper Catalog ID
    // that was involved in this merge back to the loser's ID. If the keeper
    // variant received genuinely new orders (unrelated to this merge) after
    // the merge happened, those get reverted too -- undo is intended to run
    // soon after a mistaken merge, not long after, for this reason.
    let touchedAnyRow = false;
    oData.forEach(row => {
      let touchedThisRow = false;
      catalogCols.forEach(col => {
        const current = String(row[col] || '');
        if (reverseMap[current]) {
          row[col] = reverseMap[current];
          touchedThisRow = true;
        }
      });
      if (touchedThisRow) { ordersReverted++; touchedAnyRow = true; }
    });

    if (touchedAnyRow) {
      ordersSheet.getRange(2, 1, oData.length, oLastCol).setValues(oData);
    }
  }

  historySheet.getRange(historyRow + 1, iStatus + 1).setValue('Deshecho');
  if (iUndoneDate >= 0) historySheet.getRange(historyRow + 1, iUndoneDate + 1).setValue(nowISO());

  return jsonResponse({ result: 'undone', merge_id: mergeId, orders_reverted: ordersReverted });
}

// ═══════════════════════════════════════════════════════════════════════════
// DUPLICATE CUSTOMER DETECTION
// ═══════════════════════════════════════════════════════════════════════════

const DUPLICATE_SCORE_THRESHOLD = 55;

function phoneSimilarityScore(phoneA, fullA, phoneB, fullB) {
  const fA = normalizePhone(fullA);
  const fB = normalizePhone(fullB);
  if (fA && fB) return fA === fB ? 100 : 0;

  const extract = (partial) => {
    const s = String(partial || '');
    const prefixM = s.match(/(\d+)\*/);
    const suffixM = s.match(/\*(\d+)$/);
    return { prefix: prefixM ? prefixM[1] : '', suffix: suffixM ? suffixM[1] : '' };
  };
  const pa = extract(phoneA);
  const pb = extract(phoneB);
  if (!pa.prefix && !pa.suffix) return 0;
  if (!pb.prefix && !pb.suffix) return 0;
  if (pa.prefix === pb.prefix && pa.suffix === pb.suffix && (pa.prefix || pa.suffix)) return 100;
  if (pa.suffix && pa.suffix === pb.suffix) return 50;
  if (pa.prefix && pa.prefix === pb.prefix) return 40;
  return 0;
}

function scoreCustomerPair(a, b) {
  let score = 0;

  score += phoneSimilarityScore(a['Phone Partial'], a['Phone Full'], b['Phone Partial'], b['Phone Full']) * 0.45;

  const streetA = String(a['Street + Number'] || '');
  const streetB = String(b['Street + Number'] || '');
  if (streetA && streetB) {
    score += shopifyStringSimilarity(streetA, streetB) * 100 * 0.25;
  }

  if (a['ZIP'] && b['ZIP'] && String(a['ZIP']) === String(b['ZIP'])) {
    score += 15;
  }

  const initA = String(a['Initials (TT Format)'] || '').charAt(0).toUpperCase();
  const initB = String(b['Initials (TT Format)'] || '').charAt(0).toUpperCase();
  if (initA && initA === initB) {
    score += 10;
  }

  const nameA = `${a['First Name'] || ''} ${a['Surname'] || ''}`.trim();
  const nameB = `${b['First Name'] || ''} ${b['Surname'] || ''}`.trim();
  if (nameA && nameB) {
    score += shopifyStringSimilarity(nameA, nameB) * 100 * 0.05;
  }

  return Math.round(Math.min(score, 100));
}

// Bucketed by City first -- two customers in different cities are
// essentially never the same person, so this avoids a full O(n²)
// comparison across everyone (~850 customers = ~360,000 pairs unbucketed;
// bucketing cuts this to a low-thousands worst case).
function getDismissedDuplicatesSheet() {
  return SpreadsheetApp.openById(CUSTOMERS_SHEET_ID).getSheetByName('Dismissed Duplicates');
}

// Order-independent key so A|B and B|A always match the same dismissal.
function dismissedPairKey(idA, idB) {
  return [String(idA), String(idB)].sort().join('|');
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

  const buckets = {};
  customers.forEach(c => {
    const key = String(c['City'] || '').trim().toLowerCase() || '__no_city__';
    if (!buckets[key]) buckets[key] = [];
    buckets[key].push(c);
  });

  const pairs = [];
  const seenPairs = new Set();

  Object.values(buckets).forEach(bucket => {
    for (let i = 0; i < bucket.length; i++) {
      for (let j = i + 1; j < bucket.length; j++) {
        const a = bucket[i], b = bucket[j];
        const pairKey = [a['Customer ID'], b['Customer ID']].sort().join('|');
        if (seenPairs.has(pairKey)) continue;
        seenPairs.add(pairKey);

        if (dismissed.has(pairKey)) continue;

        const score = scoreCustomerPair(a, b);
        if (score >= threshold) {
          pairs.push({ customer_a: a, customer_b: b, score: score });
        }
      }
    }
  });

  pairs.sort((x, y) => y.score - x.score);

  return jsonResponse({ pairs: pairs });
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
// be the one getting retired), sums Shipment Count across both, unions
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
      sheet.getRange(keepRow + 1, col + 1).setValue(loserVal);
    }
  });

  // ─── Sum Shipment Count across both customers ──────────────────────
  if (shipmentCountCol >= 0) {
    const keeperCount = parseInt(data[keepRow][shipmentCountCol], 10) || 0;
    const loserCount = parseInt(data[loseRow][shipmentCountCol], 10) || 0;
    sheet.getRange(keepRow + 1, shipmentCountCol + 1).setValue(keeperCount + loserCount);
  }

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

  if (oLastRow > 1) {
    const oData = ordersSheet.getRange(2, 1, oLastRow - 1, oLastCol).getValues();
    oData.forEach((row) => {
      if (String(row[oCustCol]) === String(loseId)) {
        row[oCustCol] = keepId;
        ordersRepointed++;
      }
    });
    if (ordersRepointed > 0) {
      ordersSheet.getRange(2, 1, oData.length, oLastCol).setValues(oData);
    }
  }

  if (usernameCol >= 0) {
    sheet.getRange(loseRow + 1, usernameCol + 1).setValue(`${loserUsername} (merged→${keepId})`);
  }
  if (notesCol >= 0) {
    const existingNotes = String(data[loseRow][notesCol] || '');
    sheet.getRange(loseRow + 1, notesCol + 1).setValue(
      (existingNotes ? existingNotes + ' | ' : '') + `Merged into ${keepId} on ${nowISO()}`
    );
  }

  logMergeHistory(keepId, keeperUsername, loseId, loserUsername, ordersRepointed, keeperSnapshot);

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
      custSheet.getRange(keepRow + 1, cShopifyIdCol + 1).setValue(snapshot.shopifyCustomerId);
    }
    if (cShipmentCountCol >= 0 && snapshot.shipmentCount !== null && snapshot.shipmentCount !== undefined) {
      custSheet.getRange(keepRow + 1, cShipmentCountCol + 1).setValue(snapshot.shipmentCount);
    }
    if (snapshot.fields) {
      MERGE_BACKFILL_FIELDS.forEach(field => {
        const col = cHeaders.indexOf(field);
        if (col >= 0 && snapshot.fields[field] !== undefined) {
          custSheet.getRange(keepRow + 1, col + 1).setValue(snapshot.fields[field]);
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

  // NOTE: this is a best-effort revert -- it cannot distinguish orders that
  // legitimately belonged to the winner already vs. ones moved during this
  // specific merge, if the winner had other orders before. Given Vel's
  // current workflow (cleaning customers BEFORE the historical import, with
  // zero active orders in the system at merge time), this ambiguity does
  // not arise in practice today.
  if (oLastRow > 1) {
    const oData = ordersSheet.getRange(2, 1, oLastRow - 1, oLastCol).getValues();
    oData.forEach(row => {
      if (String(row[oCustCol]) === String(keepId) && row[oUsernameCol] === originalLoserUsername) {
        row[oCustCol] = loseId;
        ordersReverted++;
      }
    });
    if (ordersReverted > 0) {
      ordersSheet.getRange(2, 1, oData.length, oLastCol).setValues(oData);
    }
  }

  historySheet.getRange(historyRow + 1, iStatus + 1).setValue('Deshecho');
  if (iUndoneDate >= 0) historySheet.getRange(historyRow + 1, iUndoneDate + 1).setValue(nowISO());

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
  custSheet.deleteRow(loseRow + 1);

  historySheet.getRange(historyRow + 1, iStatus + 1).setValue('Limpiado');

  return jsonResponse({ result: 'deleted', merge_id: mergeId, customer_id: loseId, username: deletedUsername });
}
