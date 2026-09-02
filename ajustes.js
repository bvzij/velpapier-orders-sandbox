/* ============================================================================
   ajustes.js — Settings page: theme preference + duplicate-customer tool.
   ==========================================================================*/

(function initTheme() {
  const buttons = document.querySelectorAll('#aj-theme-toggle .vp-period-btn');
  function reflect() {
    const current = VP.getTheme();
    buttons.forEach(b => b.classList.toggle('is-active', b.dataset.theme === current));
  }
  buttons.forEach(b => {
    b.addEventListener('click', () => {
      VP.setTheme(b.dataset.theme);
      reflect();
    });
  });
  reflect();
})();

document.getElementById('aj-scan-duplicates').addEventListener('click', openDuplicatesModal);

async function openDuplicatesModal() {
  const modalRoot = document.getElementById('modal-container');
  modalRoot.innerHTML = `<div class="modal-overlay" id="modal-overlay">
    <div class="modal aj-merge-modal">
      <div class="modal-title">Clientes duplicados</div>
      <div class="aj-merge-scroll" id="aj-duplicates-content">
        <div class="vp-loading">Comparando clientes, puede tardar un momento…</div>
      </div>
      <div class="modal-actions">
        <button class="btn" id="aj-merge-history-btn">Ver historial</button>
        <button class="btn" id="aj-merge-close-btn">Cerrar</button>
      </div>
    </div>
  </div>`;

  document.getElementById('aj-merge-close-btn').addEventListener('click', () => { modalRoot.innerHTML = ''; });
  document.getElementById('aj-merge-history-btn').addEventListener('click', openMergeHistoryModal);
  document.getElementById('modal-overlay').addEventListener('click', e => {
    if (e.target.id === 'modal-overlay') modalRoot.innerHTML = '';
  });

  try {
    await VP.ensureToken();
    const data = await VP.get('action=find_duplicate_customers');
    renderDuplicates(data.pairs || []);
  } catch (e) {
    document.getElementById('aj-duplicates-content').innerHTML =
      `<div class="vp-empty-sm">Error al buscar duplicados: ${VP.esc(e.message)}</div>`;
  }
}

function renderDuplicates(pairs) {
  const content = document.getElementById('aj-duplicates-content');

  if (!pairs.length) {
    content.innerHTML = '<div class="vp-empty-sm">No se encontraron duplicados probables.</div>';
    return;
  }

  content.innerHTML = `<div style="font-size:12px;color:var(--text-muted);margin-bottom:10px">
    ${VP.num(pairs.length)} par${pairs.length !== 1 ? 'es' : ''} probable${pairs.length !== 1 ? 's' : ''} encontrado${pairs.length !== 1 ? 's' : ''}
  </div>` + pairs.map(pairHtml).join('');

  content.querySelectorAll('.aj-dup-merge-btn').forEach(el => {
    el.addEventListener('click', () => handleMerge(el));
  });
  content.querySelectorAll('.aj-dup-dismiss-btn').forEach(el => {
    el.addEventListener('click', () => el.closest('.aj-dup-pair').remove());
  });
}

function customerDetailHtml(c) {
  const lines = [
    c['Phone Full'] || c['Phone Partial'] || '',
    [c['Street + Number'], c['City'], c['State']].filter(Boolean).join(', '),
    c['ZIP'] || '',
    c['Aliases'] ? `Alias: ${c['Aliases']}` : '',
  ].filter(Boolean);
  return lines.map(l => VP.esc(l)).join('<br>');
}

function pairHtml(pair) {
  const a = pair.customer_a, b = pair.customer_b;
  return `<div class="aj-dup-pair" data-a="${VP.esc(a['Customer ID'])}" data-b="${VP.esc(b['Customer ID'])}">
    <div class="aj-dup-header">
      <span>Coincidencia probable</span>
      <span class="aj-dup-score">${pair.score}%</span>
    </div>
    <div class="aj-dup-compare">
      <div class="aj-dup-side">
        <div class="aj-dup-username">${VP.esc(a['Primary Username'] || a['Customer ID'])}</div>
        <div class="aj-dup-detail">${customerDetailHtml(a)}</div>
      </div>
      <div class="aj-dup-side">
        <div class="aj-dup-username">${VP.esc(b['Primary Username'] || b['Customer ID'])}</div>
        <div class="aj-dup-detail">${customerDetailHtml(b)}</div>
      </div>
    </div>
    <div class="aj-dup-actions">
      <button class="refresh-btn aj-dup-dismiss-btn">No son iguales</button>
      <button class="refresh-btn aj-dup-merge-btn" data-keep="a">Usar «${VP.esc(a['Primary Username'] || a['Customer ID'])}» como principal</button>
      <button class="refresh-btn aj-dup-merge-btn" data-keep="b">Usar «${VP.esc(b['Primary Username'] || b['Customer ID'])}» como principal</button>
    </div>
  </div>`;
}

