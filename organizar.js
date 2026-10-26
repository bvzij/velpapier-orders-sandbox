/* organizar.js — Productos › Organizar
   Tools for categorizing, flagging for review, merging duplicate products,
   merging duplicate variants within one product, and bulk-editing variant
   attributes (Stock, Barcode, Low Stock At, Image URL). Mirrors the modal/
   row visual language already used on Ajustes (aj-merge-modal, aj-dup-*,
   aj-history-* classes) so nothing new needed adding to style.css. */
window.vpOrganizar = (function () {

  let rendered = false;

  function render() {
    if (rendered) return;
    rendered = true;
    const el = document.getElementById('org-body');
    el.innerHTML = `
      <div class="aj-section">
        <div class="aj-section-title">Productos duplicados</div>
        <div class="aj-card">
          <div class="aj-row">
            <div>
              <div class="aj-row-label">Buscar posibles duplicados</div>
              <div class="aj-row-hint">Compara productos con nombre similar y sugiere cuáles fusionar</div>
            </div>
            <button class="refresh-btn" id="org-scan-product-duplicates">Buscar duplicados</button>
          </div>
          <div class="aj-row">
            <div>
              <div class="aj-row-label">Buscar manualmente</div>
              <div class="aj-row-hint">Elige dos productos tú mismo y fusiónalos directamente</div>
            </div>
            <button class="refresh-btn" id="org-manual-product-merge">Buscar manualmente</button>
          </div>
          <div class="aj-row" style="margin-bottom:0">
            <div>
              <div class="aj-row-label">Fusionar variantes del mismo producto</div>
              <div class="aj-row-hint">Para cuando el duplicado está dentro de un producto (dos variantes "Rojo", por ejemplo), no entre dos productos distintos</div>
            </div>
            <button class="refresh-btn" id="org-variant-merge">Fusionar variantes</button>
          </div>
        </div>
      </div>

      <div class="aj-section">
        <div class="aj-section-title">Categorías</div>
        <div class="aj-card">
          <div class="aj-row">
            <div>
              <div class="aj-row-label">Asignar categoría en bloque</div>
              <div class="aj-row-hint">Selecciona productos y asígnales una categoría a todos a la vez</div>
            </div>
            <button class="refresh-btn" id="org-bulk-category">Asignar categoría</button>
          </div>
          <div class="aj-row" style="margin-bottom:0">
            <div>
              <div class="aj-row-label">Editar lista de categorías</div>
              <div class="aj-row-hint">Agrega, renombra o elimina categorías</div>
            </div>
            <button class="refresh-btn" id="org-manage-categories">Editar categorías</button>
          </div>
        </div>
      </div>

      <div class="aj-section">
        <div class="aj-section-title">Atributos</div>
        <div class="aj-card">
          <div class="aj-row" style="margin-bottom:0">
            <div>
              <div class="aj-row-label">Edición masiva</div>
              <div class="aj-row-hint">Cambia Stock, Código de barras, Stock bajo o Foto para varias variantes a la vez</div>
            </div>
            <button class="refresh-btn" id="org-bulk-attrs">Editar en bloque</button>
          </div>
        </div>
      </div>

      <div class="aj-section">
        <div class="aj-section-title">Historial</div>
        <div class="aj-card">
          <div class="aj-row" style="margin-bottom:0">
            <div>
              <div class="aj-row-label">Fusiones de productos y variantes</div>
              <div class="aj-row-hint">Revisa las fusiones realizadas y deshaz cualquiera que haya sido un error</div>
            </div>
            <button class="refresh-btn" id="org-merge-history">Ver historial</button>
          </div>
        </div>
      </div>
    `;
    bind();
  }

  function bind() {
    document.getElementById('org-scan-product-duplicates').addEventListener('click', openProductDuplicatesModal);
    document.getElementById('org-manual-product-merge').addEventListener('click', openManualProductSearchModal);
    document.getElementById('org-variant-merge').addEventListener('click', openVariantMergePicker);
    document.getElementById('org-bulk-category').addEventListener('click', openBulkCategoryModal);
    document.getElementById('org-manage-categories').addEventListener('click', openManageCategoriesModal);
    document.getElementById('org-bulk-attrs').addEventListener('click', openBulkAttrsModal);
    document.getElementById('org-merge-history').addEventListener('click', openOrgMergeHistoryModal);
  }

  /* ── Product duplicate-merger (relocated from ajustes.js, unchanged) ───
     Two-level merge: Parent-level fuzzy match, then a per-variant pairing
     screen. Nothing is written until "Confirmar fusión" is pressed. ──── */

  const ORG_PROD_DUP_DEFAULT_THRESHOLD = 55;

  async function openProductDuplicatesModal() {
    const modalRoot = document.getElementById('modal-container');
    modalRoot.innerHTML = `<div class="modal-overlay" id="org-prod-overlay">
      <div class="modal aj-merge-modal">
        <div class="modal-title">Productos duplicados</div>
        <div class="aj-dup-threshold-row">
          <span class="aj-dup-threshold-label">Umbral</span>
          <input type="range" id="org-prod-threshold-slider" min="0" max="100" step="1" value="${ORG_PROD_DUP_DEFAULT_THRESHOLD}">
          <span class="aj-dup-threshold-value" id="org-prod-threshold-value">${ORG_PROD_DUP_DEFAULT_THRESHOLD}%</span>
          <button class="btn aj-dup-refresh-btn" id="org-prod-refresh-btn" title="Buscar de nuevo con este umbral" aria-label="Actualizar">↻</button>
        </div>
        <div class="aj-merge-scroll" id="org-prod-duplicates-content">
          <div class="vp-loading">Comparando productos, puede tardar un momento…</div>
        </div>
        <div class="modal-actions">
          <button class="btn" id="org-prod-close-btn">Cerrar</button>
        </div>
      </div>
    </div>`;

    document.getElementById('org-prod-close-btn').addEventListener('click', () => { modalRoot.innerHTML = ''; });

    const slider = document.getElementById('org-prod-threshold-slider');
    const valueLabel = document.getElementById('org-prod-threshold-value');
    slider.addEventListener('input', () => { valueLabel.textContent = slider.value + '%'; });
    document.getElementById('org-prod-refresh-btn').addEventListener('click', () => {
      loadProductDuplicates(parseInt(slider.value, 10));
    });

    await loadProductDuplicates(ORG_PROD_DUP_DEFAULT_THRESHOLD);
  }

  async function loadProductDuplicates(threshold) {
    const content = document.getElementById('org-prod-duplicates-content');
    content.innerHTML = '<div class="vp-loading">Comparando productos, puede tardar un momento…</div>';
    try {
      await VP.ensureToken();
      const data = await VP.get('action=find_duplicate_products&threshold=' + threshold);
      renderProductDuplicates(data.pairs || []);
    } catch (e) {
      content.innerHTML = `<div class="vp-empty-sm">Error al buscar duplicados: ${VP.esc(e.message)}</div>`;
    }
  }

  function renderProductDuplicates(pairs) {
    const content = document.getElementById('org-prod-duplicates-content');

    if (!pairs.length) {
      content.innerHTML = '<div class="vp-empty-sm">No se encontraron duplicados probables.</div>';
      return;
    }

    content.innerHTML = `<div style="font-size:12px;color:var(--text-muted);margin-bottom:10px">
      ${VP.num(pairs.length)} par${pairs.length !== 1 ? 'es' : ''} probable${pairs.length !== 1 ? 's' : ''} encontrado${pairs.length !== 1 ? 's' : ''}
    </div>` + pairs.map(productPairHtml).join('');

    content.querySelectorAll('.org-prod-review-btn').forEach(el => {
      el.addEventListener('click', () => openProductMergeScreen(JSON.parse(el.dataset.pair)));
    });
    content.querySelectorAll('.org-prod-dismiss-btn').forEach(el => {
      el.addEventListener('click', () => handleProductDismiss(el));
    });
  }

  function productPairHtml(pair) {
    const a = pair.parent_a, b = pair.parent_b;
    const pairJson = VP.esc(JSON.stringify(pair));
    return `<div class="aj-dup-pair" data-a="${VP.esc(a['Parent ID'])}" data-b="${VP.esc(b['Parent ID'])}">
      <div class="aj-dup-header">
        <span>Coincidencia probable</span>
        <span class="aj-dup-score">${pair.score}%</span>
      </div>
      <div class="aj-dup-compare">
        <div class="aj-dup-side">
          <div class="aj-dup-username">${VP.esc(a['Parent Name'])}</div>
          <div class="aj-dup-detail">${VP.num((pair.variants_a || []).length)} variante(s)</div>
        </div>
        <div class="aj-dup-side">
          <div class="aj-dup-username">${VP.esc(b['Parent Name'])}</div>
          <div class="aj-dup-detail">${VP.num((pair.variants_b || []).length)} variante(s)</div>
        </div>
      </div>
      <div class="aj-dup-actions">
        <button class="refresh-btn org-prod-dismiss-btn">No son iguales</button>
        <button class="refresh-btn org-prod-review-btn" data-pair="${pairJson}">Revisar y fusionar</button>
      </div>
    </div>`;
  }

  async function handleProductDismiss(btn) {
    const pairEl = btn.closest('.aj-dup-pair');
    const idA = pairEl.dataset.a;
    const idB = pairEl.dataset.b;
    btn.disabled = true;
    btn.textContent = 'Descartando…';
    try {
      await VP.post({ action: 'dismiss_product_pair', parent_id_a: idA, parent_id_b: idB });
      pairEl.remove();
    } catch (e) {
      btn.disabled = false;
      btn.textContent = 'No son iguales';
      VP.toast('Error al descartar: ' + e.message, true);
    }
  }

  // ── Merge screen: pick keeper, then pair variants ──────────────────────

  function openProductMergeScreen(pair, onBack) {
    const modalRoot = document.getElementById('modal-container');
    const state = { keeper: 'a', pair: pair };

    modalRoot.innerHTML = `<div class="modal-overlay" id="org-prod-overlay">
      <div class="modal aj-merge-modal">
        <div class="modal-title">Fusionar productos</div>
        <div class="aj-merge-scroll" id="org-prod-merge-content"></div>
        <div class="modal-actions">
          <button class="btn" id="org-prod-back-btn">← Volver</button>
          <button class="refresh-btn" id="org-prod-confirm-btn">Confirmar fusión</button>
        </div>
      </div>
    </div>`;

    document.getElementById('org-prod-back-btn').addEventListener('click', () => (onBack || openProductDuplicatesModal)());
    document.getElementById('org-prod-confirm-btn').addEventListener('click', () => submitProductMerge(state));

    renderProductMergeScreen(state);
  }

  function renderProductMergeScreen(state) {
    const { pair, keeper } = state;
    const a = pair.parent_a, b = pair.parent_b;
    const keeperParent = keeper === 'a' ? a : b;
    const loserParent = keeper === 'a' ? b : a;
    const keeperVariants = keeper === 'a' ? pair.variants_a : pair.variants_b;
    const loserVariants = keeper === 'a' ? pair.variants_b : pair.variants_a;

    const suggestionByLoserCatalogId = {};
    (pair.suggested_variant_pairs || []).forEach(s => {
      suggestionByLoserCatalogId[s.b_catalog_id] = s.suggested_a_catalog_id;
    });

    const content = document.getElementById('org-prod-merge-content');
    content.innerHTML = `
      <div class="aj-prod-keeper-row">
        <div class="aj-prod-keeper-card ${keeper === 'a' ? 'is-selected' : 'is-unselected'}" data-side="a">
          <div class="aj-prod-keeper-name">${VP.esc(a['Parent Name'])}</div>
          <div class="aj-prod-keeper-hint">${VP.num((pair.variants_a || []).length)} variante(s)</div>
          ${keeper === 'a' ? '<div class="aj-prod-keeper-badge">Se mantiene</div>' : ''}
        </div>
        <div class="aj-prod-keeper-card ${keeper === 'b' ? 'is-selected' : 'is-unselected'}" data-side="b">
          <div class="aj-prod-keeper-name">${VP.esc(b['Parent Name'])}</div>
          <div class="aj-prod-keeper-hint">${VP.num((pair.variants_b || []).length)} variante(s)</div>
          ${keeper === 'b' ? '<div class="aj-prod-keeper-badge">Se mantiene</div>' : ''}
        </div>
      </div>
      <div class="aj-prod-variant-section-title">
        Empareja cada variante de «${VP.esc(loserParent['Parent Name'])}» con su equivalente en «${VP.esc(keeperParent['Parent Name'])}» (o déjala como única)
      </div>
      <div id="org-prod-variant-rows">
        ${loserVariants.map(lv => {
          const suggested = keeper === 'a' ? (suggestionByLoserCatalogId[lv['Catalog ID']] || '') : '';
          return `<div class="aj-prod-variant-row" data-lose-catalog-id="${VP.esc(lv['Catalog ID'])}">
            <div class="aj-prod-variant-name">${VP.esc(lv['Variant Name'] || '(sin nombre)')}</div>
            <div class="aj-prod-variant-arrow">→</div>
            <select class="aj-prod-variant-select">
              <option value="">— Única, no fusionar —</option>
              ${keeperVariants.map(kv => `<option value="${VP.esc(kv['Catalog ID'])}" ${kv['Catalog ID'] === suggested ? 'selected' : ''}>${VP.esc(kv['Variant Name'] || '(sin nombre)')}</option>`).join('')}
            </select>
          </div>`;
        }).join('')}
      </div>
      <div class="aj-prod-unmapped-note">
        Las variantes marcadas como "Única" se quedan tal cual, solo se moverán al producto que se mantiene. Las variantes de «${VP.esc(keeperParent['Parent Name'])}» que no aparecen arriba ya se consideran únicas automáticamente.
      </div>
    `;

    content.querySelectorAll('.aj-prod-keeper-card').forEach(card => {
      card.addEventListener('click', () => {
        state.keeper = card.dataset.side;
        renderProductMergeScreen(state);
      });
    });
  }

  async function submitProductMerge(state) {
    const { pair, keeper } = state;
    const keeperParent = keeper === 'a' ? pair.parent_a : pair.parent_b;
    const loserParent = keeper === 'a' ? pair.parent_b : pair.parent_a;

    const variantPairs = [];
    document.querySelectorAll('#org-prod-variant-rows .aj-prod-variant-row').forEach(row => {
      const loseCatalogId = row.dataset.loseCatalogId;
      const keepCatalogId = row.querySelector('.aj-prod-variant-select').value;
      if (keepCatalogId) {
        variantPairs.push({ keep_catalog_id: keepCatalogId, lose_catalog_id: loseCatalogId });
      }
    });

    const confirmBtn = document.getElementById('org-prod-confirm-btn');
    confirmBtn.disabled = true;
    confirmBtn.textContent = 'Fusionando…';

    try {
      const result = await VP.post({
        action: 'merge_products',
        keep_parent_id: keeperParent['Parent ID'],
        lose_parent_id: loserParent['Parent ID'],
        variant_pairs: variantPairs,
      });
      const content = document.getElementById('org-prod-merge-content');
      content.innerHTML = `
        <div class="aj-backfill-success">✓ Productos fusionados</div>
        <div class="aj-backfill-stats">
          <div class="aj-backfill-stat-row is-highlight">
            <span class="aj-backfill-stat-label">Variantes fusionadas</span>
            <span class="aj-backfill-stat-value">${VP.num(result.variants_merged)}</span>
          </div>
          <div class="aj-backfill-stat-row is-highlight">
            <span class="aj-backfill-stat-label">Variantes reasignadas (únicas)</span>
            <span class="aj-backfill-stat-value">${VP.num(result.variants_reassigned)}</span>
          </div>
          <div class="aj-backfill-stat-row">
            <span class="aj-backfill-stat-label">Pedidos actualizados</span>
            <span class="aj-backfill-stat-value">${VP.num(result.orders_repointed)}</span>
          </div>
        </div>
      `;
      document.querySelector('#org-prod-overlay .modal-actions').innerHTML =
        `<button class="btn" id="org-prod-close-btn">Cerrar</button>`;
      document.getElementById('org-prod-close-btn').addEventListener('click', () => {
        document.getElementById('modal-container').innerHTML = '';
      });
    } catch (e) {
      confirmBtn.disabled = false;
      confirmBtn.textContent = 'Confirmar fusión';
      VP.toast('Error al fusionar: ' + e.message, true);
    }
  }

  /* ── Manual search-and-pick (relocated from ajustes.js, unchanged) ───── */

  async function openManualProductSearchModal() {
    const modalRoot = document.getElementById('modal-container');
    modalRoot.innerHTML = `<div class="modal-overlay" id="org-manual-overlay">
      <div class="modal aj-merge-modal">
        <div class="modal-title">Buscar productos manualmente</div>
        <div class="aj-merge-scroll" id="org-manual-content">
          <div class="vp-loading">Cargando productos…</div>
        </div>
        <div class="modal-actions">
          <button class="btn" id="org-manual-close-btn">Cerrar</button>
        </div>
      </div>
    </div>`;
    document.getElementById('org-manual-close-btn').addEventListener('click', () => { modalRoot.innerHTML = ''; });

    const content = document.getElementById('org-manual-content');
    try {
      await VP.ensureToken();
      const data = await VP.get('action=search_products_for_merge');
      renderManualSearchForm(data.products || []);
    } catch (e) {
      content.innerHTML = `<div class="vp-empty-sm">Error al cargar productos: ${VP.esc(e.message)}</div>`;
    }
  }

  function renderManualSearchForm(products) {
    const content = document.getElementById('org-manual-content');
    const state = { productA: null, productB: null };

    content.innerHTML = `
      <div class="aj-prod-keeper-row">
        <div style="position:relative">
          <input type="text" class="aj-prod-variant-select" id="org-manual-input-a" placeholder="Buscar producto A…" autocomplete="off" style="width:100%">
          <div class="autocomplete-list" id="org-manual-list-a" style="display:none"></div>
        </div>
        <div style="position:relative">
          <input type="text" class="aj-prod-variant-select" id="org-manual-input-b" placeholder="Buscar producto B…" autocomplete="off" style="width:100%">
          <div class="autocomplete-list" id="org-manual-list-b" style="display:none"></div>
        </div>
      </div>
      <div id="org-manual-selection-summary" style="font-size:12.5px;color:var(--text-muted);min-height:20px;margin-bottom:10px"></div>
      <div style="display:flex;justify-content:flex-end">
        <button class="refresh-btn" id="org-manual-continue-btn" disabled>Continuar</button>
      </div>
    `;

    function renderList(side, inputEl, listEl) {
      const val = inputEl.value.trim().toLowerCase();
      const otherSide = side === 'a' ? state.productB : state.productA;
      if (!val) { listEl.style.display = 'none'; return; }

      const matches = products.filter(p => {
        if (otherSide && p.parent['Parent ID'] === otherSide.parent['Parent ID']) return false;
        return String(p.parent['Parent Name'] || '').toLowerCase().includes(val);
      }).slice(0, 10);

      if (!matches.length) { listEl.style.display = 'none'; return; }
      listEl.innerHTML = '';
      matches.forEach(p => {
        const item = document.createElement('div');
        item.className = 'autocomplete-item';
        item.innerHTML = `<span>${VP.esc(p.parent['Parent Name'])}</span><span style="color:var(--text-faint);font-size:11.5px">${VP.num(p.total_units_sold)} vendidos</span>`;
        item.addEventListener('mousedown', e => {
          e.preventDefault();
          if (side === 'a') state.productA = p; else state.productB = p;
          inputEl.value = p.parent['Parent Name'];
          listEl.style.display = 'none';
          updateManualState();
        });
        listEl.appendChild(item);
      });
      listEl.style.display = 'block';
    }

    function updateManualState() {
      const summary = document.getElementById('org-manual-selection-summary');
      const continueBtn = document.getElementById('org-manual-continue-btn');
      if (state.productA && state.productB) {
        summary.textContent = `${state.productA.parent['Parent Name']} (${VP.num(state.productA.total_units_sold)} vendidos) ↔ ${state.productB.parent['Parent Name']} (${VP.num(state.productB.total_units_sold)} vendidos)`;
        continueBtn.disabled = false;
      } else {
        summary.textContent = '';
        continueBtn.disabled = true;
      }
    }

    const inputA = document.getElementById('org-manual-input-a');
    const listA = document.getElementById('org-manual-list-a');
    const inputB = document.getElementById('org-manual-input-b');
    const listB = document.getElementById('org-manual-list-b');

    inputA.addEventListener('input', () => {
      if (state.productA && inputA.value !== state.productA.parent['Parent Name']) { state.productA = null; updateManualState(); }
      renderList('a', inputA, listA);
    });
    inputB.addEventListener('input', () => {
      if (state.productB && inputB.value !== state.productB.parent['Parent Name']) { state.productB = null; updateManualState(); }
      renderList('b', inputB, listB);
    });
    inputA.addEventListener('blur', () => setTimeout(() => { listA.style.display = 'none'; }, 150));
    inputB.addEventListener('blur', () => setTimeout(() => { listB.style.display = 'none'; }, 150));

    document.getElementById('org-manual-continue-btn').addEventListener('click', async () => {
      const btn = document.getElementById('org-manual-continue-btn');
      btn.disabled = true;
      btn.textContent = 'Cargando…';
      try {
        const data = await VP.get('action=manual_product_pair&parent_id_a=' + encodeURIComponent(state.productA.parent['Parent ID']) +
          '&parent_id_b=' + encodeURIComponent(state.productB.parent['Parent ID']));
        if (data.error) throw new Error(data.error);
        openProductMergeScreen(data.pair, openManualProductSearchModal);
      } catch (e) {
        btn.disabled = false;
        btn.textContent = 'Continuar';
        VP.toast('Error: ' + e.message, true);
      }
    });
  }

  /* ── Fusionar variantes del mismo producto ──────────────────────────────
     Step 1: pick a parent (same autocomplete pattern as the manual product
     search). Step 2: show its variants, pick two to merge -- the same
     keeper/loser card UI as the parent merger, but with no cross-parent
     repoint and no Parent Name sentinel. ────────────────────────────── */

  async function openVariantMergePicker() {
    const modalRoot = document.getElementById('modal-container');
    modalRoot.innerHTML = `<div class="modal-overlay" id="org-vm-overlay">
      <div class="modal aj-merge-modal">
        <div class="modal-title">Fusionar variantes del mismo producto</div>
        <div class="aj-merge-scroll" id="org-vm-content">
          <div class="vp-loading">Cargando productos…</div>
        </div>
        <div class="modal-actions">
          <button class="btn" id="org-vm-close-btn">Cerrar</button>
        </div>
      </div>
    </div>`;
    document.getElementById('org-vm-close-btn').addEventListener('click', () => { modalRoot.innerHTML = ''; });

    const content = document.getElementById('org-vm-content');
    try {
      await VP.ensureToken();
      const data = await VP.get('action=catalog_list');
      renderVariantMergeParentPicker((data.parents || []).filter(p => (p.variants || []).length >= 2));
    } catch (e) {
      content.innerHTML = `<div class="vp-empty-sm">Error al cargar productos: ${VP.esc(e.message)}</div>`;
    }
  }

  function renderVariantMergeParentPicker(parents) {
    const content = document.getElementById('org-vm-content');
    const state = { parent: null };

    content.innerHTML = `
      <div style="position:relative">
        <input type="text" class="aj-prod-variant-select" id="org-vm-input" placeholder="Buscar producto…" autocomplete="off" style="width:100%">
        <div class="autocomplete-list" id="org-vm-list" style="display:none"></div>
      </div>
    `;

    const input = document.getElementById('org-vm-input');
    const list = document.getElementById('org-vm-list');

    input.addEventListener('input', () => {
      const val = input.value.trim().toLowerCase();
      if (!val) { list.style.display = 'none'; return; }
      const matches = parents.filter(p => String(p.name || '').toLowerCase().includes(val)).slice(0, 10);
      if (!matches.length) { list.style.display = 'none'; return; }
      list.innerHTML = '';
      matches.forEach(p => {
        const item = document.createElement('div');
        item.className = 'autocomplete-item';
        item.innerHTML = `<span>${VP.esc(p.name)}</span><span style="color:var(--text-faint);font-size:11.5px">${VP.num((p.variants || []).length)} variante(s)</span>`;
        item.addEventListener('mousedown', e => {
          e.preventDefault();
          list.style.display = 'none';
          openVariantMergeScreen(p);
        });
        list.appendChild(item);
      });
      list.style.display = 'block';
    });
    input.addEventListener('blur', () => setTimeout(() => { list.style.display = 'none'; }, 150));
  }

  function openVariantMergeScreen(parent) {
    const state = { parent: parent, keep: null, lose: null };
    renderVariantMergeScreen(state);
  }

  function renderVariantMergeScreen(state) {
    const content = document.getElementById('org-vm-content');
    const variants = state.parent.variants || [];

    content.innerHTML = `
      <div class="aj-prod-variant-section-title">
        Variantes de «${VP.esc(state.parent.name)}» -- elige las dos que son la misma
      </div>
      <div id="org-vm-variant-list">
        ${variants.map(v => `
          <div class="aj-history-row" data-catalog-id="${VP.esc(v.catalog_id)}" style="cursor:pointer">
            <div class="aj-history-main">
              <span>${VP.esc(v.variant_name || '(sin nombre)')}</span>
              <span class="aj-row-hint">${VP.esc(v.sku || '')}</span>
            </div>
            <span class="status-pill org-vm-role-pill" style="background:var(--surface2);color:var(--text-faint)">—</span>
          </div>
        `).join('')}
      </div>
      <div style="font-size:12.5px;color:var(--text-muted);margin:10px 0" id="org-vm-summary">Toca una variante para marcarla "Se mantiene", luego otra para marcarla "Se fusiona".</div>
      <div style="display:flex;justify-content:flex-end;gap:8px">
        <button class="btn" id="org-vm-back-btn">← Elegir otro producto</button>
        <button class="refresh-btn" id="org-vm-confirm-btn" disabled>Confirmar fusión</button>
      </div>
    `;

    function updateRoles() {
      content.querySelectorAll('#org-vm-variant-list .aj-history-row').forEach(row => {
        const cid = row.dataset.catalogId;
        const pill = row.querySelector('.org-vm-role-pill');
        if (cid === state.keep) {
          pill.textContent = 'Se mantiene';
          pill.style.background = 'var(--green-bg)'; pill.style.color = 'var(--green-text)';
        } else if (cid === state.lose) {
          pill.textContent = 'Se fusiona';
          pill.style.background = 'var(--amber-bg)'; pill.style.color = 'var(--amber-text)';
        } else {
          pill.textContent = '—';
          pill.style.background = 'var(--surface2)'; pill.style.color = 'var(--text-faint)';
        }
      });
      document.getElementById('org-vm-confirm-btn').disabled = !(state.keep && state.lose);
      document.getElementById('org-vm-summary').textContent = state.keep && state.lose
        ? 'Listo para fusionar.' : 'Toca una variante para marcarla "Se mantiene", luego otra para marcarla "Se fusiona".';
    }

    content.querySelectorAll('#org-vm-variant-list .aj-history-row').forEach(row => {
      row.addEventListener('click', () => {
        const cid = row.dataset.catalogId;
        if (cid === state.keep) { state.keep = null; }
        else if (cid === state.lose) { state.lose = null; }
        else if (!state.keep) { state.keep = cid; }
        else if (!state.lose && cid !== state.keep) { state.lose = cid; }
        else { state.lose = cid; } // replace the losing pick if both already set
        updateRoles();
      });
    });

    document.getElementById('org-vm-back-btn').addEventListener('click', openVariantMergePicker);
    document.getElementById('org-vm-confirm-btn').addEventListener('click', () => submitVariantMerge(state));
  }

  async function submitVariantMerge(state) {
    const btn = document.getElementById('org-vm-confirm-btn');
    btn.disabled = true;
    btn.textContent = 'Fusionando…';
    try {
      const result = await VP.post({
        action: 'merge_variants_within_parent',
        parent_id: state.parent.parent_id,
        keep_catalog_id: state.keep,
        lose_catalog_id: state.lose,
      });
      const content = document.getElementById('org-vm-content');
      content.innerHTML = `
        <div class="aj-backfill-success">✓ Variantes fusionadas</div>
        <div class="aj-backfill-stats">
          <div class="aj-backfill-stat-row">
            <span class="aj-backfill-stat-label">Pedidos actualizados</span>
            <span class="aj-backfill-stat-value">${VP.num(result.orders_repointed)}</span>
          </div>
        </div>
      `;
      document.querySelector('#org-vm-overlay .modal-actions').innerHTML = `<button class="btn" id="org-vm-close-btn2">Cerrar</button>`;
      document.getElementById('org-vm-close-btn2').addEventListener('click', () => {
        document.getElementById('modal-container').innerHTML = '';
      });
    } catch (e) {
      btn.disabled = false;
      btn.textContent = 'Confirmar fusión';
      VP.toast('Error al fusionar: ' + e.message, true);
    }
  }

  /* ── Categorías ──────────────────────────────────────────────────────── */

  async function fetchCategories() {
    const data = await VP.get('action=product_categories');
    return data.categories || [];
  }

  // Bulk-assign: pick products (same autocomplete-list pattern as the
  // variant-merge picker), pick a category, apply to all selected at once.
  async function openBulkCategoryModal() {
    const modalRoot = document.getElementById('modal-container');
    modalRoot.innerHTML = `<div class="modal-overlay" id="org-cat-overlay">
      <div class="modal aj-merge-modal">
        <div class="modal-title">Asignar categoría en bloque</div>
        <div class="aj-merge-scroll" id="org-cat-content">
          <div class="vp-loading">Cargando…</div>
        </div>
        <div class="modal-actions">
          <button class="btn" id="org-cat-close-btn">Cerrar</button>
        </div>
      </div>
    </div>`;
    document.getElementById('org-cat-close-btn').addEventListener('click', () => { modalRoot.innerHTML = ''; });

    const content = document.getElementById('org-cat-content');
    try {
      await VP.ensureToken();
      const [catalogData, categories] = await Promise.all([VP.get('action=catalog_list'), fetchCategories()]);
      renderBulkCategoryForm(catalogData.parents || [], categories);
    } catch (e) {
      content.innerHTML = `<div class="vp-empty-sm">Error al cargar: ${VP.esc(e.message)}</div>`;
    }
  }

  function renderBulkCategoryForm(parents, categories) {
    const content = document.getElementById('org-cat-content');
    const state = { selected: new Map() }; // parent_id -> name

    if (!categories.length) {
      content.innerHTML = '<div class="vp-empty-sm">No hay categorías. Usa «Editar categorías» primero.</div>';
      return;
    }

    content.innerHTML = `
      <div style="position:relative;margin-bottom:10px">
        <input type="text" class="aj-prod-variant-select" id="org-cat-search" placeholder="Buscar producto…" autocomplete="off" style="width:100%">
        <div class="autocomplete-list" id="org-cat-search-list" style="display:none"></div>
      </div>
      <div id="org-cat-selected-list" style="margin-bottom:12px"></div>
      <div style="display:flex;gap:8px;align-items:center;margin-bottom:4px">
        <select class="sort-select" id="org-cat-select" style="flex:1">
          <option value="">— Elige categoría —</option>
          ${categories.map(c => `<option value="${VP.esc(c)}">${VP.esc(c)}</option>`).join('')}
        </select>
        <button class="refresh-btn" id="org-cat-apply-btn" disabled>Aplicar</button>
      </div>
    `;

    function renderSelected() {
      const el = document.getElementById('org-cat-selected-list');
      if (!state.selected.size) {
        el.innerHTML = '<div class="aj-row-hint">Ningún producto seleccionado todavía.</div>';
      } else {
        el.innerHTML = Array.from(state.selected.entries()).map(([pid, name]) =>
          `<div class="aj-history-row" data-pid="${VP.esc(pid)}">
            <span>${VP.esc(name)}</span>
            <button class="ls-mini org-cat-remove-btn">Quitar</button>
          </div>`).join('');
        el.querySelectorAll('.org-cat-remove-btn').forEach(btn => btn.addEventListener('click', () => {
          state.selected.delete(btn.closest('.aj-history-row').dataset.pid);
          renderSelected();
        }));
      }
      document.getElementById('org-cat-apply-btn').disabled = !(state.selected.size && document.getElementById('org-cat-select').value);
    }

    const search = document.getElementById('org-cat-search');
    const list = document.getElementById('org-cat-search-list');
    search.addEventListener('input', () => {
      const val = search.value.trim().toLowerCase();
      if (!val) { list.style.display = 'none'; return; }
      const matches = parents.filter(p => !state.selected.has(p.parent_id) && String(p.name || '').toLowerCase().includes(val)).slice(0, 10);
      if (!matches.length) { list.style.display = 'none'; return; }
      list.innerHTML = '';
      matches.forEach(p => {
        const item = document.createElement('div');
        item.className = 'autocomplete-item';
        item.textContent = p.name;
        item.addEventListener('mousedown', e => {
          e.preventDefault();
          state.selected.set(p.parent_id, p.name);
          search.value = '';
          list.style.display = 'none';
          renderSelected();
        });
        list.appendChild(item);
      });
      list.style.display = 'block';
    });
    search.addEventListener('blur', () => setTimeout(() => { list.style.display = 'none'; }, 150));

    document.getElementById('org-cat-select').addEventListener('change', renderSelected);

    document.getElementById('org-cat-apply-btn').addEventListener('click', async () => {
      const btn = document.getElementById('org-cat-apply-btn');
      const category = document.getElementById('org-cat-select').value;
      btn.disabled = true;
      btn.textContent = 'Aplicando…';
      try {
        const r = await VP.post({ action: 'set_product_category', parent_ids: Array.from(state.selected.keys()), category: category });
        VP.toast(`Categoría «${category}» aplicada a ${r.updated} producto(s)`);
        document.getElementById('modal-container').innerHTML = '';
      } catch (e) {
        btn.disabled = false;
        btn.textContent = 'Aplicar';
        VP.toast('Error: ' + e.message, true);
      }
    });

    renderSelected();
  }

  // Manage list: add / rename / delete, then one save_product_categories call.
  async function openManageCategoriesModal() {
    const modalRoot = document.getElementById('modal-container');
    modalRoot.innerHTML = `<div class="modal-overlay" id="org-catmgr-overlay">
      <div class="modal aj-merge-modal">
        <div class="modal-title">Editar categorías</div>
        <div class="aj-merge-scroll" id="org-catmgr-content">
          <div class="vp-loading">Cargando…</div>
        </div>
        <div class="modal-actions">
          <button class="btn" id="org-catmgr-close-btn">Cerrar</button>
          <button class="refresh-btn" id="org-catmgr-save-btn">Guardar cambios</button>
        </div>
      </div>
    </div>`;
    document.getElementById('org-catmgr-close-btn').addEventListener('click', () => { modalRoot.innerHTML = ''; });

    let categories;
    try {
      await VP.ensureToken();
      categories = await fetchCategories();
    } catch (e) {
      document.getElementById('org-catmgr-content').innerHTML = `<div class="vp-empty-sm">Error al cargar: ${VP.esc(e.message)}</div>`;
      return;
    }
    renderManageCategories(categories.slice());
  }

  function renderManageCategories(categories) {
    const content = document.getElementById('org-catmgr-content');

    function row(name, idx) {
      return `<div class="aj-history-row" data-idx="${idx}">
        <input type="text" class="aj-prod-variant-select org-catmgr-input" value="${VP.esc(name)}" style="flex:1;margin-right:8px">
        <button class="ls-mini org-catmgr-del-btn">Eliminar</button>
      </div>`;
    }

    function renderList() {
      content.innerHTML = `<div id="org-catmgr-list">${categories.map(row).join('')}</div>
        <button class="ls-mini" id="org-catmgr-add-btn" style="margin-top:10px">+ Agregar categoría</button>`;

      content.querySelectorAll('.org-catmgr-input').forEach(inp => inp.addEventListener('input', () => {
        const idx = Number(inp.closest('.aj-history-row').dataset.idx);
        categories[idx] = inp.value;
      }));
      content.querySelectorAll('.org-catmgr-del-btn').forEach(btn => btn.addEventListener('click', () => {
        const idx = Number(btn.closest('.aj-history-row').dataset.idx);
        categories.splice(idx, 1);
        renderList();
      }));
      document.getElementById('org-catmgr-add-btn').addEventListener('click', () => {
        categories.push('');
        renderList();
      });
    }
    renderList();

    document.getElementById('org-catmgr-save-btn').addEventListener('click', async () => {
      const btn = document.getElementById('org-catmgr-save-btn');
      const clean = categories.map(c => String(c || '').trim()).filter(Boolean);
      if (!clean.length) { VP.toast('La lista no puede quedar vacía', true); return; }
      btn.disabled = true;
      btn.textContent = 'Guardando…';
      try {
        await VP.post({ action: 'save_product_categories', categories: clean });
        VP.toast('Categorías guardadas');
        document.getElementById('modal-container').innerHTML = '';
      } catch (e) {
        btn.disabled = false;
        btn.textContent = 'Guardar cambios';
        VP.toast('Error: ' + e.message, true);
      }
    });
  }

  /* ── Edición masiva de atributos ─────────────────────────────────────── */

  const ORG_BULK_ATTR_FIELDS = ['Stock', 'Low Stock At', 'Barcode', 'Image URL'];

  async function openBulkAttrsModal() {
    const modalRoot = document.getElementById('modal-container');
    modalRoot.innerHTML = `<div class="modal-overlay" id="org-attrs-overlay">
      <div class="modal aj-merge-modal">
        <div class="modal-title">Edición masiva de atributos</div>
        <div class="aj-merge-scroll" id="org-attrs-content">
          <div class="vp-loading">Cargando…</div>
        </div>
        <div class="modal-actions">
          <button class="btn" id="org-attrs-close-btn">Cerrar</button>
        </div>
      </div>
    </div>`;
    document.getElementById('org-attrs-close-btn').addEventListener('click', () => { modalRoot.innerHTML = ''; });

    const content = document.getElementById('org-attrs-content');
    try {
      await VP.ensureToken();
      const data = await VP.get('action=catalog_list');
      const variants = [];
      (data.parents || []).forEach(p => (p.variants || []).forEach(v => variants.push(Object.assign({ parent_name: p.name }, v))));
      renderBulkAttrsForm(variants);
    } catch (e) {
      content.innerHTML = `<div class="vp-empty-sm">Error al cargar: ${VP.esc(e.message)}</div>`;
    }
  }

  function renderBulkAttrsForm(variants) {
    const content = document.getElementById('org-attrs-content');
    const state = { selected: new Map() }; // catalog_id -> label

    content.innerHTML = `
      <div style="position:relative;margin-bottom:10px">
        <input type="text" class="aj-prod-variant-select" id="org-attrs-search" placeholder="Buscar variante…" autocomplete="off" style="width:100%">
        <div class="autocomplete-list" id="org-attrs-search-list" style="display:none"></div>
      </div>
      <div id="org-attrs-selected-list" style="margin-bottom:12px"></div>
      <div class="aj-prod-variant-section-title">Solo rellena los campos que quieras cambiar -- se aplican a todas las variantes seleccionadas</div>
      <div id="org-attrs-fields" style="display:flex;flex-direction:column;gap:8px;margin:10px 0"></div>
      <div style="display:flex;justify-content:flex-end">
        <button class="refresh-btn" id="org-attrs-apply-btn" disabled>Aplicar a seleccionadas</button>
      </div>
    `;

    document.getElementById('org-attrs-fields').innerHTML = ORG_BULK_ATTR_FIELDS.map(f =>
      `<label style="display:flex;flex-direction:column;gap:3px;font-size:12px;color:var(--text-muted)">
        ${VP.esc(f)}
        <input type="text" class="aj-prod-variant-select" data-field="${VP.esc(f)}" placeholder="(sin cambios)">
      </label>`).join('');

    function renderSelected() {
      const el = document.getElementById('org-attrs-selected-list');
      if (!state.selected.size) {
        el.innerHTML = '<div class="aj-row-hint">Ninguna variante seleccionada todavía.</div>';
      } else {
        el.innerHTML = Array.from(state.selected.entries()).map(([cid, label]) =>
          `<div class="aj-history-row" data-cid="${VP.esc(cid)}">
            <span>${VP.esc(label)}</span>
            <button class="ls-mini org-attrs-remove-btn">Quitar</button>
          </div>`).join('');
        el.querySelectorAll('.org-attrs-remove-btn').forEach(btn => btn.addEventListener('click', () => {
          state.selected.delete(btn.closest('.aj-history-row').dataset.cid);
          renderSelected();
        }));
      }
      updateApplyState();
    }

    function updateApplyState() {
      const anyField = Array.from(document.querySelectorAll('#org-attrs-fields input')).some(i => i.value.trim() !== '');
      document.getElementById('org-attrs-apply-btn').disabled = !(state.selected.size && anyField);
    }
    document.querySelectorAll('#org-attrs-fields input').forEach(i => i.addEventListener('input', updateApplyState));

    const search = document.getElementById('org-attrs-search');
    const list = document.getElementById('org-attrs-search-list');
    search.addEventListener('input', () => {
      const val = search.value.trim().toLowerCase();
      if (!val) { list.style.display = 'none'; return; }
      const matches = variants.filter(v => !state.selected.has(v.catalog_id) &&
        (String(v.variant_name || '').toLowerCase().includes(val) || String(v.parent_name || '').toLowerCase().includes(val) || String(v.sku || '').toLowerCase().includes(val))
      ).slice(0, 10);
      if (!matches.length) { list.style.display = 'none'; return; }
      list.innerHTML = '';
      matches.forEach(v => {
        const label = `${v.parent_name} -- ${v.variant_name || '(sin nombre)'}`;
        const item = document.createElement('div');
        item.className = 'autocomplete-item';
        item.textContent = label;
        item.addEventListener('mousedown', e => {
          e.preventDefault();
          state.selected.set(v.catalog_id, label);
          search.value = '';
          list.style.display = 'none';
          renderSelected();
        });
        list.appendChild(item);
      });
      list.style.display = 'block';
    });
    search.addEventListener('blur', () => setTimeout(() => { list.style.display = 'none'; }, 150));

    document.getElementById('org-attrs-apply-btn').addEventListener('click', async () => {
      const btn = document.getElementById('org-attrs-apply-btn');
      const fields = {};
      document.querySelectorAll('#org-attrs-fields input').forEach(i => {
        const v = i.value.trim();
        if (v !== '') fields[i.dataset.field] = v;
      });
      btn.disabled = true;
      btn.textContent = 'Aplicando…';
      try {
        const r = await VP.post({ action: 'catalog_set_fields_bulk', catalog_ids: Array.from(state.selected.keys()), fields: fields });
        VP.toast(`Aplicado a ${r.updated} variante(s)`);
        document.getElementById('modal-container').innerHTML = '';
      } catch (e) {
        btn.disabled = false;
        btn.textContent = 'Aplicar a seleccionadas';
        VP.toast('Error: ' + e.message, true);
      }
    });

    renderSelected();
  }

  /* ── Historial (fusiones de productos y variantes, con deshacer) ────────
     Same source (product_merge_history) as the old Ajustes screen. Kept
     Parent ID === Merged Parent ID in a record means it was a within-
     parent variant merge, so its "Deshacer" button calls the matching
     undo action instead of undo_product_merge. ─────────────────────── */

  async function openOrgMergeHistoryModal() {
    const modalRoot = document.getElementById('modal-container');
    modalRoot.innerHTML = `<div class="modal-overlay" id="org-hist-overlay">
      <div class="modal aj-merge-modal">
        <div class="modal-title">Historial de fusiones</div>
        <div class="aj-merge-scroll" id="org-hist-content">
          <div class="vp-loading">Cargando…</div>
        </div>
        <div class="modal-actions">
          <button class="btn" id="org-hist-close-btn">Cerrar</button>
        </div>
      </div>
    </div>`;
    document.getElementById('org-hist-close-btn').addEventListener('click', () => { modalRoot.innerHTML = ''; });

    const content = document.getElementById('org-hist-content');
    let records;
    try {
      await VP.ensureToken();
      records = (await VP.get('action=product_merge_history')).records || [];
    } catch (e) {
      content.innerHTML = `<div class="vp-empty-sm">No se pudo cargar: ${VP.esc(e.message)}</div>`;
      return;
    }
    if (!records.length) { content.innerHTML = '<div class="vp-empty-sm">Todavía no se ha fusionado ningún producto.</div>'; return; }

    const dateOf = r => r['Merged Date'] || r['Merge Date'] || r['Date'] || '';
    records.sort((a, b) => String(dateOf(b)).localeCompare(String(dateOf(a))));
    content.innerHTML = records.map(r => {
      const withinParent = String(r['Kept Parent ID']) === String(r['Merged Parent ID']);
      const undone = r['Status'] && r['Status'] !== 'Activo';
      const right = undone
        ? `<span class="status-pill" style="background:var(--surface2);color:var(--text-faint)">${VP.esc(r['Status'])}</span>`
        : `<button class="refresh-btn org-hist-undo-btn" data-merge-id="${VP.esc(r['Merge ID'])}" data-within="${withinParent ? '1' : '0'}">Deshacer</button>`;
      return `<div class="aj-history-row">
        <div class="aj-history-main" style="flex-direction:column;align-items:flex-start;gap:2px">
          <span class="aj-history-arrow">${VP.esc(r['Merged Parent Name'] || r['Merged Parent ID'])} → ${VP.esc(r['Kept Parent Name'] || r['Kept Parent ID'])}${withinParent ? ' (misma producto)' : ''}</span>
          <span class="aj-history-date">${VP.esc(VP.fmtDateTime(dateOf(r)))}${r['Orders Repointed'] !== undefined && r['Orders Repointed'] !== '' ? ' · ' + VP.num(r['Orders Repointed']) + ' pedidos movidos' : ''}</span>
        </div>
        ${right}
      </div>`;
    }).join('');

    content.querySelectorAll('.org-hist-undo-btn').forEach(btn => btn.addEventListener('click', async () => {
      if (!confirm('¿Deshacer esta fusión? Los pedidos vuelven a apuntar al original.')) return;
      const within = btn.dataset.within === '1';
      btn.disabled = true; btn.textContent = 'Deshaciendo…';
      try {
        await VP.post({ action: within ? 'undo_variant_merge_within_parent' : 'undo_product_merge', merge_id: btn.dataset.mergeId });
        btn.closest('.aj-history-row').outerHTML = '<div class="aj-history-row" style="color:var(--green-text);font-size:13px">✓ Fusión deshecha</div>';
      } catch (e) {
        btn.disabled = false; btn.textContent = 'Deshacer';
        VP.toast('No se pudo deshacer: ' + e.message, true);
      }
    }));
  }

  return { render };
})();
