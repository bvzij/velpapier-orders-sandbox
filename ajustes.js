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

// Shared close-on-Escape for every modal on this page. Click-outside-to-close
// is deliberately NOT used -- an accidental click just outside a modal (e.g.
// on mobile, or a slightly-off click) should never lose in-progress work.
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    const modalRoot = document.getElementById('modal-container');
    if (modalRoot.innerHTML.trim()) modalRoot.innerHTML = '';
  }
});

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

// TikTok's export prefixes every money field with the currency code and a
// space (e.g. "MXN 160.00") -- strip that so the sheet stores a plain,
// summable number rather than text. Only applied to genuinely price-like
// fields; dates, IDs, and text fields are left untouched.
const AJ_BACKFILL_PRICE_FIELDS = [
  'sku_unit_price', 'sku_subtotal_before', 'sku_platform_discount',
  'sku_seller_discount', 'sku_subtotal_after', 'shipping_fee_after',
  'shipping_fee_original', 'shipping_fee_seller_disc',
  'shipping_fee_platform_disc', 'payment_platform_discount',
  'retail_delivery_fee', 'order_amount', 'order_refund_amount',
];

function parseBackfillPrice(raw) {
  const cleaned = String(raw || '').replace(/[A-Za-z\s]/g, '').trim();
  if (!cleaned) return '';
  const num = parseFloat(cleaned);
  return isNaN(num) ? '' : num;
}

// Maps this CSV's exact header names to the same record keys the backend's
// TIKTOK_HISTORY_FIELD_MAP already expects. Every field the sheet stores is
// listed here -- not just the ones this tool updates on an existing match --
// because a NOT-FOUND row is inserted fresh with whatever the record
// contains; leaving fields out here means they'd be written blank on insert.
// A few CSV header names differ slightly from the sheet's column names
// (noted below) -- mapped by value (order_status, etc.), not by spelling.
const AJ_BACKFILL_COLUMN_MAP = {
  'Order ID':                        'order_id',
  'SKU ID':                          'sku_id',
  'Seller SKU':                      'seller_sku',
  'Product Name':                    'product_name',
  'Variation':                       'variation',
  'Quantity':                        'quantity',
  'Order Status':                    'order_status',
  'Order Substatus':                 'order_substatus',
  'Cancelation/Return Type':         'cancel_return_type',
  'SKU Unit Original Price':         'sku_unit_price',
  'SKU Subtotal Before Discount':    'sku_subtotal_before',
  'SKU Platform Discount':           'sku_platform_discount',
  'SKU Seller Discount':             'sku_seller_discount',
  'SKU Subtotal After Discount':     'sku_subtotal_after',
  'Shipping Fee After Discount':     'shipping_fee_after',
  'Original Shipping Fee':           'shipping_fee_original',
  'Shipping Fee Seller Discount':    'shipping_fee_seller_disc',
  'Shipping Fee Platform Discount':  'shipping_fee_platform_disc',
  'Payment platform discount':       'payment_platform_discount',   // CSV: lowercase "platform discount"
  'Retail Delivery Fee':             'retail_delivery_fee',
  'Order Amount':                    'order_amount',
  'Order Refund Amount':             'order_refund_amount',
  'Created Time':                    'created_time',
  'Paid Time':                       'paid_time',
  'RTS Time':                        'rts_time',
  'Shipped Time':                    'shipped_time',
  'Delivered Time':                  'delivered_time',
  'Cancelled Time':                  'cancelled_time',
  'Cancel By':                       'cancel_by',
  'Cancel Reason':                   'cancel_reason',
  'Fulfillment Type':                'fulfillment_type',
  'Warehouse Name':                  'warehouse_name',
  'Tracking ID':                     'tracking_id',
  'Delivery Option Type':            'delivery_option_type',
  'Delivery Option':                 'delivery_option',
  'Shipping Provider Name':          'shipping_provider',           // CSV: "Shipping Provider Name"
  'Buyer Username':                  'buyer_username',
  'Payment Method':                  'payment_method',
  'Weight(kg)':                      'weight_kg',                   // CSV: no space before "(kg)"
  'Product Category':                'product_category',
  'Order Channel':                   'order_channel',
  'Creator Handle':                  'creator_handle',
};

const AJ_BACKFILL_SKIP_SUBSTATUSES = ['Awaiting shipment', 'Unpaid'];

document.getElementById('aj-open-backfill').addEventListener('click', openBackfillModal);

