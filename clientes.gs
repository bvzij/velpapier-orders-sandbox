// ═══════════════════════════════════════════════════════════════════════════
// CLIENTES page backend (clientes.gs) — every action starts with "cli_"
// ═══════════════════════════════════════════════════════════════════════════
//
// Routing (apps-script.gs): doGet -> cliDispatchGet(), dispatchPostAction -> cliDispatchPost().
// Access: the page scope 'clientes' (Ajustes -> Acceso a páginas) opens the READ actions.
// Every WRITE action is admin only. Staff never receive phone, email, street, ZIP or
// notes: they are removed here on the server, not just hidden on screen.
//
// Reused from apps-script.gs (nothing rebuilt): sheetToObjects, getCustomersSheet,
// getOrdersSheet, getAuditLogSheet, getMergeHistorySheet, getShopifyMatchesSheet,
// appendCustomerRowByHeader, setCustomerCell, generateCustomerID, normalizeUsername,
// dupFeatures, dupScorePair, DUPLICATE_SCORE_THRESHOLD, recalculateShipmentCountsFor,
// logAudit, logAuditEvent, requireAdmin, hasScope, jsonResponse, nowISO.
//
// Merge / undo / cleanup / dismiss / find-duplicates stay the existing actions
// (merge_customers, undo_merge, delete_merged_customer, dismiss_duplicate_pair,
// find_duplicate_customers, merge_history) — the page calls them directly.
//
// New sheet (created on first delete): "Deleted Customers" in the Customers spreadsheet.
// New Customers column (created on first save of a tag): "Tags".

const CLI_FIELDS = [
  'Primary Username', 'Aliases', 'First Name', 'Surname', 'Initials (TT Format)',
  'Street + Number', 'City', 'State', 'ZIP', 'Phone Partial', 'Phone Full', 'Email',
  'Notes', 'Tags',
];
// Removed server-side for staff.
const CLI_STAFF_HIDDEN = ['Phone Partial', 'Phone Full', 'Email', 'Street + Number', 'ZIP', 'Notes'];
const CLI_DELETED_HEADERS = ['Deleted ID', 'Customer ID', 'Username', 'Deleted By', 'Deleted At', 'Status', 'Restored At', 'Snapshot'];
const CLI_AUDIT_SCAN_ROWS = 30000;   // timeline reads at most this many rows from the end of the log
const CLI_ORDERS_IN_DETAIL = 300;

// ─── small helpers ─────────────────────────────────────────────────────────
function cliStr_(v) { return v === null || v === undefined ? '' : String(v).trim(); }
function cliIsMerged_(c) { return String(c['Primary Username'] || '').indexOf('(merged→') >= 0; }
function cliIso_(v) {
  if (v instanceof Date) return isNaN(v.getTime()) ? '' : v.toISOString();
  return v === null || v === undefined ? '' : String(v);
}
function cliMs_(v) {
  if (v instanceof Date) return v.getTime();
  if (!v) return NaN;
  return Date.parse(String(v));
}
function cliNum_(v) { return Number(String(v === null || v === undefined ? '' : v).replace(/[^0-9.\-]/g, '')) || 0; }
function cliErr_(msg) { return jsonResponse({ error: msg }); }
function cliIsAdmin_(identity) { return !!identity && requireAdmin(identity.role); }

function cliHeaders_(sheet) {
  const h = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map(x => String(x));
  while (h.length && h[h.length - 1] === '') h.pop();
  return h;
}

// Returns the 0-based index of column `name`, adding it at the far right when missing.
function cliEnsureColumn_(sheet, name) {
  const h = cliHeaders_(sheet);
  const i = h.indexOf(name);
  if (i >= 0) return i;
  sheet.getRange(1, h.length + 1).setValue(name);
  return h.length;
}

function cliNormAliases_(raw) {
  const seen = {};
  return String(raw || '').split(',').map(s => s.trim()).filter(s => {
    const k = normalizeUsername(s);
    if (!s || !k || seen[k]) return false;
    seen[k] = true;
    return true;
  }).join(', ');
}

