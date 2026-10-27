/* ============================================================================
   Clientes page (clientes.html)
   Backend: clientes.gs (cli_* actions) + the existing merge/dedup actions.
   Staff with the "clientes" scope get a read-only list/detail; the server
   removes phone, email, address and notes for them. Every button that writes
   is only drawn for admins, and the server enforces it again.
   ========================================================================== */
(function () {
  'use strict';

  const esc = VP.esc;
  const $ = id => document.getElementById(id);

  const PRESET_TAGS = ['Frecuente', 'VIP', 'Problemático'];
  const PAGE_SIZE = 60;
  const DUP_DEFAULT = 55;

  // [header, label, fullWidth, type]
  const FORM_FIELDS = [
    ['Primary Username', 'Usuario'], ['Aliases', 'Alias (separados por coma)'],
    ['First Name', 'Nombre'], ['Surname', 'Apellido'],
    ['Initials (TT Format)', 'Iniciales'], ['Email', 'Email'],
    ['Phone Partial', 'Tel. parcial'], ['Phone Full', 'Tel. completo'],
    ['Street + Number', 'Calle y número', true],
    ['City', 'Ciudad'], ['State', 'Estado'], ['ZIP', 'CP'],
    ['Notes', 'Notas', true, 'textarea'],
  ];

  const COMPARE_FIELDS = [
    ['Customer ID', 'ID'], ['Primary Username', 'Usuario'], ['First Name', 'Nombre'], ['Surname', 'Apellido'],
    ['Initials (TT Format)', 'Iniciales'], ['Email', 'Email'], ['Phone Partial', 'Tel. parcial'],
    ['Phone Full', 'Tel. completo'], ['Street + Number', 'Calle y número'], ['City', 'Ciudad'],
    ['State', 'Estado'], ['ZIP', 'CP'], ['Aliases', 'Alias'], ['Shipment Count', 'Envíos'],
    ['Tags', 'Etiquetas'], ['Notes', 'Notas'],
  ];

  let ADMIN = false;
  let records = [];
  let byId = {};
  let view = [];
  let stale = false;
  let tab = 'clientes';
  let shown = PAGE_SIZE;
  let seg = 'all';
  let sortKey = 'recent';
  let q = '';

  /* ── helpers ──────────────────────────────────────────────────────────── */

  const norm = s => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/@/g, '');
  const dispName = r => r.username || r.name || r.id;
  const digits = s => String(s || '').replace(/\D/g, '');

  function tagClass(t) {
    const k = norm(t);
    if (k === 'vip') return ' cl-tag--vip';
    if (k === 'frecuente') return ' cl-tag--frecuente';
    if (k === 'problematico') return ' cl-tag--problematico';
    return '';
  }
  const tagsHtml = tags => String(tags || '').split(',').map(t => t.trim()).filter(Boolean)
    .map(t => `<span class="cl-tag${tagClass(t)}">${esc(t)}</span>`).join('');

  function statusPill(s) {
    const map = { 'Pagado': 'pill-pagado', 'No Pagado': 'pill-nopagado', 'Enviado': 'pill-enviado', 'Anotado': 'pill-anotado' };
    return `<span class="status-pill ${map[s] || ''}">${esc(s || '—')}</span>`;
  }

  async function withBusy(btn, label, fn) {
    if (!btn || btn.disabled) return;
    const old = btn.textContent;
    btn.disabled = true; btn.textContent = label;
    try { return await fn(); }
    catch (e) { VP.toast(e.message || String(e), true); }
    finally { if (document.body.contains(btn)) { btn.disabled = false; btn.textContent = old; } }
  }

  // Promise<boolean>. Closing the dialog any other way (X, outside click, Escape) counts as "no".
  function askConfirm(opts) {
    return new Promise(resolve => {
      const m = VP.showModal(
        `<h3 class="cl-h">${esc(opts.title)}</h3>
         <div style="font-size:13px;line-height:1.5;margin-top:8px">${opts.html}</div>
         <div class="cl-actions">
           <button class="btn" data-x="no">${esc(opts.cancelLabel || 'Cancelar')}</button>
           <button class="btn ${opts.danger ? 'btn-danger' : 'btn-primary'}" data-x="yes">${esc(opts.ok || 'Confirmar')}</button>
         </div>`, { maxWidth: '480px' });
      let done = false;
      const obs = new MutationObserver(() => { if (!document.body.contains(m.el)) fin(false); });
      function fin(v) { if (done) return; done = true; obs.disconnect(); m.close(); resolve(v); }
      obs.observe(document.body, { childList: true });
      m.el.addEventListener('click', e => { const b = e.target.closest('[data-x]'); if (b) fin(b.dataset.x === 'yes'); });
    });
  }

  function refreshListSoon() {
    stale = true;
    if (tab === 'clientes' && $('cl-list')) loadRecords();
  }

  /* ── tabs ─────────────────────────────────────────────────────────────── */

  function renderTabs() {
    const tabs = [['clientes', 'Clientes']];
    if (ADMIN) tabs.push(['duplicados', 'Duplicados'], ['fusiones', 'Fusiones'], ['eliminados', 'Eliminados'], ['shopify', 'Shopify']);
    const el = $('cl-tabs');
    if (tabs.length === 1) { el.style.display = 'none'; return; }
    el.innerHTML = tabs.map(([id, label]) => `<button class="cl-tab${id === tab ? ' is-active' : ''}" data-tab="${id}" type="button">${label}</button>`).join('');
  }

  function setTab(t) {
    tab = t;
    renderTabs();
    const p = $('cl-panel');
    p.onclick = null;
    ({ clientes: showClientes, duplicados: showDuplicados, fusiones: showFusiones, eliminados: showEliminados, shopify: showShopify })[t]();
  }

  /* ── Clientes tab: list ───────────────────────────────────────────────── */

  const NOW = Date.now();
  const sameMonth = ms => { if (isNaN(ms)) return false; const d = new Date(ms), n = new Date(); return d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth(); };
  const SEGS = [
    ['all', 'Todos', () => true],
    ['rec', 'Recurrentes', r => r.sc >= 2],
    ['new', 'Nuevos este mes', r => sameMonth(r._first)],
    ['dorm', 'Dormidos (+90 días)', r => r.oc > 0 && !isNaN(r._last) && NOW - r._last > 90 * 864e5],
    ['none', 'Sin pedidos', r => r.oc === 0],
    ['tag', 'Con etiqueta', r => !!r.tags],
  ];
  const num = (a, b) => (b || 0) - (a || 0);
  const msOr = v => isNaN(v) ? -1 : v;
  const SORTS = {
    recent: (a, b) => msOr(b._last) - msOr(a._last),
    orders: (a, b) => num(a.oc, b.oc),
    ships: (a, b) => num(a.sc, b.sc),
    newest: (a, b) => msOr(b._first) - msOr(a._first),
    name: (a, b) => dispName(a).localeCompare(dispName(b), 'es'),
  };

  function prep(r) {
    r._last = r.last ? Date.parse(r.last) : NaN;
    r._first = r.first ? Date.parse(r.first) : NaN;
    r._h = norm([r.username, r.aliases, r.name, r.id, r.city, r.state, r.tags, r.phone, digits(r.phone), r.email].join(' '));
  }

  async function loadRecords() {
    const list = $('cl-list');
    if (list && !records.length) list.innerHTML = '<div class="vp-loading">Cargando clientes…</div>';
    try {
      const d = await VP.get('action=cli_list');
      records = d.records || [];
      records.forEach(prep);
      byId = {};
      records.forEach(r => { byId[r.id] = r; });
      stale = false;
      $('cl-sub').textContent = VP.num(records.length) + ' clientes' + (ADMIN ? '' : ' · solo lectura');
      if ($('cl-list')) renderAll();
    } catch (e) {
      if ($('cl-list')) $('cl-list').innerHTML = `<div class="vp-empty-sm">Error al cargar clientes: ${esc(e.message)}</div>`;
    }
  }

  function applyFilter() {
    const toks = norm(q).split(/\s+/).filter(Boolean);
    const segFn = SEGS.find(s => s[0] === seg)[2];
    view = records.filter(r => segFn(r) && toks.every(t => r._h.indexOf(t) >= 0));
    view.sort(SORTS[sortKey]);
  }

  function renderChips() {
    const toks = norm(q).split(/\s+/).filter(Boolean);
    const base = records.filter(r => toks.every(t => r._h.indexOf(t) >= 0));
    $('cl-chips').innerHTML = SEGS.map(([id, label, fn]) =>
      `<button class="cl-chip${id === seg ? ' is-active' : ''}" data-seg="${id}" type="button">${label}<small>${VP.num(base.filter(fn).length)}</small></button>`).join('');
  }

  function renderRows() {
    applyFilter();
    $('cl-count').textContent = VP.num(view.length) + ' de ' + VP.num(records.length) + ' clientes';
    if (!view.length) {
      $('cl-list').innerHTML = '<div class="cl-empty">Ningún cliente coincide con la búsqueda.</div>';
      return;
    }
    const rows = view.slice(0, shown).map(r => `
      <div class="cl-row" data-id="${esc(r.id)}">
        <div class="cl-main"><b>${esc(dispName(r))}</b><small>${esc(r.id)}${r.name && r.username ? ' · ' + esc(r.name) : ''}</small></div>
        <div class="cl-loc">${esc([r.city, r.state].filter(Boolean).join(', ') || '—')}</div>
        <div class="cl-n">${VP.num(r.oc)}</div>
        <div class="cl-n">${VP.num(r.sc)}</div>
        <div class="cl-date">${r.last ? esc(VP.fmtDate(r.last)) : '—'}</div>
        <div class="cl-tagcell">${tagsHtml(r.tags)}</div>
      </div>`).join('');
    $('cl-list').innerHTML = `<div class="cl-head"><div>Cliente</div><div>Ubicación</div><div class="cl-n">Pedidos</div><div class="cl-n">Envíos</div><div>Último</div><div>Etiquetas</div></div>${rows}` +
      (view.length > shown ? `<button class="btn cl-more" id="cl-more" type="button">Mostrar más (${VP.num(view.length - shown)})</button>` : '');
  }

  function renderAll() { renderChips(); renderRows(); }

  async function showClientes() {
    const p = $('cl-panel');
    p.innerHTML = `
      <div class="cl-toolbar">
        <input type="search" id="cl-q" class="cl-search" placeholder="Buscar por usuario, alias, nombre, ID, ciudad${ADMIN ? ', teléfono, email' : ''}…" value="${esc(q)}" autocomplete="off">
        <select id="cl-sort" class="sort-select">
          <option value="recent">Último pedido</option><option value="orders">Más pedidos</option><option value="ships">Más envíos</option>
          <option value="newest">Más nuevos</option><option value="name">Nombre A–Z</option>
        </select>
        ${ADMIN ? '<button class="btn btn-primary" id="cl-new" type="button">+ Nuevo cliente</button><button class="btn" id="cl-export" type="button">Exportar CSV</button>' : ''}
        <button class="refresh-btn" id="cl-refresh" type="button" title="Actualizar" aria-label="Actualizar">↻</button>
      </div>
      <div class="cl-chips" id="cl-chips"></div>
      <div class="cl-count" id="cl-count"></div>
      <div id="cl-list"></div>`;
    $('cl-sort').value = sortKey;

    let timer;
    $('cl-q').addEventListener('input', e => {
      clearTimeout(timer);
      timer = setTimeout(() => { q = e.target.value; shown = PAGE_SIZE; renderAll(); }, 120);
    });
    $('cl-sort').addEventListener('change', e => { sortKey = e.target.value; shown = PAGE_SIZE; renderRows(); });
    p.onclick = e => {
      const chip = e.target.closest('[data-seg]');
      if (chip) { seg = chip.dataset.seg; shown = PAGE_SIZE; renderAll(); return; }
      if (e.target.closest('#cl-more')) { shown += PAGE_SIZE; renderRows(); return; }
      if (e.target.closest('#cl-refresh')) { loadRecords(); return; }
      if (e.target.closest('#cl-new')) { openCreate(); return; }
      const ex = e.target.closest('#cl-export');
      if (ex) { exportCsv(ex); return; }
      const row = e.target.closest('.cl-row');
      if (row) openDetail(row.dataset.id);
    };

    if (!records.length || stale) await loadRecords(); else renderAll();
  }

  /* ── CSV export (admin) ───────────────────────────────────────────────── */

  function csvCell(v) {
    let s = String(v === null || v === undefined ? '' : v);
    if (/^[=@]/.test(s)) s = "'" + s;   // stop Excel from running a username that starts with = or @
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  function exportCsv(btn) {
    return withBusy(btn, 'Exportando…', async () => {
      const d = await VP.get('action=cli_export');
      const iId = d.headers.indexOf('Customer ID');
      const ids = new Set(view.map(r => r.id));
      const rows = d.rows.filter(r => ids.has(String(r[iId])));
      const csv = '\uFEFF' + [d.headers].concat(rows).map(r => r.map(csvCell).join(',')).join('\r\n');
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
      a.download = 'clientes_' + new Date().toISOString().slice(0, 10) + '.csv';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
      VP.toast(VP.num(rows.length) + ' clientes exportados');
    });
  }

  /* ── detail modal ─────────────────────────────────────────────────────── */

  async function openDetail(id, startSub) {
    const m = VP.showModal('<div class="vp-loading">Cargando cliente…</div>', { maxWidth: '860px' });
    const st = { id, m, box: m.el.querySelector('.vp-modal-body'), data: null, sub: startSub || 'orders' };
    await loadDetail(st);
  }

  async function loadDetail(st) {
    try {
      st.data = await VP.get('action=cli_detail&customer_id=' + encodeURIComponent(st.id));
      renderDetail(st);
    } catch (e) {
      st.box.innerHTML = `<div class="vp-empty-sm">${esc(e.message)}</div>`;
    }
  }

  function waLink(phone) {
    let d = digits(phone);
    if (d.length < 10) return '';
    if (d.length === 10) d = '52' + d;
    return 'https://wa.me/' + d;
  }

  function describeAudit(a) {
    switch (a.action) {
      case 'cli_update': return `Editó <b>${esc(a.field)}</b>: «${esc(a.before || '—')}» → «${esc(a.after || '—')}»`;
      case 'add_alias': return `Alias añadido: «${esc(a.after)}»`;
      case 'cli_create': case 'create_customer': return 'Cliente creado';
      case 'merge_customers': return 'Fusión de clientes';
      case 'undo_merge': return 'Fusión deshecha';
      case 'resolve_shopify_match': return 'Coincidencia de Shopify resuelta';
      case 'cli_recalc': return `Recalculó <b>${esc(a.field)}</b>: ${esc(a.before)} → ${esc(a.after)}`;
      case 'cli_restore': return 'Cliente restaurado';
      default: return esc(a.action) + (a.field ? ' · ' + esc(a.field) : '');
    }
  }

  function renderDetail(st) {
    const d = st.data, c = d.customer;
    const lastOrder = d.orders.find(o => o.channel !== 'Nota');
    const infoRow = (label, html) => html ? `<div class="cl-info-row"><span>${esc(label)}</span><span>${html}</span></div>` : '';
    const phone = c['Phone Full'] || c['Phone Partial'] || '';
    const wa = d.admin ? waLink(c['Phone Full']) : '';
    const addr = [c['Street + Number'], c['ZIP'], c['City'], c['State']].filter(Boolean).join(', ');

    const subs = [['orders', 'Pedidos (' + d.orders_total + ')']];
    if (d.admin) subs.push(['history', 'Historial'], ['merges', 'Fusiones (' + d.merges.length + ')']);

    st.box.innerHTML = `
      <h3 class="cl-h">${esc(c['Primary Username'] || [c['First Name'], c['Surname']].filter(Boolean).join(' ') || c['Customer ID'])}</h3>
      <div class="cl-sub"><span class="cl-mono">${esc(c['Customer ID'])}</span> ${tagsHtml(c['Tags'])}</div>
      ${d.admin ? `<div class="cl-actions cl-actions--left">
        <button class="btn btn-sm" data-act="edit" type="button">Editar</button>
        <button class="btn btn-sm" data-act="merge" type="button">Fusionar con…</button>
        <button class="btn btn-sm" data-act="recalc" type="button">Recalcular</button>
        <button class="btn btn-sm btn-danger" data-act="delete" type="button">Eliminar</button>
      </div>` : ''}
      <div class="cl-stats">
        <div class="cl-stat"><span>Pedidos</span><b>${VP.num(d.orders_total)}</b></div>
        <div class="cl-stat"><span>Envíos</span><b>${VP.num(c['Shipment Count'])}</b></div>
        <div class="cl-stat"><span>Primer pedido</span><b>${esc(VP.fmtDate(c['First Order Date']))}</b></div>
        <div class="cl-stat"><span>Último pedido</span><b>${lastOrder ? esc(VP.fmtDate(lastOrder.date)) : '—'}</b></div>
        ${d.admin ? `<div class="cl-stat"><span>Total (Pagado + Enviado)</span><b>${esc(VP.mxnExact(d.spend))}</b></div>` : ''}
      </div>
      <div class="cl-info">
        ${infoRow('Nombre', esc([c['First Name'], c['Surname']].filter(Boolean).join(' ')))}
        ${infoRow('Ubicación', esc([c['City'], c['State']].filter(Boolean).join(', ')))}
        ${infoRow('Alias', esc(c['Aliases']))}
        ${d.admin ? infoRow('Teléfono', phone ? esc(phone) + (wa ? ` · <a href="${esc(wa)}" target="_blank" rel="noopener">WhatsApp</a>` : '') : '') : ''}
        ${d.admin ? infoRow('Email', c['Email'] ? `<a href="mailto:${esc(c['Email'])}">${esc(c['Email'])}</a>` : '') : ''}
        ${d.admin ? infoRow('Dirección', esc(addr)) : ''}
        ${d.admin ? infoRow('ID de Shopify', c['Shopify Customer ID'] ? `<span class="cl-mono">${esc(c['Shopify Customer ID'])}</span>` : '') : ''}
        ${d.admin ? infoRow('Notas', esc(c['Notes']).replace(/\n/g, '<br>')) : ''}
      </div>
      <div class="cl-subtabs">${subs.map(([id, label]) => `<button class="cl-subtab${id === st.sub ? ' is-active' : ''}" data-sub="${id}" type="button">${esc(label)}</button>`).join('')}</div>
      <div class="cl-scroll" id="cl-subbody"></div>`;

    renderSub(st);
    st.box.onclick = e => {
      const sub = e.target.closest('[data-sub]');
      if (sub) { st.sub = sub.dataset.sub; renderDetail(st); return; }
      const act = e.target.closest('[data-act]');
      if (act) { detailAction(st, act); return; }
      const undo = e.target.closest('[data-undo]');
      if (undo) { undoMerge(undo, st); return; }
    };
  }

  function renderSub(st) {
    const d = st.data, el = st.box.querySelector('#cl-subbody');
    if (st.sub === 'orders') {
      if (!d.orders.length) { el.innerHTML = '<div class="vp-empty-sm">Este cliente todavía no tiene pedidos.</div>'; return; }
      el.innerHTML = d.orders.map(o => `
        <div class="cl-lrow">
          <div style="min-width:0"><span class="cl-mono" style="overflow-wrap:anywhere">${esc(o.order_id || '—')}</span><br><small>${esc(o.channel)}${o.tracking_id ? ' · ' + esc(o.tracking_id) : ''}</small></div>
          <div style="display:flex;gap:10px;align-items:center">${statusPill(o.status)}<small>${esc(VP.fmtDate(o.date))}</small>${o.price !== undefined ? `<span>${esc(VP.mxnExact(o.price))}</span>` : ''}</div>
        </div>`).join('') +
        (d.orders_total > d.orders.length ? `<div class="vp-empty-sm">Mostrando los ${d.orders.length} más recientes de ${d.orders_total}.</div>` : '');
    } else if (st.sub === 'history') {
      el.innerHTML = d.timeline.length ? d.timeline.map(a => `
        <div class="cl-lrow"><div>${describeAudit(a)}<br><small>${esc(a.person)}</small></div><small>${esc(VP.fmtDateTime(a.ts))}</small></div>`).join('')
        : '<div class="vp-empty-sm">Sin cambios registrados este año.</div>';
    } else if (st.sub === 'merges') {
      el.innerHTML = d.merges.length ? d.merges.map(mg => `
        <div class="cl-lrow">
          <div>${esc(mg.merged_username || mg.merged_id)} → ${esc(mg.kept_username || mg.kept_id)}<br><small>${esc(VP.fmtDateTime(mg.date))} · ${esc(mg.status)}</small></div>
          ${mg.status === 'Activo' ? `<button class="btn btn-sm" data-undo="${esc(mg.merge_id)}" type="button">Deshacer</button>` : ''}
        </div>`).join('')
        : '<div class="vp-empty-sm">Este cliente no ha sido fusionado.</div>';
    }
  }

  function detailAction(st, btn) {
    const act = btn.dataset.act;
    if (act === 'edit') return renderEdit(st);
    if (act === 'merge') return openMergePicker(st);
    if (act === 'recalc') return withBusy(btn, 'Calculando…', async () => {
      const r = await VP.post({ action: 'cli_recalc', customer_id: st.id });
      VP.toast('Envíos: ' + r.shipment_count + ' · primer pedido: ' + VP.fmtDate(r.first_order_date));
      await loadDetail(st); refreshListSoon();
    });
    if (act === 'delete') return doDelete(st);
  }

  /* ── edit / create form ───────────────────────────────────────────────── */

  let formTags = [];

  function formHtml(values) {
    return `<div class="cl-form">${FORM_FIELDS.map(([h, label, full, type]) => `
      <div class="form-group${full ? ' full' : ''}"><label>${esc(label)}</label>${type === 'textarea'
        ? `<textarea data-f="${esc(h)}">${esc(values[h] || '')}</textarea>`
        : `<input data-f="${esc(h)}" value="${esc(values[h] || '')}" autocomplete="off">`}</div>`).join('')}
      <div class="form-group full"><label>Etiquetas</label><div class="cl-tagedit" id="cl-tagedit"></div></div>
    </div>`;
  }

  function renderTagEditor(root) {
    const el = root.querySelector('#cl-tagedit');
    if (!el) return;
    const extra = formTags.filter(t => PRESET_TAGS.map(norm).indexOf(norm(t)) < 0);
    const has = t => formTags.some(x => norm(x) === norm(t));
    el.innerHTML = PRESET_TAGS.map(t => `<button type="button" class="cl-tagbtn${has(t) ? ' is-on' : ''}" data-tag="${esc(t)}">${esc(t)}</button>`).join('') +
      extra.map(t => `<button type="button" class="cl-tagbtn is-on" data-tag="${esc(t)}" title="Quitar">${esc(t)} ✕</button>`).join('') +
      '<input class="cl-taginput" id="cl-taginput" placeholder="Otra etiqueta + Enter" maxlength="30">';
    el.onclick = e => {
      const b = e.target.closest('[data-tag]');
      if (!b) return;
      const t = b.dataset.tag;
      formTags = has(t) ? formTags.filter(x => norm(x) !== norm(t)) : formTags.concat([t]);
      renderTagEditor(root);
    };
    el.querySelector('#cl-taginput').addEventListener('keydown', e => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const t = e.target.value.replace(/,/g, ' ').trim();
      if (t && !has(t)) formTags.push(t);
      renderTagEditor(root);
      root.querySelector('#cl-taginput').focus();
    });
  }

  function collectForm(root) {
    const out = {};
    root.querySelectorAll('[data-f]').forEach(el => { out[el.dataset.f] = el.value.trim(); });
    out['Tags'] = formTags.join(', ');
    return out;
  }

  function renderEdit(st) {
    const c = st.data.customer;
    formTags = String(c['Tags'] || '').split(',').map(t => t.trim()).filter(Boolean);
    st.box.onclick = null;
    st.box.innerHTML = `
      <h3 class="cl-h">Editar cliente</h3>
      <div class="cl-sub"><span class="cl-mono">${esc(c['Customer ID'])}</span> · los cambios quedan en el historial</div>
      ${formHtml(c)}
      <div class="cl-actions">
        <button class="btn" data-x="cancel" type="button">Cancelar</button>
        <button class="btn btn-primary" data-x="save" type="button">Guardar cambios</button>
      </div>`;
    renderTagEditor(st.box);
    st.box.onclick = async e => {
      const b = e.target.closest('[data-x]');
      if (!b) return;
      if (b.dataset.x === 'cancel') { renderDetail(st); return; }
      withBusy(b, 'Guardando…', async () => {
        const vals = collectForm(st.box), fields = {};
        Object.keys(vals).forEach(h => { if (String(vals[h]).trim() !== String(c[h] || '').trim()) fields[h] = vals[h]; });
        if (!Object.keys(fields).length) { VP.toast('No hay cambios'); renderDetail(st); return; }
        await VP.post({ action: 'cli_update', customer_id: st.id, fields });
        VP.toast('Cliente actualizado');
        await loadDetail(st); refreshListSoon();
      });
    };
  }

  function openCreate() {
    formTags = [];
    const m = VP.showModal(`
      <h3 class="cl-h">Nuevo cliente</h3>
      <div class="cl-sub">Si ya existe uno parecido te avisamos antes de crearlo</div>
      ${formHtml({})}
      <div id="cl-cmsg"></div>
      <div class="cl-actions">
        <button class="btn" data-x="cancel" type="button">Cancelar</button>
        <button class="btn btn-primary" data-x="save" type="button">Crear cliente</button>
      </div>`, { maxWidth: '720px' });
    const box = m.el.querySelector('.vp-modal-body');
    renderTagEditor(box);

    const submit = (btn, force) => withBusy(btn, 'Creando…', async () => {
      const r = await VP.post({ action: 'cli_create', fields: collectForm(box), force: !!force });
      if (r.result === 'similar') {
        $('cl-cmsg') && ($('cl-cmsg').innerHTML = `<div class="cl-warn"><b>Ya hay clientes parecidos:</b>
          ${r.matches.map(x => `<div class="cl-lrow"><div><b>${esc(x.username || x.name || x.customer_id)}</b> <span class="cl-mono">${esc(x.customer_id)}</span><br><small>${esc([x.name, x.city, x.phone].filter(Boolean).join(' · '))} · ${x.score}% · ${esc((x.reasons || []).join(', '))}</small></div>
            <button class="btn btn-sm" data-open="${esc(x.customer_id)}" type="button">Abrir ficha</button></div>`).join('')}
          <div class="cl-actions"><button class="btn btn-sm btn-primary" data-x="force" type="button">Crear de todos modos</button></div></div>`);
        return;
      }
      m.close();
      VP.toast('Cliente creado: ' + r.customer_id);
      stale = true;
      if (tab === 'clientes') await loadRecords();
      openDetail(r.customer_id);
    });

    box.addEventListener('click', e => {
      const open = e.target.closest('[data-open]');
      if (open) { openDetail(open.dataset.open); return; }
      const b = e.target.closest('[data-x]');
      if (!b) return;
      if (b.dataset.x === 'cancel') m.close();
      else submit(b, b.dataset.x === 'force');
    });
  }

  /* ── delete ───────────────────────────────────────────────────────────── */

  async function doDelete(st) {
    const c = st.data.customer, name = c['Primary Username'] || [c['First Name'], c['Surname']].filter(Boolean).join(' ') || c['Customer ID'];
    const n = st.data.orders_total;
    if (n > 0) {
      const go = await askConfirm({
        title: 'No se puede eliminar',
        html: `<b>${esc(name)}</b> tiene <b>${n} pedido${n === 1 ? '' : 's'}</b> vinculado${n === 1 ? '' : 's'}. Un cliente con pedidos no se elimina: fusiónalo con otro para conservar su historial.`,
        ok: 'Fusionar con otro cliente', cancelLabel: 'Cerrar',
      });
      if (go) openMergePicker(st);
      return;
    }
    const yes = await askConfirm({
      title: 'Eliminar cliente', danger: true, ok: 'Eliminar',
      html: `<p>Vas a eliminar a <b>${esc(name)}</b> (<span class="cl-mono">${esc(c['Customer ID'])}</span>).</p>
             <p style="margin-top:8px">No tiene pedidos vinculados. Se guarda una copia completa y puedes restaurarlo desde la pestaña <b>Eliminados</b>.</p>`,
    });
    if (!yes) return;
    try {
      await VP.post({ action: 'cli_delete', customer_id: st.id });
      st.m.close();
      VP.toast('Cliente eliminado — se puede restaurar en Eliminados');
      refreshListSoon();
    } catch (e) { VP.toast(e.message, true); }
  }

  /* ── manual merge ─────────────────────────────────────────────────────── */

  function openMergePicker(st) {
    const m = VP.showModal(`
      <h3 class="cl-h">Fusionar con otro cliente</h3>
      <div class="cl-sub">Busca a la otra persona. Verás las dos fichas antes de confirmar.</div>
      <input type="search" id="cl-mq" class="cl-search" style="width:100%;margin-bottom:10px" placeholder="Usuario, nombre, ID, teléfono…" autocomplete="off">
      <div id="cl-mres" class="cl-scroll"></div>`, { maxWidth: '620px' });
    const box = m.el.querySelector('.vp-modal-body');
    const paint = () => {
      const toks = norm($('cl-mq').value).split(/\s+/).filter(Boolean);
      const hits = records.filter(r => r.id !== st.id && toks.every(t => r._h.indexOf(t) >= 0)).sort(SORTS.orders).slice(0, 15);
      $('cl-mres').innerHTML = !records.length ? '<div class="vp-empty-sm">La lista de clientes todavía está cargando…</div>' : !toks.length ? '<div class="vp-empty-sm">Escribe para buscar…</div>' : hits.length ? hits.map(r =>
        `<button class="cl-pick" data-id="${esc(r.id)}" type="button"><span><b>${esc(dispName(r))}</b> <small>${esc(r.id)}${r.city ? ' · ' + esc(r.city) : ''}</small></span><small>${r.oc} pedidos</small></button>`).join('')
        : '<div class="vp-empty-sm">Sin resultados.</div>';
    };
    $('cl-mq').addEventListener('input', paint);
    $('cl-mq').focus();
    paint();
    box.addEventListener('click', e => {
      const b = e.target.closest('.cl-pick');
      if (b) openMergeCompare(m, box, st, st.id, b.dataset.id);
    });
  }

  async function openMergeCompare(m, box, st, idA, idB) {
    box.innerHTML = '<div class="vp-loading">Comparando…</div>';
    try {
      const [A, B] = await Promise.all([idA, idB].map(id => VP.get('action=cli_detail&customer_id=' + encodeURIComponent(id))));
      const a = A.customer, b = B.customer;
      const defKeep = (B.orders_total > A.orders_total || (B.orders_total === A.orders_total && b['Customer ID'] < a['Customer ID'])) ? 'b' : 'a';
      const nm = c => c['Primary Username'] || [c['First Name'], c['Surname']].filter(Boolean).join(' ') || c['Customer ID'];
      box.innerHTML = `
        <h3 class="cl-h">Confirmar fusión</h3>
        <div class="cl-sub">Elige cuál ficha se queda como principal. La otra se marca como fusionada y sus pedidos pasan a la principal.</div>
        <div class="cl-keep">
          <label><input type="radio" name="cl-keep" value="a" ${defKeep === 'a' ? 'checked' : ''}> Principal: <b>${esc(nm(a))}</b> (${A.orders_total} pedidos)</label>
          <label><input type="radio" name="cl-keep" value="b" ${defKeep === 'b' ? 'checked' : ''}> Principal: <b>${esc(nm(b))}</b> (${B.orders_total} pedidos)</label>
        </div>
        <div class="cl-cmp">
          <div class="cl-cmp-row cl-cmp-head"><div></div><div>${esc(nm(a))}</div><div>${esc(nm(b))}</div></div>
          ${COMPARE_FIELDS.map(([k, label]) => `<div class="cl-cmp-row"><div>${esc(label)}</div><div>${esc(a[k] || '—')}</div><div>${esc(b[k] || '—')}</div></div>`).join('')}
        </div>
        <div class="cl-warn" id="cl-msum"></div>
        <div class="cl-actions">
          <button class="btn" data-x="cancel" type="button">Cancelar</button>
          <button class="btn btn-primary" data-x="go" type="button">Fusionar</button>
        </div>`;
      const keepSel = () => box.querySelector('input[name="cl-keep"]:checked').value;
      const sum = () => {
        const keepA = keepSel() === 'a', lose = keepA ? B : A, keep = keepA ? A : B;
        box.querySelector('#cl-msum').innerHTML = `Se moverán <b>${lose.orders_total}</b> pedido${lose.orders_total === 1 ? '' : 's'} de «${esc(nm(lose.customer))}» a «${esc(nm(keep.customer))}». Se puede deshacer en la pestaña <b>Fusiones</b>.`;
      };
      sum();
      box.addEventListener('change', sum);
      box.addEventListener('click', e => {
        const x = e.target.closest('[data-x]');
        if (!x) return;
        if (x.dataset.x === 'cancel') { m.close(); return; }
        withBusy(x, 'Fusionando…', async () => {
          const keepA = keepSel() === 'a';
          const keepId = keepA ? a['Customer ID'] : b['Customer ID'], loseId = keepA ? b['Customer ID'] : a['Customer ID'];
          await VP.post({ action: 'merge_customers', keep_id: keepId, merge_id: loseId });
          m.close(); st.m.close();
          VP.toast('Clientes fusionados');
          stale = true;
          if (tab === 'clientes') await loadRecords();
          openDetail(keepId);
        });
      });
    } catch (e) {
      box.innerHTML = `<div class="vp-empty-sm">${esc(e.message)}</div>`;
    }
  }

  async function undoMerge(btn, st) {
    return withBusy(btn, 'Deshaciendo…', async () => {
      await VP.post({ action: 'undo_merge', merge_id: btn.dataset.undo });
      VP.toast('Fusión deshecha');
      if (st) await loadDetail(st);
      refreshListSoon();
    });
  }

  /* ── Duplicados tab ───────────────────────────────────────────────────── */

  const sideDetail = c => [c['Phone Full'] || c['Phone Partial'] || '', [c['Street + Number'], c['City'], c['State']].filter(Boolean).join(', '), c['ZIP'] || '', c['Aliases'] ? 'Alias: ' + c['Aliases'] : '']
    .filter(Boolean).map(esc).join('<br>');

  function pairHtml(pair) {
    const a = pair.customer_a, b = pair.customer_b;
    const side = c => `<div class="aj-dup-side"><div class="aj-dup-username">${esc(c['Primary Username'] || c['Customer ID'])}</div>
      <div class="aj-dup-detail">${sideDetail(c)}</div><button class="ls-mini" style="margin-top:6px" data-open="${esc(c['Customer ID'])}" type="button">Ver ficha</button></div>`;
    const extra = COMPARE_FIELDS.map(([k, label]) => `<div class="aj-dup-field-row"><div class="aj-dup-field-label">${esc(label)}</div>
      <div class="aj-dup-field-val">${esc(a[k] !== undefined && a[k] !== '' ? a[k] : '—')}</div><div class="aj-dup-field-val">${esc(b[k] !== undefined && b[k] !== '' ? b[k] : '—')}</div></div>`).join('');
    return `<div class="aj-dup-pair" data-a="${esc(a['Customer ID'])}" data-b="${esc(b['Customer ID'])}">
      <div class="aj-dup-header"><span>Coincidencia probable</span><span class="aj-dup-score">${pair.score}%</span></div>
      <div class="aj-dup-compare">${side(a)}${side(b)}</div>
      <button class="aj-dup-expand-btn" data-x="expand" type="button" aria-expanded="false">Ver más ▾</button>
      <div class="aj-dup-expanded" style="display:none">${extra}</div>
      <div class="aj-dup-actions">
        <button class="refresh-btn" data-x="dismiss" type="button">No son iguales</button>
        <button class="refresh-btn" data-x="merge-a" type="button">Usar «${esc(a['Primary Username'] || a['Customer ID'])}» como principal</button>
        <button class="refresh-btn" data-x="merge-b" type="button">Usar «${esc(b['Primary Username'] || b['Customer ID'])}» como principal</button>
      </div></div>`;
  }

  async function loadDups(threshold) {
    const el = $('cl-dups');
    if (!el) return;
    el.innerHTML = '<div class="vp-loading">Comparando clientes, puede tardar un momento…</div>';
    try {
      const d = await VP.get('action=find_duplicate_customers&threshold=' + threshold);
      if (!$('cl-dups')) return;
      const pairs = d.pairs || [];
      $('cl-dups').innerHTML = pairs.length
        ? `<div class="cl-count">${VP.num(pairs.length)} par${pairs.length === 1 ? '' : 'es'} probable${pairs.length === 1 ? '' : 's'}</div>` + pairs.map(pairHtml).join('')
        : '<div class="cl-empty">No se encontraron duplicados probables.</div>';
    } catch (e) {
      if ($('cl-dups')) $('cl-dups').innerHTML = `<div class="vp-empty-sm">Error al buscar duplicados: ${esc(e.message)}</div>`;
    }
  }

  function showDuplicados() {
    const p = $('cl-panel');
    p.innerHTML = `<div class="cl-thr"><span>Umbral</span><input type="range" id="cl-thr" min="0" max="100" step="1" value="${DUP_DEFAULT}"><b id="cl-thrv">${DUP_DEFAULT}%</b>
      <button class="btn btn-sm" id="cl-thr-go" type="button">↻ Buscar de nuevo</button></div><div id="cl-dups"></div>`;
    $('cl-thr').addEventListener('input', e => { $('cl-thrv').textContent = e.target.value + '%'; });
    p.onclick = e => {
      if (e.target.closest('#cl-thr-go')) { loadDups(parseInt($('cl-thr').value, 10)); return; }
      const open = e.target.closest('[data-open]');
      if (open) { openDetail(open.dataset.open); return; }
      const b = e.target.closest('[data-x]');
      const pair = b && b.closest('.aj-dup-pair');
      if (!pair) return;
      const idA = pair.dataset.a, idB = pair.dataset.b, x = b.dataset.x;
      if (x === 'expand') {
        const box = b.nextElementSibling, openNow = box.style.display === 'block';
        box.style.display = openNow ? 'none' : 'block';
        b.setAttribute('aria-expanded', String(!openNow));
        b.textContent = openNow ? 'Ver más ▾' : 'Ver menos ▴';
      } else if (x === 'dismiss') {
        withBusy(b, 'Descartando…', async () => { await VP.post({ action: 'dismiss_duplicate_pair', customer_id_a: idA, customer_id_b: idB }); pair.remove(); });
      } else if (x === 'merge-a' || x === 'merge-b') {
        const keepId = x === 'merge-a' ? idA : idB, loseId = x === 'merge-a' ? idB : idA;
        withBusy(b, 'Fusionando…', async () => {
          await VP.post({ action: 'merge_customers', keep_id: keepId, merge_id: loseId });
          pair.innerHTML = '<div class="cl-ok" style="padding:12px;font-size:13px">✓ Fusionado correctamente</div>';
          stale = true;
        });
      }
    };
    loadDups(DUP_DEFAULT);
  }

  /* ── Fusiones tab ─────────────────────────────────────────────────────── */

  async function showFusiones() {
    const p = $('cl-panel');
    p.innerHTML = '<div class="vp-loading">Cargando historial…</div>';
    const render = async () => {
      try {
        const d = await VP.get('action=merge_history');
        const recs = (d.records || []).sort((a, b) => String(b['Merged Date'] || '').localeCompare(String(a['Merged Date'] || '')));
        if (tab !== 'fusiones') return;
        p.innerHTML = recs.length ? recs.map(r => {
          const s = r['Status'];
          const right = s === 'Deshecho' ? '<span class="status-pill" style="background:var(--surface2);color:var(--text-faint)">Deshecho</span>'
            : s === 'Limpiado' ? '<span class="status-pill" style="background:var(--surface2);color:var(--text-faint)">Eliminado permanentemente</span>'
            : `<div style="display:flex;gap:6px"><button class="refresh-btn" data-undo="${esc(r['Merge ID'])}" type="button">Deshacer</button>
               <button class="refresh-btn" data-clean="${esc(r['Merge ID'])}" data-name="${esc(r['Merged Username'] || r['Merged Customer ID'])}" type="button">Limpiar</button></div>`;
          return `<div class="aj-history-row"><div class="aj-history-main">
            <span class="aj-history-arrow">${esc(r['Merged Username'] || r['Merged Customer ID'])} → ${esc(r['Kept Username'] || r['Kept Customer ID'])}</span>
            <span class="aj-history-date">${esc(VP.fmtDateTime(r['Merged Date']))} · ${esc(r['Orders Repointed'] || 0)} pedidos movidos</span></div>${right}</div>`;
        }).join('') : '<div class="cl-empty">Todavía no se ha fusionado ningún cliente.</div>';
      } catch (e) { p.innerHTML = `<div class="vp-empty-sm">Error al cargar historial: ${esc(e.message)}</div>`; }
    };
    p.onclick = async e => {
      const u = e.target.closest('[data-undo]');
      if (u) { await undoMerge(u, null); render(); return; }
      const c = e.target.closest('[data-clean]');
      if (c) {
        const yes = await askConfirm({ title: 'Limpiar cliente fusionado', danger: true, ok: 'Borrar permanentemente',
          html: `Esto borra para siempre el registro de <b>${esc(c.dataset.name)}</b> (el que quedó marcado como fusionado). Después ya no se puede deshacer esta fusión.` });
        if (!yes) return;
        withBusy(c, 'Borrando…', async () => { await VP.post({ action: 'delete_merged_customer', merge_id: c.dataset.clean }); VP.toast('Registro eliminado'); render(); });
      }
    };
    render();
  }

  /* ── Eliminados tab ───────────────────────────────────────────────────── */

  async function showEliminados() {
    const p = $('cl-panel');
    p.innerHTML = '<div class="vp-loading">Cargando…</div>';
    const render = async () => {
      try {
        const d = await VP.get('action=cli_deleted');
        if (tab !== 'eliminados') return;
        const recs = d.records || [];
        p.innerHTML = recs.length ? recs.map(r => `
          <div class="aj-history-row"><div class="aj-history-main">
            <span class="aj-history-arrow">${esc(r.username || '(sin usuario)')} <span class="cl-mono">${esc(r.customer_id)}</span></span>
            <span class="aj-history-date">Eliminado por ${esc(r.deleted_by)} · ${esc(VP.fmtDateTime(r.deleted_at))}${r.restored_at ? ' · restaurado ' + esc(VP.fmtDateTime(r.restored_at)) : ''}</span></div>
            ${r.status === 'Eliminado' ? `<button class="refresh-btn" data-restore="${esc(r.deleted_id)}" type="button">Restaurar</button>` : '<span class="status-pill" style="background:var(--surface2);color:var(--text-faint)">Restaurado</span>'}
          </div>`).join('') : '<div class="cl-empty">No se ha eliminado ningún cliente.</div>';
      } catch (e) { p.innerHTML = `<div class="vp-empty-sm">${esc(e.message)}</div>`; }
    };
    p.onclick = e => {
      const b = e.target.closest('[data-restore]');
      if (!b) return;
      withBusy(b, 'Restaurando…', async () => {
        const r = await VP.post({ action: 'cli_restore', deleted_id: b.dataset.restore });
        VP.toast('Restaurado: ' + (r.username || r.customer_id));
        stale = true; render();
      });
    };
    render();
  }

  /* ── Shopify tab ──────────────────────────────────────────────────────── */

  async function showShopify() {
    const p = $('cl-panel');
    p.innerHTML = '<div class="vp-loading">Cargando…</div>';
    try {
      const d = await VP.get('action=cli_shopify_count');
      if (tab !== 'shopify') return;
      p.innerHTML = `<div class="cl-info" style="padding:18px">
        <div style="font-size:15px;font-weight:600;margin-bottom:6px">${d.people ? VP.num(d.people) + ' persona' + (d.people === 1 ? '' : 's') + ' por confirmar' : 'No hay coincidencias de Shopify pendientes'}</div>
        <div style="font-size:13px;color:var(--text-muted);margin-bottom:12px">${d.matches ? VP.num(d.matches) + ' pedido' + (d.matches === 1 ? '' : 's') + ' de Shopify esperan saber a qué cliente pertenecen. ' : ''}La revisión (con candidatos y confirmación en bloque) se hace en Pedidos, con el botón Revisar.</div>
        <a class="btn btn-primary" href="pedidos.html">Abrir Pedidos</a></div>`;
    } catch (e) { p.innerHTML = `<div class="vp-empty-sm">${esc(e.message)}</div>`; }
  }

  /* ── start ────────────────────────────────────────────────────────────── */

  document.addEventListener('click', e => {
    const t = e.target.closest('#cl-tabs [data-tab]');
    if (t) setTab(t.dataset.tab);
  });

  function openFromHash() {
    if (/^#CUST-\d+$/i.test(location.hash)) openDetail(location.hash.slice(1).toUpperCase());
  }

  (async function init() {
    try {
      await VP.ensureToken();
      VP.requirePage('clientes');   // redirects and throws when this person has no access
      VP.mountNav('clientes');
    } catch (e) { return; }
    ADMIN = VP.getRole() === 'admin';
    setTab('clientes');
    openFromHash();
    window.addEventListener('hashchange', openFromHash);
  })();
})();
