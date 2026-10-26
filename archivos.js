// archivos.js — Archivos page: team photo/video/file sharing, stored on the
// VPS (vp-files container, see vps-reference/vp-files/service.py).
// Everyone on the team can upload, browse, download and share links.
// Deleting goes to a 30-day trash; emptying it is admin-only.
window.vpArchivos = (function () {
  'use strict';

  const API = 'https://files.srv2017849.hstgr.cloud';
  const esc = s => VP.esc(s == null ? '' : s);
  const toast = (m, e) => VP.toast(m, !!e);

  let folderId = 'root';
  let pendingFolder = [];   // [{id, name, thumb_url}] -- photos dragged in, not yet saved to a new folder
  let lastClickedFile = null;   // for shift-click range select
  let sortOrder = 'new';    // 'new' | 'old'
  let groupBy = 'none';     // 'none' | 'used' | 'unused'
  let usageMap = null;      // url -> ['tiktok','shopify'] -- from Apps Script, cached per page load

  // TODO-CLEANUP (usage badges, disabled 2026-10-26): feature is built but
  // turned off for now. To re-enable: remove the early `return {}` below.
  // To actually clean this up later: delete loadUsageMap_/usageOf/
  // usageBadgeHtml/markFolderUsage_, the .ar-tile--*/.ar-folder--*/.ar-usage-*
  // CSS in archivos.html, the usedCls/usageBadgeHtml() calls in tileFile(),
  // the markFolderUsage_() call in render(), and prodFileUsageAction_ +
  // its GET route in products.gs if nothing else ends up using it.
  async function loadUsageMap_() {
    usageMap = {}; return usageMap;   // DISABLED -- see TODO-CLEANUP above
    if (usageMap) return usageMap;
    try { usageMap = (await VP.get('action=prod_file_usage')).usage || {}; }
    catch (e) { usageMap = {}; }
    return usageMap;
  }
  function usageOf(f) {
    const u = usageMap || {};
    return u[f.web_url] || u[f.url] || [];
  }
  function usageBadgeHtml(platforms) {
    if (!platforms.length) return '';
    const cls = platforms.length === 2 ? 'ar-usage-both' : (platforms[0] === 'tiktok' ? 'ar-usage-tiktok' : 'ar-usage-shopify');
    const label = platforms.length === 2 ? 'TikTok + Shopify' : (platforms[0] === 'tiktok' ? 'TikTok' : 'Shopify');
    return '<span class="ar-usage-tab ' + cls + '">' + label + '</span>';
  }
  function sortFiles_(list) {
    const sorted = list.slice().sort((a, b) => String(a.uploaded_at).localeCompare(String(b.uploaded_at)));
    return sortOrder === 'old' ? sorted : sorted.reverse();
  }
  function groupFiles_(list) {
    if (groupBy === 'none') return [{ label: '', files: list }];
    const used = list.filter(f => usageOf(f).length);
    const unused = list.filter(f => !usageOf(f).length);
    return groupBy === 'used'
      ? [{ label: 'Usadas en un listado (' + used.length + ')', files: used }, { label: 'Sin usar (' + unused.length + ')', files: unused }]
      : [{ label: 'Sin usar (' + unused.length + ')', files: unused }, { label: 'Usadas en un listado (' + used.length + ')', files: used }];
  }
  let data = null;               // /api/list response
  let view = 'folder';           // folder | trash | search
  let searchResults = null;
  let selected = new Set();      // file ids
  let selectedFolders = new Set();
  const queue = [];              // upload queue
  let uploading = false;

  // ── API ──────────────────────────────────────────────────────────────────
  async function api(path, opts) {
    opts = opts || {};
    const headers = Object.assign({ Authorization: 'Bearer ' + VP.token }, opts.headers || {});
    let body = opts.body;
    if (body && typeof body === 'object' && !(body instanceof ArrayBuffer) && !ArrayBuffer.isView(body) && typeof body.arrayBuffer !== 'function') { body = JSON.stringify(body); headers['Content-Type'] = 'application/json'; }
    let r;
    try { r = await fetch(API + path, { method: opts.method || 'GET', headers: headers, body: body }); }
    catch (e) { throw new Error('No hay conexión con el servidor de archivos'); }   // TROUBLESHOOT: vp-files down -> on the VPS: docker ps / docker logs vp-files
    let j = null;
    try { j = await r.json(); } catch (e) { /* not JSON */ }
    if (!r.ok) throw new Error((j && j.detail) || ('Error ' + r.status));
    return j;
  }
  const authQ = () => 't=' + encodeURIComponent(VP.token);
  const withAuth = url => url + (url.indexOf('?') >= 0 ? '&' : '?') + authQ();

  function fmtSize(b) {
    b = Number(b) || 0;
    if (b < 1024) return b + ' B';
    if (b < 1024 * 1024) return (b / 1024).toFixed(0) + ' KB';
    if (b < 1024 ** 3) return (b / 1024 / 1024).toFixed(1) + ' MB';
    return (b / 1024 ** 3).toFixed(2) + ' GB';
  }

  // ── Loading ──────────────────────────────────────────────────────────────
  async function open(id) {
    folderId = id || 'root';
    view = 'folder'; searchResults = null;
    selected.clear(); selectedFolders.clear(); pendingFolder = [];
    document.getElementById('ar-search').value = '';
    try { history.replaceState(null, '', folderId === 'root' ? 'archivos.html' : '#' + folderId); } catch (e) { /* ignore */ }
    await loadUsageMap_();
    await refresh();
  }
  function setSort(v) { sortOrder = v; render(); }
  function setGroup(v) { groupBy = v; render(); }

  async function refresh() {
    const grid = document.getElementById('ar-grid');
    try {
      if (view === 'trash') data = await api('/api/trash');
      else data = await api('/api/list?folder=' + encodeURIComponent(folderId));
      render();
    } catch (e) {
      grid.innerHTML = '<div class="pr-empty-state">' + esc(e.message) + (/conexión/.test(e.message) ? '<br><br><small>El servidor de archivos todavía no está instalado o no responde.</small>' : '') + '</div>';
      if (view === 'folder' && folderId !== 'root' && /no encontrada/i.test(e.message)) open('root');
    }
    loadUsage();
  }

  async function loadUsage() {
    try {
      const u = await api('/api/usage');
      const pct = u.disk_total ? Math.round(u.disk_used / u.disk_total * 100) : 0;
      const el = document.getElementById('ar-usage');
      el.innerHTML = '<div class="ar-meter"><div style="width:' + pct + '%;background:' + (pct >= 90 ? 'var(--red-text)' : pct >= 80 ? 'var(--amber-text)' : 'var(--green-text)') + '"></div></div>' +
        '<span>' + fmtSize(u.disk_free) + ' libres de ' + fmtSize(u.disk_total) + ' · ' + u.files + ' archivo' + (u.files !== 1 ? 's' : '') + ' (' + fmtSize(u.files_bytes) + ')' +
        (VP.getRole() === 'admin' ? ' · respaldo: ' + (u.backup ? (u.backup.ok ? '✓ ' + esc(VP.fmtRel(u.backup.at)) : esc(u.backup.message || 'falló')) : 'sin datos') : '') + '</span>';
    } catch (e) { /* meter is optional */ }
  }

  // ── Rendering ────────────────────────────────────────────────────────────
  function tileFile(f, showPath) {
    const sel = selected.has(f.id);
    const icon = f.kind === 'video' ? '▶' : f.kind === 'pdf' ? 'PDF' : (f.name.split('.').pop() || '').toUpperCase().slice(0, 4);
    const used = usageOf(f);
    const usedCls = used.length === 2 ? ' ar-tile--both' : used.length ? (used[0] === 'tiktok' ? ' ar-tile--tiktok' : ' ar-tile--shopify') : '';
    return '<div class="ar-tile' + (sel ? ' is-sel' : '') + usedCls + '" data-file="' + esc(f.id) + '" draggable="true">' +
      usageBadgeHtml(used) +
      '<input type="checkbox" class="ar-check" data-check="' + esc(f.id) + '"' + (sel ? ' checked' : '') + '>' +
      '<div class="ar-img">' + (f.thumb_url ? '<img src="' + esc(f.thumb_url) + '" loading="lazy" alt="">' : '<span class="ar-icon">' + esc(icon) + '</span>') +
        (f.kind === 'video' && f.thumb_url ? '<span class="ar-play">▶</span>' : '') + '</div>' +
      '<div class="ar-name" title="' + esc(f.name) + '">' + esc(f.name) + '</div>' +
      '<div class="ar-meta">' + (showPath ? esc(f.folder_path || 'Archivos') + ' · ' : '') + fmtSize(f.size) + ' · ' + esc(f.uploaded_by || '') + (f.public ? '' : ' · 🔒') + '</div>' +
      '</div>';
  }

  // Drag-photos-to-make-a-folder strip. Nothing here touches the server
  // until "Guardar carpeta" -- dragging and dropping only builds up
  // `pendingFolder` in memory, so it's free to undo (Cancelar / page nav)
  // right up to that one save call.
  function renderDropStrip() {
    const el = document.getElementById('ar-dropstrip');
    if (!el) return;
    if (view !== 'folder') { el.style.display = 'none'; return; }
    el.style.display = '';
    if (!pendingFolder.length) {
      el.innerHTML = '<div class="ar-ds-empty">Arrastra fotos aquí para crear una carpeta nueva</div>';
      return;
    }
    el.innerHTML = '<div class="ar-ds-row">' +
      '<div class="ar-ds-thumbs">' + pendingFolder.map(f => '<div class="ar-ds-thumb"><img src="' + esc(f.thumb_url || '') + '" alt=""><button class="ar-ds-x" data-ds-remove="' + esc(f.id) + '">✕</button></div>').join('') + '</div>' +
      '<input type="text" id="ar-ds-name" class="ar-ds-name" placeholder="Nombre de la carpeta" value="' + esc(pendingFolder.name || '') + '">' +
      '<button class="btn btn-primary" id="ar-ds-save">Guardar carpeta</button>' +
      '<button class="ls-mini" id="ar-ds-cancel">Cancelar</button>' +
      '</div>';
  }
  function dropStripAdd(f) {
    if (pendingFolder.some(x => x.id === f.id)) { toast('Esa foto ya está agregada', true); return; }
    pendingFolder.push({ id: f.id, name: f.name, thumb_url: f.thumb_url });
    renderDropStrip();
  }
  function dropStripRemove(id) {
    pendingFolder = pendingFolder.filter(x => x.id !== id);
    renderDropStrip();
  }
  function dropStripCancel() {
    pendingFolder = [];
    renderDropStrip();
  }
  async function dropStripSave() {
    const input = document.getElementById('ar-ds-name');
    let name = (input ? input.value : '').trim();
    if (!name) { toast('Escribe un nombre para la carpeta', true); return; }
    const fileIds = pendingFolder.map(f => f.id);
    for (let attempt = 0; attempt < 20; attempt++) {
      try {
        await api('/api/folder_from_files', { method: 'POST', body: { name: name, parent_id: folderId, file_ids: fileIds } });
        pendingFolder = [];
        toast('✓ Carpeta creada');
        refresh();
        return;
      } catch (e) {
        if (/ya existe/i.test(e.message) && attempt === 0) {
          // name taken -> offer "(1)" instead of just failing silently
          if (!confirm('Ya existe una carpeta llamada «' + name + '» aquí. ¿Usar «' + name + ' (1)» en su lugar?')) { renderDropStrip(); return; }
          name = name + ' (1)';
          continue;
        }
        if (/ya existe/i.test(e.message)) {
          const m = name.match(/^(.*) \((\d+)\)$/);
          name = m ? m[1] + ' (' + (Number(m[2]) + 1) + ')' : name + ' (1)';
          continue;
        }
        toast(e.message, true);
        renderDropStrip();
        return;
      }
    }
  }

  function render() {
    const grid = document.getElementById('ar-grid');
    const crumbs = document.getElementById('ar-crumbs');
    const admin = VP.getRole() === 'admin';
    document.getElementById('ar-trash-btn').textContent = view === 'trash' ? '← Volver a Archivos' : '🗑 Papelera';
    document.getElementById('ar-upload-btn').style.display = view === 'folder' ? '' : 'none';
    document.getElementById('ar-newfolder-btn').style.display = view === 'folder' ? '' : 'none';

    if (view === 'trash') {
      crumbs.innerHTML = '<b>Papelera</b> <span class="ar-sub">· se borra sola a los ' + (data.days || 30) + ' días</span>' +
        (admin && (data.files.length || data.folders.length) ? ' <button class="ls-mini" onclick="vpArchivos.emptyTrash()">Vaciar papelera</button>' : '');
      const items = data.folders.map(f => '<div class="ar-trash-row">📁 <b>' + esc(f.name) + '</b> <span class="ar-sub">borrada por ' + esc(f.trashed_by) + ' ' + esc(VP.fmtRel(f.trashed_at)) + '</span><button class="ls-mini" onclick="vpArchivos.restore(null,\'' + esc(f.id) + '\')">Restaurar</button></div>')
        .concat(data.files.map(f => '<div class="ar-trash-row">' + (f.thumb_url ? '<img src="' + esc(f.thumb_url) + '" alt="">' : '📄') + ' <b>' + esc(f.name) + '</b> <span class="ar-sub">' + fmtSize(f.size) + ' · borrado por ' + esc(f.trashed_by || '') + ' ' + esc(VP.fmtRel(f.trashed_at)) + '</span><button class="ls-mini" onclick="vpArchivos.restore(\'' + esc(f.id) + '\')">Restaurar</button></div>'));
      grid.innerHTML = items.length ? items.join('') : '<div class="pr-empty-state">La papelera está vacía</div>';
      renderSel();
      renderDropStrip();
      return;
    }

    if (view === 'search') {
      crumbs.innerHTML = '<b>Resultados</b> <button class="ls-mini" onclick="vpArchivos.open(\'' + esc(folderId) + '\')">Cerrar búsqueda</button>';
      const r = searchResults || { files: [], folders: [] };
      grid.innerHTML = (r.folders.length ? '<div class="ar-folders">' + r.folders.map(f => '<button class="ar-folder" onclick="vpArchivos.open(\'' + esc(f.id) + '\')">📁 ' + esc(f.name) + '<small>' + esc(f.path) + '</small></button>').join('') + '</div>' : '') +
        (r.files.length ? '<div class="ar-files">' + r.files.map(f => tileFile(f, true)).join('') + '</div>' : '') ||
        '<div class="pr-empty-state">Sin resultados</div>';
      renderSel();
      renderDropStrip();
      return;
    }

    const f = data.folder;
    crumbs.innerHTML = data.path.map((p, i) => i === data.path.length - 1 ? '<b>' + esc(p.name) + '</b>' : '<a href="#" onclick="vpArchivos.open(\'' + esc(p.id) + '\');return false">' + esc(p.name) + '</a>').join(' <span class="ar-sub">/</span> ') +
      ' <span class="ar-badge ' + (f.effective_public ? 'ar-badge--pub' : 'ar-badge--priv') + '" title="' + (f.effective_public ? 'Los enlaces de esta carpeta funcionan sin iniciar sesión (TikTok y Shopify pueden leer las fotos)' : 'Solo el equipo, con sesión iniciada, puede abrir estos archivos') + '">' + (f.effective_public ? 'Enlaces públicos' : '🔒 Privada') + '</span>' +
      (admin && f.id !== 'root' ? ' <button class="ls-mini" onclick="vpArchivos.toggleVisibility()">' + (f.public ? 'Hacer privada' : 'Hacer pública') + '</button>' : '') +
      (f.id !== 'root' ? ' <button class="ls-mini" onclick="vpArchivos.renameFolder()">Renombrar</button>' : '');

    const folders = data.folders.map(x => '<div class="ar-folder-wrap" id="ar-fw-' + esc(x.id) + '"><input type="checkbox" class="ar-fcheck" data-fcheck="' + esc(x.id) + '"' + (selectedFolders.has(x.id) ? ' checked' : '') + '>' +
      '<button class="ar-folder" data-folder-id="' + esc(x.id) + '" onclick="vpArchivos.open(\'' + esc(x.id) + '\')">' + (x.public ? '📁' : '🔒') + ' ' + esc(x.name) +
      '<small>' + x.files + ' archivo' + (x.files !== 1 ? 's' : '') + (x.subfolders ? ' · ' + x.subfolders + ' carpeta' + (x.subfolders !== 1 ? 's' : '') : '') + '</small></button></div>').join('');
    const groups = groupFiles_(sortFiles_(data.files));
    const filesHtml = groups.map(g => (g.label ? '<div class="ar-group-label">' + esc(g.label) + '</div>' : '') +
      (g.files.length ? '<div class="ar-files">' + g.files.map(x => tileFile(x, false)).join('') + '</div>' : '')).join('');
    grid.innerHTML = (folders ? '<div class="ar-folders">' + folders + '</div>' : '') +
      (data.files.length ? filesHtml : '<div class="ar-drop-hint">Arrastra archivos aquí o toca <b>Subir</b>.<br><small>Fotos, videos, PDF… hasta 4 GB por archivo.</small></div>');
    renderSel();
    renderDropStrip();
    markFolderUsage_(data.folders);
  }
  // A folder gets the same colored outline only when EVERY image inside it
  // (recursively, one level is enough in practice) is used on the same
  // platform(s). Fetched lazily per visible folder since /api/list only
  // returns the current folder's own files.
  async function markFolderUsage_(folders) {
    await loadUsageMap_();
    for (const fo of folders) {
      let d;
      try { d = await api('/api/list?folder=' + encodeURIComponent(fo.id)); } catch (e) { continue; }
      const imgs = (d.files || []).filter(f => f.kind === 'image');
      if (!imgs.length) continue;
      const sets = imgs.map(f => usageOf(f));
      if (sets.some(s => !s.length)) continue;   // at least one unused photo -> no badge
      const common = sets[0].filter(p => sets.every(s => s.includes(p)));
      if (!common.length) continue;
      const el = document.getElementById('ar-fw-' + fo.id);
      const btn = el && el.querySelector('.ar-folder');
      if (btn) btn.classList.add(common.length === 2 ? 'ar-folder--both' : (common.includes('tiktok') ? 'ar-folder--tiktok' : 'ar-folder--shopify'));
    }
  }

  function renderSel() {
    const n = selected.size + selectedFolders.size;
    const bar = document.getElementById('ar-selbar');
    bar.style.display = n && view !== 'trash' ? '' : 'none';
    if (!n) return;
    const oneFile = selected.size === 1 && !selectedFolders.size;
    document.getElementById('ar-seltext').textContent = n + ' seleccionado' + (n !== 1 ? 's' : '');
    document.getElementById('ar-sel-link').style.display = oneFile ? '' : 'none';
    document.getElementById('ar-sel-rename').style.display = oneFile ? '' : 'none';
    document.getElementById('ar-sel-download').style.display = selected.size ? '' : 'none';
  }

  function fileById(id) {
    const list = view === 'search' ? (searchResults || {}).files : (data || {}).files;
    return (list || []).find(f => f.id === id);
  }

  // ── Preview ──────────────────────────────────────────────────────────────
  function preview(id) {
    const f = fileById(id);
    if (!f) return;
    const src = f.public ? f.url : withAuth(f.url);
    if (f.kind === 'image' && !/heic/i.test(f.mime)) { VP.lightbox(f.public ? (f.web_url || f.url) : withAuth(f.web_url || f.url)); return; }
    const body = f.kind === 'video' ? '<video src="' + esc(src) + '" controls playsinline style="width:100%;max-height:60vh;border-radius:8px;background:#000"></video>'
      : (f.thumb_url ? '<img src="' + esc(f.thumb_url) + '" style="max-width:100%;border-radius:8px" alt="">' : '<div class="pr-empty-state">Sin vista previa</div>');
    const m = VP.showModal('<div class="modal-title" style="margin-bottom:10px;word-break:break-all">' + esc(f.name) + '</div>' + body +
      '<div class="ar-sub" style="margin:8px 0">' + fmtSize(f.size) + (f.width ? ' · ' + f.width + '×' + f.height : '') + (f.duration ? ' · ' + Math.round(f.duration) + ' s' : '') + ' · subido por ' + esc(f.uploaded_by) + ' ' + esc(VP.fmtRel(f.uploaded_at)) + '</div>' +
      '<div class="ls-ai-actions"><a class="btn btn-primary" href="' + esc(withAuth(f.url) + '&dl=1') + '">Descargar</a>' +
      '<button class="btn" id="pv-link">Copiar enlace</button><a class="btn" href="' + esc(src) + '" target="_blank" rel="noopener">Abrir</a></div>', { maxWidth: '720px' });
    m.el.querySelector('#pv-link').onclick = () => copyLink(f);
  }

  async function copyLink(f) {
    const url = f.kind === 'image' && f.web_url ? f.web_url : f.url;
    try { await navigator.clipboard.writeText(url); toast(f.public ? '✓ Enlace copiado' : '✓ Enlace copiado (carpeta privada: solo funciona con sesión iniciada)'); }
    catch (e) { prompt('Copia el enlace:', url); }
  }

  // ── Selection actions ────────────────────────────────────────────────────
  function download() {
    const ids = Array.from(selected);
    if (ids.length === 1) {
      const f = fileById(ids[0]);
      if (f) { location.href = withAuth(f.url) + '&dl=1'; return; }
    }
    location.href = API + '/api/zip?ids=' + encodeURIComponent(ids.join(',')) + '&' + authQ();
    toast('Preparando el ZIP… la descarga empieza sola');
  }
  function linkSelected() { const f = fileById(Array.from(selected)[0]); if (f) copyLink(f); }
  // "Crear producto con fotos seleccionadas": assign each photo to the
  // listing gallery (max 9) and/or a variant, name option 1, then hand the
  // whole thing to Productos via sessionStorage (simplest reliable way to
  // pass this across a page navigation without a backend round trip).
  function createProduct() {
    const files = Array.from(selected).map(id => fileById(id)).filter(Boolean);
    if (!files.length) return;
    // role: 'listing' | 'variant' | 'both' -- click the photo itself to cycle
    // through roles instead of separate checkbox + textbox controls.
    const state = {};
    files.forEach(f => { state[f.id] = { role: 'listing', variantName: '' }; });
    const roleLabel = { listing: 'Listado', variant: 'Variante', both: 'Ambas' };
    const tile = f => {
      const s = state[f.id];
      return '<div class="cp-tile" data-id="' + esc(f.id) + '">' +
        '<img src="' + esc(f.thumb_url) + '" alt="">' +
        '<button type="button" class="cp-role cp-role--' + s.role + '" data-cp-role="' + esc(f.id) + '">' + roleLabel[s.role] + '</button>' +
        (s.role !== 'listing' ? '<input type="text" class="cp-variant" data-cp-variant="' + esc(f.id) + '" placeholder="Nombre de variante" value="' + esc(s.variantName) + '">' : '') +
        '</div>';
    };
    const paintTiles = () => { m.el.querySelector('#cp-tiles').innerHTML = files.map(tile).join(''); };
    const m = VP.showModal('<div class="modal-title" style="margin-bottom:6px">Crear producto</div>' +
      '<div class="ls-help" style="margin-bottom:10px">Toca una foto para cambiar su uso: <b>Listado</b> (galería principal, máx. 9), <b>Variante</b> (ej. color) o <b>Ambas</b>.</div>' +
      '<label class="ls-field"><span class="ls-label">Nombre de la opción 1 (ej. Color)</span><input type="text" class="ls-input" id="cp-opt1"></label>' +
      '<div class="cp-tiles" id="cp-tiles"></div>' +
      '<div class="ls-ai-actions" style="margin-top:12px"><button class="btn btn-primary" id="cp-go">Crear producto</button></div>', { maxWidth: '640px' });
    paintTiles();
    m.el.addEventListener('click', e => {
      const b = e.target.closest('[data-cp-role]');
      if (!b) return;
      const s = state[b.dataset.cpRole];
      s.role = s.role === 'listing' ? 'variant' : s.role === 'variant' ? 'both' : 'listing';
      paintTiles();
    });
    m.el.addEventListener('input', e => {
      if (e.target.dataset.cpVariant !== undefined) state[e.target.dataset.cpVariant].variantName = e.target.value;
    });
    m.el.querySelector('#cp-go').onclick = () => {
      const listingCount = files.filter(f => state[f.id].role !== 'variant').length;
      if (listingCount > 9) { toast('Máximo 9 fotos para el listado', true); return; }
      const images = files.filter(f => state[f.id].role !== 'variant').map(f => ({ thumb: f.thumb_url, full: f.web_url || f.url }));
      const byVariant = {};
      files.forEach(f => {
        const s = state[f.id];
        const name = s.role === 'listing' ? '' : s.variantName.trim();
        if (!name) return;
        if (!byVariant[name]) byVariant[name] = { thumb: f.thumb_url, full: f.web_url || f.url };
      });
      const variants = Object.keys(byVariant).map(name => Object.assign({ option1: name, sku: '', price: '', stock: '' }, byVariant[name]));
      const payload = { images: images, option1_name: m.el.querySelector('#cp-opt1').value.trim(), variants: variants };
      sessionStorage.setItem('vp_prod_from_archivos', JSON.stringify(payload));
      location.href = 'productos.html?from_archivos=1';
    };
  }
  async function renameSelected() {
    const f = fileById(Array.from(selected)[0]);
    if (!f) return;
    const name = (prompt('Nuevo nombre:', f.name) || '').trim();
    if (!name || name === f.name) return;
    try { await api('/api/rename', { method: 'POST', body: { kind: 'file', id: f.id, name: name } }); selected.clear(); refresh(); }
    catch (e) { toast(e.message, true); }
  }
  async function trashSelected() {
    const n = selected.size + selectedFolders.size;
    if (!confirm('¿Mandar ' + n + ' elemento(s) a la papelera? Se pueden restaurar durante 30 días.')) return;
    try {
      await api('/api/trash', { method: 'POST', body: { file_ids: Array.from(selected), folder_ids: Array.from(selectedFolders) } });
      selected.clear(); selectedFolders.clear(); toast('Enviado a la papelera'); refresh();
    } catch (e) { toast(e.message, true); }
  }
  async function moveSelected() {
    // simple folder picker: walk the tree from root
    let cur = 'root';
    const m = VP.showModal('<div class="modal-title" style="margin-bottom:10px">Mover a…</div><div id="mv-body"></div>', { maxWidth: '480px' });
    async function paint() {
      const d = await api('/api/list?folder=' + encodeURIComponent(cur));
      m.el.querySelector('#mv-body').innerHTML = '<div class="ar-sub" style="margin-bottom:8px">' + d.path.map(p => esc(p.name)).join(' / ') + '</div>' +
        (cur !== 'root' ? '<button class="pp-item" data-up="' + esc(d.path[d.path.length - 2].id) + '">⬆ Subir un nivel</button>' : '') +
        d.folders.filter(x => !selectedFolders.has(x.id)).map(x => '<button class="pp-item" data-go="' + esc(x.id) + '">' + (x.public ? '📁' : '🔒') + ' ' + esc(x.name) + '</button>').join('') +
        '<div style="text-align:right;margin-top:10px"><button class="btn btn-primary" id="mv-here">Mover aquí</button></div>';
    }
    m.el.addEventListener('click', async e => {
      const b = e.target.closest('[data-go],[data-up]');
      if (b) { cur = b.dataset.go || b.dataset.up; paint(); return; }
      if (e.target.id === 'mv-here') {
        try {
          await api('/api/move', { method: 'POST', body: { file_ids: Array.from(selected), folder_ids: Array.from(selectedFolders), to: cur } });
          selected.clear(); selectedFolders.clear(); m.close(); toast('✓ Movido'); refresh();
        } catch (err) { toast(err.message, true); }
      }
    });
    paint().catch(e => toast(e.message, true));
  }

  // ── Folders ──────────────────────────────────────────────────────────────
  async function newFolder() {
    const name = (prompt('Nombre de la carpeta:') || '').trim();
    if (!name) return;
    try { await api('/api/folder', { method: 'POST', body: { name: name, parent_id: folderId } }); refresh(); }
    catch (e) { toast(e.message, true); }
  }
  async function renameFolder() {
    const name = (prompt('Nuevo nombre de la carpeta:', data.folder.name) || '').trim();
    if (!name) return;
    try { await api('/api/rename', { method: 'POST', body: { kind: 'folder', id: folderId, name: name } }); refresh(); }
    catch (e) { toast(e.message, true); }
  }
  async function toggleVisibility() {
    const toPublic = !data.folder.public;
    if (!confirm(toPublic ? '¿Hacer pública esta carpeta? Cualquiera con un enlace podrá ver sus archivos (necesario para fotos de TikTok/Shopify).'
      : '¿Hacer privada esta carpeta? Los enlaces que ya compartiste dejarán de funcionar fuera del dashboard.')) return;
    try { await api('/api/visibility', { method: 'POST', body: { folder_id: folderId, public: toPublic } }); refresh(); }
    catch (e) { toast(e.message, true); }
  }

  // ── Trash ────────────────────────────────────────────────────────────────
  function toggleTrash() {
    selected.clear(); selectedFolders.clear();
    view = view === 'trash' ? 'folder' : 'trash';
    refresh();
  }
  async function restore(fileId, folder) {
    try { await api('/api/restore', { method: 'POST', body: { file_ids: fileId ? [fileId] : [], folder_ids: folder ? [folder] : [] } }); toast('✓ Restaurado'); refresh(); }
    catch (e) { toast(e.message, true); }
  }
  async function emptyTrash() {
    if (!confirm('¿Borrar para siempre todo lo que hay en la papelera? Esto no se puede deshacer.')) return;
    try { const r = await api('/api/purge', { method: 'POST', body: { all: true } }); toast(r.deleted + ' archivo(s) borrados para siempre'); refresh(); }
    catch (e) { toast(e.message, true); }
  }

  // ── Search ───────────────────────────────────────────────────────────────
  let sTimer = null;
  function search(q) {
    clearTimeout(sTimer);
    q = q.trim();
    if (q.length < 2) { if (view === 'search') { view = 'folder'; render(); } return; }
    sTimer = setTimeout(async () => {
      try { searchResults = await api('/api/search?q=' + encodeURIComponent(q)); view = 'search'; selected.clear(); render(); }
      catch (e) { toast(e.message, true); }
    }, 300);
  }

  // ── Upload (chunked, resumable per chunk) ────────────────────────────────
  function addFiles(list) {
    Array.from(list || []).forEach(file => queue.push({ file: file, folder: folderId, folderName: data && data.folder ? data.folder.name : '', status: 'waiting', pct: 0, error: '' }));
    renderQueue();
    pump();
  }
  async function pump() {
    if (uploading) return;
    uploading = true;
    let item;
    while ((item = queue.find(q => q.status === 'waiting'))) {
      item.status = 'uploading'; renderQueue();
      try {
        const init = await api('/api/upload/init', { method: 'POST', body: { name: item.file.name, size: item.file.size, mime: item.file.type, folder_id: item.folder } });
        for (let i = 0; i < init.chunks; i++) {
          const blob = item.file.slice(i * init.chunk_size, (i + 1) * init.chunk_size);
          let ok = false, lastErr = null;
          for (let attempt = 1; attempt <= 4 && !ok; attempt++) {
            try { await api('/api/upload/' + init.upload_id + '/' + i, { method: 'PUT', body: await blob.arrayBuffer(), headers: { 'Content-Type': 'application/octet-stream' } }); ok = true; }
            catch (e) { lastErr = e; await new Promise(r => setTimeout(r, 1500 * attempt)); }
          }
          if (!ok) throw lastErr;
          item.pct = Math.round((i + 1) / init.chunks * 100); renderQueue();
        }
        const res = await api('/api/upload/' + init.upload_id + '/complete', { method: 'POST' });
        item.status = 'done';
        if (res.duplicate_of) item.error = 'Ya existía uno igual (' + res.duplicate_of.name + ')';
        if (item.folder === folderId && view === 'folder') refresh();
      } catch (e) {
        item.status = 'error'; item.error = e.message || String(e);
      }
      renderQueue();
    }
    uploading = false;
  }
  function renderQueue() {
    const el = document.getElementById('ar-queue');
    if (!queue.length) { el.style.display = 'none'; return; }
    el.style.display = '';
    const active = queue.filter(q => q.status === 'waiting' || q.status === 'uploading').length;
    el.innerHTML = '<div class="ar-q-head"><b>' + (active ? 'Subiendo ' + active + '…' : 'Subidas terminadas') + '</b>' +
      (active ? '' : '<button class="ls-mini" onclick="vpArchivos.clearQueue()">Cerrar</button>') + '</div>' +
      queue.slice(-30).map(q => '<div class="ar-q-row"><span class="ar-q-name">' + esc(q.file.name) + '</span>' +
        '<span class="ar-q-st ' + q.status + '">' + (q.status === 'uploading' ? q.pct + '%' : q.status === 'done' ? '✓' : q.status === 'error' ? 'Error' : 'En espera') + '</span>' +
        (q.error ? '<div class="ar-q-err">' + esc(q.error) + (q.status === 'error' ? ' <a href="#" onclick="vpArchivos.retry(\'' + queue.indexOf(q) + '\');return false">Reintentar</a>' : '') + '</div>' : '') +
        '<div class="ar-q-bar"><div style="width:' + (q.status === 'done' ? 100 : q.pct) + '%"></div></div></div>').join('');
  }
  function clearQueue() { for (let i = queue.length - 1; i >= 0; i--) if (queue[i].status === 'done' || queue[i].status === 'error') queue.splice(i, 1); renderQueue(); }
  function retry(i) { const q = queue[Number(i)]; if (q) { q.status = 'waiting'; q.error = ''; q.pct = 0; renderQueue(); pump(); } }

  // ── Wiring ───────────────────────────────────────────────────────────────
  function wire() {
    const grid = document.getElementById('ar-grid');
    grid.addEventListener('change', e => {
      const c = e.target.closest('[data-check]');
      if (c) { if (c.checked) selected.add(c.dataset.check); else selected.delete(c.dataset.check); c.closest('.ar-tile').classList.toggle('is-sel', c.checked); lastClickedFile = c.dataset.check; renderSel(); return; }
      const fc = e.target.closest('[data-fcheck]');
      if (fc) { if (fc.checked) selectedFolders.add(fc.dataset.fcheck); else selectedFolders.delete(fc.dataset.fcheck); renderSel(); }
    });
    grid.addEventListener('click', e => {
      if (e.target.closest('input')) return;
      const t = e.target.closest('[data-file]');
      if (!t) return;
      if (e.shiftKey && lastClickedFile) {
        const tiles = Array.from(grid.querySelectorAll('[data-file]'));
        const ids = tiles.map(x => x.dataset.file);
        const a = ids.indexOf(lastClickedFile), b = ids.indexOf(t.dataset.file);
        if (a >= 0 && b >= 0) { ids.slice(Math.min(a, b), Math.max(a, b) + 1).forEach(id => selected.add(id)); render(); return; }
      }
      if (selected.size) {   // while selecting, a tap toggles instead of opening
        const id = t.dataset.file;
        if (selected.has(id)) selected.delete(id); else selected.add(id);
        lastClickedFile = id;
        render(); return;
      }
      preview(t.dataset.file);
    });
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && (selected.size || selectedFolders.size)) { selected.clear(); selectedFolders.clear(); lastClickedFile = null; render(); }
    });
    // Drag a tile from the grid onto the drop strip -> add to pendingFolder.
    // Uses a custom drag type (not "Files") so it never collides with the
    // OS-file-drop-to-upload handling below.
    grid.addEventListener('dragstart', e => {
      const t = e.target.closest('[data-file]');
      if (!t) { e.preventDefault(); return; }
      const f = fileById(t.dataset.file);
      if (!f) { e.preventDefault(); return; }
      e.dataTransfer.effectAllowed = 'copy';
      e.dataTransfer.setData('application/x-vp-file', JSON.stringify({ id: f.id, name: f.name, thumb_url: f.thumb_url }));
    });
    // Drag a tile straight onto an existing folder tile -> move it there
    // immediately (unlike the drop strip, this has no undo step; it's a
    // direct move, same as the existing "Mover" button).
    grid.addEventListener('dragover', e => {
      const fb = e.target.closest('[data-folder-id]');
      if (fb && Array.from(e.dataTransfer.types || []).indexOf('application/x-vp-file') >= 0) { e.preventDefault(); fb.classList.add('drag-over'); }
    });
    grid.addEventListener('dragleave', e => {
      const fb = e.target.closest('[data-folder-id]');
      if (fb && !fb.contains(e.relatedTarget)) fb.classList.remove('drag-over');
    });
    grid.addEventListener('drop', async e => {
      const fb = e.target.closest('[data-folder-id]');
      if (!fb) return;
      const raw = e.dataTransfer.getData('application/x-vp-file');
      if (!raw) return;
      e.preventDefault();
      fb.classList.remove('drag-over');
      let f; try { f = JSON.parse(raw); } catch (err) { return; }
      try { await api('/api/move', { method: 'POST', body: { file_ids: [f.id], to: fb.dataset.folderId } }); toast('✓ Movido a la carpeta'); refresh(); }
      catch (err) { toast(err.message, true); }
    });
    const strip = document.getElementById('ar-dropstrip');
    strip.addEventListener('dragover', e => { if (Array.from(e.dataTransfer.types || []).indexOf('application/x-vp-file') >= 0) e.preventDefault(); });
    strip.addEventListener('drop', e => {
      const raw = e.dataTransfer.getData('application/x-vp-file');
      if (!raw) return;
      e.preventDefault();
      try { dropStripAdd(JSON.parse(raw)); } catch (err) { /* ignore malformed drag data */ }
    });
    strip.addEventListener('click', e => {
      const rm = e.target.closest('[data-ds-remove]');
      if (rm) { dropStripRemove(rm.dataset.dsRemove); return; }
      if (e.target.id === 'ar-ds-save') dropStripSave();
      if (e.target.id === 'ar-ds-cancel') dropStripCancel();
    });
    const page = document.body;
    let dragDepth = 0;
    page.addEventListener('dragenter', e => { if (view !== 'folder' || !e.dataTransfer || Array.from(e.dataTransfer.types || []).indexOf('Files') < 0) return; dragDepth++; document.getElementById('ar-dropzone').style.display = ''; });
    page.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) document.getElementById('ar-dropzone').style.display = 'none'; });
    page.addEventListener('dragover', e => { if (view === 'folder') e.preventDefault(); });
    page.addEventListener('drop', e => {
      e.preventDefault(); dragDepth = 0;
      document.getElementById('ar-dropzone').style.display = 'none';
      if (view === 'folder' && e.dataTransfer && e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
    });
    window.addEventListener('beforeunload', e => { if (uploading) { e.preventDefault(); e.returnValue = ''; } });
    const h = (location.hash || '').replace('#', '');
    open(/^D[0-9a-f]{10}$/.test(h) ? h : 'root');
  }

  document.addEventListener('DOMContentLoaded', wire);

  return { open, refresh, addFiles, newFolder, renameFolder, toggleVisibility, toggleTrash, restore, emptyTrash, search, setSort, setGroup,
    download, linkSelected, renameSelected, trashSelected, moveSelected, createProduct, clearQueue, retry,
    clearSel: () => { selected.clear(); selectedFolders.clear(); render(); } };
})();