function cliNormTags_(raw) {
  const seen = {};
  return String(raw || '').split(',').map(s => s.trim()).filter(s => {
    const k = s.toLowerCase();
    if (!s || seen[k]) return false;
    seen[k] = true;
    return true;
  }).join(', ');
}

function cliDisplayName_(c) {
  const u = cliStr_(c['Primary Username']);
  if (u) return u;
  const n = [c['First Name'], c['Surname']].map(cliStr_).filter(Boolean).join(' ');
  return n || cliStr_(c['Email']) || cliStr_(c['Customer ID']);
}

// The active (non-merged) customer that already uses this username as primary or alias.
function cliFindUsername_(customers, raw, excludeId) {
  const norm = normalizeUsername(raw);
  if (!norm) return null;
  for (let i = 0; i < customers.length; i++) {
    const c = customers[i];
    if (cliIsMerged_(c)) continue;
    if (excludeId && cliStr_(c['Customer ID']) === excludeId) continue;
    const names = [c['Primary Username']].concat(String(c['Aliases'] || '').split(','));
    for (let j = 0; j < names.length; j++) if (normalizeUsername(names[j]) === norm) return c;
  }
  return null;
}

function cliReadOrders_() {
  const data = getOrdersSheet().getDataRange().getValues();
  if (data.length < 2) return { h: data[0] || [], rows: [] };
  return { h: data[0], rows: data.slice(1) };
}

function cliCustomerRow_(sheet, id) {
  const customers = sheetToObjects(sheet);
  for (let i = 0; i < customers.length; i++) if (cliStr_(customers[i]['Customer ID']) === id) return customers[i];
  return null;
}

// ─── Routers ───────────────────────────────────────────────────────────────
function cliDispatchGet(action, e, identity) {
  if (!hasScope(identity, 'clientes')) return jsonResponse({ error: 'unauthorized' });
  const admin = cliIsAdmin_(identity);
  try {
    if (action === 'cli_list') return cliListAction_(admin);
    if (action === 'cli_detail') return cliDetailAction_(e, admin);
    if (action === 'cli_shopify_count') return cliShopifyCountAction_();
    if (!admin) return jsonResponse({ error: 'unauthorized' });
    if (action === 'cli_export') return cliExportAction_();
    if (action === 'cli_deleted') return cliDeletedListAction_();
    return cliErr_('Acción desconocida: ' + action);   // frontend newer than backend -> deploy clientes.gs again
  } catch (err) {
    return cliErr_(err.message);
  }
}

// Called inside withWriteLock (dispatchPostAction), so every write is serialised and audited.
function cliDispatchPost(action, body, identity) {
  if (!hasScope(identity, 'clientes') || !cliIsAdmin_(identity)) return jsonResponse({ error: 'unauthorized' });
  try {
    if (action === 'cli_create') return cliCreateAction_(body);
    if (action === 'cli_update') return cliUpdateAction_(body);
    if (action === 'cli_delete') return cliDeleteAction_(body, identity);
    if (action === 'cli_restore') return cliRestoreAction_(body, identity);
    if (action === 'cli_recalc') return cliRecalcAction_(body);
    return cliErr_('Acción desconocida: ' + action);
  } catch (err) {
    return cliErr_(err.message);
  }
}

