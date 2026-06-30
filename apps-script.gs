// ─────────────────────────────────────────────────────────────────────────────
// Canonical copy of the Apps Script bound to the Orders/Customers sheets.
//
// IMPORTANT: This file is NOT executed by the website. It must be pasted into
// the Apps Script editor for the project bound to ORDERS_SHEET_ID /
// CUSTOMERS_SHEET_ID below, replacing the existing script content. After
// pasting, go to Deploy > Manage deployments > Edit (pencil icon) > Version:
// "New version" > Deploy. A code-only change like this does NOT require a new
// deployment URL — the existing /exec URL keeps working. (Only "New
// deployment" instead of "New version" would change the URL, and that's not
// needed here.)
//
// Changes vs. the previous version (performance optimization, no behavior
// change):
//   1. updateOrder, deleteOrder, updateOrderStatus, updatePackedDate now use
//      findOrderRow() (TextFinder on column A) instead of sheetToObjects()
//      + .find() to locate a single row. This avoids reading/JSON-ifying the
//      entire sheet just to find one row by Order ID.
//   2. doGet's `action=orders` branch now filters rows BEFORE building
//      response objects, using the raw getValues() grid directly. Rows that
//      don't match status/channel/customer_id are never converted to JSON.
//      `status` now accepts a comma-separated list, e.g.
//      ?status=No Pagado,Pagado,Enviado
// ─────────────────────────────────────────────────────────────────────────────

const ORDERS_SHEET_ID = '1ghfPmDU6NvOWhzAdyqMcXap2DH3_j47tv5kTCwh4BTg';
const CUSTOMERS_SHEET_ID = '1lM9RjWq4vvcmXTUwJmi0IbS2tQw31CzjnWsFmMON7ak';

// ─── Sheet accessors ───────────────────────────────────────────────────────────

function getOrdersSheet() {
  return SpreadsheetApp.openById(ORDERS_SHEET_ID).getSheets()[0];
}

function getCustomersSheet() {
  return SpreadsheetApp.openById(CUSTOMERS_SHEET_ID).getSheets()[0];
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

// Locates a single row by Order ID without scanning the whole sheet into
// memory. Order ID lives in column A. Returns the 1-based sheet row number,
// or null if not found.
function findOrderRow(sheet, orderID) {
  const idColumn = sheet.getRange('A:A'); // Order ID is column A
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

  // 1. Exact match on Primary Username
  let match = customers.find(c =>
    normalizeUsername(c['Primary Username']) === normalized
  );
  if (match) return { customer: match, confidence: 'exact' };

  // 2. Exact match in Aliases
  match = customers.find(c => {
    const aliases = (c['Aliases'] || '').split(',').map(a => normalizeUsername(a.trim()));
    return aliases.includes(normalized);
  });
  if (match) return { customer: match, confidence: 'alias' };

  // 3. Fuzzy match (simple prefix / substring for now — flag for review)
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

        // Only rows that survive every filter get converted to objects.
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

    if (action === 'create_order') return createOrder(body);
    if (action === 'create_customer') return createCustomer(body);
    if (action === 'update_order_status') return updateOrderStatus(body);
    if (action === 'add_alias') return addAlias(body);
    if (action === 'update_packed_date') return updatePackedDate(body);
    if (action === 'migrate_order') return migrateOrder(body);
    if (action === 'stamp_customer_ids') { stampCustomerIDs(); return jsonResponse({ result: 'done' }); }
    if (action === 'update_order') return updateOrder(body);
    if (action === 'delete_order') return deleteOrder(body);

    return jsonResponse({ error: 'Unknown action' });

  } catch (err) {
    return jsonResponse({ error: err.message });
  }
}

// ─── Create order ──────────────────────────────────────────────────────────────

