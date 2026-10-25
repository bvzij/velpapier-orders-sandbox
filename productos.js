// productos.js — bulk drag-and-drop photo upload for the product catalog
// (Product Parents + Product Variants). Admin-only page.
//
// Loads the full catalog via `action=catalog_list`, shows one placeholder
// box per parent and per variant, lets the user drag/drop or click to pick
// a photo into any box (staged locally, nothing uploaded yet), then uploads
// everything in one batch via `action=catalog_upload_image` (type: parent|variant).
window.vpProductos = (function () {
  'use strict';

  const ACCEPT = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'];
  const MAX_BYTES = 15 * 1024 * 1024;

  // parents: [{ parent_id, name, image, variants:[{catalog_id,parent_id,variant_name,sku,image}] }]
  let parents = [];
  // pending: Map key ("parent:PARENT-1" or "variant:VAR-1") -> { type, id, file, previewUrl, label, status }
  const pending = new Map();
  let saving = false;

  const esc = s => (typeof VP !== 'undefined' ? VP.esc(s) : String(s == null ? '' : s));
  const toast = (m, err) => { try { VP.toast(m, !!err); } catch (e) { console.log('[productos]', m); } };

  function pendingKey(type, id) { return type + ':' + id; }

  function imageFor(type, id, catalogImage) {
    const p = pending.get(pendingKey(type, id));
    return p ? p.previewUrl : (catalogImage || '');
  }

  // ── Loading ──────────────────────────────────────────────────────────────
  async function load(force) {
    const btn = document.getElementById('pr-refresh');
    if (btn) btn.disabled = true;
    try {
      const res = await VP.get('action=catalog_list' + (force ? '&_=' + Date.now() : ''));
      parents = res.parents || [];
      render();
    } catch (e) {
      toast('No se pudo cargar el catálogo: ' + (e.message || e), true);
      const list = document.getElementById('pr-list');
      if (list && !parents.length) list.innerHTML = '<div class="pr-empty-state">No se pudo cargar el catálogo. Toca «Actualizar».</div>';
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  // ── Staging a file (drag/drop or click-to-pick) ─────────────────────────
  function validateFile(file) {
    if (!file) return 'No se seleccionó ningún archivo';
    if (ACCEPT.indexOf(file.type) < 0) return 'Formato no permitido (usa JPG, PNG o WEBP)';
    if (file.size > MAX_BYTES) return 'La foto es demasiado grande (máx 15MB)';
    return '';
  }

  function stageFile(type, id, label, file) {
    const err = validateFile(file);
    if (err) { toast(err, true); return; }
    const key = pendingKey(type, id);
    const existing = pending.get(key);
    if (existing && existing.previewUrl) URL.revokeObjectURL(existing.previewUrl);
    const item = { type, id, label, file, previewUrl: URL.createObjectURL(file), status: 'uploading' };
    pending.set(key, item);
    render();
    uploadInBackground(item);
  }

  async function uploadInBackground(item) {
    try {
      const thumbUrl = await uploadOne(item);
      if (pending.get(pendingKey(item.type, item.id)) !== item) return;   // discarded or replaced while it was uploading
      applyResult(item, thumbUrl);
      item.status = 'uploaded';
    } catch (e) {
      if (pending.get(pendingKey(item.type, item.id)) !== item) return;
      item.status = 'error';
      item.error = e.message || String(e);
    }
    render();
  }

  async function discardOne(type, id) {
    const key = pendingKey(type, id);
    const p = pending.get(key);
    if (!p) return;
    if (p.previewUrl) URL.revokeObjectURL(p.previewUrl);
    pending.delete(key);
    render();
    if (p.status === 'uploaded') {
      // the photo is already saved on the sheet -- clear it back out
      try { await clearImage(p.type, p.id); } catch (e) { toast('No se pudo borrar la foto guardada: ' + (e.message || e), true); }
    }
  }

  async function discardAll() {
    if (!pending.size || saving) return;
    const items = Array.from(pending.values());
    if (!confirm('¿Descartar ' + items.length + ' foto(s)?')) return;
    items.forEach(p => { if (p.previewUrl) URL.revokeObjectURL(p.previewUrl); });
    pending.clear();
    render();
    const toClear = items.filter(p => p.status === 'uploaded');
    for (let i = 0; i < toClear.length; i++) {
      try { await clearImage(toClear[i].type, toClear[i].id); } catch (e) { /* best-effort */ }
    }
  }

  async function clearImage(type, id) {
    const body = type === 'parent'
      ? { action: 'catalog_set_fields', catalog_id: id, type: 'parent', fields: { 'Image URL': '' } }
      : { action: 'catalog_set_fields', catalog_id: id, fields: { 'Image URL': '' } };
    const res = await VP.post(body);
    if (!res || !res.ok) throw new Error((res && res.error) || 'Error desconocido');
    if (type === 'parent') { const p = parents.find(x => x.parent_id === id); if (p) p.image = ''; }
    else { for (const p of parents) { const v = p.variants.find(x => x.catalog_id === id); if (v) { v.image = ''; break; } } }
    render();
  }

  // ── Save ─────────────────────────────────────────────────────────────────
  function fileToDataUrl(file) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = () => reject(new Error('No se pudo leer el archivo'));
      r.readAsDataURL(file);
    });
  }

  async function uploadOne(item) {
    const dataUrl = await fileToDataUrl(item.file);
    const body = item.type === 'parent'
      ? { action: 'catalog_upload_image', type: 'parent', parent_id: item.id, file_name: item.file.name, file_data: dataUrl }
      : { action: 'catalog_upload_image', type: 'variant', catalog_id: item.id, file_name: item.file.name, file_data: dataUrl };
    const res = await VP.post(body);
    if (!res || !res.ok) throw new Error((res && res.error) || 'Error desconocido');
    return res.thumb_url;
  }

  async function saveAll() {
    if (saving) return;
    const items = Array.from(pending.values());
    const stillUploading = items.filter(i => i.status === 'uploading');
    if (stillUploading.length) { toast('Espera a que terminen de subir ' + stillUploading.length + ' foto(s)…', true); return; }
    const done = items.filter(i => i.status === 'uploaded');
    done.forEach(item => { if (item.previewUrl) URL.revokeObjectURL(item.previewUrl); pending.delete(pendingKey(item.type, item.id)); });
    render();
    if (done.length) toast('✓ ' + done.length + ' foto(s) guardadas');
  }

  function applyResult(item, thumbUrl) {
    if (item.type === 'parent') {
      const p = parents.find(x => x.parent_id === item.id);
      if (p) p.image = thumbUrl;
    } else {
      for (let i = 0; i < parents.length; i++) {
        const v = parents[i].variants.find(x => x.catalog_id === item.id);
        if (v) { v.image = thumbUrl; break; }
      }
    }
  }

  // ── Rendering ────────────────────────────────────────────────────────────
  function boxHtml(type, id, label, image, sizeCls) {
    const p = pending.get(pendingKey(type, id));
    const showUrl = p ? p.previewUrl : image;
    const cls = ['pr-box', sizeCls];
    if (showUrl) cls.push('has-image');
    if (p && p.status === 'pending') cls.push('is-pending');
    const inner = showUrl ? '<img src="' + esc(showUrl) + '" alt="">' : '<span class="pr-box-empty">+</span>';
    let overlay = '';
    if (p) {
      if (p.status === 'uploading') overlay = '<div class="pr-box-progress">Subiendo…</div>';
      else if (p.status === 'uploaded') overlay = '<span class="pr-box-pending-badge" style="background:#1f8a4c;color:#fff">guardada</span><span class="pr-box-plus">✎</span>';
      else if (p.status === 'error') overlay = '<div class="pr-box-err" title="' + esc(p.error || '') + '">Error — toca para reintentar</div>';
    } else if (showUrl) {
      overlay = '<span class="pr-box-plus">✎</span>';
    }
    const disabled = saving ? ' pr-box--disabled' : '';
    return '<div class="' + cls.join(' ') + disabled + '" data-type="' + type + '" data-id="' + esc(id) + '" data-label="' + esc(label) + '">' +
      inner + overlay + '<input type="file" accept="image/jpeg,image/png,image/webp" data-type="' + type + '" data-id="' + esc(id) + '" data-label="' + esc(label) + '"></div>';
  }

  function render() {
    const q = (document.getElementById('pr-search') || {}).value || '';
    const query = q.trim().toLowerCase();

    let filtered = !query ? parents.slice() : parents.filter(p => {
      if (p.name.toLowerCase().includes(query) || (p.sku || '').toLowerCase().includes(query)) return true;
      return p.variants.some(v => v.variant_name.toLowerCase().includes(query) || v.sku.toLowerCase().includes(query));
    });
    const chanFilter = (document.getElementById('pr-channel') || {}).value || 'all';
    if (chanFilter !== 'all') filtered = filtered.filter(p => (p.channel || '').toLowerCase().includes(chanFilter));

    const list = document.getElementById('pr-list');
    if (list) {
      if (!parents.length) {
        list.innerHTML = '<div class="pr-empty-state">Cargando catálogo…</div>';
      } else if (!filtered.length) {
        list.innerHTML = '<div class="pr-empty-state">Sin resultados para «' + esc(q) + '»</div>';
      } else {
        list.innerHTML = filtered.map(p => {
          const variantsHtml = p.variants.length ? '<div class="pr-variants">' + p.variants.map(v =>
            '<div class="pr-variant">' + boxHtml('variant', v.catalog_id, (p.name + (v.variant_name ? ' (' + v.variant_name + ')' : '')), v.image, 'pr-box--variant') +
            '<div class="pr-variant-label">' + esc(v.variant_name || '—') + '</div>' +
            '<div class="pr-variant-sku">' + esc(v.sku || v.catalog_id) + '</div></div>'
          ).join('') + '</div>' : '<div class="pr-variants"><div class="pr-product-sub" style="grid-column:1/-1">Sin variantes</div></div>';
          return '<div class="pr-product">' +
            '<div class="pr-product-top">' + boxHtml('parent', p.parent_id, p.name, p.image, 'pr-box--parent') +
            '<div class="pr-product-info"><div class="pr-product-name">' + esc(p.name || '(sin nombre)') + '</div>' +
            '<div class="pr-product-sub">' + p.variants.length + ' variante' + (p.variants.length !== 1 ? 's' : '') + ' · SKU ' + esc(p.sku || p.parent_id) + (p.units_sold ? ' · ' + p.units_sold + ' vendidos' : '') + '</div></div>' +
            '</div>' + variantsHtml + '</div>';
        }).join('');
      }
    }

    const sortMode = (document.getElementById('pr-sort') || {}).value || 'name';
    const chan = (document.getElementById('pr-channel') || {}).value || 'all';
    filtered.sort((a, b) => {
      if (sortMode === 'created') return (b.created || '').localeCompare(a.created || '');
      if (sortMode === 'sold') return (b.units_sold || 0) - (a.units_sold || 0);
      return a.name.localeCompare(b.name, 'es');
    });

    const stat = document.getElementById('pr-stat');
    if (stat) stat.textContent = parents.length ? (filtered.length + ' producto' + (filtered.length !== 1 ? 's' : '')) : '';

    const bar = document.getElementById('pr-save-bar');
    const text = document.getElementById('pr-save-text');
    const saveBtn = document.getElementById('pr-save-btn');
    const discardBtn = document.getElementById('pr-discard-btn');
    if (bar) {
      bar.classList.toggle('is-empty', pending.size === 0);
      if (text) {
        const n = pending.size;
        text.textContent = saving ? 'Guardando ' + n + ' foto(s)…' : (n + ' foto' + (n !== 1 ? 's' : '') + ' sin guardar');
      }
      if (saveBtn) saveBtn.disabled = saving || pending.size === 0;
      if (discardBtn) discardBtn.disabled = saving;
    }
  }

  // ── Event wiring (drag/drop + click-to-pick, delegated on #pr-list) ────
  function wire() {
    const list = document.getElementById('pr-list');
    if (!list) return;

    list.addEventListener('click', ev => {
      const box = ev.target.closest('.pr-box');
      if (!box || saving) return;
      if (box.classList.contains('pr-box--disabled')) return;
      if (box.classList.contains('is-pending') || ev.target.closest('.pr-box-err')) {
        // retry / change staged file -> open picker again
      }
      box.querySelector('input[type=file]').click();
    });

    list.addEventListener('change', ev => {
      const inp = ev.target.closest('input[type=file]');
      if (!inp || !inp.files || !inp.files[0]) return;
      stageFile(inp.dataset.type, inp.dataset.id, inp.dataset.label, inp.files[0]);
      inp.value = '';
    });

    ['dragenter', 'dragover'].forEach(evt => list.addEventListener(evt, ev => {
      const box = ev.target.closest('.pr-box');
      if (!box || saving) return;
      ev.preventDefault();
      box.classList.add('drag-over');
    }));
    ['dragleave', 'drop'].forEach(evt => list.addEventListener(evt, ev => {
      const box = ev.target.closest('.pr-box');
      if (!box) return;
      if (evt === 'dragleave' && box.contains(ev.relatedTarget)) return;
      box.classList.remove('drag-over');
    }));
    list.addEventListener('drop', ev => {
      const box = ev.target.closest('.pr-box');
      if (!box || saving) return;
      ev.preventDefault();
      const file = ev.dataTransfer && ev.dataTransfer.files && ev.dataTransfer.files[0];
      if (file) stageFile(box.dataset.type, box.dataset.id, box.dataset.label, file);
    });

    window.addEventListener('beforeunload', ev => {
      if (pending.size && !saving) { ev.preventDefault(); ev.returnValue = ''; }
    });
  }

  document.addEventListener('DOMContentLoaded', () => { wire(); load(); });

  return { load, render, saveAll, discardAll, discardOne };
})();