// ─── GET cli_list ──────────────────────────────────────────────────────────
// One compact record per active customer. Order Count / Last Order come from one
// pass over Orders (Nota rows excluded, same rule as ordersCountByCustomer_).
function cliListAction_(admin) {
  const customers = sheetToObjects(getCustomersSheet())
    .filter(c => cliStr_(c['Customer ID']) && !cliIsMerged_(c));
  const o = cliReadOrders_();
  const iC = o.h.indexOf('Customer ID'), iCh = o.h.indexOf('Channel');
  const iOD = o.h.indexOf('Order Date'), iCD = o.h.indexOf('Created Date');
  const agg = {};
  if (iC >= 0) {
    o.rows.forEach(r => {
      const id = cliStr_(r[iC]);
      if (!id) return;
      if (iCh >= 0 && String(r[iCh]) === 'Nota') return;
      const a = agg[id] || (agg[id] = { oc: 0, last: NaN });
      a.oc++;
      const raw = (iOD >= 0 && r[iOD]) ? r[iOD] : (iCD >= 0 ? r[iCD] : '');
      const ms = cliMs_(raw);
      if (!isNaN(ms) && (isNaN(a.last) || ms > a.last)) a.last = ms;
    });
  }
  const records = customers.map(c => {
    const id = cliStr_(c['Customer ID']);
    const a = agg[id] || { oc: 0, last: NaN };
    const rec = {
      id: id,
      username: cliStr_(c['Primary Username']),
      aliases: cliStr_(c['Aliases']),
      name: [c['First Name'], c['Surname']].map(cliStr_).filter(Boolean).join(' '),
      city: cliStr_(c['City']),
      state: cliStr_(c['State']),
      oc: a.oc,
      sc: Number(c['Shipment Count']) || 0,
      first: cliIso_(c['First Order Date']),
      last: isNaN(a.last) ? '' : new Date(a.last).toISOString(),
      tags: cliStr_(c['Tags']),
    };
    if (admin) {
      rec.phone = cliStr_(c['Phone Full']) || cliStr_(c['Phone Partial']);
      rec.email = cliStr_(c['Email']);
    }
    return rec;
  });
  return jsonResponse({ records: records, admin: admin, total: records.length });
}

// ─── GET cli_detail?customer_id= ───────────────────────────────────────────
function cliDetailAction_(e, admin) {
  const id = cliStr_(e.parameter.customer_id);
  if (!id) return cliErr_('Falta el ID del cliente.');
  const c = cliCustomerRow_(getCustomersSheet(), id);
  if (!c) return cliErr_('Cliente no encontrado: ' + id);

  const customer = {};
  Object.keys(c).forEach(k => {
    if (k === '_rowIndex') return;
    if (!admin && CLI_STAFF_HIDDEN.indexOf(k) >= 0) return;
    customer[k] = cliIso_(c[k]);
  });

  // Orders of this customer (both channels).
  const o = cliReadOrders_();
  const ix = n => o.h.indexOf(n);
  const iC = ix('Customer ID');
  const orders = [];
  let spend = 0;
  if (iC >= 0) {
    o.rows.forEach(r => {
      if (cliStr_(r[iC]) !== id) return;
      const channel = cliStr_(r[ix('Channel')]);
      const status = cliStr_(r[ix('Status')]);
      const raw = (ix('Order Date') >= 0 && r[ix('Order Date')]) ? r[ix('Order Date')] : (ix('Created Date') >= 0 ? r[ix('Created Date')] : '');
      const rec = {
        order_id: cliStr_(r[ix('Order ID')]),
        tracking_id: cliStr_(r[ix('Tracking ID')]),
        channel: channel,
        status: status,
        date: cliIso_(raw),
      };
      if (admin && ix('Price') >= 0) {
        rec.price = cliNum_(r[ix('Price')]);
        if (channel !== 'Nota' && (status === 'Pagado' || status === 'Enviado')) spend += rec.price;
      }
      orders.push(rec);
    });
  }
  orders.sort((a, b) => String(b.date).localeCompare(String(a.date)));
  const out = { customer: customer, orders: orders.slice(0, CLI_ORDERS_IN_DETAIL), orders_total: orders.length, admin: admin };

  if (admin) {
    out.spend = spend;
    out.merges = cliMergesFor_(id);
    out.timeline = cliAuditFor_(id);
  }
  return jsonResponse(out);
}

function cliMergesFor_(id) {
  let sh = null;
  try { sh = getMergeHistorySheet(); } catch (err) { sh = null; }
  if (!sh) return [];
  return sheetToObjects(sh)
    .filter(r => cliStr_(r['Kept Customer ID']) === id || cliStr_(r['Merged Customer ID']) === id)
    .map(r => ({
      merge_id: cliStr_(r['Merge ID']),
      kept_id: cliStr_(r['Kept Customer ID']), kept_username: cliStr_(r['Kept Username']),
      merged_id: cliStr_(r['Merged Customer ID']), merged_username: cliStr_(r['Merged Username']),
      orders_repointed: r['Orders Repointed'], status: cliStr_(r['Status']), date: cliIso_(r['Merged Date']),
    }))
    .sort((a, b) => String(b.date).localeCompare(String(a.date)));
}

