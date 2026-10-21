/* ============================================================================
   mayoristas.js — wholesale channel: clients, tiered quotes, PDF versions.
   Tiers are computed here, live, from history + settings — never stored —
   so every settings change applies retroactively. A saved order keeps the
   discount % it was saved with until someone re-applies it.
   ==========================================================================*/

const MAY_ALLOWED_EXTRA = ['KARIN'];
const STATUSES = ['Cotización', 'Anticipo', 'Liquidado', 'Enviado', 'Cancelado'];
const COUNTING = ['Anticipo', 'Liquidado', 'Enviado'];   // confirmed orders count toward history

let S = null;            // settings
let CLIENTES = [];       // Mayoreo Clientes rows
let ORDERS = [];         // Mayoreo Orders rows (+ .items)
let TT = {};             // Customer ID -> TikTok spend
let CUST = {};           // Customer ID -> customer record (Customers sheet)
let ALL_CUST = [];       // visible customers, for the picker

const $ = id => document.getElementById(id);
const money = n => VP.mxn(Math.round(Number(n) || 0));
const today = () => new Date().toISOString().slice(0, 10);

/* ── Init ─────────────────────────────────────────────────────────────── */

(async function init() {
  try {
    await VP.ensureToken();
    const name = (VP.getUserName ? VP.getUserName() : '').toUpperCase();
    if (VP.getRole() !== 'admin' && MAY_ALLOWED_EXTRA.indexOf(name) < 0) {
      window.location.href = 'pedidos.html';
      return;
    }
    VP.mountNav('mayoristas');
    $('may-search').addEventListener('input', renderList);
    $('may-refresh').addEventListener('click', load);
    $('may-settings').addEventListener('click', openSettings);
    $('may-new-client').addEventListener('click', openNewClient);
    await load();
  } catch (e) {
    console.error(e);
  }
})();

async function load() {
  $('may-content').innerHTML = '<div class="vp-loading">Cargando mayoristas</div>';
  try {
    const [data, custData] = await Promise.all([
      VP.get('action=mayoreo_data'),
      VP.get('action=customers'),
    ]);
    S = data.settings;
    CLIENTES = data.clientes || [];
    ORDERS = data.orders || [];
    TT = data.tiktok_spend || {};
    ALL_CUST = custData.records || [];
    CUST = {};
    ALL_CUST.forEach(c => { CUST[String(c['Customer ID'])] = c; });
    renderList();
  } catch (e) {
    $('may-content').innerHTML = `<div class="may-empty">Error al cargar: ${VP.esc(e.message)}</div>`;
  }
}

/* ── Names ────────────────────────────────────────────────────────────── */

function custName(cid) {
  const c = CUST[cid];
  if (!c) return cid;
  const full = [c['First Name'], c['Surname']].filter(Boolean).join(' ').trim();
  return full || c['Primary Username'] || cid;
}
function custUser(cid) {
  const c = CUST[cid];
  return c && c['Primary Username'] ? '@' + c['Primary Username'] : '';
}
function cliente(cid) { return CLIENTES.find(c => String(c['Customer ID']) === String(cid)) || null; }

/* ── Tier engine ──────────────────────────────────────────────────────── */

function tiersSorted() { return (S.tiers || []).slice().sort((a, b) => a.min - b.min); }

function tierForAmount(amount) {
  let t = null;
  tiersSorted().forEach(x => { if (amount >= x.min) t = x; });
  return t;   // null = below opening minimum
}

function tierByNivel(n) { return tiersSorted().find(t => Number(t.nivel) === Number(n)) || null; }

function orderValueForHistory(o) {
  return S.history_basis === 'before' ? Number(o['Subtotal']) || 0 : Number(o['Total']) || 0;
}

function countingOrders(cid, excludeId, beforeDate) {
  return ORDERS.filter(o =>
    String(o['Customer ID']) === String(cid) &&
    COUNTING.indexOf(o['Status']) >= 0 &&
    String(o['Mayoreo ID']) !== String(excludeId || '') &&
    (!beforeDate || String(o['Fecha'] || '') <= beforeDate)
  );
}

// History total for a client, optionally excluding one order / only up to a date.
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

function daysSince(dateStr, ref) {
  if (!dateStr) return Infinity;
  return Math.floor((new Date(ref || today()) - new Date(dateStr)) / 86400000);
}

