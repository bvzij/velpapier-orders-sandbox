// ═══════════════════════════════════════════════════════════════════════════
// FINANZAS — expense tracking (new file: finanzas.gs)
//
// Lives in its own spreadsheet ("Vel Papier - Finanzas", id in Script Property
// FINANZAS_SHEET_ID, created by the admin button Finanzas > Configuración).
// Files (ticket photos, CFDI XML/PDF) live in a PRIVATE Drive folder (id in
// FINANZAS_DRIVE_FOLDER_ID) and are only ever served through fin_get_file,
// which checks permissions on every request.
//
// Related files:  permisos.gs (who may do what) · finanzas-cfdi.gs (facturas)
//                 finanzas-admin.gs (cierre, caja chica, fijos, resumen, IA)
//
// Rules this module follows (see the plan doc):
//   - the server filters, the browser only hides
//   - nothing is ever hard-deleted: rows become 'Anulado' / 'Reemplazada'
//   - writes go by HEADER NAME; ID/date columns are forced to text
//   - every error message carries a "// TROUBLESHOOT:" comment next to it
//   - all names here start with "fin" so they can never shadow apps-script.gs
// ═══════════════════════════════════════════════════════════════════════════

const FIN_VERSION = '2026-10-25.1';

const FIN_TABS = {
  'Gastos': {
    headers: ['Expense ID', 'Captura Status', 'Status', 'Fecha Compra', 'Fecha Pago', 'Periodo', 'Vendor ID', 'Category ID', 'Scope',
      'Descripción', 'Método Pago', 'Cuenta Pago', 'Pagado Por', 'Reembolso Status', 'Reembolso Fecha', 'Moneda', 'Tipo Cambio',
      'Subtotal', 'IVA', 'Otros Impuestos', 'Total', 'Total MXN', 'Folio Ticket', 'Datos Facturación', 'Requiere Factura',
      'Estado Factura', 'Fecha Límite Factura', 'Invoice ID', 'Archivos', 'Recurring ID', 'Deducible', 'Flags', 'Notas',
      'Creado Por', 'Creado En', 'Editado Por', 'Editado En', 'Anulado Por', 'Anulado En', 'Motivo Anulación'],
    num: ['Tipo Cambio', 'Subtotal', 'IVA', 'Otros Impuestos', 'Total', 'Total MXN'],
  },
  'Gasto Líneas': {
    headers: ['Line ID', 'Expense ID', 'Línea #', 'Vendor ID', 'Código Proveedor', 'Descripción', 'Catalog ID', 'Vínculo', 'Tipo Línea',
      'Cantidad', 'Unidad', 'Piezas por Unidad', 'Costo Unitario', 'Descuento Línea', 'Total Línea', 'Status', 'Creado Por', 'Creado En', 'Condición'],
    num: ['Línea #', 'Cantidad', 'Piezas por Unidad', 'Costo Unitario', 'Descuento Línea', 'Total Línea'],
  },
  'Facturas': {
    headers: ['Invoice ID', 'UUID', 'Status', 'Scope', 'RFC Emisor', 'Nombre Emisor', 'Vendor ID', 'RFC Receptor', 'Uso CFDI', 'Fecha Emisión',
      'Serie', 'Folio', 'Subtotal', 'Descuento', 'IVA Trasladado', 'Retenciones', 'Total', 'Moneda', 'Forma Pago', 'Método Pago',
      'Archivo XML', 'Archivo PDF', 'Expense IDs', 'Match Status', 'Flags', 'Creado Por', 'Creado En'],
    num: ['Subtotal', 'Descuento', 'IVA Trasladado', 'Retenciones', 'Total'],
  },
  'Factura Conceptos': {
    headers: ['Concepto ID', 'Invoice ID', 'Clave ProdServ', 'No Identificación', 'Descripción', 'Cantidad', 'Clave Unidad', 'Valor Unitario', 'Importe', 'Descuento'],
    num: ['Cantidad', 'Valor Unitario', 'Importe', 'Descuento'],
  },
  'Proveedores': {
    headers: ['Vendor ID', 'Nombre', 'Alias', 'RFC', 'Status', 'Default Category ID', 'Portal Facturación URL', 'Regla Plazo Factura',
      'Días Plazo', 'Requiere Factura Default', 'Contacto', 'Teléfono', 'Notas', 'Creado Por', 'Creado En', 'Método Pago Default', 'Cuenta Pago Default', 'Porcentaje Factura'],
    num: ['Días Plazo'],
  },
  'Categorías': {
    headers: ['Category ID', 'Nombre', 'Parent ID', 'Scope', 'Tipo Contable', 'Deducible Default', 'Activa', 'Orden'],
    num: ['Orden'],
  },
  'Mapa Proveedor-Producto': {
    headers: ['Map ID', 'Vendor ID', 'Código Proveedor', 'Descripción Normalizada', 'Catalog ID', 'Piezas por Unidad', 'Último Costo Unitario',
      'Última Fecha', 'Veces Usado', 'Confirmado Por', 'Status'],
    num: ['Piezas por Unidad', 'Último Costo Unitario', 'Veces Usado'],
  },
  'Gastos Fijos': {
    headers: ['Recurring ID', 'Nombre', 'Vendor ID', 'Category ID', 'Monto Estimado', 'Moneda', 'Frecuencia', 'Día', 'Método Pago',
      'Cuenta Pago', 'Requiere Factura', 'Activo', 'Desde', 'Hasta', 'Último Generado', 'Notas'],
    num: ['Monto Estimado', 'Día'],
  },
  'Caja Chica': {
    headers: ['Movimiento ID', 'Fecha', 'Responsable', 'Tipo', 'Monto', 'Notas', 'Creado Por', 'Creado En'],
    num: ['Monto'],
  },
  'Cierres': {
    headers: ['Periodo', 'Estado', 'Cerrado Por', 'Cerrado En', 'Notas'],
    num: [],
  },
  'Archivos': {
    headers: ['File ID', 'Nombre', 'Mime', 'Kind', 'Expense ID', 'Invoice ID', 'Scope', 'Subido Por', 'Subido En', 'Bytes'],
    num: ['Bytes'],
  },
  'Config': {
    headers: ['Clave', 'Valor'],
    num: [],
  },
  'AI Log': {
    headers: ['Fecha', 'Persona', 'File ID', 'Modelo', 'Tokens In', 'Tokens Out', 'Costo USD', 'Resultado'],
    num: ['Tokens In', 'Tokens Out', 'Costo USD'],
  },
  // Created now so the structure is ready; no screen uses these two yet.
  'Nómina': {
    headers: ['Payroll ID', 'Periodo', 'Empleado', 'Concepto', 'Monto Bruto', 'Deducciones', 'Monto Neto', 'Fecha Pago', 'Expense ID'],
    num: ['Monto Bruto', 'Deducciones', 'Monto Neto'],
  },
  'Movimientos Inventario': {
    headers: ['Movement ID', 'Fecha', 'Catalog ID', 'Cantidad', 'Tipo', 'Referencia', 'Costo Unitario', 'Creado Por', 'Creado En'],
    num: ['Cantidad', 'Costo Unitario'],
  },
};

const FIN_METODOS = ['Efectivo', 'Tarjeta débito', 'Tarjeta crédito', 'Transferencia', 'Caja chica', 'Otro'];
const FIN_ESTADOS_FACTURA = ['No requiere', 'Pendiente', 'Solicitada', 'Recibida', 'Perdida'];
const FIN_CAPTURA = ['Por capturar', 'Capturado', 'Revisado', 'Por pagar'];
const FIN_TIPOS_LINEA = ['Inventario', 'Insumo', 'Gasto'];
const FIN_UNIDADES = ['pz', 'caja', 'paquete', 'kg', 'm'];
const FIN_FILE_MIMES = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf', 'text/xml', 'application/xml'];
const FIN_MAX_FILE_BYTES = 12 * 1024 * 1024;
const FIN_SCOPE_RANK = { operativo: 0, fijo: 1, nomina: 2, confidencial: 3 };

const FIN_CONFIG_DEFAULTS = {
  razon_social: '', rfc: '', regimen_fiscal: '', codigo_postal: '', uso_cfdi: 'G03', email_factura: '',
  cash_limit: '2000', invoice_alert_days: '3', ai_monthly_cap_usd: '5',
};

// [name, scope, tipo contable, deducible default]
const FIN_SEED_CATEGORIES = [
  ['Mercancía para venta', 'operativo', 'COGS', 'Sí'],
  ['Empaque e insumos de envío', 'operativo', 'Envíos', 'Sí'],
  ['Guías y paquetería', 'operativo', 'Envíos', 'Sí'],
  ['Papelería y oficina', 'operativo', 'Operativo', 'Sí'],
  ['Limpieza y mantenimiento', 'operativo', 'Operativo', 'Sí'],
  ['Transporte y gasolina', 'operativo', 'Operativo', 'Sí'],
  ['Comida y viáticos', 'operativo', 'Operativo', 'Revisar'],
  ['Giveaways y muestras', 'operativo', 'Marketing', 'Sí'],
  ['Publicidad (TikTok ads, etc.)', 'fijo', 'Marketing', 'Sí'],
  ['Software y suscripciones', 'fijo', 'Software', 'Sí'],
  ['Renta', 'fijo', 'Renta', 'Sí'],
  ['Luz, agua, internet, teléfono', 'fijo', 'Servicios', 'Sí'],
  ['Contador y honorarios', 'fijo', 'Honorarios', 'Sí'],
  ['Sueldos y bonos', 'nomina', 'Nómina', 'Sí'],
  ['IMSS y aguinaldo', 'nomina', 'Nómina', 'Sí'],
  ['Comisiones de plataformas', 'confidencial', 'Comisiones', 'Sí'],
  ['Impuestos', 'confidencial', 'Impuestos', 'No'],
  ['Préstamos e intereses', 'confidencial', 'Financiero', 'Revisar'],
  ['Retiros de socios', 'confidencial', 'Retiro socio', 'No'],
];