// Newest first, capped. Reads only the tail of the current-year log.
function cliAuditFor_(id) {
  const sh = getAuditLogSheet();
  if (!sh) return [];
  const last = sh.getLastRow();
  if (last < 2) return [];
  const hdr = cliHeaders_(sh);
  const col = n => hdr.indexOf(n);
  const start = Math.max(2, last - CLI_AUDIT_SCAN_ROWS + 1);
  const vals = sh.getRange(start, 1, last - start + 1, hdr.length).getValues();
  const out = [];
  for (let i = vals.length - 1; i >= 0 && out.length < 200; i--) {
    const r = vals[i];
    if (cliStr_(r[col('Record ID')]) !== id) continue;
    out.push({
      ts: cliIso_(r[col('Timestamp')]), person: cliStr_(r[col('Person')]), action: cliStr_(r[col('Action')]),
      field: cliStr_(r[col('Field')]), before: cliStr_(r[col('Before')]), after: cliStr_(r[col('After')]),
      details: cliStr_(r[col('Details')]).slice(0, 600),
    });
  }
  return out;
}

// ─── GET cli_export (admin) ────────────────────────────────────────────────
function cliExportAction_() {
  const sheet = getCustomersSheet();
  const headers = cliHeaders_(sheet);
  const data = sheet.getDataRange().getValues();
  const iU = headers.indexOf('Primary Username');
  const rows = data.slice(1)
    .filter(r => cliStr_(r[headers.indexOf('Customer ID')]) && String(r[iU] || '').indexOf('(merged→') < 0)
    .map(r => headers.map((h, j) => cliIso_(r[j])));
  return jsonResponse({ headers: headers, rows: rows });
}

// ─── GET cli_shopify_count ─────────────────────────────────────────────────
// Light count only; the actual review tool lives in Pedidos (bulk, with candidates).
function cliShopifyCountAction_() {
  const sh = getShopifyMatchesSheet();
  if (!sh) return jsonResponse({ matches: 0, people: 0 });
  const pending = sheetToObjects(sh).filter(m => cliStr_(m['Decision']) === 'Pending');
  const keys = {};
  pending.forEach(m => { keys[cliStr_(m['Shopify Customer ID']) || cliStr_(m['Match ID'])] = true; });
  return jsonResponse({ matches: pending.length, people: Object.keys(keys).length });
}

// ─── POST cli_create ───────────────────────────────────────────────────────
// body: { fields:{ 'Primary Username':..., ... }, force:true? }
// Exact username (or alias) already in use -> error. Similar customers (same score the
// duplicate finder uses) -> { result:'similar', matches } until the caller repeats with force.
function cliCreateAction_(body) {
  const f = body.fields || {};
  const vals = {};
  CLI_FIELDS.forEach(h => { vals[h] = cliStr_(f[h]); });
  vals['Aliases'] = cliNormAliases_(vals['Aliases']);
  vals['Tags'] = cliNormTags_(vals['Tags']);
  if (!vals['Primary Username'] && !vals['First Name'] && !vals['Surname'] && !vals['Phone Full'] && !vals['Phone Partial'] && !vals['Email']) {
    return cliErr_('Escribe al menos un usuario, nombre, teléfono o correo.');
  }

  const sheet = getCustomersSheet();
  const customers = sheetToObjects(sheet).filter(c => !cliIsMerged_(c));

  if (vals['Primary Username']) {
    const hit = cliFindUsername_(customers, vals['Primary Username'], '');
    if (hit) return cliErr_('Ya existe un cliente con ese usuario: ' + cliStr_(hit['Customer ID']) + ' (' + cliDisplayName_(hit) + ').');
  }

  if (!body.force) {
    const fNew = dupFeatures(vals);
    const matches = [];
    customers.forEach(c => {
      const res = dupScorePair(fNew, dupFeatures(c));
      if (res.score >= DUPLICATE_SCORE_THRESHOLD) {
        matches.push({
          customer_id: cliStr_(c['Customer ID']), username: cliStr_(c['Primary Username']),
          name: [c['First Name'], c['Surname']].map(cliStr_).filter(Boolean).join(' '),
          city: cliStr_(c['City']), phone: cliStr_(c['Phone Full']) || cliStr_(c['Phone Partial']),
          score: res.score, reasons: res.reasons,
        });
      }
    });
    if (matches.length) {
      matches.sort((a, b) => b.score - a.score);
      return jsonResponse({ result: 'similar', matches: matches.slice(0, 5) });
    }
  }

  if (vals['Tags']) cliEnsureColumn_(sheet, 'Tags');
  const newId = generateCustomerID(sheet);
  const fv = Object.assign({}, vals, {
    'Customer ID': newId, 'First Order Date': nowISO(), 'Shipment Count': 0, 'Merge Flag': false,
  });
  appendCustomerRowByHeader(sheet, fv);
  logAuditEvent('cli_create', 'Customer', newId, { primary_username: vals['Primary Username'], manual: true, forced: !!body.force });
  return jsonResponse({ result: 'created', customer_id: newId });
}

