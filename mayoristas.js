/* ============================================================================
   mayoristas.js — wholesale channel.
   Views: Pedidos (active order flow, default) · Clientes · Listas · Resumen.
   Tiers are computed here, live, from history + settings — never stored —
   so settings changes apply retroactively. A saved order keeps the discount
   % it was saved with until someone re-applies it.
   Data is cached in localStorage and shown instantly; a fresh copy is
   fetched in the background on every visit.
   ==========================================================================*/

const MAY_ALLOWED_EXTRA = ['KARIN'];
const STATUSES = ['Cotización', 'Apartado', 'Listo', 'Pagado', 'Enviado', 'Cancelado'];
const LEGACY_STATUS = { 'Anticipo': 'Apartado', 'Liquidado': 'Pagado' };
const ACTIVE = ['Cotización', 'Apartado', 'Listo', 'Pagado'];
const COUNTING = ['Apartado', 'Listo', 'Pagado', 'Enviado'];   // confirmed orders count toward history
const NEXT_STATUS = { 'Cotización': 'Apartado', 'Apartado': 'Listo', 'Listo': 'Pagado', 'Pagado': 'Enviado' };
const CACHE_KEY = 'vp_may_data_v2';
const PRODUCTS_KEY = 'vp_may_products_v1';
const UPLOAD_FOLDER = 'velpapier/mayoreo';

let S = null;            // settings
let CLIENTES = [];       // Mayoreo Clientes rows
let ORDERS = [];         // Mayoreo Orders rows (+ .items)
let PLANTILLAS = [];     // Mayoreo Plantillas rows
let TT = {};             // Customer ID -> TikTok spend (only when it counts)
let ALL_CUST = null;     // full Customers list, loaded lazily for the picker
let PRODUCTS = null;     // catalog names for autocomplete, loaded lazily
let VIEW = localStorage.getItem('vp_may_view') || 'pedidos';
let FILTER = 'Activos';

const $ = id => document.getElementById(id);
const money = n => VP.mxn(Math.round(Number(n) || 0));
const today = () => {
  const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 10);
};
const esc = s => VP.esc(s);

/* ── Init / load ──────────────────────────────────────────────────────── */

(async function init() {
  try {
    await VP.ensureToken();
    const name = (VP.getUserName ? VP.getUserName() : '').toUpperCase();
    if (VP.getRole() !== 'admin' && MAY_ALLOWED_EXTRA.indexOf(name) < 0) {
      window.location.href = 'pedidos.html';
      return;
    }
    VP.mountNav('mayoristas');
    $('may-search').addEventListener('input', render);
    $('may-settings').addEventListener('click', openSettings);
    $('may-new-client').addEventListener('click', openNewClient);
    $('may-new-quote').addEventListener('click', () => pickClient(cid => openEditor(null, cid)));
    document.querySelectorAll('#may-view [data-view]').forEach(b => b.addEventListener('click', () => {
      VIEW = b.dataset.view; localStorage.setItem('vp_may_view', VIEW); render();
    }));
    window.addEventListener('resize', () => { if (VIEW === 'resumen') VP.paintCharts(); });

    // Instant paint from cache, then refresh in the background.
    try {
      const cached = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null');
      if (cached) { applyData(cached); render(); }
    } catch (e) { /* corrupt cache: ignore */ }
    await load();
  } catch (e) {
    console.error(e);
  }
})();

function applyData(data) {
  S = data.settings;
  CLIENTES = data.clientes || [];
  ORDERS = (data.orders || []).map(normalizeOrder);
  PLANTILLAS = data.plantillas || [];
  TT = data.tiktok_spend || {};
}

async function load() {
  try {
    const data = await VP.get('action=mayoreo_data');
    try { localStorage.setItem(CACHE_KEY, JSON.stringify(data)); } catch (e) { /* quota: fine */ }
    applyData(data);
    render();
  } catch (e) {
    if (!S) $('may-content').innerHTML = `<div class="may-empty">Error al cargar: ${esc(e.message)}</div>`;
    else VP.toast('No se pudo actualizar: ' + e.message, true);
  }
}

function normalizeOrder(o) {
  if (LEGACY_STATUS[o['Status']]) o['Status'] = LEGACY_STATUS[o['Status']];
  if (!Array.isArray(o['Pagos'])) o['Pagos'] = [];
  // Pre-v2 orders kept two fixed payment fields -- fold them into the log.
  if (!o['Pagos'].length) {
    if (Number(o['Anticipo Monto'])) o['Pagos'].push({ fecha: o['Anticipo Fecha'] || o['Fecha'], monto: Number(o['Anticipo Monto']), concepto: 'Anticipo', comprobante: '' });
    if (Number(o['Liquidación Monto'])) o['Pagos'].push({ fecha: o['Liquidación Fecha'] || o['Fecha'], monto: Number(o['Liquidación Monto']), concepto: 'Liquidación', comprobante: '' });
  }
  if (!Array.isArray(o['Status Historial'])) o['Status Historial'] = [];
  if (!Array.isArray(o['PDF Historial'])) o['PDF Historial'] = [];
  if (!Array.isArray(o.items)) o.items = [];
  return o;
}

/* ── Clients ──────────────────────────────────────────────────────────── */

function cliente(cid) { return CLIENTES.find(c => String(c['Customer ID']) === String(cid)) || null; }
function custName(cid) {
  const c = cliente(cid);
  return (c && (c['Nombre'] || c['Usuario'])) || cid;
}
function custUser(cid) {
  const c = cliente(cid);
  return c && c['Usuario'] ? '@' + String(c['Usuario']).replace(/^@/, '') : '';
}
function firstName(cid) { return String(custName(cid)).split(' ')[0]; }

function waLink(phone, text) {
  let d = String(phone || '').replace(/\D/g, '');
  if (!d) return '';
  if (d.length === 10) d = '52' + d;
  return 'https://wa.me/' + d + (text ? '?text=' + encodeURIComponent(text) : '');
}

/* ── Money / status helpers ───────────────────────────────────────────── */

function paid(o) { return (o['Pagos'] || []).reduce((s, p) => s + (Number(p.monto) || 0), 0); }
function due(o) { return (Number(o['Total']) || 0) + (Number(o['Envío']) || 0); }
function pending(o) { return Math.max(0, due(o) - paid(o)); }

function statusSince(o) {
  const h = (o['Status Historial'] || []).filter(x => x.status === o['Status']);
  return h.length ? String(h[h.length - 1].fecha).slice(0, 10) : String(o['Fecha'] || '');
}
function daysSince(dateStr, ref) {
  if (!dateStr) return Infinity;
  return Math.floor((new Date(ref || today()) - new Date(String(dateStr).slice(0, 10))) / 86400000);
}
function businessDaysSince(dateStr) {
  if (!dateStr) return 0;
  const d = new Date(String(dateStr).slice(0, 10)), end = new Date(today());
  let n = 0;
  while (d < end) { d.setDate(d.getDate() + 1); const w = d.getDay(); if (w !== 0 && w !== 6) n++; }
  return n;
}

// Waiting indicator for an order: { text, cls } or null.
function waitFlag(o) {
  const st = o['Status'], since = statusSince(o);
  const d = daysSince(since);
  if (st === 'Cotización') {
    const valid = Number(S.pdf_validity_days) || 0;
    if (valid && d > valid) return { text: `vencida (${d} días)`, cls: 'red' };
    if (d >= (Number(S.quote_followup_days) || 3)) return { text: `sin respuesta hace ${d} días`, cls: '' };
    return { text: d === 0 ? 'enviada hoy' : `enviada hace ${d} día${d === 1 ? '' : 's'}`, cls: 'grey' };
  }
  if (st === 'Apartado') {
    const b = businessDaysSince(since), lim = Number(S.prep_days) || 7;
    if (b > lim) return { text: `retrasado · día hábil ${b} de ${lim}`, cls: 'red' };
    if (b >= lim - 1) return { text: `día hábil ${b} de ${lim}`, cls: '' };
    return { text: `preparando · día ${b} de ${lim}`, cls: 'grey' };
  }
  if (st === 'Listo') {
    if (d >= (Number(S.quote_followup_days) || 3)) return { text: `esperando pago hace ${d} días`, cls: '' };
    return { text: 'esperando pago', cls: 'grey' };
  }
  if (st === 'Pagado') return { text: d >= 2 ? `por enviar hace ${d} días` : 'por enviar', cls: d >= 2 ? '' : 'grey' };
  return null;
}

/* ── Tier engine ──────────────────────────────────────────────────────── */

function tiersSorted() { return (S.tiers || []).slice().sort((a, b) => a.min - b.min); }
function tierForAmount(amount) { let t = null; tiersSorted().forEach(x => { if (amount >= x.min) t = x; }); return t; }
function tierByNivel(n) { return tiersSorted().find(t => Number(t.nivel) === Number(n)) || null; }
function orderValueForHistory(o) { return S.history_basis === 'before' ? Number(o['Subtotal']) || 0 : Number(o['Total']) || 0; }

function countingOrders(cid, excludeId, beforeDate) {
  return ORDERS.filter(o =>
    String(o['Customer ID']) === String(cid) &&
    COUNTING.indexOf(o['Status']) >= 0 &&
    String(o['Mayoreo ID']) !== String(excludeId || '') &&
    (!beforeDate || String(o['Fecha'] || '') <= beforeDate));
}

function historyFor(cid, excludeId, beforeDate) {
  const cl = cliente(cid);
  const inicial = cl ? Number(cl['Saldo Histórico Inicial']) || 0 : 0;
  const may = countingOrders(cid, excludeId, beforeDate).reduce((s, o) => s + orderValueForHistory(o), 0);
  const tt = S.count_tiktok ? (Number(TT[cid]) || 0) : 0;
  return { inicial, may, tt, total: inicial + may + tt };
}

function lastOrderDate(cid, excludeId) {
  const d = countingOrders(cid, excludeId).map(o => String(o['Fecha'] || '')).filter(Boolean).sort();
  return d.length ? d[d.length - 1] : '';
}

// opts: { excludeId, orderDate, orderSubtotal }
function tierInfo(cid, opts) {
  opts = opts || {};
  const hist = historyFor(cid, opts.excludeId, opts.orderDate);
  let amount = hist.total;
  if (S.current_counts && opts.orderSubtotal) amount += Number(opts.orderSubtotal) || 0;
  const isOpening = hist.total === 0 && opts.orderSubtotal !== undefined;
  let tier = tierForAmount(amount);
  if (!tier && isOpening && tierForAmount(Number(opts.orderSubtotal) || 0)) tier = tiersSorted()[0];

  const last = lastOrderDate(cid, opts.excludeId);
  const lapsed = !!last && daysSince(last, opts.orderDate) > (Number(S.lapse_days) || 30);
  let effective = tier;
  if (lapsed && tier && tier.nivel > 1) {
    if (S.lapse_rule === 'drop_one') effective = tierByNivel(tier.nivel - 1) || tier;
    if (S.lapse_rule === 'drop_to_1') effective = tiersSorted()[0];
  }
  const cl = cliente(cid);
  const manualN = cl && cl['Nivel Manual'] !== '' && cl['Nivel Manual'] !== undefined ? Number(cl['Nivel Manual']) : 0;
  const manual = manualN ? tierByNivel(manualN) : null;
  if (manual) effective = manual;

  const next = tiersSorted().find(t => t.min > hist.total) || null;
  return { hist, amount, calc: tier, tier: effective, manual: !!manual, lapsed, last, next,
    pct: effective ? Number(effective.pct) : 0, toNext: next ? next.min - hist.total : 0 };
}

