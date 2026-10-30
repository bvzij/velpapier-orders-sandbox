// ═══════════════════════════════════════════════════════════════════════════
// FINANZAS — admin side (new file: finanzas-admin.gs)
// Month close · petty cash · reimbursements · recurring costs + daily job ·
// summary · analytics feed · exports for the contador · AI ticket reading ·
// the capability toggles screen.
// ═══════════════════════════════════════════════════════════════════════════

const FIN_PAID_STATES = ['Capturado', 'Revisado'];
const FIN_ORDER_PAID = ['Pagado', 'Anotado', 'Enviado', 'Archivado'];   // same statuses Análisis counts as revenue

// ─── Month close ───────────────────────────────────────────────────────────

function finCloseCheckGet_(p, identity) {
  const caps = resolveCaps(identity);
  if (!caps['finance.month_close']) return finDenied_();
  const periodo = finStr_(p.periodo);
  if (!/^\d{4}-\d{2}$/.test(periodo)) return finErr_('Elige un mes válido.');   // TROUBLESHOOT: a required field was empty or malformed; the browser form normally prevents this
  const rows = finRead_('Gastos').rows.filter(r => r['Status'] === 'Activo');
  const inP = rows.filter(r => r['Periodo'] === periodo);
  const lines = finRead_('Gasto Líneas').rows;
  const ids = {};
  inP.forEach(r => { ids[r['Expense ID']] = true; });
  const pendInv = inP.filter(r => r['Requiere Factura'] === 'Sí' && ['Pendiente', 'Solicitada'].indexOf(r['Estado Factura']) >= 0 && r['Captura Status'] !== 'Por capturar');
  return jsonResponse({
    periodo: periodo, closed: finIsClosed_(periodo),
    por_capturar: inP.filter(r => r['Captura Status'] === 'Por capturar').length,
    por_pagar: inP.filter(r => r['Captura Status'] === 'Por pagar').length,
    sin_revisar: inP.filter(r => r['Captura Status'] === 'Capturado').length,
    facturas_pendientes: pendInv.length,
    facturas_vencidas: pendInv.filter(r => finIsDate_(r['Fecha Límite Factura']) && r['Fecha Límite Factura'] < finToday_()).length,
    lineas_sin_vincular: lines.filter(l => l['Status'] === 'Activo' && l['Tipo Línea'] === 'Inventario' && !l['Catalog ID'] && ids[l['Expense ID']]).length,
    reembolsos_pendientes: rows.filter(r => r['Reembolso Status'] === 'Pendiente').length,
  });
}

function finCloseMonthAction(body, identity) {
  const caps = resolveCaps(identity);
  if (!caps['finance.month_close']) return finDenied_();
  const periodo = finStr_(body.periodo);
  if (!/^\d{4}-\d{2}$/.test(periodo)) return finErr_('Elige un mes válido.');   // TROUBLESHOOT: a required field was empty or malformed; the browser form normally prevents this
  if (periodo > finToday_().slice(0, 7)) return finErr_('No se puede cerrar un mes que todavía no empieza.');   // TROUBLESHOOT: month state is kept in the Cierres tab (last row per period wins)
  if (finIsClosed_(periodo)) return finErr_('Ese mes ya está cerrado.');   // TROUBLESHOOT: the period is closed in the Cierres tab; an admin reopens it in Finanzas > Cierre
  finAppend_('Cierres', [{ 'Periodo': periodo, 'Estado': 'Cerrado', 'Cerrado Por': personKey_(identity), 'Cerrado En': finNow_(), 'Notas': finStr_(body.notas) }]);
  logAuditEvent('fin_close_month', 'Cierre', periodo, {});
  return jsonResponse({ result: 'ok', closed_periods: finClosedPeriods_() });
}

function finReopenMonthAction(body, identity) {
  const caps = resolveCaps(identity);
  if (!caps['finance.month_close']) return finDenied_();
  const periodo = finStr_(body.periodo);
  if (!finIsClosed_(periodo)) return finErr_('Ese mes no está cerrado.');   // TROUBLESHOOT: the period is closed in the Cierres tab; an admin reopens it in Finanzas > Cierre
  finAppend_('Cierres', [{ 'Periodo': periodo, 'Estado': 'Reabierto', 'Cerrado Por': personKey_(identity), 'Cerrado En': finNow_(), 'Notas': finStr_(body.notas) }]);
  logAuditEvent('fin_reopen_month', 'Cierre', periodo, {});
  return jsonResponse({ result: 'ok', closed_periods: finClosedPeriods_() });
}

// ─── Petty cash + reimbursements ───────────────────────────────────────────
// Balance = fondeos + ajustes − gastos activos pagados con "Caja chica" por
// esa persona. Expenses are never copied into the Caja Chica tab, so the
// balance can never drift out of sync with Gastos.

function finPettyBalances_() {
  const moves = finRead_('Caja Chica').rows;
  const spent = finRead_('Gastos').rows.filter(r => r['Status'] === 'Activo' && r['Método Pago'] === 'Caja chica' && r['Captura Status'] !== 'Por capturar');
  const people = {};
  const ensure = n => (people[n] = people[n] || { responsable: n, fondeos: 0, ajustes: 0, gastos: 0, saldo: 0 });
  moves.forEach(m => { const o = ensure(String(m['Responsable']).toUpperCase()); if (m['Tipo'] === 'Fondeo') o.fondeos += finNum_(m['Monto']); else o.ajustes += finNum_(m['Monto']); });
  spent.forEach(r => { ensure(String(r['Pagado Por']).toUpperCase()).gastos += finNum_(r['Total MXN']); });
  Object.keys(people).forEach(k => {
    const o = people[k];
    o.fondeos = finR2_(o.fondeos); o.ajustes = finR2_(o.ajustes); o.gastos = finR2_(o.gastos);
    o.saldo = finR2_(o.fondeos + o.ajustes - o.gastos);
  });
  return { people: people, moves: moves, spent: spent };
}

function finPettyCashGet_(p, identity) {
  const caps = resolveCaps(identity);
  const all = !!caps['finance.reimburse'];
  if (!all && !caps['finance.petty_cash']) return finDenied_();
  const me = personKey_(identity);
  const b = finPettyBalances_();
  const mine = n => String(n).toUpperCase() === me;
  const balances = Object.keys(b.people).map(k => b.people[k]).filter(o => all || mine(o.responsable));
  if (!all && !balances.length) balances.push({ responsable: me, fondeos: 0, ajustes: 0, gastos: 0, saldo: 0 });
  const moves = b.moves.filter(m => all || mine(m['Responsable'])).map(m => { const o = Object.assign({}, m); delete o._row; return o; })
    .sort((x, y) => String(y['Fecha']).localeCompare(String(x['Fecha']))).slice(0, 100);
  const spent = b.spent.filter(r => all || mine(r['Pagado Por'])).filter(r => finCanSeeExpense_(r, identity, caps) || all)
    .map(r => ({ id: r['Expense ID'], fecha: r['Fecha Compra'], total: r['Total MXN'], descripcion: r['Descripción'], responsable: r['Pagado Por'] }))
    .sort((x, y) => String(y.fecha).localeCompare(String(x.fecha))).slice(0, 100);
  return jsonResponse({ balances: balances, moves: moves, spent: spent, can_fund: all });
}

function finPettyCashMoveAction(body, identity) {
  const caps = resolveCaps(identity);
  if (!caps['finance.reimburse']) return finDenied_();
  const who = finStr_(body.responsable).toUpperCase();
  if (!who) return finErr_('Elige quién recibe el dinero.');   // TROUBLESHOOT: a required field was empty or malformed; the browser form normally prevents this
  const tipo = body.tipo === 'Ajuste' ? 'Ajuste' : 'Fondeo';
  const monto = finR2_(finNum_(body.monto));
  if (!monto || (tipo === 'Fondeo' && monto < 0)) return finErr_('Escribe un monto válido.');   // TROUBLESHOOT: a required field was empty or malformed; the browser form normally prevents this
  const fecha = finIsDate_(body.fecha) ? body.fecha : finToday_();
  const id = finNextId_('CCH', 5);
  finAppend_('Caja Chica', [{ 'Movimiento ID': id, 'Fecha': fecha, 'Responsable': who, 'Tipo': tipo, 'Monto': monto, 'Notas': finStr_(body.notas), 'Creado Por': personKey_(identity), 'Creado En': finNow_() }]);
  logAuditEvent('fin_petty_cash_move', 'CajaChica', id, { who: who, tipo: tipo, monto: monto });
  return jsonResponse({ result: 'ok', movement_id: id });
}