// ─── POST cli_update ───────────────────────────────────────────────────────
// body: { customer_id, fields:{ header: value } } — only CLI_FIELDS may change.
function cliUpdateAction_(body) {
  const id = cliStr_(body.customer_id);
  const fields = body.fields || {};
  if (!id) return cliErr_('Falta el ID del cliente.');
  const sheet = getCustomersSheet();
  const c = cliCustomerRow_(sheet, id);
  if (!c) return cliErr_('Cliente no encontrado: ' + id);
  if (cliIsMerged_(c)) return cliErr_('Este cliente ya fue fusionado y no se puede editar.');

  const keys = Object.keys(fields);
  for (let i = 0; i < keys.length; i++) {
    if (CLI_FIELDS.indexOf(keys[i]) < 0) return cliErr_('Campo no editable: ' + keys[i]);
  }

  const next = {};
  keys.forEach(k => {
    let v = cliStr_(fields[k]);
    if (k === 'Aliases') v = cliNormAliases_(v);
    if (k === 'Tags') v = cliNormTags_(v);
    next[k] = v;
  });

  if (next['Primary Username'] !== undefined && next['Primary Username'] !== cliStr_(c['Primary Username']) && next['Primary Username']) {
    const customers = sheetToObjects(sheet);
    const hit = cliFindUsername_(customers, next['Primary Username'], id);
    if (hit) return cliErr_('Ese usuario ya lo tiene ' + cliStr_(hit['Customer ID']) + ' (' + cliDisplayName_(hit) + '). Si es la misma persona, fusiónalos.');
  }
  if (next['Aliases']) {
    const customers = sheetToObjects(sheet);
    const mine = cliStr_(next['Primary Username'] !== undefined ? next['Primary Username'] : c['Primary Username']);
    const list = next['Aliases'].split(',').map(s => s.trim()).filter(Boolean);
    for (let i = 0; i < list.length; i++) {
      if (normalizeUsername(list[i]) === normalizeUsername(mine)) continue;
      const hit = cliFindUsername_(customers, list[i], id);
      if (hit) return cliErr_('El alias «' + list[i] + '» ya lo usa ' + cliStr_(hit['Customer ID']) + ' (' + cliDisplayName_(hit) + ').');
    }
  }

  if (next['Tags'] !== undefined && next['Tags'] !== cliStr_(c['Tags'])) cliEnsureColumn_(sheet, 'Tags');
  const headers = cliHeaders_(sheet);
  const changed = [];
  Object.keys(next).forEach(k => {
    const before = cliStr_(c[k]);
    if (before === next[k]) return;
    const col = headers.indexOf(k) + 1;
    if (col <= 0) return;
    setCustomerCell(sheet, c._rowIndex, col, k, next[k]);
    logAudit('cli_update', 'Customer', id, k, before, next[k]);
    changed.push(k);
  });
  if (!changed.length) return jsonResponse({ result: 'unchanged', customer_id: id });
  return jsonResponse({ result: 'updated', customer_id: id, changed: changed });
}