// Full tier picture for a client (optionally in the context of one order).
// opts: { excludeId, orderDate, orderSubtotal }
function tierInfo(cid, opts) {
  opts = opts || {};
  const hist = historyFor(cid, opts.excludeId, opts.orderDate);
  let amount = hist.total;
  if (S.current_counts && opts.orderSubtotal) amount += Number(opts.orderSubtotal) || 0;
  // Opening order: no history yet, but the order itself qualifies for Nivel 1.
  const isOpening = hist.total === 0 && opts.orderSubtotal !== undefined;
  let tier = tierForAmount(amount);
  if (!tier && isOpening && tierForAmount(Number(opts.orderSubtotal) || 0)) tier = tiersSorted()[0];

  // Lapse rule (only bites on levels above the first).
  const last = lastOrderDate(cid, opts.excludeId);
  const lapsed = !!last && daysSince(last, opts.orderDate) > (Number(S.lapse_days) || 30);
  let effective = tier;
  if (lapsed && tier && tier.nivel > 1) {
    if (S.lapse_rule === 'drop_one') effective = tierByNivel(tier.nivel - 1) || tier;
    if (S.lapse_rule === 'drop_to_1') effective = tiersSorted()[0];
  }

  // Manual override beats everything.
  const cl = cliente(cid);
  const manualN = cl && cl['Nivel Manual'] !== '' && cl['Nivel Manual'] !== undefined ? Number(cl['Nivel Manual']) : 0;
  const manual = manualN ? tierByNivel(manualN) : null;
  if (manual) effective = manual;

  const ts = tiersSorted();
  const next = ts.find(t => t.min > hist.total) || null;
  return {
    hist, amount, calc: tier, tier: effective, manual: !!manual, lapsed, last, next,
    pct: effective ? Number(effective.pct) : 0,
    toNext: next ? next.min - hist.total : 0,
  };
}

function tierBadge(t) {
  const n = t ? t.nivel : 0;
  return `<span class="may-tier may-tier-${n}">${t ? 'Nivel ' + n + ' · ' + t.pct + '%' : 'Sin nivel'}</span>`;
}

/* ── Client list ──────────────────────────────────────────────────────── */

function renderList() {
  const q = $('may-search').value.trim().toLowerCase();
  const rows = CLIENTES.map(c => {
    const cid = String(c['Customer ID']);
    const info = tierInfo(cid);
    const orders = ORDERS.filter(o => String(o['Customer ID']) === cid);
    return { cid, info, orders, name: custName(cid), user: custUser(cid) };
  }).filter(r => !q || (r.name + ' ' + r.user + ' ' + r.cid).toLowerCase().includes(q))
    .sort((a, b) => b.info.hist.total - a.info.hist.total);

  $('may-count').textContent = `${CLIENTES.length} mayorista${CLIENTES.length === 1 ? '' : 's'} · ${ORDERS.filter(o => o['Status'] === 'Cotización').length} cotizaciones abiertas`;

  if (!rows.length) {
    $('may-content').innerHTML = `<div class="may-card"><div class="may-empty">${CLIENTES.length ? 'Sin resultados.' : 'Aún no hay mayoristas. Agrega el primero con “Nuevo mayorista”.'}</div></div>`;
    return;
  }

  $('may-content').innerHTML = `<div class="may-card"><table class="vp-table">
    <thead><tr><th>Cliente</th><th>Nivel</th><th class="num">Historial</th><th>Siguiente nivel</th><th>Último pedido</th><th class="num">Pedidos</th><th></th></tr></thead>
    <tbody>${rows.map(r => {
      const i = r.info;
      const prog = i.next ? Math.min(100, Math.round(i.hist.total / i.next.min * 100)) : 100;
      return `<tr class="vp-table-row-clickable" data-cid="${VP.esc(r.cid)}">
        <td><div class="vp-table-name">${VP.esc(r.name)}</div><div class="may-sub">${VP.esc(r.user)} · ${VP.esc(r.cid)}</div></td>
        <td>${tierBadge(i.tier)}${i.manual ? '<span class="may-flag">manual</span>' : ''}${i.lapsed && i.tier && i.tier.nivel > 1 ? '<span class="may-flag">inactivo</span>' : ''}</td>
        <td class="num">${money(i.hist.total)}</td>
        <td>${i.next ? `<div class="may-sub">faltan ${money(i.toNext)} para Nivel ${i.next.nivel}</div><div class="may-progress"><div style="width:${prog}%"></div></div>` : '<span class="may-sub">Nivel máximo</span>'}</td>
        <td>${i.last ? VP.esc(i.last) + `<div class="may-sub">hace ${daysSince(i.last)} días</div>` : '<span class="may-sub">—</span>'}</td>
        <td class="num">${r.orders.length}</td>
        <td><button class="btn btn-sm" data-new="${VP.esc(r.cid)}">+ Cotización</button></td>
      </tr>`;
    }).join('')}</tbody></table></div>`;

  $('may-content').querySelectorAll('tr[data-cid]').forEach(tr => {
    tr.addEventListener('click', e => {
      if (e.target.closest('[data-new]')) return;
      openPortfolio(tr.dataset.cid);
    });
  });
  $('may-content').querySelectorAll('[data-new]').forEach(b => b.addEventListener('click', () => openEditor(null, b.dataset.new)));
}

/* ── Portfolio ────────────────────────────────────────────────────────── */