function finReimbursementsGet_(p, identity) {
  const caps = resolveCaps(identity);
  if (!caps['finance.view']) return finDenied_();
  const all = !!caps['finance.reimburse'];
  const me = personKey_(identity);
  const rows = finRead_('Gastos').rows
    .filter(r => r['Status'] === 'Activo' && r['Reembolso Status'] === 'Pendiente' && finCanSeeExpense_(r, identity, caps) && (all || String(r['Pagado Por']).toUpperCase() === me))
    .map(r => ({ id: r['Expense ID'], fecha: r['Fecha Compra'], total: r['Total MXN'], descripcion: r['Descripción'], pagado_por: r['Pagado Por'], vendor_id: r['Vendor ID'] }))
    .sort((a, b) => String(a.fecha).localeCompare(String(b.fecha)));
  return jsonResponse({ rows: rows, can_pay: all });
}

function finMarkReimbursedAction(body, identity) {
  const caps = resolveCaps(identity);
  if (!caps['finance.reimburse']) return finDenied_();
  const ids = (Array.isArray(body.expense_ids) ? body.expense_ids : []).map(String);
  if (!ids.length) return finErr_('Elige al menos un gasto.');   // TROUBLESHOOT: a required field was empty or malformed; the browser form normally prevents this
  let done = 0;
  ids.forEach(id => {
    const r = finFindExpenseRow_(id);
    if (r && r['Status'] === 'Activo' && r['Reembolso Status'] === 'Pendiente') {
      finUpdate_('Gastos', r._row, { 'Reembolso Status': 'Pagado', 'Reembolso Fecha': finToday_(), 'Editado Por': personKey_(identity), 'Editado En': finNow_() });
      done++;
    }
  });
  logAuditEvent('fin_mark_reimbursed', 'Gasto', ids.join(','), { done: done });
  return jsonResponse({ result: 'ok', done: done });
}

// ─── Recurring costs (Gastos fijos) ────────────────────────────────────────

function finRecurringOut_(r) {
  const o = {};
  Object.keys(r).forEach(k => { if (k !== '_row') o[k] = r[k]; });
  return o;
}

function finRecurringListGet_(p, identity) {
  const caps = resolveCaps(identity);
  if (!caps['finance.recurring']) return finDenied_();
  const periodo = finStr_(p.periodo) || finToday_().slice(0, 7);
  const templates = finRead_('Gastos Fijos').rows.map(finRecurringOut_);
  const cfg = finConfig_();
  const due = finRead_('Gastos').rows.filter(r => r['Status'] === 'Activo' && r['Recurring ID'] && r['Periodo'] === periodo).map(r => finExpenseOut_(r, cfg));
  return jsonResponse({ templates: templates, expenses: due, periodo: periodo });
}

function finSaveRecurringAction(body, identity) {
  const caps = resolveCaps(identity);
  if (!caps['finance.recurring']) return finDenied_();
  const r = body.recurring || {};
  const nombre = finStr_(r.nombre);
  if (!nombre) return finErr_('Escribe el nombre del gasto fijo.');   // TROUBLESHOOT: a required field was empty or malformed; the browser form normally prevents this
  const cat = finCategoryById_(finStr_(r.category_id));
  if (!cat) return finErr_('Elige una categoría.');   // TROUBLESHOOT: a required field was empty or malformed; the browser form normally prevents this
  const freq = ['Mensual', 'Quincenal', 'Anual'].indexOf(r.frecuencia) >= 0 ? r.frecuencia : 'Mensual';
  const dia = Math.min(Math.max(Math.floor(finNum_(r.dia)) || 1, 1), 31);
  if (freq === 'Anual' && !finIsDate_(r.desde)) return finErr_('Un gasto anual necesita la fecha "Desde" (el mes se toma de ahí).');   // TROUBLESHOOT: a required field was empty or malformed; the browser form normally prevents this
  const patch = {
    'Nombre': nombre, 'Vendor ID': finStr_(r.vendor_id), 'Category ID': cat['Category ID'], 'Monto Estimado': finR2_(finNum_(r.monto_estimado)),
    'Moneda': finStr_(r.moneda).toUpperCase() || 'MXN', 'Frecuencia': freq, 'Día': dia,
    'Método Pago': FIN_METODOS.indexOf(r.metodo_pago) >= 0 ? r.metodo_pago : 'Transferencia', 'Cuenta Pago': finStr_(r.cuenta_pago),
    'Requiere Factura': r.requiere_factura === 'No' ? 'No' : 'Sí', 'Activo': r.activo === 'No' ? 'No' : 'Sí',
    'Desde': finIsDate_(r.desde) ? r.desde : '', 'Hasta': finIsDate_(r.hasta) ? r.hasta : '', 'Notas': finStr_(r.notas),
  };
  if (r.recurring_id) {
    const cur = finRead_('Gastos Fijos').rows.find(x => x['Recurring ID'] === r.recurring_id);
    if (!cur) return finErr_('No se encontró ese gasto fijo.');   // TROUBLESHOOT: the id the browser sent is not in the tab, or the person's scopes hide it; check the id in the Finanzas sheet
    finUpdate_('Gastos Fijos', cur._row, patch);
    logAuditEvent('fin_save_recurring', 'GastoFijo', r.recurring_id, { nombre: nombre });
    return jsonResponse({ result: 'ok', recurring_id: r.recurring_id });
  }
  const id = finNextId_('FIJ', 3);
  finAppend_('Gastos Fijos', [Object.assign({ 'Recurring ID': id, 'Último Generado': '' }, patch)]);
  logAuditEvent('fin_save_recurring', 'GastoFijo', id, { nombre: nombre, created: true });
  return jsonResponse({ result: 'ok', recurring_id: id });
}

function finMonthLength_(ym) { return Number(finEndOfMonth_(ym + '-01').slice(8, 10)); }

// Which keys/dates of this template are due as of `today`. Pure function.
function finRecurringDue_(t, today) {
  if (t['Activo'] === 'No') return [];
  if (finIsDate_(t['Desde']) && today < t['Desde']) return [];
  if (finIsDate_(t['Hasta']) && today > t['Hasta']) return [];
  const ym = today.slice(0, 7), d = Number(today.slice(8, 10)), len = finMonthLength_(ym);
  const dia = Math.min(Math.max(Number(t['Día']) || 1, 1), 31);
  const at = n => ym + '-' + String(Math.min(n, len)).padStart(2, '0');
  const out = [];
  if (t['Frecuencia'] === 'Quincenal') {
    const a = Math.min(dia, dia > 15 ? dia - 15 : dia), b = a + 15;
    if (d >= Math.min(a, len)) out.push({ key: ym + '-q1', fecha: at(a) });
    if (d >= Math.min(b, len)) out.push({ key: ym + '-q2', fecha: at(b) });
  } else if (t['Frecuencia'] === 'Anual') {
    if (finIsDate_(t['Desde']) && Number(ym.slice(5, 7)) === Number(String(t['Desde']).slice(5, 7)) && d >= Math.min(dia, len)) out.push({ key: ym.slice(0, 4), fecha: at(dia) });
  } else if (d >= Math.min(dia, len)) {
    out.push({ key: ym, fecha: at(dia) });
  }
  return out;
}