// ─── POST cli_delete ───────────────────────────────────────────────────────
// Refuses while ANY Orders row (any channel, including Nota) carries this Customer ID,
// or while the customer is the kept side of an active merge (that would break its undo).
// Saves the whole row to "Deleted Customers" + the audit log, then deletes the row.
function cliDeletedSheet_(create) {
  const ss = openSheetCached(CUSTOMERS_SHEET_ID);
  let sh = ss.getSheetByName('Deleted Customers');
  if (!sh && create) {
    sh = ss.insertSheet('Deleted Customers');
    sh.getRange(1, 1, 1, CLI_DELETED_HEADERS.length).setValues([CLI_DELETED_HEADERS]);
    sh.setFrozenRows(1);
    sh.getRange(1, 1, sh.getMaxRows(), 2).setNumberFormat('@');
  }
  return sh;
}

function cliOrderCountFor_(id) {
  const sh = getOrdersSheet();
  if (sh.getLastRow() < 2) return 0;
  const h = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  const iC = h.indexOf('Customer ID');
  if (iC < 0) throw new Error('La hoja de pedidos no tiene la columna Customer ID: no se puede comprobar si el cliente tiene pedidos.');
  return readColumn(sh, iC).filter(v => cliStr_(v) === id).length;
}

function cliDeleteAction_(body, identity) {
  const id = cliStr_(body.customer_id);
  if (!id) return cliErr_('Falta el ID del cliente.');
  const sheet = getCustomersSheet();
  const c = cliCustomerRow_(sheet, id);
  if (!c) return cliErr_('Cliente no encontrado: ' + id);
  if (cliIsMerged_(c)) return cliErr_('Este cliente ya fue fusionado. Límpialo desde la pestaña Fusiones.');

  const n = cliOrderCountFor_(id);
  if (n > 0) {
    return cliErr_('No se puede eliminar a ' + cliDisplayName_(c) + ': tiene ' + n + ' pedido' + (n === 1 ? '' : 's') +
      ' vinculado' + (n === 1 ? '' : 's') + '. Fusiónalo con otro cliente para conservar su historial.');
  }
  const activeMerge = cliMergesFor_(id).filter(m => m.kept_id === id && m.status === 'Activo');
  if (activeMerge.length) {
    return cliErr_('No se puede eliminar: es el cliente principal de ' + activeMerge.length + ' fusión' + (activeMerge.length === 1 ? '' : 'es') +
      ' activa' + (activeMerge.length === 1 ? '' : 's') + '. Deshaz o limpia esas fusiones primero.');
  }

  const snapshot = {};
  Object.keys(c).forEach(k => { if (k !== '_rowIndex') snapshot[k] = cliIso_(c[k]); });
  const delSheet = cliDeletedSheet_(true);
  const delId = 'DEL-' + Utilities.formatDate(new Date(), 'America/Mexico_City', 'yyMMdd-HHmmss') + '-' + id.replace('CUST-', '');
  delSheet.getRange(delSheet.getLastRow() + 1, 1, 1, CLI_DELETED_HEADERS.length).setValues([[
    delId, id, cliStr_(c['Primary Username']), identity ? identity.name : '', nowISO(), 'Eliminado', '', JSON.stringify(snapshot),
  ]]);
  logAuditEvent('cli_delete', 'Customer', id, { deleted_id: delId, deleted_row: snapshot });
  sheet.deleteRow(c._rowIndex);
  return jsonResponse({ result: 'deleted', customer_id: id, deleted_id: delId, username: cliStr_(c['Primary Username']) });
}

// ─── GET cli_deleted (admin) / POST cli_restore ────────────────────────────
function cliDeletedListAction_() {
  const sh = cliDeletedSheet_(false);
  if (!sh) return jsonResponse({ records: [] });
  const records = sheetToObjects(sh).map(r => ({
    deleted_id: cliStr_(r['Deleted ID']), customer_id: cliStr_(r['Customer ID']), username: cliStr_(r['Username']),
    deleted_by: cliStr_(r['Deleted By']), deleted_at: cliIso_(r['Deleted At']), status: cliStr_(r['Status']),
    restored_at: cliIso_(r['Restored At']),
  })).sort((a, b) => String(b.deleted_at).localeCompare(String(a.deleted_at)));
  return jsonResponse({ records: records });
}

