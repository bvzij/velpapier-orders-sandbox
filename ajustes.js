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

const AJ_DUP_DEFAULT_THRESHOLD = 55;

async function openDuplicatesModal() {
  const modalRoot = document.getElementById('modal-container');
  modalRoot.innerHTML = `<div class="modal-overlay" id="modal-overlay">
    <div class="modal aj-merge-modal">
      <div class="modal-title">Clientes duplicados</div>
      <div class="aj-dup-threshold-row">
        <span class="aj-dup-threshold-label">Umbral</span>
        <input type="range" id="aj-dup-threshold-slider" min="0" max="100" step="1" value="${AJ_DUP_DEFAULT_THRESHOLD}">
        <span class="aj-dup-threshold-value" id="aj-dup-threshold-value">${AJ_DUP_DEFAULT_THRESHOLD}%</span>
        <button class="btn aj-dup-refresh-btn" id="aj-dup-refresh-btn" title="Buscar de nuevo con este umbral" aria-label="Actualizar">↻</button>
      </div>
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

  const slider = document.getElementById('aj-dup-threshold-slider');
  const valueLabel = document.getElementById('aj-dup-threshold-value');
  slider.addEventListener('input', () => { valueLabel.textContent = slider.value + '%'; });
  document.getElementById('aj-dup-refresh-btn').addEventListener('click', () => {
    loadDuplicates(parseInt(slider.value, 10));
  });

  await loadDuplicates(AJ_DUP_DEFAULT_THRESHOLD);
}

async function loadDuplicates(threshold) {
  const content = document.getElementById('aj-duplicates-content');
  content.innerHTML = '<div class="vp-loading">Comparando clientes, puede tardar un momento…</div>';
  try {
    await VP.ensureToken();
    const data = await VP.get('action=find_duplicate_customers&threshold=' + threshold);
    renderDuplicates(data.pairs || []);
  } catch (e) {
    content.innerHTML = `<div class="vp-empty-sm">Error al buscar duplicados: ${VP.esc(e.message)}</div>`;
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
    el.addEventListener('click', () => handleDismiss(el));
  });
  content.querySelectorAll('.aj-dup-expand-btn').forEach(el => {
    el.addEventListener('click', () => {
      const expanded = el.nextElementSibling;
      const isOpen = expanded.style.display === 'block';
      expanded.style.display = isOpen ? 'none' : 'block';
      el.setAttribute('aria-expanded', String(!isOpen));
      el.textContent = isOpen ? 'Ver más ▾' : 'Ver menos ▴';
    });
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

// Every field the expanded view shows, top to bottom, as aligned rows so a
// value present on one side but not the other still lines up correctly.
// Deliberately includes fields already visible in the collapsed card above
// (phone, address, aliases) -- repeating them here means everything about
// both customers is visible in one place without scrolling back up.
const AJ_DUP_EXTRA_FIELDS = [
  ['Customer ID',            'ID'],
  ['Primary Username',       'Usuario'],
  ['First Name',             'Nombre'],
  ['Surname',                'Apellido'],
  ['Initials (TT Format)',   'Iniciales'],
  ['Email',                  'Email'],
  ['Phone Partial',          'Tel. parcial'],
  ['Phone Full',             'Tel. completo'],
  ['Street + Number',        'Calle y número'],
  ['City',                   'Ciudad'],
  ['State',                  'Estado'],
  ['ZIP',                    'CP'],
  ['Aliases',                'Alias'],
  ['Shipment Count',         'Envíos'],
  ['Notes',                  'Notas'],
];

function customerExtraFieldsTableHtml(a, b) {
  return AJ_DUP_EXTRA_FIELDS.map(([key, label]) => {
    const valA = a[key] !== undefined && a[key] !== '' ? VP.esc(String(a[key])) : '—';
    const valB = b[key] !== undefined && b[key] !== '' ? VP.esc(String(b[key])) : '—';
    return `<div class="aj-dup-field-row">
      <div class="aj-dup-field-label">${VP.esc(label)}</div>
      <div class="aj-dup-field-val">${valA}</div>
      <div class="aj-dup-field-val">${valB}</div>
    </div>`;
  }).join('');
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
        <button class="aj-dup-expand-btn" type="button" aria-expanded="false">Ver más ▾</button>
    <div class="aj-dup-expanded" style="display:none">
      ${customerExtraFieldsTableHtml(a, b)}
    </div>
    <div class="aj-dup-actions">
      <button class="refresh-btn aj-dup-dismiss-btn">No son iguales</button>
      <button class="refresh-btn aj-dup-merge-btn" data-keep="a">Usar «${VP.esc(a['Primary Username'] || a['Customer ID'])}» como principal</button>
      <button class="refresh-btn aj-dup-merge-btn" data-keep="b">Usar «${VP.esc(b['Primary Username'] || b['Customer ID'])}» como principal</button>
    </div>
  </div>`;
}

