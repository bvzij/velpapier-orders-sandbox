// ═══════════════════════════════════════════════════════════════════════════
// FINANZAS — facturas / CFDI (new file: finanzas-cfdi.gs)
//
// The browser sends the XML TEXT of a CFDI; the server parses it, so what is
// saved never depends on the frontend. Parsing uses a small built-in reader
// (finParseXml_) instead of XmlService so it can be tested outside Google and
// never expands entities beyond the five basic ones (no XXE risk).
//
// Nothing links automatically: the server only SUGGESTS which expense a
// factura belongs to; a person confirms (fin_link_invoice).
// ═══════════════════════════════════════════════════════════════════════════

const FIN_USO_OK = ['G01', 'G02', 'G03'];   // uso CFDI values that normally make a purchase deductible

// ─── Tiny XML reader ───────────────────────────────────────────────────────

function finXmlDecode_(s) {
  return String(s).replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (m, g) => {
    if (g === 'amp') return '&';
    if (g === 'lt') return '<';
    if (g === 'gt') return '>';
    if (g === 'quot') return '"';
    if (g === 'apos') return "'";
    const code = g[1] === 'x' ? parseInt(g.slice(2), 16) : parseInt(g.slice(1), 10);
    return isNaN(code) ? m : String.fromCodePoint(code);
  });
}