function openPortfolio(cid) {
  const c = cliente(cid) || {};
  const i = tierInfo(cid);
  const orders = ORDERS.filter(o => String(o['Customer ID']) === cid)
    .sort((a, b) => String(b['Fecha']).localeCompare(String(a['Fecha'])));

  const m = VP.showModal(`
    <h2 class="may-h2">${VP.esc(custName(cid))}</h2>
    <div class="may-sub">${VP.esc(custUser(cid))} · ${VP.esc(cid)} · mayorista desde ${VP.esc(c['Fecha Alta'] || '—')}</div>
    <div style="margin-top:10px">${tierBadge(i.tier)}${i.manual ? '<span class="may-flag">manual</span>' : ''}${i.lapsed && i.tier && i.tier.nivel > 1 ? `<span class="may-flag">sin compras hace ${daysSince(i.last)} días</span>` : ''}</div>

    <div class="may-h3">Historial de compras</div>
    <div class="may-totals" style="margin-left:0">
      <div><span>Saldo inicial</span><span>${money(i.hist.inicial)}</span></div>
      <div><span>Pedidos mayoreo confirmados</span><span>${money(i.hist.may)}</span></div>
      <div><span>TikTok ${S.count_tiktok ? '' : '(no cuenta)'}</span><span>${money(S.count_tiktok ? i.hist.tt : (TT[cid] || 0))}</span></div>
      <div class="big"><span>Total que cuenta</span><span>${money(i.hist.total)}</span></div>
      ${i.next ? `<div><span>Para Nivel ${i.next.nivel}</span><span>faltan ${money(i.toNext)}</span></div>` : ''}
    </div>

    <div class="may-h3">Datos del mayorista</div>
    <div class="may-grid">
      <label class="may-field">Saldo histórico inicial<input class="vp-input" id="pf-saldo" type="number" min="0" value="${VP.esc(c['Saldo Histórico Inicial'] || 0)}"></label>
      <label class="may-field">Nivel manual
        <select class="vp-input" id="pf-nivel">
          <option value="">Automático</option>
          ${tiersSorted().map(t => `<option value="${t.nivel}" ${String(c['Nivel Manual']) === String(t.nivel) ? 'selected' : ''}>Nivel ${t.nivel} (${t.pct}%)</option>`).join('')}
        </select></label>
      <label class="may-field" style="grid-column:span 2">Motivo del nivel manual<input class="vp-input" id="pf-nivelnota" value="${VP.esc(c['Nivel Manual Nota'] || '')}"></label>
      <label class="may-field" style="grid-column:1/-1">Notas<input class="vp-input" id="pf-notas" value="${VP.esc(c['Notas'] || '')}"></label>
    </div>
    <div class="may-actions" style="justify-content:flex-start"><button class="btn btn-sm" id="pf-save">Guardar datos</button></div>

    <div class="may-h3">Pedidos</div>
    ${orders.length ? `<table class="vp-table"><thead><tr><th>Pedido</th><th>Fecha</th><th>Estado</th><th class="num">Total</th><th class="num">Pendiente</th><th>PDF</th></tr></thead><tbody>
      ${orders.map(o => `<tr class="vp-table-row-clickable" data-id="${VP.esc(o['Mayoreo ID'])}">
        <td>${VP.esc(o['Mayoreo ID'])}</td><td>${VP.esc(o['Fecha'])}</td>
        <td><span class="may-status may-st-${VP.esc(o['Status'])}">${VP.esc(o['Status'])}</span></td>
        <td class="num">${money(o['Total'])}</td>
        <td class="num">${money(balance(o))}</td>
        <td>${o['PDF URL'] ? `<a href="${VP.esc(o['PDF URL'])}" target="_blank" rel="noopener" data-stop>v${VP.esc(o['PDF Versión'])}</a>` : '—'}</td>
      </tr>`).join('')}</tbody></table>` : '<div class="may-sub">Sin pedidos todavía.</div>'}
    <div class="may-actions"><button class="btn btn-primary" id="pf-new">+ Nueva cotización</button></div>
  `, { maxWidth: '760px' });

  m.el.querySelector('#pf-new').onclick = () => { m.close(); openEditor(null, cid); };
  m.el.querySelectorAll('tr[data-id]').forEach(tr => tr.addEventListener('click', e => {
    if (e.target.closest('[data-stop]')) return;
    m.close(); openEditor(tr.dataset.id);
  }));
  m.el.querySelector('#pf-save').onclick = async () => {
    const nivel = m.el.querySelector('#pf-nivel').value;
    const nota = m.el.querySelector('#pf-nivelnota').value.trim();
    if (nivel && !nota) { VP.toast('Escribe el motivo del nivel manual', true); return; }
    try {
      await VP.post({ action: 'mayoreo_save_cliente', cliente: {
        'Customer ID': cid,
        'Saldo Histórico Inicial': Number(m.el.querySelector('#pf-saldo').value) || 0,
        'Nivel Manual': nivel,
        'Nivel Manual Nota': nivel ? nota : '',
        'Notas': m.el.querySelector('#pf-notas').value.trim(),
      } });
      VP.toast('Guardado');
      m.close(); await load(); openPortfolio(cid);
    } catch (e) { VP.toast(e.message, true); }
  };
}

