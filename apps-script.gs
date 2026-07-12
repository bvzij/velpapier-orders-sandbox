const ORDERS_SHEET_ID = '1ghfPmDU6NvOWhzAdyqMcXap2DH3_j47tv5kTCwh4BTg';
const CUSTOMERS_SHEET_ID = '1lM9RjWq4vvcmXTUwJmi0IbS2tQw31CzjnWsFmMON7ak';

const SCRIPT_VERSION = '2026-07-12.2';

const BACKUP_FOLDER_ID = '1wxkTAqFlGlOc-qMGBv24nQswW7IyYMoL';

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
    body.initials_tt || '',
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

// ─── Update order status (rewritten — recalculates true shipment count) ───────

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

// ─── Recalculate shipment count (replaces incrementShipmentCount) ─────────────

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
    if (row[channelCol] !== 'TikTok') continue;
    if (row[statusCol] === 'Enviado' || row[statusCol] === 'Archivado') count++;
  }

  Logger.log('Counted: ' + count + ' for customer: ' + customerID);

  const customersSheet = getCustomersSheet();
  const custData = customersSheet.getDataRange().getValues();
  const custHeaders = custData[0];
  const custIdCol = custHeaders.indexOf('Customer ID');
  const countCol = custHeaders.indexOf('Shipment Count');

  Logger.log('custIdCol: ' + custIdCol + ' countCol: ' + countCol);

  for (let i = 1; i < custData.length; i++) {
    if (custData[i][custIdCol] === customerID) {
      Logger.log('Writing ' + count + ' to row ' + (i+1));
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

  // If status was among the changed fields, fire the same side-effects
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
  if (channel === 'TikTok' && customerID) {
    recalculateShipmentCount(customerID);
  }
}

// Full recompute of every customer's TikTok shipment count from scratch.
// Run manually to fix drift, and set on a once-a-day trigger as a safety net.
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
    if (row[channelCol] !== 'TikTok') continue;
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
  // Prune copies older than 30 days
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

function importTikTokOrders(body) {
  const orders = getOrdersSheet();
  const customersSheet = getCustomersSheet();
  const oh = orders.getRange(1, 1, 1, orders.getLastColumn()).getValues()[0];

  const iTrk = oh.indexOf('Tracking ID');
  const trackingSet = {};
  const lastRow = orders.getLastRow();
  if (lastRow > 1) {
    orders.getRange(2, iTrk + 1, lastRow - 1, 1)
          .getValues()
          .forEach(r => { if (r[0]) trackingSet[String(r[0])] = true; });
  }

  const ch = customersSheet.getRange(1, 1, 1, customersSheet.getLastColumn()).getValues()[0];
  const cCols = {
    street: ch.indexOf('Street + Number') + 1,
    city:   ch.indexOf('City') + 1,
    state:  ch.indexOf('State') + 1,
    zip:    ch.indexOf('ZIP') + 1,
    phone:  ch.indexOf('Phone Partial') + 1,
    notes:  ch.indexOf('Notes') + 1,
  };

  const rows = [], results = [], unresolved = [];

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
      const customers = sheetToObjects(customersSheet);
      const found = customers.find(c => c['Customer ID'] === customerID);
      if (found) {
        const allOrders = getOrdersSheet().getDataRange().getValues();
        const headers = allOrders[0];
        const iChan = headers.indexOf('Channel');
        const iStat = headers.indexOf('Status');
        const iCust = headers.indexOf('Customer ID');
        shipCount = allOrders.slice(1).filter(r =>
          r[iCust] === customerID &&
          ['TikTok', 'Shopify'].includes(r[iChan]) &&
          ['Enviado', 'Archivado'].includes(r[iStat])
        ).length;
        enrichAddressTT(customersSheet, found, s.address || {}, cCols);
      }
    } else if (s.username) {
      unresolved.push(s.username);
    }

    rows.push([
      (s.order_ids || []).join(' + ') || generateUUID(),
      tid,
      customerID,
      primary,
      'TikTok',
      'Pagado',
      s.products || '',
      Number(s.price) || 0,
      '', '', nowISO(), '', '', '', tid
    ]);
    results.push({ tracking_id: tid, inserted: true, customer_id: customerID, shipment_count: shipCount });
  });

  if (rows.length)
    orders.getRange(orders.getLastRow() + 1, 1, rows.length, rows[0].length).setValues(rows);

  return jsonResponse({
    result:     'imported',
    inserted:   rows.length,
    duplicates: results.filter(r => !r.inserted).length,
    unresolved: [...new Set(unresolved)],
    shipments:  results,
  });
}

function enrichAddressTT(sheet, customer, addr, cCols) {
  const pairs = [
    ['street', 'Street + Number'],
    ['city',   'City'],
    ['state',  'State'],
    ['zip',    'ZIP'],
    ['phone',  'Phone Partial'],
  ];
  const noteAdd = [];
  pairs.forEach(([k, col]) => {
    const incoming = (addr[k] || '').toString().trim();
    if (!incoming) return;
    const current = (customer[col] || '').toString().trim();
    const colIdx = { street: cCols.street, city: cCols.city, state: cCols.state, zip: cCols.zip, phone: cCols.phone }[k];
    if (!current && colIdx) {
      sheet.getRange(customer._rowIndex, colIdx).setValue(incoming);
    } else if (current && current.toLowerCase() !== incoming.toLowerCase()) {
      noteAdd.push(`${col} alt: ${incoming}`);
    }
  });
  if (noteAdd.length && cCols.notes > 0) {
    const existing = (customer['Notes'] || '').toString();
    sheet.getRange(customer._rowIndex, cCols.notes)
         .setValue((existing ? existing + ' | ' : '') + noteAdd.join('; '));
  }
}
