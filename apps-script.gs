const ORDERS_SHEET_ID = '1ghfPmDU6NvOWhzAdyqMcXap2DH3_j47tv5kTCwh4BTg';
const CUSTOMERS_SHEET_ID = '1lM9RjWq4vvcmXTUwJmi0IbS2tQw31CzjnWsFmMON7ak';
const QC_SHEET_ID = '1HFzeXHMOxQ3dNb8g4wvU1bp-psGlWMZUlXO0tQYWFxc';

const SCRIPT_VERSION = '2026-08-27.3';

const BACKUP_FOLDER_ID = '1wxkTAqFlGlOc-qMGBv24nQswW7IyYMoL';

// ─── Sheet accessors ───────────────────────────────────────────────────────────

function getOrdersSheet() {
  return SpreadsheetApp.openById(ORDERS_SHEET_ID).getSheets()[0];
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
  return username
    .toLowerCase()
    .replace(/^@/, '')
    .replace(/^tiktok\.com\/@?/, '')
    .replace(/\s*\(.*?\)\s*/g, '')
    .trim();
}

function findCustomerByUsername(customers, rawUsername) {
  const normalized = normalizeUsername(rawUsername);
  if (!normalized) return null;

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

// ─── GET handler ───────────────────────────────────────────────────────────────

function doGet(e) {
  try {
    const action = e.parameter.action || 'orders';

    if (action === 'ping') return jsonResponse({ ok: true });
    if (action !== 'version' && !authOk(e.parameter.token)) return jsonResponse({ error: 'unauthorized' });

    if (action === 'version') return jsonResponse({ version: SCRIPT_VERSION });

    if (action === 'get_upload_signature') return getUploadSignature(e);
    if (action === 'qc') return getQC(e);
    if (action === 'active_session') return getActiveSession(e);
    if (action === 'sessions') return getSessions(e);

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

      return jsonResponse({ records: customers });
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
    

    return jsonResponse({ error: 'Unknown action' });

  } catch (err) {
    return jsonResponse({ error: err.message });
  }
}

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

  const row = [
    body.order_id || generateUUID(),
    body.tracking_id || '',
    customerID,
    primaryUsername,
    body.channel || 'Manual',
    status,
    body.products || '',
    body.price || 0,
    body.shopify_order_id || '',
    body.notes || '',
    nowISO(),
    '',   // Packed Date
    '',   // Shipped Date
    '',   // Archive Date
    body.linked_shipment || ''
  ];

  ordersSheet.appendRow(row);

  return jsonResponse({
    result: 'created',
    order_id: row[0],
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

  const row = [
    customerID,
    body.primary_username || '',
    body.aliases || '',
    body.first_name || '',
    body.surname || '',
    body.initials || '',
    body.street || '',
    body.city || '',
    body.state || '',
    body.zip || '',
    body.phone_partial || '',
    body.phone_full || '',
    body.email || '',
    nowISO(),
    0,
    body.notes || '',
    false
  ];

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
// REPLACE the entire existing importTikTokOrders() function with this one.
// Find it by searching for:  function importTikTokOrders(body) {
// and replace all the way down to its closing brace (the one right before
// the "// ─── Bulk customer creation" comment that follows it).
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
  (body.shipments || []).forEach(s => {
    (s.line_items || []).forEach(li => allLineItems.push(li));
  });
  const skuToCatalogId = allLineItems.length ? resolveLineItemsBatch(allLineItems) : {};

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
        const noteAdd = [];
        pairs.forEach(([k, colIdx]) => {
          const incoming = (addr[k] || '').toString().trim();
          if (!incoming || colIdx < 0) return;
          const current = (custData[idx][colIdx] || '').toString().trim();
          if (!current) {
            custData[idx][colIdx] = incoming;
            customersDirty = true;
          } else if (current.toLowerCase() !== incoming.toLowerCase()) {
            noteAdd.push(`${k} alt: ${incoming}`);
          }
        });
        if (noteAdd.length && cCol.notes >= 0) {
          const existing = (custData[idx][cCol.notes] || '').toString();
          custData[idx][cCol.notes] = (existing ? existing + ' | ' : '') + noteAdd.join('; ');
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
  if (rows.length)
    orders.getRange(orders.getLastRow() + 1, 1, rows.length, rows[0].length).setValues(rows);

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
    rows.push([
      customerID,
      cust.primary_username || '',
      cust.aliases || '',
      cust.first_name || '',
      cust.surname || '',
      cust.initials || '',
      cust.street || '',
      cust.city || '',
      cust.state || '',
      cust.zip || '',
      cust.phone_partial || '',
      cust.phone_full || '',
      cust.email || '',
      nowISO(),
      0,
      cust.notes || '',
      false
    ]);
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
// ADD THIS ENTIRE BLOCK ANYWHERE IN apps-script.gs (e.g. right after the
// existing getQCSheet() function, near the other sheet accessors).
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
// ADD THIS ENTIRE BLOCK anywhere in apps-script.gs (e.g. right after
// findCustomerByUsername(), since it's conceptually the Shopify sibling
// of that TikTok resolution function).
// ═══════════════════════════════════════════════════════════════════════════

function getShopifyMatchesSheet() {
  return SpreadsheetApp.openById(CUSTOMERS_SHEET_ID).getSheetByName('Shopify Customer Matches');
}

const SHOPIFY_SCORE_THRESHOLD = 30; // below this, treat as "no reasonable guess" -> straight to new_customer

// Simple Levenshtein-based similarity, 0-1. Reused from the Product Catalog
// fuzzy-matching (same function name/shape as stringSimilarity() there —
// if that function already exists in this file, DELETE this duplicate
// definition and just call the existing one instead.)
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

  // Phone — 40%
  const phoneScore = phoneMatchScore(
    incoming.phone,
    customer['Phone Full'],
    customer['Phone Partial']
  );
  score += phoneScore * 0.40;

  // Full name — 25%
  const customerFullName = `${customer['First Name'] || ''} ${customer['Surname'] || ''}`.trim();
  if (incoming.fullName && customerFullName) {
    score += shopifyStringSimilarity(incoming.fullName, customerFullName) * 100 * 0.25;
  }

  // Username (optional, from the 'company' field) — 20%
  // Skipped entirely if either side is blank -- a blank never counts as a match.
  if (incoming.username) {
    const candidates = [customer['Primary Username'] || ''].concat(
      String(customer['Aliases'] || '').split(',').map(a => a.trim())
    ).filter(Boolean);
    let bestUsernameScore = 0;
    candidates.forEach(cand => {
      const s = shopifyStringSimilarity(normalizeUsername(incoming.username), normalizeUsername(cand));
      if (s > bestUsernameScore) bestUsernameScore = s;
    });
    score += bestUsernameScore * 100 * 0.20;
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
    const found = customers.find(c =>
      String(c['Shopify Customer ID'] || '') === String(incoming.shopifyCustomerId)
    );
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

// ═══════════════════════════════════════════════════════════════════════════
// SHOPIFY ORDER IMPORT — the actual endpoint N8N will POST to.
// ADD THIS BLOCK anywhere in apps-script.gs, after the resolution block
// (03_ADD_shopify_resolution.gs) since it calls functions defined there.
//
// ALSO: add this one line inside doPost()'s action dispatcher, alongside
// the other "if (action === ...)" lines:
//     if (action === 'import_shopify_order') return importShopifyOrder(body);
// ═══════════════════════════════════════════════════════════════════════════

function importShopifyOrder(body) {
  const ordersSheet = getOrdersSheet();
  const oh = ordersSheet.getRange(1, 1, 1, ordersSheet.getLastColumn()).getValues()[0];

  const shopifyOrderId = String(body.shopify_order_id || '');
  const orderName = body.order_name || ''; // e.g. "#1346"

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
    // Order still gets written below with a blank Customer ID -- fulfillment
    // isn't blocked while Vel reviews. The match is logged so it survives
    // reloads and shows up in the pending-review queue.
    matchId = logShopifyMatch(incoming, resolution, shopifyOrderId, orderName);

  } else if (resolution.tier === 'new') {
    // No reasonable match at all -- create the customer immediately from
    // Shopify's own (generally reliable) data, and store their Shopify
    // Customer ID right away so this exact person is a Tier-1 auto-match
    // on every future order.
    const customersSheet = getCustomersSheet();
    const nameParts = (incoming.fullName || '').split(' ');
    const firstName = nameParts[0] || '';
    const surname   = nameParts.slice(1).join(' ');

    customerID = generateCustomerID(customersSheet);
    customersSheet.appendRow([
      customerID,                       // Customer ID
      incoming.username || '',          // Primary Username
      '',                                // Aliases
      incoming.shopifyCustomerId || '', // Shopify Customer ID
      firstName,                        // First Name
      surname,                          // Surname
      '',                                // Initials (TT Format)
      '',                                // Street + Number
      incoming.city || '',              // City
      incoming.state || '',             // State
      incoming.zip || '',               // ZIP
      '',                                // Phone Partial
      incoming.phone || '',             // Phone Full
      incoming.email || '',             // Email
      nowISO(),                          // First Order Date
      0,                                 // Shipment Count
      'Auto-created from Shopify order ' + orderName, // Notes
      false,                             // Merge Flag
    ]);
  }

  // ─── Write the Orders row (always, regardless of tier) ────────────
  const row = new Array(oh.length).fill('');
  row[oh.indexOf('Order ID')] = generateUUID();
  row[oh.indexOf('Shopify Order ID')] = shopifyOrderId;
  row[oh.indexOf('Customer ID')] = customerID;
  row[oh.indexOf('Primary Username')] = incoming.username || '';
  row[oh.indexOf('Channel')] = 'Shopify';
  row[oh.indexOf('Status')] = 'Pagado';
  row[oh.indexOf('Products')] = body.products || '';
  row[oh.indexOf('Price')] = Number(body.price) || 0;
  row[oh.indexOf('Created Date')] = nowISO();

  // Populate the 30 product slots, same pattern as importTikTokOrders.
  const PRODUCT_SLOTS = 30;
  const lineItems = body.line_items || [];
  const allLineItems = lineItems.map(li => ({
    sku_id:    li.sku_id || li.variant_id || '', // Shopify variant_id as fallback identifier
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
}