function tierBadge(t) {
  const n = t ? t.nivel : 0;
  return `<span class="may-tier may-tier-${n}">${t ? 'Nivel ' + n + ' · ' + t.pct + '%' : 'Sin nivel'}</span>`;
}
function statusPill(st) { return `<span class="may-status may-st-${esc(st)}">${esc(st)}</span>`; }

/* ── Render router ────────────────────────────────────────────────────── */

function render() {
  if (!S) return;
  document.querySelectorAll('#may-view [data-view]').forEach(b => b.classList.toggle('is-active', b.dataset.view === VIEW));
  const active = ORDERS.filter(o => ACTIVE.indexOf(o['Status']) >= 0).length;
  $('may-count').textContent = `${active} pedido${active === 1 ? '' : 's'} activo${active === 1 ? '' : 's'} · ${CLIENTES.length} mayorista${CLIENTES.length === 1 ? '' : 's'}`;
  $('may-search').style.display = VIEW === 'resumen' ? 'none' : '';
  if (VIEW === 'clientes') renderClientes();
  else if (VIEW === 'listas') renderListas();
  else if (VIEW === 'resumen') renderResumen();
  else renderPedidos();
}

/* ── View: Pedidos ────────────────────────────────────────────────────── */

function renderPedidos() {
  const q = $('may-search').value.trim().toLowerCase();
  const thisMonth = today().slice(0, 7);
  const quotes = ORDERS.filter(o => o['Status'] === 'Cotización');
  const toCollect = ORDERS.filter(o => ['Apartado', 'Listo'].indexOf(o['Status']) >= 0 && pending(o) > 0);
  const toShip = ORDERS.filter(o => o['Status'] === 'Pagado');
  const monthSales = ORDERS.filter(o => COUNTING.indexOf(o['Status']) >= 0 && String(o['Fecha']).slice(0, 7) === thisMonth);

  const chips = ['Activos', ...STATUSES];
  const count = f => f === 'Activos' ? ORDERS.filter(o => ACTIVE.indexOf(o['Status']) >= 0).length : ORDERS.filter(o => o['Status'] === f).length;

  let list = ORDERS.filter(o => FILTER === 'Activos' ? ACTIVE.indexOf(o['Status']) >= 0 : o['Status'] === FILTER);
  if (q) list = ORDERS.filter(o => (o['Mayoreo ID'] + ' ' + custName(o['Customer ID']) + ' ' + custUser(o['Customer ID']) + ' ' + (o['Guía'] || '')).toLowerCase().includes(q));
  const order = { 'Cotización': 0, 'Apartado': 1, 'Listo': 2, 'Pagado': 3, 'Enviado': 4, 'Cancelado': 5 };
  list.sort((a, b) => FILTER === 'Activos' && !q
    ? (order[a['Status']] - order[b['Status']]) || String(statusSince(a)).localeCompare(String(statusSince(b)))
    : String(b['Fecha']).localeCompare(String(a['Fecha'])));

  $('may-content').innerHTML = `
    <div class="vp-stats may-stats">
      ${stat('Cotizaciones abiertas', money(quotes.reduce((s, o) => s + due(o), 0)), `${quotes.length} pedido${quotes.length === 1 ? '' : 's'}`)}
      ${stat('Por cobrar', money(toCollect.reduce((s, o) => s + pending(o), 0)), `${toCollect.length} apartado${toCollect.length === 1 ? '' : 's'} / listo${toCollect.length === 1 ? '' : 's'}`)}
      ${stat('Por enviar', String(toShip.length), toShip.length ? 'pagados, sin enviar' : 'todo al día')}
      ${stat('Ventas del mes', money(monthSales.reduce((s, o) => s + (Number(o['Total']) || 0), 0)), `${monthSales.length} pedido${monthSales.length === 1 ? '' : 's'} confirmado${monthSales.length === 1 ? '' : 's'}`)}
    </div>
    <div class="may-chips">${chips.map(f => `<button class="may-chip${FILTER === f && !q ? ' is-active' : ''}" data-filter="${f}">${f}<b>${count(f)}</b></button>`).join('')}</div>
    <div class="may-card">${list.length ? `<table class="vp-table may-tbl">
      <thead><tr><th>Pedido</th><th>Cliente</th><th>Estado</th><th>Total</th><th>Pendiente</th><th>Espera</th><th>Acciones</th></tr></thead>
      <tbody>${list.map(o => {
        const cid = String(o['Customer ID']);
        const f = waitFlag(o);
        const next = NEXT_STATUS[o['Status']];
        return `<tr class="vp-table-row-clickable" data-id="${esc(o['Mayoreo ID'])}">
          <td><b>${esc(o['Mayoreo ID'])}</b><div class="may-sub">${esc(o['Fecha'])}</div></td>
          <td><span class="may-link" data-client="${esc(cid)}">${esc(custName(cid))}</span><div class="may-sub">${tierBadge(tierInfo(cid).tier)}</div></td>
          <td>${statusPill(o['Status'])}</td>
          <td>${money(o['Total'])}</td>
          <td>${pending(o) ? money(pending(o)) : '<span class="may-sub">—</span>'}</td>
          <td>${f ? `<span class="may-flag ${f.cls}">${esc(f.text)}</span>` : ''}</td>
          <td><div class="may-acts">
            <button class="btn btn-sm" data-act="wa" title="WhatsApp">💬</button>
            ${o['PDF URL'] ? `<a class="btn btn-sm" href="${esc(o['PDF URL'])}" target="_blank" rel="noopener" data-act="pdf" title="Ver PDF" style="text-decoration:none">PDF</a>` : ''}
            ${ACTIVE.indexOf(o['Status']) >= 0 ? '<button class="btn btn-sm" data-act="pay" title="Registrar pago">$</button>' : ''}
            ${next ? `<button class="btn btn-sm" data-act="next" title="Mover a ${next}">→ ${next}</button>` : ''}
          </div></td>
        </tr>`;
      }).join('')}</tbody></table>` : `<div class="may-empty">${ORDERS.length ? 'No hay pedidos en esta vista.' : 'Aún no hay pedidos. Crea la primera cotización con “+ Cotización”.'}</div>`}</div>`;

  $('may-content').querySelectorAll('[data-filter]').forEach(b => b.onclick = () => { FILTER = b.dataset.filter; $('may-search').value = ''; render(); });
  $('may-content').querySelectorAll('tr[data-id]').forEach(tr => tr.addEventListener('click', e => {
    const o = ORDERS.find(x => x['Mayoreo ID'] === tr.dataset.id);
    const act = e.target.closest('[data-act]');
    const cl = e.target.closest('[data-client]');
    if (cl) { openClient(cl.dataset.client); return; }
    if (!act) { openEditor(o['Mayoreo ID']); return; }
    if (act.dataset.act === 'pdf') return;
    e.preventDefault();
    if (act.dataset.act === 'wa') openWhatsApp(o);
    if (act.dataset.act === 'pay') openPayment(o, null, async pago => quickPayment(o, pago));
    if (act.dataset.act === 'next') quickNext(o);
  }));
}

function stat(label, value, foot) {
  return `<div class="vp-stat"><div class="vp-stat-label">${esc(label)}</div><div class="vp-stat-value">${esc(value)}</div><div class="vp-stat-foot"><span class="vp-stat-sub">${esc(foot)}</span></div></div>`;
}

// Saves only the given header fields of an order (items untouched).
async function saveHead(o, fields) {
  await VP.post({ action: 'mayoreo_save_order', order: Object.assign({ 'Mayoreo ID': o['Mayoreo ID'], 'Customer ID': o['Customer ID'] }, fields) });
}

async function quickNext(o) {
  const next = NEXT_STATUS[o['Status']];
  if (!next) return;
  let msg = `¿Mover ${o['Mayoreo ID']} a ${next}?`;
  if (next === 'Apartado' && paid(o) < (Number(o['Total']) || 0) / 2) msg += `\n\nOjo: solo hay ${money(paid(o))} registrado de pagos (50% = ${money(o['Total'] / 2)}).`;
  if (next === 'Pagado' && pending(o) > 0) msg += `\n\nOjo: aún hay ${money(pending(o))} pendiente.`;
  if (next === 'Enviado' && !o['Guía']) msg += '\n\nAún no tiene número de guía (puedes agregarlo después).';
  if (!confirm(msg)) return;
  try { await saveHead(o, { 'Status': next }); VP.toast(`${o['Mayoreo ID']} → ${next}`); await load(); }
  catch (e) { VP.toast(e.message, true); }
}

// After a payment, suggest the matching status move (never automatic).
function suggestStatusAfterPayment(o, pagos) {
  const p = pagos.reduce((s, x) => s + (Number(x.monto) || 0), 0);
  const total = Number(o['Total']) || 0;
  if (o['Status'] === 'Cotización' && p >= total / 2 - 1) return 'Apartado';
  if (['Apartado', 'Listo'].indexOf(o['Status']) >= 0 && p >= due(o) - 1) return 'Pagado';
  return null;
}

async function quickPayment(o, pago) {
  const pagos = (o['Pagos'] || []).concat([pago]);
  const fields = { 'Pagos': pagos };
  const sug = suggestStatusAfterPayment(o, pagos);
  if (sug && confirm(`Pago registrado. ¿Mover ${o['Mayoreo ID']} a ${sug}?`)) fields['Status'] = sug;
  try { await saveHead(o, fields); VP.toast('Pago registrado'); await load(); }
  catch (e) { VP.toast(e.message, true); }
}

/* ── View: Clientes ───────────────────────────────────────────────────── */

function renderClientes() {
  const q = $('may-search').value.trim().toLowerCase();
  const rows = CLIENTES.map(c => {
    const cid = String(c['Customer ID']);
    return { cid, c, info: tierInfo(cid), act: ORDERS.filter(o => String(o['Customer ID']) === cid && ACTIVE.indexOf(o['Status']) >= 0).length };
  }).filter(r => !q || (custName(r.cid) + ' ' + custUser(r.cid) + ' ' + r.cid + ' ' + (r.c['Ciudad'] || '')).toLowerCase().includes(q))
    .sort((a, b) => b.info.hist.total - a.info.hist.total);

  const reDays = Number(S.reactivate_days) || 21;
  const react = rows.filter(r => r.info.last && daysSince(r.info.last) >= reDays && !r.act)
    .sort((a, b) => daysSince(b.info.last) - daysSince(a.info.last));

  $('may-content').innerHTML = `
    ${react.length ? `<div class="may-h3" style="margin-top:0">Por reactivar · sin compras hace ${reDays}+ días</div>
      <div class="may-react">${react.map(r => `<div class="may-react-item" data-client="${esc(r.cid)}">${esc(custName(r.cid))} · ${daysSince(r.info.last)} días${r.info.tier && r.info.tier.nivel > 1 ? ' · ' + 'Nivel ' + r.info.tier.nivel : ''}</div>`).join('')}</div>` : ''}
    <div class="may-card">${rows.length ? `<table class="vp-table may-tbl">
      <thead><tr><th>Cliente</th><th>Nivel</th><th>Historial</th><th>Siguiente nivel</th><th>Último pedido</th><th>Activos</th><th>Contacto</th></tr></thead>
      <tbody>${rows.map(r => {
        const i = r.info;
        const prog = i.next ? Math.min(100, Math.round(i.hist.total / i.next.min * 100)) : 100;
        const wa = waLink(r.c['Teléfono']);
        return `<tr class="vp-table-row-clickable" data-client="${esc(r.cid)}">
          <td><div class="vp-table-name">${esc(custName(r.cid))}</div><div class="may-sub">${esc(custUser(r.cid))} · ${esc(r.cid)}${r.c['Ciudad'] ? ' · ' + esc(r.c['Ciudad']) : ''}</div></td>
          <td>${tierBadge(i.tier)}${i.manual ? '<span class="may-flag grey">manual</span>' : ''}${i.lapsed && i.tier && i.tier.nivel > 1 ? '<span class="may-flag">inactivo</span>' : ''}</td>
          <td>${money(i.hist.total)}</td>
          <td>${i.next ? `<div class="may-sub">faltan ${money(i.toNext)} para Nivel ${i.next.nivel}</div><div class="may-progress"><div style="width:${prog}%"></div></div>` : '<span class="may-sub">Nivel máximo</span>'}</td>
          <td>${i.last ? esc(i.last) + `<div class="may-sub">hace ${daysSince(i.last)} días</div>` : '<span class="may-sub">—</span>'}</td>
          <td>${r.act || '<span class="may-sub">—</span>'}</td>
          <td>${wa ? `<a class="btn btn-sm" href="${esc(wa)}" target="_blank" rel="noopener" data-stop style="text-decoration:none">💬</a>` : '<span class="may-sub">sin teléfono</span>'}</td>
        </tr>`;
      }).join('')}</tbody></table>` : `<div class="may-empty">${CLIENTES.length ? 'Sin resultados.' : 'Aún no hay mayoristas. Agrega el primero con “+ Mayorista”.'}</div>`}</div>`;

  $('may-content').querySelectorAll('[data-client]').forEach(el => el.addEventListener('click', e => {
    if (e.target.closest('[data-stop]')) return;
    openClient(el.dataset.client);
  }));
}