function openBackfillModal() {
  const modalRoot = document.getElementById('modal-container');
  modalRoot.innerHTML = `<div class="modal-overlay" id="aj-backfill-overlay">
    <div class="modal aj-backfill-modal">
      <div class="aj-backfill-title">Importación histórica de TikTok</div>
      <div id="aj-backfill-content">
        <p class="aj-backfill-intro">
          Sube el CSV completo de pedidos de TikTok (todos los estados). Solo
          actualiza <strong>TikTok Import History</strong> — nunca crea ni
          modifica pedidos en "Orders", y nunca toca la lista de control de
          calidad.
        </p>
        <label class="aj-backfill-dropzone" id="aj-backfill-dropzone">
          <div class="aj-backfill-dropzone-icon">📄</div>
          <div class="aj-backfill-dropzone-label">Arrastra tu CSV aquí</div>
          <div class="aj-backfill-dropzone-hint">o haz clic para elegir un archivo</div>
          <input type="file" id="aj-backfill-file" accept=".csv" />
        </label>
      </div>
      <div class="modal-actions">
        <button class="btn" id="aj-backfill-close-btn">Cerrar</button>
      </div>
    </div>
  </div>`;

    document.getElementById('aj-backfill-close-btn').addEventListener('click', () => { modalRoot.innerHTML = ''; });
  document.getElementById('aj-backfill-file').addEventListener('change', handleBackfillFileSelected);

  const dropzone = document.getElementById('aj-backfill-dropzone');
  ['dragenter', 'dragover'].forEach(evt => {
    dropzone.addEventListener(evt, e => { e.preventDefault(); dropzone.classList.add('is-dragover'); });
  });
  ['dragleave', 'drop'].forEach(evt => {
    dropzone.addEventListener(evt, e => { e.preventDefault(); dropzone.classList.remove('is-dragover'); });
  });
  dropzone.addEventListener('drop', e => {
    const file = e.dataTransfer.files[0];
    if (file) processBackfillFile(file);
  });
}

function handleBackfillFileSelected(e) {
  const file = e.target.files[0];
  if (file) processBackfillFile(file);
}