function finGenerateRecurring_(today) {
  const created = [], skipped = [];
  const exps = finRead_('Gastos').rows;
  const cfg = finConfig_();
  finRead_('Gastos Fijos').rows.forEach(t => {
    const due = finRecurringDue_(t, today);
    let last = String(t['Último Generado'] || '');
    due.forEach(item => {
      if (item.key <= last && last) return;
      if (exps.some(e => e['Recurring ID'] === t['Recurring ID'] && e['Fecha Compra'] === item.fecha && e['Status'] === 'Activo')) { last = item.key; return; }
      if (finIsClosed_(item.fecha.slice(0, 7))) { skipped.push(t['Recurring ID'] + ' ' + item.fecha + ' (mes cerrado)'); return; }
      const cat = finCategoryById_(t['Category ID']);
      if (!cat) { skipped.push(t['Recurring ID'] + ' (categoría borrada)'); return; }   // TROUBLESHOOT: the template points at a deleted category; edit the Gasto fijo and pick another
      const vendor = t['Vendor ID'] ? finVendorById_(t['Vendor ID']) : null;
      const moneda = String(t['Moneda'] || 'MXN').toUpperCase();
      const e = {
        'Expense ID': finNextId_('GST', 6), 'Captura Status': 'Por pagar', 'Status': 'Activo', 'Fecha Compra': item.fecha, 'Fecha Pago': '',
        'Periodo': item.fecha.slice(0, 7), 'Vendor ID': t['Vendor ID'] || '', 'Category ID': cat['Category ID'], 'Scope': cat['Scope'],
        'Descripción': t['Nombre'], 'Método Pago': t['Método Pago'] || 'Transferencia', 'Cuenta Pago': t['Cuenta Pago'] || '', 'Pagado Por': 'SISTEMA',
        'Reembolso Status': 'No aplica', 'Moneda': moneda, 'Tipo Cambio': moneda === 'MXN' ? 1 : '', 'Total': finR2_(finNum_(t['Monto Estimado'])),
        'Total MXN': moneda === 'MXN' ? finR2_(finNum_(t['Monto Estimado'])) : 0, 'Requiere Factura': t['Requiere Factura'] === 'No' ? 'No' : 'Sí',
        'Recurring ID': t['Recurring ID'], 'Deducible': cat['Deducible Default'] || 'Sí', 'Archivos': '', 'Creado Por': 'SISTEMA', 'Creado En': finNow_(),
      };
      e['Estado Factura'] = e['Requiere Factura'] === 'No' ? 'No requiere' : 'Pendiente';
      e['Fecha Límite Factura'] = e['Requiere Factura'] === 'Sí' ? finInvoiceDeadline_(item.fecha, vendor) : '';
      e['Flags'] = finComputeFlags_(e, [], cfg);
      finAppend_('Gastos', [e]);
      exps.push(e);
      created.push(e['Expense ID']);
      last = item.key;
    });
    if (last !== String(t['Último Generado'] || '')) finUpdate_('Gastos Fijos', t._row, { 'Último Generado': last });
  });
  return { created: created, skipped: skipped };
}

// Keeps the INVOICE_OVERDUE flag honest (the screens compute it live anyway;
// the flag is for analytics and exports).
function finRefreshFlags_() {
  const cfg = finConfig_();
  let changed = 0;
  finRead_('Gastos').rows.forEach(r => {
    if (r['Status'] !== 'Activo') return;
    const f = String(r['Flags'] || '').split(',').filter(x => x && x !== 'INVOICE_OVERDUE');
    const overdue = r['Requiere Factura'] === 'Sí' && ['Pendiente', 'Solicitada'].indexOf(r['Estado Factura']) >= 0 && finIsDate_(r['Fecha Límite Factura']) && r['Fecha Límite Factura'] < finToday_();
    if (overdue) f.push('INVOICE_OVERDUE');
    const next = f.join(',');
    if (next !== String(r['Flags'] || '')) { finUpdate_('Gastos', r._row, { 'Flags': next }); changed++; }
  });
  return changed;
}

function finRunDailyAction(body, identity) {
  const caps = resolveCaps(identity);
  if (!caps['finance.recurring']) return finDenied_();
  const g = finGenerateRecurring_(finToday_());
  const flags = finRefreshFlags_();
  logAuditEvent('fin_run_daily', 'Finanzas', 'daily', { created: g.created.length, flags: flags });
  return jsonResponse({ result: 'ok', created: g.created.length, skipped: g.skipped, flags_updated: flags });
}

// Time-driven trigger entry point (installed by setup). Takes the same lock
// the web app uses so a daily run can never overlap a save.
function finDailyJob() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(60000)) { Logger.log('finDailyJob: busy, will retry tomorrow'); return; }   // TROUBLESHOOT: another request held the lock for a full minute; run "Generar gastos fijos" from Finanzas > Gastos fijos
  try {
    _ssCache = {};
    _currentIdentity = { name: 'SISTEMA', role: 'admin' };
    if (!finIsSetup_()) return;
    const g = finGenerateRecurring_(finToday_());
    const flags = finRefreshFlags_();
    logAuditEvent('fin_daily_job', 'Finanzas', 'daily', { created: g.created.length, skipped: g.skipped.length, flags: flags });
    try { flushAudit(); } catch (e) { Logger.log('finDailyJob: audit flush failed ' + e.message); }
  } finally { lock.releaseLock(); }
}

function finInstallTriggers_() {
  const have = ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === 'finDailyJob');
  if (have.length) return 'ya existía';
  ScriptApp.newTrigger('finDailyJob').timeBased().atHour(6).everyDays(1).inTimezone(MX_TZ).create();
  return 'creado';
}

// ─── Summary (Resumen) ─────────────────────────────────────────────────────

function finPrevPeriodo_(ym) {
  const y = Number(ym.slice(0, 4)), m = Number(ym.slice(5, 7));
  const d = new Date(Date.UTC(y, m - 2, 1, 12));
  return d.toISOString().slice(0, 7);
}

// Revenue per month, from the same Orders sheet and statuses Análisis uses.
function finIncomeByMonth_() {
  const cache = CacheService.getScriptCache();
  try { const hit = cache.get('fin_income_v1'); if (hit) return JSON.parse(hit); } catch (e) { /* recompute */ }
  const sh = getOrdersSheet();
  const out = {};
  const last = sh.getLastRow();
  if (last >= 2) {
    const headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(String);
    const col = n => headers.indexOf(n) + 1;
    const cStatus = col('Status'), cPrice = col('Price'), cOrder = col('Order Date'), cCreated = col('Created Date');
    if (cStatus && cPrice && (cOrder || cCreated)) {
      const read = c => c ? sh.getRange(2, c, last - 1, 1).getValues() : null;
      const st = read(cStatus), pr = read(cPrice), od = read(cOrder), cr = read(cCreated);
      const ym = v => {
        if (v instanceof Date) return Utilities.formatDate(v, MX_TZ, 'yyyy-MM');
        const s = String(v || '');
        if (/^\d{4}-\d{2}/.test(s)) return s.slice(0, 7);
        const d = s ? new Date(s) : null;
        return d && !isNaN(d.getTime()) ? Utilities.formatDate(d, MX_TZ, 'yyyy-MM') : '';
      };
      for (let i = 0; i < st.length; i++) {
        if (FIN_ORDER_PAID.indexOf(String(st[i][0])) < 0) continue;
        const m = ym((od && od[i][0]) || (cr && cr[i][0]));
        if (m) out[m] = finR2_((out[m] || 0) + finNum_(pr[i][0]));
      }
    }
  }
  try { cache.put('fin_income_v1', JSON.stringify(out), 600); } catch (e) { /* too big for cache: fine */ }
  return out;
}