/* ── Client modal (slim) + edit modal ─────────────────────────────────── */

function openClient(cid) {
  const c = cliente(cid) || {};
  const i = tierInfo(cid);
  const orders = ORDERS.filter(o => String(o['Customer ID']) === String(cid)).sort((a, b) => String(b['Fecha']).localeCompare(String(a['Fecha'])));
  const prog = i.next ? Math.min(100, Math.round(i.hist.total / i.next.min * 100)) : 100;
  const wa = waLink(c['Teléfono']);
  const addr = [c['Calle y Número'], c['Colonia'], c['Ciudad'], c['Estado'], c['CP']].filter(Boolean).join(', ');

  const m = VP.showModal(`
    <button class="may-edit-btn" id="cl-edit" title="Editar datos">✏️</button>
    <h2 class="may-h2">${esc(custName(cid))}</h2>
    <div class="may-sub">${esc(custUser(cid))} · ${esc(cid)} · mayorista desde ${esc(c['Fecha Alta'] || '—')}</div>
    <div style="margin-top:10px;display:flex;align-items:center;gap:10px;flex-wrap:wrap">
      ${tierBadge(i.tier)}${i.manual ? '<span class="may-flag grey">manual</span>' : ''}${i.lapsed && i.tier && i.tier.nivel > 1 ? `<span class="may-flag">sin compras hace ${daysSince(i.last)} días</span>` : ''}
      <span class="may-sub">Historial ${money(i.hist.total)}${i.next ? ` · faltan ${money(i.toNext)} para Nivel ${i.next.nivel}` : ' · nivel máximo'}</span>
    </div>
    ${i.next ? `<div class="may-progress" style="margin:8px 0 0;max-width:320px"><div style="width:${prog}%"></div></div>` : ''}
    <div style="margin-top:14px;display:flex;gap:14px;flex-wrap:wrap;font-size:13px">
      ${wa ? `<a class="may-link" href="${esc(wa)}" target="_blank" rel="noopener">💬 ${esc(c['Teléfono'])}</a>` : '<span class="may-sub">Sin teléfono</span>'}
      ${c['Email'] ? `<a class="may-link" href="mailto:${esc(c['Email'])}">${esc(c['Email'])}</a>` : ''}
      ${addr ? `<span class="may-sub">📦 ${esc(addr)}</span>` : ''}
      ${c['Requiere Factura'] === 'Sí' ? '<span class="may-flag grey">requiere factura</span>' : ''}
    </div>
    ${c['Notas'] ? `<div class="may-note" style="margin-top:8px">${esc(c['Notas'])}</div>` : ''}

    <div class="may-h3">Pedidos</div>
    ${orders.length ? `<table class="vp-table may-tbl"><thead><tr><th>Pedido</th><th>Fecha</th><th>Estado</th><th>Total</th><th>Pendiente</th><th>PDF</th></tr></thead><tbody>
      ${orders.map(o => `<tr class="vp-table-row-clickable" data-id="${esc(o['Mayoreo ID'])}">
        <td>${esc(o['Mayoreo ID'])}</td><td>${esc(o['Fecha'])}</td><td>${statusPill(o['Status'])}</td>
        <td>${money(o['Total'])}</td><td>${pending(o) && o['Status'] !== 'Cancelado' ? money(pending(o)) : '—'}</td>
        <td>${o['PDF URL'] ? `<a class="may-link" href="${esc(o['PDF URL'])}" target="_blank" rel="noopener" data-stop>v${esc(o['PDF Versión'])}</a>` : '—'}</td>
      </tr>`).join('')}</tbody></table>` : '<div class="may-sub">Sin pedidos todavía.</div>'}
    <div class="may-actions">
      ${orders.length ? '<button class="btn" id="cl-repeat">Repetir último pedido</button>' : ''}
      <button class="btn btn-primary" id="cl-new">+ Nueva cotización</button>
    </div>
  `, { maxWidth: '760px' });

  m.el.querySelector('#cl-edit').onclick = () => { m.close(); openClientEdit(cid, null, () => openClient(cid)); };
  m.el.querySelector('#cl-new').onclick = () => { m.close(); openEditor(null, cid); };
  const rep = m.el.querySelector('#cl-repeat');
  if (rep) rep.onclick = () => { m.close(); openEditor(null, cid, orders.find(o => o['Status'] !== 'Cancelado') || orders[0]); };
  m.el.querySelectorAll('tr[data-id]').forEach(tr => tr.addEventListener('click', e => {
    if (e.target.closest('[data-stop]')) return;
    m.close(); openEditor(tr.dataset.id);
  }));
}

const CLIENT_FIELDS = [
  ['Contacto', [['Nombre', 'Nombre', 'may-span2'], ['Teléfono', 'Teléfono / WhatsApp'], ['Email', 'Email']]],
  ['Dirección de envío', [['Calle y Número', 'Calle y número', 'may-span2'], ['Colonia', 'Colonia'], ['Ciudad', 'Ciudad'], ['Estado', 'Estado'], ['CP', 'CP'], ['Referencias', 'Referencias', 'may-span2'], ['Paquetería Preferida', 'Paquetería preferida']]],
  ['Facturación', [['Requiere Factura', 'Requiere factura', '', ['No', 'Sí']], ['Razón Social', 'Razón social', 'may-span2'], ['RFC', 'RFC'], ['Régimen Fiscal', 'Régimen fiscal'], ['CP Fiscal', 'CP fiscal'], ['Uso CFDI', 'Uso de CFDI']]],
];

// prefill: values for a brand-new mayorista (Customer ID, Usuario, Nombre).
function openClientEdit(cid, prefill, onDone) {
  const c = Object.assign({}, cliente(cid) || {}, prefill || {});
  const isNew = !cliente(cid);
  const field = ([key, label, cls, opts]) => `<label class="may-field ${cls || ''}">${esc(label)}${opts
    ? `<select class="vp-input" data-k="${esc(key)}">${opts.map(o => `<option ${String(c[key] || opts[0]) === o ? 'selected' : ''}>${o}</option>`).join('')}</select>`
    : `<input class="vp-input" data-k="${esc(key)}" value="${esc(c[key] || '')}">`}</label>`;

  const m = VP.showModal(`
    <h2 class="may-h2">${isNew ? 'Nuevo mayorista' : 'Editar ' + esc(custName(cid))}</h2>
    <div class="may-sub">${esc(c['Usuario'] ? '@' + c['Usuario'] : '')} · ${esc(cid)}</div>
    ${CLIENT_FIELDS.map(([title, fields]) => `<div class="may-h3">${title}</div><div class="may-grid">${fields.map(field).join('')}</div>`).join('')}
    <div class="may-h3">Programa de mayoreo</div>
    <div class="may-grid">
      <label class="may-field">Saldo histórico inicial<input class="vp-input" type="number" min="0" data-k="Saldo Histórico Inicial" value="${esc(c['Saldo Histórico Inicial'] || 0)}"></label>
      <label class="may-field">Nivel manual<select class="vp-input" data-k="Nivel Manual"><option value="">Automático</option>
        ${tiersSorted().map(t => `<option value="${t.nivel}" ${String(c['Nivel Manual']) === String(t.nivel) ? 'selected' : ''}>Nivel ${t.nivel} (${t.pct}%)</option>`).join('')}</select></label>
      <label class="may-field may-span2">Motivo del nivel manual<input class="vp-input" data-k="Nivel Manual Nota" value="${esc(c['Nivel Manual Nota'] || '')}"></label>
      <label class="may-field may-full">Notas<input class="vp-input" data-k="Notas" value="${esc(c['Notas'] || '')}"></label>
    </div>
    <div class="may-actions"><button class="btn btn-primary" id="ce-save">${isNew ? 'Agregar mayorista' : 'Guardar'}</button></div>
  `, { maxWidth: '760px' });

  m.el.querySelector('#ce-save').onclick = async () => {
    const out = { 'Customer ID': cid };
    if (c['Usuario']) out['Usuario'] = c['Usuario'];
    m.el.querySelectorAll('[data-k]').forEach(el => { out[el.dataset.k] = el.type === 'number' ? Number(el.value) || 0 : el.value.trim(); });
    if (out['Nivel Manual'] && !out['Nivel Manual Nota']) { VP.toast('Escribe el motivo del nivel manual', true); return; }
    if (!out['Nivel Manual']) out['Nivel Manual Nota'] = '';
    try {
      await VP.post({ action: 'mayoreo_save_cliente', cliente: out });
      VP.toast(isNew ? 'Mayorista agregado' : 'Guardado');
      m.close(); await load(); if (onDone) onDone();
    } catch (e) { VP.toast(e.message, true); }
  };
}

/* ── Pick / create mayorista ──────────────────────────────────────────── */

async function loadAllCustomers() {
  if (ALL_CUST) return ALL_CUST;
  const d = await VP.get('action=customers');
  ALL_CUST = d.records || [];
  return ALL_CUST;
}

// Pick an existing mayorista (for a new quote).
function pickClient(onPick) {
  if (!CLIENTES.length) { VP.toast('Primero agrega un mayorista', true); openNewClient(); return; }
  const m = VP.showModal(`
    <h2 class="may-h2">Nueva cotización</h2>
    <div class="may-note">¿Para qué mayorista?</div>
    <div class="may-combo" style="margin-top:12px">
      <input class="vp-input" id="pc-q" style="width:100%;box-sizing:border-box" placeholder="Buscar mayorista…" autocomplete="off">
      <div class="may-combo-list open" id="pc-list"></div>
    </div>
    <div style="height:230px"></div>
    <div class="may-note">¿No está en la lista? <span class="may-link" id="pc-new">Agregar nuevo mayorista</span></div>
  `, { maxWidth: '480px' });
  const q = m.el.querySelector('#pc-q'), list = m.el.querySelector('#pc-list');
  const draw = () => {
    const s = q.value.trim().toLowerCase();
    const hits = CLIENTES.filter(c => (custName(c['Customer ID']) + ' ' + custUser(c['Customer ID']) + ' ' + c['Customer ID']).toLowerCase().includes(s)).slice(0, 30);
    list.innerHTML = hits.map(c => `<div class="may-combo-item" data-cid="${esc(c['Customer ID'])}">${esc(custName(c['Customer ID']))} <span class="may-sub">${esc(custUser(c['Customer ID']))}</span></div>`).join('') || '<div class="may-combo-item may-sub">Sin coincidencias</div>';
    list.querySelectorAll('[data-cid]').forEach(el => el.onclick = () => { m.close(); onPick(el.dataset.cid); });
  };
  q.addEventListener('input', draw); draw();
  m.el.querySelector('#pc-new').onclick = () => { m.close(); openNewClient(); };
  setTimeout(() => q.focus(), 50);
}