async function handleDismiss(btn) {
  const pairEl = btn.closest('.aj-dup-pair');
  const idA = pairEl.dataset.a;
  const idB = pairEl.dataset.b;
  btn.disabled = true;
  btn.textContent = 'Descartando…';
  try {
    await VP.post({ action: 'dismiss_duplicate_pair', customer_id_a: idA, customer_id_b: idB });
    pairEl.remove();
  } catch (e) {
    btn.disabled = false;
    btn.textContent = 'No son iguales';
        VP.toast('Error al descartar: ' + e.message, true);
  }
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
        <button class="btn" id="aj-history-back-btn">← Volver a duplicados</button>
        <button class="btn" id="aj-history-close-btn">Cerrar</button>
      </div>
    </div>
  </div>`;

  document.getElementById('aj-history-close-btn').addEventListener('click', () => { modalRoot.innerHTML = ''; });
  document.getElementById('aj-history-back-btn').addEventListener('click', () => { openDuplicatesModal(); });
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
    const status = r['Status'];
    let rightSide;
    if (status === 'Deshecho') {
      rightSide = `<span class="status-pill" style="background:var(--surface2);color:var(--text-faint)">Deshecho</span>`;
    } else if (status === 'Limpiado') {
      rightSide = `<span class="status-pill" style="background:var(--surface2);color:var(--text-faint)">Eliminado permanentemente</span>`;
    } else {
      rightSide = `<div style="display:flex;gap:6px">
            <button class="refresh-btn aj-undo-btn" data-merge-id="${VP.esc(r['Merge ID'])}">Deshacer</button>
            <button class="refresh-btn aj-cleanup-btn" data-merge-id="${VP.esc(r['Merge ID'])}">Limpiar</button>
          </div>`;
    }
    return `<div class="aj-history-row" data-merge-id="${VP.esc(r['Merge ID'])}">
      <div class="aj-history-main">
        <span class="aj-history-arrow">${VP.esc(r['Merged Username'] || r['Merged Customer ID'])} → ${VP.esc(r['Kept Username'] || r['Kept Customer ID'])}</span>
        <span class="aj-history-date">${VP.esc(VP.fmtDateTime ? VP.fmtDateTime(r['Merged Date']) : r['Merged Date'])}</span>
      </div>
      ${rightSide}
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

/* ── Historical / backfill TikTok CSV import ──────────────────────────
   Enriches "TikTok Import History" ONLY -- never touches Orders or QC.
   CSV is parsed entirely client-side (PapaParse); Apps Script only ever
   receives clean structured records, same shape as the daily import uses
   (TIKTOK_HISTORY_FIELD_MAP keys in apps-script.gs).
   Flow: pick file -> parse+map -> preview (dry run, no writes) -> confirm
   -> commit (real write) -> show result. ───────────────────────────── */

// Maps this CSV's exact header names to the same record keys the backend's
// TIKTOK_HISTORY_FIELD_MAP already expects (order_id, sku_id, etc.) -- only
// the fields this tool actually reads/writes need to be listed here.
const AJ_BACKFILL_COLUMN_MAP = {
  'Order ID':          'order_id',
  'SKU ID':            'sku_id',
  'Order Status':      'order_status',
  'Order Substatus':   'order_substatus',
  'Shipped Time':      'shipped_time',
  'Delivered Time':    'delivered_time',
  'Cancelled Time':    'cancelled_time',
  'Cancel By':         'cancel_by',
  'Cancel Reason':     'cancel_reason',
};

const AJ_BACKFILL_SKIP_SUBSTATUSES = ['Awaiting shipment', 'Unpaid'];

document.getElementById('aj-open-backfill').addEventListener('click', openBackfillModal);

function openBackfillModal() {
  const modalRoot = document.getElementById('modal-container');
  modalRoot.innerHTML = `<div class="modal-overlay" id="aj-backfill-overlay">
    <div class="modal aj-merge-modal">
      <div class="modal-title">Importación histórica de TikTok</div>
      <div class="aj-merge-scroll" id="aj-backfill-content">
        <p style="font-size:13px;color:var(--text-muted);margin:0 0 14px">
          Sube el CSV completo de pedidos de TikTok (todos los estados). Esta
          herramienta solo actualiza la pestaña <strong>TikTok Import History</strong>
          — nunca crea ni modifica pedidos en "Orders", y nunca toca la lista
          de control de calidad.
        </p>
        <input type="file" id="aj-backfill-file" accept=".csv" />
      </div>
      <div class="modal-actions">
        <button class="btn" id="aj-backfill-close-btn">Cerrar</button>
      </div>
    </div>
  </div>`;

  document.getElementById('aj-backfill-close-btn').addEventListener('click', () => { modalRoot.innerHTML = ''; });
  document.getElementById('aj-backfill-overlay').addEventListener('click', e => {
    if (e.target.id === 'aj-backfill-overlay') modalRoot.innerHTML = '';
  });
  document.getElementById('aj-backfill-file').addEventListener('change', handleBackfillFileSelected);
}

function handleBackfillFileSelected(e) {
  const file = e.target.files[0];
  if (!file) return;

  const content = document.getElementById('aj-backfill-content');
  content.innerHTML = '<div class="vp-loading">Leyendo el archivo…</div>';

  Papa.parse(file, {
    header: true,
    skipEmptyLines: true,
    complete: results => {
      try {
        const records = mapBackfillRows(results.data);
        runBackfillPreview(records);
      } catch (err) {
        content.innerHTML = `<div class="vp-empty-sm">Error al leer el CSV: ${VP.esc(err.message)}</div>`;
      }
    },
    error: err => {
      content.innerHTML = `<div class="vp-empty-sm">Error al leer el CSV: ${VP.esc(err.message)}</div>`;
    },
  });
}

// Trims every value (TikTok pads Order ID / SKU ID / dates with a stray
// trailing tab character) and maps CSV headers to the backend's expected
// record keys. Rows with substatus Awaiting shipment / Unpaid are dropped
// here already -- no Tracking ID yet, not useful to either preview or
// commit, and no point sending them over the wire at all.
function mapBackfillRows(rows) {
  const mapped = [];
  rows.forEach(row => {
    const rec = {};
    Object.keys(AJ_BACKFILL_COLUMN_MAP).forEach(header => {
      const key = AJ_BACKFILL_COLUMN_MAP[header];
      rec[key] = String(row[header] || '').trim();
    });
    if (!rec.order_id || !rec.sku_id) return;
    if (AJ_BACKFILL_SKIP_SUBSTATUSES.includes(rec.order_substatus)) return;
    mapped.push(rec);
  });
  return mapped;
}

async function runBackfillPreview(records) {
  const content = document.getElementById('aj-backfill-content');

  if (!records.length) {
    content.innerHTML = '<div class="vp-empty-sm">No se encontraron filas útiles en este archivo (después de omitir "Awaiting shipment" y "Unpaid").</div>';
    return;
  }

  content.innerHTML = `<div class="vp-loading">Comparando ${VP.num(records.length)} filas contra el historial existente…</div>`;

  try {
    await VP.ensureToken();
    const result = await VP.post({ action: 'backfill_tiktok_preview', records });
    renderBackfillPreview(records, result);
  } catch (e) {
    content.innerHTML = `<div class="vp-empty-sm">Error al comparar: ${VP.esc(e.message)}</div>`;
  }
}

function renderBackfillPreview(records, result) {
  const content = document.getElementById('aj-backfill-content');
  content.innerHTML = `
    <div class="aj-dup-field-row" style="grid-template-columns:1fr auto"><div>Filas leídas del archivo</div><div>${VP.num(result.total)}</div></div>
    <div class="aj-dup-field-row" style="grid-template-columns:1fr auto"><div>Se actualizarán (ya existían)</div><div>${VP.num(result.updated)}</div></div>
    <div class="aj-dup-field-row" style="grid-template-columns:1fr auto"><div>Se crearán (no existían)</div><div>${VP.num(result.inserted)}</div></div>
    <div class="aj-dup-field-row" style="grid-template-columns:1fr auto"><div>Omitidas</div><div>${VP.num(result.skipped)}</div></div>
    <p style="font-size:12.5px;color:var(--text-faint);margin:14px 0 0">
      Solo se sobrescriben "Order Status" y "Order Substatus". Las fechas de
      envío/entrega/cancelación solo se rellenan si estaban vacías — nunca
      se sobrescribe un valor ya existente.
    </p>
    <div style="margin-top:16px;display:flex;justify-content:flex-end">
      <button class="refresh-btn" id="aj-backfill-confirm-btn">Confirmar e importar</button>
    </div>
  `;
  document.getElementById('aj-backfill-confirm-btn').addEventListener('click', () => runBackfillCommit(records));
}

async function runBackfillCommit(records) {
  const content = document.getElementById('aj-backfill-content');
  content.innerHTML = '<div class="vp-loading">Escribiendo cambios…</div>';

  try {
    const result = await VP.post({ action: 'backfill_tiktok_commit', records });
    content.innerHTML = `
      <div style="padding:12px 0;font-size:13px;color:var(--green-text)">✓ Importación completada</div>
      <div class="aj-dup-field-row" style="grid-template-columns:1fr auto"><div>Filas actualizadas</div><div>${VP.num(result.updated)}</div></div>
      <div class="aj-dup-field-row" style="grid-template-columns:1fr auto"><div>Filas nuevas creadas</div><div>${VP.num(result.inserted)}</div></div>
      <div class="aj-dup-field-row" style="grid-template-columns:1fr auto"><div>Omitidas</div><div>${VP.num(result.skipped)}</div></div>
    `;
  } catch (e) {
    content.innerHTML = `<div class="vp-empty-sm">Error al importar: ${VP.esc(e.message)}</div>`;
  }
}