// Returns { local, attrs, children, text }. Throws a Spanish message when malformed.
function finParseXml_(xml) {
  let s = String(xml || '').replace(/^\uFEFF/, '');
  if (!s.trim()) throw new Error('El archivo XML está vacío.');   // TROUBLESHOOT: the browser sent no text; check the file picker
  s = s.replace(/<\?[\s\S]*?\?>/g, '').replace(/<!--[\s\S]*?-->/g, '').replace(/<!DOCTYPE[^>]*>/gi, '');
  const root = { local: '#root', name: '#root', attrs: {}, children: [], text: '' };
  const stack = [root];
  const tokenRe = /<\/([A-Za-z_][\w:.\-]*)\s*>|<([A-Za-z_][\w:.\-]*)((?:\s+[\w:.\-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|<!\[CDATA\[([\s\S]*?)\]\]>|([^<]+)/g;
  const attrRe = /([\w:.\-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let m, guard = 0;
  while ((m = tokenRe.exec(s)) !== null) {
    if (++guard > 200000) throw new Error('El XML es demasiado grande.');   // TROUBLESHOOT: a real CFDI has well under 20k nodes
    const cur = stack[stack.length - 1];
    if (m[1] !== undefined) {                      // closing tag
      if (stack.length < 2 || cur.name !== m[1]) throw new Error('El XML está mal formado (etiqueta ' + m[1] + ' sin abrir).');   // TROUBLESHOOT: file is truncated or not XML
      stack.pop();
    } else if (m[2] !== undefined) {               // opening / self-closing tag
      const attrs = {};
      let a;
      attrRe.lastIndex = 0;
      while ((a = attrRe.exec(m[3] || '')) !== null) {
        const key = a[1].indexOf(':') >= 0 ? a[1].slice(a[1].indexOf(':') + 1) : a[1];
        if (!(key in attrs)) attrs[key] = finXmlDecode_(a[2] !== undefined ? a[2] : a[3]);
      }
      const node = { name: m[2], local: m[2].indexOf(':') >= 0 ? m[2].slice(m[2].indexOf(':') + 1) : m[2], attrs: attrs, children: [], text: '' };
      cur.children.push(node);
      if (m[4] !== '/') stack.push(node);
    } else if (m[5] !== undefined) {               // CDATA
      cur.text += m[5];
    } else if (m[6] !== undefined) {
      cur.text += finXmlDecode_(m[6]);
    }
  }
  if (stack.length !== 1) throw new Error('El XML está mal formado (le faltan etiquetas de cierre).');   // TROUBLESHOOT: not a stamped CFDI purchase invoice; ask the vendor for the original XML
  return root;
}

function finXmlFirst_(node, local) {
  if (!node) return null;
  for (let i = 0; i < node.children.length; i++) {
    const c = node.children[i];
    if (c.local === local) return c;
    const deeper = finXmlFirst_(c, local);
    if (deeper) return deeper;
  }
  return null;
}

function finXmlChildren_(node, local) {
  return node ? node.children.filter(c => c.local === local) : [];
}

// ─── CFDI reader ───────────────────────────────────────────────────────────

function finParseCfdi_(xmlText) {
  const root = finParseXml_(xmlText);
  const comp = root.children.find(c => c.local === 'Comprobante');
  if (!comp) throw new Error('Este XML no parece una factura (CFDI): no tiene el nodo Comprobante.');   // TROUBLESHOOT: wrong file, or a PDF renamed to .xml
  const a = comp.attrs;
  const tipo = String(a.TipoDeComprobante || 'I').toUpperCase();
  if (tipo === 'P') throw new Error('Este XML es un complemento de pago, no una factura de compra.');   // TROUBLESHOOT: not a stamped CFDI purchase invoice; ask the vendor for the original XML
  if (tipo === 'T') throw new Error('Este XML es un comprobante de traslado, no una factura de compra.');   // TROUBLESHOOT: not a stamped CFDI purchase invoice; ask the vendor for the original XML
  const tfd = finXmlFirst_(comp, 'TimbreFiscalDigital');
  const uuid = tfd ? String(tfd.attrs.UUID || '').toUpperCase() : '';
  if (!uuid) throw new Error('La factura no está timbrada (no trae UUID).');   // TROUBLESHOOT: the vendor sent a draft; ask for the stamped XML
  const emisor = finXmlChildren_(comp, 'Emisor')[0], receptor = finXmlChildren_(comp, 'Receptor')[0];
  if (!emisor || !receptor) throw new Error('La factura no trae emisor o receptor.');   // TROUBLESHOOT: not a stamped CFDI purchase invoice; ask the vendor for the original XML
  const total = finNum_(a.Total);
  if (!(total >= 0) || !a.Fecha) throw new Error('La factura no trae fecha o total válidos.');   // TROUBLESHOOT: not a stamped CFDI purchase invoice; ask the vendor for the original XML
  const conceptosNode = finXmlChildren_(comp, 'Conceptos')[0];
  const conceptos = finXmlChildren_(conceptosNode, 'Concepto').map(c => ({
    claveProdServ: String(c.attrs.ClaveProdServ || ''), noIdent: String(c.attrs.NoIdentificacion || ''),
    descripcion: String(c.attrs.Descripcion || ''), cantidad: finNum_(c.attrs.Cantidad), claveUnidad: String(c.attrs.ClaveUnidad || ''),
    valorUnitario: finNum_(c.attrs.ValorUnitario), importe: finNum_(c.attrs.Importe), descuento: finNum_(c.attrs.Descuento),
  }));
  const imp = finXmlChildren_(comp, 'Impuestos')[0];
  let iva = 0, ret = 0;
  if (imp) {
    if (imp.attrs.TotalImpuestosTrasladados !== undefined) iva = finNum_(imp.attrs.TotalImpuestosTrasladados);
    else finXmlChildren_(finXmlChildren_(imp, 'Traslados')[0], 'Traslado').forEach(t => { if (t.attrs.Impuesto === '002') iva += finNum_(t.attrs.Importe); });
    ret = finNum_(imp.attrs.TotalImpuestosRetenidos);
  }
  return {
    version: String(a.Version || a.version || ''), tipo: tipo, uuid: uuid, fecha: String(a.Fecha).slice(0, 10),
    serie: String(a.Serie || ''), folio: String(a.Folio || ''), subtotal: finNum_(a.SubTotal), descuento: finNum_(a.Descuento),
    total: total, moneda: String(a.Moneda || 'MXN').toUpperCase(), tipoCambio: finNum_(a.TipoCambio) || 1,
    formaPago: String(a.FormaPago || ''), metodoPago: String(a.MetodoPago || '').toUpperCase(),
    emisor: { rfc: String(emisor.attrs.Rfc || '').toUpperCase(), nombre: String(emisor.attrs.Nombre || '') },
    receptor: { rfc: String(receptor.attrs.Rfc || '').toUpperCase(), uso: String(receptor.attrs.UsoCFDI || '').toUpperCase() },
    iva: finR2_(iva), retenciones: finR2_(ret), conceptos: conceptos,
  };
}

// ─── Output shape ──────────────────────────────────────────────────────────

function finInvoiceOut_(inv) {
  const o = {};
  Object.keys(inv).forEach(k => { if (k !== '_row') o[k] = inv[k]; });
  o.expense_ids = String(inv['Expense IDs'] || '').split(',').map(s => s.trim()).filter(Boolean);
  o.files = { xml: String(inv['Archivo XML'] || ''), pdf: String(inv['Archivo PDF'] || '') };
  return o;
}

function finScopeMax_(a, b) { return (FIN_SCOPE_RANK[b] || 0) > (FIN_SCOPE_RANK[a] || 0) ? b : a; }

// ─── Suggestions (never writes) ────────────────────────────────────────────

function finInvoiceCandidates_(inv, vendorId, identity, caps) {
  const cfg = finConfig_();
  const out = [];
  const needle = finNorm_([inv['Serie'], inv['Folio'], inv._conceptos || ''].join(' '));
  finRead_('Gastos').rows.forEach(r => {
    if (r['Status'] !== 'Activo' || r['Invoice ID'] || finIsDraft_(r)) return;
    if (!finCanSeeExpense_(r, identity, caps)) return;
    const sameCurrency = r['Moneda'] === inv['Moneda'];
    const totalDiff = Math.abs(finNum_(sameCurrency ? r['Total'] : r['Total MXN']) - finNum_(inv['Total']));
    const vendorMatch = vendorId && r['Vendor ID'] === vendorId;
    const days = finIsDate_(r['Fecha Compra']) && finIsDate_(inv['Fecha Emisión']) ? finDaysBetween_(r['Fecha Compra'], inv['Fecha Emisión']) : null;
    if (days !== null && (days < -1 || days > 45)) return;   // purchase must precede the factura by 0–45 days
    let score = 0;
    if (totalDiff <= 0.01) score += 50; else if (totalDiff <= 1) score += 35;
    if (vendorMatch) score += 30; else if (!r['Vendor ID']) score += 5;
    const folio = finNorm_(r['Folio Ticket']);
    if (folio && folio.length >= 3 && needle.indexOf(folio) >= 0) score += 30;
    if (days !== null) score += Math.round(20 * (1 - Math.max(0, days) / 45));
    if (score >= 50 && (totalDiff <= 1 || folio)) out.push({ expense_id: r['Expense ID'], fecha: r['Fecha Compra'], total: r['Total'], vendor_id: r['Vendor ID'], descripcion: r['Descripción'], folio_ticket: r['Folio Ticket'], score: score, total_diff: finR2_(totalDiff) });
  });
  out.sort((x, y) => y.score - x.score);
  return out.slice(0, 5);
}

// ─── Actions ───────────────────────────────────────────────────────────────

function finCreateInvoiceAction(body, identity) {
  const caps = resolveCaps(identity);
  if (!caps['finance.invoices']) return finDenied_();
  let cfdi;
  try { cfdi = finParseCfdi_(body.xml); } catch (e) { return finErr_(e.message); }   // TROUBLESHOOT: the message says what is wrong with the XML; re-download it from the vendor

  const existing = finRead_('Facturas').rows.find(r => String(r['UUID']).toUpperCase() === cfdi.uuid && r['Status'] === 'Activa');
  if (existing) {
    if (!finCanSeeScope_(existing['Scope'], caps)) return finErr_('Esta factura ya fue registrada.');   // do not reveal details of invoices outside the caller's scopes
    return jsonResponse({ result: 'duplicate_invoice', invoice: finInvoiceOut_(existing) });
  }

  const cfg = finConfig_();
  const vendors = finRead_('Proveedores').rows;
  let vendor = vendors.find(v => v['RFC'] && String(v['RFC']).toUpperCase() === cfdi.emisor.rfc)
    || vendors.find(v => finNorm_(v['Nombre']) === finNorm_(cfdi.emisor.nombre));
  let scope = 'operativo';
  if (vendor && vendor['Default Category ID']) {
    const cat = finCategoryById_(vendor['Default Category ID']);
    if (cat) scope = cat['Scope'];
  }
  if (!finCanSeeScope_(scope, caps)) return finErr_('Esta factura corresponde a gastos que no tienes permiso de ver. Pásasela a un admin.');   // TROUBLESHOOT: the matched vendor's default category has a scope outside the person's finance.scopes

  const flags = [];
  if (cfg.rfc && cfdi.receptor.rfc !== String(cfg.rfc).toUpperCase()) flags.push('WRONG_RFC');
  if (FIN_USO_OK.indexOf(cfdi.receptor.uso) < 0) flags.push('WRONG_USO');
  if (cfdi.formaPago === '01' && cfdi.total * (cfdi.moneda === 'MXN' ? 1 : cfdi.tipoCambio) > (Number(cfg.cash_limit) || 2000)) flags.push('CASH_OVER_LIMIT');
  if (cfdi.metodoPago === 'PPD') flags.push('PPD_NEEDS_PAYMENT');
  if (cfdi.tipo === 'E') flags.push('NOTA_CREDITO');

  const fileIds = finAttachableFiles_([finStr_(body.xml_file_id), finStr_(body.pdf_file_id)].filter(Boolean), identity, caps);
  const xmlFile = fileIds.indexOf(finStr_(body.xml_file_id)) >= 0 ? finStr_(body.xml_file_id) : '';
  const pdfFile = fileIds.indexOf(finStr_(body.pdf_file_id)) >= 0 ? finStr_(body.pdf_file_id) : '';

  const invoiceId = finNextId_('FAC', 6);
  const row = {
    'Invoice ID': invoiceId, 'UUID': cfdi.uuid, 'Status': 'Activa', 'Scope': scope, 'RFC Emisor': cfdi.emisor.rfc, 'Nombre Emisor': cfdi.emisor.nombre,
    'Vendor ID': vendor ? vendor['Vendor ID'] : '', 'RFC Receptor': cfdi.receptor.rfc, 'Uso CFDI': cfdi.receptor.uso, 'Fecha Emisión': cfdi.fecha,
    'Serie': cfdi.serie, 'Folio': cfdi.folio, 'Subtotal': cfdi.subtotal, 'Descuento': cfdi.descuento, 'IVA Trasladado': cfdi.iva,
    'Retenciones': cfdi.retenciones, 'Total': cfdi.total, 'Moneda': cfdi.moneda, 'Forma Pago': cfdi.formaPago, 'Método Pago': cfdi.metodoPago,
    'Archivo XML': xmlFile, 'Archivo PDF': pdfFile, 'Expense IDs': '', 'Match Status': 'Sin vincular', 'Flags': flags.join(','),
    'Creado Por': personKey_(identity), 'Creado En': finNow_(),
  };
  finAppend_('Facturas', [row]);
  finAppend_('Factura Conceptos', cfdi.conceptos.map(c => ({
    'Concepto ID': finNextId_('CON', 6), 'Invoice ID': invoiceId, 'Clave ProdServ': c.claveProdServ, 'No Identificación': c.noIdent,
    'Descripción': c.descripcion, 'Cantidad': c.cantidad, 'Clave Unidad': c.claveUnidad, 'Valor Unitario': c.valorUnitario, 'Importe': c.importe, 'Descuento': c.descuento,
  })));
  if (fileIds.length) {
    finRead_('Archivos').rows.forEach(r => { if (fileIds.indexOf(String(r['File ID'])) >= 0) finUpdate_('Archivos', r._row, { 'Invoice ID': invoiceId, 'Scope': scope }); });
  }
  const candidates = finInvoiceCandidates_(Object.assign({}, row, { _conceptos: cfdi.conceptos.map(c => c.descripcion).join(' ') }), row['Vendor ID'], identity, caps);
  logAuditEvent('fin_create_invoice', 'Factura', invoiceId, { uuid: cfdi.uuid, total: cfdi.total, flags: flags });
  return jsonResponse({
    result: 'ok', invoice: finInvoiceOut_(row), conceptos: cfdi.conceptos, suggestions: candidates,
    vendor_hint: vendor ? null : { rfc: cfdi.emisor.rfc, nombre: cfdi.emisor.nombre },
  });
}

function finLinkInvoiceAction(body, identity) {
  const caps = resolveCaps(identity);
  if (!caps['finance.invoices']) return finDenied_();
  const inv = finRead_('Facturas').rows.find(r => r['Invoice ID'] === finStr_(body.invoice_id));
  if (!inv || inv['Status'] !== 'Activa' || !finCanSeeScope_(inv['Scope'], caps)) return finErr_('No se encontró esa factura.');   // TROUBLESHOOT: the id the browser sent is not in the tab, or the person's scopes hide it; check the id in the Finanzas sheet
  const ids = (Array.isArray(body.expense_ids) ? body.expense_ids : []).map(String);
  if (!ids.length) return finErr_('Elige al menos un gasto para vincular.');   // TROUBLESHOOT: a required field was empty or malformed; the browser form normally prevents this
  const exps = [];
  for (let i = 0; i < ids.length; i++) {
    const r = finFindExpenseRow_(ids[i]);
    if (!r || r['Status'] !== 'Activo' || !finCanSeeExpense_(r, identity, caps)) return finErr_('No se encontró el gasto ' + ids[i] + '.');   // TROUBLESHOOT: the id the browser sent is not in the tab, or the person's scopes hide it; check the id in the Finanzas sheet
    if (r['Invoice ID'] && r['Invoice ID'] !== inv['Invoice ID']) return finErr_('El gasto ' + ids[i] + ' ya tiene otra factura vinculada.');   // TROUBLESHOOT: unlink the other factura first (fin_unlink_invoice), then relink
    if (finIsClosed_(r['Periodo'])) return finErr_('El mes ' + r['Periodo'] + ' está cerrado. Un admin debe reabrirlo.');   // TROUBLESHOOT: the period is closed in the Cierres tab; an admin reopens it in Finanzas > Cierre
    exps.push(r);
  }
  const prev = String(inv['Expense IDs'] || '').split(',').map(s => s.trim()).filter(Boolean);
  const all = prev.concat(ids.filter(id => prev.indexOf(id) < 0));
  const sumExp = all.reduce((s, id) => { const r = exps.find(x => x['Expense ID'] === id) || finFindExpenseRow_(id); return s + (r ? finNum_(r['Total']) : 0); }, 0);
  const diff = finR2_(sumExp - finNum_(inv['Total']));
  if (Math.abs(diff) > 1 && !body.confirm_mismatch) {
    return jsonResponse({ result: 'mismatch_warning', diff: diff, expenses_total: finR2_(sumExp), invoice_total: inv['Total'] });
  }
  let scope = inv['Scope'];
  exps.forEach(r => {
    scope = finScopeMax_(scope, finScopeOfRow_(r));
    const patch = { 'Invoice ID': inv['Invoice ID'], 'Estado Factura': 'Recibida', 'Requiere Factura': 'Sí', 'Editado Por': personKey_(identity), 'Editado En': finNow_() };
    if (all.length === 1 && Math.abs(finNum_(r['Total']) - finNum_(inv['Total'])) <= 1) { patch['Subtotal'] = inv['Subtotal']; patch['IVA'] = inv['IVA Trasladado']; }
    finUpdate_('Gastos', r._row, patch);
    const merged = Object.assign({}, r, patch);
    finUpdate_('Gastos', r._row, { 'Flags': finComputeFlags_(merged, finLinesOut_(r['Expense ID']), finConfig_()) });
  });
  const invPatch = { 'Expense IDs': all.join(','), 'Match Status': 'Confirmado', 'Scope': scope };
  if (!inv['Vendor ID'] && exps[0] && exps[0]['Vendor ID']) invPatch['Vendor ID'] = exps[0]['Vendor ID'];
  finUpdate_('Facturas', inv._row, invPatch);
  const vId = invPatch['Vendor ID'] || inv['Vendor ID'];
  if (vId && inv['RFC Emisor']) {   // learn the vendor's RFC once, from a confirmed match
    const v = finVendorById_(vId);
    if (v && !v['RFC']) finUpdate_('Proveedores', v._row, { 'RFC': inv['RFC Emisor'] });
  }
  finRead_('Archivos').rows.forEach(r => { if (r['Invoice ID'] === inv['Invoice ID']) finUpdate_('Archivos', r._row, { 'Scope': scope }); });
  logAuditEvent('fin_link_invoice', 'Factura', inv['Invoice ID'], { expenses: all, diff: diff });
  return jsonResponse({ result: 'ok', invoice: finInvoiceOut_(Object.assign({}, inv, invPatch)) });
}

// Internal: used by unlink, void invoice and void expense.
function finUnlinkExpenseFromInvoice_(invoiceId, expenseId) {
  const inv = finRead_('Facturas').rows.find(r => r['Invoice ID'] === invoiceId);
  if (!inv) return;
  const left = String(inv['Expense IDs'] || '').split(',').map(s => s.trim()).filter(s => s && s !== expenseId);
  finUpdate_('Facturas', inv._row, { 'Expense IDs': left.join(','), 'Match Status': left.length ? 'Confirmado' : 'Sin vincular' });
}

function finUnlinkInvoiceAction(body, identity) {
  const caps = resolveCaps(identity);
  if (!caps['finance.invoices']) return finDenied_();
  const ex = finFindExpenseRow_(finStr_(body.expense_id));
  if (!ex || !ex['Invoice ID'] || !finCanSeeExpense_(ex, identity, caps)) return finErr_('Ese gasto no tiene factura vinculada.');   // TROUBLESHOOT: a required field was empty or malformed; the browser form normally prevents this
  if (finIsClosed_(ex['Periodo'])) return finErr_('El mes ' + ex['Periodo'] + ' está cerrado. Un admin debe reabrirlo.');   // TROUBLESHOOT: the period is closed in the Cierres tab; an admin reopens it in Finanzas > Cierre
  const vendor = finVendorById_(ex['Vendor ID']);
  const patch = { 'Invoice ID': '', 'Estado Factura': 'Pendiente', 'Requiere Factura': 'Sí', 'Fecha Límite Factura': finInvoiceDeadline_(ex['Fecha Compra'], vendor), 'Editado Por': personKey_(identity), 'Editado En': finNow_() };
  finUnlinkExpenseFromInvoice_(ex['Invoice ID'], ex['Expense ID']);
  finUpdate_('Gastos', ex._row, patch);
  logAuditEvent('fin_unlink_invoice', 'Gasto', ex['Expense ID'], { invoice: ex['Invoice ID'] });
  return jsonResponse({ result: 'ok' });
}

function finVoidInvoiceAction(body, identity) {
  const caps = resolveCaps(identity);
  if (!caps['finance.void']) return finDenied_();
  const inv = finRead_('Facturas').rows.find(r => r['Invoice ID'] === finStr_(body.invoice_id));
  if (!inv || inv['Status'] !== 'Activa') return finErr_('No se encontró esa factura.');   // TROUBLESHOOT: the id the browser sent is not in the tab, or the person's scopes hide it; check the id in the Finanzas sheet
  const reason = finStr_(body.reason);
  if (!reason) return finErr_('Escribe el motivo de la anulación.');   // TROUBLESHOOT: a required field was empty or malformed; the browser form normally prevents this
  String(inv['Expense IDs'] || '').split(',').map(s => s.trim()).filter(Boolean).forEach(id => {
    const ex = finFindExpenseRow_(id);
    if (ex && ex['Invoice ID'] === inv['Invoice ID']) {
      const vendor = finVendorById_(ex['Vendor ID']);
      finUpdate_('Gastos', ex._row, { 'Invoice ID': '', 'Estado Factura': 'Pendiente', 'Fecha Límite Factura': finInvoiceDeadline_(ex['Fecha Compra'], vendor) });
    }
  });
  finUpdate_('Facturas', inv._row, { 'Status': 'Anulada', 'Expense IDs': '', 'Match Status': 'Sin vincular', 'Flags': (inv['Flags'] ? inv['Flags'] + ',' : '') + 'ANULADA:' + reason.slice(0, 40) });
  logAuditEvent('fin_void_invoice', 'Factura', inv['Invoice ID'], { reason: reason });
  return jsonResponse({ result: 'ok' });
}

function finListInvoicesGet_(p, identity) {
  const caps = resolveCaps(identity);
  if (!caps['finance.invoices']) return finDenied_();
  let rows = finRead_('Facturas').rows.filter(r => r['Status'] === 'Activa' && finCanSeeScope_(r['Scope'], caps));
  if (p.match === 'sin_vincular') rows = rows.filter(r => r['Match Status'] !== 'Confirmado');
  rows.sort((a, b) => String(b['Fecha Emisión']).localeCompare(String(a['Fecha Emisión'])));
  const out = rows.slice(0, 300).map(r => {
    const o = finInvoiceOut_(r);
    if (r['Match Status'] !== 'Confirmado') {
      o.suggestions = finInvoiceCandidates_(r, r['Vendor ID'], identity, caps);
    }
    return o;
  });
  return jsonResponse({ rows: out, count: rows.length });
}