function processBackfillFile(file) {
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
      const raw = String(row[header] || '').trim();
      rec[key] = AJ_BACKFILL_PRICE_FIELDS.includes(key) ? parseBackfillPrice(raw) : raw;
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
    <div class="aj-backfill-stats">
      <div class="aj-backfill-stat-row">
        <span class="aj-backfill-stat-label">Filas leídas del archivo</span>
        <span class="aj-backfill-stat-value">${VP.num(result.total)}</span>
      </div>
      <div class="aj-backfill-stat-row is-highlight">
        <span class="aj-backfill-stat-label">Se actualizarán (ya existían)</span>
        <span class="aj-backfill-stat-value">${VP.num(result.updated)}</span>
      </div>
      <div class="aj-backfill-stat-row is-highlight">
        <span class="aj-backfill-stat-label">Se crearán (no existían)</span>
        <span class="aj-backfill-stat-value">${VP.num(result.inserted)}</span>
      </div>
      <div class="aj-backfill-stat-row">
        <span class="aj-backfill-stat-label">Omitidas</span>
        <span class="aj-backfill-stat-value">${VP.num(result.skipped)}</span>
      </div>
    </div>
    <p class="aj-backfill-note">
      Solo se sobrescriben "Order Status" y "Order Substatus". Las fechas de
      envío, entrega y cancelación solo se rellenan si estaban vacías — nunca
      se sobrescribe un valor ya existente.
    </p>
  `;
  const modalActions = document.querySelector('#aj-backfill-overlay .modal-actions');
  modalActions.innerHTML = `
    <button class="btn" id="aj-backfill-close-btn">Cerrar</button>
    <button class="refresh-btn" id="aj-backfill-confirm-btn">Confirmar e importar</button>
  `;
  document.getElementById('aj-backfill-close-btn').addEventListener('click', () => {
    document.getElementById('modal-container').innerHTML = '';
  });
  document.getElementById('aj-backfill-confirm-btn').addEventListener('click', () => runBackfillCommit(records));
}

async function runBackfillCommit(records) {
  const content = document.getElementById('aj-backfill-content');
  content.innerHTML = '<div class="vp-loading">Escribiendo cambios…</div>';
  document.querySelector('#aj-backfill-overlay .modal-actions').innerHTML =
    `<button class="btn" id="aj-backfill-close-btn" disabled>Cerrar</button>`;

  try {
    const result = await VP.post({ action: 'backfill_tiktok_commit', records });
    content.innerHTML = `
      <div class="aj-backfill-success">✓ Importación completada</div>
      <div class="aj-backfill-stats">
        <div class="aj-backfill-stat-row is-highlight">
          <span class="aj-backfill-stat-label">Filas actualizadas</span>
          <span class="aj-backfill-stat-value">${VP.num(result.updated)}</span>
        </div>
        <div class="aj-backfill-stat-row is-highlight">
          <span class="aj-backfill-stat-label">Filas nuevas creadas</span>
          <span class="aj-backfill-stat-value">${VP.num(result.inserted)}</span>
        </div>
        <div class="aj-backfill-stat-row">
          <span class="aj-backfill-stat-label">Omitidas</span>
          <span class="aj-backfill-stat-value">${VP.num(result.skipped)}</span>
        </div>
      </div>
    `;
  } catch (e) {
    content.innerHTML = `<div class="vp-empty-sm">Error al importar: ${VP.esc(e.message)}</div>`;
  }
  document.querySelector('#aj-backfill-overlay .modal-actions').innerHTML =
    `<button class="btn" id="aj-backfill-close-btn">Cerrar</button>`;
  document.getElementById('aj-backfill-close-btn').addEventListener('click', () => {
    document.getElementById('modal-container').innerHTML = '';
  });
}

/* ── Product duplicate-merger ──────────────────────────────────────────
   Two-level merge: Parent-level fuzzy match, then a per-variant pairing
   screen (dropdown per losing-side variant, pre-filled with the backend's
   fuzzy suggestion). Nothing is written until "Confirmar fusión" is
   pressed. Mirrors the shape of the customer duplicate-finder but adds
   the variant-pairing step, since Orders references Catalog IDs
   (variant-level), not Parent IDs. ─────────────────────────────────── */

const AJ_PROD_DUP_DEFAULT_THRESHOLD = 55;

document.getElementById('aj-scan-product-duplicates').addEventListener('click', openProductDuplicatesModal);

async function openProductDuplicatesModal() {
  const modalRoot = document.getElementById('modal-container');
  modalRoot.innerHTML = `<div class="modal-overlay" id="aj-prod-overlay">
    <div class="modal aj-merge-modal">
      <div class="modal-title">Productos duplicados</div>
      <div class="aj-dup-threshold-row">
        <span class="aj-dup-threshold-label">Umbral</span>
        <input type="range" id="aj-prod-threshold-slider" min="0" max="100" step="1" value="${AJ_PROD_DUP_DEFAULT_THRESHOLD}">
        <span class="aj-dup-threshold-value" id="aj-prod-threshold-value">${AJ_PROD_DUP_DEFAULT_THRESHOLD}%</span>
        <button class="btn aj-dup-refresh-btn" id="aj-prod-refresh-btn" title="Buscar de nuevo con este umbral" aria-label="Actualizar">↻</button>
      </div>
      <div class="aj-merge-scroll" id="aj-prod-duplicates-content">
        <div class="vp-loading">Comparando productos, puede tardar un momento…</div>
      </div>
      <div class="modal-actions">
        <button class="btn" id="aj-prod-close-btn">Cerrar</button>
      </div>
    </div>
  </div>`;

  document.getElementById('aj-prod-close-btn').addEventListener('click', () => { modalRoot.innerHTML = ''; });

  const slider = document.getElementById('aj-prod-threshold-slider');
  const valueLabel = document.getElementById('aj-prod-threshold-value');
  slider.addEventListener('input', () => { valueLabel.textContent = slider.value + '%'; });
  document.getElementById('aj-prod-refresh-btn').addEventListener('click', () => {
    loadProductDuplicates(parseInt(slider.value, 10));
  });

  await loadProductDuplicates(AJ_PROD_DUP_DEFAULT_THRESHOLD);
}

async function loadProductDuplicates(threshold) {
  const content = document.getElementById('aj-prod-duplicates-content');
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
  const content = document.getElementById('aj-prod-duplicates-content');

  if (!pairs.length) {
    content.innerHTML = '<div class="vp-empty-sm">No se encontraron duplicados probables.</div>';
    return;
  }

  content.innerHTML = `<div style="font-size:12px;color:var(--text-muted);margin-bottom:10px">
    ${VP.num(pairs.length)} par${pairs.length !== 1 ? 'es' : ''} probable${pairs.length !== 1 ? 's' : ''} encontrado${pairs.length !== 1 ? 's' : ''}
  </div>` + pairs.map(productPairHtml).join('');

  content.querySelectorAll('.aj-prod-review-btn').forEach(el => {
    el.addEventListener('click', () => openProductMergeScreen(JSON.parse(el.dataset.pair)));
  });
  content.querySelectorAll('.aj-prod-dismiss-btn').forEach(el => {
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
      <button class="refresh-btn aj-prod-dismiss-btn">No son iguales</button>
      <button class="refresh-btn aj-prod-review-btn" data-pair="${pairJson}">Revisar y fusionar</button>
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

function openProductMergeScreen(pair) {
  const modalRoot = document.getElementById('modal-container');
  // Default keeper = parent_a until the user clicks a card.
  const state = { keeper: 'a', pair: pair };

  modalRoot.innerHTML = `<div class="modal-overlay" id="aj-prod-overlay">
    <div class="modal aj-merge-modal">
      <div class="modal-title">Fusionar productos</div>
      <div class="aj-merge-scroll" id="aj-prod-merge-content"></div>
      <div class="modal-actions">
        <button class="btn" id="aj-prod-back-btn">← Volver</button>
        <button class="refresh-btn" id="aj-prod-confirm-btn">Confirmar fusión</button>
      </div>
    </div>
  </div>`;

  document.getElementById('aj-prod-back-btn').addEventListener('click', () => openProductDuplicatesModal());
  document.getElementById('aj-prod-confirm-btn').addEventListener('click', () => submitProductMerge(state));

  renderProductMergeScreen(state);
}

function renderProductMergeScreen(state) {
  const { pair, keeper } = state;
  const a = pair.parent_a, b = pair.parent_b;
  const keeperParent = keeper === 'a' ? a : b;
  const loserParent = keeper === 'a' ? b : a;
  const keeperVariants = keeper === 'a' ? pair.variants_a : pair.variants_b;
  const loserVariants = keeper === 'a' ? pair.variants_b : pair.variants_a;

  // suggested_variant_pairs is always b_catalog_id -> suggested_a_catalog_id
  // (computed once, from the ORIGINAL a/b orientation) -- re-map lookups by
  // catalog ID rather than by a/b position so flipping the keeper still
  // shows the right suggestion regardless of which side "b" ends up being.
  const suggestionByLoserCatalogId = {};
  (pair.suggested_variant_pairs || []).forEach(s => {
    // s.b_catalog_id is always from the ORIGINAL parent_b; s.suggested_a_catalog_id from parent_a.
    suggestionByLoserCatalogId[s.b_catalog_id] = s.suggested_a_catalog_id;
  });

  const content = document.getElementById('aj-prod-merge-content');
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
    <div id="aj-prod-variant-rows">
      ${loserVariants.map(lv => {
        // The suggestion map was computed with ORIGINAL a=parent_a/b=parent_b.
        // If keeper is 'b', loser is 'a', and the suggestion map (keyed by
        // b's catalog IDs) doesn't directly apply -- in that case we still
        // show the dropdown, just without a pre-filled suggestion, rather
        // than risk showing a wrong one.
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
  document.querySelectorAll('#aj-prod-variant-rows .aj-prod-variant-row').forEach(row => {
    const loseCatalogId = row.dataset.loseCatalogId;
    const keepCatalogId = row.querySelector('.aj-prod-variant-select').value;
    if (keepCatalogId) {
      variantPairs.push({ keep_catalog_id: keepCatalogId, lose_catalog_id: loseCatalogId });
    }
  });

  const confirmBtn = document.getElementById('aj-prod-confirm-btn');
  confirmBtn.disabled = true;
  confirmBtn.textContent = 'Fusionando…';

  try {
    const result = await VP.post({
      action: 'merge_products',
      keep_parent_id: keeperParent['Parent ID'],
      lose_parent_id: loserParent['Parent ID'],
      variant_pairs: variantPairs,
    });
    const content = document.getElementById('aj-prod-merge-content');
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
    document.querySelector('#aj-prod-overlay .modal-actions').innerHTML =
      `<button class="btn" id="aj-prod-close-btn">Cerrar</button>`;
    document.getElementById('aj-prod-close-btn').addEventListener('click', () => {
      document.getElementById('modal-container').innerHTML = '';
    });
  } catch (e) {
    confirmBtn.disabled = false;
    confirmBtn.textContent = 'Confirmar fusión';
    VP.toast('Error al fusionar: ' + e.message, true);
  }
}
