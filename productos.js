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
    pending.set(key, { type, id, label, file, previewUrl: URL.createObjectURL(file), status: 'pending' });
    render();
  }

  function discardOne(type, id) {
    const key = pendingKey(type, id);
    const p = pending.get(key);
    if (p && p.previewUrl) URL.revokeObjectURL(p.previewUrl);
    pending.delete(key);
    render();
  }

  function discardAll() {
    if (!pending.size || saving) return;
    if (!confirm('¿Descartar ' + pending.size + ' foto(s) sin guardar?')) return;
    pending.forEach(p => { if (p.previewUrl) URL.revokeObjectURL(p.previewUrl); });
    pending.clear();
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
    if (saving || !pending.size) return;
    saving = true;
    const items = Array.from(pending.values());
    render();   // lock inputs, show "Guardando…"

    let ok = 0, failed = 0;
    // Sequential, not parallel: Apps Script serialises writes behind one lock
    // anyway, so parallel calls would just queue up and risk the 30s "busy"
    // timeout on a big batch. One at a time is slower but reliable.
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      item.status = 'uploading';
      render();
      try {
        const thumbUrl = await uploadOne(item);
        applyResult(item, thumbUrl);
        item.status = 'done';
        ok++;
      } catch (e) {
        item.status = 'error';
        item.error = e.message || String(e);
        failed++;
      }
      render();
    }

    // Drop everything that succeeded; keep failures staged so they can be retried.
    items.forEach(item => {
      if (item.status === 'done') {
        if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
        pending.delete(pendingKey(item.type, item.id));
      }
    });

    saving = false;
    render();
    if (failed) toast(ok + ' foto(s) guardadas, ' + failed + ' con error — revisa los recuadros en rojo', true);
    else toast('✓ ' + ok + ' foto(s) guardadas');
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
      if (p.status === 'pending') overlay = '<span class="pr-box-pending-badge">nueva</span><span class="pr-box-plus">✎</span>';
      else if (p.status === 'uploading') overlay = '<div class="pr-box-progress">Subiendo…</div>';
      else if (p.status === 'done') overlay = '<div class="pr-box-ok">✓</div>';
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

    const filtered = !query ? parents : parents.filter(p => {
      if (p.name.toLowerCase().includes(query)) return true;
      return p.variants.some(v => v.variant_name.toLowerCase().includes(query) || v.sku.toLowerCase().includes(query));
    });

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
            '<div class="pr-product-sub">' + p.variants.length + ' variante' + (p.variants.length !== 1 ? 's' : '') + ' · ' + esc(p.parent_id) + '</div></div>' +
            '</div>' + variantsHtml + '</div>';
        }).join('');
      }
    }

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