function cliRestoreAction_(body, identity) {
  const delId = cliStr_(body.deleted_id);
  const sh = cliDeletedSheet_(false);
  if (!sh) return cliErr_('Todavía no se ha eliminado ningún cliente.');
  const rec = sheetToObjects(sh).find(r => cliStr_(r['Deleted ID']) === delId);
  if (!rec) return cliErr_('No se encontró el registro eliminado: ' + delId);
  if (cliStr_(rec['Status']) !== 'Eliminado') return cliErr_('Este cliente ya fue restaurado.');

  let snapshot;
  try { snapshot = JSON.parse(String(rec['Snapshot'] || '')); } catch (err) { return cliErr_('La copia guardada está dañada y no se puede restaurar.'); }
  const id = cliStr_(snapshot['Customer ID']);
  const sheet = getCustomersSheet();
  if (!id) return cliErr_('La copia guardada no tiene Customer ID.');
  if (cliCustomerRow_(sheet, id)) return cliErr_('Ya existe un cliente con el ID ' + id + '; no se puede restaurar encima.');

  if (snapshot['Tags']) cliEnsureColumn_(sheet, 'Tags');
  appendCustomerRowByHeader(sheet, snapshot);
  const h = cliHeaders_(sh);
  sh.getRange(rec._rowIndex, h.indexOf('Status') + 1).setValue('Restaurado');
  sh.getRange(rec._rowIndex, h.indexOf('Restored At') + 1).setValue(nowISO());
  logAuditEvent('cli_restore', 'Customer', id, { deleted_id: delId, restored_by: identity ? identity.name : '' });
  return jsonResponse({ result: 'restored', customer_id: id, username: cliStr_(snapshot['Primary Username']) });
}

// ─── POST cli_recalc ───────────────────────────────────────────────────────
// Same two rules as reconcileCustomerAggregates, for one customer.
function cliRecalcAction_(body) {
  const id = cliStr_(body.customer_id);
  if (!id) return cliErr_('Falta el ID del cliente.');
  const sheet = getCustomersSheet();
  const c = cliCustomerRow_(sheet, id);
  if (!c) return cliErr_('Cliente no encontrado: ' + id);

  const beforeCount = Number(c['Shipment Count']) || 0;
  recalculateShipmentCountsFor([id]);

  const o = cliReadOrders_();
  const iC = o.h.indexOf('Customer ID'), iOD = o.h.indexOf('Order Date'), iCD = o.h.indexOf('Created Date');
  let firstMs = NaN;
  if (iC >= 0) {
    o.rows.forEach(r => {
      if (cliStr_(r[iC]) !== id) return;
      const raw = (iOD >= 0 && r[iOD]) ? r[iOD] : (iCD >= 0 ? r[iCD] : '');
      const ms = cliMs_(raw);
      if (!isNaN(ms) && (isNaN(firstMs) || ms < firstMs)) firstMs = ms;
    });
  }
  const headers = cliHeaders_(sheet);
  const iFirst = headers.indexOf('First Order Date');
  const curFirst = cliMs_(c['First Order Date']);
  let firstIso = cliIso_(c['First Order Date']);
  if (iFirst >= 0 && !isNaN(firstMs) && (isNaN(curFirst) || Math.abs(curFirst - firstMs) > 60000)) {
    firstIso = new Date(firstMs).toISOString();
    setCustomerCell(sheet, c._rowIndex, iFirst + 1, 'First Order Date', firstIso);
    logAudit('cli_recalc', 'Customer', id, 'First Order Date', cliIso_(c['First Order Date']), firstIso);
  }
  const fresh = cliCustomerRow_(sheet, id);
  const afterCount = Number(fresh['Shipment Count']) || 0;
  if (afterCount !== beforeCount) logAudit('cli_recalc', 'Customer', id, 'Shipment Count', beforeCount, afterCount);
  return jsonResponse({ result: 'recalculated', customer_id: id, shipment_count: afterCount, first_order_date: firstIso });
}
