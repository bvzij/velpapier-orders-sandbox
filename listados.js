// listados.js — Productos page: product listings editor, AI assistant,
// TikTok / Shopify export, TikTok templates and settings. Admin-only.
//
// Backend: products.gs (actions prod_*). Exporters: exportadores.js (VPExport).
// The "Fotos" tab (catalog photo boxes) is still productos.js, untouched.
//
// Data shape of a listing: see prodListingOut_() in products.gs.
window.vpListados = (function () {
  'use strict';

  const FILES_API = 'https://files.srv2017849.hstgr.cloud';   // vp-files container (Archivos); photo picker only
  const IMG_MAX = 1200;        // px — TikTok accepts 100..1200 px; resized here before upload
  const IMG_QUALITY = 0.9;

  const esc = s => VP.esc(s == null ? '' : s);
  const toast = (m, e) => VP.toast(m, !!e);
  const num = v => (v === '' || v == null || isNaN(Number(v))) ? '' : Number(v);
  const clone = o => JSON.parse(JSON.stringify(o));

  let boot = null;                 // prod_bootstrap response
  let selected = new Set();
  let draft = null;                // listing being edited
  let dirty = false;
  let saving = false;
  let aiBusy = '';
  let aiUndo = null;
  let catalogParents = null;       // lazy, from catalog_list
  const imgDims = {};              // url -> {w,h} (for pre-flight)
  let viewMode = localStorage.getItem('vp_prod_view') || 'tiktok';   // 'tiktok' | 'shopify' | 'ambos' -- which fields are SHOWN; never affects what's stored or what export checks

  // Vel Papier's two brand colors for the platform pills, used both in the
  // pill badges and the field-visibility toggle at the top of the editor.
  const PLATFORM_COLORS = {
    shopify: { text: '#4A6B24', bg: '#ECF3E0', label: 'Shopify' },
    tiktok: { text: '#3B5FA0', bg: '#E9F1FA', label: 'TikTok' },
  };
  // Spanish labels for TikTok's own property-field names (the ones that
  // actually show -- see the TikTok card render for why others are hidden).
  // Keys stay the raw product_property/NNNNNN TikTok uses; add more here as
  // new categories bring in fields not covered yet. Anything missing falls
  // back to TikTok's English label.
  const PROP_LABEL_ES = {
    'product_property/100107': 'Tipo de garantía',
    'product_property/101476': 'Período de garantía',
    'product_property/100149': 'País de origen',
    'product_property/102254': 'Producto importado',
    'product_property/100115': 'Condición del producto',
  };
  function translateBtn_(fieldKey, fieldLabel, value) {
    const onclick = 'vpListados.translateAttribute(' + JSON.stringify(fieldKey) + ',' + JSON.stringify(fieldLabel) + ',' + JSON.stringify(value) + ')';
    return '<button type="button" class="ls-mini ls-translate-btn" onclick="' + esc(onclick).replace(/"/g, '&quot;') + '">Traducir «' + esc(value) + '»</button>';
  }
  // Shows the badge(s) relevant to a field, filtered by what's actually
  // visible right now -- a 'both' field only shows the TikTok pill while in
  // TikTok view (and vice versa in Shopify view), so the badges never claim
  // relevance for a platform whose own fields are currently hidden. In Ambos
  // view a 'both' field shows both pills, since both really do apply.
  function platformPill(p) {
    const show = p === 'both' ? (viewMode === 'ambos' ? ['tiktok', 'shopify'] : [viewMode]) : [p];
    return show.map(k => {
      const c = PLATFORM_COLORS[k];
      return c ? '<span class="ls-pf-pill" style="color:' + c.text + ';background:' + c.bg + '">' + c.label + '</span>' : '';
    }).join('');
  }
  // Whether a field tagged `p` ('tiktok' | 'shopify' | 'both') should render
  // in the current viewMode. 'both'-tagged fields always show (they're the
  // shared facts: title, photos, price, SKU...).
  function platformVisible(p) {
    if (!p || p === 'both') return true;
    if (viewMode === 'ambos') return true;
    return p === viewMode;
  }
  function setViewMode(m) {
    viewMode = m;
    localStorage.setItem('vp_prod_view', m);
    if (draft) renderEditor();
  }

  // ── Tabs ─────────────────────────────────────────────────────────────────
  function tab(name) {
    document.querySelectorAll('[data-pr-tab]').forEach(b => b.classList.toggle('active', b.dataset.prTab === name));
    document.querySelectorAll('[data-pr-panel]').forEach(p => { p.style.display = p.dataset.prPanel === name ? '' : 'none'; });
    try { history.replaceState(null, '', '#' + name); } catch (e) { /* ignore */ }
    if (name === 'plantillas') renderTemplates();
    if (name === 'ajustes') renderSettings();
  }

  // ── Loading ──────────────────────────────────────────────────────────────
  async function load() {
    const list = document.getElementById('ls-list');
    try {
      boot = await VP.get('action=prod_bootstrap');
      renderList();
      const h = (location.hash || '').replace('#', '');
      if (h === 'plantillas' || h === 'ajustes') { renderTemplates(); renderSettings(); }
      // Handoff from Archivos "Crear producto con fotos seleccionadas".
      if (new URLSearchParams(location.search).get('from_archivos') === '1') {
        const raw = sessionStorage.getItem('vp_prod_from_archivos');
        sessionStorage.removeItem('vp_prod_from_archivos');
        try { history.replaceState(null, '', 'productos.html'); } catch (e) { /* ignore */ }
        if (raw) { try { open(null, JSON.parse(raw)); } catch (e) { /* bad payload, ignore */ } }
      }
    } catch (e) {
      if (list) list.innerHTML = '<div class="pr-empty-state">No se pudo cargar: ' + esc(e.message || e) + '<br><br>' +
        '<span style="font-size:12px">Si dice «Acción desconocida», falta pegar <b>products.gs</b> en Apps Script y publicar.</span></div>';
      // TROUBLESHOOT: "Acción desconocida: prod_bootstrap" -> products.gs is missing or the deployment was not updated.
    }
  }

  function templateById(id) { return (boot.templates || []).find(t => t.template_id === id) || null; }
  function activeTemplates() { return (boot.templates || []).filter(t => t.active && t.platform === 'tiktok'); }
  // ── List view ────────────────────────────────────────────────────────────
  function renderList() {
    const el = document.getElementById('ls-list');
    if (!el || !boot) return;
    const q = (document.getElementById('ls-search').value || '').trim().toLowerCase();
    const st = document.getElementById('ls-status').value;
    let rows = boot.listings.slice();
    rows = rows.filter(l => st === 'activos' ? l.status !== 'Archivado' : (st === 'todos' ? true : l.status === st));
    if (q) rows = rows.filter(l => [l.title, l.listing_id, l.parent_id, l.key_features].concat((l.variants || []).map(v => v.sku + ' ' + v.option1)).join(' ').toLowerCase().indexOf(q) >= 0);
    rows.sort((a, b) => String(b.updated).localeCompare(String(a.updated)));
    document.getElementById('ls-stat').textContent = rows.length + ' producto' + (rows.length !== 1 ? 's' : '');
    if (!boot.listings.length) {
      el.innerHTML = '<div class="pr-empty-state"><div style="font-size:15px;font-weight:600;margin-bottom:6px">Todavía no hay productos aquí</div>' +
        'Toca <b>+ Nuevo producto</b> para crear el primero, o vincula uno del catálogo.' +
        (activeTemplates().length ? '' : '<br><br>Antes de exportar a TikTok, sube al menos una plantilla en la pestaña <b>Plantillas</b>.') + '</div>';
    } else if (!rows.length) {
      el.innerHTML = '<div class="pr-empty-state">Sin resultados</div>';
    } else {
      el.innerHTML = rows.map(l => {
        const pf = preflight(l, 'tiktok');
        const img = (l.images && l.images[0]) ? (l.images[0].thumb || l.images[0].full) : '';
        const t = templateById(l.template_id);
        const dot = pf.errors.length ? '<span class="ls-dot ls-dot--red" title="' + esc(pf.errors.join(' · ')) + '">' + pf.errors.length + '</span>'
          : (pf.warnings.length ? '<span class="ls-dot ls-dot--amber" title="' + esc(pf.warnings.join(' · ')) + '">' + pf.warnings.length + '</span>' : '<span class="ls-dot ls-dot--green" title="Listo para exportar">✓</span>');
        return '<div class="ls-row' + (selected.has(l.listing_id) ? ' is-selected' : '') + '">' +
          '<input type="checkbox" class="ls-check" data-sel="' + esc(l.listing_id) + '"' + (selected.has(l.listing_id) ? ' checked' : '') + '>' +
          '<div class="ls-thumb" onclick="vpListados.open(\'' + esc(l.listing_id) + '\')">' + (img ? '<img src="' + esc(img) + '" alt="" loading="lazy">' : '<span>sin foto</span>') + '</div>' +
          '<div class="ls-main" onclick="vpListados.open(\'' + esc(l.listing_id) + '\')">' +
            '<div class="ls-title">' + esc(l.title || '(sin título)') + '</div>' +
            '<div class="ls-sub">' + esc(l.listing_id) + (l.parent_id ? ' · ' + esc(l.parent_id) : '') + ' · ' + (l.variants || []).length + ' variante' + ((l.variants || []).length !== 1 ? 's' : '') +
              (t ? ' · ' + esc(t.name) : ' · <span style="color:var(--amber-text)">sin plantilla TikTok</span>') +
              (l.last_export_tiktok ? ' · TikTok ' + esc(VP.fmtDate(l.last_export_tiktok)) : '') + (l.last_export_shopify ? ' · Shopify ' + esc(VP.fmtDate(l.last_export_shopify)) : '') + '</div>' +
          '</div>' + dot +
          '<span class="status-pill ls-pill ls-pill--' + esc(l.status) + '">' + esc(l.status) + '</span>' +
          '<span class="ls-when">' + esc(l.updated ? VP.fmtRel(l.updated) : '') + '</span>' +
          '</div>';
      }).join('');
    }
    renderSelBar();
  }

  function renderSelBar() {
    const n = selected.size;
    const bar = document.getElementById('ls-selbar');
    if (!bar) return;
    bar.style.display = n ? '' : 'none';
    document.getElementById('ls-seltext').textContent = n + ' seleccionado' + (n !== 1 ? 's' : '');
  }

  function toggleSel(id, on) { if (on) selected.add(id); else selected.delete(id); renderList(); }
  function selectAllVisible() {
    document.querySelectorAll('#ls-list [data-sel]').forEach(c => selected.add(c.dataset.sel));
    renderList();
  }
  function clearSel() { selected.clear(); renderList(); }

  // ── Pre-flight checks ────────────────────────────────────────────────────
  function preflight(l, platform) {
    const errors = [], warnings = [];
    const vs = l.variants && l.variants.length ? l.variants : [];
    const title = String(l.title || '');
    if (!title) errors.push('Falta el título');
    else if (title.length > 300) errors.push('Título de más de 300 caracteres');
    else if (title.length > 255) warnings.push('Título de más de 255 caracteres');
    if (!String(l.description || '').trim()) errors.push('Falta la descripción');
    else if (String(l.description).length < 80) warnings.push('Descripción muy corta');
    if (!(l.images || []).length) errors.push('Falta al menos una foto');
    if (!vs.length) errors.push('Falta al menos una variante con precio');
    if (platform === 'tiktok') {
      if (!l.template_id) errors.push('Elige una plantilla TikTok (categoría)');
      else if (!templateById(l.template_id)) errors.push('La plantilla TikTok ya no existe');
      if (num(l.weight_g) === '' || Number(l.weight_g) <= 0) errors.push('Falta el peso del paquete');
      if (num(l.length_cm) === '' || num(l.width_cm) === '' || num(l.height_cm) === '') warnings.push('Faltan medidas del paquete');
    }
    if (l.option1_name && l.option1_name.length > 20) errors.push('El nombre de la opción 1 pasa de 20 caracteres');
    if (l.option2_name && l.option2_name.length > 20) errors.push('El nombre de la opción 2 pasa de 20 caracteres');
    if (vs.length > 1 && !l.option1_name) errors.push('Hay varias variantes: falta el nombre de la opción (ej. Color)');
    const combos = {};
    vs.forEach((v, i) => {
      const n = 'Variante ' + (i + 1);
      if (num(v.price) === '' || Number(v.price) <= 0) errors.push(n + ': falta el precio');
      if (v.stock !== '' && v.stock != null && (!Number.isInteger(Number(v.stock)) || Number(v.stock) < 0)) errors.push(n + ': el stock debe ser un número entero');
      if (l.option1_name && !String(v.option1 || '').trim()) errors.push(n + ': falta el valor de «' + l.option1_name + '»');
      if (String(v.option1 || '').length > 50 || String(v.option2 || '').length > 50) errors.push(n + ': el valor de la opción pasa de 50 caracteres');
      const k = (v.option1 || '') + '||' + (v.option2 || '');
      if (l.option1_name && combos[k]) errors.push(n + ': combinación repetida');
      combos[k] = true;
      if (!v.sku) warnings.push(n + ': sin SKU — TikTok la puede rechazar sin un código de proveedor');
    });
    (l.images || []).forEach((im, i) => {
      const d = imgDims[im.full || im.thumb];
      if (!d || d.pending) return;
      const r = d.w / d.h;
      if (i === 0 && (r < 0.75 || r > 1.3334)) warnings.push('La foto principal debe tener proporción entre 3:4 y 4:3');
      if (d.w > 1200 || d.h > 1200) warnings.push('Foto ' + (i + 1) + ' mide más de 1200 px (TikTok)');
      if (d.w < 300 || d.h < 300) warnings.push('Foto ' + (i + 1) + ' es muy pequeña');
    });
    return { errors: errors, warnings: Array.from(new Set(warnings)) };
  }

  function measure(url) {
    if (!url || imgDims[url]) return;
    imgDims[url] = { w: 0, h: 0, pending: true };
    const im = new Image();
    im.onload = () => { imgDims[url] = { w: im.naturalWidth, h: im.naturalHeight }; if (draft) renderPreflight(); };
    im.onerror = () => { delete imgDims[url]; };
    im.src = url;
  }

  // ── Editor ───────────────────────────────────────────────────────────────
  function blankListing() {
    const s = boot.settings || {};
    const tpls = activeTemplates();
    const dims = String(s.default_dims_cm || '').split(/[x×*,\s]+/).filter(Boolean);
    return {
      listing_id: '', parent_id: '', status: 'Borrador', title: '', shopify_title: '', description: '', description_html: '',
      key_features: '', brand: s.brand_default || 'No brand', template_id: tpls.length === 1 ? tpls[0].template_id : '',
      tiktok_props: Object.assign({}, s.tiktok_defaults || {}), shopify_category: '', shopify_type: '', tags: [],
      shopify_handle: '', seo_title: '', seo_description: '', images: [], option1_name: '', option2_name: '',
      weight_g: s.default_weight_g || '', length_cm: dims[0] || '', width_cm: dims[1] || '', height_cm: dims[2] || '',
      attributes: {}, attributes_source: '', ai_model: '', ai_at: '', notes: '', variants_hint: '',
      variants: [{ catalog_id: '', option1: '', option2: '', sku: '', price: '', compare_at: '', stock: '', barcode: '', image: '', image_full: '' }],
    };
  }

  function open(id, preset) {
    const l = id ? boot.listings.find(x => x.listing_id === id) : null;
    draft = l ? clone(l) : blankListing();
    if (preset) {
      if (preset.images && preset.images.length) draft.images = preset.images.slice(0, 9);
      if (preset.option1_name) draft.option1_name = preset.option1_name;
      if (preset.variants && preset.variants.length) draft.variants = preset.variants.map(v => Object.assign({ catalog_id: '', option2: '', compare_at: '', barcode: '', image_full: '' }, v));
    }
    if (!draft.variants || !draft.variants.length) draft.variants = blankListing().variants;
    draft.variants_hint = draft.variants_hint || '';
    dirty = false; aiUndo = null;
    document.getElementById('ls-editor').style.display = '';
    document.body.style.overflow = 'hidden';
    renderEditor();
  }

  function close(force) {
    if (!force && dirty && !confirm('Tienes cambios sin guardar. ¿Salir sin guardar?')) return;
    draft = null; dirty = false;
    document.getElementById('ls-editor').style.display = 'none';
    document.body.style.overflow = '';
    renderList();
  }

  function markDirty() { dirty = true; const b = document.getElementById('ls-dirty'); if (b) b.textContent = 'Cambios sin guardar'; schedulePreflight(); }
  let pfTimer = null;
  function schedulePreflight() { clearTimeout(pfTimer); pfTimer = setTimeout(renderPreflight, 250); }

  function renderPreflight() {
    const el = document.getElementById('ls-preflight');
    if (!el || !draft) return;
    const t = preflight(draft, 'tiktok');
    const items = t.errors.map(x => '<li class="pf-err">' + esc(x) + '</li>').concat(t.warnings.map(x => '<li class="pf-warn">' + esc(x) + '</li>'));
    el.innerHTML = items.length ? '<div class="pf-head">' + (t.errors.length ? '🔴 ' + t.errors.length + ' por resolver antes de exportar a TikTok' : '🟡 Se puede exportar, con ' + t.warnings.length + ' aviso(s)') + '</div><ul>' + items.join('') + '</ul>'
      : '<div class="pf-head pf-ok">✓ Listo para exportar a TikTok</div>';
    document.querySelectorAll('[data-count]').forEach(c => {
      const f = c.dataset.count, max = Number(c.dataset.max);
      const len = String(draft[f] || '').length;
      c.textContent = len + (max ? ' / ' + max : '');
      c.classList.toggle('over', !!max && len > max);
    });
  }

  // opts.platform: 'tiktok' | 'shopify' | 'both' (default) -- which pill shows
  // and whether the field is hidden by the view-mode toggle.
  // opts.required: true -- bold label + red asterisk (only meaningful on
  // 'both' fields: those are the ones that block every export if missing).
  function field(label, key, opts) {
    opts = opts || {};
    if (!platformVisible(opts.platform)) return '';
    const v = draft[key] == null ? '' : draft[key];
    const counter = (opts.max || opts.count) ? '<span class="ls-count" data-count="' + key + '" data-max="' + (opts.max || '') + '"></span>' : '';
    const input = opts.area
      ? '<textarea class="ls-input" data-f="' + key + '" rows="' + (opts.rows || 4) + '" placeholder="' + esc(opts.ph || '') + '">' + esc(v) + '</textarea>'
      : '<input class="ls-input" data-f="' + key + '" value="' + esc(v) + '" placeholder="' + esc(opts.ph || '') + '"' + (opts.type ? ' type="' + opts.type + '" inputmode="decimal"' : '') + (opts.list ? ' list="' + opts.list + '"' : '') + '>';
    const labelHtml = (opts.required ? '<b>' + esc(label) + '</b><span class="ls-req">*</span>' : esc(label));
    return '<label class="ls-field' + (opts.half ? ' ls-half' : '') + (opts.third ? ' ls-third' : '') + '"><span class="ls-label">' + labelHtml + platformPill(opts.platform || 'both') + counter + '</span>' + input + (opts.help ? '<span class="ls-help">' + opts.help + '</span>' : '') + '</label>';
  }

  // renderEditor() rebuilds the whole editor body, which otherwise makes the
  // page visibly jump on every "+ Variante" / remove / any field change that
  // triggers a re-render -- the browser keeps the same scrollTop number while
  // the content above/below it changes height. Save and restore it around
  // the rebuild so the view stays put.
  function renderEditor() {
    const scroller = document.getElementById('ls-editor');
    const savedScroll = scroller ? scroller.scrollTop : 0;
    renderEditorNow_();
    if (scroller) scroller.scrollTop = savedScroll;
  }
  function renderEditorNow_() {
    const root = document.getElementById('ls-editor-body');
    if (!root || !draft) return;
    const tpls = activeTemplates();
    const tpl = templateById(draft.template_id);
    const head = document.getElementById('ls-editor-title');
    head.textContent = draft.listing_id ? draft.listing_id + ' · ' + (draft.title || '(sin título)') : 'Nuevo producto';
    document.getElementById('ls-status-sel').value = draft.status || 'Borrador';
    document.getElementById('ls-dirty').textContent = dirty ? 'Cambios sin guardar' : '';
    document.getElementById('ls-archive-btn').style.display = draft.listing_id ? '' : 'none';
    document.getElementById('ls-archive-btn').textContent = draft.status === 'Archivado' ? 'Restaurar' : 'Archivar';

    // A. catalog link
    let linkHtml;
    if (draft.parent_id) {
      linkHtml = '<div class="ls-link">Vinculado al catálogo: <b>' + esc(draft.parent_id) + '</b>' +
        (draft.listing_id ? '' : ' <button class="ls-mini" onclick="vpListados.pickParent()">Cambiar</button> <button class="ls-mini" onclick="vpListados.unlinkParent()">Quitar</button>') + '</div>';
    } else {
      linkHtml = '<div class="ls-link">Al guardar se crea un <b>producto nuevo</b> en el catálogo. ' +
        '<button class="ls-mini" onclick="vpListados.pickParent()">Vincular a uno existente</button></div>';
    }

    // B. AI
    const aiOn = boot.ai_enabled;
    const aiHtml = '<div class="ls-card ls-ai">' +
      '<div class="ls-card-title">✨ Asistente IA <span class="ls-help" style="display:inline">' + (aiOn ? 'modelo ' + esc(boot.ai_model) : 'no configurado todavía') + '</span></div>' +
      field('Características clave — escribe todo lo que sepas del producto', 'key_features', { area: true, rows: 6,
        ph: 'Ej.: marcadores de alcohol marca Ohuhu, 24 colores, doble punta pincel + cincel, estuche de tela, tinta recargable, para ilustración y manga, colores pastel y tonos piel, para principiantes y pro, hecho en China…' }) +
      field('Variantes (una por línea, como se te ocurra)', 'variants_hint', { area: true, rows: 3, ph: 'rojo\nazul cielo\nverde menta' }) +
      '<div class="ls-ai-actions">' +
        '<button class="btn btn-primary" ' + (aiOn && !aiBusy ? '' : 'disabled') + ' onclick="vpListados.runAi(\'both\')">' + (aiBusy ? 'Generando… (hasta 40 s)' : 'Generar todo') + '</button>' +
        '<button class="btn" ' + (aiOn && !aiBusy ? '' : 'disabled') + ' onclick="vpListados.runAi(\'copy\')">Solo título, descripción y variantes</button>' +
        '<button class="btn" ' + (aiOn && !aiBusy ? '' : 'disabled') + ' onclick="vpListados.runAi(\'attributes\')">Solo atributos</button>' +
        (aiUndo ? '<button class="btn" onclick="vpListados.undoAi()">↶ Deshacer IA</button>' : '') +
      '</div>' +
      (aiOn ? '<div class="ls-help">La IA también mira las primeras 4 fotos. Revisa siempre el texto antes de exportar.</div>'
        : '<div class="ls-help">Para activarla falta la clave de Anthropic en Apps Script (ver instrucciones).</div>') +
      '</div>';

    // C. text
    const brandOpts = tpl && tpl.config.options && tpl.config.options.brand ? tpl.config.options.brand : ['No brand'];
    const textHtml = '<div class="ls-card"><div class="ls-card-title">Texto</div>' +
      field('Título', 'title', { max: 255, required: true }) +
      field('Título corto (Shopify)', 'shopify_title', { max: 70, half: true, platform: 'shopify', ph: 'Si lo dejas vacío se usa el título de arriba' }) +
      field('Marca', 'brand', { half: true, list: 'ls-brands' }) +
      '<datalist id="ls-brands">' + brandOpts.map(b => '<option value="' + esc(b) + '">').join('') + '</datalist>' +
      field('Descripción', 'description', { area: true, rows: 9, count: true, required: true, help: 'Texto plano. Para Shopify se convierte solo a HTML (párrafos y viñetas «• »).' }) +
      '</div>';

    // D. photos
    const imgs = draft.images || [];
    imgs.forEach(im => measure(im.full || im.thumb));
    const photosHtml = '<div class="ls-card"><div class="ls-card-title">Fotos <span class="ls-help" style="display:inline">' + imgs.length + ' / 9 · la primera es la principal (fondo blanco, proporción 3:4 a 4:3)</span></div>' +
      '<div class="ls-gallery">' + imgs.map((im, i) =>
        '<div class="ls-gimg">' + (i === 0 ? '<span class="ls-gmain">Principal</span>' : '') +
        '<img src="' + esc(im.thumb || im.full) + '" alt="" onclick="VP.lightbox(\'' + esc(im.full || im.thumb) + '\')">' +
        '<div class="ls-gbtns"><button title="Mover a la izquierda" onclick="vpListados.moveImg(' + i + ',-1)">◀</button>' +
        '<button title="Quitar" onclick="vpListados.removeImg(' + i + ')">✕</button>' +
        '<button title="Mover a la derecha" onclick="vpListados.moveImg(' + i + ',1)">▶</button></div></div>').join('') +
      (imgs.length < 9 ? '<label class="ls-gadd">' + (boot.images_enabled ? '<input type="file" accept="image/jpeg,image/png,image/webp" multiple onchange="vpListados.uploadImgs(this)">' : '') +
        '<span id="ls-gadd-text">' + (boot.images_enabled ? '+ Subir fotos' : 'Subida no configurada') + '</span></label>' : '') +
      '</div><div class="ls-ai-actions" style="margin-top:8px">' +
        '<button class="ls-mini" onclick="vpListados.pasteImg()">Pegar enlace de foto</button>' +
        '<button class="ls-mini" onclick="vpListados.pickFromArchivos()">Elegir de Archivos</button>' +
        (draft.parent_id ? '<button class="ls-mini" onclick="vpListados.useCatalogPhotos()">Usar fotos del catálogo</button>' : '') +
      '</div></div>';

    // E. variants
    const two = !!draft.option2_name;
    const showCompareAt = platformVisible('shopify');
    const vRows = draft.variants.map((v, i) => {
      const vi = ' data-vi="' + i + '"';
      // No option 1 value typed -> this row isn't really a distinct variant
      // yet, so its photo is meaningless (there's nothing for it to be a
      // photo OF) and the upload/choose buttons are disabled, not just the
      // text fields.
      const hasVariant = !!draft.option1_name;
      const photoCell = !hasVariant
        ? '<td><div class="ls-vimg-pair" aria-disabled="true"><span class="ls-vimg-box ls-vimg-disabled">' + (v.image ? '' : '—') + '</span></div></td>'
        : '<td><div class="ls-vimg-pair">' +
            '<button type="button" class="ls-vimg-box" onclick="vpListados.uploadVariantImgPrompt(' + i + ')" title="Subir foto nueva">' + (v.image ? '<img src="' + esc(v.image) + '" alt="">' : '<span>⬆</span>') + '</button>' +
            '<button type="button" class="ls-vimg-pick" onclick="vpListados.browseVariantImg(' + i + ')" title="Elegir de Archivos">📁</button>' +
          '</div></td>';
      return '<tr>' +
        photoCell +
        '<td><input class="ls-cell" data-vf="option1"' + vi + ' value="' + esc(v.option1) + '" placeholder="' + esc(draft.option1_name || 'Sin variantes') + '"' + (hasVariant ? '' : ' disabled') + '></td>' +
        (two ? '<td><input class="ls-cell" data-vf="option2"' + vi + ' value="' + esc(v.option2) + '" placeholder="' + esc(draft.option2_name) + '"></td>' : '') +
        '<td><input class="ls-cell ls-sku" data-vf="sku"' + vi + ' value="' + esc(v.sku) + '" placeholder="código del proveedor"><span class="ls-sku-hint" data-sku-hint="' + i + '"></span></td>' +
        '<td><input class="ls-cell ls-num" data-vf="price"' + vi + ' value="' + esc(v.price) + '" inputmode="decimal" placeholder="$"></td>' +
        (showCompareAt ? '<td><input class="ls-cell ls-num" data-vf="compare_at"' + vi + ' value="' + esc(v.compare_at) + '" inputmode="decimal" placeholder="$"></td>' : '') +
        '<td><input class="ls-cell ls-num" data-vf="stock"' + vi + ' value="' + esc(v.stock) + '" inputmode="numeric"></td>' +
        '<td><input class="ls-cell" data-vf="barcode"' + vi + ' value="' + esc(v.barcode) + '" inputmode="numeric" pattern="[0-9]*" maxlength="30"></td>' +
        '<td class="ls-vord"><button class="ls-x" title="Mover arriba" ' + (i === 0 ? 'disabled' : '') + ' onclick="vpListados.moveVariant(' + i + ',-1)">▲</button>' +
        '<button class="ls-x" title="Mover abajo" ' + (i === draft.variants.length - 1 ? 'disabled' : '') + ' onclick="vpListados.moveVariant(' + i + ',1)">▼</button>' +
        '<button class="ls-x" title="Quitar variante" onclick="vpListados.removeVariant(' + i + ')">✕</button></td>' +
        '</tr>' + (v.catalog_id ? '' : '');
    }).join('');
    const variantsHtml = '<div class="ls-card"><div class="ls-card-title">Variantes</div>' +
      '<div class="ls-grid">' + field('Nombre de la opción 1', 'option1_name', { half: true, max: 20, ph: 'Ej. Color (vacío = sin variantes)' }) +
      field('Nombre de la opción 2', 'option2_name', { half: true, max: 20, ph: 'Ej. Tamaño (opcional)' }) + '</div>' +
      '<div class="ls-table-wrap"><table class="ls-table"><thead><tr><th>Foto</th><th>' + esc(draft.option1_name || 'Opción 1') + '</th>' + (two ? '<th>' + esc(draft.option2_name) + '</th>' : '') +
      '<th>SKU</th><th>Precio *</th>' + (showCompareAt ? '<th>Antes' + platformPill('shopify') + '</th>' : '') + '<th>Stock</th><th>Código de barras</th><th></th></tr></thead><tbody>' + vRows + '</tbody></table></div>' +
      '<div class="ls-ai-actions" style="margin-top:8px">' +
        '<button class="ls-mini" onclick="vpListados.addVariant()">+ Variante</button>' +
        '<button class="ls-mini" onclick="vpListados.combos()">Generar combinaciones</button>' +
        '<button class="ls-mini" onclick="vpListados.fillDown()">Copiar precio/stock de la 1ª a todas</button>' +
      '</div><div class="ls-help">El SKU es el código del proveedor, tal cual, incluso si repite el mismo código en varias variantes. Puede quedar vacío. Liga los pedidos de TikTok y Shopify con este producto.' +
      (showCompareAt ? ' «Antes» es el precio tachado que Shopify muestra junto al precio con descuento; no existe en la plantilla de TikTok.' : '') + '</div></div>';

    // F. shipping
    const shipHtml = '<div class="ls-card"><div class="ls-card-title">Paquete (para el envío)</div><div class="ls-grid">' +
      field('Peso con empaque (g)', 'weight_g', { type: 'number', third: true }) +
      field('Largo (cm)', 'length_cm', { type: 'number', third: true }) + field('Ancho (cm)', 'width_cm', { type: 'number', third: true }) +
      field('Alto (cm)', 'height_cm', { type: 'number', third: true }) + '</div>' +
      '<div class="ls-help">TikTok usa el peso y medidas de la primera variante para calcular el envío de todas.</div></div>';

    // G. TikTok -- whole card hidden in pure Shopify view.
    let propsHtml = '';
    if (tpl) {
      // Only fields with an actual dropdown list from TikTok's own template
      // are shown. A "conditionally mandatory" field with NO options (With
      // battery, Plug type, Operating system, Storage capacity, ...) is
      // TikTok's generic parent-category list leaking in -- things that only
      // apply to electronics, never actually relevant to stationery, and
      // with nothing to fill in besides free text TikTok doesn't even
      // validate. Hiding them outright instead of collapsing them avoids
      // showing fields that will never matter for what Vel Papier sells.
      const cols = (tpl.config.columns || []).filter(c => c.key.indexOf('product_property/') === 0 && (tpl.config.options || {})[c.key]);
      const propField = c => {
        const opts = (tpl.config.options || {})[c.key];
        const v = (draft.tiktok_props || {})[c.key] || '';
        // dropdown values come from TikTok's template in English; show the
        // Spanish word the first time it's been translated, English with a
        // "traducir" link the first time it's seen (see translateAttribute()).
        const dict = (boot.translations || {})[c.key] || {};
        const input = '<select class="ls-input" data-tp="' + esc(c.key) + '" data-tp-label="' + esc(c.label) + '"><option value="">\u2014</option>' +
          opts.map(o => '<option value="' + esc(o) + '"' + (o === v ? ' selected' : '') + '>' + esc(dict[o] || o) + (dict[o] ? '' : ' (sin traducir)') + '</option>').join('') + '</select>' +
          (v && !dict[v] ? translateBtn_(c.key, c.label, v) : '');
        return '<label class="ls-field ls-half"><span class="ls-label">' + esc(PROP_LABEL_ES[c.key] || c.label) + '</span>' + input + '</label>';
      };
      propsHtml = '<div class="ls-grid">' + cols.map(propField).join('') + '</div>';
    }
    const tiktokHtml = !platformVisible('tiktok') ? '' : '<div class="ls-card"><div class="ls-card-title">TikTok' + platformPill('tiktok') + '</div>' +
      '<label class="ls-field"><span class="ls-label">Categoría' + platformPill('tiktok') + '</span><select class="ls-input" data-f="template_id" data-rerender="1">' +
        '<option value="">— Elige la categoría —</option>' + tpls.map(t => '<option value="' + esc(t.template_id) + '"' + (t.template_id === draft.template_id ? ' selected' : '') + '>' + esc(t.name) + '</option>').join('') +
        (draft.template_id && !tpl ? '<option value="' + esc(draft.template_id) + '" selected>(plantilla inactiva)</option>' : '') +
      '</select>' + (tpls.length ? '' : '<span class="ls-help">No hay plantillas. Súbelas en la pestaña Plantillas.</span>') + '</label>' + propsHtml + '</div>';

    // H. Shopify -- whole card hidden outside Shopify/Ambos view, since none
    // of these fields matter for a TikTok-only product (the common case).
    const shopifyHtml = !platformVisible('shopify') ? '' : '<div class="ls-card"><div class="ls-card-title">Shopify' + platformPill('shopify') + '</div><div class="ls-grid">' +
      field('Categoría de Shopify', 'shopify_category', { half: true, ph: 'Ej. Arts & Entertainment > Hobbies & Creative Arts > Arts & Crafts' }) +
      field('Tipo', 'shopify_type', { half: true, ph: 'Ej. Marcadores' }) +
      '<label class="ls-field"><span class="ls-label">Etiquetas (separadas por coma)</span><input class="ls-input" data-tags="1" value="' + esc((draft.tags || []).join(', ')) + '"></label>' +
      field('URL (handle)', 'shopify_handle', { half: true, ph: 'se crea del título al guardar' }) +
      field('Título SEO', 'seo_title', { half: true, max: 70 }) +
      field('Descripción SEO', 'seo_description', { max: 160 }) + '</div></div>';

    // I. attributes
    const attrHtml = renderAttributes();

    // J. notes
    const notesHtml = '<div class="ls-card"><div class="ls-card-title">Notas internas</div>' + field('', 'notes', { area: true, rows: 3, ph: 'Solo para el equipo' }) + '</div>';

    const viewToggleHtml = '<div class="ls-viewtoggle">' +
      '<span class="ls-viewtoggle-label">Mostrar campos:</span>' +
      ['tiktok', 'shopify', 'ambos'].map(m => '<button type="button" class="ls-vt-btn' + (viewMode === m ? ' is-active' : '') + '" data-vt-color="' + (m === 'ambos' ? '' : m) + '" onclick="vpListados.setViewMode(\'' + m + '\')">' +
        (m === 'tiktok' ? 'TikTok' : m === 'shopify' ? 'Shopify' : 'Ambos') + '</button>').join('') +
      '</div>';
    root.innerHTML = viewToggleHtml + '<div class="ls-preflight" id="ls-preflight"></div>' + '<div class="ls-card">' + linkHtml + '</div>' +
      aiHtml + textHtml + photosHtml + variantsHtml + shipHtml + tiktokHtml + shopifyHtml + attrHtml + notesHtml +
      (draft.listing_id ? '<div class="ls-help" style="text-align:center;margin:10px 0 30px">Creado por ' + esc(draft.created_by) + ' ' + esc(draft.created ? VP.fmtDateTime(draft.created) : '') +
        ' · última edición ' + esc(draft.updated_by) + ' ' + esc(draft.updated ? VP.fmtDateTime(draft.updated) : '') + '</div>' : '');
    renderPreflight();
  }

  // Spanish labels for the attribute-schema keys (the keys themselves stay
  // English snake_case server-side, for stable analysis joins -- this is
  // purely what the editor shows). Any key missing here falls back to the
  // key with underscores turned into spaces, same as before.
  const ATTR_LABELS = {
    product_type: 'Tipo de producto', product_subtype: 'Subtipo', category_group: 'Categoría general',
    brand: 'Marca', product_line: 'Línea', medium: 'Medio/técnica', technique_uses: 'Usos/técnicas',
    tip_types: 'Tipo de punta', tip_size_mm: 'Grosor de punta (mm)', color_count: 'Cantidad de colores',
    color_families: 'Familias de color', specific_colors: 'Colores específicos', pack_quantity: 'Piezas por paquete',
    size_format: 'Formato/tamaño', dimensions_cm: 'Dimensiones (cm)', page_count: 'Número de páginas',
    paper_weight_gsm: 'Gramaje del papel', paper_type: 'Tipo de papel', binding: 'Encuadernado',
    cover_material: 'Material de la portada', material: 'Material', finish: 'Acabado',
    refillable: 'Recargable', erasable: 'Borrable', water_resistant: 'Resistente al agua',
    lightfast: 'Resistente a la luz', non_toxic: 'No tóxico', acid_free: 'Libre de ácido', blendable: 'Se puede mezclar',
    skill_level: 'Nivel', audience: 'Público', age_min: 'Edad mínima', aesthetic: 'Estética',
    themes: 'Temas', occasions: 'Ocasiones', giftable: 'Para regalo', includes: 'Qué incluye',
    country_of_origin: 'País de origen', price_positioning: 'Rango de precio', keywords: 'Palabras clave',
    extra: 'Otros rasgos',
  };
  function renderAttributes() {
    const schema = boot.attribute_schema || {};
    const a = draft.attributes || {};
    const kindOf = (k, desc) => {
      if (k === 'extra') return 'json';
      if (/^true\/false/.test(desc)) return 'bool';
      if (/^lista de números/.test(desc)) return 'numlist';
      if (/^lista/.test(desc)) return 'list';
      if (/^número/.test(desc)) return 'num';
      return 'text';
    };
    const rows = Object.keys(schema).map(k => {
      const desc = schema[k], kind = kindOf(k, desc), v = a[k];
      let input;
      if (kind === 'bool') {
        input = '<select class="ls-input" data-attr="' + k + '" data-kind="bool"><option value="">—</option><option value="true"' + (v === true ? ' selected' : '') + '>sí</option><option value="false"' + (v === false ? ' selected' : '') + '>no</option></select>';
      } else if (kind === 'json') {
        input = '<textarea class="ls-input" rows="2" data-attr="' + k + '" data-kind="json" placeholder="{&quot;clave&quot;: &quot;valor&quot;}">' + esc(v && Object.keys(v).length ? JSON.stringify(v) : '') + '</textarea>';
      } else {
        const shown = Array.isArray(v) ? v.join(', ') : (v == null ? '' : v);
        input = '<input class="ls-input" data-attr="' + k + '" data-kind="' + kind + '" value="' + esc(shown) + '" placeholder="' + esc(desc.replace(/^[^—]*—\s*/, '').slice(0, 70)) + '">';
      }
      return '<label class="ls-field ls-half"><span class="ls-label">' + esc(ATTR_LABELS[k] || k.replace(/_/g, ' ')) + '</span>' + input + '</label>';
    }).join('');
    const filled = Object.keys(a).filter(k => a[k] != null && a[k] !== '' && !(Array.isArray(a[k]) && !a[k].length)).length;
    const src = draft.attributes_source === 'ai' ? 'IA' : (draft.attributes_source === 'mixto' ? 'IA + manual' : (filled ? 'manual' : ''));
    return '<div class="ls-card"><details class="ls-details"' + (filled ? '' : '') + '><summary><b>Atributos para análisis</b> · ' + filled + ' de ' + Object.keys(schema).length + ' llenos' + (src ? ' · ' + src : '') + '</summary>' +
      '<div class="ls-help" style="margin:8px 0">Describen el producto de forma uniforme para cruzarlo después con lo que compran los clientes. Listas separadas por coma, todo en minúsculas. La IA los llena con «Solo atributos».</div>' +
      '<div class="ls-grid">' + rows + '</div></details></div>';
  }

  // ── Editor input handling (delegated) ────────────────────────────────────
  function onInput(ev) {
    if (!draft) return;
    const t = ev.target;
    if (t.dataset.f) {
      draft[t.dataset.f] = t.value;
      markDirty();
      if (t.dataset.f === 'option1_name' && !t.value.trim()) {
        // no option 1 name -> these rows aren't distinct variants, so a
        // photo on one of them no longer means anything; clear it rather
        // than leave a photo attached to a "variant" that doesn't exist.
        draft.variants.forEach(v => { v.image = ''; v.image_full = ''; });
      }
      if (t.dataset.rerender || t.dataset.f === 'option1_name' || t.dataset.f === 'option2_name') {
        if (ev.type === 'change' || t.tagName === 'SELECT') renderEditor();
      }
      return;
    }
    if (t.dataset.vf) {
      const v = draft.variants[Number(t.dataset.vi)];
      if (!v) return;
      v[t.dataset.vf] = t.dataset.vf === 'sku' ? t.value.trim().toUpperCase().replace(/\s+/g, '') : t.value;
      markDirty();
      if (t.dataset.vf === 'sku' && ev.type === 'change') skuBlurCheck(Number(t.dataset.vi), v.sku);   // on blur/tab, not every keystroke
      return;
    }
    if (t.dataset.tp) {
      draft.tiktok_props = draft.tiktok_props || {};
      draft.tiktok_props[t.dataset.tp] = t.value;
      markDirty();
      // a dropdown pick needs a re-render so the "Traducir" button can
      // appear/disappear for the newly selected value; typed text fields don't.
      if (t.tagName === 'SELECT') renderEditor();
      return;
    }
    if (t.dataset.tags) {
      draft.tags = t.value.split(',').map(s => s.trim()).filter(Boolean);
      markDirty();
      return;
    }
    if (t.dataset.attr) {
      const k = t.dataset.attr, kind = t.dataset.kind, raw = t.value;
      draft.attributes = draft.attributes || {};
      let val;
      if (kind === 'bool') val = raw === '' ? null : raw === 'true';
      else if (kind === 'num') val = raw === '' ? null : num(raw);
      else if (kind === 'list') val = raw.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
      else if (kind === 'numlist') val = raw.split(',').map(s => num(s.trim())).filter(x => x !== '');
      else if (kind === 'json') { try { val = raw.trim() ? JSON.parse(raw) : {}; t.style.borderColor = ''; } catch (e) { t.style.borderColor = 'var(--red-text)'; return; } }
      else val = raw.trim().toLowerCase() || null;
      draft.attributes[k] = val;
      if (draft.attributes_source === 'ai') draft.attributes_source = 'mixto';
      else if (!draft.attributes_source) draft.attributes_source = 'manual';
      markDirty();
    }
  }

  // Quiet "this SKU already exists" preview while editing -- the save()/
  // askSkuDecision() flow is the one that actually blocks or confirms;
  // this is just an early heads-up so it's not a surprise at save time.
  let skuCheckSeq = 0;
  async function skuBlurCheck(vi, sku) {
    const hint = document.querySelector('[data-sku-hint="' + vi + '"]');
    if (!hint) return;
    if (!sku) { hint.textContent = ''; return; }
    const mine = draft.listing_id ? (boot.listings.find(l => l.listing_id === draft.listing_id) || {}).parent_id : '';
    const myOwn = draft.variants.filter((v, i) => i !== vi).some(v => (v.sku || '').toUpperCase() === sku);
    if (myOwn || (draft.sku_links && draft.sku_links[sku])) { hint.textContent = ''; return; }   // already ours, or already resolved
    const seq = ++skuCheckSeq;
    hint.textContent = '…';
    try {
      const r = await VP.get('action=prod_sku_lookup&sku=' + encodeURIComponent(sku));
      if (seq !== skuCheckSeq) return;   // a newer check superseded this one
      if (r.found && r.parent_id !== draft.parent_id && r.parent_id !== mine) {
        hint.textContent = '⚠ ya existe en ' + r.parent_name;
        hint.title = 'Se te preguntará al guardar si es el mismo producto';
      } else {
        hint.textContent = '';
      }
    } catch (e) { hint.textContent = ''; }
  }

  // ── Variants actions ─────────────────────────────────────────────────────
  function addVariant() {
    // Blank on purpose: every variant is its own real-world item with its own
    // SKU, price and stock, so starting from the previous row's values would
    // just be a value someone forgot to change, not a shortcut.
    draft.variants.push({ catalog_id: '', option1: '', option2: '', sku: '', price: '', compare_at: '', stock: '', barcode: '', image: '', image_full: '' });
    markDirty(); renderEditor();
  }
  function moveVariant(i, d) {
    const j = i + d;
    if (j < 0 || j >= draft.variants.length) return;
    const [v] = draft.variants.splice(i, 1);
    draft.variants.splice(j, 0, v);
    markDirty(); renderEditor();
  }
  function removeVariant(i) {
    const v = draft.variants[i];
    if (draft.variants.length === 1) { toast('Debe quedar al menos una variante', true); return; }
    if (v.catalog_id && !confirm('Esta variante ya existe en el catálogo (' + v.catalog_id + '). Se quita de este producto, pero sigue en el catálogo y en los pedidos. ¿Continuar?')) return;
    draft.variants.splice(i, 1);
    markDirty(); renderEditor();
  }
  function fillDown() {
    const f = draft.variants[0];
    draft.variants.forEach(v => { v.price = f.price; v.stock = f.stock; v.compare_at = f.compare_at; });
    markDirty(); renderEditor();
  }
  function combos() {
    const m = VP.showModal('<div class="modal-title" style="margin-bottom:10px">Generar combinaciones</div>' +
      '<div class="ls-help" style="margin-bottom:8px">Un valor por línea. Se crea una variante por cada combinación (las que ya existen se conservan).</div>' +
      '<div class="ls-grid"><label class="ls-field ls-half"><span class="ls-label">' + esc(draft.option1_name || 'Opción 1') + '</span><textarea class="ls-input" rows="8" id="cb-1"></textarea></label>' +
      '<label class="ls-field ls-half"><span class="ls-label">' + esc(draft.option2_name || 'Opción 2 (opcional)') + '</span><textarea class="ls-input" rows="8" id="cb-2"></textarea></label></div>' +
      '<div style="text-align:right;margin-top:10px"><button class="btn btn-primary" id="cb-go">Crear variantes</button></div>', { maxWidth: '560px' });
    m.el.querySelector('#cb-go').onclick = () => {
      const a = m.el.querySelector('#cb-1').value.split('\n').map(s => s.trim()).filter(Boolean);
      const b = m.el.querySelector('#cb-2').value.split('\n').map(s => s.trim()).filter(Boolean);
      if (!a.length) { toast('Escribe al menos un valor en la opción 1', true); return; }
      if (!draft.option1_name) draft.option1_name = 'Color';
      if (b.length && !draft.option2_name) draft.option2_name = 'Tamaño';
      const base = draft.variants.filter(v => v.option1 || v.catalog_id);
      const proto = draft.variants[0] || {};
      const have = {};
      base.forEach(v => { have[(v.option1 || '') + '||' + (v.option2 || '')] = 1; });
      (b.length ? a.flatMap(x => b.map(y => [x, y])) : a.map(x => [x, ''])).forEach(([x, y]) => {
        if (have[x + '||' + y]) return;
        base.push({ catalog_id: '', option1: x, option2: y, sku: '', price: proto.price || '', compare_at: proto.compare_at || '', stock: proto.stock || '', barcode: '', image: '', image_full: '' });
      });
      draft.variants = base.length ? base : draft.variants;
      m.close(); markDirty(); renderEditor();
    };
  }

  // ── Photos ───────────────────────────────────────────────────────────────
  async function resizeToDataUrl(file) {
    let bmp = null, w, h, src;
    try { bmp = await createImageBitmap(file); src = bmp; w = bmp.width; h = bmp.height; }
    catch (e) {
      const url = URL.createObjectURL(file);
      src = await new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = () => rej(new Error('No se pudo leer la foto')); im.src = url; });
      w = src.naturalWidth; h = src.naturalHeight;
    }
    const s = Math.min(1, IMG_MAX / Math.max(w, h));
    const c = document.createElement('canvas');
    c.width = Math.round(w * s); c.height = Math.round(h * s);
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);   // transparent PNGs get a white background
    ctx.drawImage(src, 0, 0, c.width, c.height);
    if (bmp) try { bmp.close(); } catch (e) { /* ignore */ }
    const out = c.toDataURL('image/jpeg', IMG_QUALITY);
    c.width = c.height = 0;
    return out;
  }
  async function uploadFile(file) {
    if (!/^image\/(jpeg|png|webp)$/.test(file.type)) throw new Error('Formato no permitido (usa JPG, PNG o WEBP)');
    const dataUrl = await resizeToDataUrl(file);
    const res = await VP.post({ action: 'prod_upload_image', file_name: file.name.replace(/\.\w+$/, '') + '.jpg', file_data: dataUrl });
    return { thumb: res.thumb_url, full: res.full_url };
  }
  async function uploadImgs(input) {
    const files = Array.from(input.files || []);
    input.value = '';
    await uploadFilesInto_(files);
  }
  async function uploadVariantImg(input, i) {
    const f = input.files && input.files[0];
    input.value = '';
    if (!f) return;
    toast('Subiendo foto…');
    try { const im = await uploadFile(f); draft.variants[i].image = im.thumb; draft.variants[i].image_full = im.full; markDirty(); renderEditor(); toast('✓ Foto lista'); }
    catch (e) { toast(e.message || String(e), true); }
  }
  // The ⬆ icon on a variant row: no modal, straight to the OS file picker,
  // same as the old single-button behavior but now reachable only via its
  // own icon instead of being the row's only option.
  function uploadVariantImgPrompt(i) {
    if (!boot.images_enabled) { toast('La subida de fotos no está configurada todavía', true); return; }
    const inp = document.createElement('input');
    inp.type = 'file'; inp.accept = 'image/jpeg,image/png,image/webp';
    inp.onchange = () => uploadVariantImg(inp, i);
    inp.click();
  }
  // The 📁 icon on a variant row: straight to the Archivos browser, no
  // intermediate "upload or browse?" modal (that choice is now the two icons).
  function browseVariantImg(i) {
    browseArchivos('Elegir foto para la variante', (f, m) => {
      draft.variants[i].image = f.thumb_url;
      draft.variants[i].image_full = f.web_url || f.url;
      markDirty();
      m.close();
      renderEditor();
    });
  }
  function moveImg(i, d) {
    const j = i + d;
    if (j < 0 || j >= draft.images.length) return;
    const t = draft.images[i]; draft.images[i] = draft.images[j]; draft.images[j] = t;
    markDirty(); renderEditor();
  }
  function removeImg(i) { draft.images.splice(i, 1); markDirty(); renderEditor(); }
  function addImgUrl_(u) {
    u = String(u || '').trim();
    if (!u) return false;
    if (!/^https:\/\/\S+$/.test(u)) { toast('El enlace debe empezar con https://', true); return false; }
    if ((draft.images || []).length >= 9) { toast('Ya tienes 9 fotos', true); return false; }
    draft.images.push({ thumb: u, full: u }); markDirty(); renderEditor();
    return true;
  }
  function pasteImg() {
    addImgUrl_(prompt('Pega el enlace (https://…) de la foto:'));
  }
  // Drag-and-drop onto the "+ Subir fotos" box: an image file uploads like a
  // normal click-to-pick; a dropped/pasted URL (e.g. dragged from another
  // browser tab) is added directly, same as "Pegar enlace de foto" but
  // without the prompt.
  async function dropOnGallery_(dt) {
    if (!dt) return;
    const files = Array.from((dt.files || [])).filter(f => /^image\//.test(f.type));
    if (files.length) { await uploadFilesInto_(files); return; }
    const text = dt.getData && (dt.getData('text/uri-list') || dt.getData('text/plain'));
    if (text) addImgUrl_(text.split('\n')[0]);
  }
  async function uploadFilesInto_(files) {
    const room = 9 - (draft.images || []).length;
    files = files.slice(0, Math.max(room, 0));
    if (!files.length) { toast('Ya tienes 9 fotos', true); return; }
    const label = document.getElementById('ls-gadd-text');
    for (let i = 0; i < files.length; i++) {
      if (label) label.textContent = 'Subiendo ' + (i + 1) + ' de ' + files.length + '…';
      try { const im = await uploadFile(files[i]); draft.images.push(im); markDirty(); }
      catch (e) { toast(files[i].name + ': ' + (e.message || e), true); }
    }
    renderEditor();
  }
  async function useCatalogPhotos() {
    const parents = await loadCatalog();
    const p = parents.find(x => x.parent_id === draft.parent_id);
    if (!p) { toast('No se encontró el producto en el catálogo', true); return; }
    let added = 0;
    const have = new Set((draft.images || []).map(im => im.thumb));
    if (p.image && !have.has(p.image)) { draft.images.unshift({ thumb: p.image, full: p.full_image || p.image }); added++; }
    (p.variants || []).forEach(v => {
      const dv = draft.variants.find(x => x.catalog_id === v.catalog_id);
      if (dv && v.image && !dv.image) { dv.image = v.image; dv.image_full = v.full_image || v.image; added++; }
    });
    draft.images = draft.images.slice(0, 9);
    if (!added) toast('El catálogo no tiene fotos nuevas para este producto'); else markDirty();
    renderEditor();
  }
  async function archivosFetch_(path) {
    const r = await fetch(FILES_API + path, { headers: { Authorization: 'Bearer ' + VP.token } });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  }
  // Shared Archivos browser: folder navigation (click a folder to open it,
  // breadcrumb to go back up) plus a search box that searches site-wide once
  // 2+ characters are typed. onPick(file, modal, tileEl) decides what happens
  // when a photo tile is tapped; the modal stays open so several can be
  // picked in a row (gallery use) unless onPick itself closes it.
  async function browseArchivos(title, onPick) {
    const m = VP.showModal('<div class="modal-title" style="margin-bottom:10px">' + esc(title) + '</div>' +
      '<input class="ls-input" id="pa-q" placeholder="Buscar en todo Archivos…" style="margin-bottom:8px">' +
      '<div id="pa-crumbs" class="pa-crumbs"></div>' +
      '<div class="pa-grid" id="pa-grid"><div class="pr-empty-state">Cargando…</div></div>', { maxWidth: '760px' });
    const grid = m.el.querySelector('#pa-grid');
    const crumbs = m.el.querySelector('#pa-crumbs');
    let files = [];
    const paintFiles = list => {
      files = list;
      grid.innerHTML = list.length ? list.map((f, i) => '<button class="pa-tile" data-i="' + i + '"><img src="' + esc(f.thumb_url) + '" loading="lazy" alt=""><span>' + esc(f.name) + '</span></button>').join('')
        : '<div class="pr-empty-state">No hay fotos aquí</div>';
    };
    async function openFolder(id) {
      let data;
      try { data = await archivosFetch_('/api/list?folder=' + encodeURIComponent(id)); }
      catch (e) {
        toast('Archivos no responde todavía (¿ya se instaló vp-files en el VPS?)', true);
        // TROUBLESHOOT: the vp-files container is not running or files.srv2017849.hstgr.cloud does not resolve -> run the VPS install script.
        return;
      }
      crumbs.innerHTML = data.path.map((p, i) => i === data.path.length - 1 ? '<b>' + esc(p.name) + '</b>' : '<a href="#" data-go="' + esc(p.id) + '">' + esc(p.name) + '</a>').join(' <span class="ar-sub">/</span> ');
      const folders = (data.folders || []).filter(f => f.public);
      const imgs = (data.files || []).filter(f => f.public && f.kind === 'image');
      paintFiles(imgs);
      if (folders.length) grid.innerHTML = folders.map(f => '<button class="pa-folder" data-go="' + esc(f.id) + '">📁 ' + esc(f.name) + '</button>').join('') + grid.innerHTML;
    }
    async function doSearch(q) {
      if (q.length < 2) { openFolder('root'); return; }
      crumbs.innerHTML = '';
      let data;
      try { data = await archivosFetch_('/api/search?q=' + encodeURIComponent(q)); } catch (e) { return; }
      paintFiles((data.files || []).filter(f => f.public && f.kind === 'image'));
    }
    let qTimer = null;
    m.el.querySelector('#pa-q').oninput = e => { clearTimeout(qTimer); const q = e.target.value.trim(); qTimer = setTimeout(() => doSearch(q), 250); };
    m.el.addEventListener('click', e => {
      const go = e.target.closest('[data-go]');
      if (go) { e.preventDefault(); m.el.querySelector('#pa-q').value = ''; openFolder(go.dataset.go); return; }
      const tile = e.target.closest('.pa-tile');
      if (tile) onPick(files[Number(tile.dataset.i)], m, tile);
    });
    openFolder('root');
  }
  function pickFromArchivos() {
    browseArchivos('Elegir de Archivos', (f, m, b) => {
      if ((draft.images || []).length >= 9) { toast('Ya tienes 9 fotos', true); return; }
      draft.images.push({ thumb: f.thumb_url, full: f.web_url || f.url });
      b.classList.add('is-picked');
      markDirty();
      renderEditor();
    });
  }
  // ── Catalog link ─────────────────────────────────────────────────────────
  async function loadCatalog() {
    if (catalogParents) return catalogParents;
    const res = await VP.get('action=prod_catalog');
    catalogParents = (res.parents || []).filter(p => !String(p.name).includes('(merged→'));
    return catalogParents;
  }
  async function pickParent() {
    const m = VP.showModal('<div class="modal-title" style="margin-bottom:10px">Vincular a un producto del catálogo</div>' +
      '<input class="ls-input" id="pp-q" placeholder="Buscar por nombre, SKU o PARENT-…" style="margin-bottom:10px">' +
      '<div id="pp-list" class="pp-list"><div class="pr-empty-state">Cargando catálogo…</div></div>', { maxWidth: '640px' });
    let parents;
    try { parents = await loadCatalog(); } catch (e) { m.el.querySelector('#pp-list').innerHTML = '<div class="pr-empty-state">' + esc(e.message) + '</div>'; return; }
    const usedBy = {};
    boot.listings.forEach(l => { if (l.parent_id && l.listing_id !== draft.listing_id) usedBy[l.parent_id] = l.listing_id; });
    const paint = q => {
      const list = parents.filter(p => !q || (p.name + ' ' + p.parent_id + ' ' + (p.variants || []).map(v => v.sku + ' ' + v.variant_name).join(' ')).toLowerCase().indexOf(q) >= 0)
        .sort((a, b) => (b.units_sold || 0) - (a.units_sold || 0)).slice(0, 80);
      m.el.querySelector('#pp-list').innerHTML = list.map(p => '<button class="pp-item" data-id="' + esc(p.parent_id) + '">' +
        (p.image ? '<img src="' + esc(p.image) + '" alt="">' : '<span class="pp-noimg"></span>') +
        '<span><b>' + esc(p.name) + '</b><br><small>' + esc(p.parent_id) + ' · ' + (p.variants || []).length + ' variantes · ' + (p.units_sold || 0) + ' vendidos' +
        (usedBy[p.parent_id] ? ' · <span style="color:var(--amber-text)">ya está en ' + esc(usedBy[p.parent_id]) + '</span>' : '') + '</small></span></button>').join('') || '<div class="pr-empty-state">Sin resultados</div>';
    };
    paint('');
    m.el.querySelector('#pp-q').oninput = e => paint(e.target.value.trim().toLowerCase());
    m.el.querySelector('#pp-list').onclick = e => {
      const b = e.target.closest('.pp-item');
      if (!b) return;
      const p = parents.find(x => x.parent_id === b.dataset.id);
      if (usedBy[p.parent_id] && !confirm('Este producto del catálogo ya tiene una ficha (' + usedBy[p.parent_id] + '). ¿Vincularlo también a esta?')) return;
      draft.parent_id = p.parent_id;
      const emptyVariants = draft.variants.every(v => !v.option1 && !v.price && !v.catalog_id);
      if (emptyVariants && (p.variants || []).length) {
        draft.variants = p.variants.map(v => ({ catalog_id: v.catalog_id, option1: v.variant_name || '', option2: '', sku: v.sku || '', price: '', compare_at: '', stock: '', barcode: '', image: v.image || '', image_full: v.full_image || v.image || '' }));
        if (p.variants.length > 1 && !draft.option1_name) draft.option1_name = 'Variante';
      }
      if (!draft.title) draft.title = p.name;
      if (!(draft.images || []).length && p.image) draft.images = [{ thumb: p.image, full: p.full_image || p.image }];
      m.close(); markDirty(); renderEditor();
    };
  }
  function unlinkParent() { draft.parent_id = ''; draft.variants.forEach(v => { v.catalog_id = ''; }); markDirty(); renderEditor(); }

  // ── AI ───────────────────────────────────────────────────────────────────
  async function runAi(which) {
    if (aiBusy) return;
    if (!String(draft.key_features || '').trim() && !draft.title) { toast('Escribe primero las características clave', true); return; }
    const tpl = templateById(draft.template_id);
    const input = {
      key_features: draft.key_features, title: draft.title, description: draft.description,
      variants_hint: draft.variants_hint || draft.variants.map(v => [v.option1, v.option2].filter(Boolean).join(' / ')).filter(Boolean).join('\n'),
      option1_name: draft.option1_name, option2_name: draft.option2_name, brand: draft.brand && draft.brand !== 'No brand' ? draft.brand : '',
      category: tpl ? tpl.category_path : '', prices: draft.variants.map(v => v.price).filter(Boolean).slice(0, 5).join(', '),
      images: (draft.images || []).slice(0, 4).map(im => im.full || im.thumb),
    };
    aiBusy = which; renderEditor();
    const before = clone(draft);
    const jobs = [];
    if (which === 'both' || which === 'copy') jobs.push(VP.post({ action: 'prod_ai', mode: 'copy', input: input }).then(applyCopy));
    if (which === 'both' || which === 'attributes') jobs.push(VP.post({ action: 'prod_ai', mode: 'attributes', input: input }).then(applyAttributes));
    const results = await Promise.allSettled(jobs);
    aiBusy = '';
    const failed = results.filter(r => r.status === 'rejected');
    if (failed.length < results.length) { aiUndo = before; markDirty(); }
    failed.forEach(f => toast(f.reason && f.reason.message ? f.reason.message : String(f.reason), true));
    if (!failed.length) toast('✓ Listo. Revisa el texto antes de guardar');
    renderEditor();
  }
  function applyCopy(res) {
    const r = res.result || {};
    if (r.title) draft.title = String(r.title).slice(0, 300);
    if (r.shopify_title) draft.shopify_title = String(r.shopify_title).slice(0, 255);
    if (r.description) draft.description = String(r.description);
    if (Array.isArray(r.tags)) draft.tags = r.tags.map(String).slice(0, 30);
    if (r.seo_title) draft.seo_title = String(r.seo_title);
    if (r.seo_description) draft.seo_description = String(r.seo_description);
    if (typeof r.option1_name === 'string') draft.option1_name = r.option1_name.slice(0, 20);
    if (typeof r.option2_name === 'string') draft.option2_name = r.option2_name.slice(0, 20);
    if (Array.isArray(r.variants) && r.variants.length) {
      const proto = draft.variants[0] || {};
      const realRows = draft.variants.filter(v => v.option1 || v.catalog_id || v.sku);
      if (realRows.length === r.variants.length) {
        r.variants.forEach((av, i) => { realRows[i].option1 = String(av.option1 || '').slice(0, 50); realRows[i].option2 = String(av.option2 || '').slice(0, 50); });
        draft.variants = realRows;
      } else if (!realRows.length) {
        draft.variants = r.variants.map(av => ({ catalog_id: '', option1: String(av.option1 || '').slice(0, 50), option2: String(av.option2 || '').slice(0, 50), sku: '', price: proto.price || '', compare_at: proto.compare_at || '', stock: proto.stock || '', barcode: '', image: '', image_full: '' }));
      } else {
        toast('La IA propuso ' + r.variants.length + ' variantes y tienes ' + realRows.length + ': no cambié las variantes', true);
      }
    }
    draft.ai_model = res.model; draft.ai_at = res.at;
  }
  function applyAttributes(res) {
    const r = res.result || {};
    const clean = {};
    Object.keys(r).forEach(k => {
      let v = r[k];
      if (v == null || v === '' || (Array.isArray(v) && !v.length)) return;
      if (typeof v === 'string') v = v.toLowerCase();
      if (Array.isArray(v)) v = v.map(x => typeof x === 'string' ? x.toLowerCase() : x);
      clean[k] = v;
    });
    draft.attributes = clean;
    draft.attributes_source = 'ai';
    draft.ai_model = res.model; draft.ai_at = res.at;
  }
  function undoAi() { if (!aiUndo) return; draft = aiUndo; aiUndo = null; markDirty(); renderEditor(); toast('Se deshizo el cambio de la IA'); }

  // ── Save / archive ───────────────────────────────────────────────────────
  async function save() {
    if (saving || !draft) return;
    saving = true;
    const btn = document.getElementById('ls-save-btn');
    btn.disabled = true; btn.textContent = 'Guardando…';
    draft.status = document.getElementById('ls-status-sel').value;
    try {
      const payload = clone(draft);
      payload.sku_links = Object.assign({}, draft.sku_links || {});
      payload.variants = payload.variants.filter((v, i) => i === 0 || v.option1 || v.option2 || v.price || v.sku || v.catalog_id);
      const res = await VP.post({ action: 'prod_save', listing: payload }, { passErrors: ['sku_conflict'] });
      if (res && res.error === 'sku_conflict') {
        saving = false; btn.disabled = false; btn.textContent = 'Guardar';
        return askSkuDecision(res.sku, res.existing_parent_id);
      }
      const saved = res.listing;
      saved.variants_hint = draft.variants_hint;
      const idx = boot.listings.findIndex(l => l.listing_id === saved.listing_id);
      if (idx >= 0) boot.listings[idx] = saved; else boot.listings.push(saved);
      (saved.variants || []).forEach(v => { if (v.sku) boot.skus[v.sku.toUpperCase()] = v.catalog_id; });
      if (res.created_parent) catalogParents = null;   // catalog changed -> reload next time
      draft = clone(saved); dirty = false;
      toast('✓ Guardado' + (res.created_parent ? ' · producto nuevo en el catálogo: ' + res.created_parent : '') + (res.created_variants ? ' · ' + res.created_variants + ' variante(s) nueva(s)' : ''));
      renderEditor();
    } catch (e) {
      toast('No se guardó: ' + (e.message || e), true);
    } finally {
      saving = false; btn.disabled = false; btn.textContent = 'Guardar';
    }
  }

  // The SKU on a variant already belongs to a different catalog parent.
  // Ask once: same product (link this listing to that parent and retry the
  // save) or a different product (remember that choice and retry, which
  // then creates a new parent as usual).
  async function askSkuDecision(sku, existingParentId) {
    let parent = null;
    try { parent = (await loadCatalog()).find(p => p.parent_id === existingParentId); } catch (e) { /* preview is best-effort */ }
    const m = VP.showModal('<div class="modal-title" style="margin-bottom:10px">El SKU «' + esc(sku) + '» ya existe</div>' +
      (parent ? '<div class="pp-item" style="cursor:default">' + (parent.image ? '<img src="' + esc(parent.image) + '" alt="">' : '<span class="pp-noimg"></span>') +
        '<span><b>' + esc(parent.name) + '</b><br><small>' + esc(existingParentId) + ' · ' + (parent.variants || []).length + ' variante(s): ' + esc((parent.variants || []).map(v => v.variant_name).filter(Boolean).join(', ')) + '</small></span></div>'
        : '<div class="ls-help">' + esc(existingParentId) + '</div>') +
      '<div class="ls-help" style="margin:10px 0">¿Es el mismo producto (otro lote comprado después), o es un producto distinto que por casualidad comparte el SKU del proveedor?</div>' +
      '<div class="ls-ai-actions"><button class="btn btn-primary" id="sd-same">Sí, es el mismo producto</button><button class="btn" id="sd-diff">No, es distinto</button></div>', { maxWidth: '520px' });
    m.el.querySelector('#sd-same').onclick = () => {
      draft.sku_links = draft.sku_links || {};
      draft.sku_links[sku] = existingParentId;
      m.close(); save();
    };
    m.el.querySelector('#sd-diff').onclick = () => {
      // Remembering "different" for this exact SKU+parent pair stops the same
      // prompt from reappearing on retry, without silently linking anything.
      draft.sku_links = draft.sku_links || {};
      draft.sku_links[sku] = '__different__';
      m.close(); save();
    };
  }
  async function archiveToggle() {
    if (!draft || !draft.listing_id) return;
    const archive = draft.status !== 'Archivado';
    if (archive && !confirm('¿Archivar este producto? No se borra nada: lo puedes restaurar desde el filtro «Archivados».')) return;
    try {
      const res = await VP.post({ action: 'prod_archive', listing_id: draft.listing_id, archived: archive });
      const l = boot.listings.find(x => x.listing_id === draft.listing_id);
      if (l) l.status = res.status;
      draft.status = res.status;
      toast(archive ? 'Archivado' : 'Restaurado');
      close(true);
    } catch (e) { toast(e.message || String(e), true); }
  }

  // ── Export ───────────────────────────────────────────────────────────────
  function b64ToBuf(b64) {
    const bin = atob(b64); const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out.buffer;
  }
  function download(blob, name) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
  }
  function stamp() { const d = new Date(); return d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0') + '-' + String(d.getHours()).padStart(2, '0') + String(d.getMinutes()).padStart(2, '0'); }
  function withDefaults(l) {
    const out = clone(l);
    out.tiktok_props = Object.assign({}, (boot.settings || {}).tiktok_defaults || {}, l.tiktok_props || {});
    return out;
  }

  function exportDialog(platform) {
    const list = boot.listings.filter(l => selected.has(l.listing_id));
    if (!list.length) { toast('Selecciona primero los productos', true); return; }
    const checked = list.map(l => ({ l: l, pf: preflight(l, platform) }));
    const blocked = checked.filter(c => c.pf.errors.length);
    const ok = checked.filter(c => !c.pf.errors.length);
    let groupsHtml = '';
    if (platform === 'tiktok') {
      const groups = {};
      ok.forEach(c => { (groups[c.l.template_id] = groups[c.l.template_id] || []).push(c.l); });
      groupsHtml = Object.keys(groups).map(tid => {
        const t = templateById(tid);
        const rows = groups[tid].reduce((n, l) => n + Math.max((l.variants || []).length, 1), 0);
        return '<li><b>' + esc(t ? t.name : tid) + '</b> — ' + groups[tid].length + ' producto(s), ' + rows + ' fila(s) → 1 archivo</li>';
      }).join('');
    } else {
      groupsHtml = '<li>' + ok.length + ' producto(s) → 1 archivo CSV</li>';
    }
    const m = VP.showModal('<div class="modal-title" style="margin-bottom:10px">Exportar a ' + (platform === 'tiktok' ? 'TikTok' : 'Shopify') + '</div>' +
      (ok.length ? '<ul class="ex-list">' + groupsHtml + '</ul>' : '') +
      (blocked.length ? '<div class="ex-blocked"><b>' + blocked.length + ' producto(s) no se incluyen</b> porque les falta algo:<ul>' +
        blocked.map(c => '<li>' + esc(c.l.listing_id) + ' ' + esc(c.l.title || '') + ': ' + esc(c.pf.errors.slice(0, 3).join(' · ')) + '</li>').join('') + '</ul></div>' : '') +
      (platform === 'tiktok' ? '<div class="ls-help" style="margin:10px 0">Sube el archivo en TikTok Seller Center → Productos → Carga masiva. Las fotos se toman de los enlaces.</div>'
        : '<div class="ls-help" style="margin:10px 0">Shopify → Productos → Importar. Se crean como «' + esc((boot.settings || {}).shopify_status || 'Draft') + '» (cámbialo en Ajustes). Si un producto ya existe en Shopify, marca «Sobrescribir productos con el mismo handle».</div>') +
      '<div style="text-align:right"><button class="btn btn-primary" id="ex-go"' + (ok.length ? '' : ' disabled') + '>Descargar</button></div>', { maxWidth: '620px' });
    m.el.querySelector('#ex-go').onclick = async () => {
      const b = m.el.querySelector('#ex-go');
      b.disabled = true; b.textContent = 'Preparando…';
      try {
        if (platform === 'tiktok') await exportTikTok(ok.map(c => c.l));
        else await exportShopify(ok.map(c => c.l));
        m.close();
      } catch (e) {
        toast('Error al exportar: ' + (e.message || e), true);
        b.disabled = false; b.textContent = 'Descargar';
      }
    };
  }

  async function exportTikTok(list) {
    const groups = {};
    list.forEach(l => { (groups[l.template_id] = groups[l.template_id] || []).push(l); });
    for (const tid of Object.keys(groups)) {
      const t = templateById(tid);
      const file = await VP.get('action=prod_template_file&template_id=' + encodeURIComponent(tid));
      const rows = [];
      groups[tid].forEach(l => VPExport.tiktokRowsFor(withDefaults(l), t.config).forEach(r => rows.push(r)));
      const blob = await VPExport.fillTikTokTemplate(b64ToBuf(file.file_data), t.config, rows, 'blob');
      const name = 'TikTok_' + (t.name || 'productos').replace(/[^\w]+/g, '_') + '_' + stamp() + '.xlsx';
      download(blob, name);
      const res = await VP.post({ action: 'prod_export_done', platform: 'tiktok', template_id: tid, listing_ids: groups[tid].map(l => l.listing_id), rows: rows.length, file_name: name });
      groups[tid].forEach(l => { l.last_export_tiktok = res.at; if (l.status !== 'Archivado') l.status = 'Exportado'; });
    }
    toast('✓ Archivo(s) de TikTok descargados');
    renderList();
  }

  async function exportShopify(list) {
    const csv = VPExport.buildShopifyCsv(list.map(withDefaults), boot.settings || {});
    const name = 'Shopify_productos_' + stamp() + '.csv';
    download(new Blob([csv], { type: 'text/csv;charset=utf-8' }), name);
    const res = await VP.post({ action: 'prod_export_done', platform: 'shopify', listing_ids: list.map(l => l.listing_id), rows: csv.split('\r\n').length - 2, file_name: name });
    list.forEach(l => { l.last_export_shopify = res.at; if (l.status !== 'Archivado') l.status = 'Exportado'; });
    toast('✓ CSV de Shopify descargado');
    renderList();
  }

  // ── Templates tab ────────────────────────────────────────────────────────
  let pendingTemplate = null;
  function renderTemplates() {
    const el = document.getElementById('tp-body');
    if (!el || !boot) return;
    const tpls = (boot.templates || []).filter(t => t.platform === 'tiktok').sort((a, b) => (b.active - a.active) || a.name.localeCompare(b.name));
    el.innerHTML = '<div class="ls-card"><div class="ls-card-title">Plantillas de TikTok</div>' +
      '<div class="ls-help" style="margin-bottom:10px">TikTok usa una plantilla distinta por categoría. Descárgala en Seller Center (Carga masiva → elige la categoría → Descargar plantilla) y súbela aquí tal cual. Si subes otra de la misma categoría, reemplaza a la anterior.</div>' +
      '<label class="btn btn-primary" style="cursor:pointer">Subir plantilla (.xlsx)<input type="file" accept=".xlsx" style="display:none" onchange="vpListados.readTemplate(this)"></label>' +
      '<div id="tp-preview"></div>' +
      (tpls.length ? '<table class="ls-table" style="margin-top:14px"><thead><tr><th>Nombre</th><th>Categoría TikTok</th><th>Versión</th><th>Subida</th><th>Campos con lista</th><th></th></tr></thead><tbody>' +
        tpls.map(t => '<tr style="' + (t.active ? '' : 'opacity:.5') + '"><td><b>' + esc(t.name) + '</b><br><small>' + esc(t.template_id) + '</small></td><td>' + esc(t.category_path) + '<br><small>ID ' + esc(t.category_id) + '</small></td>' +
          '<td>' + esc(t.version) + '</td><td>' + esc(t.uploaded_by) + '<br><small>' + esc(t.uploaded ? VP.fmtDate(t.uploaded) : '') + '</small></td>' +
          '<td>' + Object.keys((t.config && t.config.options) || {}).length + '</td>' +
          '<td><button class="ls-mini" onclick="vpListados.toggleTemplate(\'' + esc(t.template_id) + '\',' + (t.active ? 'false' : 'true') + ')">' + (t.active ? 'Desactivar' : 'Activar') + '</button></td></tr>').join('') +
        '</tbody></table>' : '<div class="pr-empty-state">Aún no hay plantillas</div>') + '</div>' +
      '<div class="ls-card"><div class="ls-card-title">Shopify</div><div class="ls-help">Shopify usa un solo formato de CSV para todos los productos; ya viene incluido, no hace falta subir nada.</div></div>';
  }
  async function readTemplate(input) {
    const f = input.files && input.files[0];
    input.value = '';
    if (!f) return;
    const prev = document.getElementById('tp-preview');
    prev.innerHTML = '<div class="ls-help" style="margin-top:10px">Leyendo plantilla…</div>';
    try {
      const buf = await f.arrayBuffer();
      const cfg = await VPExport.parseTikTokTemplate(buf);
      const req = cfg.columns.filter(c => c.required === 'required').map(c => c.label);
      const lists = Object.keys(cfg.options).map(k => (cfg.columns.find(c => c.key === k) || {}).label || k);
      const b64 = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1]); r.onerror = () => rej(new Error('No se pudo leer el archivo')); r.readAsDataURL(f); });
      pendingTemplate = { file_name: f.name, file_data: b64, config: cfg };
      const defName = cfg.category_path.split('/').pop();
      prev.innerHTML = '<div class="ls-card" style="margin-top:12px;background:var(--surface2)">' +
        '<div><b>Categoría:</b> ' + esc(cfg.category_path) + ' (ID ' + esc(cfg.category_id) + ')</div>' +
        '<div><b>Versión:</b> ' + esc(cfg.version) + ' · <b>Columnas:</b> ' + cfg.columns.length + ' · <b>Primera fila de datos:</b> ' + cfg.data_start_row + '</div>' +
        '<div style="margin-top:6px"><b>Obligatorias:</b> ' + esc(req.join(', ')) + '</div>' +
        '<div><b>Con lista desplegable:</b> ' + esc(lists.join(', ')) + '</div>' +
        '<label class="ls-field" style="margin-top:10px"><span class="ls-label">Nombre corto</span><input class="ls-input" id="tp-name" value="' + esc(defName) + '"></label>' +
        '<button class="btn btn-primary" onclick="vpListados.saveTemplate()">Guardar plantilla</button></div>';
    } catch (e) {
      pendingTemplate = null;
      prev.innerHTML = '<div class="ex-blocked" style="margin-top:10px">' + esc(e.message || e) + '</div>';
    }
  }
  async function saveTemplate() {
    if (!pendingTemplate) return;
    const name = (document.getElementById('tp-name').value || '').trim();
    try {
      await VP.post(Object.assign({ action: 'prod_template_save', platform: 'tiktok', name: name }, pendingTemplate));
      pendingTemplate = null;
      toast('✓ Plantilla guardada');
      boot = await VP.get('action=prod_bootstrap');
      renderTemplates(); renderList();
    } catch (e) { toast(e.message || String(e), true); }
  }
  // First time a TikTok dropdown value shows up untranslated: ask once for
  // the Spanish word, save it catalog-wide (prod_translate_save), re-render.
  async function translateAttribute(fieldKey, fieldLabel, english) {
    const spanish = (prompt('¿Cómo se dice «' + english + '» en español? (campo: ' + fieldLabel + ')') || '').trim();
    if (!spanish) return;
    try {
      const res = await VP.post({ action: 'prod_translate_save', field_key: fieldKey, field_label: fieldLabel, english: english, spanish: spanish });
      boot.translations = res.translations;
      toast('✓ Traducción guardada');
      renderEditor();
    } catch (e) { toast(e.message || String(e), true); }
  }
  async function toggleTemplate(id, active) {
    try {
      await VP.post({ action: 'prod_template_toggle', template_id: id, active: active });
      const t = templateById(id); if (t) t.active = active;
      renderTemplates();
    } catch (e) { toast(e.message || String(e), true); }
  }

  // ── Settings tab ─────────────────────────────────────────────────────────
  function renderSettings() {
    const el = document.getElementById('aj-body');
    if (!el || !boot) return;
    const s = boot.settings || {};
    const tpls = (boot.templates || []).filter(t => t.platform === 'tiktok' && t.active);
    const propOpts = {};
    const propLabel = {};
    tpls.forEach(t => (t.config.columns || []).forEach(c => {
      if (c.key.indexOf('product_property/') !== 0) return;
      propLabel[c.key] = c.label;
      if ((t.config.options || {})[c.key]) propOpts[c.key] = Array.from(new Set((propOpts[c.key] || []).concat(t.config.options[c.key])));
    }));
    const inp = (id, label, val, ph) => '<label class="ls-field ls-half"><span class="ls-label">' + esc(label) + '</span><input class="ls-input" id="' + id + '" value="' + esc(val || '') + '" placeholder="' + esc(ph || '') + '"></label>';
    el.innerHTML = '<div class="ls-card"><div class="ls-card-title">Valores por defecto</div><div class="ls-grid">' +
      inp('st-brand', 'Marca por defecto (TikTok)', s.brand_default, 'No brand') +
      inp('st-vendor', 'Proveedor en Shopify (Vendor)', s.shopify_vendor, 'Vel Papier') +
      '<label class="ls-field ls-half"><span class="ls-label">Estado al importar en Shopify</span><select class="ls-input" id="st-status"><option value="Draft"' + (s.shopify_status !== 'Active' ? ' selected' : '') + '>Borrador (revisar en Shopify)</option><option value="Active"' + (s.shopify_status === 'Active' ? ' selected' : '') + '>Activo (visible de inmediato)</option></select></label>' +
      inp('st-weight', 'Peso por defecto (g)', s.default_weight_g, 'ej. 250') +
      inp('st-dims', 'Medidas por defecto (cm, largo x ancho x alto)', s.default_dims_cm, 'ej. 20 x 15 x 5') +
      '</div></div>' +
      '<div class="ls-card"><div class="ls-card-title">Campos de TikTok que casi siempre son iguales</div><div class="ls-help" style="margin-bottom:8px">Se usan en cada producto nuevo y al exportar, salvo que el producto tenga otro valor.</div><div class="ls-grid">' +
      Object.keys(propOpts).map(k => '<label class="ls-field ls-half"><span class="ls-label">' + esc(propLabel[k]) + '</span><select class="ls-input" data-tdef="' + esc(k) + '"><option value="">—</option>' +
        propOpts[k].map(o => '<option' + ((s.tiktok_defaults || {})[k] === o ? ' selected' : '') + '>' + esc(o) + '</option>').join('') + '</select></label>').join('') +
      '</div></div>' +
      '<div class="ls-card"><div class="ls-card-title">IA</div>' +
      '<div class="ls-help" style="margin-bottom:8px">Estado: ' + (boot.ai_enabled ? '<b style="color:var(--green-text)">activa</b> · modelo ' + esc(boot.ai_model) : '<b style="color:var(--amber-text)">sin configurar</b> — falta ANTHROPIC_API_KEY en Apps Script') + '</div>' +
      '<label class="ls-field"><span class="ls-label">Estilo de la tienda (la IA lo sigue en títulos y descripciones)</span><textarea class="ls-input" id="st-voice" rows="5" placeholder="Ej.: Habla de tú. Menciona que es ideal para regalo cuando aplique. Nunca uses la palabra «barato».">' + esc(s.ai_voice || '') + '</textarea></label>' +
      '</div><div style="text-align:right;margin-bottom:30px"><button class="btn btn-primary" onclick="vpListados.saveSettings()">Guardar ajustes</button></div>';
  }
  async function saveSettings() {
    const s = {
      brand_default: document.getElementById('st-brand').value, shopify_vendor: document.getElementById('st-vendor').value,
      shopify_status: document.getElementById('st-status').value, default_weight_g: document.getElementById('st-weight').value,
      default_dims_cm: document.getElementById('st-dims').value, ai_voice: document.getElementById('st-voice').value,
      tiktok_defaults: {},
    };
    document.querySelectorAll('[data-tdef]').forEach(sel => { if (sel.value) s.tiktok_defaults[sel.dataset.tdef] = sel.value; });
    try {
      const res = await VP.post({ action: 'prod_settings_save', settings: s });
      boot.settings = res.settings;
      toast('✓ Ajustes guardados');
      renderSettings();
    } catch (e) { toast(e.message || String(e), true); }
  }

  // ── Wiring ───────────────────────────────────────────────────────────────
  function wire() {
    const list = document.getElementById('ls-list');
    list.addEventListener('change', e => { const c = e.target.closest('[data-sel]'); if (c) toggleSel(c.dataset.sel, c.checked); });
    const ed = document.getElementById('ls-editor-body');
    ed.addEventListener('input', onInput);
    ed.addEventListener('change', onInput);
    // Drag-and-drop onto the "+ Subir fotos" box, same pattern as Fotos del
    // catálogo: delegated on the editor body since the box is re-created on
    // every renderEditor().
    ['dragenter', 'dragover'].forEach(evt => ed.addEventListener(evt, e => {
      const box = e.target.closest('.ls-gadd');
      if (!box) return;
      e.preventDefault();
      box.classList.add('drag-over');
    }));
    ['dragleave', 'drop'].forEach(evt => ed.addEventListener(evt, e => {
      const box = e.target.closest('.ls-gadd');
      if (!box) return;
      if (evt === 'dragleave' && box.contains(e.relatedTarget)) return;
      box.classList.remove('drag-over');
    }));
    ed.addEventListener('drop', e => {
      const box = e.target.closest('.ls-gadd');
      if (!box || !draft) return;
      e.preventDefault();
      dropOnGallery_(e.dataTransfer);
    });
    document.addEventListener('keydown', e => {
      if (!draft) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); save(); }
    });
    window.addEventListener('beforeunload', e => { if (draft && dirty) { e.preventDefault(); e.returnValue = ''; } });
    const h = (location.hash || '').replace('#', '');
    tab(['listados', 'fotos', 'plantillas', 'ajustes'].indexOf(h) >= 0 ? h : 'listados');
  }

  document.addEventListener('DOMContentLoaded', () => { wire(); load(); });

  return {
    tab, load, renderList, open, close, save, archiveToggle, selectAllVisible, clearSel, exportDialog,
    addVariant, removeVariant, moveVariant, fillDown, combos, uploadImgs, uploadVariantImg, uploadVariantImgPrompt, browseVariantImg, moveImg, removeImg,
    pasteImg, useCatalogPhotos, pickFromArchivos, pickParent, unlinkParent, runAi, undoAi, setViewMode,
    readTemplate, saveTemplate, toggleTemplate, saveSettings, preflight, translateAttribute,
  };
})();