function finSummaryGet_(p, identity) {
  const caps = resolveCaps(identity);
  if (!caps['finance.view_summary']) return finDenied_();
  const periodo = /^\d{4}-\d{2}$/.test(finStr_(p.periodo)) ? p.periodo : finToday_().slice(0, 7);
  const prev = finPrevPeriodo_(periodo);
  const rows = finRead_('Gastos').rows.filter(r => r['Status'] === 'Activo' && finCanSeeExpense_(r, identity, caps));
  const paid = r => FIN_PAID_STATES.indexOf(r['Captura Status']) >= 0;
  const cats = {}, vendors = {};
  finRead_('Categorías').rows.forEach(c => { cats[c['Category ID']] = c; });
  finRead_('Proveedores').rows.forEach(v => { vendors[v['Vendor ID']] = v; });
  const inP = rows.filter(r => r['Periodo'] === periodo);
  const paidP = inP.filter(paid);
  const sum = list => finR2_(list.reduce((s, r) => s + finNum_(r['Total MXN']), 0));
  const total = sum(paidP), prevTotal = sum(rows.filter(r => r['Periodo'] === prev && paid(r)));

  const group = (list, keyFn, labelFn, extra) => {
    const g = {};
    list.forEach(r => { const k = keyFn(r) || '—'; (g[k] = g[k] || { id: k, name: labelFn(k), total: 0, count: 0 }); g[k].total += finNum_(r['Total MXN']); g[k].count++; if (extra) extra(g[k], r); });
    return Object.keys(g).map(k => { const o = g[k]; o.total = finR2_(o.total); o.pct = total > 0 ? Math.round(o.total / total * 1000) / 10 : 0; return o; }).sort((a, b) => b.total - a.total);
  };
  const byCategory = group(paidP, r => r['Category ID'], k => (cats[k] ? cats[k]['Nombre'] : 'Sin categoría'), (o, r) => { o.scope = r['Scope']; o.tipo = cats[r['Category ID']] ? cats[r['Category ID']]['Tipo Contable'] : ''; });
  const byVendor = group(paidP, r => r['Vendor ID'], k => (vendors[k] ? vendors[k]['Nombre'] : 'Sin proveedor')).slice(0, 10);
  const byScope = group(paidP, r => r['Scope'], k => k);

  const needInv = paidP.filter(r => r['Requiere Factura'] === 'Sí');
  const withInv = needInv.filter(r => r['Estado Factura'] === 'Recibida');
  const pending = needInv.filter(r => ['Pendiente', 'Solicitada'].indexOf(r['Estado Factura']) >= 0);

  const income = caps._admin ? finIncomeByMonth_() : null;
  const months = [];
  let m = periodo;
  for (let i = 0; i < 6; i++) { months.unshift(m); m = finPrevPeriodo_(m); }
  const series = months.map(mm => ({ periodo: mm, gasto: sum(rows.filter(r => r['Periodo'] === mm && paid(r))), ingresos: income ? (income[mm] || 0) : null }));

  const allLines = finRead_('Gasto Líneas').rows;
  const idsP = {};
  inP.forEach(r => { idsP[r['Expense ID']] = true; });
  const res = {
    periodo: periodo, prev_periodo: prev,
    gasto: { total: total, count: paidP.length, prev_total: prevTotal, delta_pct: prevTotal > 0 ? Math.round((total - prevTotal) / prevTotal * 1000) / 10 : null },
    by_category: byCategory, by_vendor: byVendor, by_scope: byScope,
    facturas: {
      requeridas_total: sum(needInv), con_factura_total: sum(withInv), coverage_pct: needInv.length ? Math.round(sum(withInv) / Math.max(sum(needInv), 0.01) * 1000) / 10 : null,
      pendientes_count: pending.length, pendientes_total: sum(pending),
      vencidas_count: pending.filter(r => finIsDate_(r['Fecha Límite Factura']) && r['Fecha Límite Factura'] < finToday_()).length,
    },
    iva_acreditable: finR2_(withInv.reduce((s, r) => s + finNum_(r['IVA']), 0)),
    por_pagar: { count: inP.filter(r => r['Captura Status'] === 'Por pagar').length, total: sum(inP.filter(r => r['Captura Status'] === 'Por pagar')) },
    por_capturar: inP.filter(r => r['Captura Status'] === 'Por capturar').length,
    reembolsos_pendientes: { count: rows.filter(r => r['Reembolso Status'] === 'Pendiente').length, total: sum(rows.filter(r => r['Reembolso Status'] === 'Pendiente')) },
    lineas_sin_vincular: allLines.filter(l => l['Status'] === 'Activo' && l['Tipo Línea'] === 'Inventario' && !l['Catalog ID'] && idsP[l['Expense ID']]).length,
    months: series,
  };
  if (income) { res.ingresos = { total: income[periodo] || 0, prev_total: income[prev] || 0 }; res.neto = finR2_((income[periodo] || 0) - total); }
  return jsonResponse(res);
}

// Compact rows for the Análisis page (admin only).
function finSlimGet_(p, identity) {
  const caps = resolveCaps(identity);
  if (!caps['finance.view_totals'] || !caps['finance.view_summary']) return finDenied_();
  const cats = {};
  finRead_('Categorías').rows.forEach(c => { cats[c['Category ID']] = c; });
  const rows = finRead_('Gastos').rows
    .filter(r => r['Status'] === 'Activo' && r['Captura Status'] !== 'Por capturar' && finCanSeeExpense_(r, identity, caps))
    .map(r => ({
      periodo: r['Periodo'], fecha: r['Fecha Compra'], vendorId: r['Vendor ID'], categoryId: r['Category ID'],
      tipoContable: cats[r['Category ID']] ? cats[r['Category ID']]['Tipo Contable'] : '', scope: r['Scope'],
      subtotal: r['Subtotal'], iva: r['IVA'], totalMXN: r['Total MXN'], deducible: r['Deducible'], estadoFactura: r['Estado Factura'], captura: r['Captura Status'],
    }));
  return jsonResponse({ rows: rows });
}

// ─── Export for the contador ───────────────────────────────────────────────