function balance(o) {
  const total = (Number(o['Total']) || 0) + (Number(o['Envío']) || 0);
  return Math.max(0, total - (Number(o['Anticipo Monto']) || 0) - (Number(o['Liquidación Monto']) || 0));
}

/* ── New mayorista ────────────────────────────────────────────────────── */

function openNewClient() {
  const m = VP.showModal(`
    <h2 class="may-h2">Nuevo mayorista</h2>
    <div class="may-note">Busca al cliente existente. Si no existe, créalo con su usuario; los demás datos se completan después.</div>
    <div class="may-combo" style="margin-top:14px">
      <input class="vp-input" id="nc-q" style="width:100%;box-sizing:border-box" placeholder="Usuario, nombre o CUST-…" autocomplete="off">
      <div class="may-combo-list" id="nc-list"></div>
    </div>
    <div id="nc-picked" class="may-note" style="margin-top:10px"></div>
    <div class="may-grid" style="margin-top:12px">
      <label class="may-field">Saldo histórico inicial<input class="vp-input" id="nc-saldo" type="number" min="0" value="0"></label>
    </div>
    <div class="may-actions">
      <button class="btn" id="nc-create" disabled>Crear cliente nuevo</button>
      <button class="btn btn-primary" id="nc-save" disabled>Agregar como mayorista</button>
    </div>
  `, { maxWidth: '520px' });

  let picked = null;
  const q = m.el.querySelector('#nc-q'), list = m.el.querySelector('#nc-list');
  const setPicked = cid => {
    picked = cid;
    m.el.querySelector('#nc-picked').innerHTML = cid ? `Seleccionado: <b>${VP.esc(custName(cid))}</b> ${VP.esc(custUser(cid))} · ${VP.esc(cid)}${cliente(cid) ? ' — <span style="color:var(--amber-text)">ya es mayorista</span>' : ''}` : '';
    m.el.querySelector('#nc-save').disabled = !cid || !!cliente(cid);
  };
  q.addEventListener('input', () => {
    const s = q.value.trim().toLowerCase();
    m.el.querySelector('#nc-create').disabled = s.length < 2;
    if (s.length < 2) { list.classList.remove('open'); return; }
    const hits = ALL_CUST.filter(c => [c['Customer ID'], c['Primary Username'], c['Aliases'], c['First Name'], c['Surname']]
      .join(' ').toLowerCase().includes(s)).slice(0, 12);
    list.innerHTML = hits.map(c => `<div class="may-combo-item" data-cid="${VP.esc(c['Customer ID'])}">@${VP.esc(c['Primary Username'])} <span class="may-sub">${VP.esc(c['Customer ID'])} ${VP.esc([c['First Name'], c['Surname']].filter(Boolean).join(' '))}</span></div>`).join('')
      || '<div class="may-combo-item may-sub">Sin coincidencias</div>';
    list.classList.add('open');
    list.querySelectorAll('[data-cid]').forEach(el => el.onclick = () => { setPicked(el.dataset.cid); list.classList.remove('open'); });
  });
  m.el.querySelector('#nc-create').onclick = async () => {
    const u = q.value.trim().replace(/^@/, '');
    if (!confirm(`¿Crear cliente nuevo con usuario "${u}"?`)) return;
    try {
      const r = await VP.post({ action: 'create_customer', primary_username: u });
      const cid = r.customer_id;
      if (!CUST[cid]) { const rec = { 'Customer ID': cid, 'Primary Username': u }; CUST[cid] = rec; ALL_CUST.push(rec); }
      VP.toast(r.result === 'exists' ? 'Ese usuario ya existía — seleccionado' : 'Cliente creado: ' + cid);
      setPicked(cid);
    } catch (e) { VP.toast(e.message, true); }
  };
  m.el.querySelector('#nc-save').onclick = async () => {
    try {
      await VP.post({ action: 'mayoreo_save_cliente', cliente: {
        'Customer ID': picked, 'Saldo Histórico Inicial': Number(m.el.querySelector('#nc-saldo').value) || 0,
      } });
      VP.toast('Mayorista agregado');
      m.close(); await load(); openPortfolio(picked);
    } catch (e) { VP.toast(e.message, true); }
  };
  setTimeout(() => q.focus(), 50);
}

/* ── Order editor ─────────────────────────────────────────────────────── */

function blankItem() { return { 'Artículo': '', 'Cantidad': 1, 'Precio Unitario': 0, 'Catálogo': 'Regular', _tienda: '' }; }

function isLowQty(it) {
  return it['Catálogo'] !== 'Especial' && !!String(it['Artículo'] || '').trim() && (Number(it['Cantidad']) || 0) < (Number(S.min_pieces) || 0);
}