function openNewClient() {
  const m = VP.showModal(`
    <h2 class="may-h2">Nuevo mayorista</h2>
    <div class="may-note">Busca al cliente existente. Si no existe, créalo con su usuario; los demás datos se completan después.</div>
    <div class="may-combo" style="margin-top:14px">
      <input class="vp-input" id="nc-q" style="width:100%;box-sizing:border-box" placeholder="Cargando clientes…" autocomplete="off" disabled>
      <div class="may-combo-list" id="nc-list"></div>
    </div>
    <div style="height:200px"></div>
    <div class="may-actions"><button class="btn" id="nc-create" disabled>Crear cliente nuevo con este usuario</button></div>
  `, { maxWidth: '520px' });
  const q = m.el.querySelector('#nc-q'), list = m.el.querySelector('#nc-list');
  const go = (cid, rec) => {
    m.close();
    if (cliente(cid)) { VP.toast('Ya es mayorista'); openClient(cid); return; }
    const full = [rec && rec['First Name'], rec && rec['Surname']].filter(Boolean).join(' ').trim();
    openClientEdit(cid, { 'Usuario': rec ? rec['Primary Username'] || '' : '', 'Nombre': full }, () => openClient(cid));
  };
  loadAllCustomers().then(all => {
    q.disabled = false; q.placeholder = 'Usuario, nombre o CUST-…'; q.focus();
    q.addEventListener('input', () => {
      const s = q.value.trim().toLowerCase();
      m.el.querySelector('#nc-create').disabled = s.length < 2;
      if (s.length < 2) { list.classList.remove('open'); return; }
      const hits = all.filter(c => [c['Customer ID'], c['Primary Username'], c['Aliases'], c['First Name'], c['Surname']].join(' ').toLowerCase().includes(s)).slice(0, 12);
      list.innerHTML = hits.map(c => `<div class="may-combo-item" data-cid="${esc(c['Customer ID'])}">@${esc(c['Primary Username'])} <span class="may-sub">${esc(c['Customer ID'])} ${esc([c['First Name'], c['Surname']].filter(Boolean).join(' '))}${cliente(c['Customer ID']) ? ' · ya es mayorista' : ''}</span></div>`).join('')
        || '<div class="may-combo-item may-sub">Sin coincidencias</div>';
      list.classList.add('open');
      list.querySelectorAll('[data-cid]').forEach(el => el.onclick = () => go(el.dataset.cid, all.find(c => c['Customer ID'] === el.dataset.cid)));
    });
  }).catch(e => VP.toast(e.message, true));
  m.el.querySelector('#nc-create').onclick = async () => {
    const u = q.value.trim().replace(/^@/, '');
    if (!confirm(`¿Crear cliente nuevo con usuario "${u}"?`)) return;
    try {
      const r = await VP.post({ action: 'create_customer', primary_username: u });
      const rec = (ALL_CUST || []).find(c => c['Customer ID'] === r.customer_id) || { 'Customer ID': r.customer_id, 'Primary Username': u };
      if (ALL_CUST && r.result !== 'exists') ALL_CUST.push(rec);
      VP.toast(r.result === 'exists' ? 'Ese usuario ya existía — seleccionado' : 'Cliente creado: ' + r.customer_id);
      go(r.customer_id, rec);
    } catch (e) { VP.toast(e.message, true); }
  };
}

/* ── WhatsApp ─────────────────────────────────────────────────────────── */

function fillTemplate(tpl, o) {
  const cid = o['Customer ID'];
  const map = {
    nombre: firstName(cid), pedido: o['Mayoreo ID'] || '', total: money(o['Total']),
    anticipo: money((Number(o['Total']) || 0) / 2), saldo: money(pending(o)),
    pdf: o['PDF URL'] || '', guia: o['Guía'] || '', paqueteria: o['Paquetería'] || '',
  };
  return String(tpl || '').replace(/\{(\w+)\}/g, (m, k) => (k in map ? map[k] : m));
}

function openWhatsApp(o) {
  const c = cliente(o['Customer ID']) || {};
  if (!c['Teléfono']) {
    VP.toast('Agrega el teléfono del mayorista', true);
    openClientEdit(o['Customer ID'], null, null);
    return;
  }
  const opts = [
    ['Cotización lista', S.wa_tpl_quote, 'Cotización'],
    ['Pedir anticipo', S.wa_tpl_deposit, 'Cotización'],
    ['Pedido listo · saldo', S.wa_tpl_ready, 'Listo'],
    ['Enviado · guía', S.wa_tpl_shipped, 'Enviado'],
  ];
  // The message that fits the current status goes first.
  const fit = { 'Cotización': 0, 'Apartado': 1, 'Listo': 2, 'Pagado': 3, 'Enviado': 3 }[o['Status']] || 0;
  const ordered = [opts[fit]].concat(opts.filter((x, i) => i !== fit));
  const m = VP.showModal(`
    <h2 class="may-h2">WhatsApp · ${esc(firstName(o['Customer ID']))}</h2>
    <div class="may-note" style="margin-bottom:12px">${esc(c['Teléfono'])} · ${esc(o['Mayoreo ID'])}</div>
    ${ordered.map(([label, tpl], i) => `<a class="btn may-wa-opt${i === 0 ? ' btn-primary' : ''}" href="${esc(waLink(c['Teléfono'], fillTemplate(tpl, o)))}" target="_blank" rel="noopener" style="text-decoration:none">
      <b>${esc(label)}</b><br><span style="opacity:.75;font-size:12px">${esc(fillTemplate(tpl, o))}</span></a>`).join('')}
    <a class="may-link" style="font-size:12.5px" href="${esc(waLink(c['Teléfono']))}" target="_blank" rel="noopener">Abrir chat sin mensaje</a>
  `, { maxWidth: '520px' });
  m.el.querySelectorAll('a').forEach(a => a.addEventListener('click', () => setTimeout(m.close, 100)));
}

/* ── Payments ─────────────────────────────────────────────────────────── */

// onSave(pago) receives { fecha, monto, concepto, comprobante }.
function openPayment(o, total, onSave) {
  const p = paid(o);
  const totalNow = total !== null && total !== undefined ? total : Number(o['Total']) || 0;
  const suggest = p === 0 ? Math.round(totalNow / 2) : Math.max(0, Math.round(totalNow + (Number(o['Envío']) || 0) - p));
  const m = VP.showModal(`
    <h2 class="may-h2">Registrar pago</h2>
    <div class="may-sub">${esc(o['Mayoreo ID'] || 'Pedido nuevo')} · ${esc(custName(o['Customer ID']))} · pagado ${money(p)} de ${money(totalNow + (Number(o['Envío']) || 0))}</div>
    <div class="may-grid" style="margin-top:14px">
      <label class="may-field">Monto<input class="vp-input" type="number" min="0" id="py-monto" value="${suggest}"></label>
      <label class="may-field">Fecha<input class="vp-input" type="date" id="py-fecha" value="${today()}"></label>
      <label class="may-field">Concepto<select class="vp-input" id="py-concepto">
        ${['Anticipo', 'Liquidación', 'Envío', 'Otro'].map(x => `<option ${(p === 0 ? 'Anticipo' : 'Liquidación') === x ? 'selected' : ''}>${x}</option>`).join('')}</select></label>
    </div>
    <label class="may-field" style="margin-top:10px">Comprobante (captura o PDF de la transferencia)
      <input class="vp-input" type="file" id="py-file" accept="image/*,application/pdf"></label>
    <div class="may-actions"><button class="btn btn-primary" id="py-save">Guardar pago</button></div>
  `, { maxWidth: '520px' });
  m.el.querySelector('#py-save').onclick = async e => {
    const btn = e.target;
    const monto = Number(m.el.querySelector('#py-monto').value) || 0;
    if (monto <= 0) { VP.toast('Monto inválido', true); return; }
    btn.disabled = true; btn.textContent = 'Guardando…';
    try {
      const f = m.el.querySelector('#py-file').files[0];
      const comprobante = f ? await uploadAny(f) : '';
      const pago = { fecha: m.el.querySelector('#py-fecha').value, monto, concepto: m.el.querySelector('#py-concepto').value, comprobante };
      m.close();
      await onSave(pago);
    } catch (err) { VP.toast(err.message, true); btn.disabled = false; btn.textContent = 'Guardar pago'; }
  };
}