function finCsv_(headers, rows) {
  const esc = v => { const s = v === null || v === undefined ? '' : String(v); return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  return '\uFEFF' + [headers.map(esc).join(',')].concat(rows.map(r => r.map(esc).join(','))).join('\r\n');
}

function finExportMonthGet_(p, identity) {
  const caps = resolveCaps(identity);
  if (!caps['finance.export']) return finDenied_();
  const periodo = finStr_(p.periodo);
  if (!/^\d{4}-\d{2}$/.test(periodo)) return finErr_('Elige un mes válido.');   // TROUBLESHOOT: a required field was empty or malformed; the browser form normally prevents this
  const cats = {}, vendors = {}, invoices = {};
  finRead_('Categorías').rows.forEach(c => { cats[c['Category ID']] = c; });
  finRead_('Proveedores').rows.forEach(v => { vendors[v['Vendor ID']] = v; });
  finRead_('Facturas').rows.forEach(i => { invoices[i['Invoice ID']] = i; });
  const exps = finRead_('Gastos').rows.filter(r => r['Status'] === 'Activo' && r['Periodo'] === periodo && r['Captura Status'] !== 'Por capturar' && finCanSeeExpense_(r, identity, caps));
  const h1 = ['ID', 'Fecha compra', 'Fecha pago', 'Proveedor', 'RFC proveedor', 'Categoría', 'Tipo contable', 'Alcance', 'Descripción', 'Método de pago', 'Cuenta', 'Moneda', 'Subtotal', 'IVA', 'Total', 'Total MXN', 'Estado factura', 'UUID factura', 'Folio ticket', 'Deducible', 'Banderas', 'Notas'];
  const r1 = exps.sort((a, b) => String(a['Fecha Compra']).localeCompare(String(b['Fecha Compra']))).map(r => {
    const v = vendors[r['Vendor ID']] || {}, c = cats[r['Category ID']] || {}, inv = invoices[r['Invoice ID']] || {};
    return [r['Expense ID'], r['Fecha Compra'], r['Fecha Pago'], v['Nombre'] || '', v['RFC'] || inv['RFC Emisor'] || '', c['Nombre'] || '', c['Tipo Contable'] || '', r['Scope'], r['Descripción'],
      r['Método Pago'], r['Cuenta Pago'], r['Moneda'], r['Subtotal'], r['IVA'], r['Total'], r['Total MXN'], r['Estado Factura'], inv['UUID'] || '', r['Folio Ticket'], r['Deducible'], r['Flags'], r['Notas']];
  });
  const idset = {};
  exps.forEach(r => { idset[r['Expense ID']] = r; });
  const h2 = ['Gasto', 'Línea', 'Código proveedor', 'Descripción', 'Producto (Catalog ID)', 'Tipo', 'Cantidad', 'Unidad', 'Piezas por unidad', 'Costo unitario', 'Descuento', 'Total línea'];
  const r2 = finRead_('Gasto Líneas').rows.filter(l => l['Status'] === 'Activo' && idset[l['Expense ID']])
    .map(l => [l['Expense ID'], l['Línea #'], l['Código Proveedor'], l['Descripción'], l['Catalog ID'], l['Tipo Línea'], l['Cantidad'], l['Unidad'], l['Piezas por Unidad'], l['Costo Unitario'], l['Descuento Línea'], l['Total Línea']]);
  const enc = s => Utilities.base64Encode(Utilities.newBlob(s, 'text/csv', 'x.csv').getBytes());
  logAuditEvent('fin_export_month', 'Finanzas', periodo, { expenses: exps.length });
  return jsonResponse({ files: [
    { name: 'gastos-' + periodo + '.csv', mime: 'text/csv', data: enc(finCsv_(h1, r1)) },
    { name: 'lineas-' + periodo + '.csv', mime: 'text/csv', data: enc(finCsv_(h2, r2)) },
  ], expenses: exps.length });
}

function finExportZipGet_(p, identity) {
  const caps = resolveCaps(identity);
  if (!caps['finance.export']) return finDenied_();
  const periodo = finStr_(p.periodo);
  if (!/^\d{4}-\d{2}$/.test(periodo)) return finErr_('Elige un mes válido.');   // TROUBLESHOOT: a required field was empty or malformed; the browser form normally prevents this
  const withTickets = p.include_tickets === '1';
  const exps = finRead_('Gastos').rows.filter(r => r['Status'] === 'Activo' && r['Periodo'] === periodo && finCanSeeExpense_(r, identity, caps));
  const expIds = {}, invIds = {};
  exps.forEach(r => { expIds[r['Expense ID']] = true; if (r['Invoice ID']) invIds[r['Invoice ID']] = true; });
  const reg = finRead_('Archivos').rows.filter(f =>
    (f['Invoice ID'] && invIds[f['Invoice ID']] && (f['Kind'] === 'xml' || f['Kind'] === 'pdf')) || (withTickets && f['Expense ID'] && expIds[f['Expense ID']] && f['Kind'] === 'ticket'));
  const blobs = [];
  let bytes = 0;
  for (let i = 0; i < reg.length; i++) {
    let file;
    let blob;
    try { blob = Utilities.newBlob(finFileBytes_(reg[i]), reg[i]['Mime'], String(reg[i]['Nombre'])); } catch (e) { continue; }   // TROUBLESHOOT: file deleted from Drive/VPS, or VPFILES_FIN_KEY wrong; it is skipped
    bytes += blob.getBytes().length;
    if (bytes > 25 * 1024 * 1024) return finErr_('Los archivos de ' + periodo + ' pesan más de 25 MB. Descarga sin fotos de tickets o por partes.');   // TROUBLESHOOT: Apps Script responses cap near 50 MB; lower or split
    blob.setName((reg[i]['Kind'] === 'ticket' ? 'tickets/' : 'facturas/') + (reg[i]['Expense ID'] || reg[i]['Invoice ID']) + '-' + reg[i]['Nombre']);
    blobs.push(blob);
  }
  if (!blobs.length) return finErr_('No hay archivos para ese mes.');   // TROUBLESHOOT: no XML/PDF files are linked to that month's expenses
  const zip = Utilities.zip(blobs, 'archivos-' + periodo + '.zip');
  logAuditEvent('fin_export_zip', 'Finanzas', periodo, { files: blobs.length });
  return jsonResponse({ name: 'archivos-' + periodo + '.zip', mime: 'application/zip', data: Utilities.base64Encode(zip.getBytes()), files: blobs.length });
}

// ─── AI ticket reading (dormant until an AI key exists) ─────────────────────
// Provider-agnostic: Gemini or Claude, picked by which key exists in Script Properties.
// Keys live ONLY in Script Properties; the browser never sees them.
//   FIN_GEMINI_KEY     -> Google Gemini (free tier available; aistudio.google.com)
//   FIN_ANTHROPIC_KEY  -> Anthropic Claude (console.anthropic.com)
//   FIN_AI_PROVIDER    -> optional: 'gemini' or 'anthropic' to force one when both keys exist
//   FIN_GEMINI_MODEL / FIN_ANTHROPIC_MODEL -> optional: override the model name without a code change

const FIN_AI_PROVIDERS = {
  gemini:    { keyProp: 'FIN_GEMINI_KEY',    modelProp: 'FIN_GEMINI_MODEL',    model: 'gemini-3.8-flash', priceIn: 0,    priceOut: 0 },      // free tier: cost logged as 0
  anthropic: { keyProp: 'FIN_ANTHROPIC_KEY', modelProp: 'FIN_ANTHROPIC_MODEL', model: 'claude-haiku-5-5', priceIn: 0.10, priceOut: 0.50 },  // USD per million tokens
};

function finAiProvider_() {
  const props = PropertiesService.getScriptProperties();
  const forced = String(props.getProperty('FIN_AI_PROVIDER') || '').toLowerCase().trim();
  const order = FIN_AI_PROVIDERS[forced] ? [forced] : ['anthropic', 'gemini'];
  for (let i = 0; i < order.length; i++) {
    const def = FIN_AI_PROVIDERS[order[i]];
    const key = props.getProperty(def.keyProp);
    if (key) return { name: order[i], key: key, model: props.getProperty(def.modelProp) || def.model, priceIn: def.priceIn, priceOut: def.priceOut };
  }
  return null;
}

// AI reads run OUTSIDE the global write lock (they take a minute or more), so the log row takes
// the lock only for the instant of the append. If it can't, the row is skipped rather than blocking.
function finAiLog_(row) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return;   // TROUBLESHOOT: another save held the lock for 10 s; this one AI Log row is skipped, nothing else is affected
  try { finAppend_('AI Log', [row]); } finally { lock.releaseLock(); }
}

// Ticket dates come in several shapes. Rules (Mexico): a 4-digit year first means Y-M-D (ISO);
// year last means D-M-Y, unless the first number is over 12 and the second is not (then M-D-Y, US style).
// A 2-digit year is taken as 20YY. Anything that is not a real calendar date returns ''.
function finParseTicketDate_(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  const pad = n => String(n).padStart(2, '0');
  const ok = (y, m, d) => {
    if (y < 100) y += 2000;
    const iso = y + '-' + pad(m) + '-' + pad(d);
    return m >= 1 && m <= 12 && d >= 1 && d <= 31 && finIsDate_(iso) ? iso : '';
  };
  let m = s.match(/(\d{4})[-\/.](\d{1,2})[-\/.](\d{1,2})/);
  if (m) return ok(+m[1], +m[2], +m[3]);
  m = s.match(/(\d{1,2})[-\/.](\d{1,2})[-\/.](\d{2,4})/);
  if (m) {
    const a = +m[1], b = +m[2], y = +m[3];
    if (b > 12 && a <= 12) return ok(y, a, b);   // only possible as month-first
    return ok(y, b, a);                          // default: day-first
  }
  return '';
}

function finAiMonthSpend_() {
  const prefix = finToday_().slice(0, 7);
  return Math.round(finRead_('AI Log').rows.filter(r => String(r['Fecha']).indexOf(prefix) === 0).reduce((s, r) => s + finNum_(r['Costo USD']), 0) * 10000) / 10000;
}

function finAiStatusGet_(p, identity) {
  const caps = resolveCaps(identity);
  if (!caps['finance.ai_prefill']) return finDenied_();
  const cap = Number(finConfig_().ai_monthly_cap_usd) || 5;
  const prov = finAiProvider_();
  return jsonResponse({ ready: !!prov, provider: prov ? prov.name : '', month_spend_usd: finAiMonthSpend_(), cap_usd: cap, model: prov ? prov.model : '—' });
}

