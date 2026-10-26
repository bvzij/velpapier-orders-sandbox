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
    // Screens below (variant merge, categories, bulk attrs, history) are
    // wired in their own stages -- see the matching bind() calls appended
    // there.
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

  return { render };
})();