function openEditor(id, cidForNew) {
  const src = id ? ORDERS.find(o => String(o['Mayoreo ID']) === String(id)) : null;
  const o = src ? JSON.parse(JSON.stringify(src)) : {
    'Mayoreo ID': '', 'Customer ID': cidForNew, 'Fecha': today(), 'Status': 'Cotización',
    'Descuento Origen': 'auto', 'Envío': 0, 'PDF Historial': [], items: [blankItem()],
  };
  if (!o.items || !o.items.length) o.items = [blankItem()];
  const cid = String(o['Customer ID']);
  let manualPct = o['Descuento Origen'] === 'manual' ? Number(o['Descuento %']) : null;

  const m = VP.showModal(`<div id="ed-root"></div>`, { maxWidth: '960px' });
  const root = m.el.querySelector('#ed-root');

  function calc() {
    const reg = o.items.filter(it => it['Catálogo'] !== 'Especial');
    const esp = o.items.filter(it => it['Catálogo'] === 'Especial');
    const line = it => (Number(it['Cantidad']) || 0) * (Number(it['Precio Unitario']) || 0);
    const regSub = reg.reduce((s, it) => s + line(it), 0);
    const espSub = esp.reduce((s, it) => s + line(it), 0);
    const info = tierInfo(cid, { excludeId: o['Mayoreo ID'], orderDate: o['Fecha'], orderSubtotal: regSub + espSub });
    const pct = manualPct !== null && !isNaN(manualPct) ? manualPct : info.pct;
    const desc = Math.round(regSub * pct / 100);
    const total = Math.round(regSub + espSub - desc);
    return { regSub, espSub, sub: regSub + espSub, info, pct, desc, total, pieces: o.items.reduce((s, it) => s + (Number(it['Cantidad']) || 0), 0) };
  }

  // Re-rendering replaces every input, so remember which one had focus
  // (renders are deferred a tick so Tab has already moved focus) and restore it.
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
    const hist = o['PDF Historial'] || [];
    root.innerHTML = `
      <h2 class="may-h2">${o['Mayoreo ID'] ? 'Pedido ' + VP.esc(o['Mayoreo ID']) : 'Nueva cotización'}</h2>
      <div class="may-sub">${VP.esc(custName(cid))} ${VP.esc(custUser(cid))} · ${VP.esc(cid)} · ${tierBadge(c.info.tier)}
        ${c.info.lapsed && c.info.calc && c.info.calc.nivel > 1 ? `<span class="may-flag">sin compras hace ${daysSince(c.info.last, o['Fecha'])} días</span>` : ''}</div>

      <div class="may-grid" style="margin-top:14px">
        <label class="may-field">Fecha<input class="vp-input" type="date" data-f="Fecha" value="${VP.esc(o['Fecha'])}"></label>
        <label class="may-field">Estado<select class="vp-input" data-f="Status">${STATUSES.map(s => `<option ${o['Status'] === s ? 'selected' : ''}>${s}</option>`).join('')}</select></label>
      </div>

      <div class="may-h3">Artículos · ${c.pieces} piezas${o.items.filter(isLowQty).length ? ` <span class="may-warn">· ${o.items.filter(isLowQty).length} con menos de ${S.min_pieces} piezas</span>` : ''}</div>
      <div style="overflow-x:auto"><table class="may-items">
        <colgroup><col><col style="width:84px">${pctMode ? '<col style="width:110px">' : ''}<col style="width:112px"><col style="width:112px"><col style="width:112px"><col style="width:36px"></colgroup>
        <thead><tr><th>Artículo</th><th class="num">Piezas</th>${pctMode ? '<th class="num">Precio tienda</th>' : ''}<th class="num">Precio unit.</th><th class="num">Importe</th><th>Catálogo</th><th></th></tr></thead>
        <tbody>${o.items.map((it, n) => `<tr data-n="${n}">
            <td><input class="vp-input" data-i="Artículo" value="${VP.esc(it['Artículo'])}" placeholder="Nombre del producto"></td>
            <td><input class="vp-input num${isLowQty(it) ? ' may-low' : ''}" type="number" min="0" data-i="Cantidad" value="${VP.esc(it['Cantidad'])}"${isLowQty(it) ? ` title="Menos de ${S.min_pieces} piezas por modelo"` : ''}></td>
            ${pctMode ? `<td>${it['Catálogo'] === 'Especial' ? `<input class="vp-input num" type="number" min="0" data-i="_tienda" value="${VP.esc(it._tienda || '')}" placeholder="-${S.especial_default_pct}%">` : ''}</td>` : ''}
            <td><input class="vp-input num" type="number" min="0" step="0.01" data-i="Precio Unitario" value="${VP.esc(it['Precio Unitario'])}"></td>
            <td class="num">${money((Number(it['Cantidad']) || 0) * (Number(it['Precio Unitario']) || 0))}</td>
            <td><select class="vp-input" data-i="Catálogo"><option ${it['Catálogo'] !== 'Especial' ? 'selected' : ''}>Regular</option><option ${it['Catálogo'] === 'Especial' ? 'selected' : ''}>Especial</option></select></td>
            <td><button class="btn btn-xs" data-del="${n}" tabindex="-1" title="Quitar">✕</button></td>
          </tr>`).join('')}</tbody></table></div>
      <button class="btn btn-sm" id="ed-add" style="margin-top:8px">+ Agregar artículo</button>

      <div style="display:flex;gap:24px;flex-wrap:wrap;margin-top:18px">
        <div style="flex:1;min-width:260px">
          <div class="may-grid">
            <label class="may-field">Descuento %<input class="vp-input" type="number" min="0" max="100" id="ed-pct" value="${c.pct}"></label>
            <label class="may-field">Envío<input class="vp-input" type="number" min="0" data-f="Envío" value="${VP.esc(o['Envío'] || 0)}"></label>
          </div>
          ${manualPct !== null ? `<label class="may-field" style="margin-top:8px">Motivo del descuento manual (auto: ${c.info.pct}%)
            <input class="vp-input" data-f="Descuento Nota" value="${VP.esc(o['Descuento Nota'] || '')}"></label>
            <button class="btn btn-xs" id="ed-auto" style="margin-top:6px">Volver al automático</button>` : ''}
          <div class="may-h3">Pagos</div>
          <div class="may-grid">
            <label class="may-field">Anticipo<input class="vp-input" type="number" min="0" data-f="Anticipo Monto" value="${VP.esc(o['Anticipo Monto'] || '')}" placeholder="${money(c.total / 2)}"></label>
            <label class="may-field">Fecha anticipo<input class="vp-input" type="date" data-f="Anticipo Fecha" value="${VP.esc(o['Anticipo Fecha'] || '')}"></label>
            <label class="may-field">Liquidación<input class="vp-input" type="number" min="0" data-f="Liquidación Monto" value="${VP.esc(o['Liquidación Monto'] || '')}"></label>
            <label class="may-field">Fecha liquidación<input class="vp-input" type="date" data-f="Liquidación Fecha" value="${VP.esc(o['Liquidación Fecha'] || '')}"></label>
          </div>
          <label class="may-field" style="margin-top:10px">Notas internas<input class="vp-input" data-f="Notas" value="${VP.esc(o['Notas'] || '')}"></label>
        </div>
        <div class="may-totals">
          <div><span>Subtotal regular</span><span>${money(c.regSub)}</span></div>
          <div><span>Descuento (${c.pct}%)</span><span>−${money(c.desc)}</span></div>
          ${c.espSub ? `<div><span>Catálogo especial</span><span>${money(c.espSub)}</span></div>` : ''}
          <div class="big"><span>Total</span><span>${money(c.total)}</span></div>
          <div><span>Envío</span><span>${money(o['Envío'])}</span></div>
          <div><span>Pagado</span><span>${money((Number(o['Anticipo Monto']) || 0) + (Number(o['Liquidación Monto']) || 0))}</span></div>
          <div><b>Pendiente</b><b>${money(balance(Object.assign({}, o, { 'Total': c.total })))}</b></div>
          ${!c.info.hist.total && c.sub < (tiersSorted()[0] || {}).min ? `<div class="may-warn">Pedido de apertura mínimo ${money(tiersSorted()[0].min)}</div>` : ''}
        </div>
      </div>

      ${hist.length ? `<div class="may-h3">Versiones del PDF</div><div class="may-pdfs">${hist.slice().reverse().map(h => `<a href="${VP.esc(h.url)}" target="_blank" rel="noopener">v${h.v} · ${VP.esc(h.fecha)} · ${money(h.total)}</a>`).join('')}</div>` : ''}

      <div class="may-actions">
        ${o['Mayoreo ID'] ? '<button class="btn" id="ed-del" style="margin-right:auto;color:var(--red-text)">Eliminar</button>' : ''}
        <button class="btn" id="ed-save">Guardar</button>
        <button class="btn btn-primary" id="ed-pdf">Guardar y generar PDF</button>
      </div>`;
    wire();
    restoreFocus(fk);
  }

  function wire() {
    root.querySelectorAll('[data-f]').forEach(el => el.addEventListener('change', () => { o[el.dataset.f] = el.value; later(); }));
    root.querySelectorAll('tr[data-n]').forEach(tr => {
      const it = o.items[Number(tr.dataset.n)];
      tr.querySelectorAll('[data-i]').forEach(el => { if (el.tagName === 'INPUT') el.addEventListener('focus', () => el.select()); });
      tr.querySelectorAll('[data-i]').forEach(el => el.addEventListener('change', () => {
        const k = el.dataset.i;
        it[k] = el.type === 'number' ? Number(el.value) : el.value;
        if (k === '_tienda' && it._tienda) it['Precio Unitario'] = Math.round(it._tienda * (1 - (Number(S.especial_default_pct) || 0) / 100) * 100) / 100;
        later();
      }));
    });
    root.querySelectorAll('[data-del]').forEach(b => b.onclick = () => { o.items.splice(Number(b.dataset.del), 1); if (!o.items.length) o.items.push(blankItem()); render(); });
    root.querySelector('#ed-add').onclick = () => { o.items.push(blankItem()); render(); const ins = root.querySelectorAll('[data-i="Artículo"]'); ins[ins.length - 1].focus(); };
    // Excel feel: Tab out of the last row's last cell opens a fresh row.
    const lastSel = root.querySelector('tr[data-n]:last-child select[data-i="Catálogo"]');
    if (lastSel) lastSel.addEventListener('keydown', e => {
      if (e.key === 'Tab' && !e.shiftKey) {
        e.preventDefault();
        o.items.push(blankItem()); render();
        const ins = root.querySelectorAll('[data-i="Artículo"]'); ins[ins.length - 1].focus();
      }
    });
    root.querySelector('#ed-pct').addEventListener('change', e => {
      const v = Number(e.target.value);
      manualPct = v === calc().info.pct && manualPct === null ? null : v;
      later();
    });
    const auto = root.querySelector('#ed-auto');
    if (auto) auto.onclick = () => { manualPct = null; o['Descuento Nota'] = ''; render(); };
    root.querySelector('#ed-save').onclick = () => save(false);
    root.querySelector('#ed-pdf').onclick = () => save(true);
    const del = root.querySelector('#ed-del');
    if (del) del.onclick = async () => {
      if (!confirm(`¿Eliminar ${o['Mayoreo ID']}? Esto no se puede deshacer.`)) return;
      try { await VP.post({ action: 'mayoreo_delete_order', id: o['Mayoreo ID'] }); VP.toast('Eliminado'); m.close(); await load(); }
      catch (e) { VP.toast(e.message, true); }
    };
  }

  function payload(c) {
    const head = Object.assign({}, o);
    delete head.items;
    Object.assign(head, {
      'Subtotal': c.sub, 'Descuento %': c.pct, 'Total': c.total,
      'Descuento Origen': manualPct !== null ? 'manual' : 'auto',
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
        const url = await uploadPdf(blob);
        const hist = (o['PDF Historial'] || []).concat([{ v, url, fecha: today(), total: c.total }]);
        o['PDF Historial'] = hist; o['PDF Versión'] = v; o['PDF URL'] = url;
        await VP.post({ action: 'mayoreo_save_order', order: { 'Mayoreo ID': r.id, 'Customer ID': cid, 'PDF URL': url, 'PDF Versión': v, 'PDF Historial': hist } });
        downloadBlob(blob, pdfName(head, v));
      }
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

/* ── PDF ──────────────────────────────────────────────────────────────── */

function pdfName(head, v) {
  const n = custName(head['Customer ID']).replace(/[^\w\-]+/g, '_');
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
  doc.text(custName(head['Customer ID']), L, 51);
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

  const ant = Number(head['Anticipo Monto']) || 0, liq = Number(head['Liquidación Monto']) || 0, env = Number(head['Envío']) || 0;
  row('Anticipo 50%', ant ? `${fmt(ant)} pagado` : fmt(c.total / 2));
  row('Resto 50% + envío', liq ? `${fmt(liq)} pagado` : fmt(c.total - (ant || c.total / 2)) + (env ? ` + ${fmt(env)}` : ' + envío'));
  const pend = Math.max(0, c.total + env - ant - liq);
  if (ant || liq) row('Saldo pendiente', fmt(pend), true);

  // Progress nudge
  const after = c.info.hist.total + (S.history_basis === 'before' ? c.sub : c.total);
  const nextAfter = tiersSorted().find(t => t.min > after);
  y += 4;
  if (nextAfter) {
    doc.setFont('helvetica', 'italic'); doc.setFontSize(9); doc.setTextColor(...muted);
    doc.text(`Con este pedido llevarás ${fmt(after)} en compras. Te faltarán ${fmt(Math.max(0, nextAfter.min - after))} para Nivel ${nextAfter.nivel} (${nextAfter.pct}% de descuento).`, L, y, { maxWidth: R - L });
    y += 10;
  }

  // Footer: payment + terms
  let fy = Math.max(y + 6, doc.internal.pageSize.getHeight() - 52);
  doc.setDrawColor(...line); doc.line(L, fy, R, fy); fy += 6;
  doc.setFont('helvetica', 'bold'); doc.setFontSize(9); doc.setTextColor(...ink);
  doc.text('Forma de pago', L, fy);
  doc.setFont('helvetica', 'normal'); doc.setTextColor(...muted); doc.setFontSize(8.5);
  const bank = String(S.pdf_bank_info || 'Transferencia bancaria (datos por WhatsApp).');
  doc.text(bank.split('\n'), L, fy + 5);
  doc.text('Precios en MXN. 50% de anticipo para apartar mercancía; 50% restante + envío al estar listo el pedido. ' +
    'Preparación hasta 1 semana hábil tras el anticipo. El envío corre por cuenta del cliente; no nos hacemos ' +
    'responsables por daños o retrasos de la paquetería. Entregamos evidencia fotográfica del paquete.',
    L + 88, fy + 5, { maxWidth: R - L - 88 });
  return doc.output('blob');
}

async function uploadPdf(blob) {
  const sig = await VP.get('action=get_upload_signature&folder=' + encodeURIComponent('velpapier/mayoreo'));
  const fd = new FormData();
  fd.append('file', blob, 'cotizacion.pdf');
  fd.append('api_key', sig.api_key);
  fd.append('timestamp', sig.timestamp);
  fd.append('folder', sig.folder);
  fd.append('signature', sig.signature);
  const r = await fetch(`https://api.cloudinary.com/v1_1/${sig.cloud}/raw/upload`, { method: 'POST', body: fd });
  const j = await r.json();
  if (!r.ok || !j.secure_url) throw new Error('No se pudo subir el PDF: ' + ((j.error && j.error.message) || r.status));
  return j.secure_url;
}

function downloadBlob(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

/* ── Settings modal ───────────────────────────────────────────────────── */

function openSettings() {
  const t = tiersSorted();
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
      <label class="may-field">Compras de TikTok cuentan
        <select class="vp-input" id="st-tt"><option value="false" ${!S.count_tiktok ? 'selected' : ''}>No</option><option value="true" ${S.count_tiktok ? 'selected' : ''}>Sí</option></select></label>
      <label class="may-field">Monto que cuenta
        <select class="vp-input" id="st-basis"><option value="after" ${S.history_basis !== 'before' ? 'selected' : ''}>Después del descuento</option><option value="before" ${S.history_basis === 'before' ? 'selected' : ''}>Antes del descuento</option></select></label>
      <label class="may-field">El pedido actual cuenta para su propio nivel
        <select class="vp-input" id="st-cur"><option value="false" ${!S.current_counts ? 'selected' : ''}>No</option><option value="true" ${S.current_counts ? 'selected' : ''}>Sí</option></select></label>
    </div>

    <div class="may-h3">Inactividad (niveles 2 y 3)</div>
    <div class="may-grid">
      <label class="may-field">Días sin comprar<input class="vp-input" type="number" min="1" id="st-days" value="${S.lapse_days}"></label>
      <label class="may-field">Qué pasa
        <select class="vp-input" id="st-lapse">
          <option value="flag" ${S.lapse_rule === 'flag' ? 'selected' : ''}>Solo marcar</option>
          <option value="drop_one" ${S.lapse_rule === 'drop_one' ? 'selected' : ''}>Baja un nivel</option>
          <option value="drop_to_1" ${S.lapse_rule === 'drop_to_1' ? 'selected' : ''}>Baja a Nivel 1</option>
        </select></label>
    </div>

    <div class="may-h3">Catálogo especial y pedidos</div>
    <div class="may-grid">
      <label class="may-field">Precio especial
        <select class="vp-input" id="st-esp"><option value="manual" ${S.especial_mode !== 'percent' ? 'selected' : ''}>Escribir precio</option><option value="percent" ${S.especial_mode === 'percent' ? 'selected' : ''}>% sobre precio de tienda</option></select></label>
      <label class="may-field">% especial por defecto<input class="vp-input" type="number" min="0" max="100" id="st-esppct" value="${S.especial_default_pct}"></label>
      <label class="may-field">Mínimo de piezas por modelo<input class="vp-input" type="number" min="0" id="st-min" value="${S.min_pieces}"></label>
    </div>

    <div class="may-h3">PDF</div>
    <div class="may-grid">
      <label class="may-field">Vigencia (días)<input class="vp-input" type="number" min="0" id="st-valid" value="${S.pdf_validity_days || 0}"></label>
    </div>
    <label class="may-field" style="margin-top:8px">Datos bancarios (aparecen en el PDF)
      <textarea class="vp-input" id="st-bank" rows="3">${VP.esc(S.pdf_bank_info || '')}</textarea></label>

    <div class="may-actions"><button class="btn btn-primary" id="st-save">Guardar ajustes</button></div>
  `, { maxWidth: '620px' });

  m.el.querySelector('#st-save').onclick = async () => {
    const q = s => m.el.querySelector(s);
    const tiers = t.map((x, i) => ({ nivel: x.nivel, min: Number(q(`[data-tmin="${i}"]`).value) || 0, pct: Number(q(`[data-tpct="${i}"]`).value) || 0 }));
    const settings = Object.assign({}, S, {
      tiers,
      count_tiktok: q('#st-tt').value === 'true',
      history_basis: q('#st-basis').value,
      current_counts: q('#st-cur').value === 'true',
      lapse_days: Number(q('#st-days').value) || 30,
      lapse_rule: q('#st-lapse').value,
      especial_mode: q('#st-esp').value,
      especial_default_pct: Number(q('#st-esppct').value) || 0,
      min_pieces: Number(q('#st-min').value) || 0,
      pdf_validity_days: Number(q('#st-valid').value) || 0,
      pdf_bank_info: q('#st-bank').value,
    });
    try {
      const r = await VP.post({ action: 'mayoreo_save_settings', settings });
      S = r.settings || settings;
      VP.toast('Ajustes guardados');
      m.close(); renderList();
    } catch (e) { VP.toast(e.message, true); }
  };
}