// One call, any provider. req = { system, parts: [{text} | {image: {mime, data(base64)}}], maxTokens, json }.
// Returns { text, tokensIn, tokensOut } in the same shape for every provider.
function finAiCall_(prov, req) {
  let url, headers, payload;
  if (prov.name === 'gemini') {
    url = 'https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(prov.model) + ':generateContent';
    headers = { 'x-goog-api-key': prov.key };
    const gen = { maxOutputTokens: req.maxTokens || 2000, temperature: 0 };
    if (req.json) gen.responseMimeType = 'application/json';
    // Reading a ticket needs no reasoning: switch "thinking" off (the main cause of slow replies).
    if (/^gemini-2\./.test(prov.model)) gen.thinkingConfig = { thinkingBudget: 0 };
    else if (/^gemini-/.test(prov.model)) gen.thinkingConfig = { thinkingLevel: 'minimal' };
    payload = {
      contents: [{ role: 'user', parts: req.parts.map(p => p.image ? { inline_data: { mime_type: p.image.mime, data: p.image.data } } : { text: p.text }) }],
      generationConfig: gen,
    };
    if (req.system) payload.systemInstruction = { parts: [{ text: req.system }] };
  } else {
    url = 'https://api.anthropic.com/v1/messages';
    headers = { 'x-api-key': prov.key, 'anthropic-version': '2023-06-01' };
    payload = {
      model: prov.model, max_tokens: req.maxTokens || 2000,
      messages: [{ role: 'user', content: req.parts.map(p => p.image ? { type: 'image', source: { type: 'base64', media_type: p.image.mime, data: p.image.data } } : { type: 'text', text: p.text }) }],
    };
    if (req.system) payload.system = req.system;
  }
  const send = () => UrlFetchApp.fetch(url, { method: 'post', contentType: 'application/json', muteHttpExceptions: true, headers: headers, payload: JSON.stringify(payload) });
  let res = send();
  const tc = payload.generationConfig && payload.generationConfig.thinkingConfig;
  let thinking = tc ? (tc.thinkingLevel || 'off') : '';
  if (res.getResponseCode() === 400 && thinking) {
    // Not every model accepts every level: step down minimal -> low before dropping the setting entirely.
    if (tc.thinkingLevel === 'minimal') { payload.generationConfig.thinkingConfig = { thinkingLevel: 'low' }; thinking = 'low'; res = send(); }
    if (res.getResponseCode() === 400) { delete payload.generationConfig.thinkingConfig; thinking = 'rechazado'; res = send(); }
  }
  const code = res.getResponseCode();
  const body = res.getContentText();
  if (code === 429) throw new Error('La IA está saturada o se llegó al límite gratuito. Espera un minuto y reintenta.');   // TROUBLESHOOT: Gemini free tier = few requests/minute and a daily cap per project; check limits in aistudio.google.com
  if (code !== 200) { Logger.log('AI ' + prov.name + ' HTTP ' + code + ': ' + body.slice(0, 1000)); throw new Error('La IA no respondió (HTTP ' + code + ').'); }   // TROUBLESHOOT: 400/403 = wrong key or model; 404 = model name no longer exists (set FIN_GEMINI_MODEL / FIN_ANTHROPIC_MODEL); body is in the Executions log
  const out = JSON.parse(body);
  if (prov.name === 'gemini') {
    const cand = (out.candidates || [])[0] || {};
    const text = ((cand.content || {}).parts || []).filter(p => !p.thought).map(p => p.text || '').join('');
    if (!text) throw new Error('La IA no devolvió texto (' + (cand.finishReason || 'sin motivo') + ').');   // TROUBLESHOOT: finishReason SAFETY/RECITATION = blocked by Google; MAX_TOKENS = ticket too long for maxTokens
    const u = out.usageMetadata || {};
    return { text: text, tokensIn: Number(u.promptTokenCount) || 0, tokensOut: (Number(u.candidatesTokenCount) || 0) + (Number(u.thoughtsTokenCount) || 0), thoughts: Number(u.thoughtsTokenCount) || 0, thinking: thinking };
  }
  return {
    text: (out.content || []).filter(b => b.type === 'text').map(b => b.text).join(''),
    tokensIn: Number(out.usage && out.usage.input_tokens) || 0, tokensOut: Number(out.usage && out.usage.output_tokens) || 0,
  };
}