async function uploadAny(file) {
  if (/^image\//.test(file.type)) { const r = await uploadPhoto(file, UPLOAD_FOLDER); return r.url; }
  return uploadRaw(file, file.name || 'archivo.pdf');
}

async function uploadRaw(blob, name) {
  const sig = await VP.get('action=get_upload_signature&folder=' + encodeURIComponent(UPLOAD_FOLDER));
  const fd = new FormData();
  fd.append('file', blob, name);
  fd.append('api_key', sig.api_key);
  fd.append('timestamp', sig.timestamp);
  fd.append('folder', sig.folder);
  fd.append('signature', sig.signature);
  const r = await fetch(`https://api.cloudinary.com/v1_1/${sig.cloud}/raw/upload`, { method: 'POST', body: fd });
  const j = await r.json();
  if (!r.ok || !j.secure_url) throw new Error('No se pudo subir el archivo: ' + ((j.error && j.error.message) || r.status));
  return j.secure_url;
}

/* ── Products (autocomplete) ──────────────────────────────────────────── */

async function ensureProducts() {
  if (PRODUCTS) return PRODUCTS;
  try {
    const c = JSON.parse(localStorage.getItem(PRODUCTS_KEY) || 'null');
    if (c && Date.now() - c.t < 12 * 3600 * 1000) PRODUCTS = c.list;
  } catch (e) { /* ignore */ }
  if (!PRODUCTS) {
    try {
      const d = await VP.get('action=mayoreo_products');
      PRODUCTS = d.products || [];
      try { localStorage.setItem(PRODUCTS_KEY, JSON.stringify({ t: Date.now(), list: PRODUCTS })); } catch (e) {}
    } catch (e) { PRODUCTS = []; }
  }
  fillDatalist();
  return PRODUCTS;
}

function fillDatalist() {
  const names = new Set();
  ORDERS.forEach(o => o.items.forEach(it => it['Artículo'] && names.add(String(it['Artículo']))));
  (PRODUCTS || []).forEach(p => names.add(p.name));
  $('may-products').innerHTML = [...names].sort().map(n => `<option value="${esc(n)}">`).join('');
}

// Last price this client paid for an item (else anyone), newest order first.
function lastPrice(name, cid) {
  const n = String(name).trim().toLowerCase();
  const sorted = ORDERS.slice().sort((a, b) => String(b['Fecha']).localeCompare(String(a['Fecha'])));
  for (const pass of [cid, null]) {
    for (const o of sorted) {
      if (pass && String(o['Customer ID']) !== String(pass)) continue;
      const it = o.items.find(x => String(x['Artículo']).trim().toLowerCase() === n);
      if (it && Number(it['Precio Unitario'])) return Number(it['Precio Unitario']);
    }
  }
  return 0;
}

/* ── Order editor ─────────────────────────────────────────────────────── */

function blankItem() { return { 'Artículo': '', 'Cantidad': 1, 'Precio Unitario': 0, 'Catálogo': 'Regular', 'Catalog ID': '', _tienda: '' }; }
function isLowQty(it) {
  return it['Catálogo'] !== 'Especial' && !!String(it['Artículo'] || '').trim() && (Number(it['Cantidad']) || 0) < (Number(S.min_pieces) || 0);
}

// id: existing order · cidForNew: client for a new one · copyFrom: order to repeat.
function openEditor(id, cidForNew, copyFrom) {
  const src = id ? ORDERS.find(o => String(o['Mayoreo ID']) === String(id)) : null;
  const cidNew = cidForNew || (copyFrom && copyFrom['Customer ID']);
  const cl0 = cliente(src ? src['Customer ID'] : cidNew) || {};
  const o = src ? JSON.parse(JSON.stringify(src)) : {
    'Mayoreo ID': '', 'Customer ID': cidNew, 'Fecha': today(), 'Status': 'Cotización',
    'Descuento Origen': 'auto', 'Envío': 0, 'Pagos': [], 'Status Historial': [], 'PDF Historial': [],
    'Paquetería': cl0['Paquetería Preferida'] || '', 'Factura': cl0['Requiere Factura'] === 'Sí' ? 'Pendiente' : '',
    items: copyFrom ? copyFrom.items.map(it => ({ 'Artículo': it['Artículo'], 'Cantidad': Number(it['Cantidad']) || 0, 'Precio Unitario': Number(it['Precio Unitario']) || 0, 'Catálogo': it['Catálogo'] || 'Regular', 'Catalog ID': it['Catalog ID'] || '' })) : [blankItem()],
  };
  if (!o.items.length) o.items = [blankItem()];
  const cid = String(o['Customer ID']);
  let manualPct = o['Descuento Origen'] === 'manual' ? Number(o['Descuento %']) : null;
  let dirty = false;

  const m = VP.showModal(`<div id="ed-root"></div>`, { maxWidth: '980px' });
  const root = m.el.querySelector('#ed-root');
  ensureProducts();

  function calc() {
    const line = it => (Number(it['Cantidad']) || 0) * (Number(it['Precio Unitario']) || 0);
    const regSub = o.items.filter(it => it['Catálogo'] !== 'Especial').reduce((s, it) => s + line(it), 0);
    const espSub = o.items.filter(it => it['Catálogo'] === 'Especial').reduce((s, it) => s + line(it), 0);
    const info = tierInfo(cid, { excludeId: o['Mayoreo ID'], orderDate: o['Fecha'], orderSubtotal: regSub + espSub });
    const pct = manualPct !== null && !isNaN(manualPct) ? manualPct : info.pct;
    const desc = Math.round(regSub * pct / 100);
    const total = Math.round(regSub + espSub - desc);
    const pieces = o.items.reduce((s, it) => s + (Number(it['Cantidad']) || 0), 0);
    return { regSub, espSub, sub: regSub + espSub, info, pct, desc, total, pieces };
  }

  function focusKey() {
    const a = document.activeElement;
    if (!a || !root.contains(a)) return null;
    const tr = a.closest('tr[data-n]');
    return { n: tr ? tr.dataset.n : null, i: a.dataset.i, f: a.dataset.f, id: a.id };
  }
  function restoreFocus(k) {
    if (!k) return;
    let el = null;
    if (k.n !== null && k.i) el = root.querySelector(`tr[data-n="${k.n}"] [data-i="${k.i}"]`);
    else if (k.f) el = root.querySelector(`[data-f="${k.f}"]`);
    else if (k.id) el = root.querySelector('#' + k.id);
    if (el) el.focus();
  }
  const later = () => setTimeout(render, 0);

  function render() {
    const fk = focusKey();
    const c = calc();
    const pctMode = S.especial_mode === 'percent';
    const lows = o.items.filter(isLowQty).length;
    const pagos = o['Pagos'] || [];
    const oc = Object.assign({}, o, { 'Total': c.total });
    const wantsFactura = (cliente(cid) || {})['Requiere Factura'] === 'Sí' || o['Factura'];
    const sh = (o['Status Historial'] || []).map(h => `${esc(h.status)} ${esc(String(h.fecha).slice(5, 10).split('-').reverse().join('/'))}`).join(' → ');
    const packs = PLANTILLAS.filter(p => p['Tipo'] === 'Pack' && p['Activa'] !== 'No');
    const esps = PLANTILLAS.filter(p => p['Tipo'] === 'Especial' && p['Activa'] !== 'No' && (!p['Vence'] || p['Vence'] >= today()));
    root.innerHTML = `
      <h2 class="may-h2">${o['Mayoreo ID'] ? 'Pedido ' + esc(o['Mayoreo ID']) : 'Nueva cotización'}</h2>
      <div class="may-sub"><span class="may-link" id="ed-client">${esc(custName(cid))}</span> ${esc(custUser(cid))} · ${esc(cid)} · ${tierBadge(c.info.tier)}
        ${c.info.lapsed && c.info.calc && c.info.calc.nivel > 1 ? `<span class="may-flag">sin compras hace ${daysSince(c.info.last, o['Fecha'])} días</span>` : ''}</div>
      ${sh ? `<div class="may-note">${sh}</div>` : ''}

      <div class="may-grid" style="margin-top:14px">
        <label class="may-field">Fecha<input class="vp-input" type="date" data-f="Fecha" value="${esc(o['Fecha'])}"></label>
        <label class="may-field">Estado<select class="vp-input" data-f="Status">${STATUSES.map(s => `<option ${o['Status'] === s ? 'selected' : ''}>${s}</option>`).join('')}</select></label>
        ${wantsFactura ? `<label class="may-field">Factura<select class="vp-input" data-f="Factura">${['', 'Pendiente', 'Emitida', 'Enviada'].map(s => `<option value="${s}" ${(o['Factura'] || '') === s ? 'selected' : ''}>${s || '—'}</option>`).join('')}</select></label>` : ''}
      </div>

      <div class="may-h3">Artículos · ${c.pieces} piezas${lows ? ` <span class="may-warn">· ${lows} con menos de ${S.min_pieces} piezas</span>` : ''}</div>
      <div style="overflow-x:auto"><table class="may-items">
        <colgroup><col><col style="width:84px">${pctMode ? '<col style="width:110px">' : ''}<col style="width:112px"><col style="width:112px"><col style="width:112px"><col style="width:36px"></colgroup>
        <thead><tr><th>Artículo</th><th>Piezas</th>${pctMode ? '<th>Precio tienda</th>' : ''}<th>Precio unit.</th><th>Importe</th><th>Catálogo</th><th></th></tr></thead>
        <tbody>${o.items.map((it, n) => `<tr data-n="${n}">
            <td><input class="vp-input" data-i="Artículo" list="may-products" value="${esc(it['Artículo'])}" placeholder="Nombre del producto"></td>
            <td><input class="vp-input${isLowQty(it) ? ' may-low' : ''}" type="number" min="0" data-i="Cantidad" value="${esc(it['Cantidad'])}"${isLowQty(it) ? ` title="Menos de ${S.min_pieces} piezas por modelo"` : ''}></td>
            ${pctMode ? `<td>${it['Catálogo'] === 'Especial' ? `<input class="vp-input" type="number" min="0" data-i="_tienda" value="${esc(it._tienda || '')}" placeholder="-${S.especial_default_pct}%">` : ''}</td>` : ''}
            <td><input class="vp-input" type="number" min="0" step="0.01" data-i="Precio Unitario" value="${esc(it['Precio Unitario'])}"></td>
            <td>${money((Number(it['Cantidad']) || 0) * (Number(it['Precio Unitario']) || 0))}</td>
            <td><select class="vp-input" data-i="Catálogo"><option ${it['Catálogo'] !== 'Especial' ? 'selected' : ''}>Regular</option><option ${it['Catálogo'] === 'Especial' ? 'selected' : ''}>Especial</option></select></td>
            <td><button class="btn btn-xs" data-del="${n}" tabindex="-1" title="Quitar">✕</button></td>
          </tr>`).join('')}</tbody></table></div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px">
        <button class="btn btn-sm" id="ed-add">+ Agregar artículo</button>
        ${packs.length ? '<button class="btn btn-sm" id="ed-pack">Cargar Pack Inicial</button>' : ''}
        ${esps.length ? '<button class="btn btn-sm" id="ed-esp">Agregar de lista especial</button>' : ''}
      </div>

      <div style="display:flex;gap:28px;flex-wrap:wrap;margin-top:18px">
        <div style="flex:1.3;min-width:300px">
          <div class="may-grid">
            <label class="may-field">Descuento %<input class="vp-input" type="number" min="0" max="100" id="ed-pct" value="${c.pct}"></label>
            <label class="may-field">Envío<input class="vp-input" type="number" min="0" data-f="Envío" value="${esc(o['Envío'] || 0)}"></label>
          </div>
          ${manualPct !== null ? `<label class="may-field" style="margin-top:8px">Motivo del descuento manual (auto: ${c.info.pct}%)
            <input class="vp-input" data-f="Descuento Nota" value="${esc(o['Descuento Nota'] || '')}"></label>
            <button class="btn btn-xs" id="ed-auto" style="margin-top:6px">Volver al automático</button>` : ''}

          <div class="may-h3">Pagos</div>
          ${pagos.length ? `<table class="may-pays"><tbody>${pagos.map((p, n) => `<tr>
            <td>${esc(p.concepto)}</td><td>${esc(p.fecha)}</td><td>${money(p.monto)}</td>
            <td>${p.comprobante ? `<a class="may-link" href="${esc(p.comprobante)}" target="_blank" rel="noopener">comprobante</a>` : '<span class="may-sub">sin comprobante</span>'}</td>
            <td><button class="btn btn-xs" data-delpay="${n}" title="Quitar pago">✕</button></td></tr>`).join('')}</tbody></table>` : '<div class="may-sub">Sin pagos registrados.</div>'}
          <button class="btn btn-sm" id="ed-pay" style="margin-top:8px">+ Registrar pago</button>

          <div class="may-h3">Envío</div>
          <div class="may-grid">
            <label class="may-field">Paquetería<input class="vp-input" data-f="Paquetería" value="${esc(o['Paquetería'] || '')}"></label>
            <label class="may-field">Guía<input class="vp-input" data-f="Guía" value="${esc(o['Guía'] || '')}"></label>
          </div>
          <div style="margin-top:8px;font-size:13px">${o['Etiqueta URL'] ? `<a class="may-link" href="${esc(o['Etiqueta URL'])}" target="_blank" rel="noopener">Ver etiqueta</a> · ` : ''}
            <label class="may-link">${o['Etiqueta URL'] ? 'Cambiar' : 'Subir'} etiqueta<input type="file" id="ed-label" accept="image/*,application/pdf" style="display:none"></label></div>

          <label class="may-field" style="margin-top:12px">Notas internas<input class="vp-input" data-f="Notas" value="${esc(o['Notas'] || '')}"></label>
        </div>
        <div class="may-totals">
          <div><span>Subtotal regular</span><span>${money(c.regSub)}</span></div>
          <div><span>Descuento (${c.pct}%)</span><span>−${money(c.desc)}</span></div>
          ${c.espSub ? `<div><span>Catálogo especial</span><span>${money(c.espSub)}</span></div>` : ''}
          <div class="big"><span>Total</span><span>${money(c.total)}</span></div>
          <div><span>Envío</span><span>${money(o['Envío'])}</span></div>
          <div><span>Pagado</span><span>${money(paid(o))}</span></div>
          <div><b>Pendiente</b><b>${money(pending(oc))}</b></div>
          ${!c.info.hist.total && tiersSorted()[0] && c.sub < tiersSorted()[0].min ? `<div class="may-warn">Pedido de apertura mínimo ${money(tiersSorted()[0].min)}</div>` : ''}
        </div>
      </div>

      ${o['PDF Historial'].length ? `<div class="may-h3">Versiones del PDF</div><div class="may-pdfs">${o['PDF Historial'].slice().reverse().map(h => `<a href="${esc(h.url)}" target="_blank" rel="noopener">v${h.v} · ${esc(h.fecha)} · ${money(h.total)}</a>`).join('')}</div>` : ''}

      <div class="may-actions">
        ${o['Mayoreo ID'] ? '<button class="btn" id="ed-del" style="margin-right:auto;color:var(--red-text)">Eliminar</button>' : ''}
        ${o['Mayoreo ID'] ? '<button class="btn" id="ed-wa">💬 WhatsApp</button><button class="btn" id="ed-repeat">Repetir pedido</button>' : ''}
        <button class="btn" id="ed-save">Guardar</button>
        <button class="btn btn-primary" id="ed-pdf">Guardar y generar PDF</button>
      </div>`;
    wire();
    restoreFocus(fk);
  }

  function wire() {
    const q = s => root.querySelector(s);
    q('#ed-client').onclick = () => { if (!dirty || confirm('Hay cambios sin guardar. ¿Salir?')) { m.close(); openClient(cid); } };
    root.querySelectorAll('[data-f]').forEach(el => el.addEventListener('change', () => { o[el.dataset.f] = el.value; dirty = true; later(); }));
    root.querySelectorAll('tr[data-n]').forEach(tr => {
      const it = o.items[Number(tr.dataset.n)];
      tr.querySelectorAll('[data-i]').forEach(el => { if (el.tagName === 'INPUT') el.addEventListener('focus', () => el.select()); });
      tr.querySelectorAll('[data-i]').forEach(el => el.addEventListener('change', () => {
        const k = el.dataset.i;
        it[k] = el.type === 'number' ? Number(el.value) : el.value;
        if (k === '_tienda' && it._tienda) it['Precio Unitario'] = Math.round(it._tienda * (1 - (Number(S.especial_default_pct) || 0) / 100) * 100) / 100;
        if (k === 'Artículo') {
          const hit = (PRODUCTS || []).find(p => p.name === String(it['Artículo']).trim());
          it['Catalog ID'] = hit ? hit.id : '';
          if (!Number(it['Precio Unitario'])) { const lp = lastPrice(it['Artículo'], cid); if (lp) it['Precio Unitario'] = lp; }
        }
        dirty = true; later();
      }));
    });
    root.querySelectorAll('[data-del]').forEach(b => b.onclick = () => { o.items.splice(Number(b.dataset.del), 1); if (!o.items.length) o.items.push(blankItem()); dirty = true; render(); });
    q('#ed-add').onclick = () => { o.items.push(blankItem()); render(); const ins = root.querySelectorAll('[data-i="Artículo"]'); ins[ins.length - 1].focus(); };
    const lastSel = root.querySelector('tr[data-n]:last-child select[data-i="Catálogo"]');
    if (lastSel) lastSel.addEventListener('keydown', e => {
      if (e.key === 'Tab' && !e.shiftKey) {
        e.preventDefault();
        o.items.push(blankItem()); render();
        const ins = root.querySelectorAll('[data-i="Artículo"]'); ins[ins.length - 1].focus();
      }
    });
    if (q('#ed-pack')) q('#ed-pack').onclick = () => pickPlantilla('Pack', p => addFromPlantilla(p, 'Regular'));
    if (q('#ed-esp')) q('#ed-esp').onclick = () => pickPlantilla('Especial', p => addFromPlantilla(p, 'Especial'));
    q('#ed-pct').addEventListener('change', e => {
      const v = Number(e.target.value);
      manualPct = v === calc().info.pct && manualPct === null ? null : v;
      dirty = true; later();
    });
    if (q('#ed-auto')) q('#ed-auto').onclick = () => { manualPct = null; o['Descuento Nota'] = ''; render(); };
    q('#ed-pay').onclick = () => openPayment(o, calc().total, async pago => {
      o['Pagos'] = (o['Pagos'] || []).concat([pago]);
      const sug = suggestStatusAfterPayment(Object.assign({}, o, { 'Total': calc().total }), o['Pagos']);
      if (sug && confirm(`¿Mover a ${sug}?`)) o['Status'] = sug;
      dirty = true; render(); VP.toast('Pago agregado — recuerda Guardar');
    });
    root.querySelectorAll('[data-delpay]').forEach(b => b.onclick = () => {
      if (!confirm('¿Quitar este pago?')) return;
      o['Pagos'].splice(Number(b.dataset.delpay), 1); dirty = true; render();
    });
    q('#ed-label').addEventListener('change', async e => {
      const f = e.target.files[0]; if (!f) return;
      try { VP.toast('Subiendo etiqueta…'); o['Etiqueta URL'] = await uploadAny(f); dirty = true; render(); VP.toast('Etiqueta subida — recuerda Guardar'); }
      catch (err) { VP.toast(err.message, true); }
    });
    q('#ed-save').onclick = () => save(false);
    q('#ed-pdf').onclick = () => save(true);
    if (q('#ed-wa')) q('#ed-wa').onclick = () => openWhatsApp(Object.assign({}, o, { 'Total': calc().total }));
    if (q('#ed-repeat')) q('#ed-repeat').onclick = () => { m.close(); openEditor(null, cid, o); };
    if (q('#ed-del')) q('#ed-del').onclick = async () => {
      if (!confirm(`¿Eliminar ${o['Mayoreo ID']}? Esto no se puede deshacer.`)) return;
      try { await VP.post({ action: 'mayoreo_delete_order', id: o['Mayoreo ID'] }); VP.toast('Eliminado'); m.close(); await load(); }
      catch (e) { VP.toast(e.message, true); }
    };
  }

  function addFromPlantilla(p, catalogo) {
    const items = (Array.isArray(p['Items']) ? p['Items'] : []).map(it => ({
      'Artículo': it['Artículo'], 'Cantidad': Number(it['Cantidad']) || 1, 'Precio Unitario': Number(it['Precio Unitario']) || 0,
      'Catálogo': catalogo, 'Catalog ID': it['Catalog ID'] || '',
    }));
    o.items = o.items.filter(it => String(it['Artículo']).trim()).concat(items);
    if (!o.items.length) o.items.push(blankItem());
    dirty = true; render();
  }

  function payload(c) {
    const head = Object.assign({}, o);
    delete head.items; delete head['Status Historial'];
    Object.assign(head, {
      'Subtotal': c.sub, 'Descuento %': c.pct, 'Total': c.total,
      'Descuento Origen': manualPct !== null ? 'manual' : 'auto',
      // the payment log replaces the pre-v2 fixed fields
      'Anticipo Monto': '', 'Anticipo Fecha': '', 'Liquidación Monto': '', 'Liquidación Fecha': '',
    });
    if (manualPct === null) head['Descuento Nota'] = '';
    const items = o.items.filter(it => String(it['Artículo']).trim()).map(it => ({
      'Artículo': String(it['Artículo']).trim(), 'Cantidad': Number(it['Cantidad']) || 0,
      'Precio Unitario': Number(it['Precio Unitario']) || 0, 'Catálogo': it['Catálogo'] || 'Regular',
      'Catalog ID': it['Catalog ID'] || '',
    }));
    return { head, items };
  }

  async function save(withPdf) {
    const c = calc();
    if (manualPct !== null && !String(o['Descuento Nota'] || '').trim()) { VP.toast('Escribe el motivo del descuento manual', true); return; }
    const { head, items } = payload(c);
    if (!items.length) { VP.toast('Agrega al menos un artículo', true); return; }
    const btns = root.querySelectorAll('.may-actions .btn');
    btns.forEach(b => b.disabled = true);
    try {
      const r = await VP.post({ action: 'mayoreo_save_order', order: head, items });
      o['Mayoreo ID'] = r.id; head['Mayoreo ID'] = r.id;
      if (withPdf) {
        VP.toast('Generando PDF…');
        const v = (Number(o['PDF Versión']) || 0) + 1;
        const blob = buildPdf(head, items, c, v);
        const url = await uploadRaw(blob, 'cotizacion.pdf');
        const hist = (o['PDF Historial'] || []).concat([{ v, url, fecha: today(), total: c.total }]);
        await saveHead(head, { 'PDF URL': url, 'PDF Versión': v, 'PDF Historial': hist });
        downloadBlob(blob, pdfName(head, v));
      }
      dirty = false;
      VP.toast(withPdf ? 'Guardado y PDF generado' : 'Guardado ' + r.id);
      await load();
      m.close();
      openEditor(r.id);
    } catch (e) {
      VP.toast(e.message, true);
      btns.forEach(b => b.disabled = false);
    }
  }

  render();
}

function pickPlantilla(tipo, onPick) {
  const list = PLANTILLAS.filter(p => p['Tipo'] === tipo && p['Activa'] !== 'No' && (tipo !== 'Especial' || !p['Vence'] || p['Vence'] >= today()));
  const m = VP.showModal(`
    <h2 class="may-h2">${tipo === 'Pack' ? 'Cargar Pack Inicial' : 'Lista especial'}</h2>
    ${list.map(p => `<button class="btn may-wa-opt" data-pid="${esc(p['Plantilla ID'])}"><b>${esc(p['Nombre'])}</b><br>
      <span style="opacity:.75;font-size:12px">${(p['Items'] || []).length} artículos${p['Vence'] ? ' · vence ' + esc(p['Vence']) : ''}</span></button>`).join('')}
  `, { maxWidth: '480px' });
  m.el.querySelectorAll('[data-pid]').forEach(b => b.onclick = () => { m.close(); onPick(PLANTILLAS.find(p => p['Plantilla ID'] === b.dataset.pid)); });
}

/* ── PDF ──────────────────────────────────────────────────────────────── */

function pdfName(head, v) {
  const n = String(custName(head['Customer ID'])).replace(/[^\w\-]+/g, '_');
  return `Cotizacion_${head['Mayoreo ID']}_v${v}_${n}.pdf`;
}

function buildPdf(head, items, c, v) {
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: 'mm', format: 'letter' });
  const W = doc.internal.pageSize.getWidth(), L = 18, R = W - 18;
  const fmt = n => '$' + Math.round(Number(n) || 0).toLocaleString('es-MX');
  const ink = [40, 38, 34], muted = [120, 116, 108], line = [220, 216, 208];

  doc.setFont('times', 'italic'); doc.setFontSize(26); doc.setTextColor(...ink);
  doc.text('Vel Papier', L, 24);
  doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.setTextColor(...muted);
  doc.text('Programa de Mayoreo', L, 30);

  doc.setFont('helvetica', 'bold'); doc.setFontSize(13); doc.setTextColor(...ink);
  doc.text('Cotización ' + head['Mayoreo ID'], R, 22, { align: 'right' });
  doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.setTextColor(...muted);
  doc.text(`Versión ${v} · ${head['Fecha']}`, R, 28, { align: 'right' });
  if (S.pdf_validity_days) doc.text(`Válida por ${S.pdf_validity_days} días`, R, 33, { align: 'right' });

  doc.setDrawColor(...line); doc.line(L, 38, R, 38);
  doc.setFontSize(8.5); doc.text('CLIENTA / CLIENTE', L, 45);
  doc.setFont('helvetica', 'bold'); doc.setFontSize(12); doc.setTextColor(...ink);
  doc.text(String(custName(head['Customer ID'])), L, 51);
  doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.setTextColor(...muted);
  doc.text([custUser(head['Customer ID']), head['Customer ID']].filter(Boolean).join('  ·  '), L, 56);
  doc.text(c.info.tier ? `Nivel ${c.info.tier.nivel}` : '', R, 51, { align: 'right' });

  doc.autoTable({
    startY: 63, margin: { left: L, right: 18 },
    head: [['Artículo', 'Piezas', 'Precio unit.', 'Importe']],
    body: items.map(it => [
      it['Artículo'] + (it['Catálogo'] === 'Especial' ? '  (Especial)' : ''),
      it['Cantidad'], fmt(it['Precio Unitario']), fmt(it['Cantidad'] * it['Precio Unitario']),
    ]),
    theme: 'plain',
    styles: { font: 'helvetica', fontSize: 9.5, textColor: ink, cellPadding: { top: 2.6, bottom: 2.6, left: 2, right: 2 }, lineColor: line, lineWidth: { bottom: 0.2 } },
    headStyles: { fontStyle: 'bold', textColor: muted, fontSize: 8.5, lineWidth: { bottom: 0.4 }, lineColor: ink },
    columnStyles: { 1: { halign: 'right', cellWidth: 20 }, 2: { halign: 'right', cellWidth: 30 }, 3: { halign: 'right', cellWidth: 30 } },
    didParseCell: d => { if (d.section === 'head' && d.column.index > 0) d.cell.styles.halign = 'right'; },
  });

  let y = doc.lastAutoTable.finalY + 8;
  const row = (label, val, bold) => {
    doc.setFont('helvetica', bold ? 'bold' : 'normal'); doc.setFontSize(bold ? 11.5 : 9.5);
    doc.setTextColor(...(bold ? ink : muted));
    doc.text(label, R - 70, y); doc.setTextColor(...ink); doc.text(val, R, y, { align: 'right' });
    y += bold ? 7 : 5.5;
  };
  row(`Subtotal (${c.pieces} piezas)`, fmt(c.sub));
  if (c.desc) row(`Descuento ${c.info.tier && head['Descuento Origen'] !== 'manual' ? 'Nivel ' + c.info.tier.nivel + ' ' : ''}(${c.pct}%)`, '-' + fmt(c.desc));
  if (c.espSub && c.desc) row('(Catálogo especial sin descuento adicional)', '');
  doc.setDrawColor(...ink); doc.line(R - 70, y - 2, R, y - 2); y += 3;
  row('Total', fmt(c.total), true);
  y += 2;

  const env = Number(head['Envío']) || 0;
  const pd = (head['Pagos'] || []).reduce((s, p) => s + (Number(p.monto) || 0), 0);
  row('Anticipo 50%', fmt(c.total / 2));
  row('Resto 50% + envío', fmt(c.total / 2) + (env ? ` + ${fmt(env)}` : ' + envío'));
  if (pd) { row('Pagado', fmt(pd)); row('Saldo pendiente', fmt(Math.max(0, c.total + env - pd)), true); }

  const after = c.info.hist.total + (S.history_basis === 'before' ? c.sub : c.total);
  const nextAfter = tiersSorted().find(t => t.min > after);
  y += 4;
  if (nextAfter) {
    doc.setFont('helvetica', 'italic'); doc.setFontSize(9); doc.setTextColor(...muted);
    doc.text(`Con este pedido llevarás ${fmt(after)} en compras. Te faltarán ${fmt(Math.max(0, nextAfter.min - after))} para Nivel ${nextAfter.nivel} (${nextAfter.pct}% de descuento).`, L, y, { maxWidth: R - L });
    y += 10;
  }

  let fy = Math.max(y + 6, doc.internal.pageSize.getHeight() - 52);
  doc.setDrawColor(...line); doc.line(L, fy, R, fy); fy += 6;
  doc.setFont('helvetica', 'bold'); doc.setFontSize(9); doc.setTextColor(...ink);
  doc.text('Forma de pago', L, fy);
  doc.setFont('helvetica', 'normal'); doc.setTextColor(...muted); doc.setFontSize(8.5);
  doc.text(String(S.pdf_bank_info || 'Transferencia bancaria (datos por WhatsApp).').split('\n'), L, fy + 5);
  doc.text('Precios en MXN. 50% de anticipo para apartar mercancía; 50% restante + envío al estar listo el pedido. ' +
    'Preparación hasta 1 semana hábil tras el anticipo. El envío corre por cuenta del cliente; no nos hacemos ' +
    'responsables por daños o retrasos de la paquetería. Entregamos evidencia fotográfica del paquete.',
    L + 88, fy + 5, { maxWidth: R - L - 88 });
  return doc.output('blob');
}