function createOrder(body) {
  const ordersSheet = getOrdersSheet();
  const customersSheet = getCustomersSheet();

  // Dedup check for TikTok orders (by Tracking ID)
  if (body.channel === 'TikTok' && body.tracking_id) {
    const existing = sheetToObjects(ordersSheet);
    const dup = existing.find(o => o['Tracking ID'] === body.tracking_id);
    if (dup) {
      // Safety net: cross-check Order ID
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

  // Identity resolution
  const customers = sheetToObjects(customersSheet);
  let customerID = '';
  let primaryUsername = body.username || '';
  let mergeFlag = false;

  if (body.username) {
    const resolution = findCustomerByUsername(customers, body.username);
    if (resolution) {
      customerID = resolution.customer['Customer ID'];
      primaryUsername = resolution.customer['Primary Username'];
      if (resolution.confidence === 'fuzzy') mergeFlag = true;
    }
    // If no match: customerID stays blank — dashboard will flag for manual customer creation
  }

  // Status logic
  let status = body.status || 'No Pagado';
  if (body.channel === 'TikTok') status = 'Pagado';

  // Build row
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
    '',   // Packed Date — filled later from mobile QC
    '',   // Shipped Date — filled later via API or manually
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

  // Check if already exists
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
    body.initials_tt || '',
    body.street || '',
    body.city || '',
    body.state || '',
    body.zip || '',
    body.phone_partial || '',
    body.phone_full || '',
    body.email || '',
    nowISO(),
    0,   // Shipment Count starts at 0
    body.notes || '',
    false // Merge Flag
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
  const packedCol = headers.indexOf('Packed Date') + 1;
  const shippedCol = headers.indexOf('Shipped Date') + 1;
  const customerIdCol = headers.indexOf('Customer ID') + 1;

  sheet.getRange(rowIndex, statusCol).setValue(body.status);

  if (body.status === 'Empacado' && packedCol > 0) {
    sheet.getRange(rowIndex, packedCol).setValue(nowISO());
  }
  if (body.status === 'Enviado' && shippedCol > 0) {
    sheet.getRange(rowIndex, shippedCol).setValue(nowISO());
  }

  // Increment shipment count on customer when packed
  if (body.status === 'Empacado' && customerIdCol > 0) {
    const customerID = sheet.getRange(rowIndex, customerIdCol).getValue();
    if (customerID) incrementShipmentCount(customerID);
  }

  return jsonResponse({ result: 'updated', order_id: body.order_id, status: body.status });
}

// ─── Increment shipment count ──────────────────────────────────────────────────

function incrementShipmentCount(customerID) {
  const sheet = getCustomersSheet();
  const customers = sheetToObjects(sheet);
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const countCol = headers.indexOf('Shipment Count') + 1;

  const customer = customers.find(c => c['Customer ID'] === customerID);
  if (!customer || countCol === 0) return;

  const current = parseInt(customer['Shipment Count'], 10) || 0;
  sheet.getRange(customer._rowIndex, countCol).setValue(current + 1);
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

function migrateOrder(body) {
  const ordersSheet = getOrdersSheet();

  const row = [
    body.order_id || generateUUID(),
    body.tracking_id || '',
    '',                          // Customer ID — resolved separately
    body.username || '',         // Primary Username as-is for now
    body.channel || 'Manual',
    body.status || 'No Pagado',
    body.products || '',
    body.price || 0,
    body.shopify_order_id || '',
    body.notes || '',
    body.created_date || nowISO(),
    body.packed_date || '',
    body.shipped_date || '',
    ''                           // Linked Shipment
  ];

  ordersSheet.appendRow(row);
  return jsonResponse({ result: 'migrated', order_id: row[0] });
}

function stampCustomerIDs() {
  const ordersSheet = getOrdersSheet();
  const customersSheet = getCustomersSheet();

  const customers = sheetToObjects(customersSheet);
  const orders = sheetToObjects(ordersSheet);
  const headers = ordersSheet.getRange(1, 1, 1, ordersSheet.getLastColumn()).getValues()[0];

  const customerIDCol = headers.indexOf('Customer ID') + 1;
  const primaryUsernameCol = headers.indexOf('Primary Username') + 1;

  let stamped = 0;
  let notFound = 0;
  let notFoundList = [];

  orders.forEach(order => {
    if (order['Customer ID']) return; // already has one, skip

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

  return jsonResponse({ result: 'updated', order_id: body.order_id });
}

function deleteOrder(body) {
  const sheet = getOrdersSheet();
  const rowIndex = findOrderRow(sheet, body.order_id);
  if (!rowIndex) return jsonResponse({ error: 'Order not found' });

  sheet.deleteRow(rowIndex);
  return jsonResponse({ result: 'deleted', order_id: body.order_id });
}