function finAiExtractAction(body, identity) {
  const caps = resolveCaps(identity);
  if (!caps['finance.ai_prefill'] || !caps['finance.create']) return finDenied_();
  const prov = finAiProvider_();
  if (!prov) return finErr_('La lectura con IA todavía no está activada. Un admin debe agregar una llave (FIN_GEMINI_KEY o FIN_ANTHROPIC_KEY).');   // TROUBLESHOOT: add Script Property FIN_GEMINI_KEY (aistudio.google.com) or FIN_ANTHROPIC_KEY (console.anthropic.com)
  const cfg = finConfig_();
  const cap = Number(cfg.ai_monthly_cap_usd) || 5;
  if (finAiMonthSpend_() >= cap) return finErr_('Se alcanzó el tope mensual de IA (' + cap + ' USD). Un admin puede subirlo en Configuración.');   // TROUBLESHOOT: monthly AI spend reached ai_monthly_cap_usd (Configuración); raise it or wait for next month

  // One ticket can come as several overlapping photos (long tickets), sent in top-to-bottom order.
  const idsIn = Array.isArray(body.file_ids) ? body.file_ids : [body.file_id];
  const ids = [];
  idsIn.forEach(x => { const s = finStr_(x); if (s && ids.indexOf(s) < 0) ids.push(s); });
  if (!ids.length) return finErr_('Agrega primero la foto del ticket.');
  if (ids.length > 10) return finErr_('Máximo 10 fotos por ticket. Si el ticket es más largo, divídelo en dos gastos.');   // TROUBLESHOOT: raise the 10 here only if the AI keeps up; more photos = slower and pricier
  const archivos = finRead_('Archivos').rows;
  const images = [];
  let totalBytes = 0;
  for (let i = 0; i < ids.length; i++) {
    const reg = archivos.find(r => String(r['File ID']) === ids[i]);
    if (!reg || !finMayReadFile_(reg, identity, caps) || String(reg['Mime']).indexOf('image/') !== 0) return finErr_('No se encontró la foto ' + (i + 1) + '.');   // TROUBLESHOOT: the id the browser sent is not in the tab, or the person's scopes hide it; check the id in the Finanzas sheet
    let bytes;
    try { bytes = finFileBytes_(reg); } catch (e) { return finErr_('No se pudo leer la foto ' + (i + 1) + ': ' + e.message); }   // TROUBLESHOOT: Drive file deleted, or VPS file missing / VPFILES_FIN_KEY wrong
    if (bytes.length > 4.5 * 1024 * 1024) return finErr_('La foto ' + (i + 1) + ' es muy pesada para la IA. Tómala de nuevo.');   // TROUBLESHOOT: photo over 4.5 MB; the browser normally shrinks photos to ~300 KB before upload
    totalBytes += bytes.length;
    images.push({ mime: reg['Mime'], data: Utilities.base64Encode(bytes) });
  }
  if (totalBytes > 20 * 1024 * 1024) return finErr_('Las fotos juntas pesan demasiado. Usa menos fotos.');   // TROUBLESHOOT: API request limit; normally ~300 KB per photo

  const vendors = finRead_('Proveedores').rows.filter(v => v['Status'] !== 'Inactivo');
  const names = vendors.slice(0, 80).map(v => v['Nombre']).join('; ');
  const system = 'You read photos of Mexican purchase receipts (tickets) for a small stationery business. Reply with ONLY one JSON object, no prose, no markdown.\n'
    + 'PHOTOS: you may get several photos of ONE long ticket, in order from top to bottom. Consecutive photos overlap by one or more items. '
    + 'List every purchased item exactly once, in ticket order. An item at the bottom of one photo that reappears at the top of the next is the SAME item: list it once. '
    + 'Only when you truly cannot tell whether two identical consecutive items are an overlap or two separate purchases, list both and set posible_duplicado true on the second.\n'
    + 'HANDWRITING: ignore all pen marks (circles, ticks, numbers inside circles, names, notes, strike-throughs). Read only the printed text.\n'
    + 'COMMON LAYOUT: each item uses two printed rows. Row 1 = CODE then DESCRIPTION. Row 2 = quantity, unit price, line amount. '
    + 'Footer: "Cantidades" = total pieces, "Importe" = total. Header: "Numero" = folio.\n'
    + 'codigo = only the first token of row 1, exactly as printed (examples: A2809, YMHM-4, QYSHL-4). '
    + 'descripcion = the rest of row 1, but drop any "COD-<digits>" token and drop a trailing "X <n> PZS" box-size note.\n'
    + 'Fields: vendor_name (string|null), fecha (YYYY-MM-DD|null), fecha_texto (string|null, the purchase date exactly as printed, e.g. "2026-10-16" or "16/10/26"), folio (string|null), metodo_pago (one of "Efectivo","Tarjeta débito","Tarjeta crédito","Transferencia"|null), '
    + 'total (number|null), subtotal (number|null), iva (number|null), total_piezas (number|null, the printed total pieces), '
    + 'lineas (array of {codigo (string|null), descripcion (string), cantidad (number), costo_unitario (number), total_linea (number), foto (number, 1-based photo where the item was read), posible_duplicado (boolean)}), notas (string|null). '
    + 'Use plain numbers (no currency symbols). Never invent values you cannot read; use null. Known vendors (prefer these exact spellings if one matches): ' + names;
  const parts = [];
  images.forEach((im, i) => {
    parts.push({ text: 'Foto ' + (i + 1) + ' de ' + images.length + ':' });
    parts.push({ image: im });
  });
  parts.push({ text: images.length > 1 ? 'Read this ticket. The photos overlap; list each item once.' : 'Read this ticket.' });
  const logId = ids.join(',');
  // Same photos asked again within 10 min (a double click, or Google re-sending a slow request):
  // hand back the answer already read, or wait for the read that is still running, instead of paying twice.
  const cache = CacheService.getScriptCache();
  const ckey = 'finai_' + Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, logId)).slice(0, 22);
  const done = cache.get(ckey + '_done');
  if (done) return jsonResponse(JSON.parse(done));
  if (cache.get(ckey + '_run')) {
    for (let w = 0; w < 60; w++) {
      Utilities.sleep(3000);
      const d = cache.get(ckey + '_done');
      if (d) return jsonResponse(JSON.parse(d));
      if (!cache.get(ckey + '_run')) break;
    }
  }
  cache.put(ckey + '_run', '1', 360);
  const t0 = Date.now();
  const secs = () => Math.round((Date.now() - t0) / 1000);
  let out, parsed, tries = 0;
  try {
    // The model sometimes returns broken JSON; one more attempt usually comes back clean.
    while (!parsed) {
      tries++;
      out = finAiCall_(prov, { system: system, parts: parts, maxTokens: 8000, json: true });
      const text = out.text, a = text.indexOf('{'), z = text.lastIndexOf('}');
      try { parsed = JSON.parse(text.slice(a, z + 1)); }
      catch (pe) {
        try { parsed = JSON.parse(text.slice(a, z + 1).replace(/,\s*([\]}])/g, '$1')); }   // trailing commas are the usual culprit
        catch (pe2) { if (tries >= 2) throw new Error('JSON inválido dos veces: ' + pe.message); }
      }
    }
  } catch (e) {
    cache.remove(ckey + '_run');
    finAiLog_({ 'Fecha': finNow_(), 'Persona': personKey_(identity), 'File ID': logId, 'Modelo': prov.model, 'Tokens In': out ? out.tokensIn : 0, 'Tokens Out': out ? out.tokensOut : 0, 'Costo USD': 0, 'Resultado': 'error · ' + secs() + ' s · ' + String(e.message).slice(0, 120) });
    return finErr_(e.message.indexOf('IA') >= 0 ? e.message : 'La IA devolvió algo que no se pudo leer. Intenta de nuevo o captura el ticket a mano.');   // TROUBLESHOOT: see AI Log tab; broken JSON twice in a row, or max_tokens hit on a very long ticket (Tokens Out near 8000)
  }
  const tin = out.tokensIn, tout = out.tokensOut;
  const cost = Math.round((tin * prov.priceIn + tout * prov.priceOut) / 1e6 * 1e6) / 1e6;
  finAiLog_({ 'Fecha': finNow_(), 'Persona': personKey_(identity), 'File ID': logId, 'Modelo': prov.model, 'Tokens In': tin, 'Tokens Out': tout, 'Costo USD': cost,
    'Resultado': 'ok · ' + images.length + ' foto(s) · ' + secs() + ' s' + (tries > 1 ? ' · 2 intentos' : '') + (out.thinking ? ' · thinking ' + out.thinking : '') + (out.thoughts ? ' · ' + out.thoughts + ' tok pensando' : '') });

  // Normalise + match vendor (suggest-only: the person confirms in the form).
  let vendorId = '';
  const vn = finNorm_(parsed.vendor_name);
  if (vn) {
    let best = 0;
    vendors.forEach(v => {
      const cands = [v['Nombre']].concat(String(v['Alias'] || '').split('|'));
      cands.forEach(c => { const s = finNorm_(c) === vn ? 1 : finSimilar_(vn, finNorm_(c)); if (s > best && s >= 0.8) { best = s; vendorId = v['Vendor ID']; } });
    });
  }
  // Lines: clean the code/description again (in case the model missed a rule), then flag
  // identical items sitting on a photo boundary -- flagged, never deleted.
  const lines = (Array.isArray(parsed.lineas) ? parsed.lineas : []).slice(0, 300).map(l => ({
    codigo: finStr_(l.codigo).replace(/\s+/g, '').toUpperCase(),
    descripcion: finStr_(l.descripcion).replace(/\bCOD-\d+\b/gi, '').replace(/\s+X\s*\d+\s*PZS\.?\s*$/i, '').replace(/\s{2,}/g, ' ').trim(),
    cantidad: finNum_(l.cantidad) || 1, costo_unitario: finR2_(finNum_(l.costo_unitario)), total_linea: finR2_(finNum_(l.total_linea)),
    foto: Number(l.foto) || 0, posible_duplicado: l.posible_duplicado === true,
  }));
  for (let i = 1; i < lines.length; i++) {
    const a = lines[i - 1], b = lines[i];
    if (a.foto && b.foto && b.foto === a.foto + 1 && a.codigo === b.codigo && a.descripcion === b.descripcion && a.cantidad === b.cantidad && a.costo_unitario === b.costo_unitario) b.posible_duplicado = true;
  }
  const metodos = ['Efectivo', 'Tarjeta débito', 'Tarjeta crédito', 'Transferencia'];
  const suggestion = {
    vendor_name: finStr_(parsed.vendor_name), vendor_id: vendorId, fecha_compra: finParseTicketDate_(parsed.fecha) || finParseTicketDate_(parsed.fecha_texto), folio_ticket: finStr_(parsed.folio),
    metodo_pago: metodos.indexOf(parsed.metodo_pago) >= 0 ? parsed.metodo_pago : '', total: finR2_(finNum_(parsed.total)), subtotal: parsed.subtotal == null ? '' : finR2_(finNum_(parsed.subtotal)),
    iva: parsed.iva == null ? '' : finR2_(finNum_(parsed.iva)), notas: finStr_(parsed.notas),
    total_piezas: parsed.total_piezas == null ? '' : finNum_(parsed.total_piezas),
    photos: images.length, lines: lines,
  };
  logAuditEvent('fin_ai_extract', 'Archivo', logId, { cost_usd: cost, tokens_in: tin, tokens_out: tout, photos: images.length, lines: lines.length });
  const answer = { result: 'ok', suggestion: suggestion, cost_usd: cost, model: prov.model };
  try { cache.put(ckey + '_done', JSON.stringify(answer), 600); } catch (e) { /* over 100 KB: just not cached */ }
  cache.remove(ckey + '_run');
  return jsonResponse(answer);
}