function downloadBlob(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

/* ── View: Listas (Pack Inicial + Catálogo especial) ──────────────────── */

function renderListas() {
  const q = $('may-search').value.trim().toLowerCase();
  const rows = PLANTILLAS.filter(p => !q || String(p['Nombre']).toLowerCase().includes(q));
  const block = (tipo, title, note) => {
    const list = rows.filter(p => p['Tipo'] === tipo);
    return `<div class="may-section">
      <div class="may-toolbar" style="margin-bottom:8px"><div><div class="may-h3" style="margin:0">${title}</div><div class="may-note">${note}</div></div>
        <button class="btn btn-sm" data-newpl="${tipo}">+ Nueva</button></div>
      <div class="may-card">${list.length ? `<table class="vp-table may-tbl"><thead><tr><th>Nombre</th><th>Artículos</th><th>Valor</th>${tipo === 'Especial' ? '<th>Vence</th>' : ''}<th>Estado</th></tr></thead><tbody>
        ${list.map(p => {
          const its = Array.isArray(p['Items']) ? p['Items'] : [];
          const val = its.reduce((s, it) => s + (Number(it['Cantidad']) || 0) * (Number(it['Precio Unitario']) || 0), 0);
          const expired = tipo === 'Especial' && p['Vence'] && p['Vence'] < today();
          return `<tr class="vp-table-row-clickable" data-pl="${esc(p['Plantilla ID'])}"><td>${esc(p['Nombre'])}</td><td>${its.length}</td><td>${money(val)}</td>
            ${tipo === 'Especial' ? `<td>${esc(p['Vence'] || '—')}</td>` : ''}
            <td>${p['Activa'] === 'No' ? '<span class="may-flag grey">inactiva</span>' : expired ? '<span class="may-flag red">vencida</span>' : '<span class="may-flag grey" style="background:var(--green-bg);color:var(--green-text)">activa</span>'}</td></tr>`;
        }).join('')}</tbody></table>` : '<div class="may-empty" style="padding:1.5rem">Ninguna todavía.</div>'}</div></div>`;
  };
  $('may-content').innerHTML =
    block('Pack', 'Pack Inicial', 'Selecciones recomendadas para cargar en una cotización con un clic (precio regular, aplica descuento de nivel).') +
    block('Especial', 'Catálogo especial', 'Preórdenes y liquidaciones con precio fijo — no acumulan descuento de nivel. Piezas = mínimo por producto.');
  $('may-content').querySelectorAll('[data-newpl]').forEach(b => b.onclick = () => openPlantilla(null, b.dataset.newpl));
  $('may-content').querySelectorAll('tr[data-pl]').forEach(tr => tr.onclick = () => openPlantilla(tr.dataset.pl));
}

function openPlantilla(id, tipoNew) {
  const src = id ? PLANTILLAS.find(p => p['Plantilla ID'] === id) : null;
  const p = src ? JSON.parse(JSON.stringify(src)) : { 'Plantilla ID': '', 'Nombre': '', 'Tipo': tipoNew, 'Activa': 'Sí', 'Vence': '', 'Items': [] };
  if (!Array.isArray(p['Items'])) p['Items'] = [];
  if (!p['Items'].length) p['Items'].push({ 'Artículo': '', 'Cantidad': p['Tipo'] === 'Especial' ? Number(S.min_pieces) || 1 : 3, 'Precio Unitario': 0 });
  const m = VP.showModal(`<div id="pl-root"></div>`, { maxWidth: '760px' });
  const root = m.el.querySelector('#pl-root');
  ensureProducts();

  function render() {
    root.innerHTML = `
      <h2 class="may-h2">${src ? esc(p['Nombre']) : 'Nueva lista'} <span class="may-sub">· ${p['Tipo'] === 'Pack' ? 'Pack Inicial' : 'Catálogo especial'}</span></h2>
      <div class="may-grid" style="margin-top:12px">
        <label class="may-field may-span2">Nombre<input class="vp-input" data-p="Nombre" value="${esc(p['Nombre'])}"></label>
        <label class="may-field">Estado<select class="vp-input" data-p="Activa"><option ${p['Activa'] !== 'No' ? 'selected' : ''}>Sí</option><option ${p['Activa'] === 'No' ? 'selected' : ''}>No</option></select></label>
        ${p['Tipo'] === 'Especial' ? `<label class="may-field">Vence<input class="vp-input" type="date" data-p="Vence" value="${esc(p['Vence'] || '')}"></label>` : ''}
      </div>
      <div class="may-h3">Artículos</div>
      <table class="may-items" style="min-width:0"><colgroup><col><col style="width:100px"><col style="width:120px"><col style="width:36px"></colgroup>
        <thead><tr><th>Artículo</th><th>${p['Tipo'] === 'Especial' ? 'Mínimo' : 'Piezas'}</th><th>${p['Tipo'] === 'Especial' ? 'Precio especial' : 'Precio unit.'}</th><th></th></tr></thead>
        <tbody>${p['Items'].map((it, n) => `<tr data-n="${n}">
          <td><input class="vp-input" list="may-products" data-i="Artículo" value="${esc(it['Artículo'])}"></td>
          <td><input class="vp-input" type="number" min="0" data-i="Cantidad" value="${esc(it['Cantidad'])}"></td>
          <td><input class="vp-input" type="number" min="0" step="0.01" data-i="Precio Unitario" value="${esc(it['Precio Unitario'])}"></td>
          <td><button class="btn btn-xs" tabindex="-1" data-del="${n}">✕</button></td></tr>`).join('')}</tbody></table>
      <button class="btn btn-sm" id="pl-add" style="margin-top:8px">+ Agregar artículo</button>
      <div class="may-actions">
        ${src ? '<button class="btn" id="pl-del" style="margin-right:auto;color:var(--red-text)">Eliminar</button>' : ''}
        <button class="btn btn-primary" id="pl-save">Guardar lista</button>
      </div>`;
    root.querySelectorAll('[data-p]').forEach(el => el.onchange = () => { p[el.dataset.p] = el.value; });
    root.querySelectorAll('tr[data-n]').forEach(tr => tr.querySelectorAll('[data-i]').forEach(el => {
      el.addEventListener('focus', () => el.select());
      el.onchange = () => {
        const it = p['Items'][Number(tr.dataset.n)];
        it[el.dataset.i] = el.type === 'number' ? Number(el.value) : el.value;
        if (el.dataset.i === 'Artículo') { const hit = (PRODUCTS || []).find(x => x.name === el.value.trim()); it['Catalog ID'] = hit ? hit.id : ''; }
      };
    }));
    root.querySelectorAll('[data-del]').forEach(b => b.onclick = () => { p['Items'].splice(Number(b.dataset.del), 1); render(); });
    root.querySelector('#pl-add').onclick = () => {
      p['Items'].push({ 'Artículo': '', 'Cantidad': p['Tipo'] === 'Especial' ? Number(S.min_pieces) || 1 : 3, 'Precio Unitario': 0 });
      render(); const ins = root.querySelectorAll('[data-i="Artículo"]'); ins[ins.length - 1].focus();
    };
    root.querySelector('#pl-save').onclick = async () => {
      p['Items'] = p['Items'].filter(it => String(it['Artículo']).trim());
      if (!String(p['Nombre']).trim()) { VP.toast('Ponle nombre a la lista', true); return; }
      try { await VP.post({ action: 'mayoreo_save_plantilla', plantilla: p }); VP.toast('Lista guardada'); m.close(); await load(); }
      catch (e) { VP.toast(e.message, true); }
    };
    const del = root.querySelector('#pl-del');
    if (del) del.onclick = async () => {
      if (!confirm('¿Eliminar esta lista?')) return;
      try { await VP.post({ action: 'mayoreo_delete_plantilla', id: p['Plantilla ID'] }); VP.toast('Eliminada'); m.close(); await load(); }
      catch (e) { VP.toast(e.message, true); }
    };
  }
  render();
}

/* ── View: Resumen ────────────────────────────────────────────────────── */

function renderResumen() {
  VP.resetCharts();
  const conf = ORDERS.filter(o => COUNTING.indexOf(o['Status']) >= 0);
  const months = [];
  const d = new Date(today().slice(0, 7) + '-01T12:00:00');
  for (let i = 11; i >= 0; i--) { const x = new Date(d); x.setMonth(d.getMonth() - i); months.push(x.toISOString().slice(0, 7)); }
  const byMonth = months.map(mo => conf.filter(o => String(o['Fecha']).slice(0, 7) === mo).reduce((s, o) => s + (Number(o['Total']) || 0), 0));
  const labels = months.map(mo => VP.MONTHS_ES[Number(mo.slice(5, 7)) - 1]);
  const thisM = byMonth[11], prevM = byMonth[10];
  const year = conf.filter(o => String(o['Fecha']).slice(0, 4) === today().slice(0, 4)).reduce((s, o) => s + (Number(o['Total']) || 0), 0);
  const avg = conf.length ? conf.reduce((s, o) => s + (Number(o['Total']) || 0), 0) / conf.length : 0;

  const prod = {};
  conf.forEach(o => {
    const f = (Number(o['Total']) || 0) / ((Number(o['Subtotal']) || 1));   // spread the discount over the lines
    o.items.forEach(it => {
      const k = String(it['Artículo']).trim(); if (!k) return;
      prod[k] = prod[k] || { pz: 0, val: 0 };
      prod[k].pz += Number(it['Cantidad']) || 0;
      prod[k].val += (Number(it['Cantidad']) || 0) * (Number(it['Precio Unitario']) || 0) * f;
    });
  });
  const topP = Object.entries(prod).sort((a, b) => b[1].val - a[1].val).slice(0, 10);
  const cli = {};
  conf.forEach(o => { const c = String(o['Customer ID']); cli[c] = (cli[c] || 0) + (Number(o['Total']) || 0); });
  const topC = Object.entries(cli).sort((a, b) => b[1] - a[1]).slice(0, 10);

  $('may-content').innerHTML = `
    <div class="vp-stats may-stats">
      ${stat('Este mes', money(thisM), prevM ? `${thisM >= prevM ? '+' : ''}${Math.round((thisM - prevM) / prevM * 100)}% vs mes pasado` : 'mes pasado ' + money(prevM))}
      ${stat('Mes pasado', money(prevM), '')}
      ${stat('Este año', money(year), `${conf.filter(o => String(o['Fecha']).slice(0, 4) === today().slice(0, 4)).length} pedidos`)}
      ${stat('Pedido promedio', money(avg), `${conf.length} pedidos confirmados`)}
    </div>
    <div class="may-card" style="padding:16px 16px 6px;margin-bottom:14px">
      <div class="may-h3" style="margin-top:0">Ventas de mayoreo por mes (pedidos confirmados)</div>
      ${VP.chartSlot(w => VP.chart.bars(labels, [{ name: 'Mayoreo', values: byMonth }], { width: w, fmt: v => money(v) }), 200)}
    </div>
    <div class="may-two">
      <div class="may-card">${topP.length ? `<table class="vp-table may-tbl"><thead><tr><th>Producto más vendido</th><th>Piezas</th><th>Ventas</th></tr></thead><tbody>
        ${topP.map(([n, v]) => `<tr><td>${esc(n)}</td><td>${v.pz}</td><td>${money(v.val)}</td></tr>`).join('')}</tbody></table>` : '<div class="may-empty">Sin pedidos confirmados todavía.</div>'}</div>
      <div class="may-card">${topC.length ? `<table class="vp-table may-tbl"><thead><tr><th>Mejores clientes</th><th>Nivel</th><th>Compras</th></tr></thead><tbody>
        ${topC.map(([c, v]) => `<tr class="vp-table-row-clickable" data-client="${esc(c)}"><td>${esc(custName(c))}</td><td>${tierBadge(tierInfo(c).tier)}</td><td>${money(v)}</td></tr>`).join('')}</tbody></table>` : '<div class="may-empty">Sin pedidos confirmados todavía.</div>'}</div>
    </div>
    <div class="may-note" style="margin-top:10px">Solo cuenta pedidos Apartado, Listo, Pagado y Enviado. El saldo inicial de cada cliente no aparece aquí.</div>`;
  VP.paintCharts();
  $('may-content').querySelectorAll('[data-client]').forEach(tr => tr.onclick = () => openClient(tr.dataset.client));
}

/* ── Settings ─────────────────────────────────────────────────────────── */

function openSettings() {
  const t = tiersSorted();
  const sel = (id, val, opts) => `<select class="vp-input" id="${id}">${opts.map(([v, l]) => `<option value="${v}" ${String(val) === String(v) ? 'selected' : ''}>${l}</option>`).join('')}</select>`;
  const m = VP.showModal(`
    <h2 class="may-h2">Ajustes de mayoreo</h2>
    <div class="may-note">Los niveles se recalculan al momento con estos ajustes. Los pedidos ya guardados conservan su descuento hasta que los abras y guardes de nuevo.</div>

    <div class="may-h3">Niveles</div>
    ${t.map((x, i) => `<div class="may-grid" style="margin-bottom:6px">
      <label class="may-field">Nivel ${x.nivel} desde ($)<input class="vp-input" type="number" min="0" data-tmin="${i}" value="${x.min}"></label>
      <label class="may-field">Descuento %<input class="vp-input" type="number" min="0" max="100" data-tpct="${i}" value="${x.pct}"></label>
    </div>`).join('')}

    <div class="may-h3">Historial de compras</div>
    <div class="may-grid">
      <label class="may-field">Compras de TikTok cuentan${sel('st-tt', S.count_tiktok, [[false, 'No'], [true, 'Sí']])}</label>
      <label class="may-field">Monto que cuenta${sel('st-basis', S.history_basis, [['after', 'Después del descuento'], ['before', 'Antes del descuento']])}</label>
      <label class="may-field">El pedido actual cuenta para su propio nivel${sel('st-cur', S.current_counts, [[false, 'No'], [true, 'Sí']])}</label>
    </div>

    <div class="may-h3">Inactividad</div>
    <div class="may-grid">
      <label class="may-field">Días sin comprar (niveles 2 y 3)<input class="vp-input" type="number" min="1" id="st-days" value="${S.lapse_days}"></label>
      <label class="may-field">Qué pasa${sel('st-lapse', S.lapse_rule, [['flag', 'Solo marcar'], ['drop_one', 'Baja un nivel'], ['drop_to_1', 'Baja a Nivel 1']])}</label>
      <label class="may-field">“Por reactivar” después de (días)<input class="vp-input" type="number" min="1" id="st-react" value="${S.reactivate_days}"></label>
    </div>

    <div class="may-h3">Seguimiento de pedidos</div>
    <div class="may-grid">
      <label class="may-field">Avisar cotización sin respuesta (días)<input class="vp-input" type="number" min="1" id="st-follow" value="${S.quote_followup_days}"></label>
      <label class="may-field">Días hábiles de preparación<input class="vp-input" type="number" min="1" id="st-prep" value="${S.prep_days}"></label>
      <label class="may-field">Vigencia de cotización (días)<input class="vp-input" type="number" min="0" id="st-valid" value="${S.pdf_validity_days || 0}"></label>
    </div>

    <div class="may-h3">Catálogo especial y pedidos</div>
    <div class="may-grid">
      <label class="may-field">Precio especial${sel('st-esp', S.especial_mode, [['manual', 'Escribir precio'], ['percent', '% sobre precio de tienda']])}</label>
      <label class="may-field">% especial por defecto<input class="vp-input" type="number" min="0" max="100" id="st-esppct" value="${S.especial_default_pct}"></label>
      <label class="may-field">Mínimo de piezas por modelo<input class="vp-input" type="number" min="0" id="st-min" value="${S.min_pieces}"></label>
    </div>

    <div class="may-h3">PDF</div>
    <label class="may-field">Datos bancarios (aparecen en el PDF)<textarea class="vp-input" id="st-bank" rows="3">${esc(S.pdf_bank_info || '')}</textarea></label>

    <div class="may-h3">Mensajes de WhatsApp</div>
    <div class="may-note" style="margin-bottom:8px">Puedes usar: {nombre} {pedido} {total} {anticipo} {saldo} {pdf} {guia} {paqueteria}</div>
    ${[['wa_tpl_quote', 'Cotización lista'], ['wa_tpl_deposit', 'Pedir anticipo'], ['wa_tpl_ready', 'Pedido listo · saldo'], ['wa_tpl_shipped', 'Enviado · guía']].map(([k, l]) =>
      `<label class="may-field" style="margin-bottom:8px">${l}<textarea class="vp-input" data-wa="${k}" rows="2">${esc(S[k] || '')}</textarea></label>`).join('')}

    <div class="may-actions"><button class="btn btn-primary" id="st-save">Guardar ajustes</button></div>
  `, { maxWidth: '660px' });

  m.el.querySelector('#st-save').onclick = async () => {
    const q = s => m.el.querySelector(s);
    const settings = Object.assign({}, S, {
      tiers: t.map((x, i) => ({ nivel: x.nivel, min: Number(q(`[data-tmin="${i}"]`).value) || 0, pct: Number(q(`[data-tpct="${i}"]`).value) || 0 })),
      count_tiktok: q('#st-tt').value === 'true',
      history_basis: q('#st-basis').value,
      current_counts: q('#st-cur').value === 'true',
      lapse_days: Number(q('#st-days').value) || 30,
      lapse_rule: q('#st-lapse').value,
      reactivate_days: Number(q('#st-react').value) || 21,
      quote_followup_days: Number(q('#st-follow').value) || 3,
      prep_days: Number(q('#st-prep').value) || 7,
      pdf_validity_days: Number(q('#st-valid').value) || 0,
      especial_mode: q('#st-esp').value,
      especial_default_pct: Number(q('#st-esppct').value) || 0,
      min_pieces: Number(q('#st-min').value) || 0,
      pdf_bank_info: q('#st-bank').value,
    });
    m.el.querySelectorAll('[data-wa]').forEach(el => { settings[el.dataset.wa] = el.value; });
    try {
      const r = await VP.post({ action: 'mayoreo_save_settings', settings });
      S = r.settings || settings;
      VP.toast('Ajustes guardados');
      m.close();
      await load();   // TikTok spend may now be needed
    } catch (e) { VP.toast(e.message, true); }
  };
}
