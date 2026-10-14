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
  // Strip currency letters/whitespace (e.g. "MXN ") AND comma thousands
  // separators (e.g. "1,072.88") before parsing. parseFloat stops at the
  // first character it can't interpret as part of a number -- a bare
  // comma left in place silently truncates "1,072.88" down to just "1",
  // which is exactly the bug that produced $1, $2, $3 "orders" for what
  // were really four-figure amounts.
  const cleaned = String(raw || '').replace(/[A-Za-z\s,]/g, '').trim();
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

function openProductMergeScreen(pair, onBack) {
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

  document.getElementById('aj-prod-back-btn').addEventListener('click', () => (onBack || openProductDuplicatesModal)());
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

/* ── Manual search-and-pick (alternative to the automatic scan) ────────
   Two autocomplete inputs (same interaction pattern as the customer
   autocomplete on the Pedidos page: input filters a client-side list,
   mousedown selects). Product list (with total units sold) is fetched
   once when the modal opens, then filtered entirely client-side as the
   user types -- no repeated server calls per keystroke. Once both sides
   are picked, fetches the pair's variant data and hands off to the same
   openProductMergeScreen() the automatic scan already uses. ─────────── */

document.getElementById('aj-manual-product-merge').addEventListener('click', openManualProductSearchModal);

async function openManualProductSearchModal() {
  const modalRoot = document.getElementById('modal-container');
  modalRoot.innerHTML = `<div class="modal-overlay" id="aj-manual-overlay">
    <div class="modal aj-merge-modal">
      <div class="modal-title">Buscar productos manualmente</div>
      <div class="aj-merge-scroll" id="aj-manual-content">
        <div class="vp-loading">Cargando productos…</div>
      </div>
      <div class="modal-actions">
        <button class="btn" id="aj-manual-close-btn">Cerrar</button>
      </div>
    </div>
  </div>`;
  document.getElementById('aj-manual-close-btn').addEventListener('click', () => { modalRoot.innerHTML = ''; });

  const content = document.getElementById('aj-manual-content');
  try {
    await VP.ensureToken();
    const data = await VP.get('action=search_products_for_merge');
    renderManualSearchForm(data.products || []);
  } catch (e) {
    content.innerHTML = `<div class="vp-empty-sm">Error al cargar productos: ${VP.esc(e.message)}</div>`;
  }
}

function renderManualSearchForm(products) {
  const content = document.getElementById('aj-manual-content');
  const state = { productA: null, productB: null };

  content.innerHTML = `
    <div class="aj-prod-keeper-row">
      <div style="position:relative">
        <input type="text" class="aj-prod-variant-select" id="aj-manual-input-a" placeholder="Buscar producto A…" autocomplete="off" style="width:100%">
        <div class="autocomplete-list" id="aj-manual-list-a" style="display:none"></div>
      </div>
      <div style="position:relative">
        <input type="text" class="aj-prod-variant-select" id="aj-manual-input-b" placeholder="Buscar producto B…" autocomplete="off" style="width:100%">
        <div class="autocomplete-list" id="aj-manual-list-b" style="display:none"></div>
      </div>
    </div>
    <div id="aj-manual-selection-summary" style="font-size:12.5px;color:var(--text-muted);min-height:20px;margin-bottom:10px"></div>
    <div style="display:flex;justify-content:flex-end">
      <button class="refresh-btn" id="aj-manual-continue-btn" disabled>Continuar</button>
    </div>
  `;

  function renderList(side, inputEl, listEl) {
    const val = inputEl.value.trim().toLowerCase();
    const otherSide = side === 'a' ? state.productB : state.productA;
    if (!val) { listEl.style.display = 'none'; return; }

    const matches = products.filter(p => {
      if (otherSide && p.parent['Parent ID'] === otherSide.parent['Parent ID']) return false; // mutual exclusion
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
    const summary = document.getElementById('aj-manual-selection-summary');
    const continueBtn = document.getElementById('aj-manual-continue-btn');
    if (state.productA && state.productB) {
      summary.textContent = `${state.productA.parent['Parent Name']} (${VP.num(state.productA.total_units_sold)} vendidos) ↔ ${state.productB.parent['Parent Name']} (${VP.num(state.productB.total_units_sold)} vendidos)`;
      continueBtn.disabled = false;
    } else {
      summary.textContent = '';
      continueBtn.disabled = true;
    }
  }

  const inputA = document.getElementById('aj-manual-input-a');
  const listA = document.getElementById('aj-manual-list-a');
  const inputB = document.getElementById('aj-manual-input-b');
  const listB = document.getElementById('aj-manual-list-b');

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

  document.getElementById('aj-manual-continue-btn').addEventListener('click', async () => {
    const btn = document.getElementById('aj-manual-continue-btn');
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

/* ============================================================================
   SHOPIFY — revisión en bloque de coincidencias pendientes
   Agrupa por persona los pedidos de Shopify "pendientes de fusión", muestra por
   qué se sugiere cada cliente y aplica todo de una vez. Al vincular, el ID de
   Shopify se guarda en el cliente principal. No cambia nada hasta pulsar Aplicar.
   ==========================================================================*/

const AJ_SHOP_DEFAULT_THRESHOLD = 80;   // desde qué % se preselecciona "Vincular"
const AJ_SHOP_BATCH = 12;               // personas por petición (corta, para no bloquear otros guardados)
let ajShopGroups = [];

document.getElementById('aj-open-shopify-matches').addEventListener('click', ajShopOpen);

function ajShopOpen() {
  const modalRoot = document.getElementById('modal-container');
  modalRoot.innerHTML = `<div class="modal-overlay" id="modal-overlay">
    <div class="modal aj-merge-modal">
      <div class="modal-title">Coincidencias de Shopify pendientes</div>
      <div class="aj-dup-threshold-row">
        <span class="aj-dup-threshold-label" title="Las personas cuya mejor sugerencia llegue a este porcentaje aparecen ya marcadas para vincular. Puedes cambiar cualquiera a mano.">Marcar desde</span>
        <input type="range" id="aj-shop-threshold" min="0" max="100" step="1" value="${AJ_SHOP_DEFAULT_THRESHOLD}">
        <span class="aj-dup-threshold-value" id="aj-shop-threshold-value">${AJ_SHOP_DEFAULT_THRESHOLD}%</span>
        <button class="btn aj-dup-refresh-btn" id="aj-shop-reload" title="Volver a cargar la lista" aria-label="Actualizar">↻</button>
      </div>
      <div class="aj-merge-scroll" id="aj-shop-content">
        <div class="vp-loading">Cargando coincidencias pendientes…</div>
      </div>
      <div class="modal-actions">
        <span id="aj-shop-summary" style="margin-right:auto;font-size:12px;color:var(--text-muted)"></span>
        <button class="btn" id="aj-shop-close">Cerrar</button>
        <button class="btn btn-primary" id="aj-shop-apply" disabled>Aplicar</button>
      </div>
    </div>
  </div>`;

  document.getElementById('aj-shop-close').addEventListener('click', () => { modalRoot.innerHTML = ''; });
  document.getElementById('aj-shop-reload').addEventListener('click', () => ajShopLoad());
  document.getElementById('aj-shop-apply').addEventListener('click', ajShopApply);

  const slider = document.getElementById('aj-shop-threshold');
  slider.addEventListener('input', () => {
    document.getElementById('aj-shop-threshold-value').textContent = slider.value + '%';
    ajShopApplyThreshold();
  });
  ajShopLoad();
}

async function ajShopLoad(bannerHtml) {
  const content = document.getElementById('aj-shop-content');
  if (!content) return;
  content.innerHTML = '<div class="vp-loading">Cargando coincidencias pendientes…</div>';
  try {
    await VP.ensureToken();
    const data = await VP.get('action=shopify_matches_review');
    if (data.error) throw new Error(data.error);
    ajShopGroups = data.groups || [];
    ajShopRender(bannerHtml || '');
  } catch (e) {
    content.innerHTML = `<div class="vp-empty-sm">Error al cargar: ${VP.esc(e.message)}</div>`;
  }
}

function ajShopLabel(c) { return c.username || c.name || c.customer_id; }

function ajShopPill(text, good) {
  const colors = good ? 'background:var(--green-bg);color:var(--green-text)' : 'background:var(--surface2);color:var(--text-muted)';
  return `<span style="display:inline-block;font-size:11px;padding:2px 7px;border-radius:999px;margin:3px 4px 0 0;${colors}">${VP.esc(text)}</span>`;
}

function ajShopIncomingHtml(g) {
  const i = g.incoming;
  const lines = [i.email, i.phone, [i.city, i.state].filter(Boolean).join(', '), i.zip ? 'CP ' + i.zip : '',
    g.shopify_customer_id ? 'ID Shopify: ' + g.shopify_customer_id : 'Sin ID de Shopify (compra como invitado)'].filter(Boolean);
  return `<div class="aj-dup-username">${VP.esc(i.name || i.email || i.phone || 'Sin datos')}</div>
    <div class="aj-dup-detail">${lines.map(l => VP.esc(l)).join('<br>')}</div>`;
}

function ajShopRowHtml(g, idx) {
  const orders = g.order_names.length
    ? g.order_names.slice(0, 4).join(', ') + (g.order_names.length > 4 ? ` +${g.order_names.length - 4} más` : '')
    : `${g.match_ids.length} pedido${g.match_ids.length !== 1 ? 's' : ''}`;
  const opts = g.candidates.map(c =>
    `<option value="link:${VP.esc(c.customer_id)}">Vincular a «${VP.esc(ajShopLabel(c))}» (${c.score}%)</option>`).join('');
  return `<div class="aj-dup-pair" data-idx="${idx}">
    <div class="aj-dup-header">
      <span>${VP.esc(orders)} · ${g.match_ids.length} pedido${g.match_ids.length !== 1 ? 's' : ''}</span>
      <span class="aj-dup-score" data-role="score"></span>
    </div>
    <div class="aj-dup-compare">
      <div class="aj-dup-side">
        <div style="font-size:11px;color:var(--text-faint);margin-bottom:3px">EN SHOPIFY</div>
        ${ajShopIncomingHtml(g)}
      </div>
      <div class="aj-dup-side" data-role="target"></div>
    </div>
    <div class="aj-dup-actions" style="justify-content:stretch">
      <select data-role="choice" style="flex:1;min-width:0;padding:7px 8px;border:0.5px solid var(--border-strong);border-radius:var(--radius-sm);background:var(--surface);color:var(--text);font:inherit;font-size:13px">
        ${opts}
        <option value="new">Crear un cliente nuevo</option>
        <option value="skip">Dejar pendiente (no cambiar nada)</option>
      </select>
    </div>
  </div>`;
}

function ajShopRender(bannerHtml) {
  const content = document.getElementById('aj-shop-content');
  if (!ajShopGroups.length) {
    content.innerHTML = (bannerHtml || '') + '<div class="vp-empty-sm">No hay coincidencias pendientes. 🎉</div>';
    ajShopUpdateSummary();
    return;
  }
  content.innerHTML = (bannerHtml || '') + ajShopGroups.map(ajShopRowHtml).join('');
  content.querySelectorAll('.aj-dup-pair').forEach(row => {
    row.querySelector('[data-role="choice"]').addEventListener('change', () => {
      row.dataset.touched = '1';          // the slider no longer overrides this one
      ajShopRefreshRow(row);
      ajShopUpdateSummary();
    });
  });
  ajShopApplyThreshold();
}

// Default choice for a person, from the slider.
function ajShopDefaultChoice(g, threshold) {
  const best = g.candidates[0];
  if (!best) return 'skip';
  // A candidate whose Shopify ID already matches this incoming group is
  // strong evidence (same person ordering under two Shopify accounts), but
  // NOT a certainty that needs no review -- it is still a suggestion to
  // confirm, same as a high score. Pre-select it, but never silently.
  if (best.same_shopify_id) return 'link:' + best.customer_id;
  return best.score >= threshold ? 'link:' + best.customer_id : 'skip';
}

function ajShopApplyThreshold() {
  const threshold = parseInt(document.getElementById('aj-shop-threshold').value, 10);
  document.querySelectorAll('#aj-shop-content .aj-dup-pair').forEach(row => {
    if (row.dataset.touched === '1') return;
    const g = ajShopGroups[parseInt(row.dataset.idx, 10)];
    row.querySelector('[data-role="choice"]').value = ajShopDefaultChoice(g, threshold);
    ajShopRefreshRow(row);
  });
  ajShopUpdateSummary();
}

// Redraws the right-hand side + score badge for the current choice.
function ajShopRefreshRow(row) {
  const g = ajShopGroups[parseInt(row.dataset.idx, 10)];
  const choice = row.querySelector('[data-role="choice"]').value;
  const target = row.querySelector('[data-role="target"]');
  const score = row.querySelector('[data-role="score"]');

  if (choice.indexOf('link:') === 0) {
    const c = g.candidates.find(x => x.customer_id === choice.slice(5));
    const lines = [c.name && c.username ? c.name : '', c.phone, c.email, c.city,
      c.shopify_ids ? 'Ya tiene ID(s): ' + c.shopify_ids : 'Sin ID de Shopify todavía'].filter(Boolean);
    // FIXED 2026-10-14: this pill used to claim certainty ("Seguro") and
    // imply no review was needed. That was wrong -- it can also mean the
    // same person simply has two Shopify accounts (a known, legitimate
    // pattern), which is new information to confirm, not a leftover to
    // wave through. Shown as corroborating evidence like any other reason.
    target.innerHTML = `<div style="font-size:11px;color:var(--text-faint);margin-bottom:3px">SE VINCULA A</div>
      <div class="aj-dup-username">${VP.esc(ajShopLabel(c))} <span style="font-weight:400;color:var(--text-faint)">${VP.esc(c.customer_id)}</span></div>
      <div class="aj-dup-detail">${lines.map(l => VP.esc(l)).join('<br>')}</div>
      <div>${c.same_shopify_id ? ajShopPill('Este cliente ya tiene este mismo ID de Shopify', true) : ''}${c.reasons.map(r => ajShopPill(r)).join('')}</div>`;
    score.textContent = c.same_shopify_id ? 'ID coincide' : c.score + '%';
  } else if (choice === 'new') {
    target.innerHTML = `<div style="font-size:11px;color:var(--text-faint);margin-bottom:3px">SE CREA</div>
      <div class="aj-dup-detail">Un único cliente nuevo con estos datos de Shopify, para ${g.match_ids.length > 1 ? 'los ' + g.match_ids.length + ' pedidos' : 'el pedido'}.</div>`;
    score.textContent = '';
  } else {
    target.innerHTML = `<div style="font-size:11px;color:var(--text-faint);margin-bottom:3px">SIN CAMBIOS</div>
      <div class="aj-dup-detail">Se queda pendiente; podrás decidirlo después.</div>`;
    score.textContent = '';
  }
  row.style.opacity = choice === 'skip' ? '0.75' : '1';
}

// What would be applied right now.
function ajShopCollect() {
  const items = [];
  document.querySelectorAll('#aj-shop-content .aj-dup-pair').forEach(row => {
    const g = ajShopGroups[parseInt(row.dataset.idx, 10)];
    const choice = row.querySelector('[data-role="choice"]').value;
    if (choice === 'skip') return;
    items.push(choice === 'new'
      ? { key: g.key, match_ids: g.match_ids, decision: 'new' }
      : { key: g.key, match_ids: g.match_ids, decision: 'link', customer_id: choice.slice(5) });
  });
  return items;
}

function ajShopUpdateSummary() {
  const items = ajShopCollect();
  const link = items.filter(i => i.decision === 'link').length;
  const fresh = items.filter(i => i.decision === 'new').length;
  const total = ajShopGroups.length;
  const summary = document.getElementById('aj-shop-summary');
  const btn = document.getElementById('aj-shop-apply');
  if (!summary || !btn) return;
  btn.dataset.armed = '';
  summary.textContent = total
    ? `${VP.num(total)} persona${total !== 1 ? 's' : ''} · ${VP.num(link)} a vincular` + (fresh ? ` · ${VP.num(fresh)} nuevo${fresh !== 1 ? 's' : ''}` : '')
    : '';
  btn.textContent = items.length ? `Aplicar (${VP.num(items.length)})` : 'Aplicar';
  btn.disabled = !items.length;
}

async function ajShopApply() {
  const btn = document.getElementById('aj-shop-apply');
  const items = ajShopCollect();
  if (!items.length) return;

  // Two clicks on purpose: the first one only asks "are you sure".
  if (btn.dataset.armed !== '1') {
    btn.dataset.armed = '1';
    btn.textContent = `¿Seguro? Aplicar ${VP.num(items.length)} cambio${items.length !== 1 ? 's' : ''}`;
    setTimeout(() => { if (btn.dataset.armed === '1') ajShopUpdateSummary(); }, 6000);
    return;
  }

  const summary = document.getElementById('aj-shop-summary');
  const content = document.getElementById('aj-shop-content');
  content.querySelectorAll('select').forEach(s => { s.disabled = true; });
  document.getElementById('aj-shop-threshold').disabled = true;
  btn.disabled = true;

  const failed = [];
  let applied = 0, done = 0, aborted = '';
  for (let i = 0; i < items.length; i += AJ_SHOP_BATCH) {
    const batch = items.slice(i, i + AJ_SHOP_BATCH);
    summary.textContent = `Aplicando… ${VP.num(done)} de ${VP.num(items.length)}`;
    try {
      const res = await VP.post({ action: 'resolve_shopify_matches_bulk', items: batch });
      if (res.error) throw new Error(res.error);        // the server answers HTTP 200 even for errors
      applied += res.applied || 0;
      (res.results || []).filter(r => !r.ok).forEach(r => failed.push(r));
    } catch (e) {
      aborted = e.message;                              // already-applied batches stay applied; the reload shows what is left
      break;
    }
    done += batch.length;
  }

  const nameOf = key => { const g = ajShopGroups.find(x => x.key === key); return g ? (g.incoming.name || g.incoming.email || key) : key; };
  let banner = `<div style="padding:10px 12px;margin-bottom:10px;border-radius:var(--radius-sm);font-size:13px;background:${aborted || failed.length ? 'var(--amber-bg)' : 'var(--green-bg)'};color:${aborted || failed.length ? 'var(--amber-text)' : 'var(--green-text)'}">
    ✓ ${VP.num(applied)} persona${applied !== 1 ? 's' : ''} aplicada${applied !== 1 ? 's' : ''}.`;
  if (failed.length) banner += `<br>No se pudo aplicar a ${VP.num(failed.length)}: ` + failed.map(f => `${VP.esc(nameOf(f.key))} (${VP.esc(f.error)})`).join('; ');
  if (aborted) banner += `<br>Se detuvo: ${VP.esc(aborted.replace(/[.\s]+$/, ''))}. Lo ya aplicado se conserva; la lista de abajo muestra lo que falta.`;
  banner += '</div>';

  document.getElementById('aj-shop-threshold').disabled = false;
  await ajShopLoad(banner);
}