// Editor helper: run once after adding a key to check the key + model name.
function finAiSelfTest() {
  const prov = finAiProvider_();
  if (!prov) { Logger.log('Falta FIN_GEMINI_KEY o FIN_ANTHROPIC_KEY en Script Properties.'); return; }
  const out = finAiCall_(prov, { parts: [{ text: 'Reply with the single word OK.' }], maxTokens: 20 });
  Logger.log('Proveedor: ' + prov.name + ' · modelo: ' + prov.model + ' · respuesta: ' + out.text + ' · tokens: ' + out.tokensIn + '/' + out.tokensOut);
}

// ─── Clean slate + bulk delete (admin only) ───────────────────────────────
// Both always make a full copy of the Finanzas spreadsheet first; that copy is the undo.
// Setup stays: Proveedores, Categorías, Mapa Proveedor-Producto, Gastos Fijos, Config.
// Ticket files themselves are never deleted (Drive / VPS); only their registry rows go.
const FIN_RESET_TABS = ['Gastos', 'Gasto Líneas', 'Facturas', 'Factura Conceptos', 'Caja Chica', 'Cierres', 'Archivos', 'AI Log', 'Movimientos Inventario'];
const FIN_RESET_SEQS = ['GST', 'GSL', 'FAC', 'CON', 'CCH'];

function finBackupCopy_(label) {
  const stamp = Utilities.formatDate(new Date(), MX_TZ, 'yyyy-MM-dd HH-mm');
  const copy = DriveApp.getFileById(finSsId_()).makeCopy('Finanzas — respaldo ' + label + ' ' + stamp, finRootFolder_());
  return copy.getUrl();
}

function finResetPreviewGet_(p, identity) {
  if (!identity || identity.role !== 'admin') return finDenied_();
  const counts = {};
  FIN_RESET_TABS.forEach(t => { try { counts[t] = finRead_(t).rows.length; } catch (e) { counts[t] = 0; } });
  const g = finRead_('Gastos').rows;
  const fechas = g.map(r => String(r['Fecha Compra'] || '')).filter(Boolean).sort();
  return jsonResponse({
    counts: counts, desde: fechas[0] || '', hasta: fechas[fechas.length - 1] || '',
    total_mxn: finR2_(g.filter(r => r['Status'] === 'Activo').reduce((s, r) => s + finNum_(r['Total MXN']), 0)),
  });
}

function finResetDataAction(body, identity) {
  if (!identity || identity.role !== 'admin') return finDenied_();
  if (finStr_(body.confirm) !== 'BORRAR') return finErr_('Escribe BORRAR para confirmar.');   // TROUBLESHOOT: the browser asks for the word BORRAR before sending
  let backup;
  try { backup = finBackupCopy_('antes de empezar de cero'); } catch (e) { return finErr_('No se pudo hacer el respaldo, no se borró nada: ' + e.message); }   // TROUBLESHOOT: Drive copy failed (quota/permissions); nothing was deleted
  const cleared = {};
  FIN_RESET_TABS.forEach(t => {
    let sh;
    try { sh = finSheet_(t); } catch (e) { return; }
    const last = sh.getLastRow(), lc = sh.getLastColumn();
    cleared[t] = Math.max(0, last - 1);
    if (last > 1 && lc > 0) sh.getRange(2, 1, last - 1, lc).clearContent();   // keeps headers and the text format of the columns
  });
  const props = PropertiesService.getScriptProperties();
  FIN_RESET_SEQS.forEach(s => props.deleteProperty('FIN_SEQ_' + s));
  logAuditEvent('fin_reset_data', 'Finanzas', 'todo', { backup: backup, cleared: cleared });
  return jsonResponse({ result: 'ok', backup_url: backup, cleared: cleared });
}

function finDeleteExpensesAction(body, identity) {
  if (!identity || identity.role !== 'admin') return finDenied_();
  const ids = (Array.isArray(body.ids) ? body.ids : []).map(finStr_).filter(Boolean);
  if (!ids.length) return finErr_('No hay gastos seleccionados.');
  if (ids.length > 300) return finErr_('Máximo 300 gastos a la vez.');   // TROUBLESHOOT: limit keeps the call under Apps Script's time limit
  const gastos = finRead_('Gastos').rows.filter(r => ids.indexOf(String(r['Expense ID'])) >= 0);
  if (!gastos.length) return finErr_('No se encontraron esos gastos.');
  const closed = gastos.filter(r => finIsClosed_(r['Periodo'])).map(r => r['Periodo']);
  if (closed.length) return finErr_('Hay gastos en meses cerrados (' + closed.filter((x, i, a) => a.indexOf(x) === i).join(', ') + '). Reabre el mes primero.');   // TROUBLESHOOT: reopen the period in Finanzas > Cierre
  let backup;
  try { backup = finBackupCopy_('antes de eliminar ' + gastos.length + ' gastos'); } catch (e) { return finErr_('No se pudo hacer el respaldo, no se borró nada: ' + e.message); }   // TROUBLESHOOT: Drive copy failed; nothing was deleted
  gastos.forEach(r => { if (r['Invoice ID']) { try { finUnlinkExpenseFromInvoice_(r['Invoice ID'], r['Expense ID']); } catch (e) { /* invoice already gone */ } } });
  const del = (tab, rows) => {
    if (!rows.length) return 0;
    const sh = finSheet_(tab);
    rows.map(r => r._row).sort((a, b) => b - a).forEach(n => sh.deleteRow(n));   // bottom-up so row numbers stay valid
    return rows.length;
  };
  const isMine = r => ids.indexOf(String(r['Expense ID'])) >= 0;
  const n = {
    gastos: del('Gastos', gastos),
    lineas: del('Gasto Líneas', finRead_('Gasto Líneas').rows.filter(isMine)),
    archivos: del('Archivos', finRead_('Archivos').rows.filter(isMine)),
  };
  logAuditEvent('fin_delete_expenses', 'Gasto', ids.slice(0, 20).join(','), { count: n.gastos, lines: n.lineas, files: n.archivos, backup: backup });
  return jsonResponse({ result: 'ok', deleted: n, backup_url: backup });
}

// ─── Permisos screen (Finanzas > Configuración) ────────────────────────────

function finCapsGet_(p, identity) {
  if (!identity || identity.role !== 'admin') return finDenied_();
  const props = PropertiesService.getScriptProperties().getProperties();
  const users = [];
  Object.keys(props).forEach(k => {
    if (k.indexOf('USER_') !== 0) return;
    const parsed = parseUserProp(props[k]);
    if (parsed.role === 'admin') return;
    const name = k.slice(5).toUpperCase();
    const base = Object.assign({}, cleanCaps_(ROLE_CAPS.staff), cleanCaps_(USER_CAPS[name]));
    const over = capOverrides_(name);
    users.push({ name: name, defaults: base, overrides: over, effective: Object.assign({}, base, over), has_override: Object.keys(over).length > 0 });
  });
  users.sort((a, b) => a.name.localeCompare(b.name));
  return jsonResponse({ defs: CAP_DEFS, scopes: FIN_SCOPES, users: users });
}

function finCapsSetAction(body, identity) {
  if (!identity || identity.role !== 'admin') return finDenied_();
  const name = finStr_(body.name).toUpperCase();
  const props = PropertiesService.getScriptProperties();
  const raw = props.getProperty('USER_' + name);
  if (!raw) return finErr_('No existe esa persona.');   // TROUBLESHOOT: names come from the USER_<NAME> Script Properties
  if (parseUserProp(raw).role === 'admin') return finErr_('Los admins siempre tienen acceso total; no se editan aquí.');   // TROUBLESHOOT: admins cannot be restricted; edit USER_<NAME> role in Script Properties if that was the intent
  if (body.reset === true) {
    props.deleteProperty('CAPS_' + name);
    logAuditEvent('fin_caps_reset', 'Permisos', name, {});
    return jsonResponse({ result: 'ok' });
  }
  const clean = cleanCaps_(body.caps || {});
  props.setProperty('CAPS_' + name, JSON.stringify(clean));
  logAuditEvent('fin_caps_set', 'Permisos', name, { caps: clean });
  return jsonResponse({ result: 'ok', effective: Object.assign({}, cleanCaps_(ROLE_CAPS.staff), cleanCaps_(USER_CAPS[name]), clean) });
}
