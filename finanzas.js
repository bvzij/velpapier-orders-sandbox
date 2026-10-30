/* ============================================================================
   finanzas.js — expense tracking (Finanzas tab).
   Screens are shown by capability: the server returns `caps` and, more
   importantly, only sends the rows/files each person may see. This file only
   decides which buttons to draw.
   Screens: Bandeja · Gastos · Facturas · Proveedores · Caja chica ·
            Resumen · Gastos fijos · Cierre · Configuración
   ==========================================================================*/
(function () {
  'use strict';

  const $ = id => document.getElementById(id);
  const esc = s => VP.esc(s);
  const money = n => (n === '' || n === null || n === undefined) ? '—' : VP.mxnExact(n);
  const fdate = s => /^\d{4}-\d{2}-\d{2}/.test(String(s || '')) ? String(s).slice(8, 10) + '/' + String(s).slice(5, 7) + '/' + String(s).slice(0, 4) : '—';
  const num = v => { const n = Number(String(v === undefined || v === null ? '' : v).replace(/[$,\s]/g, '')); return isNaN(n) ? 0 : n; };
  const r2 = n => Math.round((n + Number.EPSILON) * 100) / 100;
  const val = id => { const el = $(id); return el ? el.value : ''; };

  let B = null;            // bootstrap payload (caps, categories, vendors, config…)
  let TAB = '';
  let INBOX = 0;
  let CATALOG = null;      // [{id,name}] loaded on demand
  const MAPS = { vendors: {}, cats: {} };
  const F = { month: '', q: '', estado: '', captura: '', mine: false, status: 'activo' };   // Gastos filters
  const RENDER = {};
  const ACT = {};

  /* ── capabilities (the server enforces; this only hides buttons) ───────── */
  function can(k) {
    const c = (B && B.caps) || {};
    if (c._admin) return true;
    const v = c[k];
    return v === true || (Array.isArray(v) && v.length > 0);
  }
  const isAdmin = () => !!(B && B.caps && B.caps._admin);

  /* ── api ────────────────────────────────────────────────────────────────── */
  const CACHE_TTL = 2 * 60 * 1000;   // reads stay fresh for 2 minutes; any write clears everything
  const NO_CACHE = /^(fin_bootstrap|fin_get_file|fin_get_expense|fin_export_|fin_map_suggest|fin_cost_history|fin_ai_)/;
  const CACHE = new Map();           // query string -> { ts, data }
  const api = qs => {
    if (NO_CACHE.test(qs)) return VP.get('action=' + qs);
    const hit = CACHE.get(qs);
    if (hit && Date.now() - hit.ts < CACHE_TTL) return Promise.resolve(hit.data);
    return VP.get('action=' + qs).then(data => { CACHE.set(qs, { ts: Date.now(), data: data }); return data; });
  };
  const post = (action, data) => {
    CACHE.clear();
    return VP.post(Object.assign({ action: action }, data || {})).then(r => { CACHE.clear(); return r; });
  };
  const qsOf = o => Object.keys(o).filter(k => o[k] !== '' && o[k] !== undefined && o[k] !== null && o[k] !== false).map(k => k + '=' + encodeURIComponent(o[k] === true ? '1' : o[k])).join('&');
  const fail = e => { console.error(e); VP.toast(e && e.message ? e.message : 'Algo salió mal. Intenta de nuevo.', true); };   // TROUBLESHOOT: message comes from the server (see finanzas*.gs); console shows the full error
  const loading = '<div class="vp-loading">Cargando</div>';

  /* ── small renderers ────────────────────────────────────────────────────── */
  const badge = (t, cls) => `<span class="fin-badge ${cls || ''}">${esc(t)}</span>`;
  const FLAG_TXT = {
    CASH_OVER_LIMIT: 'Efectivo sobre el límite', TOTAL_MISMATCH: 'Líneas ≠ total', SIN_PROVEEDOR: 'Sin proveedor', SIN_TIPO_CAMBIO: 'Falta tipo de cambio',
    INVOICE_OVERDUE: 'Factura vencida', WRONG_RFC: 'RFC receptor no es el nuestro', WRONG_USO: 'Uso CFDI poco común', PPD_NEEDS_PAYMENT: 'PPD: falta complemento de pago', NOTA_CREDITO: 'Nota de crédito',
  };
  const flagChips = f => String(f || '').split(',').filter(x => x && x.indexOf('ANULADA') !== 0).map(x => `<span class="fin-flag" title="${esc(FLAG_TXT[x] || x)}">⚠ ${esc(FLAG_TXT[x] || x)}</span>`).join('');
  const vendorName = id => MAPS.vendors[id] ? MAPS.vendors[id]['Nombre'] : '';
  const catName = id => MAPS.cats[id] ? MAPS.cats[id]['Nombre'] : '';

  function facturaBadge(o) {
    const s = o['Estado Factura'];
    if (s === 'Recibida') return badge('Recibida', 'fin-b-green');
    if (s === 'No requiere') return badge('No requiere');
    if (s === 'Perdida') return badge('Perdida', 'fin-b-red');
    if (o.invoice_overdue) return badge(s + ' · vencida', 'fin-b-red');
    if (o.invoice_days_left !== null && o.invoice_days_left !== undefined && o.invoice_days_left <= Number((B.config || {}).invoice_alert_days || 3)) {
      return badge(s + ' · ' + (o.invoice_days_left === 0 ? 'vence hoy' : o.invoice_days_left + ' d'), 'fin-b-amber');
    }
    return badge(s || '—', s === 'Solicitada' ? 'fin-b-blue' : 'fin-b-amber');
  }
  function capturaBadge(o) {
    const s = o['Captura Status'];
    if (s === 'Por capturar') return badge('Por capturar', 'fin-b-amber');
    if (s === 'Por pagar') return badge('Por pagar', 'fin-b-purple');
    if (s === 'Revisado') return badge('Revisado', 'fin-b-green');
    return '';
  }

  /* ── files (private Drive files are fetched through the server) ─────────── */
  const FILE_CACHE = new Map();
  const fileQueue = [];
  let fileActive = 0;

  function pump() {
    while (fileActive < 3 && fileQueue.length) {
      const j = fileQueue.shift();
      fileActive++;
      api('fin_get_file&id=' + encodeURIComponent(j.id) + '&size=' + j.size).then(r => {
        const bin = atob(r.data), bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        const blob = new Blob([bytes], { type: r.mime });
        j.resolve({ url: URL.createObjectURL(blob), mime: r.mime, name: r.name, blob: blob });
      }).catch(j.reject).finally(() => { fileActive--; pump(); });
    }
  }
  function loadFile(id, size) {
    const key = id + '|' + size;
    if (FILE_CACHE.has(key)) return FILE_CACHE.get(key);
    const p = new Promise((resolve, reject) => { fileQueue.push({ id: id, size: size, resolve: resolve, reject: reject }); pump(); });
    FILE_CACHE.set(key, p);
    p.catch(() => FILE_CACHE.delete(key));
    return p;
  }
  function thumb(id) { return `<img class="fin-thumb" data-fid="${esc(id)}" data-act="open-file" alt="" src="data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==">`; }
  function hydrate(root) {
    (root || document).querySelectorAll('img[data-fid]').forEach(img => {
      if (img.dataset.loaded) return;
      img.dataset.loaded = '1';
      loadFile(img.dataset.fid, 'thumb').then(f => {
        if (f.mime.indexOf('image/') !== 0) {
          const d = document.createElement('div');
          d.className = 'fin-thumb-doc'; d.dataset.act = 'open-file'; d.dataset.fid = img.dataset.fid;
          d.textContent = f.mime.indexOf('pdf') >= 0 ? 'PDF' : 'Archivo';
          img.replaceWith(d);
        } else img.src = f.url;
      }).catch(() => { img.alt = 'No se pudo cargar'; img.style.opacity = '.4'; });
    });
  }
  async function openFile(id) {
    try {
      const f = await loadFile(id, 'full');
      if (f.mime.indexOf('image/') === 0) VP.lightbox(f.url);
      else if (f.mime.indexOf('pdf') >= 0) window.open(f.url, '_blank');
      else { const a = document.createElement('a'); a.href = f.url; a.download = f.name || 'archivo'; document.body.appendChild(a); a.click(); a.remove(); }
    } catch (e) { fail(e); }
  }
  function readB64(blob) {
    return new Promise((res, rej) => {
      const fr = new FileReader();
      fr.onload = () => res(String(fr.result).split(',')[1]);
      fr.onerror = () => rej(new Error('No se pudo leer el archivo.'));
      fr.readAsDataURL(blob);
    });
  }
  function downloadB64(name, mime, b64) {
    const bin = atob(b64), bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
    const a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }
  // Photos are shrunk in the browser first (same helper as packing photos); PDFs go as they are.
  async function uploadTicket(file) {
    let blob = file, mime = file.type, name = file.name || 'ticket';
    if (/^image\//.test(file.type) || /\.(heic|heif)$/i.test(name)) {
      if (typeof compressImage !== 'function') throw new Error('Falta uploader.js en la página.');   // TROUBLESHOOT: finanzas.html must load uploader.js before finanzas.js
      blob = await compressImage(file, 1600, 0.8);
      mime = 'image/jpeg'; name = name.replace(/\.\w+$/, '') + '.jpg';
    } else if (file.type !== 'application/pdf') {
      throw new Error('Usa una foto o un PDF.');
    }
    const data = await readB64(blob);
    const r = await post('fin_upload_file', { name: name, mime: mime, kind: 'ticket', data: data });
    // Show the photo from the copy already in the browser instead of downloading it back from Drive.
    const local = Promise.resolve({ mime: mime, url: URL.createObjectURL(blob) });
    FILE_CACHE.set(r.file_id + '|thumb', local); FILE_CACHE.set(r.file_id + '|full', local);
    return r;
  }
  function busy(text) {
    const o = document.createElement('div');
    o.className = 'fin-overlay'; o.textContent = text || 'Un momento…';
    document.body.appendChild(o);
    return { set: t => { o.textContent = t; }, done: () => o.remove() };
  }

  /* ── modal helpers ──────────────────────────────────────────────────────── */
  function ask(title, bodyHtml, buttons) {   // buttons: [{label, value, primary}]
    return new Promise(resolve => {
      let answered = false;
      const m = VP.showModal(`<h3 class="fin-modal-h">${esc(title)}</h3><div>${bodyHtml}</div>
        <div class="fin-actions-row">${buttons.map((b, i) => `<button class="btn ${b.primary ? 'btn-primary' : ''}" data-i="${i}">${esc(b.label)}</button>`).join('')}</div>`, { maxWidth: '460px' });
      m.el.querySelectorAll('[data-i]').forEach(btn => btn.addEventListener('click', () => { answered = true; m.close(); resolve(buttons[Number(btn.dataset.i)].value); }));
      m.el.querySelector('.vp-modal-close').addEventListener('click', () => { if (!answered) resolve(null); });
      m.el.addEventListener('click', e => { if (e.target === m.el && !answered) resolve(null); });
    });
  }
  async function promptText(title, label, placeholder) {
    return new Promise(resolve => {
      let done = false;
      const m = VP.showModal(`<h3 class="fin-modal-h">${esc(title)}</h3><label class="fin-field">${esc(label)}<input class="vp-input" id="pt-in" placeholder="${esc(placeholder || '')}"></label>
        <div class="fin-actions-row"><button class="btn" id="pt-no">Cancelar</button><button class="btn btn-primary" id="pt-ok">Aceptar</button></div>`, { maxWidth: '440px' });
      const finish = v => { if (done) return; done = true; m.close(); resolve(v); };
      m.el.querySelector('#pt-ok').onclick = () => finish(m.el.querySelector('#pt-in').value.trim());
      m.el.querySelector('#pt-no').onclick = () => finish(null);
      m.el.querySelector('.vp-modal-close').addEventListener('click', () => finish(null));
      m.el.querySelector('#pt-in').addEventListener('keydown', e => { if (e.key === 'Enter') finish(e.target.value.trim()); });
      setTimeout(() => { const i = m.el.querySelector('#pt-in'); if (i) i.focus(); }, 30);
    });
  }

  /* ── bootstrap + tabs ───────────────────────────────────────────────────── */
  function rebuildMaps() {
    MAPS.vendors = {}; MAPS.cats = {};
    (B.vendors || []).forEach(v => { MAPS.vendors[v['Vendor ID']] = v; });
    (B.categories || []).forEach(c => { MAPS.cats[c['Category ID']] = c; });
    $('fin-vendors').innerHTML = (B.vendors || []).filter(v => v['Status'] !== 'Inactivo').map(v => `<option value="${esc(v['Nombre'])}"></option>`).join('');
  }
  async function reloadBoot() {
    const keepCaps = B ? B.caps : null;
    B = await api('fin_bootstrap');
    if (keepCaps && !B.caps) B.caps = keepCaps;
    rebuildMaps();
  }

  function tabsFor() {
    const t = [];
    if (can('finance.create')) t.push({ id: 'bandeja', label: 'Bandeja' });
    t.push({ id: 'gastos', label: 'Gastos' });
    if (can('finance.invoices')) t.push({ id: 'facturas', label: 'Facturas' });
    t.push({ id: 'proveedores', label: 'Proveedores' });
    if (can('finance.petty_cash') || can('finance.reimburse')) t.push({ id: 'caja', label: 'Caja chica' });
    if (can('finance.view_summary')) t.push({ id: 'resumen', label: 'Resumen' });
    if (can('finance.recurring')) t.push({ id: 'fijos', label: 'Gastos fijos' });
    if (can('finance.month_close') || can('finance.export')) t.push({ id: 'cierre', label: 'Cierre' });
    if (isAdmin()) t.push({ id: 'config', label: 'Configuración' });
    return t;
  }
  function buildTabs() {
    const tabs = tabsFor();
    $('fin-tabs').innerHTML = tabs.map(t => `<button class="fin-tab" data-tab="${t.id}">${t.label}${t.id === 'bandeja' ? '<span class="fin-tab-badge" id="fin-inbox-badge" style="display:none"></span>' : ''}</button>`).join('');
    $('fin-actions').innerHTML = can('finance.create')
      ? `<button class="refresh-btn" data-act="cam">📷 Foto de ticket</button><button class="refresh-btn" data-act="pick">⬆ Subir foto o PDF</button><button class="btn btn-primary btn-sm" data-act="new-expense">+ Gasto</button>` : '';
    $('fin-toolbar').style.display = '';
    return tabs;
  }
  function setInbox(n) {
    INBOX = n;
    const b = $('fin-inbox-badge');
    if (b) { b.textContent = n; b.style.display = n > 0 ? '' : 'none'; }
  }
  function show(tab) {
    TAB = tab;
    localStorage.setItem('vp_fin_tab', tab);
    document.querySelectorAll('#fin-tabs [data-tab]').forEach(b => b.classList.toggle('is-active', b.dataset.tab === tab));
    const c = $('fin-content');
    c.innerHTML = loading;
    Promise.resolve().then(() => RENDER[tab]()).catch(e => { c.innerHTML = `<div class="fin-empty">${esc(e.message || 'No se pudo cargar.')}</div>`; fail(e); });
  }
  const refresh = () => show(TAB);

  /* ── Bandeja (photo inbox) ──────────────────────────────────────────────── */
  RENDER.bandeja = async function () {
    const res = await api('fin_list_expenses&' + qsOf({ captura: 'Por capturar', periodo: 'all', limit: 100 }));
    setInbox(res.count);
    const c = $('fin-content');
    c.innerHTML = `
      <div class="fin-dropzone" id="fin-dz" data-act="pick">Toma o sube la foto del ticket ahora y captura los datos después. También puedes arrastrar fotos aquí.</div>
      ${res.rows.length ? `<div class="fin-inbox">${res.rows.map(o => `
        <div class="fin-inbox-card">
          ${o.files.length ? thumb(o.files[0]) : '<div class="fin-thumb-doc" style="width:100%;height:150px">Sin foto</div>'}
          <div><b>${fdate(o['Fecha Compra'])}</b> ${o.files.length > 1 ? `<span class="fin-sub">· ${o.files.length} fotos</span>` : ''}<div class="fin-sub">Subió ${esc(o['Creado Por'])}${o['Notas'] ? ' · ' + esc(o['Notas']) : ''}</div></div>
          <div class="fin-inbox-acts"><button class="btn btn-primary btn-sm" data-act="edit-expense" data-id="${esc(o['Expense ID'])}">Capturar</button><button class="btn btn-sm" data-act="void-inbox" data-id="${esc(o['Expense ID'])}" title="Quitar esta foto">✕</button></div>
        </div>`).join('')}</div>` : '<div class="fin-card"><div class="fin-empty">La bandeja está vacía. Cada foto que subas aparece aquí hasta que captures el ticket.</div></div>'}`;
    hydrate(c);
    const dz = $('fin-dz');
    ['dragover', 'dragenter'].forEach(ev => dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.add('is-over'); }));
    ['dragleave', 'drop'].forEach(ev => dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.remove('is-over'); }));
    dz.addEventListener('drop', e => { if (e.dataTransfer && e.dataTransfer.files.length) handleFiles(e.dataTransfer.files); });
  };

  async function handleFiles(fileList) {
    const files = Array.prototype.slice.call(fileList || []);
    if (!files.length) return;
    let groups = [files];
    if (files.length > 1) {
      const same = await ask('¿Son del mismo ticket?', `<p style="margin:0">Elegiste ${files.length} fotos.</p>`,
        [{ label: 'Un ticket por foto', value: false }, { label: 'Todas son un solo ticket', value: true, primary: true }]);
      if (same === null) return;
      groups = same ? [files] : files.map(f => [f]);
    }
    const ov = busy('Subiendo…');
    let ok = 0;
    try {
      for (let g = 0; g < groups.length; g++) {
        const ids = [];
        for (let i = 0; i < groups[g].length; i++) {
          ov.set('Subiendo ' + (ok + 1) + ' de ' + files.length + '…');
          const r = await uploadTicket(groups[g][i]);
          ids.push(r.file_id); ok++;
        }
        await post('fin_create_expense', { expense: { captura_status: 'Por capturar', archivos: ids, fecha_compra: B.today } });
      }
      VP.toast(groups.length > 1 ? groups.length + ' tickets en la bandeja' : 'Foto guardada en la bandeja');
    } catch (e) { fail(e); }
    ov.done();
    if (can('finance.create')) { show('bandeja'); }
  }

  ACT.cam = () => { const i = $('fin-cam'); i.value = ''; i.click(); };
  ACT.pick = () => { const i = $('fin-pick'); i.value = ''; i.click(); };
  ACT['void-inbox'] = async el => {
    const ok = await ask('¿Quitar esta foto?', '<p style="margin:0">Se quita de la bandeja (queda guardada en el historial).</p>', [{ label: 'Cancelar', value: false }, { label: 'Quitar', value: true, primary: true }]);
    if (!ok) return;
    try { await post('fin_void_expense', { expense_id: el.dataset.id, reason: 'Foto descartada desde la bandeja' }); show('bandeja'); } catch (e) { fail(e); }
  };
  ACT['open-file'] = el => { if (el.dataset.fid) openFile(el.dataset.fid); };

  /* ── catalog (links purchase lines to products; loaded when a form opens) ─ */
  async function ensureCatalog() {
    if (CATALOG) return CATALOG;
    try { CATALOG = (await api('fin_catalog')).products || []; } catch (e) { CATALOG = []; }
    $('fin-products').innerHTML = CATALOG.map(p => `<option value="${esc(p.name)}"></option>`).join('');
    return CATALOG;
  }
  const prodById = id => (CATALOG || []).find(p => p.id === id);
  const prodByName = n => (CATALOG || []).find(p => p.name.toLowerCase() === String(n || '').trim().toLowerCase());
  const vendorByName = n => Object.keys(MAPS.vendors).map(k => MAPS.vendors[k]).find(v => String(v['Nombre']).toLowerCase() === String(n || '').trim().toLowerCase());
  const copyText = async t => {
    try { await navigator.clipboard.writeText(t); VP.toast('Copiado'); }
    catch (e) { const i = document.createElement('input'); i.value = t; document.body.appendChild(i); i.select(); try { document.execCommand('copy'); VP.toast('Copiado'); } catch (_) { VP.toast('No se pudo copiar', true); } i.remove(); }
  };

  /* ── barcode scan (only where the browser supports it) ─────────────────── */
  async function scanBarcode() {
    if (!('BarcodeDetector' in window)) { VP.toast('Este navegador no escanea códigos. Escríbelo o usa un lector.', true); return ''; }
    return new Promise(async resolve => {
      let stream = null, stop = false;
      const m = VP.showModal(`<h3 class="fin-modal-h">Escanear código</h3><video class="fin-video" id="sc-v" playsinline muted></video><div class="fin-note">Apunta al código de barras del producto.</div>`, { maxWidth: '520px' });
      const finish = v => { if (stop) return; stop = true; if (stream) stream.getTracks().forEach(t => t.stop()); m.close(); resolve(v); };
      m.el.querySelector('.vp-modal-close').addEventListener('click', () => finish(''));
      m.el.addEventListener('click', e => { if (e.target === m.el) finish(''); });
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
        const v = m.el.querySelector('#sc-v'); v.srcObject = stream; await v.play();
        const det = new BarcodeDetector();
        const loop = async () => { if (stop) return; try { const r = await det.detect(v); if (r.length) return finish(r[0].rawValue); } catch (e) { /* frame not ready */ } requestAnimationFrame(loop); };
        loop();
      } catch (e) { finish(''); VP.toast('No se pudo abrir la cámara.', true); }
    });
  }

  /* ── vendor form (create for everyone allowed, edit for admins) ────────── */
  function openVendorForm(opts) {
    opts = opts || {};
    const v = opts.vendor || {};
    const editing = !!v['Vendor ID'];
    const cats = (B.categories || []).filter(c => c['Activa'] === 'Sí');
    const m = VP.showModal(`
      <h3 class="fin-modal-h">${editing ? 'Editar proveedor' : 'Nuevo proveedor'}</h3>
      <div class="fin-grid">
        <label class="fin-field fin-span2">Nombre<input class="vp-input" id="pv-nombre" value="${esc(v['Nombre'] || opts.nombre || '')}"></label>
        <label class="fin-field">RFC<input class="vp-input" id="pv-rfc" value="${esc(v['RFC'] || opts.rfc || '')}" placeholder="Opcional"></label>
        <label class="fin-field">Categoría habitual<select class="vp-input" id="pv-cat"><option value="">—</option>${cats.map(c => `<option value="${esc(c['Category ID'])}" ${c['Category ID'] === v['Default Category ID'] ? 'selected' : ''}>${esc(c['Nombre'])}</option>`).join('')}</select></label>
        <label class="fin-field fin-span2">Página para pedir factura<input class="vp-input" id="pv-portal" value="${esc(v['Portal Facturación URL'] || '')}" placeholder="https://…"></label>
        <label class="fin-field">¿Hasta cuándo se puede facturar?<select class="vp-input" id="pv-regla">${['Mismo mes', 'N días', 'Sin límite'].map(r => `<option ${r === (v['Regla Plazo Factura'] || 'Mismo mes') ? 'selected' : ''}>${r}</option>`).join('')}</select></label>
        <label class="fin-field">Días (si es “N días”)<input class="vp-input" id="pv-dias" type="number" min="0" value="${esc(v['Días Plazo'] || '')}"></label>
        <label class="fin-field">Método de pago habitual<select class="vp-input" id="pv-metodo"><option value="">—</option>${(B.enums.metodos || []).map(x => `<option ${x === v['Método Pago Default'] ? 'selected' : ''}>${esc(x)}</option>`).join('')}</select></label>
        <label class="fin-field">% del total que se factura<input class="vp-input" id="pv-pct" type="number" min="0" max="100" step="1" value="${esc(v['Porcentaje Factura'] === '' || v['Porcentaje Factura'] === undefined ? '' : v['Porcentaje Factura'])}" placeholder="100"></label>
        <label class="fin-field">Tarjeta / cuenta habitual<input class="vp-input" id="pv-cuenta" list="fin-accounts" value="${esc(v['Cuenta Pago Default'] || '')}" placeholder="Ej. BBVA 4417"></label>
        <label class="fin-field">¿Normalmente dan factura?<select class="vp-input" id="pv-req"><option ${v['Requiere Factura Default'] !== 'No' ? 'selected' : ''}>Sí</option><option ${v['Requiere Factura Default'] === 'No' ? 'selected' : ''}>No</option></select></label>
        <label class="fin-field">Alias (nombres en tickets, separados por |)<input class="vp-input" id="pv-alias" value="${esc(v['Alias'] || '')}"></label>
        <label class="fin-field">Teléfono / contacto<input class="vp-input" id="pv-contacto" value="${esc(v['Contacto'] || v['Teléfono'] || '')}"></label>
        ${editing && can('finance.vendors_edit') ? `<label class="fin-field">Estado<select class="vp-input" id="pv-status">${['Activo', 'Pendiente revisión', 'Inactivo'].map(s => `<option ${s === v['Status'] ? 'selected' : ''}>${s}</option>`).join('')}</select></label>` : ''}
        <label class="fin-field fin-full">Notas<input class="vp-input" id="pv-notas" value="${esc(v['Notas'] || '')}"></label>
      </div>
      ${!editing && !can('finance.vendors_edit') ? '<div class="fin-msg info">Un admin revisará este proveedor. Mientras tanto ya lo puedes usar.</div>' : ''}
      <div class="fin-actions-row"><button class="btn" id="pv-cancel">Cancelar</button><button class="btn btn-primary" id="pv-save">Guardar</button></div>`, { maxWidth: '640px' });
    const q = s => m.el.querySelector(s);
    q('#pv-cancel').onclick = () => m.close();
    q('#pv-save').onclick = async () => {
      const vendor = {
        nombre: q('#pv-nombre').value.trim(), rfc: q('#pv-rfc').value.trim(), default_category_id: q('#pv-cat').value, portal: q('#pv-portal').value.trim(),
        regla_plazo: q('#pv-regla').value, dias_plazo: q('#pv-dias').value, requiere_default: q('#pv-req').value, metodo_default: q('#pv-metodo').value, cuenta_default: q('#pv-cuenta').value.trim(), porcentaje_factura: q('#pv-pct').value, alias: q('#pv-alias').value.trim(),
        contacto: q('#pv-contacto').value.trim(), notas: q('#pv-notas').value.trim(),
      };
      if (!vendor.nombre) { VP.toast('Escribe el nombre del proveedor.', true); return; }
      if (q('#pv-status')) vendor.status = q('#pv-status').value;
      try {
        const r = editing ? await post('fin_update_vendor', { vendor_id: v['Vendor ID'], vendor: vendor }) : await post('fin_create_vendor', { vendor: vendor });
        const saved = r.vendor;
        const i = (B.vendors || []).findIndex(x => x['Vendor ID'] === saved['Vendor ID']);
        if (i >= 0) B.vendors[i] = saved; else B.vendors.push(saved);
        rebuildMaps();
        VP.toast(r.result === 'exists' ? 'Ese proveedor ya existía; lo seleccioné.' : 'Proveedor guardado');
        m.close();
        if (opts.onSaved) opts.onSaved(saved);
        else if (TAB === 'proveedores') refresh();
      } catch (e) { fail(e); }
    };
    setTimeout(() => q('#pv-nombre').focus(), 30);
  }

  /* ── capture form ───────────────────────────────────────────────────────── */
  let FM = null;   // { id, files:[{id,mime,name}], lines:[...], modal }

  const emptyLine = () => ({ codigo: '', descripcion: '', cantidad: 1, unidad: 'pz', ppu: 1, costo: '', descuento: '', condicion: '', tipo: 'Inventario', catalog_id: '', vinculo: 'Sin vincular', _sug: null, _ai: false });
  const lineFromServer = l => ({
    codigo: l['Código Proveedor'] || '', descripcion: l['Descripción'] || '', cantidad: l['Cantidad'], unidad: l['Unidad'] || 'pz', ppu: l['Piezas por Unidad'] || 1,
    costo: l['Costo Unitario'], descuento: num(l['Descuento Línea']) ? l['Descuento Línea'] : '', condicion: l['Condición'] || '',
    tipo: l['Tipo Línea'] || 'Inventario', catalog_id: l['Catalog ID'] || '', vinculo: l['Vínculo'] || 'Sin vincular', _sug: null, _ai: false,
  });
  const lineTotal = l => r2(num(l.cantidad) * num(l.costo) - num(l.descuento));

  function catOptions(selected) {
    const cats = (B.categories || []).filter(c => c['Activa'] === 'Sí' || isAdmin());
    const scopes = Array.from(new Set(cats.map(c => c['Scope'])));
    return '<option value="">— Elige —</option>' + scopes.map(s => {
      const g = cats.filter(c => c['Scope'] === s).map(c => `<option value="${esc(c['Category ID'])}" ${c['Category ID'] === selected ? 'selected' : ''}>${esc(c['Nombre'])}</option>`).join('');
      return scopes.length > 1 ? `<optgroup label="${esc(s)}">${g}</optgroup>` : g;
    }).join('');
  }

  function formHtml(e, isNew) {
    const m = e['Método Pago'] || 'Efectivo';
    return `
      <h3 class="fin-modal-h">${isNew ? 'Nuevo gasto' : 'Gasto ' + esc(e['Expense ID'])}</h3>
      ${e['Captura Status'] === 'Por capturar' ? '<div class="fin-note">Viene de la bandeja: completa los datos del ticket.</div>' : ''}
      <div class="fin-h3" style="margin-top:12px;display:flex;justify-content:space-between;align-items:center">Fotos del ticket
        <button class="btn btn-sm fin-ai-btn" type="button" data-f="ai" id="ff-ai" style="display:none" title="Llena los campos marcados con ✨ a partir de las fotos. Tú revisas antes de guardar.">✨ Leer ticket con IA</button></div>
      <div class="fin-photos" id="ff-photos"></div>
      <div class="fin-note" id="ff-ai-hint" style="display:none">Los campos con ✨ los puede llenar la IA. Lo que llene queda en azul hasta que lo cambies.</div>
      <div class="fin-grid" style="margin-top:12px">
        <label class="fin-field fin-span2">✨ Proveedor<div style="display:flex;gap:6px"><input class="vp-input" id="ff-vendor" list="fin-vendors" autocomplete="off" placeholder="Escribe para buscar…" value="${esc(vendorName(e['Vendor ID']))}"><button class="btn btn-sm" type="button" data-f="new-vendor">+ Nuevo</button></div></label>
        <label class="fin-field">✨ Fecha de compra<input class="vp-input" id="ff-fecha" type="date" value="${esc(e['Fecha Compra'] || B.today)}"></label>
        <label class="fin-field">✨ Total del ticket<input class="vp-input" id="ff-total" type="number" step="0.01" min="0" inputmode="decimal" value="${num(e['Total']) ? esc(e['Total']) : ''}" placeholder="0.00"></label>
        <label class="fin-field">✨ Método de pago<select class="vp-input" id="ff-metodo">${(B.enums.metodos || []).map(x => `<option ${x === m ? 'selected' : ''}>${esc(x)}</option>`).join('')}</select></label>
        <label class="fin-field">✨ Tarjeta / cuenta<input class="vp-input" id="ff-cuenta" list="fin-accounts" value="${esc(e['Cuenta Pago'] || '')}" placeholder="Ej. BBVA 4417"></label>
        <label class="fin-field">Categoría<select class="vp-input" id="ff-cat">${catOptions(e['Category ID'])}</select></label>
        <label class="fin-field">✨ Folio del ticket<input class="vp-input" id="ff-folio" value="${esc(e['Folio Ticket'] || '')}"></label>
        <label class="fin-field fin-span2">Descripción<input class="vp-input" id="ff-desc" value="${esc(e['Descripción'] || '')}" placeholder="¿Qué se compró?"></label>
        <label class="fin-field">¿Piden factura?<select class="vp-input" id="ff-req"><option value="">Según el proveedor</option><option ${e['Requiere Factura'] === 'Sí' ? 'selected' : ''}>Sí</option><option ${e['Requiere Factura'] === 'No' ? 'selected' : ''}>No</option></select></label>
        <label class="fin-field fin-span2">Datos para facturar en línea (folio web, código…)<input class="vp-input" id="ff-datos" value="${esc(e['Datos Facturación'] || '')}"></label>
      </div>
      <label class="fin-check" style="margin-top:10px"><input type="checkbox" id="ff-own" ${e['Reembolso Status'] === 'Pendiente' ? 'checked' : ''}> Lo pagué con mi dinero (hay que reembolsarme)</label>
      <details style="margin-top:10px"><summary class="fin-note" style="cursor:pointer">Más opciones (moneda, impuestos, notas)</summary>
        <div class="fin-grid" style="margin-top:8px">
          <label class="fin-field">Moneda<select class="vp-input" id="ff-moneda">${['MXN', 'USD', 'EUR'].map(x => `<option ${x === (e['Moneda'] || 'MXN') ? 'selected' : ''}>${x}</option>`).join('')}</select></label>
          <label class="fin-field" id="ff-tc-wrap" style="display:none">Tipo de cambio<input class="vp-input" id="ff-tc" type="number" step="0.0001" value="${esc(e['Tipo Cambio'] && e['Moneda'] !== 'MXN' ? e['Tipo Cambio'] : '')}"></label>
          <label class="fin-field">Subtotal<input class="vp-input" id="ff-sub" type="number" step="0.01" value="${esc(e['Subtotal'] === undefined ? '' : e['Subtotal'])}"></label>
          <label class="fin-field">IVA<input class="vp-input" id="ff-iva" type="number" step="0.01" value="${esc(e['IVA'] === undefined ? '' : e['IVA'])}"></label>
          <label class="fin-field">Deducible<select class="vp-input" id="ff-ded">${['', 'Sí', 'No', 'Revisar'].map(x => `<option value="${x}" ${x === (e['Deducible'] || '') ? 'selected' : ''}>${x || 'Según la categoría'}</option>`).join('')}</select></label>
          <label class="fin-field fin-full">Notas<input class="vp-input" id="ff-notas" value="${esc(e['Notas'] || '')}"></label>
        </div>
      </details>
      <div class="fin-h3" style="display:flex;justify-content:space-between;align-items:center">Productos del ticket (opcional)
        <span><button class="btn btn-sm" type="button" data-f="add-line">+ Línea</button></span></div>
      <div class="fin-lines" id="ff-lines"></div>
      <div class="fin-note" id="ff-sum"></div>
      <div id="ff-msg"></div>
      ${can('finance.edit_any') && !isNew ? '<label class="fin-check" style="margin-top:10px"><input type="checkbox" id="ff-review"> Marcar como revisado</label>' : ''}
      <div class="fin-actions-row">
        <button class="btn" type="button" data-f="cancel">Cancelar</button>
        ${isNew ? '<button class="btn" type="button" data-f="save-new">Guardar y capturar otro</button>' : ''}
        <button class="btn btn-primary" type="button" data-f="save">Guardar</button>
      </div>`;
  }

  function renderPhotos() {
    const el = $('ff-photos'); if (!el) return;
    el.innerHTML = FM.files.map(f => `<div style="position:relative">${thumb(f.id)}<button type="button" class="fin-line-x" data-f="rm-photo" data-id="${esc(f.id)}" style="position:absolute;top:-6px;right:-6px;background:var(--surface);border-radius:50%;width:22px;height:22px;line-height:1;font-size:14px;border:0.5px solid var(--border-strong)">×</button></div>`).join('')
      + Array.from({ length: FM.uploading || 0 }, () => '<div class="fin-thumb-doc">Subiendo…</div>').join('')
      + `<button class="btn btn-sm" type="button" data-f="add-photo">📷 Agregar foto</button>`;
    hydrate(el);
  }

  function renderLines() {
    const el = $('ff-lines'); if (!el) return;
    // Unit and pieces-per-unit are hidden for now: every line is loose pieces (pz, 1 pza c/u).
    // The values still travel to the server, so re-showing the two fields later needs no backend change.
    el.innerHTML = FM.lines.map((l, i) => {
      const linked = l.catalog_id ? (prodById(l.catalog_id) ? prodById(l.catalog_id).name : l.catalog_id) : '';
      return `<div class="fin-line ${l._ai ? 'fin-ai' : ''}" data-i="${i}">
        <div class="fin-line-main">
          <div style="display:flex;gap:4px"><input class="vp-input" data-k="codigo" placeholder="Código" value="${esc(l.codigo)}">${'BarcodeDetector' in window ? `<button type="button" class="btn btn-sm" data-f="scan" data-i="${i}" title="Escanear">▮▯</button>` : ''}</div>
          <input class="vp-input" data-k="descripcion" placeholder="Descripción" value="${esc(l.descripcion)}">
          <input class="vp-input" data-k="cantidad" type="number" step="any" min="0" inputmode="decimal" placeholder="Cant." value="${esc(l.cantidad)}">
          <input class="vp-input" data-k="costo" type="number" step="0.01" min="0" inputmode="decimal" placeholder="P. unit." value="${esc(l.costo)}">
          <div class="fin-line-total" data-total>${money(lineTotal(l))}</div>
          <button type="button" class="fin-line-x" data-f="rm-line" data-i="${i}" title="Quitar línea">×</button>
        </div>
        <div class="fin-line-sub">
          <select class="vp-input" data-k="tipo">${(B.enums.tipos_linea || []).map(t => `<option ${t === l.tipo ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select>
          <input class="vp-input" data-k="_prod" list="fin-products" placeholder="Producto del catálogo (opcional)" style="flex:1;min-width:150px" value="${esc(linked)}">
          ${l._sug && !l.catalog_id ? `<span class="fin-badge fin-b-blue fin-sug" data-f="use-sug" data-i="${i}">Sugerido: ${esc((prodById(l._sug.catalog_id) || {}).name || l._sug.catalog_id)} — usar</span>` : ''}
          ${l.catalog_id ? `<span class="fin-badge ${l.vinculo === 'Confirmado' ? 'fin-b-green' : 'fin-b-amber'}">${l.vinculo}</span>` : ''}
          ${l._dup ? '<span class="fin-badge fin-b-amber" title="Puede venir de dos fotos que se enciman">Posible duplicado</span>' : ''}
          ${/producto\s+individual/i.test(l.descripcion || '') ? '<span class="fin-badge fin-b-blue" title="El proveedor no tenía este producto en su sistema. El almacén lo identifica al recibir la mercancía.">Por identificar en recepción</span>' : ''}
          ${l.condicion === 'Dañado' ? '<span class="fin-badge fin-b-amber">Dañado</span>' : ''}
          ${num(l.descuento) ? `<span class="fin-badge fin-b-amber">Descuento −${money(l.descuento)}</span>` : ''}
          <button type="button" class="fin-line-x" data-f="line-more" data-i="${i}" title="Más opciones de la línea (dañado, descuento)" style="margin-left:auto;font-size:16px">⋯</button>
        </div>
        ${l._more ? `<div class="fin-line-sub">
          <label class="fin-check" style="margin:0"><input type="checkbox" data-k="condicion" ${l.condicion === 'Dañado' ? 'checked' : ''}> Producto dañado (empaque roto) — el almacén lo cuenta aparte</label>
          <span>Descuento $</span><input class="vp-input" data-k="descuento" type="number" step="0.01" min="0" inputmode="decimal" style="width:90px" value="${esc(l.descuento)}" placeholder="0.00">
        </div>` : ''}
      </div>`;
    }).join('');
    updateWarnings();
  }

  function updateWarnings() {
    const sumEl = $('ff-sum'), msg = $('ff-msg');
    if (!sumEl) return;
    const sum = r2(FM.lines.reduce((s, l) => s + lineTotal(l), 0));
    const total = num(val('ff-total'));
    const hasLines = FM.lines.some(l => l.codigo || l.descripcion);
    sumEl.textContent = hasLines ? `Las líneas suman ${money(sum)}${total ? ' · el ticket dice ' + money(total) : ''}.` : '';
    const out = [];
    const pzs = FM.lines.reduce((s, l) => s + num(l.cantidad), 0);
    if (hasLines && FM.aiPiezas && Math.abs(pzs - FM.aiPiezas) > 0.001) out.push(`<div class="fin-msg warn">Las líneas suman ${pzs} piezas, pero el ticket dice ${FM.aiPiezas}. Puede faltar o sobrar una línea (revisa las marcadas como posible duplicado).</div>`);
    if (FM.lines.some(l => l._dup)) out.push('<div class="fin-msg info">Hay líneas marcadas como posible duplicado: pueden venir de dos fotos que se enciman. Si es la misma, quítala con ×.</div>');
    if (hasLines && total && Math.abs(sum - total) > 1) out.push(`<div class="fin-msg warn">Las líneas (${money(sum)}) no coinciden con el total del ticket (${money(total)}). <button type="button" class="fin-link" data-f="use-sum">Usar la suma de las líneas</button></div>`);
    const limit = num((B.config || {}).cash_limit) || 2000;
    if (val('ff-metodo') === 'Efectivo' && total > limit && (val('ff-moneda') || 'MXN') === 'MXN') out.push(`<div class="fin-msg warn">Pago en efectivo mayor a ${money(limit)}: normalmente no es deducible. Confírmalo con el contador.</div>`);
    if (!val('ff-vendor').trim()) out.push('<div class="fin-msg info">Sin proveedor: se guardará marcado para revisar.</div>');
    if (msg && !msg.dataset.sticky) msg.innerHTML = out.join('');
  }

  function applyVendorDefaults() {
    const v = vendorByName(val('ff-vendor'));
    if (!v) return;
    if (!val('ff-cat') && v['Default Category ID'] && $('ff-cat').querySelector(`option[value="${v['Default Category ID']}"]`)) $('ff-cat').value = v['Default Category ID'];
    // Payment method and invoice rule follow the supplier; the person can still change them for this expense.
    if (v['Método Pago Default'] && (B.enums.metodos || []).indexOf(v['Método Pago Default']) >= 0) $('ff-metodo').value = v['Método Pago Default'];
    if (v['Requiere Factura Default'] && !val('ff-req')) $('ff-req').value = v['Requiere Factura Default'];
    if (v['Cuenta Pago Default'] && !val('ff-cuenta')) $('ff-cuenta').value = v['Cuenta Pago Default'];
  }

  async function suggestFor(i) {
    const l = FM.lines[i]; const v = vendorByName(val('ff-vendor'));
    if (!l || !v || l.catalog_id || !(l.codigo || l.descripcion)) return;
    try {
      const r = await api('fin_map_suggest&' + qsOf({ vendor_id: v['Vendor ID'], code: l.codigo, desc: l.descripcion }));
      if (r.suggestions && r.suggestions[0]) { l._sug = r.suggestions[0]; renderLines(); }   // ppu stays 1 while the pieces field is hidden
    } catch (e) { /* suggestions are optional */ }
  }

  function readForm() {
    if (FM.uploading) return { error: 'Espera a que terminen de subir las fotos.' };
    const vName = val('ff-vendor').trim();
    const v = vName ? vendorByName(vName) : null;
    if (vName && !v) { return { error: `El proveedor “${vName}” no está en la lista. Pulsa “+ Nuevo” para crearlo.` }; }
    const lines = FM.lines.map(l => ({
      codigo: l.codigo, descripcion: l.descripcion, cantidad: num(l.cantidad) || 1, unidad: l.unidad, piezas_por_unidad: num(l.ppu) || 1,
      costo_unitario: num(l.costo), descuento: num(l.descuento), condicion: l.condicion || '', tipo: l.tipo, catalog_id: l.catalog_id || '', vinculo: l.catalog_id ? l.vinculo : 'Sin vincular',
    })).filter(l => l.codigo || l.descripcion);
    const expense = {
      fecha_compra: val('ff-fecha'), vendor_id: v ? v['Vendor ID'] : '', category_id: val('ff-cat'), descripcion: val('ff-desc').trim(),
      metodo_pago: val('ff-metodo'), cuenta_pago: val('ff-cuenta').trim(), total: num(val('ff-total')), folio_ticket: val('ff-folio').trim(),
      datos_facturacion: val('ff-datos').trim(), moneda: val('ff-moneda') || 'MXN', tipo_cambio: num(val('ff-tc')), notas: val('ff-notas').trim(),
      archivos: FM.files.map(f => f.id), own_money: !!($('ff-own') && $('ff-own').checked),
    };
    if (val('ff-req')) expense.requiere_factura = val('ff-req');
    if (val('ff-sub') !== '') expense.subtotal = num(val('ff-sub'));
    if (val('ff-iva') !== '') expense.iva = num(val('ff-iva'));
    if (val('ff-ded')) expense.deducible = val('ff-ded');
    if ($('ff-review') && $('ff-review').checked) expense.captura_status = 'Revisado';
    else if (!expense.total && expense.archivos.length) expense.captura_status = 'Por capturar';
    return { expense: expense, lines: lines };
  }

  async function saveForm(andNew) {
    const data = readForm();
    const msg = $('ff-msg');
    if (data.error) { msg.dataset.sticky = '1'; msg.innerHTML = `<div class="fin-msg err">${esc(data.error)}</div>`; return; }
    const btns = FM.modal.el.querySelectorAll('[data-f="save"],[data-f="save-new"]');
    btns.forEach(b => { b.disabled = true; });
    try {
      const body = FM.id ? { expense_id: FM.id, expense: data.expense, lines: data.lines } : { expense: data.expense, lines: data.lines };
      const action = FM.id ? 'fin_update_expense' : 'fin_create_expense';
      let r = await post(action, body);
      if (r.result === 'duplicate_warning') {
        const list = r.duplicates.map(d => `<li>${esc(d.id)} · ${fdate(d.fecha)} · ${money(d.total)} (${esc(d.why)})</li>`).join('');
        const ok = await ask('Posible gasto repetido', `<ul style="margin:0 0 0 18px;padding:0">${list}</ul><p class="fin-note">¿Es otro gasto distinto?</p>`, [{ label: 'Revisar', value: false }, { label: 'Es distinto, guardar', value: true, primary: true }]);
        if (!ok) { btns.forEach(b => { b.disabled = false; }); return; }
        body.confirm_duplicate = true;
        r = await post(action, body);
      }
      VP.toast(FM.id ? 'Gasto actualizado' : 'Gasto guardado');
      FM.modal.close();
      if (andNew) openForm({}); else refresh();
      refreshInboxCount();
    } catch (e) {
      msg.dataset.sticky = '1'; msg.innerHTML = `<div class="fin-msg err">${esc(e.message)}</div>`;
      btns.forEach(b => { b.disabled = false; });
    }
  }

  function applySuggestion(s) {
    const setIfEmpty = (id, v) => { const el = $(id); if (!el || v === '' || v === undefined || v === null || v === 0) return; if (el.value && String(el.value).trim() !== '') return; el.value = v; el.classList.add('fin-ai'); };
    if (s.vendor_id) setIfEmpty('ff-vendor', vendorName(s.vendor_id));
    else if (s.vendor_name && !val('ff-vendor')) { const msg = $('ff-msg'); msg.dataset.sticky = '1'; msg.innerHTML = `<div class="fin-msg info">La IA leyó el proveedor “${esc(s.vendor_name)}”, que no está en tu lista. <button type="button" class="fin-link" data-f="new-vendor" data-name="${esc(s.vendor_name)}">Crearlo</button></div>`; }
    // A new expense starts with today's date; the date printed on the ticket replaces it.
    if (s.fecha_compra && !FM.id && val('ff-fecha') === B.today) { $('ff-fecha').value = s.fecha_compra; $('ff-fecha').classList.add('fin-ai'); }
    else setIfEmpty('ff-fecha', s.fecha_compra);
    setIfEmpty('ff-total', s.total); setIfEmpty('ff-folio', s.folio_ticket);
    const vd = vendorByName(val('ff-vendor'));
    if (vd) applyVendorDefaults();
    if (s.metodo_pago && $('ff-metodo') && !(vd && vd['Método Pago Default'])) { $('ff-metodo').value = s.metodo_pago; $('ff-metodo').classList.add('fin-ai'); }
    setIfEmpty('ff-sub', s.subtotal); setIfEmpty('ff-iva', s.iva); setIfEmpty('ff-notas', s.notas);
    FM.aiPiezas = num(s.total_piezas) || 0;
    if (!FM.lines.some(l => l.codigo || l.descripcion) && s.lines && s.lines.length) {
      FM.lines = s.lines.map(l => {
        const gap = r2(num(l.cantidad) * num(l.costo_unitario) - num(l.total_linea));
        return Object.assign(emptyLine(), { codigo: l.codigo, descripcion: l.descripcion, cantidad: l.cantidad, costo: l.costo_unitario, descuento: num(l.total_linea) > 0 && gap > 0.5 ? gap : '', _ai: true, _dup: !!l.posible_duplicado });
      });
      renderLines(); FM.lines.forEach((_, i) => suggestFor(i));
    }
    updateWarnings();
  }

  async function openForm(opts) {
    opts = opts || {};
    let e = { 'Moneda': 'MXN' }, lines = [], files = [];
    try {
      if (opts.expenseId) {
        const r = await api('fin_get_expense&id=' + encodeURIComponent(opts.expenseId));
        e = r.expense; lines = (r.lines || []).map(lineFromServer);
        files = (e.files || []).map(id => { const f = (r.files || []).find(x => x.id === id); return { id: id, mime: f ? f.mime : 'image/jpeg', name: f ? f.name : '' }; });
      }
    } catch (err) { fail(err); return; }
    if (can('finance.create')) ensureCatalog();
    const isNew = !opts.expenseId;
    const m = VP.showModal(formHtml(e, isNew), { maxWidth: '900px' });
    FM = { id: opts.expenseId || '', files: files, lines: lines.length ? lines : [], modal: m };
    renderPhotos(); renderLines();
    if (B.ai_ready) { $('ff-ai').style.display = ''; $('ff-ai-hint').style.display = ''; }
    const syncTc = () => { $('ff-tc-wrap').style.display = val('ff-moneda') !== 'MXN' ? '' : 'none'; };
    syncTc();

    m.el.addEventListener('input', ev => {
      const t = ev.target;
      if (t.closest('.fin-line') && t.dataset.k) {
        const i = Number(t.closest('.fin-line').dataset.i), k = t.dataset.k, l = FM.lines[i];
        if (k === '_prod' || k === 'condicion') return;
        l[k] = t.value; l._ai = false;
        const tot = t.closest('.fin-line').querySelector('[data-total]'); if (tot) tot.textContent = money(lineTotal(l));
        if (['cantidad', 'costo', 'descuento'].indexOf(k) >= 0) updateWarnings();
      } else {
        if (t.classList) t.classList.remove('fin-ai');
        if (['ff-total', 'ff-vendor'].indexOf(t.id) >= 0) updateWarnings();
      }
    });
    m.el.addEventListener('change', ev => {
      const t = ev.target;
      if (t.id === 'ff-vendor') { applyVendorDefaults(); FM.lines.forEach((_, i) => suggestFor(i)); updateWarnings(); }
      else if (t.id === 'ff-metodo') updateWarnings();
      else if (t.id === 'ff-moneda') { syncTc(); updateWarnings(); }
      else if (t.closest('.fin-line') && t.dataset.k) {
        const i = Number(t.closest('.fin-line').dataset.i), k = t.dataset.k, l = FM.lines[i];
        if (k === '_prod') {
          const p = prodByName(t.value);
          if (p) { l.catalog_id = p.id; l.vinculo = 'Confirmado'; l._sug = null; } else if (!t.value.trim()) { l.catalog_id = ''; l.vinculo = 'Sin vincular'; }
          renderLines();
        } else if (['codigo', 'descripcion'].indexOf(k) >= 0) suggestFor(i);
        else if (['unidad', 'tipo'].indexOf(k) >= 0) l[k] = t.value;
        else if (k === 'condicion') { l.condicion = t.checked ? 'Dañado' : ''; renderLines(); }
        else if (k === 'descuento') renderLines();
      }
    });
    m.el.addEventListener('keydown', ev => {
      if (ev.key !== 'Enter' || !ev.target.closest('.fin-line')) return;
      const row = ev.target.closest('.fin-line'), i = Number(row.dataset.i);
      if (ev.target.dataset.k === 'costo' && i === FM.lines.length - 1) { ev.preventDefault(); FM.lines.push(emptyLine()); renderLines(); const last = $('ff-lines').lastElementChild; if (last) last.querySelector('[data-k="codigo"]').focus(); }
    });
    m.el.addEventListener('click', async ev => {
      const b = ev.target.closest('[data-f]'); if (!b) return;
      const f = b.dataset.f, i = Number(b.dataset.i);
      if (f === 'cancel') m.close();
      else if (f === 'save') saveForm(false);
      else if (f === 'save-new') saveForm(true);
      else if (f === 'add-line') { FM.lines.push(emptyLine()); renderLines(); const last = $('ff-lines').lastElementChild; if (last) last.querySelector('[data-k="codigo"]').focus(); }
      else if (f === 'rm-line') { FM.lines.splice(i, 1); renderLines(); }
      else if (f === 'line-more') { FM.lines[i]._more = !FM.lines[i]._more; renderLines(); }
      else if (f === 'use-sug') { const l = FM.lines[i]; l.catalog_id = l._sug.catalog_id; l.vinculo = 'Confirmado'; l._sug = null; renderLines(); }
      else if (f === 'use-sum') { $('ff-total').value = r2(FM.lines.reduce((s, l) => s + lineTotal(l), 0)); updateWarnings(); }
      else if (f === 'scan') { const code = await scanBarcode(); if (code) { FM.lines[i].codigo = code; renderLines(); suggestFor(i); } }
      else if (f === 'new-vendor') openVendorForm({ nombre: b.dataset.name || val('ff-vendor').trim(), onSaved: v => { $('ff-vendor').value = v['Nombre']; applyVendorDefaults(); const msg = $('ff-msg'); msg.dataset.sticky = ''; updateWarnings(); } });
      else if (f === 'rm-photo') { FM.files = FM.files.filter(x => x.id !== b.dataset.id); renderPhotos(); }
      else if (f === 'ai') aiFill();
      else if (f === 'add-photo') {
        const inp = document.createElement('input'); inp.type = 'file'; inp.accept = 'image/*,application/pdf'; inp.multiple = true;
        inp.onchange = async () => {
          // Upload in the background, all photos at once: the form stays usable meanwhile.
          const form = FM, files = Array.from(inp.files);
          form.uploading = (form.uploading || 0) + files.length; renderPhotos();
          await Promise.all(files.map(async file => {
            try { const r = await uploadTicket(file); form.files.push({ id: r.file_id, mime: r.mime, name: r.name }); }
            catch (err) { fail(err); }
            form.uploading--;
            if (FM === form) renderPhotos();
          }));
        };
        inp.click();
      }
    });
    if (!isNew) m.el.querySelector('.vp-modal-body').scrollTop = 0;
  }

  async function aiFill() {
    if (FM.uploading) { VP.toast('Espera a que terminen de subir las fotos.', true); return; }
    if (FM.reading) return;
    const ids = FM.files.filter(f => String(f.mime || 'image/').indexOf('image/') === 0).map(f => f.id);
    if (!ids.length) { VP.toast('Agrega primero la foto del ticket.', true); return; }
    // Reads in the background: the button shows progress and the form stays usable.
    const form = FM, btn = $('ff-ai'), label = btn.textContent, t0 = Date.now();
    form.reading = true; btn.disabled = true;
    const tick = setInterval(() => { btn.textContent = `✨ Leyendo… ${Math.round((Date.now() - t0) / 1000)} s`; }, 1000);
    btn.textContent = '✨ Leyendo…';
    try {
      const r = await post('fin_ai_extract', { file_ids: ids });
      if (FM === form && form.modal.el.isConnected) { applySuggestion(r.suggestion); VP.toast('Listo. Revisa los campos marcados en azul antes de guardar.'); }
    } catch (e) { if (FM === form) fail(e); }
    clearInterval(tick); form.reading = false;
    if (FM === form && btn.isConnected) { btn.disabled = false; btn.textContent = label; }
  }

  ACT['new-expense'] = () => openForm({});
  ACT['edit-expense'] = el => openForm({ expenseId: el.dataset.id });

  /* ── expense detail ─────────────────────────────────────────────────────── */
  function fiscalPanel() {
    const c = B.config || {};
    const rows = [['Razón social', c.razon_social], ['RFC', c.rfc], ['Régimen fiscal', c.regimen_fiscal], ['Código postal', c.codigo_postal], ['Uso de CFDI', c.uso_cfdi], ['Correo para la factura', c.email_factura]].filter(r => r[1]);
    if (!rows.length) return '<div class="fin-msg warn">Faltan los datos fiscales de la empresa. Un admin debe capturarlos en Configuración.</div>';
    return rows.map(r => `<div class="fin-copy"><span>${esc(r[0])}</span><span><b>${esc(r[1])}</b> <button class="fin-link" data-d="copy" data-v="${esc(r[1])}">copiar</button></span></div>`).join('');
  }

  async function openDetail(id) {
    let r;
    try { r = await api('fin_get_expense&id=' + encodeURIComponent(id)); } catch (e) { fail(e); return; }
    const e = r.expense, void_ = e['Status'] !== 'Activo';
    const mine = String(e['Creado Por']).toUpperCase() === String(B.me.name).toUpperCase();
    const canEdit = !void_ && (can('finance.edit_any') || (can('finance.edit_own') && mine && e['Captura Status'] !== 'Revisado'));
    const canVoid = !void_ && (can('finance.void') || (mine && e['Captura Status'] === 'Por capturar'));
    const needsInv = !void_ && e['Requiere Factura'] === 'Sí' && ['Pendiente', 'Solicitada'].indexOf(e['Estado Factura']) >= 0;
    const vend = MAPS.vendors[e['Vendor ID']] || {};
    const m = VP.showModal(`
      <h3 class="fin-modal-h">${esc(e['Descripción'] || vendorName(e['Vendor ID']) || 'Gasto')}</h3>
      <div class="fin-sub">${esc(e['Expense ID'])} · ${fdate(e['Fecha Compra'])} ${void_ ? badge('Anulado', 'fin-b-red') : capturaBadge(e)} ${flagChips(e['Flags'])}</div>
      ${void_ ? `<div class="fin-msg err">Anulado por ${esc(e['Anulado Por'])} (${esc(e['Anulado En'])}): ${esc(e['Motivo Anulación'])}</div>` : ''}
      <div class="fin-grid" style="margin-top:12px">
        <div class="fin-field">Proveedor<b style="color:var(--text)">${esc(vendorName(e['Vendor ID']) || '—')}</b></div>
        <div class="fin-field">Total<b style="color:var(--text)">${money(e['Total'])}${e['Moneda'] !== 'MXN' ? ' ' + esc(e['Moneda']) : ''}</b></div>
        <div class="fin-field">Categoría<b style="color:var(--text)">${esc(catName(e['Category ID']) || '—')}</b></div>
        <div class="fin-field">Pago<b style="color:var(--text)">${esc(e['Método Pago'])}${e['Cuenta Pago'] ? ' · ' + esc(e['Cuenta Pago']) : ''}</b></div>
        <div class="fin-field">Folio ticket<b style="color:var(--text)">${esc(e['Folio Ticket'] || '—')}</b></div>
        <div class="fin-field">Factura<span>${facturaBadge(e)}${e['Fecha Límite Factura'] && needsInv ? ' <span class="fin-sub">límite ' + fdate(e['Fecha Límite Factura']) + '</span>' : ''}</span></div>
        ${e['Reembolso Status'] && e['Reembolso Status'] !== 'No aplica' ? `<div class="fin-field">Reembolso<span>${badge(e['Reembolso Status'], e['Reembolso Status'] === 'Pagado' ? 'fin-b-green' : 'fin-b-amber')}</span></div>` : ''}
        <div class="fin-field">Capturó<b style="color:var(--text)">${esc(e['Creado Por'])}</b></div>
        ${e['IVA'] !== '' && e['IVA'] !== undefined ? `<div class="fin-field">IVA<b style="color:var(--text)">${money(e['IVA'])}</b></div>` : ''}
        ${e['Notas'] ? `<div class="fin-field fin-full">Notas<span style="color:var(--text)">${esc(e['Notas'])}</span></div>` : ''}
      </div>
      ${r.files.length ? `<div class="fin-h3">Archivos</div><div class="fin-photos">${r.files.map(f => thumb(f.id)).join('')}</div>` : ''}
      ${r.lines.length ? `<div class="fin-h3">Productos</div><div class="fin-card"><table class="fin-tbl"><thead><tr><th>Código</th><th>Descripción</th><th class="num">Cant.</th><th class="num">P. unit.</th><th class="num">Total</th><th>Catálogo</th></tr></thead><tbody>
        ${r.lines.map(l => `<tr><td>${esc(l['Código Proveedor'])}</td><td>${esc(l['Descripción'])}</td><td class="num">${esc(l['Cantidad'])}</td><td class="num">${money(l['Costo Unitario'])}</td><td class="num">${money(l['Total Línea'])}</td><td>${l['Catalog ID'] ? badge(l['Vínculo'], l['Vínculo'] === 'Confirmado' ? 'fin-b-green' : 'fin-b-amber') + ' <span class="fin-sub">' + esc(l['Catalog ID']) + '</span>' : '<span class="fin-sub">sin vincular</span>'}</td></tr>`).join('')}
        </tbody></table></div>` : ''}
      ${r.invoice ? `<div class="fin-h3">Factura vinculada</div><div class="fin-msg ok">${esc(r.invoice['Nombre Emisor'])} · ${money(r.invoice['Total'])} · ${fdate(r.invoice['Fecha Emisión'])}<div class="fin-sub" style="color:inherit;opacity:.8">UUID ${esc(r.invoice['UUID'])}</div>
        <div style="margin-top:6px">${r.invoice.files.xml ? '<button class="fin-link" data-d="file" data-v="' + esc(r.invoice.files.xml) + '">Ver XML</button> ' : ''}${r.invoice.files.pdf ? '<button class="fin-link" data-d="file" data-v="' + esc(r.invoice.files.pdf) + '">Ver PDF</button> ' : ''}${can('finance.invoices') ? '<button class="fin-link" data-d="unlink">Desvincular</button>' : ''}</div></div>` : ''}
      ${needsInv && can('finance.invoices') ? `<div class="fin-h3">Pedir la factura</div><div class="fin-card fin-pad">
        ${vend['Portal Facturación URL'] ? `<div style="margin-bottom:8px"><a class="fin-link" href="${esc(vend['Portal Facturación URL'])}" target="_blank" rel="noopener">Abrir la página de facturación de ${esc(vend['Nombre'])} ↗</a></div>` : '<div class="fin-note" style="margin:0 0 8px">Este proveedor no tiene página de facturación guardada (un admin puede agregarla en Proveedores).</div>'}
        ${e['Datos Facturación'] ? `<div class="fin-copy"><span>Datos del ticket</span><span><b>${esc(e['Datos Facturación'])}</b> <button class="fin-link" data-d="copy" data-v="${esc(e['Datos Facturación'])}">copiar</button></span></div>` : ''}
        ${e['Folio Ticket'] ? `<div class="fin-copy"><span>Folio</span><span><b>${esc(e['Folio Ticket'])}</b> <button class="fin-link" data-d="copy" data-v="${esc(e['Folio Ticket'])}">copiar</button></span></div>` : ''}
        ${fiscalPanel()}
      </div>` : ''}
      <div class="fin-actions-row">
        ${needsInv && can('finance.invoices') ? `${e['Estado Factura'] === 'Pendiente' ? '<button class="btn btn-sm" data-d="st" data-v="Solicitada">Ya la solicité</button>' : ''}<button class="btn btn-sm" data-d="xml">Subir XML recibido</button><button class="btn btn-sm" data-d="st" data-v="Perdida">Se perdió</button><button class="btn btn-sm" data-d="st" data-v="No requiere">No requiere</button>` : ''}
        ${!void_ && e['Captura Status'] === 'Por pagar' && can('finance.edit_any') ? '<button class="btn btn-sm" data-d="paid">Marcar pagado</button>' : ''}
        ${canVoid ? '<button class="btn btn-sm btn-danger" data-d="void">Anular</button>' : ''}
        ${canEdit ? '<button class="btn btn-primary btn-sm" data-d="edit">Editar</button>' : ''}
      </div>`, { maxWidth: '860px' });
    hydrate(m.el);
    m.el.addEventListener('click', async ev => {
      const b = ev.target.closest('[data-d]'); if (!b) return;
      const d = b.dataset.d;
      try {
        if (d === 'copy') copyText(b.dataset.v);
        else if (d === 'file') openFile(b.dataset.v);
        else if (d === 'edit') { m.close(); openForm({ expenseId: id }); }
        else if (d === 'xml') { m.close(); openInvoiceUpload({ expenseId: id }); }
        else if (d === 'st') { await post('fin_set_invoice_status', { expense_id: id, estado: b.dataset.v }); VP.toast('Actualizado'); m.close(); refresh(); }
        else if (d === 'unlink') { await post('fin_unlink_invoice', { expense_id: id }); VP.toast('Factura desvinculada'); m.close(); refresh(); }
        else if (d === 'void') {
          const reason = await promptText('Anular gasto', 'Motivo', 'Ej. ticket repetido');
          if (!reason) return;
          await post('fin_void_expense', { expense_id: id, reason: reason }); VP.toast('Gasto anulado'); m.close(); refresh(); refreshInboxCount();
        } else if (d === 'paid') {
          const amount = await promptText('Marcar pagado', 'Monto real pagado (deja vacío para usar el estimado)', String(e['Total']));
          if (amount === null) return;
          await post('fin_mark_paid', { expense_id: id, total: amount === '' ? undefined : amount }); VP.toast('Marcado como pagado'); m.close(); refresh();
        }
      } catch (err) { fail(err); }
    });
  }
  ACT['open-expense'] = el => openDetail(el.dataset.id);

  async function refreshInboxCount() {
    if (!can('finance.create')) return;
    try { const r = await api('fin_list_expenses&' + qsOf({ captura: 'Por capturar', periodo: 'all', limit: 1 })); setInbox(r.count); } catch (e) { /* badge is optional */ }
  }

  /* ── Gastos (list) ──────────────────────────────────────────────────────── */
  RENDER.gastos = async function () {
    if (!F.month) F.month = B.today.slice(0, 7);
    const c = $('fin-content');
    c.innerHTML = `
      <div class="fin-filters">
        <input class="vp-input" type="month" id="g-month" value="${F.month === 'all' ? '' : esc(F.month)}">
        <button class="btn btn-sm" id="g-all">${F.month === 'all' ? '✓ ' : ''}Todos los meses</button>
        <input class="vp-input" id="g-q" type="search" placeholder="Buscar proveedor, folio, descripción…" value="${esc(F.q)}" style="flex:1;min-width:180px">
        <select class="vp-input" id="g-estado"><option value="">Factura: todas</option>${(B.enums.estados_factura || []).map(s => `<option ${s === F.estado ? 'selected' : ''}>${s}</option>`).join('')}</select>
        <select class="vp-input" id="g-captura"><option value="">Estado: todos</option>${(B.enums.captura || []).map(s => `<option ${s === F.captura ? 'selected' : ''}>${s}</option>`).join('')}</select>
        ${(isAdmin() || can('finance.view_all_entries')) ? `<label class="fin-check"><input type="checkbox" id="g-mine" ${F.mine ? 'checked' : ''}> Solo los míos</label>` : ''}
        ${isAdmin() ? `<select class="vp-input" id="g-status">${[['activo', 'Activos'], ['anulado', 'Anulados'], ['todos', 'Todos']].map(s => `<option value="${s[0]}" ${s[0] === F.status ? 'selected' : ''}>${s[1]}</option>`).join('')}</select>` : ''}
      </div>
      <div class="fin-card" id="g-list">${loading}</div>`;
    let t = null;
    const reload = () => loadGastos();
    $('g-month').onchange = e => { F.month = e.target.value || 'all'; show('gastos'); };
    $('g-all').onclick = () => { F.month = F.month === 'all' ? B.today.slice(0, 7) : 'all'; show('gastos'); };
    $('g-q').oninput = e => { F.q = e.target.value; clearTimeout(t); t = setTimeout(reload, 300); };
    $('g-estado').onchange = e => { F.estado = e.target.value; reload(); };
    $('g-captura').onchange = e => { F.captura = e.target.value; reload(); };
    if ($('g-mine')) $('g-mine').onchange = e => { F.mine = e.target.checked; reload(); };
    if ($('g-status')) $('g-status').onchange = e => { F.status = e.target.value; reload(); };
    await loadGastos();
  };

  async function loadGastos() {
    const box = $('g-list'); if (!box) return;
    const res = await api('fin_list_expenses&' + qsOf({ periodo: F.month || 'all', q: F.q, estado_factura: F.estado, captura: F.captura, mine: F.mine, status: F.status, limit: 500 }));
    if (!$('g-list')) return;
    const accounts = {};
    res.rows.forEach(o => { if (o['Cuenta Pago']) accounts[o['Cuenta Pago']] = 1; });
    $('fin-accounts').innerHTML = Object.keys(accounts).map(a => `<option value="${esc(a)}"></option>`).join('');
    if (!res.rows.length) { box.innerHTML = '<div class="fin-empty">No hay gastos con estos filtros.</div>'; return; }
    box.innerHTML = `<table class="fin-tbl"><thead><tr><th>Fecha</th><th>Proveedor</th><th>Descripción</th><th>Pago</th><th class="num">Total</th><th>Factura</th><th>📎</th><th>Capturó</th></tr></thead><tbody>
      ${res.rows.map(o => `<tr class="fin-row ${o['Status'] !== 'Activo' ? 'is-void' : ''}" data-act="open-expense" data-id="${esc(o['Expense ID'])}">
        <td style="white-space:nowrap">${fdate(o['Fecha Compra'])}</td>
        <td>${esc(vendorName(o['Vendor ID']) || '—')}</td>
        <td>${esc(o['Descripción'] || '')} <div class="fin-sub">${esc(catName(o['Category ID']))} ${capturaBadge(o)} ${flagChips(o['Flags'])}</div></td>
        <td>${esc(o['Método Pago'])}</td>
        <td class="num">${o['Captura Status'] === 'Por capturar' ? '<span class="fin-sub">—</span>' : money(o['Total'])}${o['Moneda'] !== 'MXN' ? '<div class="fin-sub">' + esc(o['Moneda']) + '</div>' : ''}</td>
        <td>${facturaBadge(o)}</td>
        <td>${o.files.length || ''}</td>
        <td class="fin-sub">${esc(o['Creado Por'])}</td></tr>`).join('')}
      </tbody>${res.totals ? `<tfoot><tr><td colspan="4">Total de lo que se ve${res.truncated ? ' (primeros 500)' : ''}</td><td class="num">${money(res.totals.total_mxn)}</td><td colspan="3"></td></tr></tfoot>` : ''}</table>
      ${res.truncated ? '<div class="fin-note fin-pad">Hay más gastos; usa los filtros para acotar.</div>' : ''}`;
  }

  /* ── Facturas ───────────────────────────────────────────────────────────── */
  RENDER.facturas = async function () {
    const [pend, inv] = await Promise.all([api('fin_pending_invoices'), api('fin_list_invoices')]);
    const c = $('fin-content');
    const late = pend.rows.filter(o => o.invoice_overdue).length;
    c.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap">
        <div class="fin-h2" style="margin:0">Pendientes de factura <span class="fin-sub">(${pend.rows.length}${late ? ' · ' + late + ' vencidas' : ''})</span></div>
        <button class="btn btn-primary btn-sm" data-act="upload-xml">⬆ Subir factura (XML)</button>
      </div>
      <div class="fin-card" style="margin-top:10px">${pend.rows.length ? `<table class="fin-tbl"><thead><tr><th>Estado</th><th>Proveedor</th><th>Compra</th><th class="num">Total</th><th>Para facturar</th><th></th></tr></thead><tbody>
        ${pend.rows.map(o => `<tr class="fin-row" data-act="open-expense" data-id="${esc(o['Expense ID'])}">
          <td>${facturaBadge(o)}${o['Fecha Límite Factura'] ? '<div class="fin-sub">límite ' + fdate(o['Fecha Límite Factura']) + '</div>' : ''}</td>
          <td>${esc(o.vendor_name || '—')}</td><td>${fdate(o['Fecha Compra'])}</td><td class="num">${money(o['Total'])}</td>
          <td class="fin-sub">${esc(o['Datos Facturación'] || o['Folio Ticket'] || '')}</td>
          <td style="white-space:nowrap">${o.vendor_portal ? `<a class="fin-link" href="${esc(o.vendor_portal)}" target="_blank" rel="noopener" onclick="event.stopPropagation()">Página ↗</a> ` : ''}<button class="btn btn-sm" data-act="xml-for" data-id="${esc(o['Expense ID'])}">Subir XML</button></td></tr>`).join('')}
        </tbody></table>` : '<div class="fin-empty">No hay facturas pendientes. 🎉</div>'}</div>
      <div class="fin-h2">Facturas recibidas</div>
      <div class="fin-card">${inv.rows.length ? `<table class="fin-tbl"><thead><tr><th>Fecha</th><th>Emisor</th><th class="num">Total</th><th>UUID</th><th>Vínculo</th><th></th></tr></thead><tbody>
        ${inv.rows.map(i => `<tr>
          <td>${fdate(i['Fecha Emisión'])}</td><td>${esc(i['Nombre Emisor'])}<div class="fin-sub">${esc(i['RFC Emisor'])} ${flagChips(i['Flags'])}</div></td>
          <td class="num">${money(i['Total'])}</td><td class="fin-sub" title="${esc(i['UUID'])}">${esc(String(i['UUID']).slice(0, 8))}…</td>
          <td>${i['Match Status'] === 'Confirmado' ? badge('Vinculada', 'fin-b-green') + '<div class="fin-sub">' + esc(i.expense_ids.join(', ')) + '</div>' : badge('Sin vincular', 'fin-b-amber')}</td>
          <td style="white-space:nowrap">${i['Match Status'] !== 'Confirmado' ? `<button class="btn btn-sm btn-primary" data-act="link-inv" data-id="${esc(i['Invoice ID'])}">Vincular</button> ` : ''}
            ${i.files.xml ? `<button class="fin-link" data-act="open-file" data-fid="${esc(i.files.xml)}">XML</button> ` : ''}${i.files.pdf ? `<button class="fin-link" data-act="open-file" data-fid="${esc(i.files.pdf)}">PDF</button> ` : ''}
            ${can('finance.void') ? `<button class="fin-link" data-act="void-inv" data-id="${esc(i['Invoice ID'])}">Anular</button>` : ''}</td></tr>`).join('')}
        </tbody></table>` : '<div class="fin-empty">Todavía no se ha subido ninguna factura.</div>'}</div>`;
    RENDER.facturas._inv = inv.rows;
  };

  // Step 2 of upload / the link dialog: pick which expenses the factura covers.
  async function linkStep(m, invoice, suggestions, preselect) {
    let pending = [];
    try { pending = (await api('fin_pending_invoices')).rows; } catch (e) { pending = []; }
    const sugIds = suggestions.map(s => s.expense_id);
    const others = pending.filter(p => sugIds.indexOf(p['Expense ID']) < 0);
    const forced = preselect && sugIds.indexOf(preselect) < 0 ? pending.find(p => p['Expense ID'] === preselect) : null;
    const body = m.el.querySelector('.vp-modal-body');
    const row = (id, label, checked, extra) => `<label class="fin-copy" style="cursor:pointer"><span><input type="checkbox" data-eid="${esc(id)}" ${checked ? 'checked' : ''}> ${label}</span><span class="fin-sub">${extra || ''}</span></label>`;
    body.innerHTML = `
      <h3 class="fin-modal-h">Factura de ${esc(invoice['Nombre Emisor'])}</h3>
      <div class="fin-sub">${fdate(invoice['Fecha Emisión'])} · ${esc(invoice['RFC Emisor'])} · UUID ${esc(String(invoice['UUID']).slice(0, 13))}…</div>
      <div class="fin-kpi" style="margin:12px 0"><div class="fin-kpi-l">Total de la factura</div><div class="fin-kpi-v">${money(invoice['Total'])}</div><div class="fin-kpi-s">IVA ${money(invoice['IVA Trasladado'])}</div></div>
      ${invoice['Flags'] ? `<div class="fin-msg warn">${String(invoice['Flags']).split(',').filter(Boolean).map(f => esc(FLAG_TXT[f] || f)).join(' · ')}</div>` : ''}
      <div class="fin-h3">¿A qué gasto corresponde?</div>
      <div class="fin-card fin-pad" id="ls-list">
        ${suggestions.map((s, i) => row(s.expense_id, `${fdate(s.fecha)} · ${money(s.total)} · ${esc(s.descripcion || vendorName(s.vendor_id) || s.expense_id)}`, i === 0 || s.expense_id === preselect, s.total_diff === 0 ? 'coincide el total' : 'difiere ' + money(s.total_diff))).join('')}
        ${forced ? row(forced['Expense ID'], `${fdate(forced['Fecha Compra'])} · ${money(forced['Total'])} · ${esc(forced['Descripción'] || forced.vendor_name || '')}`, true, 'elegido') : ''}
        ${!suggestions.length && !forced ? '<div class="fin-note" style="margin:0">No encontré un gasto que coincida. Elige uno de la lista de abajo o déjala sin vincular.</div>' : ''}
      </div>
      ${others.length ? `<div class="fin-h3">Otros gastos pendientes</div><div class="fin-card fin-pad" style="max-height:200px;overflow:auto">${others.map(p => row(p['Expense ID'], `${fdate(p['Fecha Compra'])} · ${money(p['Total'])} · ${esc(p.vendor_name || '')} ${esc(p['Descripción'] || '')}`, false, '')).join('')}</div>` : ''}
      <div id="ls-msg"></div>
      <div class="fin-actions-row"><button class="btn" id="ls-later">Dejar sin vincular</button><button class="btn btn-primary" id="ls-link">Vincular</button></div>`;
    body.querySelector('#ls-later').onclick = () => { m.close(); refresh(); };
    body.querySelector('#ls-link').onclick = async () => {
      const ids = Array.prototype.map.call(body.querySelectorAll('[data-eid]:checked'), x => x.dataset.eid);
      if (!ids.length) { body.querySelector('#ls-msg').innerHTML = '<div class="fin-msg err">Elige al menos un gasto.</div>'; return; }
      try {
        let r = await post('fin_link_invoice', { invoice_id: invoice['Invoice ID'], expense_ids: ids });
        if (r.result === 'mismatch_warning') {
          const ok = await ask('Los montos no coinciden', `<p style="margin:0">Los gastos suman ${money(r.expenses_total)} y la factura dice ${money(r.invoice_total)} (diferencia ${money(Math.abs(r.diff))}).</p>`, [{ label: 'Revisar', value: false }, { label: 'Vincular de todos modos', value: true, primary: true }]);
          if (!ok) return;
          r = await post('fin_link_invoice', { invoice_id: invoice['Invoice ID'], expense_ids: ids, confirm_mismatch: true });
        }
        VP.toast('Factura vinculada'); m.close(); refresh();
      } catch (e) { body.querySelector('#ls-msg').innerHTML = `<div class="fin-msg err">${esc(e.message)}</div>`; }
    };
  }

  function openInvoiceUpload(opts) {
    opts = opts || {};
    const m = VP.showModal(`
      <h3 class="fin-modal-h">Subir factura</h3>
      <div class="fin-note" style="margin-bottom:12px">El XML trae todos los datos (UUID, total, IVA, productos), así que no hay que capturar nada. El PDF es opcional.</div>
      <div class="fin-grid">
        <label class="fin-field fin-span2">Archivo XML (obligatorio)<input type="file" id="iu-xml" accept=".xml,text/xml,application/xml" class="vp-input"></label>
        <label class="fin-field fin-span2">Archivo PDF (opcional)<input type="file" id="iu-pdf" accept=".pdf,application/pdf" class="vp-input"></label>
      </div>
      <div id="iu-msg"></div>
      <div class="fin-actions-row"><button class="btn" id="iu-cancel">Cancelar</button><button class="btn btn-primary" id="iu-go">Leer factura</button></div>`, { maxWidth: '680px' });
    const q = s => m.el.querySelector(s);
    q('#iu-cancel').onclick = () => m.close();
    q('#iu-go').onclick = async () => {
      const xf = q('#iu-xml').files[0], pf = q('#iu-pdf').files[0], msg = q('#iu-msg');
      if (!xf) { msg.innerHTML = '<div class="fin-msg err">Elige el archivo XML.</div>'; return; }
      q('#iu-go').disabled = true; msg.innerHTML = '<div class="fin-msg info">Leyendo…</div>';
      try {
        const xml = await xf.text();
        const up = await post('fin_upload_file', { name: xf.name, mime: 'text/xml', kind: 'xml', data: await readB64(xf) });
        let pdfId = '';
        if (pf) pdfId = (await post('fin_upload_file', { name: pf.name, mime: 'application/pdf', kind: 'pdf', data: await readB64(pf) })).file_id;
        const r = await post('fin_create_invoice', { xml: xml, xml_file_id: up.file_id, pdf_file_id: pdfId });
        if (r.result === 'duplicate_invoice') {
          msg.innerHTML = `<div class="fin-msg warn">Esta factura ya estaba registrada (${esc(r.invoice['Invoice ID'])}, ${r.invoice['Match Status'] === 'Confirmado' ? 'ya vinculada' : 'sin vincular'}). No se duplicó.</div>`;
          q('#iu-go').disabled = false; return;
        }
        if (r.vendor_hint) VP.toast('Proveedor nuevo en la factura: ' + r.vendor_hint.nombre);
        await linkStep(m, r.invoice, r.suggestions || [], opts.expenseId);
        if (r.vendor_hint && can('finance.vendors_create')) {
          const body = m.el.querySelector('.vp-modal-body');
          const hint = document.createElement('div');
          hint.className = 'fin-msg info'; hint.innerHTML = `El proveedor “${esc(r.vendor_hint.nombre)}” (${esc(r.vendor_hint.rfc)}) no está en tu lista. <button class="fin-link" id="iu-newv">Crearlo</button>`;
          body.insertBefore(hint, body.querySelector('.fin-h3'));
          hint.querySelector('#iu-newv').onclick = () => openVendorForm({ nombre: r.vendor_hint.nombre, rfc: r.vendor_hint.rfc });
        }
      } catch (e) { msg.innerHTML = `<div class="fin-msg err">${esc(e.message)}</div>`; q('#iu-go').disabled = false; }
    };
  }

  ACT['upload-xml'] = () => openInvoiceUpload({});
  ACT['xml-for'] = el => openInvoiceUpload({ expenseId: el.dataset.id });
  ACT['link-inv'] = async el => {
    const inv = (RENDER.facturas._inv || []).find(i => i['Invoice ID'] === el.dataset.id);
    if (!inv) return;
    const m = VP.showModal('<div class="vp-loading">Cargando</div>', { maxWidth: '680px' });
    await linkStep(m, inv, inv.suggestions || [], '');
  };
  ACT['void-inv'] = async el => {
    const reason = await promptText('Anular factura', 'Motivo', 'Ej. cancelada por el proveedor');
    if (!reason) return;
    try { await post('fin_void_invoice', { invoice_id: el.dataset.id, reason: reason }); VP.toast('Factura anulada'); refresh(); } catch (e) { fail(e); }
  };

  /* ── Proveedores ────────────────────────────────────────────────────────── */
  RENDER.proveedores = async function () {
    const list = (B.vendors || []).slice().sort((a, b) => (a['Status'] === 'Pendiente revisión' ? -1 : 0) - (b['Status'] === 'Pendiente revisión' ? -1 : 0) || String(a['Nombre']).localeCompare(String(b['Nombre'])));
    const pend = list.filter(v => v['Status'] === 'Pendiente revisión').length;
    const c = $('fin-content');
    c.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:12px">
        <div class="fin-sub">${list.length} proveedores${pend && can('finance.vendors_edit') ? ' · <b>' + pend + ' por revisar</b>' : ''}</div>
        ${can('finance.vendors_create') || can('finance.vendors_edit') ? '<button class="btn btn-primary btn-sm" data-act="new-vendor">+ Proveedor</button>' : ''}
      </div>
      <div class="fin-card">${list.length ? `<table class="fin-tbl"><thead><tr><th>Nombre</th><th>RFC</th><th>Estado</th><th>Plazo para facturar</th><th>Página</th><th></th></tr></thead><tbody>
        ${list.map(v => `<tr>
          <td>${esc(v['Nombre'])}${v['Alias'] ? '<div class="fin-sub">' + esc(v['Alias']) + '</div>' : ''}</td><td class="fin-sub">${esc(v['RFC'] || '—')}</td>
          <td>${v['Status'] === 'Activo' ? badge('Activo', 'fin-b-green') : badge(v['Status'], v['Status'] === 'Inactivo' ? '' : 'fin-b-amber')}</td>
          <td class="fin-sub">${esc(v['Regla Plazo Factura'])}${v['Regla Plazo Factura'] === 'N días' ? ' (' + esc(v['Días Plazo']) + ')' : ''}${v['Requiere Factura Default'] === 'No' ? ' · sin factura' : ''}</td>
          <td>${v['Portal Facturación URL'] ? `<a class="fin-link" href="${esc(v['Portal Facturación URL'])}" target="_blank" rel="noopener">Abrir ↗</a>` : '<span class="fin-sub">—</span>'}</td>
          <td>${can('finance.vendors_edit') ? `<button class="btn btn-sm" data-act="edit-vendor" data-id="${esc(v['Vendor ID'])}">${v['Status'] === 'Pendiente revisión' ? 'Revisar' : 'Editar'}</button>` : ''}</td></tr>`).join('')}
        </tbody></table>` : '<div class="fin-empty">Todavía no hay proveedores. Se crean al capturar un gasto o aquí.</div>'}</div>`;
  };
  ACT['new-vendor'] = () => openVendorForm({});
  ACT['edit-vendor'] = el => openVendorForm({ vendor: MAPS.vendors[el.dataset.id] });

  /* ── Caja chica + reembolsos ────────────────────────────────────────────── */
  RENDER.caja = async function () {
    const [pc, re] = await Promise.all([
      (can('finance.petty_cash') || can('finance.reimburse')) ? api('fin_petty_cash') : Promise.resolve({ balances: [], moves: [], spent: [], can_fund: false }),
      api('fin_reimbursements'),
    ]);
    const c = $('fin-content');
    c.innerHTML = `
      <div class="fin-h2">Caja chica</div>
      <div class="fin-bal">${pc.balances.length ? pc.balances.map(b => `<div class="fin-kpi"><div class="fin-kpi-l">${esc(b.responsable)}</div><div class="fin-kpi-v">${money(b.saldo)}</div><div class="fin-kpi-s">Recibido ${money(b.fondeos + b.ajustes)} · gastado ${money(b.gastos)}</div></div>`).join('') : '<div class="fin-card fin-empty" style="grid-column:1/-1">Todavía no hay movimientos de caja chica.</div>'}</div>
      ${pc.can_fund ? `<div class="fin-card fin-pad"><div class="fin-h3" style="margin-top:0">Dar dinero o ajustar</div>
        <div class="fin-grid"><label class="fin-field">Para<input class="vp-input" id="cc-who" list="cc-names" placeholder="Ej. KARIN"><datalist id="cc-names">${pc.balances.map(b => `<option value="${esc(b.responsable)}"></option>`).join('')}</datalist></label>
        <label class="fin-field">Tipo<select class="vp-input" id="cc-tipo"><option>Fondeo</option><option>Ajuste</option></select></label>
        <label class="fin-field">Monto (el ajuste puede ser negativo)<input class="vp-input" id="cc-monto" type="number" step="0.01"></label>
        <label class="fin-field">Notas<input class="vp-input" id="cc-notas"></label></div>
        <div class="fin-actions-row"><button class="btn btn-primary btn-sm" id="cc-save">Registrar</button></div></div>` : ''}
      ${pc.spent.length ? `<div class="fin-h3">Gastos pagados con caja chica</div><div class="fin-card"><table class="fin-tbl"><tbody>${pc.spent.map(s => `<tr class="fin-row" data-act="open-expense" data-id="${esc(s.id)}"><td>${fdate(s.fecha)}</td><td>${esc(s.descripcion || s.id)}</td><td class="fin-sub">${esc(s.responsable)}</td><td class="num">${money(s.total)}</td></tr>`).join('')}</tbody></table></div>` : ''}
      ${pc.moves.length ? `<div class="fin-h3">Movimientos</div><div class="fin-card"><table class="fin-tbl"><tbody>${pc.moves.map(x => `<tr><td>${fdate(x['Fecha'])}</td><td>${esc(x['Responsable'])}</td><td>${esc(x['Tipo'])}</td><td class="fin-sub">${esc(x['Notas'])}</td><td class="num">${money(x['Monto'])}</td></tr>`).join('')}</tbody></table></div>` : ''}
      <div class="fin-h2">Reembolsos pendientes</div>
      <div class="fin-card">${re.rows.length ? `<table class="fin-tbl"><tbody>${re.rows.map(r => `<tr>${re.can_pay ? `<td><input type="checkbox" data-rid="${esc(r.id)}"></td>` : ''}<td>${fdate(r.fecha)}</td><td class="fin-row" data-act="open-expense" data-id="${esc(r.id)}">${esc(r.descripcion || vendorName(r.vendor_id) || r.id)}</td><td class="fin-sub">${esc(r.pagado_por)}</td><td class="num">${money(r.total)}</td></tr>`).join('')}</tbody></table>
        ${re.can_pay ? '<div class="fin-pad" style="text-align:right"><button class="btn btn-primary btn-sm" id="rb-pay">Marcar seleccionados como pagados</button></div>' : ''}` : '<div class="fin-empty">No hay reembolsos pendientes.</div>'}</div>`;
    if ($('cc-save')) $('cc-save').onclick = async () => {
      try {
        await post('fin_petty_cash_move', { responsable: val('cc-who'), tipo: val('cc-tipo'), monto: val('cc-monto'), notas: val('cc-notas') });
        VP.toast('Registrado'); show('caja');
      } catch (e) { fail(e); }
    };
    if ($('rb-pay')) $('rb-pay').onclick = async () => {
      const ids = Array.prototype.map.call(c.querySelectorAll('[data-rid]:checked'), x => x.dataset.rid);
      if (!ids.length) { VP.toast('Marca al menos uno.', true); return; }
      try { const r = await post('fin_mark_reimbursed', { expense_ids: ids }); VP.toast(r.done + ' reembolsos pagados'); show('caja'); } catch (e) { fail(e); }
    };
  };

  /* ── Resumen (admin / view_summary) ─────────────────────────────────────── */
  let RES_MONTH = '';
  const monthLabel = ym => VP.MONTHS_ES[Number(ym.slice(5, 7)) - 1] + ' ' + ym.slice(2, 4);
  const shiftMonth = (ym, d) => { const t = new Date(Date.UTC(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)) - 1 + d, 1, 12)); return t.toISOString().slice(0, 7); };
  const delta = (cur, prev, goodWhenDown) => {
    if (!prev) return '<span class="fin-sub">sin mes anterior</span>';
    const p = Math.round((cur - prev) / prev * 1000) / 10;
    const cls = p === 0 ? '' : ((p > 0) === !!goodWhenDown ? 'fin-up' : 'fin-down');
    return `<span class="${cls}">${p > 0 ? '▲' : p < 0 ? '▼' : '='} ${Math.abs(p)}%</span> <span class="fin-sub">vs mes anterior</span>`;
  };

  RENDER.resumen = async function () {
    if (!RES_MONTH) RES_MONTH = B.today.slice(0, 7);
    const s = await api('fin_summary&periodo=' + RES_MONTH);
    const c = $('fin-content');
    const attn = [
      [s.por_capturar, 'tickets por capturar', 'bandeja'], [s.facturas.pendientes_count, `facturas pendientes${s.facturas.vencidas_count ? ' (' + s.facturas.vencidas_count + ' vencidas)' : ''}`, 'facturas'],
      [s.por_pagar.count, 'gastos fijos por pagar (' + money(s.por_pagar.total) + ')', 'fijos'], [s.reembolsos_pendientes.count, 'reembolsos pendientes (' + money(s.reembolsos_pendientes.total) + ')', 'caja'],
    ].filter(a => a[0] > 0);
    VP.resetCharts();
    c.innerHTML = `
      <div class="fin-filters"><button class="btn btn-sm" data-act="res-prev">‹</button><input class="vp-input" type="month" id="r-month" value="${esc(RES_MONTH)}"><button class="btn btn-sm" data-act="res-next">›</button>
        <span style="flex:1"></span><button class="btn btn-sm" data-act="cost-history">Historial de costos por producto</button></div>
      <div class="fin-bal">
        <div class="fin-kpi"><div class="fin-kpi-l">Gasto de ${esc(monthLabel(RES_MONTH))}</div><div class="fin-kpi-v">${money(s.gasto.total)}</div><div class="fin-kpi-s">${s.gasto.count} gastos · ${delta(s.gasto.total, s.gasto.prev_total, true)}</div></div>
        ${s.ingresos ? `<div class="fin-kpi"><div class="fin-kpi-l">Ingresos (pedidos pagados)</div><div class="fin-kpi-v">${money(s.ingresos.total)}</div><div class="fin-kpi-s">${delta(s.ingresos.total, s.ingresos.prev_total, false)}</div></div>
        <div class="fin-kpi"><div class="fin-kpi-l">Ingresos − gastos</div><div class="fin-kpi-v ${s.neto < 0 ? 'fin-up' : ''}">${money(s.neto)}</div><div class="fin-kpi-s">ingresos del mes menos gasto del mes</div></div>` : ''}
        <div class="fin-kpi"><div class="fin-kpi-l">Gasto con factura</div><div class="fin-kpi-v">${s.facturas.coverage_pct === null ? '—' : s.facturas.coverage_pct + '%'}</div><div class="fin-kpi-s">${money(s.facturas.pendientes_total)} sin factura</div></div>
        <div class="fin-kpi"><div class="fin-kpi-l">IVA acreditable</div><div class="fin-kpi-v">${money(s.iva_acreditable)}</div><div class="fin-kpi-s">de gastos con factura</div></div>
      </div>
      ${attn.length ? `<div class="fin-card fin-pad" style="margin-bottom:14px"><b style="font-size:13px">Por atender</b>${attn.map(a => `<div class="fin-copy"><span>${a[0]} ${esc(a[1])}</span><button class="fin-link" data-act="goto" data-tab="${a[2]}">Abrir →</button></div>`).join('')}
        ${s.lineas_sin_vincular ? `<div class="fin-copy"><span>${s.lineas_sin_vincular} líneas sin vincular a un producto</span><button class="fin-link" data-act="unlinked">Vincular →</button></div>` : ''}</div>` : (s.lineas_sin_vincular ? `<div class="fin-card fin-pad" style="margin-bottom:14px"><div class="fin-copy"><span>${s.lineas_sin_vincular} líneas sin vincular a un producto</span><button class="fin-link" data-act="unlinked">Vincular →</button></div></div>` : '')}
      <div class="fin-card fin-pad"><div class="fin-h3" style="margin-top:0">${s.ingresos ? 'Ingresos vs gastos' : 'Gastos'}, últimos 6 meses</div>
        ${VP.chartSlot(w => VP.chart.bars(s.months.map(m => monthLabel(m.periodo)), (s.ingresos ? [{ name: 'Ingresos', color: '#3b6d11', values: s.months.map(m => m.ingresos || 0) }] : []).concat([{ name: 'Gastos', color: '#a32d2d', values: s.months.map(m => m.gasto) }]), { width: w, height: 220, fmt: VP.mxn }), 220)}
        <div class="fin-note">${s.ingresos ? '<span style="color:#3b6d11">■</span> Ingresos &nbsp; ' : ''}<span style="color:#a32d2d">■</span> Gastos</div></div>
      <div class="fin-two" style="margin-top:14px">
        <div class="fin-card fin-pad"><div class="fin-h3" style="margin-top:0">Por categoría</div>${VP.chart.rank(s.by_category.slice(0, 10).map(x => ({ label: x.name, value: x.total, sub: x.pct + '% · ' + x.count + ' gastos' })), { fmt: VP.mxn, accent: '#a32d2d' })}</div>
        <div class="fin-card fin-pad"><div class="fin-h3" style="margin-top:0">Por proveedor</div>${VP.chart.rank(s.by_vendor.map(x => ({ label: x.name, value: x.total, sub: x.pct + '% · ' + x.count + ' gastos' })), { fmt: VP.mxn, accent: '#185fa5' })}</div>
      </div>
      <div class="fin-card fin-pad" style="margin-top:14px"><div class="fin-h3" style="margin-top:0">Por tipo de gasto</div>${s.by_scope.length ? s.by_scope.map(x => `<div class="fin-copy"><span>${esc(x.name)}</span><b>${money(x.total)} <span class="fin-sub">${x.pct}%</span></b></div>`).join('') : '<div class="fin-empty">Sin gastos este mes.</div>'}</div>`;
    VP.paintCharts();
    $('r-month').onchange = e => { RES_MONTH = e.target.value || RES_MONTH; show('resumen'); };
  };
  ACT['res-prev'] = () => { RES_MONTH = shiftMonth(RES_MONTH, -1); show('resumen'); };
  ACT['res-next'] = () => { RES_MONTH = shiftMonth(RES_MONTH, 1); show('resumen'); };
  ACT.goto = el => show(el.dataset.tab);

  ACT.unlinked = async () => {
    await ensureCatalog();
    let r;
    try { r = await api('fin_unlinked_lines'); } catch (e) { fail(e); return; }
    const m = VP.showModal(`<h3 class="fin-modal-h">Líneas sin vincular (${r.count})</h3><div class="fin-note" style="margin-bottom:10px">Elige a qué producto del catálogo corresponde cada línea. La próxima vez que aparezca ese código, se sugerirá solo.</div>
      <div class="fin-card">${r.rows.length ? `<table class="fin-tbl"><tbody>${r.rows.map(l => `<tr data-line="${esc(l['Line ID'])}"><td>${fdate(l.fecha)}</td><td>${esc(l['Código Proveedor'])}<div class="fin-sub">${esc(l['Descripción'])}</div></td><td class="num">${esc(l['Cantidad'])} × ${money(l['Costo Unitario'])}</td><td><input class="vp-input" list="fin-products" data-pick placeholder="Producto…" style="min-width:180px"></td><td><button class="btn btn-sm" data-do="link">Vincular</button></td></tr>`).join('')}</tbody></table>` : '<div class="fin-empty">No hay líneas pendientes.</div>'}</div>`, { maxWidth: '900px' });
    m.el.addEventListener('click', async ev => {
      const b = ev.target.closest('[data-do="link"]'); if (!b) return;
      const tr = b.closest('tr'), p = prodByName(tr.querySelector('[data-pick]').value);
      if (!p) { VP.toast('Elige un producto de la lista.', true); return; }
      try { await post('fin_link_line', { line_id: tr.dataset.line, catalog_id: p.id }); tr.remove(); VP.toast('Vinculada'); } catch (e) { fail(e); }
    });
  };

  ACT['cost-history'] = async () => {
    await ensureCatalog();
    const m = VP.showModal(`<h3 class="fin-modal-h">Historial de costos</h3><label class="fin-field">Producto<input class="vp-input" id="ch-p" list="fin-products" placeholder="Escribe el producto…"></label><div id="ch-out" style="margin-top:12px"></div>`, { maxWidth: '760px' });
    m.el.querySelector('#ch-p').addEventListener('change', async e => {
      const p = prodByName(e.target.value); if (!p) return;
      const out = m.el.querySelector('#ch-out'); out.innerHTML = loading;
      try {
        const r = await api('fin_cost_history&catalog_id=' + encodeURIComponent(p.id));
        out.innerHTML = r.rows.length ? `<div class="fin-card"><table class="fin-tbl"><thead><tr><th>Fecha</th><th>Proveedor</th><th class="num">Cant.</th><th class="num">Costo unitario</th><th class="num">Costo por pieza</th></tr></thead><tbody>${r.rows.map(x => `<tr><td>${fdate(x.fecha)}</td><td>${esc(x.vendor)}</td><td class="num">${esc(x.cantidad)}</td><td class="num">${money(x.costo_unitario)}</td><td class="num">${money(x.costo_pieza)}</td></tr>`).join('')}</tbody></table></div>` : '<div class="fin-empty">Todavía no hay compras vinculadas a este producto.</div>';
      } catch (err) { out.innerHTML = ''; fail(err); }
    });
  };

  /* ── Gastos fijos ───────────────────────────────────────────────────────── */
  RENDER.fijos = async function () {
    const r = await api('fin_recurring_list&periodo=' + B.today.slice(0, 7));
    const c = $('fin-content');
    const open = r.expenses.filter(e => e['Captura Status'] === 'Por pagar');
    c.innerHTML = `
      <div style="display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;align-items:center">
        <div class="fin-h2" style="margin:0">Este mes (${esc(monthLabel(r.periodo))})</div>
        <span><button class="btn btn-sm" data-act="run-daily">Generar los de este mes ahora</button> <button class="btn btn-primary btn-sm" data-act="new-recurring">+ Gasto fijo</button></span></div>
      <div class="fin-note">Cada día a las 6 am se crean solos los gastos fijos que toquen, como “por pagar”. Ábrelos y márcalos pagados con el monto real.</div>
      <div class="fin-card" style="margin-top:10px">${r.expenses.length ? `<table class="fin-tbl"><tbody>${r.expenses.map(e => `<tr class="fin-row" data-act="open-expense" data-id="${esc(e['Expense ID'])}"><td>${fdate(e['Fecha Compra'])}</td><td>${esc(e['Descripción'])}</td><td>${capturaBadge(e) || badge('Pagado', 'fin-b-green')}</td><td class="num">${money(e['Total'])}</td><td>${facturaBadge(e)}</td></tr>`).join('')}</tbody></table>` : '<div class="fin-empty">Todavía no se generó nada este mes.</div>'}</div>
      ${open.length ? `<div class="fin-note">${open.length} por pagar · ${money(open.reduce((s, e) => s + num(e['Total']), 0))}</div>` : ''}
      <div class="fin-h2">Plantillas</div>
      <div class="fin-card">${r.templates.length ? `<table class="fin-tbl"><thead><tr><th>Nombre</th><th>Categoría</th><th>Frecuencia</th><th class="num">Monto est.</th><th>Activo</th><th></th></tr></thead><tbody>${r.templates.map(t => `<tr><td>${esc(t['Nombre'])}<div class="fin-sub">${esc(vendorName(t['Vendor ID']))}</div></td><td>${esc(catName(t['Category ID']))}</td><td>${esc(t['Frecuencia'])} · día ${esc(t['Día'])}</td><td class="num">${money(t['Monto Estimado'])}</td><td>${t['Activo'] === 'No' ? badge('Pausado') : badge('Sí', 'fin-b-green')}</td><td><button class="btn btn-sm" data-act="edit-recurring" data-id="${esc(t['Recurring ID'])}">Editar</button></td></tr>`).join('')}</tbody></table>` : '<div class="fin-empty">Agrega la renta, internet, suscripciones, sueldos… y se crearán solos cada mes.</div>'}</div>`;
    RENDER.fijos._t = r.templates;
  };
  ACT['run-daily'] = async () => {
    try { const r = await post('fin_run_daily', {}); VP.toast(r.created ? r.created + ' gastos fijos creados' : 'No había nada nuevo por crear' + (r.skipped.length ? ' (' + r.skipped.length + ' omitidos)' : '')); show('fijos'); } catch (e) { fail(e); }
  };
  function openRecurringForm(t) {
    t = t || {};
    const m = VP.showModal(`<h3 class="fin-modal-h">${t['Recurring ID'] ? 'Editar gasto fijo' : 'Nuevo gasto fijo'}</h3>
      <div class="fin-grid">
        <label class="fin-field fin-span2">Nombre<input class="vp-input" id="rf-n" value="${esc(t['Nombre'] || '')}" placeholder="Ej. Renta oficina"></label>
        <label class="fin-field">Categoría<select class="vp-input" id="rf-c">${catOptions(t['Category ID'])}</select></label>
        <label class="fin-field">Proveedor<select class="vp-input" id="rf-v"><option value="">—</option>${(B.vendors || []).map(v => `<option value="${esc(v['Vendor ID'])}" ${v['Vendor ID'] === t['Vendor ID'] ? 'selected' : ''}>${esc(v['Nombre'])}</option>`).join('')}</select></label>
        <label class="fin-field">Monto estimado<input class="vp-input" id="rf-m" type="number" step="0.01" value="${esc(t['Monto Estimado'] || '')}"></label>
        <label class="fin-field">Moneda<select class="vp-input" id="rf-mo">${['MXN', 'USD', 'EUR'].map(x => `<option ${x === (t['Moneda'] || 'MXN') ? 'selected' : ''}>${x}</option>`).join('')}</select></label>
        <label class="fin-field">Frecuencia<select class="vp-input" id="rf-f">${['Mensual', 'Quincenal', 'Anual'].map(x => `<option ${x === t['Frecuencia'] ? 'selected' : ''}>${x}</option>`).join('')}</select></label>
        <label class="fin-field">Día del mes<input class="vp-input" id="rf-d" type="number" min="1" max="31" value="${esc(t['Día'] || 1)}"></label>
        <label class="fin-field">Método de pago<select class="vp-input" id="rf-p">${(B.enums.metodos || []).map(x => `<option ${x === (t['Método Pago'] || 'Transferencia') ? 'selected' : ''}>${x}</option>`).join('')}</select></label>
        <label class="fin-field">Tarjeta / cuenta<input class="vp-input" id="rf-cu" value="${esc(t['Cuenta Pago'] || '')}"></label>
        <label class="fin-field">¿Dan factura?<select class="vp-input" id="rf-r"><option ${t['Requiere Factura'] !== 'No' ? 'selected' : ''}>Sí</option><option ${t['Requiere Factura'] === 'No' ? 'selected' : ''}>No</option></select></label>
        <label class="fin-field">Activo<select class="vp-input" id="rf-a"><option ${t['Activo'] !== 'No' ? 'selected' : ''}>Sí</option><option ${t['Activo'] === 'No' ? 'selected' : ''}>No</option></select></label>
        <label class="fin-field">Desde (obligatorio si es anual)<input class="vp-input" id="rf-de" type="date" value="${esc(t['Desde'] || '')}"></label>
        <label class="fin-field">Hasta<input class="vp-input" id="rf-ha" type="date" value="${esc(t['Hasta'] || '')}"></label>
      </div>
      <div id="rf-msg"></div>
      <div class="fin-actions-row"><button class="btn" id="rf-x">Cancelar</button><button class="btn btn-primary" id="rf-ok">Guardar</button></div>`, { maxWidth: '720px' });
    const q = s => m.el.querySelector(s);
    q('#rf-x').onclick = () => m.close();
    q('#rf-ok').onclick = async () => {
      try {
        await post('fin_save_recurring', { recurring: {
          recurring_id: t['Recurring ID'] || '', nombre: q('#rf-n').value, category_id: q('#rf-c').value, vendor_id: q('#rf-v').value, monto_estimado: q('#rf-m').value,
          moneda: q('#rf-mo').value, frecuencia: q('#rf-f').value, dia: q('#rf-d').value, metodo_pago: q('#rf-p').value, cuenta_pago: q('#rf-cu').value,
          requiere_factura: q('#rf-r').value, activo: q('#rf-a').value, desde: q('#rf-de').value, hasta: q('#rf-ha').value } });
        VP.toast('Guardado'); m.close(); show('fijos');
      } catch (e) { q('#rf-msg').innerHTML = `<div class="fin-msg err">${esc(e.message)}</div>`; }
    };
  }
  ACT['new-recurring'] = () => openRecurringForm({});
  ACT['edit-recurring'] = el => openRecurringForm((RENDER.fijos._t || []).find(t => t['Recurring ID'] === el.dataset.id));

  /* ── Cierre + exportar ──────────────────────────────────────────────────── */
  let CL_MONTH = '';
  RENDER.cierre = async function () {
    if (!CL_MONTH) CL_MONTH = shiftMonth(B.today.slice(0, 7), -1);
    const c = $('fin-content');
    let html = `<div class="fin-filters"><button class="btn btn-sm" data-act="cl-prev">‹</button><input class="vp-input" type="month" id="cl-month" value="${esc(CL_MONTH)}"><button class="btn btn-sm" data-act="cl-next">›</button></div>`;
    let chk = null;
    if (can('finance.month_close')) {
      chk = await api('fin_close_check&periodo=' + CL_MONTH);
      const item = (n, text, tab) => `<div class="fin-copy"><span>${n ? '⚠️' : '✅'} ${n} ${esc(text)}</span>${n && tab ? `<button class="fin-link" data-act="goto" data-tab="${tab}">Abrir →</button>` : ''}</div>`;
      html += `<div class="fin-card fin-pad"><div style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap"><b>${esc(monthLabel(CL_MONTH))} · ${chk.closed ? badge('Cerrado', 'fin-b-green') : badge('Abierto', 'fin-b-amber')}</b>
          ${chk.closed ? '<button class="btn btn-sm" data-act="reopen-month">Reabrir mes</button>' : '<button class="btn btn-primary btn-sm" data-act="close-month">Cerrar mes</button>'}</div>
        <div class="fin-note">Al cerrar un mes nadie puede crear, editar ni anular gastos de ese mes hasta que un admin lo reabra.</div>
        ${item(chk.por_capturar, 'tickets por capturar', 'bandeja')}${item(chk.facturas_pendientes, 'facturas pendientes (' + chk.facturas_vencidas + ' vencidas)', 'facturas')}
        ${item(chk.por_pagar, 'gastos fijos por pagar', 'fijos')}${item(chk.reembolsos_pendientes, 'reembolsos pendientes', 'caja')}
        ${item(chk.lineas_sin_vincular, 'líneas sin vincular a un producto', '')}${item(chk.sin_revisar, 'gastos sin marcar como revisados', 'gastos')}</div>`;
    }
    if (can('finance.export')) {
      html += `<div class="fin-h2">Exportar para el contador</div><div class="fin-card fin-pad">
        <div class="fin-note" style="margin-top:0">Descarga los gastos de ${esc(monthLabel(CL_MONTH))} en CSV (Excel lo abre directo) y, aparte, un ZIP con los XML y PDF de las facturas.</div>
        <div class="fin-actions-row" style="justify-content:flex-start"><button class="btn btn-primary btn-sm" data-act="export-csv">Descargar CSV (gastos y líneas)</button>
        <button class="btn btn-sm" data-act="export-zip">Descargar ZIP de facturas</button><label class="fin-check"><input type="checkbox" id="ex-tickets"> incluir fotos de tickets</label></div></div>`;
    }
    c.innerHTML = html;
    $('cl-month').onchange = e => { CL_MONTH = e.target.value || CL_MONTH; show('cierre'); };
    RENDER.cierre._chk = chk;
  };
  ACT['cl-prev'] = () => { CL_MONTH = shiftMonth(CL_MONTH, -1); show('cierre'); };
  ACT['cl-next'] = () => { CL_MONTH = shiftMonth(CL_MONTH, 1); show('cierre'); };
  ACT['close-month'] = async () => {
    const k = RENDER.cierre._chk || {};
    const pend = (k.por_capturar || 0) + (k.facturas_pendientes || 0) + (k.por_pagar || 0) + (k.reembolsos_pendientes || 0);
    const ok = await ask('¿Cerrar ' + monthLabel(CL_MONTH) + '?', pend ? `<div class="fin-msg warn">Todavía hay ${pend} pendientes en este mes. Puedes cerrarlo igual y reabrirlo si hace falta.</div>` : '<p style="margin:0">Todo en orden. Después de cerrar nadie podrá modificar ese mes.</p>', [{ label: 'Cancelar', value: false }, { label: 'Cerrar mes', value: true, primary: true }]);
    if (!ok) return;
    try { const r = await post('fin_close_month', { periodo: CL_MONTH }); B.closed_periods = r.closed_periods; VP.toast('Mes cerrado'); show('cierre'); } catch (e) { fail(e); }
  };
  ACT['reopen-month'] = async () => {
    const ok = await ask('¿Reabrir ' + monthLabel(CL_MONTH) + '?', '<p style="margin:0">Se podrán editar gastos de ese mes otra vez.</p>', [{ label: 'Cancelar', value: false }, { label: 'Reabrir', value: true, primary: true }]);
    if (!ok) return;
    try { const r = await post('fin_reopen_month', { periodo: CL_MONTH }); B.closed_periods = r.closed_periods; VP.toast('Mes reabierto'); show('cierre'); } catch (e) { fail(e); }
  };
  ACT['export-csv'] = async () => {
    const ov = busy('Preparando…');
    try { const r = await api('fin_export_month&periodo=' + CL_MONTH); r.files.forEach(f => downloadB64(f.name, f.mime, f.data)); VP.toast(r.expenses + ' gastos exportados'); } catch (e) { fail(e); }
    ov.done();
  };
  ACT['export-zip'] = async () => {
    const ov = busy('Armando el ZIP…');
    try { const r = await api('fin_export_zip&' + qsOf({ periodo: CL_MONTH, include_tickets: $('ex-tickets') && $('ex-tickets').checked })); downloadB64(r.name, r.mime, r.data); VP.toast(r.files + ' archivos'); } catch (e) { fail(e); }
    ov.done();
  };

  /* ── Configuración (admins only) ────────────────────────────────────────── */
  const TIPOS = ['COGS', 'Operativo', 'Envíos', 'Marketing', 'Software', 'Renta', 'Servicios', 'Nómina', 'Honorarios', 'Comisiones', 'Impuestos', 'Financiero', 'Retiro socio'];

  RENDER.config = async function () {
    const cfg = B.config || {};
    const c = $('fin-content');
    const cats = (B.categories || []).slice().sort((a, b) => Number(a['Orden']) - Number(b['Orden']));
    c.innerHTML = `
      <div class="fin-h2">Datos fiscales de la empresa</div>
      <div class="fin-card fin-pad"><div class="fin-note" style="margin-top:0">Se usan para pedir facturas (con botones de copiar) y para revisar que cada factura venga a nuestro RFC.</div>
        <div class="fin-grid" style="margin-top:10px">
          <label class="fin-field fin-span2">Razón social<input class="vp-input" id="cf-razon_social" value="${esc(cfg.razon_social || '')}"></label>
          <label class="fin-field">RFC<input class="vp-input" id="cf-rfc" value="${esc(cfg.rfc || '')}"></label>
          <label class="fin-field">Régimen fiscal<input class="vp-input" id="cf-regimen_fiscal" value="${esc(cfg.regimen_fiscal || '')}" placeholder="Ej. 612"></label>
          <label class="fin-field">Código postal fiscal<input class="vp-input" id="cf-codigo_postal" value="${esc(cfg.codigo_postal || '')}"></label>
          <label class="fin-field">Uso de CFDI<input class="vp-input" id="cf-uso_cfdi" value="${esc(cfg.uso_cfdi || 'G03')}"></label>
          <label class="fin-field fin-span2">Correo para recibir facturas<input class="vp-input" id="cf-email_factura" value="${esc(cfg.email_factura || '')}"></label>
          <label class="fin-field">Aviso de efectivo desde (MXN)<input class="vp-input" id="cf-cash_limit" type="number" value="${esc(cfg.cash_limit || 2000)}"></label>
          <label class="fin-field">Avisar facturas que vencen en (días)<input class="vp-input" id="cf-invoice_alert_days" type="number" value="${esc(cfg.invoice_alert_days || 3)}"></label>
          <label class="fin-field">Tope mensual de IA (USD)<input class="vp-input" id="cf-ai_monthly_cap_usd" type="number" step="0.5" value="${esc(cfg.ai_monthly_cap_usd || 5)}"></label>
        </div><div class="fin-actions-row"><button class="btn btn-primary btn-sm" id="cf-save">Guardar datos</button></div></div>

      <div style="display:flex;justify-content:space-between;align-items:center;margin-top:22px"><div class="fin-h2" style="margin:0">Categorías</div><button class="btn btn-sm" data-act="new-cat">+ Categoría</button></div>
      <div class="fin-note">El <b>alcance</b> decide quién la ve: <b>operativo</b> (compras del día a día), <b>fijo</b> (renta, suscripciones), <b>nomina</b> y <b>confidencial</b> (impuestos, comisiones, retiros). Cambiar el alcance solo afecta gastos nuevos.</div>
      <div class="fin-card" style="margin-top:10px"><table class="fin-tbl"><thead><tr><th>Nombre</th><th>Alcance</th><th>Tipo contable</th><th>Deducible</th><th>Activa</th><th></th></tr></thead><tbody>
        ${cats.map(k => `<tr><td>${esc(k['Nombre'])}</td><td>${badge(k['Scope'], k['Scope'] === 'operativo' ? 'fin-b-green' : k['Scope'] === 'fijo' ? 'fin-b-blue' : 'fin-b-purple')}</td><td>${esc(k['Tipo Contable'])}</td><td>${esc(k['Deducible Default'])}</td><td>${k['Activa'] === 'Sí' ? 'Sí' : badge('No')}</td><td><button class="btn btn-sm" data-act="edit-cat" data-id="${esc(k['Category ID'])}">Editar</button></td></tr>`).join('')}
      </tbody></table></div>

      <div class="fin-h2">Permisos del personal</div>
      <div class="fin-note" style="margin-top:-4px;margin-bottom:10px">Cada interruptor se aplica de inmediato en el servidor. Los administradores siempre tienen todo.</div>
      <div id="cf-perms">${loading}</div>

      <div class="fin-h2">Lectura de tickets con IA</div>
      <div class="fin-card fin-pad" id="cf-ai">${loading}</div>

      <div class="fin-h2">Herramientas</div>
      <div class="fin-card fin-pad"><div class="fin-actions-row" style="justify-content:flex-start;margin:0">
        <button class="btn btn-sm" data-act="open-sheet">Abrir la hoja de Finanzas</button>
        <button class="btn btn-sm" data-act="repair">Reparar estructura</button>
        <button class="btn btn-sm" data-act="run-daily">Generar gastos fijos ahora</button></div>
        <div class="fin-note">Versión ${esc(B.version)}. “Reparar estructura” recrea pestañas o columnas que falten y nunca borra datos.</div></div>`;
    $('cf-save').onclick = async () => {
      const config = {};
      ['razon_social', 'rfc', 'regimen_fiscal', 'codigo_postal', 'uso_cfdi', 'email_factura', 'cash_limit', 'invoice_alert_days', 'ai_monthly_cap_usd'].forEach(k => { config[k] = val('cf-' + k); });
      try { const r = await post('fin_config_save', { config: config }); B.config = Object.assign({}, B.config, r.config); VP.toast('Datos guardados'); } catch (e) { fail(e); }
    };
    renderPerms($('cf-perms')).catch(e => { $('cf-perms').innerHTML = `<div class="fin-empty">${esc(e.message)}</div>`; });
    renderAiPanel($('cf-ai')).catch(e => { $('cf-ai').innerHTML = `<div class="fin-note">${esc(e.message)}</div>`; });
  };

  async function renderPerms(box) {
    const r = await api('fin_caps_get');
    if (!r.users.length) { box.innerHTML = '<div class="fin-card fin-empty">No hay personal con rol “staff” registrado.</div>'; return; }
    const groups = Array.from(new Set(r.defs.map(d => d.group)));
    box.innerHTML = r.users.map(u => `<div class="fin-card fin-pad" data-user="${esc(u.name)}">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap"><b style="font-size:15px">${esc(u.name)}</b>${u.has_override ? badge('Personalizado', 'fin-b-blue') : badge('Valores por defecto')}</div>
      ${groups.map(g => `<div class="fin-perm-group">${esc(g)}</div>${r.defs.filter(d => d.group === g).map(d => {
        const v = u.effective[d.key];
        let ctl = '';
        if (d.type === 'bool') ctl = `<input type="checkbox" data-key="${esc(d.key)}" ${v === true ? 'checked' : ''}>`;
        else if (d.type === 'days') ctl = `<input class="vp-input" type="number" min="0" data-key="${esc(d.key)}" value="${esc(v || 0)}" style="width:80px">`;
        else ctl = `<span class="fin-scopes">${r.scopes.map(s => `<label class="fin-check"><input type="checkbox" data-key="${esc(d.key)}" data-scope="${s}" ${(v || []).indexOf(s) >= 0 ? 'checked' : ''}> ${s}</label>`).join('')}</span>`;
        return `<div class="fin-perm-row"><span>${esc(d.label)}</span>${ctl}</div>`;
      }).join('')}`).join('')}
      <div class="fin-actions-row"><button class="btn btn-sm" data-act="perm-reset" data-u="${esc(u.name)}">Volver a valores por defecto</button><button class="btn btn-primary btn-sm" data-act="perm-save" data-u="${esc(u.name)}">Guardar permisos de ${esc(u.name)}</button></div></div>`).join('<div style="height:12px"></div>');
  }
  ACT['perm-save'] = async el => {
    const card = document.querySelector(`[data-user="${el.dataset.u}"]`), caps = {};
    card.querySelectorAll('[data-key]').forEach(i => {
      const k = i.dataset.key;
      if (i.dataset.scope) { caps[k] = caps[k] || []; if (i.checked) caps[k].push(i.dataset.scope); }
      else if (i.type === 'checkbox') caps[k] = i.checked;
      else caps[k] = Number(i.value) || 0;
    });
    try { await post('fin_caps_set', { name: el.dataset.u, caps: caps }); VP.toast('Permisos guardados. Aplican desde ya.'); show('config'); } catch (e) { fail(e); }
  };
  ACT['perm-reset'] = async el => {
    const ok = await ask('¿Volver a los valores por defecto?', `<p style="margin:0">Los permisos de ${esc(el.dataset.u)} vuelven a lo que dice el código (permisos.gs).</p>`, [{ label: 'Cancelar', value: false }, { label: 'Volver', value: true, primary: true }]);
    if (!ok) return;
    try { await post('fin_caps_set', { name: el.dataset.u, reset: true }); VP.toast('Restablecido'); show('config'); } catch (e) { fail(e); }
  };

  async function renderAiPanel(box) {
    const s = await api('fin_ai_status');
    box.innerHTML = `<div class="fin-msg ${s.ready ? 'ok' : 'info'}" style="margin-top:0">${s.ready ? 'Activa.' : 'Todavía no está activada.'} Modelo: ${esc(s.model)} · gasto del mes: US$${Number(s.month_spend_usd).toFixed(4)} de US$${s.cap_usd}</div>
      <div class="fin-note">${s.ready ? 'Para quien tenga el permiso “Leer tickets con IA” aparece un botón ✨ en el formulario del gasto: llena los campos y tú revisas antes de guardar. Nunca guarda nada sola.' :
        'Para activarla: en Apps Script → Configuración del proyecto → Propiedades del script, agrega <b>FIN_GEMINI_KEY</b> (gratis, aistudio.google.com) o <b>FIN_ANTHROPIC_KEY</b> (Claude). Después ejecuta <b>finAiSelfTest</b> una vez para comprobarla, y dale el permiso a quien lo vaya a usar.'}</div>`;
  }

  function openCatForm(k) {
    k = k || {};
    const m = VP.showModal(`<h3 class="fin-modal-h">${k['Category ID'] ? 'Editar categoría' : 'Nueva categoría'}</h3>
      <div class="fin-grid">
        <label class="fin-field fin-span2">Nombre<input class="vp-input" id="ct-n" value="${esc(k['Nombre'] || '')}"></label>
        <label class="fin-field">Alcance<select class="vp-input" id="ct-s">${(B.enums.scopes || []).map(s => `<option ${s === (k['Scope'] || 'operativo') ? 'selected' : ''}>${s}</option>`).join('')}</select></label>
        <label class="fin-field">Tipo contable<select class="vp-input" id="ct-t">${TIPOS.map(t => `<option ${t === (k['Tipo Contable'] || 'Operativo') ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
        <label class="fin-field">Deducible por defecto<select class="vp-input" id="ct-d">${['Sí', 'No', 'Revisar'].map(t => `<option ${t === (k['Deducible Default'] || 'Sí') ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
        <label class="fin-field">Activa<select class="vp-input" id="ct-a"><option ${k['Activa'] !== 'No' ? 'selected' : ''}>Sí</option><option ${k['Activa'] === 'No' ? 'selected' : ''}>No</option></select></label>
        <label class="fin-field">Orden<input class="vp-input" id="ct-o" type="number" value="${esc(k['Orden'] || 99)}"></label>
      </div><div id="ct-msg"></div>
      <div class="fin-actions-row"><button class="btn" id="ct-x">Cancelar</button><button class="btn btn-primary" id="ct-ok">Guardar</button></div>`, { maxWidth: '620px' });
    const q = s => m.el.querySelector(s);
    q('#ct-x').onclick = () => m.close();
    q('#ct-ok').onclick = async () => {
      try {
        await post('fin_save_category', { category: { category_id: k['Category ID'] || '', nombre: q('#ct-n').value, scope: q('#ct-s').value, tipo_contable: q('#ct-t').value, deducible_default: q('#ct-d').value, activa: q('#ct-a').value, orden: q('#ct-o').value } });
        await reloadBoot(); VP.toast('Categoría guardada'); m.close(); show('config');
      } catch (e) { q('#ct-msg').innerHTML = `<div class="fin-msg err">${esc(e.message)}</div>`; }
    };
  }
  ACT['new-cat'] = () => openCatForm({});
  ACT['edit-cat'] = el => openCatForm(MAPS.cats[el.dataset.id]);
  ACT['open-sheet'] = async () => { try { const r = await post('fin_setup', {}); window.open(r.sheet_url, '_blank'); } catch (e) { fail(e); } };
  ACT.repair = async () => {
    const ov = busy('Revisando estructura…');
    try { await post('fin_setup', {}); await reloadBoot(); VP.toast('Estructura revisada'); } catch (e) { fail(e); }
    ov.done();
  };

  /* ── first-time setup gate ──────────────────────────────────────────────── */
  function renderGate() {
    $('fin-content').innerHTML = '';
    $('fin-gate').innerHTML = B.can_setup
      ? `<div class="fin-card fin-pad"><div class="fin-h2" style="margin-top:0">Falta crear la hoja de Finanzas</div>
          <p style="margin:0 0 12px;font-size:13.5px;line-height:1.5">Se creará una hoja de cálculo nueva (“Vel Papier - Finanzas”), una carpeta privada en Drive para fotos y facturas, las categorías iniciales y la tarea diaria de gastos fijos. Es seguro y solo se hace una vez.</p>
          <button class="btn btn-primary" id="gate-go">Crear hoja de Finanzas</button><div id="gate-msg"></div></div>`
      : '<div class="fin-card fin-pad"><div class="fin-h2" style="margin-top:0">Finanzas todavía no está lista</div><p style="margin:0;font-size:13.5px">Avisa a un administrador para que la configure y vuelve a abrir esta página.</p></div>';
    const go = $('gate-go');
    if (go) go.onclick = async () => {
      go.disabled = true; go.textContent = 'Creando… (puede tardar un minuto)';
      try {
        const r = await post('fin_setup', {});
        $('gate-msg').innerHTML = `<div class="fin-msg ok">Listo. <a class="fin-link" href="${esc(r.sheet_url)}" target="_blank" rel="noopener">Abrir la hoja ↗</a> · recargando…</div>`;
        setTimeout(() => window.location.reload(), 1800);
      } catch (e) { go.disabled = false; $('gate-msg').innerHTML = `<div class="fin-msg err">${esc(e.message)}</div>`; }
    };
  }

  /* ── wiring + start ─────────────────────────────────────────────────────── */
  document.addEventListener('click', ev => {
    const tab = ev.target.closest('#fin-tabs [data-tab]');
    if (tab) { if (tab.dataset.tab === TAB) CACHE.clear(); show(tab.dataset.tab); return; }
    const el = ev.target.closest('[data-act]');
    if (!el || !ACT[el.dataset.act]) return;
    Promise.resolve(ACT[el.dataset.act](el, ev)).catch(fail);
  });
  $('fin-cam').addEventListener('change', e => handleFiles(e.target.files));
  $('fin-pick').addEventListener('change', e => handleFiles(e.target.files));
  window.addEventListener('resize', () => { if (TAB === 'resumen') VP.paintCharts(); });

  (async function init() {
    try {
      await VP.ensureToken();
      VP.requirePage('finanzas');   // redirects staff who lack the 'finanzas' entry (the server grants it only when finance.view is on)
      VP.mountNav('finanzas');
      B = await api('fin_bootstrap');
      if (!B.setup) { renderGate(); return; }
      rebuildMaps();
      $('fin-sub').textContent = isAdmin() ? 'Vista de administración' : 'Gastos, tickets y facturas';
      const tabs = buildTabs();
      const saved = localStorage.getItem('vp_fin_tab');
      show(tabs.some(t => t.id === saved) ? saved : tabs[0].id);
      refreshInboxCount();
    } catch (e) {
      console.error(e);
      $('fin-content').innerHTML = `<div class="fin-card fin-empty">${esc(e.message || 'No se pudo cargar Finanzas.')}</div>`;
    }
  })();

})();