async function handleMerge(btn) {
  const pairEl = btn.closest('.aj-dup-pair');
  const idA = pairEl.dataset.a;
  const idB = pairEl.dataset.b;
  const keepId = btn.dataset.keep === 'a' ? idA : idB;
  const loseId = btn.dataset.keep === 'a' ? idB : idA;

  pairEl.querySelectorAll('button').forEach(b => { b.disabled = true; });
  btn.textContent = 'Fusionando…';

  try {
    await VP.post({ action: 'merge_customers', keep_id: keepId, merge_id: loseId });
    pairEl.style.opacity = '0.5';
    pairEl.innerHTML = `<div style="padding:12px;font-size:13px;color:var(--green-text)">✓ Fusionado correctamente</div>`;
  } catch (e) {
    pairEl.querySelectorAll('button').forEach(b => { b.disabled = false; });
    btn.textContent = 'Error, intenta de nuevo';
  }
}

/* ── Merge history + undo ──────────────────────────────────────────── */

async function openMergeHistoryModal() {
  const modalRoot = document.getElementById('modal-container');
  modalRoot.innerHTML = `<div class="modal-overlay" id="modal-overlay-history">
    <div class="modal aj-merge-modal">
      <div class="modal-title">Historial de fusiones</div>
      <div class="aj-merge-scroll" id="aj-history-content">
        <div class="vp-loading">Cargando historial…</div>
      </div>
      <div class="modal-actions">
        <button class="btn" id="aj-history-close-btn">Cerrar</button>
      </div>
    </div>
  </div>`;

  document.getElementById('aj-history-close-btn').addEventListener('click', () => { modalRoot.innerHTML = ''; });
  document.getElementById('modal-overlay-history').addEventListener('click', e => {
    if (e.target.id === 'modal-overlay-history') modalRoot.innerHTML = '';
  });

  try {
    const data = await VP.get('action=merge_history');
    renderMergeHistory(data.records || []);
  } catch (e) {
    document.getElementById('aj-history-content').innerHTML =
      `<div class="vp-empty-sm">Error al cargar historial: ${VP.esc(e.message)}</div>`;
  }
}

function renderMergeHistory(records) {
  const el = document.getElementById('aj-history-content');
  if (!records.length) {
    el.innerHTML = '<div class="vp-empty-sm">Todavía no se ha fusionado ningún cliente.</div>';
    return;
  }

  // Most recent first
  records.sort((a, b) => String(b['Merged Date'] || '').localeCompare(String(a['Merged Date'] || '')));

  el.innerHTML = records.map(r => {
    const undone = r['Status'] === 'Deshecho';
    return `<div class="aj-history-row" data-merge-id="${VP.esc(r['Merge ID'])}">
      <div class="aj-history-main">
        <span class="aj-history-arrow">${VP.esc(r['Merged Username'] || r['Merged Customer ID'])} → ${VP.esc(r['Kept Username'] || r['Kept Customer ID'])}</span>
        <span class="aj-history-date">${VP.esc(VP.fmtDateTime ? VP.fmtDateTime(r['Merged Date']) : r['Merged Date'])}</span>
      </div>
            ${undone
        ? `<span class="status-pill" style="background:var(--surface2);color:var(--text-faint)">Deshecho</span>`
        : `<div style="display:flex;gap:6px">
            <button class="refresh-btn aj-undo-btn" data-merge-id="${VP.esc(r['Merge ID'])}">Deshacer</button>
            <button class="refresh-btn aj-cleanup-btn" data-merge-id="${VP.esc(r['Merge ID'])}">Limpiar</button>
          </div>`}
    </div>`;
  }).join('');

  el.querySelectorAll('.aj-undo-btn').forEach(btn => {
    btn.addEventListener('click', () => handleUndo(btn));
  });
  el.querySelectorAll('.aj-cleanup-btn').forEach(btn => {
    btn.addEventListener('click', () => handleCleanup(btn));
  });
}

async function handleCleanup(btn) {
  const mergeId = btn.dataset.mergeId;
  if (!confirm('Esto borra permanentemente el registro del cliente fusionado. No se puede deshacer después. ¿Continuar?')) return;
  btn.disabled = true;
  btn.textContent = 'Borrando…';
  try {
    await VP.post({ action: 'delete_merged_customer', merge_id: mergeId });
    btn.closest('.aj-history-row').outerHTML =
      `<div class="aj-history-row" style="color:var(--green-text);font-size:13px">✓ Cliente fusionado eliminado permanentemente</div>`;
  } catch (e) {
    btn.disabled = false;
    btn.textContent = 'Error, intenta de nuevo';
  }
}

async function handleUndo(btn) {
  const mergeId = btn.dataset.mergeId;
  btn.disabled = true;
  btn.textContent = 'Deshaciendo…';
  try {
    await VP.post({ action: 'undo_merge', merge_id: mergeId });
    btn.closest('.aj-history-row').outerHTML =
      `<div class="aj-history-row" style="color:var(--green-text);font-size:13px">✓ Fusión deshecha</div>`;
  } catch (e) {
    btn.disabled = false;
    btn.textContent = 'Error, intenta de nuevo';
  }
}