// ─── Small helpers ─────────────────────────────────────────────────────────

function finToday_() { return Utilities.formatDate(new Date(), MX_TZ, 'yyyy-MM-dd'); }
function finNow_() { return Utilities.formatDate(new Date(), MX_TZ, 'yyyy-MM-dd HH:mm'); }
function finIsDate_(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(s || ''))) return false;
  const d = new Date(s + 'T12:00:00Z');
  return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}
function finAddDays_(dateStr, n) {
  const d = new Date(dateStr + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function finEndOfMonth_(dateStr) {
  const y = Number(dateStr.slice(0, 4)), m = Number(dateStr.slice(5, 7));
  const d = new Date(Date.UTC(y, m, 0, 12));
  return d.toISOString().slice(0, 10);
}
function finDaysBetween_(a, b) {   // b - a, whole days
  return Math.round((new Date(b + 'T12:00:00Z') - new Date(a + 'T12:00:00Z')) / 86400000);
}
function finNum_(v) {
  if (v === null || v === undefined || v === '') return 0;
  const n = Number(String(v).replace(/[$,\s]/g, ''));
  return isNaN(n) ? 0 : n;
}
function finR2_(n) { return Math.round((Number(n) + Number.EPSILON) * 100) / 100; }
function finStr_(v) { return v === null || v === undefined ? '' : String(v).trim(); }
function finNorm_(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
}
function finErr_(msg) { return jsonResponse({ error: msg }); }   // TROUBLESHOOT: the message is shown to the user as-is; the code that returned it is the caller, search for the message text
function finDenied_() { return jsonResponse({ error: 'unauthorized' }); }   // TROUBLESHOOT: the person lacks the capability; check Finanzas > Configuración > Permisos or permisos.gs

// ─── Spreadsheet access ────────────────────────────────────────────────────

function finSsId_() { return PropertiesService.getScriptProperties().getProperty('FINANZAS_SHEET_ID') || ''; }
function finIsSetup_() { return !!finSsId_(); }

function finSheet_(name) {
  const id = finSsId_();
  if (!id) throw new Error('Finanzas todavía no está configurado. Un admin debe crear la hoja en Finanzas > Configuración.');   // TROUBLESHOOT: Script Property FINANZAS_SHEET_ID is empty; press "Crear hoja de Finanzas" once
  const sh = openSheetCached(id).getSheetByName(name);
  if (!sh) throw new Error('Falta la pestaña de Finanzas: ' + name + '. Un admin debe usar Configuración > Reparar estructura.');   // TROUBLESHOOT: someone renamed/deleted a tab; press "Reparar estructura" (recreates it empty)
  return sh;
}

function finRead_(name) {
  const sh = finSheet_(name);
  const last = sh.getLastRow(), lc = sh.getLastColumn();
  if (last < 1 || lc < 1) return { headers: [], rows: [] };
  const data = sh.getRange(1, 1, last, lc).getValues();
  const headers = data[0].map(String);
  const rows = [];
  for (let i = 1; i < data.length; i++) {
    const r = data[i];
    if (r.every(v => v === '' || v === null)) continue;
    const o = { _row: i + 1 };
    headers.forEach((h, j) => {
      let v = r[j];
      if (v instanceof Date) v = Utilities.formatDate(v, MX_TZ, 'yyyy-MM-dd');
      o[h] = v;
    });
    rows.push(o);
  }
  return { headers: headers, rows: rows };
}

function finHeaders_(sh) {
  return sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(String);
}

function finAppend_(name, objs) {
  if (!objs || !objs.length) return;
  const sh = finSheet_(name);
  const headers = finHeaders_(sh);
  const start = Math.max(sh.getLastRow(), 1) + 1;
  const need = start + objs.length - 1 - sh.getMaxRows();
  if (need > 0) {   // tab is full: add rows, and re-apply the text format so dates/IDs in the new rows are never auto-converted
    const from = sh.getMaxRows() + 1;
    sh.insertRowsAfter(sh.getMaxRows(), need + 200);
    const numCols = (FIN_TABS[name] || { num: [] }).num;
    headers.forEach((h, j) => { if (numCols.indexOf(h) < 0) sh.getRange(from, j + 1, sh.getMaxRows() - from + 1, 1).setNumberFormat('@'); });
  }
  const vals = objs.map(o => headers.map(h => (o[h] === undefined || o[h] === null) ? '' : o[h]));
  sh.getRange(start, 1, vals.length, headers.length).setValues(vals);
}

function finUpdate_(name, rowNum, patch) {
  const sh = finSheet_(name);
  const headers = finHeaders_(sh);
  const cur = sh.getRange(rowNum, 1, 1, headers.length).getValues()[0];
  headers.forEach((h, j) => { if (h in patch) cur[j] = (patch[h] === null || patch[h] === undefined) ? '' : patch[h]; });
  sh.getRange(rowNum, 1, 1, headers.length).setValues([cur]);
}

function finNextId_(prefix, width) {
  const props = PropertiesService.getScriptProperties();
  const key = 'FIN_SEQ_' + prefix;
  const n = Number(props.getProperty(key) || 0) + 1;
  props.setProperty(key, String(n));
  return prefix + '-' + String(n).padStart(width, '0');
}

// A brand-new Google sheet only has 26 columns; writing past that throws.
function finEnsureCols_(sh, n) {
  const have = sh.getMaxColumns();
  if (have < n) sh.insertColumnsAfter(have, n - have);
}

// Writes the tabs/headers, forces text format on every non-numeric column.
function finEnsureTabs_(ss) {
  Object.keys(FIN_TABS).forEach(name => {
    const def = FIN_TABS[name];
    let sh = ss.getSheetByName(name);
    if (!sh) {
      sh = ss.insertSheet(name);
      finEnsureCols_(sh, def.headers.length);
      sh.getRange(1, 1, 1, def.headers.length).setValues([def.headers]);
      sh.setFrozenRows(1);
    } else {
      let have = sh.getLastColumn() ? sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(String) : [];
      def.headers.forEach(h => {
        if (have.indexOf(h) < 0) { finEnsureCols_(sh, have.length + 1); sh.getRange(1, have.length + 1).setValue(h); have.push(h); }
      });
    }
    const hdr = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(String);
    let j = 0;
    while (j < hdr.length) {   // one formatting call per run of consecutive text columns (a call per column made setup take minutes)
      if (def.num.indexOf(hdr[j]) >= 0) { j++; continue; }
      let k = j;
      while (k + 1 < hdr.length && def.num.indexOf(hdr[k + 1]) < 0) k++;
      sh.getRange(1, j + 1, sh.getMaxRows(), k - j + 1).setNumberFormat('@');
      j = k + 1;
    }
  });
  // The brand-new spreadsheet starts with an empty default tab; remove it.
  ss.getSheets().forEach(sh => {
    if (!FIN_TABS[sh.getName()] && sh.getLastRow() <= 1 && ss.getSheets().length > 1) { try { ss.deleteSheet(sh); } catch (e) { /* last sheet cannot be deleted */ } }
  });
}

function finRootFolder_() {
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty('FINANZAS_DRIVE_FOLDER_ID');
  if (id) { try { return DriveApp.getFolderById(id); } catch (e) { /* deleted: make a new one */ } }
  const f = DriveApp.createFolder('Vel Papier — Finanzas (archivos privados)');
  props.setProperty('FINANZAS_DRIVE_FOLDER_ID', f.getId());
  return f;
}

function finMonthFolder_(periodo) {
  const root = finRootFolder_();
  const it = root.getFoldersByName(periodo);
  if (it.hasNext()) return it.next();
  return root.createFolder(periodo);
}

// ─── Setup ─────────────────────────────────────────────────────────────────

function finSetupAction(body, identity) {
  if (!identity || identity.role !== 'admin' || identity.service) return finDenied_();
  const props = PropertiesService.getScriptProperties();
  let ss = null, created = false;
  const existing = props.getProperty('FINANZAS_SHEET_ID');
  if (existing) { try { ss = SpreadsheetApp.openById(existing); } catch (e) { ss = null; } }   // TROUBLESHOOT: if this keeps failing the spreadsheet was deleted or access was lost; remove FINANZAS_SHEET_ID in Script Properties and press setup again (a new empty sheet is created)
  if (!ss) {
    ss = SpreadsheetApp.create('Vel Papier - Finanzas');
    props.setProperty('FINANZAS_SHEET_ID', ss.getId());
    created = true;
  }
  _ssCache[ss.getId()] = ss;
  finEnsureTabs_(ss);
  const cats = finRead_('Categorías');
  if (!cats.rows.length) {
    finAppend_('Categorías', FIN_SEED_CATEGORIES.map((c, i) => ({
      'Category ID': finNextId_('CAT', 3), 'Nombre': c[0], 'Parent ID': '', 'Scope': c[1], 'Tipo Contable': c[2],
      'Deducible Default': c[3], 'Activa': 'Sí', 'Orden': i + 1,
    })));
  }
  const cfg = finRead_('Config');
  const haveKeys = cfg.rows.map(r => String(r['Clave']));
  finAppend_('Config', Object.keys(FIN_CONFIG_DEFAULTS).filter(k => haveKeys.indexOf(k) < 0).map(k => ({ 'Clave': k, 'Valor': FIN_CONFIG_DEFAULTS[k] })));
  const folder = finRootFolder_();
  const trig = finInstallTriggers_();
  logAuditEvent('fin_setup', 'Finanzas', ss.getId(), { created: created, trigger: trig });
  return jsonResponse({ result: 'ok', created: created, sheet_url: ss.getUrl(), folder_url: folder.getUrl(), trigger: trig });
}

// Editor shortcut: run once from the Apps Script function dropdown if the
// button in the dashboard is not available yet.
function finSetupFromEditor() {
  const r = finSetupAction({}, { name: 'EDITOR', role: 'admin' });
  Logger.log(r.getContent());
}

// ─── Config (our fiscal data etc.) ─────────────────────────────────────────

function finConfig_() {
  const out = Object.assign({}, FIN_CONFIG_DEFAULTS);
  if (!finIsSetup_()) return out;
  finRead_('Config').rows.forEach(r => { const k = String(r['Clave']); if (k) out[k] = String(r['Valor'] === undefined ? '' : r['Valor']); });
  return out;
}

function finConfigSaveAction(body, identity) {
  if (!identity || identity.role !== 'admin') return finDenied_();
  const incoming = body.config || {};
  const tab = finRead_('Config');
  const byKey = {};
  tab.rows.forEach(r => { byKey[String(r['Clave'])] = r; });
  const add = [];
  Object.keys(FIN_CONFIG_DEFAULTS).forEach(k => {
    if (!(k in incoming)) return;
    const val = finStr_(incoming[k]);
    if (byKey[k]) finUpdate_('Config', byKey[k]._row, { 'Valor': val });
    else add.push({ 'Clave': k, 'Valor': val });
  });
  finAppend_('Config', add);
  logAuditEvent('fin_config_save', 'Finanzas', 'Config', { keys: Object.keys(incoming) });
  return jsonResponse({ result: 'ok', config: finConfig_() });
}

// ─── Visibility (the heart of "the server filters") ────────────────────────

function finScopeOfRow_(r) { return String(r['Scope'] || 'operativo'); }

function finScopesAllowed_(caps) { return caps['finance.scopes'] || []; }

function finCanSeeExpense_(r, identity, caps) {
  if (caps._admin) return true;
  if (finScopesAllowed_(caps).indexOf(finScopeOfRow_(r)) < 0) return false;
  if (!caps['finance.view_all_entries'] && String(r['Creado Por']).toUpperCase() !== personKey_(identity)) return false;
  const days = Number(caps['finance.history_days'] || 0);
  if (days > 0) {
    const cutoff = finAddDays_(finToday_(), -days);
    const d = String(r['Fecha Compra'] || String(r['Creado En'] || '').slice(0, 10)).slice(0, 10);
    if (d && d < cutoff) return false;
  }
  return true;
}

function finCanSeeScope_(scope, caps) {
  return !!caps._admin || finScopesAllowed_(caps).indexOf(scope || 'operativo') >= 0;
}

// Public shape of an expense row: no sheet row number, plus computed fields.
function finExpenseOut_(r, cfg) {
  const o = {};
  Object.keys(r).forEach(k => { if (k !== '_row') o[k] = r[k]; });
  o['Archivos'] = finStr_(r['Archivos']);
  o.files = o['Archivos'] ? o['Archivos'].split('|').filter(Boolean) : [];
  // Invoice deadline status is computed live so it is always right.
  o.invoice_days_left = null;
  const needs = r['Requiere Factura'] === 'Sí' && ['Pendiente', 'Solicitada'].indexOf(r['Estado Factura']) >= 0 && r['Status'] === 'Activo';
  if (needs && finIsDate_(r['Fecha Límite Factura'])) {
    o.invoice_days_left = finDaysBetween_(finToday_(), r['Fecha Límite Factura']);
  }
  o.invoice_overdue = needs && o.invoice_days_left !== null && o.invoice_days_left < 0;
  return o;
}

// ─── Catalog of vendors / categories (what the browser needs to start) ─────

function finVendorOut_(v) {
  const o = {};
  Object.keys(v).forEach(k => { if (k !== '_row') o[k] = v[k]; });
  return o;
}

function finVendorsFor_(identity, caps) {
  const all = finRead_('Proveedores').rows;
  const me = personKey_(identity);
  return all.filter(v => {
    if (caps._admin || caps['finance.vendors_edit']) return true;
    if (v['Status'] === 'Activo') return true;
    return v['Status'] === 'Pendiente revisión' && String(v['Creado Por']).toUpperCase() === me;
  }).map(finVendorOut_);
}

function finCategoriesFor_(caps) {
  return finRead_('Categorías').rows.filter(c => {
    if (caps._admin || caps['finance.categories_edit']) return true;
    return c['Activa'] === 'Sí' && finCanSeeScope_(c['Scope'], caps);
  }).map(c => { const o = Object.assign({}, c); delete o._row; return o; })
    .sort((a, b) => Number(a['Orden'] || 0) - Number(b['Orden'] || 0));
}

function finClosedPeriods_() {
  const state = {};
  finRead_('Cierres').rows.forEach(r => { state[String(r['Periodo'])] = r['Estado']; });   // later rows win: the tab is an append-only log
  return Object.keys(state).filter(p => state[p] === 'Cerrado').sort();
}

function finIsClosed_(periodo) { return finClosedPeriods_().indexOf(periodo) >= 0; }

function finBootstrapGet_(params, identity) {
  const caps = resolveCaps(identity);
  if (!caps['finance.view']) return finDenied_();
  if (!finIsSetup_()) {
    return jsonResponse({ ok: true, setup: false, can_setup: !!caps._admin, caps: capsForClient(identity), version: FIN_VERSION });
  }
  const cfg = finConfig_();
  const publicCfg = { cash_limit: cfg.cash_limit, invoice_alert_days: cfg.invoice_alert_days };
  if (caps._admin || caps['finance.invoices']) {
    ['razon_social', 'rfc', 'regimen_fiscal', 'codigo_postal', 'uso_cfdi', 'email_factura'].forEach(k => { publicCfg[k] = cfg[k]; });
  }
  if (caps._admin) publicCfg.ai_monthly_cap_usd = cfg.ai_monthly_cap_usd;
  const props = PropertiesService.getScriptProperties();
  return jsonResponse({
    ok: true, setup: true, version: FIN_VERSION,
    me: { name: personKey_(identity), role: identity.role },
    caps: capsForClient(identity),
    today: finToday_(),
    config: publicCfg,
    categories: finCategoriesFor_(caps),
    vendors: finVendorsFor_(identity, caps),
    closed_periods: finClosedPeriods_(),
    enums: { metodos: FIN_METODOS, estados_factura: FIN_ESTADOS_FACTURA, captura: FIN_CAPTURA, tipos_linea: FIN_TIPOS_LINEA, unidades: FIN_UNIDADES, scopes: FIN_SCOPES },
    ai_ready: !!(caps['finance.ai_prefill'] && finAiProvider_()),
  });
}

// ─── Expenses: validation + building ───────────────────────────────────────

function finVendorById_(id) {
  if (!id) return null;
  const v = finRead_('Proveedores').rows.find(r => r['Vendor ID'] === id);
  return v || null;
}

function finCategoryById_(id) {
  if (!id) return null;
  return finRead_('Categorías').rows.find(r => r['Category ID'] === id) || null;
}

// Last day to request the factura, from the vendor's rule.
function finInvoiceDeadline_(fechaCompra, vendor) {
  const rule = vendor ? String(vendor['Regla Plazo Factura'] || 'Mismo mes') : 'Mismo mes';
  if (rule === 'Sin límite') return '';
  if (rule === 'N días') {
    const n = Math.max(0, Math.floor(Number(vendor['Días Plazo']) || 0));
    return n > 0 ? finAddDays_(fechaCompra, n) : finEndOfMonth_(fechaCompra);
  }
  return finEndOfMonth_(fechaCompra);
}

function finNormLines_(lines, vendorId, identity) {
  const out = [];
  (Array.isArray(lines) ? lines : []).forEach((l, i) => {
    const desc = finStr_(l.descripcion), code = finStr_(l.codigo);
    if (!desc && !code) return;
    const qty = Math.max(0, finNum_(l.cantidad)) || 1;
    const cost = Math.max(0, finNum_(l.costo_unitario));
    const disc = Math.max(0, finNum_(l.descuento));
    const tipo = FIN_TIPOS_LINEA.indexOf(l.tipo) >= 0 ? l.tipo : 'Inventario';
    const catalogId = finStr_(l.catalog_id);
    let vinculo = ['Sin vincular', 'Sugerido', 'Confirmado'].indexOf(l.vinculo) >= 0 ? l.vinculo : 'Sin vincular';
    if (!catalogId) vinculo = 'Sin vincular';
    out.push({
      'Línea #': out.length + 1, 'Vendor ID': vendorId || '', 'Código Proveedor': code, 'Descripción': desc,
      'Catalog ID': catalogId, 'Vínculo': vinculo, 'Tipo Línea': tipo, 'Cantidad': qty,
      'Unidad': FIN_UNIDADES.indexOf(l.unidad) >= 0 ? l.unidad : 'pz',
      'Piezas por Unidad': Math.max(0, finNum_(l.piezas_por_unidad)) || 1,
      'Costo Unitario': finR2_(cost), 'Descuento Línea': finR2_(disc), 'Total Línea': finR2_(qty * cost - disc),
      'Condición': l.condicion === 'Dañado' ? 'Dañado' : '',
    });
  });
  return out;
}

function finComputeFlags_(exp, lines, cfg) {
  const flags = [];
  const limit = Number(cfg.cash_limit) || 2000;
  if (exp['Método Pago'] === 'Efectivo' && finNum_(exp['Total MXN']) > limit) flags.push('CASH_OVER_LIMIT');
  if (lines.length) {
    const sum = lines.reduce((s, l) => s + finNum_(l['Total Línea']), 0);
    if (Math.abs(sum - finNum_(exp['Total'])) > 1) flags.push('TOTAL_MISMATCH');
  }
  if (!exp['Vendor ID']) flags.push('SIN_PROVEEDOR');
  if (exp['Moneda'] !== 'MXN' && !(finNum_(exp['Tipo Cambio']) > 0)) flags.push('SIN_TIPO_CAMBIO');
  if (exp['Requiere Factura'] === 'Sí' && ['Pendiente', 'Solicitada'].indexOf(exp['Estado Factura']) >= 0
      && finIsDate_(exp['Fecha Límite Factura']) && exp['Fecha Límite Factura'] < finToday_() && exp['Status'] === 'Activo') flags.push('INVOICE_OVERDUE');
  return flags.join(',');
}

// Possible duplicates among expenses the caller is allowed to see.
function finFindDuplicates_(exp, excludeId, identity, caps) {
  const total = finNum_(exp['Total']);
  const out = [];
  finRead_('Gastos').rows.forEach(r => {
    if (r['Status'] !== 'Activo' || r['Expense ID'] === excludeId) return;
    if (!finCanSeeExpense_(r, identity, caps)) return;
    let why = '';
    const sameVendor = exp['Vendor ID'] && r['Vendor ID'] === exp['Vendor ID'];
    if (sameVendor && finStr_(exp['Folio Ticket']) && finStr_(r['Folio Ticket']) === finStr_(exp['Folio Ticket'])) why = 'mismo folio de ticket';
    else if (sameVendor && total > 0 && Math.abs(finNum_(r['Total']) - total) < 0.005
             && finIsDate_(r['Fecha Compra']) && Math.abs(finDaysBetween_(r['Fecha Compra'], exp['Fecha Compra'])) <= 1) why = 'mismo proveedor, total y fecha';
    if (why) out.push({ id: r['Expense ID'], fecha: r['Fecha Compra'], total: r['Total'], why: why });
  });
  return out;
}

// Turns the browser's expense object into a full Gastos row (not yet saved).
function finBuildExpense_(inp, existing, identity, caps, cfg, vendor, category) {
  const e = existing ? Object.assign({}, existing) : {};
  const me = personKey_(identity);
  const pick = (k, cur) => (inp[k] === undefined ? cur : inp[k]);

  e['Fecha Compra'] = finStr_(pick('fecha_compra', e['Fecha Compra'] || finToday_()));
  e['Fecha Pago'] = finStr_(pick('fecha_pago', e['Fecha Pago'] || e['Fecha Compra']));
  e['Descripción'] = finStr_(pick('descripcion', e['Descripción']));
  e['Método Pago'] = finStr_(pick('metodo_pago', e['Método Pago'] || 'Efectivo'));
  e['Cuenta Pago'] = finStr_(pick('cuenta_pago', e['Cuenta Pago']));
  e['Moneda'] = finStr_(pick('moneda', e['Moneda'] || 'MXN')).toUpperCase() || 'MXN';
  e['Tipo Cambio'] = e['Moneda'] === 'MXN' ? 1 : finNum_(pick('tipo_cambio', e['Tipo Cambio']));
  e['Total'] = finR2_(finNum_(pick('total', e['Total'])));
  e['Subtotal'] = inp.subtotal === undefined ? (e['Subtotal'] === undefined ? '' : e['Subtotal']) : finR2_(finNum_(inp.subtotal));
  e['IVA'] = inp.iva === undefined ? (e['IVA'] === undefined ? '' : e['IVA']) : finR2_(finNum_(inp.iva));
  e['Otros Impuestos'] = inp.otros_impuestos === undefined ? (e['Otros Impuestos'] === undefined ? '' : e['Otros Impuestos']) : finR2_(finNum_(inp.otros_impuestos));
  e['Total MXN'] = finR2_(e['Total'] * (e['Moneda'] === 'MXN' ? 1 : (e['Tipo Cambio'] > 0 ? e['Tipo Cambio'] : 0)));
  e['Folio Ticket'] = finStr_(pick('folio_ticket', e['Folio Ticket']));
  e['Datos Facturación'] = finStr_(pick('datos_facturacion', e['Datos Facturación']));
  const dedIn = pick('deducible', e['Deducible']);
  e['Deducible'] = ['Sí', 'No', 'Revisar'].indexOf(dedIn) >= 0 ? dedIn : ((category && category['Deducible Default']) || 'Revisar');
  e['Notas'] = finStr_(pick('notas', e['Notas']));
  e['Periodo'] = e['Fecha Compra'].slice(0, 7);

  e['Vendor ID'] = vendor ? vendor['Vendor ID'] : '';
  e['Category ID'] = category ? category['Category ID'] : '';
  e['Scope'] = category ? category['Scope'] : (existing && existing['Scope']) || 'operativo';

  // Factura requirements: vendor default, overridable per expense.
  const reqIn = pick('requiere_factura', e['Requiere Factura']);
  if (reqIn === 'Sí' || reqIn === 'No') e['Requiere Factura'] = reqIn;
  else e['Requiere Factura'] = vendor && vendor['Requiere Factura Default'] === 'No' ? 'No' : 'Sí';
  if (e['Estado Factura'] === 'Recibida') { /* a linked factura is never undone by an edit */ }
  else if (e['Requiere Factura'] === 'No') e['Estado Factura'] = 'No requiere';
  else if (!e['Estado Factura'] || e['Estado Factura'] === 'No requiere') e['Estado Factura'] = 'Pendiente';
  e['Fecha Límite Factura'] = e['Requiere Factura'] === 'Sí' && e['Estado Factura'] !== 'Recibida'
    ? finInvoiceDeadline_(e['Fecha Compra'], vendor) : (e['Estado Factura'] === 'Recibida' ? (e['Fecha Límite Factura'] || '') : '');

  // Who paid / reimbursements.
  const own = inp.own_money;
  if (!existing) {
    e['Pagado Por'] = finStr_(pick('pagado_por', me)).toUpperCase() || me;
    e['Reembolso Status'] = own === true ? 'Pendiente' : 'No aplica';
    if (own === true && !e['Cuenta Pago']) e['Cuenta Pago'] = 'Personal ' + me;
  } else if (own === true && e['Reembolso Status'] === 'No aplica') {
    e['Reembolso Status'] = 'Pendiente';
  } else if (own === false && e['Reembolso Status'] === 'Pendiente') {
    e['Reembolso Status'] = 'No aplica';
  }
  return e;
}

function finExpenseValidate_(e, files, status) {
  if (!finIsDate_(e['Fecha Compra'])) return 'La fecha de compra no es válida (usa AAAA-MM-DD).';   // TROUBLESHOOT: the browser sent a malformed fecha_compra
  if (FIN_METODOS.indexOf(e['Método Pago']) < 0) return 'Elige un método de pago válido.';   // TROUBLESHOOT: metodo_pago not in FIN_METODOS
  if (status === 'Capturado' && !(e['Total'] > 0)) return 'Falta el total del ticket.';
  if (status === 'Por capturar' && !files.length) return 'Sube al menos una foto del ticket.';
  if (e['Moneda'] !== 'MXN' && !(e['Tipo Cambio'] > 0)) return 'Falta el tipo de cambio para ' + e['Moneda'] + '.';
  return '';
}

function finLinesOut_(expenseId) {
  return finRead_('Gasto Líneas').rows
    .filter(l => l['Expense ID'] === expenseId && l['Status'] === 'Activo')
    .sort((a, b) => Number(a['Línea #']) - Number(b['Línea #']))
    .map(l => { const o = Object.assign({}, l); delete o._row; return o; });
}

function finWriteLines_(expenseId, vendorId, lines, identity) {
  const now = finNow_(), me = personKey_(identity);
  const rows = lines.map(l => Object.assign({}, l, {
    'Line ID': finNextId_('GSL', 6), 'Expense ID': expenseId, 'Vendor ID': vendorId || '', 'Status': 'Activo', 'Creado Por': me, 'Creado En': now,
  }));
  finAppend_('Gasto Líneas', rows);
  return rows;
}

function finRetireLines_(expenseId, newStatus) {
  const tab = finRead_('Gasto Líneas');
  tab.rows.forEach(l => {
    if (l['Expense ID'] === expenseId && l['Status'] === 'Activo') finUpdate_('Gasto Líneas', l._row, { 'Status': newStatus });
  });
}

// Confirmed vendor-code -> catalog links teach the map (never the other way).
function finLearnFromLines_(vendorId, lines, fecha, identity) {
  if (!vendorId) return;
  lines.forEach(l => {
    if (l['Vínculo'] === 'Confirmado' && l['Catalog ID'] && (l['Código Proveedor'] || l['Descripción'])) {
      finMapUpsert_(vendorId, l['Código Proveedor'], l['Descripción'], l['Catalog ID'], l['Piezas por Unidad'], l['Costo Unitario'], fecha, personKey_(identity));
    }
  });
}

function finLinkFiles_(fileIds, expenseId, scope) {
  if (!fileIds.length) return;
  const tab = finRead_('Archivos');
  tab.rows.forEach(r => {
    if (fileIds.indexOf(String(r['File ID'])) >= 0) finUpdate_('Archivos', r._row, { 'Expense ID': expenseId, 'Scope': scope });
  });
}

// Which of these file ids may the caller attach? (their own uploads, or ones already on a visible expense)
function finAttachableFiles_(ids, identity, caps) {
  const me = personKey_(identity);
  const reg = finRead_('Archivos').rows;
  const ok = [];
  ids.forEach(id => {
    const r = reg.find(x => String(x['File ID']) === id);
    if (!r) return;
    if (caps._admin || String(r['Subido Por']).toUpperCase() === me || (!r['Expense ID'] && finCanSeeScope_(r['Scope'], caps))) ok.push(id);
  });
  return ok;
}

// ─── Expense actions ───────────────────────────────────────────────────────

function finCreateExpenseAction(body, identity) {
  const caps = resolveCaps(identity);
  if (!caps['finance.create']) return finDenied_();
  const inp = body.expense || {};
  const cfg = finConfig_();
  const fileIds = finAttachableFiles_((Array.isArray(inp.archivos) ? inp.archivos : []).map(String), identity, caps);

  let vendor = null;
  if (inp.vendor_id) {
    vendor = finVendorById_(finStr_(inp.vendor_id));
    if (!vendor) return finErr_('Ese proveedor ya no existe. Elige otro.');   // TROUBLESHOOT: vendor_id not found in Proveedores
  }
  let category = null;
  if (inp.category_id) {
    category = finCategoryById_(finStr_(inp.category_id));
    if (!category || category['Activa'] !== 'Sí') return finErr_('Esa categoría no está disponible.');   // TROUBLESHOOT: category missing or inactive
    if (!finCanSeeScope_(category['Scope'], caps)) return finDenied_();
  }

  const e = finBuildExpense_(inp, null, identity, caps, cfg, vendor, category);
  const status = inp.captura_status === 'Por capturar' || !(e['Total'] > 0) ? 'Por capturar' : 'Capturado';
  const bad = finExpenseValidate_(e, fileIds, status);
  if (bad) return finErr_(bad);   // TROUBLESHOOT: bad is the text from finExpenseValidate_; fix the field it names
  if (finIsClosed_(e['Periodo'])) return finErr_('El mes ' + e['Periodo'] + ' está cerrado. Un admin debe reabrirlo.');   // TROUBLESHOOT: period closed in Cierres; admin reopens it in Finanzas > Cierre

  const lines = finNormLines_(inp.lines || body.lines, e['Vendor ID'], identity);
  if (lines.length && !caps._admin && !finCanSeeScope_(e['Scope'], caps)) return finDenied_();

  if (!body.confirm_duplicate && status === 'Capturado') {
    const dups = finFindDuplicates_(e, '', identity, caps);
    if (dups.length) return jsonResponse({ result: 'duplicate_warning', duplicates: dups });
  }

  const me = personKey_(identity), now = finNow_();
  e['Expense ID'] = finNextId_('GST', 6);
  e['Captura Status'] = status;
  e['Status'] = 'Activo';
  e['Archivos'] = fileIds.join('|');
  e['Recurring ID'] = '';
  e['Creado Por'] = me; e['Creado En'] = now;
  e['Flags'] = finComputeFlags_(e, lines, cfg);
  finAppend_('Gastos', [e]);
  const written = lines.length ? finWriteLines_(e['Expense ID'], e['Vendor ID'], lines, identity) : [];
  finLinkFiles_(fileIds, e['Expense ID'], e['Scope']);
  finLearnFromLines_(e['Vendor ID'], written, e['Fecha Compra'], identity);
  logAuditEvent('fin_create_expense', 'Gasto', e['Expense ID'], { total: e['Total MXN'], vendor: e['Vendor ID'], lines: written.length });
  return jsonResponse({ result: 'ok', expense: finExpenseOut_(e, cfg), lines: finLinesOut_(e['Expense ID']) });
}

function finFindExpenseRow_(id) {
  return finRead_('Gastos').rows.find(r => r['Expense ID'] === id) || null;
}

function finUpdateExpenseAction(body, identity) {
  const caps = resolveCaps(identity);
  const cur = finFindExpenseRow_(finStr_(body.expense_id));
  if (!cur) return finErr_('No se encontró ese gasto.');   // TROUBLESHOOT: expense_id not in Gastos (voided rows stay in the tab, so it was never created)
  if (!finCanSeeExpense_(cur, identity, caps)) return finDenied_();
  const isOwn = String(cur['Creado Por']).toUpperCase() === personKey_(identity);
  const mayEdit = caps['finance.edit_any'] || (caps['finance.edit_own'] && isOwn && cur['Captura Status'] !== 'Revisado');
  if (!mayEdit) return finDenied_();
  if (cur['Status'] !== 'Activo') return finErr_('Este gasto está anulado y ya no se puede editar.');   // TROUBLESHOOT: voided rows are final; create a new expense instead
  if (finIsClosed_(cur['Periodo'])) return finErr_('El mes ' + cur['Periodo'] + ' está cerrado. Un admin debe reabrirlo.');   // TROUBLESHOOT: see Cierres tab

  const inp = body.expense || {};
  const cfg = finConfig_();
  let vendor = null;
  const vId = inp.vendor_id === undefined ? cur['Vendor ID'] : finStr_(inp.vendor_id);
  if (vId) { vendor = finVendorById_(vId); if (!vendor) return finErr_('Ese proveedor ya no existe. Elige otro.'); }   // TROUBLESHOOT: the id the browser sent is not in the tab, or the person's scopes hide it; check the id in the Finanzas sheet
  let category = null;
  const cId = inp.category_id === undefined ? cur['Category ID'] : finStr_(inp.category_id);
  if (cId) {
    category = finCategoryById_(cId);
    if (!category) return finErr_('Esa categoría no está disponible.');   // TROUBLESHOOT: the id the browser sent is not in the tab, or the person's scopes hide it; check the id in the Finanzas sheet
    if (!finCanSeeScope_(category['Scope'], caps)) return finDenied_();
  }

  const e = finBuildExpense_(inp, cur, identity, caps, cfg, vendor, category);
  if (finIsClosed_(e['Periodo'])) return finErr_('El mes ' + e['Periodo'] + ' está cerrado. Un admin debe reabrirlo.');   // TROUBLESHOOT: the period is closed in the Cierres tab; an admin reopens it in Finanzas > Cierre
  let fileIds = finStr_(cur['Archivos']).split('|').filter(Boolean);
  if (Array.isArray(inp.archivos)) {
    const want = inp.archivos.map(String);
    const attachable = finAttachableFiles_(want, identity, caps);
    fileIds = want.filter((f, i) => want.indexOf(f) === i && (fileIds.indexOf(f) >= 0 || attachable.indexOf(f) >= 0));   // keep files already on the expense, add only ones the caller may attach
  }

  let status = cur['Captura Status'];
  if (inp.captura_status === 'Revisado' && caps['finance.edit_any']) status = 'Revisado';
  else if (status === 'Por capturar' && e['Total'] > 0) status = 'Capturado';
  else if (status === 'Por pagar' && inp.captura_status === 'Capturado' && caps['finance.edit_any']) status = 'Capturado';
  const bad = finExpenseValidate_(e, fileIds, status);
  if (bad) return finErr_(bad);   // TROUBLESHOOT: bad is the text from finExpenseValidate_; fix the field it names

  const wantsLines = body.lines !== undefined || (inp.lines !== undefined);
  const lines = wantsLines ? finNormLines_(inp.lines || body.lines, e['Vendor ID'], identity) : finLinesOut_(cur['Expense ID']);
  if (!body.confirm_duplicate && status === 'Capturado') {
    const dups = finFindDuplicates_(e, cur['Expense ID'], identity, caps);
    if (dups.length) return jsonResponse({ result: 'duplicate_warning', duplicates: dups });
  }
  e['Captura Status'] = status;
  e['Archivos'] = fileIds.join('|');
  e['Editado Por'] = personKey_(identity); e['Editado En'] = finNow_();
  e['Flags'] = finComputeFlags_(e, lines, cfg);
  finUpdate_('Gastos', cur._row, e);
  let written = [];
  if (wantsLines) {
    finRetireLines_(cur['Expense ID'], 'Reemplazada');
    written = lines.length ? finWriteLines_(cur['Expense ID'], e['Vendor ID'], lines, identity) : [];
    finLearnFromLines_(e['Vendor ID'], written, e['Fecha Compra'], identity);
  }
  finLinkFiles_(fileIds, cur['Expense ID'], e['Scope']);
  logAuditEvent('fin_update_expense', 'Gasto', cur['Expense ID'], { total: e['Total MXN'], before_total: cur['Total MXN'], lines_replaced: wantsLines });
  return jsonResponse({ result: 'ok', expense: finExpenseOut_(Object.assign({}, e, { _row: cur._row }), cfg), lines: finLinesOut_(cur['Expense ID']) });
}

function finVoidExpenseAction(body, identity) {
  const caps = resolveCaps(identity);
  const cur = finFindExpenseRow_(finStr_(body.expense_id));
  if (!cur) return finErr_('No se encontró ese gasto.');   // TROUBLESHOOT: the id the browser sent is not in the tab, or the person's scopes hide it; check the id in the Finanzas sheet
  if (!finCanSeeExpense_(cur, identity, caps)) return finDenied_();
  const isOwnInbox = String(cur['Creado Por']).toUpperCase() === personKey_(identity) && cur['Captura Status'] === 'Por capturar';
  if (!caps['finance.void'] && !isOwnInbox) return finDenied_();
  if (cur['Status'] !== 'Activo') return finErr_('Este gasto ya estaba anulado.');   // TROUBLESHOOT: voided rows are final; create a new expense instead
  if (finIsClosed_(cur['Periodo'])) return finErr_('El mes ' + cur['Periodo'] + ' está cerrado. Un admin debe reabrirlo.');   // TROUBLESHOOT: the period is closed in the Cierres tab; an admin reopens it in Finanzas > Cierre
  const reason = finStr_(body.reason);
  if (!reason) return finErr_('Escribe el motivo de la anulación.');   // TROUBLESHOOT: a required field was empty or malformed; the browser form normally prevents this
  finUpdate_('Gastos', cur._row, { 'Status': 'Anulado', 'Anulado Por': personKey_(identity), 'Anulado En': finNow_(), 'Motivo Anulación': reason });
  finRetireLines_(cur['Expense ID'], 'Anulado');
  if (cur['Invoice ID']) finUnlinkExpenseFromInvoice_(cur['Invoice ID'], cur['Expense ID']);
  logAuditEvent('fin_void_expense', 'Gasto', cur['Expense ID'], { reason: reason, total: cur['Total MXN'] });
  return jsonResponse({ result: 'ok' });
}

// Recurring "Por pagar" rows (and any admin correction): confirm real payment.
function finMarkPaidAction(body, identity) {
  const caps = resolveCaps(identity);
  if (!caps['finance.edit_any']) return finDenied_();
  const cur = finFindExpenseRow_(finStr_(body.expense_id));
  if (!cur || cur['Status'] !== 'Activo') return finErr_('No se encontró ese gasto.');   // TROUBLESHOOT: the id the browser sent is not in the tab, or the person's scopes hide it; check the id in the Finanzas sheet
  if (finIsClosed_(cur['Periodo'])) return finErr_('El mes ' + cur['Periodo'] + ' está cerrado. Un admin debe reabrirlo.');   // TROUBLESHOOT: the period is closed in the Cierres tab; an admin reopens it in Finanzas > Cierre
  const patch = { 'Captura Status': 'Capturado', 'Fecha Pago': finIsDate_(body.fecha_pago) ? body.fecha_pago : finToday_(), 'Editado Por': personKey_(identity), 'Editado En': finNow_() };
  if (body.total !== undefined && finNum_(body.total) > 0) {
    patch['Total'] = finR2_(finNum_(body.total));
    patch['Total MXN'] = finR2_(patch['Total'] * (cur['Moneda'] === 'MXN' ? 1 : finNum_(cur['Tipo Cambio'])));
  }
  finUpdate_('Gastos', cur._row, patch);
  logAuditEvent('fin_mark_paid', 'Gasto', cur['Expense ID'], { total: patch['Total'] || cur['Total'] });
  return jsonResponse({ result: 'ok' });
}

// Karin-safe list: rows are filtered by scope/history/ownership; totals only
// travel when the person has finance.view_totals.
function finListExpensesGet_(p, identity) {
  const caps = resolveCaps(identity);
  if (!caps['finance.view']) return finDenied_();
  const cfg = finConfig_();
  let rows = finRead_('Gastos').rows.filter(r => finCanSeeExpense_(r, identity, caps));
  const status = p.status || 'activo';
  if (status === 'activo') rows = rows.filter(r => r['Status'] === 'Activo');
  else if (status === 'anulado') rows = rows.filter(r => r['Status'] === 'Anulado');
  if (p.periodo && p.periodo !== 'all') rows = rows.filter(r => r['Periodo'] === p.periodo);
  if (p.estado_factura) rows = rows.filter(r => r['Estado Factura'] === p.estado_factura);
  if (p.captura) rows = rows.filter(r => r['Captura Status'] === p.captura);
  if (p.vendor_id) rows = rows.filter(r => r['Vendor ID'] === p.vendor_id);
  if (p.category_id) rows = rows.filter(r => r['Category ID'] === p.category_id);
  if (p.mine === '1') rows = rows.filter(r => String(r['Creado Por']).toUpperCase() === personKey_(identity));
  if (p.q) {
    const q = finNorm_(p.q);
    const vendors = {};
    finRead_('Proveedores').rows.forEach(v => { vendors[v['Vendor ID']] = finNorm_(v['Nombre'] + ' ' + v['Alias']); });
    rows = rows.filter(r => finNorm_([r['Expense ID'], r['Descripción'], r['Folio Ticket'], r['Notas'], vendors[r['Vendor ID']] || ''].join(' ')).indexOf(q) >= 0);
  }
  rows.sort((a, b) => String(b['Fecha Compra']).localeCompare(String(a['Fecha Compra'])) || String(b['Expense ID']).localeCompare(String(a['Expense ID'])));
  const limit = Math.min(Math.max(Number(p.limit) || 300, 1), 1000);
  const total = rows.length;
  const out = rows.slice(0, limit).map(r => finExpenseOut_(r, cfg));
  const res = { rows: out, count: total, truncated: total > limit };
  if (caps['finance.view_totals']) {
    res.totals = { total_mxn: finR2_(rows.filter(r => ['Por capturar'].indexOf(r['Captura Status']) < 0).reduce((s, r) => s + finNum_(r['Total MXN']), 0)) };
  }
  return jsonResponse(res);
}

function finGetExpenseGet_(p, identity) {
  const caps = resolveCaps(identity);
  if (!caps['finance.view']) return finDenied_();
  const r = finFindExpenseRow_(finStr_(p.id));
  if (!r || !finCanSeeExpense_(r, identity, caps)) return finErr_('No se encontró ese gasto.');   // TROUBLESHOOT: the id the browser sent is not in the tab, or the person's scopes hide it; check the id in the Finanzas sheet
  const cfg = finConfig_();
  const files = finRead_('Archivos').rows.filter(f => f['Expense ID'] === r['Expense ID']).map(f => ({ id: f['File ID'], name: f['Nombre'], mime: f['Mime'], kind: f['Kind'] }));
  let invoice = null;
  if (r['Invoice ID']) {
    const inv = finRead_('Facturas').rows.find(i => i['Invoice ID'] === r['Invoice ID']);
    if (inv) invoice = finInvoiceOut_(inv);
  }
  return jsonResponse({ expense: finExpenseOut_(r, cfg), lines: finLinesOut_(r['Expense ID']), files: files, invoice: invoice });
}

// Everything that still needs a factura, soonest deadline first.
function finPendingInvoicesGet_(p, identity) {
  const caps = resolveCaps(identity);
  if (!caps['finance.invoices']) return finDenied_();
  const cfg = finConfig_();
  const rows = finRead_('Gastos').rows
    .filter(r => r['Status'] === 'Activo' && r['Requiere Factura'] === 'Sí' && ['Pendiente', 'Solicitada'].indexOf(r['Estado Factura']) >= 0
      && ['Por capturar'].indexOf(r['Captura Status']) < 0 && finCanSeeExpense_(r, identity, caps))
    .map(r => finExpenseOut_(r, cfg));
  rows.sort((a, b) => {
    const da = a.invoice_days_left === null ? 9999 : a.invoice_days_left;
    const db = b.invoice_days_left === null ? 9999 : b.invoice_days_left;
    return da - db || String(a['Fecha Compra']).localeCompare(String(b['Fecha Compra']));
  });
  const vendors = {};
  finRead_('Proveedores').rows.forEach(v => { vendors[v['Vendor ID']] = { nombre: v['Nombre'], portal: v['Portal Facturación URL'] || '' }; });
  rows.forEach(r => { const v = vendors[r['Vendor ID']]; r.vendor_name = v ? v.nombre : ''; r.vendor_portal = v ? v.portal : ''; });
  return jsonResponse({ rows: rows });
}

function finSetInvoiceStatusAction(body, identity) {
  const caps = resolveCaps(identity);
  if (!caps['finance.invoices']) return finDenied_();
  const cur = finFindExpenseRow_(finStr_(body.expense_id));
  if (!cur || cur['Status'] !== 'Activo' || !finCanSeeExpense_(cur, identity, caps)) return finErr_('No se encontró ese gasto.');   // TROUBLESHOOT: the id the browser sent is not in the tab, or the person's scopes hide it; check the id in the Finanzas sheet
  const st = finStr_(body.estado);
  if (['Pendiente', 'Solicitada', 'Perdida', 'No requiere'].indexOf(st) < 0) return finErr_('Estado de factura no válido.');   // TROUBLESHOOT: 'Recibida' is only set by linking a real factura (fin_link_invoice)
  if (cur['Estado Factura'] === 'Recibida') return finErr_('Este gasto ya tiene factura vinculada. Desvincúlala primero.');   // TROUBLESHOOT: unlink the other factura first (fin_unlink_invoice), then relink
  const patch = { 'Estado Factura': st, 'Editado Por': personKey_(identity), 'Editado En': finNow_() };
  if (st === 'No requiere') { patch['Requiere Factura'] = 'No'; patch['Fecha Límite Factura'] = ''; }
  if (st === 'Pendiente') patch['Requiere Factura'] = 'Sí';
  finUpdate_('Gastos', cur._row, patch);
  const merged = Object.assign({}, cur, patch);
  finUpdate_('Gastos', cur._row, { 'Flags': finComputeFlags_(merged, finLinesOut_(cur['Expense ID']), finConfig_()) });
  logAuditEvent('fin_set_invoice_status', 'Gasto', cur['Expense ID'], { estado: st });
  return jsonResponse({ result: 'ok' });
}

// ─── Files ─────────────────────────────────────────────────────────────────

function finUploadFileAction(body, identity) {
  const caps = resolveCaps(identity);
  const kind = ['ticket', 'xml', 'pdf'].indexOf(body.kind) >= 0 ? body.kind : 'ticket';
  if (kind === 'ticket' ? !caps['finance.create'] : !caps['finance.invoices']) return finDenied_();
  const mime = finStr_(body.mime).toLowerCase();
  if (FIN_FILE_MIMES.indexOf(mime) < 0) return finErr_('Ese tipo de archivo no se puede subir (usa foto, PDF o XML).');   // TROUBLESHOOT: mime not in FIN_FILE_MIMES; HEIC photos must be converted by the browser first
  let bytes;
  try { bytes = Utilities.base64Decode(String(body.data || '')); } catch (e) { return finErr_('El archivo llegó dañado. Intenta de nuevo.'); }   // TROUBLESHOOT: data was not valid base64
  if (!bytes.length) return finErr_('El archivo está vacío.');   // TROUBLESHOOT: the upload body was empty; retry from the browser
  if (bytes.length > FIN_MAX_FILE_BYTES) return finErr_('El archivo es muy grande (máximo 12 MB).');   // TROUBLESHOOT: raise FIN_MAX_FILE_BYTES; Apps Script POST bodies cap around 50 MB
  const periodo = finToday_().slice(0, 7);
  const safe = finStr_(body.name).replace(/[^\w.\- áéíóúñÁÉÍÓÚÑ]/g, '_').slice(0, 80) || (kind + '-' + Date.now());
  const file = finMonthFolder_(periodo).createFile(Utilities.newBlob(bytes, mime, safe));
  const id = file.getId();
  finAppend_('Archivos', [{
    'File ID': id, 'Nombre': safe, 'Mime': mime, 'Kind': kind, 'Expense ID': '', 'Invoice ID': '', 'Scope': 'operativo',
    'Subido Por': personKey_(identity), 'Subido En': finNow_(), 'Bytes': bytes.length,
  }]);
  logAuditEvent('fin_upload_file', 'Archivo', id, { kind: kind, bytes: bytes.length });
  return jsonResponse({ result: 'ok', file_id: id, name: safe, mime: mime, kind: kind });
}

function finMayReadFile_(reg, identity, caps) {
  if (caps._admin) return true;
  if (String(reg['Subido Por']).toUpperCase() === personKey_(identity)) return true;
  if (reg['Expense ID']) {
    const ex = finFindExpenseRow_(reg['Expense ID']);
    return !!ex && finCanSeeExpense_(ex, identity, caps);
  }
  if (reg['Invoice ID']) {
    const inv = finRead_('Facturas').rows.find(i => i['Invoice ID'] === reg['Invoice ID']);
    return !!inv && !!caps['finance.invoices'] && finCanSeeScope_(inv['Scope'], caps);
  }
  return false;
}

function finGetFileGet_(p, identity) {
  const caps = resolveCaps(identity);
  if (!caps['finance.view']) return finDenied_();
  const id = finStr_(p.id);
  const reg = finRead_('Archivos').rows.find(r => String(r['File ID']) === id);
  if (!reg || !finMayReadFile_(reg, identity, caps)) return finErr_('No se encontró ese archivo.');   // TROUBLESHOOT: file not in the Archivos registry, or the caller cannot see its expense/invoice
  let file;
  try { file = DriveApp.getFileById(id); } catch (e) { return finErr_('El archivo ya no está en Drive.'); }   // TROUBLESHOOT: the Drive file was deleted by hand
  let blob = null;
  if (p.size === 'thumb' && String(reg['Mime']).indexOf('image/') === 0) { try { blob = file.getThumbnail(); } catch (e) { blob = null; } }
  if (!blob) blob = file.getBlob();
  return jsonResponse({ id: id, name: reg['Nombre'], mime: blob.getContentType() || reg['Mime'], data: Utilities.base64Encode(blob.getBytes()) });
}

// ─── Vendors & categories ──────────────────────────────────────────────────

function finCreateVendorAction(body, identity) {
  const caps = resolveCaps(identity);
  if (!caps['finance.vendors_create'] && !caps['finance.vendors_edit']) return finDenied_();
  const v = body.vendor || {};
  const name = finStr_(v.nombre);
  if (!name) return finErr_('Escribe el nombre del proveedor.');   // TROUBLESHOOT: a required field was empty or malformed; the browser form normally prevents this
  const key = finNorm_(name);
  const all = finRead_('Proveedores').rows;
  const dup = all.find(x => finNorm_(x['Nombre']) === key || finNorm_(x['Alias']).split(' | ').indexOf(key) >= 0);
  if (dup) return jsonResponse({ result: 'exists', vendor: finVendorOut_(dup) });
  const rule = ['Mismo mes', 'N días', 'Sin límite'].indexOf(v.regla_plazo) >= 0 ? v.regla_plazo : 'Mismo mes';
  const row = {
    'Vendor ID': finNextId_('PRV', 4), 'Nombre': name, 'Alias': finStr_(v.alias), 'RFC': finStr_(v.rfc).toUpperCase(),
    'Status': caps['finance.vendors_edit'] ? 'Activo' : 'Pendiente revisión',
    'Default Category ID': finStr_(v.default_category_id), 'Portal Facturación URL': finStr_(v.portal),
    'Regla Plazo Factura': rule, 'Días Plazo': Math.max(0, Math.floor(finNum_(v.dias_plazo))),
    'Requiere Factura Default': v.requiere_default === 'No' ? 'No' : 'Sí', 'Contacto': finStr_(v.contacto),
    'Método Pago Default': FIN_METODOS.indexOf(v.metodo_default) >= 0 ? v.metodo_default : '',
    'Cuenta Pago Default': finStr_(v.cuenta_default),
    'Porcentaje Factura': finStr_(v.porcentaje_factura) === '' ? '' : Math.min(100, Math.max(0, finNum_(v.porcentaje_factura))),
    'Teléfono': finStr_(v.telefono), 'Notas': finStr_(v.notas), 'Creado Por': personKey_(identity), 'Creado En': finNow_(),
  };
  finAppend_('Proveedores', [row]);
  logAuditEvent('fin_create_vendor', 'Proveedor', row['Vendor ID'], { nombre: name });
  return jsonResponse({ result: 'ok', vendor: finVendorOut_(row) });
}

function finUpdateVendorAction(body, identity) {
  const caps = resolveCaps(identity);
  if (!caps['finance.vendors_edit']) return finDenied_();
  const cur = finVendorById_(finStr_(body.vendor_id));
  if (!cur) return finErr_('No se encontró ese proveedor.');   // TROUBLESHOOT: the id the browser sent is not in the tab, or the person's scopes hide it; check the id in the Finanzas sheet
  const v = body.vendor || {};
  const patch = {};
  const map = { nombre: 'Nombre', alias: 'Alias', rfc: 'RFC', default_category_id: 'Default Category ID', portal: 'Portal Facturación URL',
    contacto: 'Contacto', telefono: 'Teléfono', notas: 'Notas' };
  Object.keys(map).forEach(k => { if (v[k] !== undefined) patch[map[k]] = k === 'rfc' ? finStr_(v[k]).toUpperCase() : finStr_(v[k]); });
  if (v.status !== undefined && ['Activo', 'Pendiente revisión', 'Inactivo'].indexOf(v.status) >= 0) patch['Status'] = v.status;
  if (v.regla_plazo !== undefined && ['Mismo mes', 'N días', 'Sin límite'].indexOf(v.regla_plazo) >= 0) patch['Regla Plazo Factura'] = v.regla_plazo;
  if (v.dias_plazo !== undefined) patch['Días Plazo'] = Math.max(0, Math.floor(finNum_(v.dias_plazo)));
  if (v.requiere_default !== undefined) patch['Requiere Factura Default'] = v.requiere_default === 'No' ? 'No' : 'Sí';
  if (v.metodo_default !== undefined) patch['Método Pago Default'] = FIN_METODOS.indexOf(v.metodo_default) >= 0 ? v.metodo_default : '';
  if (v.cuenta_default !== undefined) patch['Cuenta Pago Default'] = finStr_(v.cuenta_default);
  if (v.porcentaje_factura !== undefined) patch['Porcentaje Factura'] = finStr_(v.porcentaje_factura) === '' ? '' : Math.min(100, Math.max(0, finNum_(v.porcentaje_factura)));
  if (patch['Nombre'] === '') return finErr_('El nombre no puede quedar vacío.');   // TROUBLESHOOT: a required field was empty or malformed; the browser form normally prevents this
  finUpdate_('Proveedores', cur._row, patch);
  logAuditEvent('fin_update_vendor', 'Proveedor', cur['Vendor ID'], { fields: Object.keys(patch) });
  return jsonResponse({ result: 'ok', vendor: finVendorOut_(Object.assign({}, cur, patch)) });
}

function finSaveCategoryAction(body, identity) {
  const caps = resolveCaps(identity);
  if (!caps['finance.categories_edit']) return finDenied_();
  const c = body.category || {};
  const name = finStr_(c.nombre);
  if (!name) return finErr_('Escribe el nombre de la categoría.');   // TROUBLESHOOT: a required field was empty or malformed; the browser form normally prevents this
  if (FIN_SCOPES.indexOf(c.scope) < 0) return finErr_('Elige el alcance de la categoría.');   // TROUBLESHOOT: a required field was empty or malformed; the browser form normally prevents this
  const patch = { 'Nombre': name, 'Parent ID': finStr_(c.parent_id), 'Scope': c.scope, 'Tipo Contable': finStr_(c.tipo_contable) || 'Operativo',
    'Deducible Default': ['Sí', 'No', 'Revisar'].indexOf(c.deducible_default) >= 0 ? c.deducible_default : 'Sí',
    'Activa': c.activa === 'No' ? 'No' : 'Sí', 'Orden': Math.floor(finNum_(c.orden)) || 99 };
  if (c.category_id) {
    const cur = finCategoryById_(c.category_id);
    if (!cur) return finErr_('No se encontró esa categoría.');   // TROUBLESHOOT: the id the browser sent is not in the tab, or the person's scopes hide it; check the id in the Finanzas sheet
    finUpdate_('Categorías', cur._row, patch);   // existing expenses keep the scope they were saved with; only new ones follow the change
    logAuditEvent('fin_save_category', 'Categoría', c.category_id, { scope: c.scope });
    return jsonResponse({ result: 'ok', category_id: c.category_id });
  }
  const id = finNextId_('CAT', 3);
  finAppend_('Categorías', [Object.assign({ 'Category ID': id }, patch)]);
  logAuditEvent('fin_save_category', 'Categoría', id, { scope: c.scope, created: true });
  return jsonResponse({ result: 'ok', category_id: id });
}

// ─── Vendor-code → Catalog ID map ──────────────────────────────────────────

function finMapKey_(vendorId, code, desc) {
  const c = finNorm_(code).replace(/ /g, '');
  return vendorId + '|' + (c ? 'c:' + c : 'd:' + finNorm_(desc));
}

function finMapUpsert_(vendorId, code, desc, catalogId, ppu, unitCost, fecha, who) {
  if (!vendorId || !catalogId) return;
  const key = finMapKey_(vendorId, code, desc);
  const tab = finRead_('Mapa Proveedor-Producto');
  const hit = tab.rows.find(r => finMapKey_(r['Vendor ID'], r['Código Proveedor'], r['Descripción Normalizada']) === key);
  if (hit) {
    finUpdate_('Mapa Proveedor-Producto', hit._row, {
      'Catalog ID': catalogId, 'Piezas por Unidad': Math.max(0, finNum_(ppu)) || hit['Piezas por Unidad'] || 1,
      'Último Costo Unitario': finNum_(unitCost), 'Última Fecha': fecha, 'Veces Usado': Number(hit['Veces Usado'] || 0) + 1, 'Confirmado Por': who, 'Status': 'Activo',
    });
  } else {
    finAppend_('Mapa Proveedor-Producto', [{
      'Map ID': finNextId_('MAP', 5), 'Vendor ID': vendorId, 'Código Proveedor': finStr_(code), 'Descripción Normalizada': finNorm_(desc),
      'Catalog ID': catalogId, 'Piezas por Unidad': Math.max(0, finNum_(ppu)) || 1, 'Último Costo Unitario': finNum_(unitCost),
      'Última Fecha': fecha, 'Veces Usado': 1, 'Confirmado Por': who, 'Status': 'Activo',
    }]);
  }
}

// Suggest-only: returns candidates, never writes.
function finMapSuggestGet_(p, identity) {
  const caps = resolveCaps(identity);
  if (!caps['finance.create']) return finDenied_();
  const vendorId = finStr_(p.vendor_id);
  const code = finStr_(p.code), desc = finStr_(p.desc);
  const rows = finRead_('Mapa Proveedor-Producto').rows.filter(r => r['Status'] !== 'Descartado' && r['Vendor ID'] === vendorId);
  const out = [];
  if (code) {
    const c = finNorm_(code).replace(/ /g, '');
    rows.forEach(r => { if (finNorm_(r['Código Proveedor']).replace(/ /g, '') === c) out.push({ catalog_id: r['Catalog ID'], via: 'código', ppu: r['Piezas por Unidad'], last_cost: r['Último Costo Unitario'], score: 1 }); });
  }
  if (!out.length && desc) {
    const d = finNorm_(desc);
    rows.forEach(r => {
      const s = finSimilar_(d, r['Descripción Normalizada']);
      if (s >= 0.8) out.push({ catalog_id: r['Catalog ID'], via: 'descripción', ppu: r['Piezas por Unidad'], last_cost: r['Último Costo Unitario'], score: s });
    });
  }
  out.sort((a, b) => b.score - a.score);
  return jsonResponse({ suggestions: out.slice(0, 3) });
}

function finSimilar_(a, b) {
  if (!a || !b) return 0;
  try { return Number(stringSimilarity(a, b)) || 0; } catch (e) { return a === b ? 1 : 0; }   // stringSimilarity lives in apps-script.gs; TROUBLESHOOT: if renamed, update this call
}

// Product names for the picker (same source as Mayoristas).
function finCatalogGet_(p, identity) {
  const caps = resolveCaps(identity);
  if (!caps['finance.create']) return finDenied_();
  const parents = sheetToObjects(getProductParentsSheet());
  const pName = {};
  parents.forEach(pr => {
    const n = String(pr['Parent Name'] || '');
    if (n && n.indexOf('(merged→') < 0) pName[String(pr['Parent ID'])] = n;
  });
  const out = [];
  sheetToObjects(getProductVariantsSheet()).forEach(v => {
    const parent = pName[String(v['Parent ID'])];
    if (!parent) return;
    const vn = String(v['Variant Name'] || '');
    if (vn.indexOf('(merged→') >= 0) return;
    out.push({ id: String(v['Catalog ID']), name: vn && vn !== parent ? parent + ' (' + vn + ')' : parent });
  });
  return jsonResponse({ products: out });
}

// Admin queue: purchase lines nobody linked to a product yet.
function finUnlinkedLinesGet_(p, identity) {
  const caps = resolveCaps(identity);
  if (!caps['finance.edit_any']) return finDenied_();
  const exps = {};
  finRead_('Gastos').rows.forEach(r => { if (r['Status'] === 'Activo') exps[r['Expense ID']] = r; });
  const rows = finRead_('Gasto Líneas').rows
    .filter(l => l['Status'] === 'Activo' && l['Tipo Línea'] === 'Inventario' && !l['Catalog ID'] && exps[l['Expense ID']])
    .map(l => { const o = Object.assign({}, l); delete o._row; o.fecha = exps[l['Expense ID']]['Fecha Compra']; return o; })
    .sort((a, b) => String(b.fecha).localeCompare(String(a.fecha)));
  return jsonResponse({ rows: rows.slice(0, 300), count: rows.length });
}

function finLinkLineAction(body, identity) {
  const caps = resolveCaps(identity);
  if (!caps['finance.edit_any']) return finDenied_();
  const line = finRead_('Gasto Líneas').rows.find(l => l['Line ID'] === finStr_(body.line_id) && l['Status'] === 'Activo');
  if (!line) return finErr_('No se encontró esa línea.');   // TROUBLESHOOT: the id the browser sent is not in the tab, or the person's scopes hide it; check the id in the Finanzas sheet
  const catalogId = finStr_(body.catalog_id);
  if (!catalogId) return finErr_('Elige un producto del catálogo.');   // TROUBLESHOOT: a required field was empty or malformed; the browser form normally prevents this
  finUpdate_('Gasto Líneas', line._row, { 'Catalog ID': catalogId, 'Vínculo': 'Confirmado' });
  const ex = finFindExpenseRow_(line['Expense ID']);
  finMapUpsert_(line['Vendor ID'], line['Código Proveedor'], line['Descripción'], catalogId, line['Piezas por Unidad'], line['Costo Unitario'], ex ? ex['Fecha Compra'] : finToday_(), personKey_(identity));
  logAuditEvent('fin_link_line', 'Línea', line['Line ID'], { catalog_id: catalogId });
  return jsonResponse({ result: 'ok' });
}

// Unit cost over time for one product (admin).
function finCostHistoryGet_(p, identity) {
  const caps = resolveCaps(identity);
  if (!caps['finance.view_summary']) return finDenied_();
  const id = finStr_(p.catalog_id);
  const exps = {};
  finRead_('Gastos').rows.forEach(r => { if (r['Status'] === 'Activo') exps[r['Expense ID']] = r; });
  const vendors = {};
  finRead_('Proveedores').rows.forEach(v => { vendors[v['Vendor ID']] = v['Nombre']; });
  const rows = finRead_('Gasto Líneas').rows
    .filter(l => l['Status'] === 'Activo' && l['Catalog ID'] === id && exps[l['Expense ID']])
    .map(l => {
      const ppu = Number(l['Piezas por Unidad']) || 1;
      return { fecha: exps[l['Expense ID']]['Fecha Compra'], vendor: vendors[l['Vendor ID']] || '', cantidad: l['Cantidad'], costo_unitario: l['Costo Unitario'], costo_pieza: finR2_(Number(l['Costo Unitario']) / ppu), expense_id: l['Expense ID'] };
    })
    .sort((a, b) => String(a.fecha).localeCompare(String(b.fecha)));
  return jsonResponse({ rows: rows });
}

// ─── Routers (called from doGet / dispatchPostAction in apps-script.gs) ────

function finRouteGet(action, p, identity) {
  try {
    if (!identity || identity.service) return finDenied_();   // machines never touch Finanzas
    switch (action) {
      case 'fin_bootstrap':        return finBootstrapGet_(p, identity);
      case 'fin_list_expenses':    return finListExpensesGet_(p, identity);
      case 'fin_get_expense':      return finGetExpenseGet_(p, identity);
      case 'fin_pending_invoices': return finPendingInvoicesGet_(p, identity);
      case 'fin_list_invoices':    return finListInvoicesGet_(p, identity);
      case 'fin_get_file':         return finGetFileGet_(p, identity);
      case 'fin_map_suggest':      return finMapSuggestGet_(p, identity);
      case 'fin_catalog':          return finCatalogGet_(p, identity);
      case 'fin_unlinked_lines':   return finUnlinkedLinesGet_(p, identity);
      case 'fin_cost_history':     return finCostHistoryGet_(p, identity);
      case 'fin_summary':          return finSummaryGet_(p, identity);
      case 'fin_slim':             return finSlimGet_(p, identity);
      case 'fin_recurring_list':   return finRecurringListGet_(p, identity);
      case 'fin_reimbursements':   return finReimbursementsGet_(p, identity);
      case 'fin_petty_cash':       return finPettyCashGet_(p, identity);
      case 'fin_close_check':      return finCloseCheckGet_(p, identity);
      case 'fin_export_month':     return finExportMonthGet_(p, identity);
      case 'fin_export_zip':       return finExportZipGet_(p, identity);
      case 'fin_caps_get':         return finCapsGet_(p, identity);
      case 'fin_ai_status':        return finAiStatusGet_(p, identity);
      default: return finErr_('Unknown action');   // TROUBLESHOOT: the browser asked for a fin_ action this script version does not know; deploy the latest finanzas*.gs files
    }
  } catch (err) {
    return finErr_(err.message);   // TROUBLESHOOT: read the message; most are explained next to the line that throws it
  }
}

function finRoutePost(action, body, identity) {
  try {
    if (!identity || identity.service) return finDenied_();
    switch (action) {
      case 'fin_setup':             return finSetupAction(body, identity);
      case 'fin_config_save':       return finConfigSaveAction(body, identity);
      case 'fin_create_expense':    return finCreateExpenseAction(body, identity);
      case 'fin_update_expense':    return finUpdateExpenseAction(body, identity);
      case 'fin_void_expense':      return finVoidExpenseAction(body, identity);
      case 'fin_mark_paid':         return finMarkPaidAction(body, identity);
      case 'fin_upload_file':       return finUploadFileAction(body, identity);
      case 'fin_create_invoice':    return finCreateInvoiceAction(body, identity);
      case 'fin_link_invoice':      return finLinkInvoiceAction(body, identity);
      case 'fin_unlink_invoice':    return finUnlinkInvoiceAction(body, identity);
      case 'fin_void_invoice':      return finVoidInvoiceAction(body, identity);
      case 'fin_set_invoice_status': return finSetInvoiceStatusAction(body, identity);
      case 'fin_create_vendor':     return finCreateVendorAction(body, identity);
      case 'fin_update_vendor':     return finUpdateVendorAction(body, identity);
      case 'fin_save_category':     return finSaveCategoryAction(body, identity);
      case 'fin_link_line':         return finLinkLineAction(body, identity);
      case 'fin_save_recurring':    return finSaveRecurringAction(body, identity);
      case 'fin_run_daily':         return finRunDailyAction(body, identity);
      case 'fin_mark_reimbursed':   return finMarkReimbursedAction(body, identity);
      case 'fin_petty_cash_move':   return finPettyCashMoveAction(body, identity);
      case 'fin_close_month':       return finCloseMonthAction(body, identity);
      case 'fin_reopen_month':      return finReopenMonthAction(body, identity);
      case 'fin_caps_set':          return finCapsSetAction(body, identity);
      case 'fin_ai_extract':        return finAiExtractAction(body, identity);
      default: return finErr_('Unknown action');   // TROUBLESHOOT: see finRouteGet
    }
  } catch (err) {
    return finErr_(err.message);   // TROUBLESHOOT: unexpected exception inside an action; open Executions in the Apps Script editor for the stack trace
  }
}
