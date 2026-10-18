/* ============================================================================
   calidad.js — the photographic record of everything that left the building.
   Filters live in a sidebar (always visible on desktop, a drawer on mobile);
   results render as tiles or as a compact list.
   ==========================================================================*/

const CONTENT_COLS = ['Content1', 'Content2', 'Content3', 'Content4', 'Content5'];
const BOX_COLS     = ['Box1', 'Box2', 'Box3', 'Box4', 'Box5'];

let QC = [], ORDERS_BY_ID = {};
let currentPage = 1;
const PER_PAGE = 100;
let viewMode = localStorage.getItem('vp_cal_viewmode') || 'tiles';
let customerFilter = '';   // exact username once picked from the combo
let allUsernames = [];
let hasLoadedOnce = false; // tells a genuinely empty result apart from a load that hasn't finished/succeeded yet
let hasFullOrdersLoaded = false; // set once the actual action=orders payload (not just QC) has landed

// The full Orders sheet no longer fits in sessionStorage's ~5-10MB quota
// (confirmed: "[VP] cache write failed -- payload too large"), so the
// cache write silently failed every time, meaning this page was doing a
// slow uncached fetch on every load -- which is also what made the modal
// timing bug so easy to hit. Only the few fields this page actually reads
// need to be cached, same slimming pattern as home.js's slimOrders.
const SLIM_ORDER_FIELDS = ['Order ID', 'Products', 'Price', 'Shopify Order ID', 'Shopify Order Number', 'Shipped Date'];
function slimOrdersForCalidad(resp) {
  return {
    records: (resp.records || []).map(r => {
      const o = {};
      for (const f of SLIM_ORDER_FIELDS) o[f] = r[f];
      return o;
    }),
  };
}

let openModalQcId = null; // which order's modal is currently open, if any

function applyQcData(q, o) {
  QC = (q.records || []).filter(r => r['Status'] === 'Enviado');
  if (o && o.records) hasFullOrdersLoaded = true;
  // QC rows have no Timestamp column -- this sort was comparing '' to ''
  // and doing nothing. QC ID is 'QC-<zero-padded row>-<rand>', so it
  // sorts reliably by creation order (same fix as Historial in qc.js).
  QC.sort((a, b) => String(b['QC ID'] || '').localeCompare(String(a['QC ID'] || '')));
  ORDERS_BY_ID = {};
  (o.records || []).forEach(r => {
    // A combined shipment's Order ID is itself a " + "-joined string
    // ("123 + 456"), so a single component ID (what QC rows store, split
    // out by orderIdsOf) never matched this key. Index every component
    // individually -- the row is unchanged, just reachable by each of its
    // own order IDs, not only the full joined string.
    String(r['Order ID'] || '').split(' + ').map(s => s.trim()).filter(Boolean).forEach(id => {
      ORDERS_BY_ID[id] = r;
    });
  });
  allUsernames = [...new Set(QC.map(r => String(r['Primary Username'] || '').trim()).filter(Boolean))].sort();
  hasLoadedOnce = true;

  // The orders fetch can land well after the modal was opened (the full
  // Orders payload is large and sometimes slow, see the sessionStorage
  // quota fix below). A modal built before that data arrives froze on
  // whatever it had at that instant -- re-render it in place once fresh
  // data comes in, rather than requiring a close/reopen to see it.
  if (openModalQcId) {
    const row = QC.find(r => r['QC ID'] === openModalQcId);
    if (row) showOrderDetailModal(row);
  }
}

/* ── Manual refresh ─────────────────────────────────────────────────── */
// Bypasses the sessionStorage cache entirely, same as QC's manualRefresh --
// always a real network call, never a silent no-op served from cache.
async function manualRefresh() {
  const icon = document.getElementById('cal-refresh-icon');
  if (icon) icon.classList.add('spinning');
  try {
    const [q, o] = await Promise.all([
      VP.get('action=qc'),
      VP.get('action=orders').catch(() => ({ records: [] })),
    ]);
    applyQcData(q, o);
    render();
  } catch (e) {
    console.error('[calidad:manualRefresh]', e);
  } finally {
    if (icon) icon.classList.remove('spinning');
  }
}

/* ── Boot ───────────────────────────────────────────────────────────── */

(async function init() {
  wire();
  applyViewMode(viewMode);
  try {
    await VP.ensureToken();
    VP.mountNav('calidad');

    // Cache-first: show instantly if we have a prior snapshot, refresh
    // quietly in the background, re-render when fresh data lands.
    // VP.getCached returns { data, pending } -- always truthy, even with
    // nothing cached. Treating it as the payload itself (the bug this
    // replaces) meant gotCache was always true and the real fetch below
    // never ran, which is why the page needed the slow background
    // callback to eventually paint anything.
    let gotCache = false;
    let cq = { records: [] }, co = { records: [] };

    const qRes = VP.getCached('action=qc', fresh => { cq = fresh; applyQcData(fresh, co); render(); });
    const oRes = VP.getCached('action=orders', fresh => { co = fresh; applyQcData(cq, fresh); render(); }, { slim: slimOrdersForCalidad, cacheKey: 'orders_calidad_slim' });

    if (qRes.data) { cq = qRes.data; gotCache = true; }
    if (oRes.data) { co = oRes.data; gotCache = true; }

    if (gotCache) {
      applyQcData(cq, co);
      render();
    } else {
      const [q, o] = await Promise.all([
        VP.get('action=qc'),
        VP.get('action=orders').catch(() => ({ records: [] })),
      ]);
      applyQcData(q, o);
      render();
    }
  } catch (e) {
    console.error('[calidad]', e);
    document.getElementById('cal-content').innerHTML =
      `<div class="vp-empty-sm">No se pudo cargar el historial.
       <a href="#" onclick="location.reload();return false">Reintentar</a></div>`;
  }
})();

function wire() {
  // Sidebar drawer (mobile/tablet only — on desktop the sidebar is static)
  const sidebar  = document.getElementById('cal-sidebar');
  const backdrop = document.getElementById('cal-sidebar-backdrop');
  const openSidebar  = () => { sidebar.classList.add('is-open'); backdrop.classList.add('is-open'); };
  const closeSidebar = () => { sidebar.classList.remove('is-open'); backdrop.classList.remove('is-open'); };

  document.getElementById('cal-filter-toggle').addEventListener('click', openSidebar);
  document.getElementById('cal-sidebar-close').addEventListener('click', closeSidebar);
  backdrop.addEventListener('click', closeSidebar);

  // Tiles / list toggle
  document.getElementById('cal-viewmode').addEventListener('click', e => {
    const btn = e.target.closest('.vp-period-btn');
    if (!btn) return;
    applyViewMode(btn.dataset.mode);
    render();
  });

  // Text + date filters
  ['cal-search', 'cal-from', 'cal-to'].forEach(id => {
    const el = document.getElementById(id);
    el.addEventListener(id === 'cal-search' ? 'input' : 'change', () => { currentPage = 1; render(); });
  });

  // Native date inputs only reliably open their picker when you hit the
  // small calendar icon — clicking the text/number area does nothing in
  // several browsers. Force the picker open on any click in the field.
  ['cal-from', 'cal-to'].forEach(id => {
    const el = document.getElementById(id);
    el.addEventListener('click', () => { if (el.showPicker) el.showPicker(); });
  });

  wireCustomerCombo();

  document.getElementById('cal-clear').addEventListener('click', () => {
    document.getElementById('cal-search').value = '';
    document.getElementById('cal-from').value = '';
    document.getElementById('cal-to').value = '';
    document.getElementById('cal-customer').value = '';
    customerFilter = '';
    currentPage = 1;
    render();
    closeSidebar();
  });
}

function applyViewMode(mode) {
  viewMode = mode === 'list' ? 'list' : 'tiles';
  localStorage.setItem('vp_cal_viewmode', viewMode);
  document.querySelectorAll('#cal-viewmode .vp-period-btn')
    .forEach(b => b.classList.toggle('is-active', b.dataset.mode === viewMode));
}

/* Customer combo: type to narrow, click to pick. Typing a name that isn't
   picked from the list still filters loosely, so partial names work too. */
function wireCustomerCombo() {
  const input = document.getElementById('cal-customer');
  const list  = document.getElementById('cal-customer-list');

  const hide = () => { list.classList.remove('is-open'); };

  function renderOptions() {
    const q = input.value.trim().toLowerCase();
    const matches = (q ? allUsernames.filter(u => u.toLowerCase().includes(q)) : allUsernames).slice(0, 40);
    if (!matches.length) { hide(); return; }
    list.innerHTML = matches
      .map(u => `<div class="cal-combo-option" data-value="${VP.esc(u)}">${VP.esc(u)}</div>`)
      .join('');
    list.classList.add('is-open');
  }

  input.addEventListener('focus', renderOptions);
  input.addEventListener('input', () => {
    customerFilter = '';        // free typing = loose match, not a locked pick
    renderOptions();
    currentPage = 1;
    render();
  });

  list.addEventListener('mousedown', e => {
    const opt = e.target.closest('.cal-combo-option');
    if (!opt) return;
    e.preventDefault();
    input.value = opt.dataset.value;
    customerFilter = opt.dataset.value;
    hide();
    currentPage = 1;
    render();
  });

  input.addEventListener('blur', () => setTimeout(hide, 120));
}

/* ── Helpers ────────────────────────────────────────────────────────── */

const photosOf = r => [...CONTENT_COLS, ...BOX_COLS].map(c => r[c]).filter(Boolean);

function orderIdsOf(r) {
  // The QC sheet's actual header is 'TikTok Order IDs ' with a trailing
  // space -- confirmed by inspecting a live row -- so the plain key never
  // matched and TikTok order IDs were silently always empty. Read both so
  // this keeps working whether or not that trailing space ever gets
  // cleaned up in the sheet itself.
  const tiktokRaw = r['TikTok Order IDs'] !== undefined ? r['TikTok Order IDs'] : r['TikTok Order IDs '];
  return {
    tiktok:  String(tiktokRaw || '').split(' + ').filter(Boolean),
    shopify: String(r['Shopify Order IDs'] || '').split(' + ').filter(Boolean),
    manual:  String(r['Manual Order IDs']  || '').split(' + ').filter(Boolean),
  };
}

function productSummary(r) {
  const ids = orderIdsOf(r);
  const all = [...ids.tiktok, ...ids.shopify, ...ids.manual];
  const names = [];
  all.forEach(id => {
    const o = ORDERS_BY_ID[id];
    if (o && o['Products']) {
      VP.parseProducts(o['Products']).forEach(p => names.push(`${p.qty}× ${p.name}`));
    }
  });
  return names;
}

/* One searchable blob per row: username, tracking, every order id, and every
   product name. Built once per render pass rather than per keystroke. */
function searchBlob(r) {
  const ids = orderIdsOf(r);
  return [
    r['Primary Username'] || '',
    r['Tracking ID'] || '',
    ...ids.tiktok, ...ids.shopify, ...ids.manual,
    ...productSummary(r),
  ].join(' ').toLowerCase();
}

/* ── Filtering ──────────────────────────────────────────────────────── */

function filteredRows() {
  const q    = document.getElementById('cal-search').value.trim().toLowerCase();
  const from = document.getElementById('cal-from').value;
  const to   = document.getElementById('cal-to').value;
  const custTyped = document.getElementById('cal-customer').value.trim().toLowerCase();

  let rows = QC;

  if (customerFilter) {
    rows = rows.filter(r => String(r['Primary Username'] || '').trim() === customerFilter);
  } else if (custTyped) {
    rows = rows.filter(r => String(r['Primary Username'] || '').toLowerCase().includes(custTyped));
  }

  // QC rows carry no date of their own (same gap found throughout the QC
  // pipeline) -- Desde/Hasta silently matched zero rows always, since
  // VP.asDate(r['Timestamp']) was always undefined. The real date lives
  // on the linked Order's Shipped Date.
  if (from || to) {
    const fromMs = from ? new Date(from + 'T00:00:00').getTime() : null;
    const toMs = to ? new Date(to + 'T23:59:59').getTime() : null;
    rows = rows.filter(r => {
      const ids = orderIdsOf(r);
      const linked = [...ids.tiktok, ...ids.shopify, ...ids.manual].map(id => ORDERS_BY_ID[id]).find(Boolean);
      const d = linked ? VP.asDate(linked['Shipped Date']) : null;
      if (!d) return false;
      if (fromMs !== null && d.getTime() < fromMs) return false;
      if (toMs !== null && d.getTime() > toMs) return false;
      return true;
    });
  }

  if (q) rows = rows.filter(r => searchBlob(r).includes(q));

  return rows;
}

function anyFilterActive() {
  return !!(document.getElementById('cal-search').value.trim() ||
            document.getElementById('cal-from').value ||
            document.getElementById('cal-to').value ||
            document.getElementById('cal-customer').value.trim());
}

/* ── Render ─────────────────────────────────────────────────────────── */

function render() {
  const rows = filteredRows();

  document.getElementById('cal-count').textContent = anyFilterActive()
    ? `${VP.num(rows.length)} de ${VP.num(QC.length)} envío${QC.length !== 1 ? 's' : ''}`
    : `${VP.num(QC.length)} envío${QC.length !== 1 ? 's' : ''} con registro fotográfico`;

  const el = document.getElementById('cal-content');

  if (!rows.length) {
    let msg;
    if (!hasLoadedOnce) msg = '⚠ No se pudo cargar. Toca el botón de actualizar.';
    else if (anyFilterActive()) msg = 'Ningún envío coincide con esos filtros.';
    else msg = 'Todavía no hay envíos registrados.';
    el.innerHTML = `<div class="vp-empty-sm">${msg}</div>`;
    document.getElementById('cal-pagination-top').innerHTML = '';
    document.getElementById('cal-pagination-bottom').innerHTML = '';
    return;
  }

  const totalPages = Math.max(1, Math.ceil(rows.length / PER_PAGE));
  if (currentPage > totalPages) currentPage = totalPages;

  const start = (currentPage - 1) * PER_PAGE;
  const visible = rows.slice(start, start + PER_PAGE);

  el.innerHTML = viewMode === 'list'
    ? `<div class="cal-list">${visible.map(listRowHtml).join('')}</div>`
    : `<div class="vp-qc-grid">${visible.map(cardHtml).join('')}</div>`;

  const paginationHtml = renderPagination(totalPages, rows.length, start, visible.length);
  document.getElementById('cal-pagination-top').innerHTML = paginationHtml;
  document.getElementById('cal-pagination-bottom').innerHTML = paginationHtml;

  wireCardClicks(el);
}

function renderPagination(totalPages, totalCount, start, visibleCount) {
  if (totalPages <= 1) return '';
  const rangeStart = start + 1;
  const rangeEnd = start + visibleCount;

  const btn = (page, label, disabled, active) =>
    `<button class="cal-page-btn${active ? ' is-active' : ''}" data-page="${page}" ${disabled ? 'disabled' : ''}>${label}</button>`;

  // Keep it to a handful of page buttons even with many pages: first, last,
  // current, and immediate neighbors — with an ellipsis for the rest.
  const pages = new Set([1, totalPages, currentPage, currentPage - 1, currentPage + 1]);
  const sorted = [...pages].filter(p => p >= 1 && p <= totalPages).sort((a, b) => a - b);

  let pageButtons = '';
  let prev = 0;
  sorted.forEach(p => {
    if (p - prev > 1) pageButtons += `<span class="cal-page-ellipsis">…</span>`;
    pageButtons += btn(p, p, false, p === currentPage);
    prev = p;
  });

  return `<div class="cal-pagination">
    <span class="cal-pagination-range">${VP.num(rangeStart)}–${VP.num(rangeEnd)} de ${VP.num(totalCount)}</span>
    <div class="cal-pagination-btns">
      ${btn(currentPage - 1, '‹', currentPage === 1, false)}
      ${pageButtons}
      ${btn(currentPage + 1, '›', currentPage === totalPages, false)}
    </div>
  </div>`;
}

function goToPage(page) {
  currentPage = page;
  render();
  document.getElementById('cal-content').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// Delegate pagination clicks once, on the static wrapper elements, rather
// than re-binding every render (the buttons themselves are replaced each
// render, but their container isn't).
document.addEventListener('click', e => {
  const btn = e.target.closest('.cal-page-btn');
  if (!btn || btn.disabled) return;
  goToPage(Number(btn.dataset.page));
});

function channelTags(ids) {
  return [
    ids.tiktok.length  ? `<span class="vp-qc-tag tiktok">TikTok · ${ids.tiktok.length}</span>`   : '',
    ids.shopify.length ? `<span class="vp-qc-tag shopify">Shopify · ${ids.shopify.length}</span>` : '',
    ids.manual.length  ? `<span class="vp-qc-tag manual">Manual · ${ids.manual.length}</span>`   : '',
  ].filter(Boolean).join('');
}

// How many of this shipment's linked orders have a Notes value -- the
// manual notes people attach when confirming "send with this TikTok
// order", not the QC row's own Notes field (that one's shown separately).
function linkedOrderNotesCount(ids) {
  const allIds = [...ids.tiktok, ...ids.shopify, ...ids.manual];
  return allIds.map(id => ORDERS_BY_ID[id]).filter(o => o && o['Notes']).length;
}

function cardHtml(r) {
  const photos = photosOf(r);
  const ids    = orderIdsOf(r);
  const notesCount = linkedOrderNotesCount(ids);

  // The strip is a 3-column grid, so with 4+ photos we show 2 plus a counter
  // tile — otherwise the counter wraps onto its own row and the card breaks.
  const visible = photos.length > 3 ? photos.slice(0, 2) : photos.slice(0, 3);
  const cells = visible.map(u =>
    `<img src="${VP.esc(u)}" loading="lazy" alt="" data-lightbox="1" onclick="VP.lightbox('${u.replace(/'/g, "\\'")}')">`).join('');
  const extra = photos.length > 3
    ? `<div class="vp-qc-photos-more" data-lightbox="1" onclick="VP.lightbox('${photos[2].replace(/'/g, "\\'")}')">+${photos.length - 2}</div>`
    : '';

  // Info list: packed date, guía, per-channel order counts, notes count --
  // everything you'd actually want when troubleshooting for a customer.
  // Product names and the QC row's own Notes text were dropped -- the
  // card is a quick-scan summary now, full detail lives in the modal.
  // Always four lines, same order, every card -- a count of 0 still shows
  // as "0 Shopify" rather than the line disappearing, so the shape of the
  // card never shifts between orders.
  const infoLines = [
    `Empacado ${fmtTimeline24h(r['Timestamp'])}`,
    `Guía ${r['Tracking ID'] || '—'}`,
    `${ids.tiktok.length} pedido${ids.tiktok.length !== 1 ? 's' : ''} TikTok`,
    `${ids.shopify.length} pedido${ids.shopify.length !== 1 ? 's' : ''} Shopify`,
    notesCount ? `${notesCount} nota${notesCount !== 1 ? 's' : ''}` : 'Sin notas',
  ];

  return `<article class="vp-qc-card" data-qcid="${VP.esc(r['QC ID'] || '')}">
    <div class="vp-qc-photos">
      ${photos.length ? cells + extra : '<div class="vp-qc-nophoto">Sin fotos</div>'}
    </div>
    <div class="vp-qc-body">
      <div class="vp-qc-user">${VP.esc(r['Primary Username'] || '—')}${ids.tiktok.length ? ` <span class="vp-qc-ttid-prominent">${VP.esc(ids.tiktok[0])}${ids.tiktok.length > 1 ? ' +' + (ids.tiktok.length - 1) : ''}</span>` : ''}</div>
      <div class="vp-qc-info">${infoLines.map(l => `<div>${VP.esc(l)}</div>`).join('')}</div>
    </div>
  </article>`;
}

function listRowHtml(r) {
  const photos = photosOf(r);
  const ids    = orderIdsOf(r);
  const prods  = productSummary(r);
  const thumb  = photos.length
    ? `<img class="cal-list-thumb" src="${VP.esc(photos[0])}" loading="lazy" alt=""
            data-lightbox="1" onclick="VP.lightbox('${photos[0].replace(/'/g, "\\'")}')">`
    : `<div class="cal-list-thumb cal-list-thumb--empty">—</div>`;

  return `<div class="cal-list-row" data-qcid="${VP.esc(r['QC ID'] || '')}">
    ${thumb}
    <div class="cal-list-main">
      <div class="cal-list-user">${VP.esc(r['Primary Username'] || '—')}</div>
      <div class="cal-list-sub">
        <code>${VP.esc(r['Tracking ID'] || '—')}</code>
        ${prods.length ? ` · ${VP.esc(prods.slice(0, 2).join(', '))}${prods.length > 2 ? ` +${prods.length - 2}` : ''}` : ''}
      </div>
    </div>
    <div class="cal-list-tags">${channelTags(ids)}</div>
    <div class="cal-list-when">
      ${VP.esc(VP.fmtDateTime(r['Timestamp']))}
      ${photos.length > 1 ? `<br><span class="cal-list-photocount">${photos.length} fotos</span>` : ''}
    </div>
  </div>`;
}

// Clicking anywhere on a card/row opens the order detail modal, EXCEPT
// clicks on a photo (data-lightbox="1"), which keep their existing
// enlarge-image behavior instead.
function wireCardClicks(container) {
  container.querySelectorAll('[data-qcid]').forEach(el => {
    el.addEventListener('click', e => {
      if (e.target.closest('[data-lightbox]')) return;
      const qcId = el.getAttribute('data-qcid');
      const row = QC.find(r => r['QC ID'] === qcId);
      if (row) showOrderDetailModal(row);
    });
  });
}

/* ── Order detail modal ────────────────────────────────────────────── */

const SHOPIFY_STORE_HANDLE = '41uqww-0a';

// One collapsible block per order, channel-aware: TikTok links to TikTok
// Seller, Shopify links to the Shopify admin, both show total price and
// item count collapsed, expanding to the full line-item list with
// per-item price on click. A combined shipment's several component IDs
// each get their own block -- never merged into one.
function renderDetailOrderBlock(id, channel, idx) {
  const o = ORDERS_BY_ID[id];
  const items = o ? VP.parseProducts(o['Products'] || '') : [];
  const itemCount = items.reduce((sum, p) => sum + (Number(p.qty) || 0), 0);
  const price = o && o['Price'] ? VP.mxn(o['Price']) : '—';

  let idLabel, idHref;
  if (channel === 'TikTok') {
    idLabel = id;
    idHref = `https://seller-mx.tiktok.com/order/detail?order_no=${encodeURIComponent(id)}&shop_region=MX`;
  } else if (channel === 'Shopify') {
    idLabel = (o && o['Shopify Order Number']) ? o['Shopify Order Number'] : id;
    idHref = o ? `https://admin.shopify.com/store/${SHOPIFY_STORE_HANDLE}/orders/${o['Shopify Order ID'] || id}` : '';
  } else {
    idLabel = id;
    idHref = '';
  }

  const itemRows = items.length
    ? items.map(p => `<div class="cal-detail-item"><span>${VP.esc(p.qty)}×</span><span>${VP.esc(p.name)}</span>${p.price ? `<span class="cal-detail-item-price">${VP.mxn(p.price)}</span>` : ''}</div>`).join('')
    : '<div class="cal-detail-item cal-detail-item--empty">Sin detalle de productos</div>';

  const detailId = `cal-order-detail-${idx}`;
  const labelHtml = channel === 'Shopify'
    ? `<span class="cal-detail-order-id">Shopify #${VP.esc(idLabel)}</span>${idHref ? `<a href="${idHref}" target="_blank" rel="noopener noreferrer" class="cal-detail-order-link" onclick="event.stopPropagation()">Ver en Shopify →</a>` : ''}`
    : idHref
      ? `<a href="${idHref}" target="_blank" rel="noopener noreferrer" class="cal-detail-order-id" onclick="event.stopPropagation()">TikTok ${VP.esc(idLabel)}</a>`
      : `<span class="cal-detail-order-id">${VP.esc(idLabel)}</span>`;

  // Collapsible, same open/close pattern as the item list above it, keyed
  // separately so a visitor can open items and notes independently.
  const notesDetailId = `cal-order-notes-${idx}`;
  const noteText = o && o['Notes'] ? o['Notes'] : '';
  const notesHtml = noteText
    ? `<div class="cal-detail-order-notes-toggle" onclick="document.getElementById('${notesDetailId}').classList.toggle('open')">
         <span class="cal-detail-order-chevron">▸</span> 1 nota
       </div>
       <div class="cal-detail-order-notes" id="${notesDetailId}">${VP.esc(noteText)}</div>`
    : '';

  return `<div class="cal-detail-order">
    <div class="cal-detail-order-head" onclick="document.getElementById('${detailId}').classList.toggle('open')">
      <span class="cal-detail-order-chevron">▸</span>
      ${labelHtml}
      <span class="cal-detail-order-summary">${itemCount} art. · ${price}</span>
    </div>
    <div class="cal-detail-order-items" id="${detailId}">${itemRows}</div>
    ${notesHtml}
  </div>`;
}

// 24h time, local to this timeline only -- VP.fmtDateTime is shared across
// the whole app (Pedidos cards, etc.) and stays 12h there; nothing else
// asked for that to change.
function fmtTimeline24h(v) {
  const d = VP.asDate(v);
  if (!d) return '—';
  return d.toLocaleString('es-MX', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
}

const AUDIT_ACTION_LABELS = {
  qc_photo_added: 'Foto agregada',
  qc_photo_removed: 'Foto eliminada',
  save_qc: 'Guardado',
  finalize_shipment: 'Envío finalizado',
  update_order_status: 'Estado actualizado',
  import_tiktok_order: 'Importado (TikTok)',
  import_shopify_order: 'Importado (Shopify)',
};
const AUDIT_GROUP_LABELS = { Content: 'contenido', Box: 'caja' };

function describeAuditEntry(en) {
  const label = AUDIT_ACTION_LABELS[en.action] || en.action;
  if ((en.action === 'qc_photo_added' || en.action === 'qc_photo_removed') && en.details && en.details.group) {
    return `${label} · ${AUDIT_GROUP_LABELS[en.details.group] || en.details.group}`;
  }
  if (en.field) {
    return `${label} · ${en.field}: ${en.before || '—'} → ${en.after || '—'}`;
  }
  return label;
}

async function loadAndRenderAuditTrail(qcId, orderIds) {
  const el = document.getElementById('cal-detail-timeline');
  if (!el) return;
  try {
    const data = await VP.get(`action=audit_trail&qc_id=${encodeURIComponent(qcId || '')}&order_ids=${encodeURIComponent(orderIds.join(','))}`);
    const entries = data.entries || [];
    if (!entries.length) { el.innerHTML = '<div class="vp-empty-sm">Sin historial</div>'; return; }
    el.innerHTML = entries.map(en => `<div class="cal-detail-timeline-row">
        <span class="cal-detail-timeline-time">${VP.esc(fmtTimeline24h(en.timestamp))}</span>
        <span class="cal-detail-timeline-person">${VP.esc(en.person || '—')}</span>
        <span class="cal-detail-timeline-what">${VP.esc(describeAuditEntry(en))}</span>
      </div>`).join('');
  } catch (e) {
    el.innerHTML = '<div class="vp-empty-sm">No se pudo cargar el historial</div>';
  }
}

function showOrderDetailModal(r) {
  openModalQcId = r['QC ID'] || null;
  const modalRoot = document.getElementById('modal-container') || createModalRoot();
  const ids = orderIdsOf(r);
  const photos = photosOf(r);

  let idx = 0;
  const orderBlocks = [
    ...ids.tiktok.map(id => renderDetailOrderBlock(id, 'TikTok', idx++)),
    ...ids.shopify.map(id => renderDetailOrderBlock(id, 'Shopify', idx++)),
    ...ids.manual.map(id => renderDetailOrderBlock(id, 'Manual', idx++)),
  ];
  const hasAnyIds = ids.tiktok.length + ids.shopify.length + ids.manual.length > 0;
  // "No orders found" is only a true empty state once the full Orders
  // payload has actually loaded -- before that, an id with no match yet
  // just means the data hasn't arrived, not that it doesn't exist.
  const orderBlocksHtml = orderBlocks.length
    ? orderBlocks.join('')
    : hasAnyIds && !hasFullOrdersLoaded
      ? '<div class="vp-empty-sm">Cargando pedidos…</div>'
      : '<div class="vp-empty-sm">No se encontraron los pedidos originales.</div>';

  // Grouped by Content vs Box, each with its own small label, instead of
  // one flat strip with no way to tell which kind of photo you're looking at.
  const contentPhotos = CONTENT_COLS.map(c => r[c]).filter(Boolean);
  const boxPhotos = BOX_COLS.map(c => r[c]).filter(Boolean);
  const photoGroupHtml = (label, urls) => urls.length
    ? `<div class="cal-detail-photo-group">
        <div class="cal-detail-photo-group-label">${label}</div>
        <div class="cal-detail-photos">${urls.map(u =>
          `<img src="${VP.esc(u)}" loading="lazy" alt="" onclick="VP.lightbox('${u.replace(/'/g, "\\'")}')">`).join('')}</div>
      </div>`
    : '';
  const photoGrid = (contentPhotos.length || boxPhotos.length)
    ? photoGroupHtml('Contenido', contentPhotos) + photoGroupHtml('Caja', boxPhotos)
    : '<div class="vp-empty-sm">Sin fotos</div>';

  // Empacado comes from the linked Order's own Shipped Date -- QC rows
  // carry no date of their own (same gap as the Historial sort fix).
  const allIds = [...ids.tiktok, ...ids.shopify, ...ids.manual];
  const linkedOrder = allIds.map(id => ORDERS_BY_ID[id]).find(Boolean);
  const shippedDate = linkedOrder ? linkedOrder['Shipped Date'] : '';

  modalRoot.innerHTML = `<div class="modal-overlay" id="modal-overlay">
    <div class="modal cal-detail-modal">
      <div class="modal-title">${VP.esc(r['Primary Username'] || 'Sin usuario')}${ids.tiktok.length ? ` <span class="vp-qc-ttid">${ids.tiktok.map(VP.esc).join(' + ')}</span>` : ''}</div>
      <div class="cal-detail-scroll">
        <div class="cal-detail-meta">
          <div><span class="cal-detail-label">Guía</span><code>${VP.esc(r['Tracking ID'] || '—')}</code></div>
          <div><span class="cal-detail-label">Empacado</span>${shippedDate ? VP.esc(VP.fmtDateTime(shippedDate)) : '—'}</div>
          ${r['Packer'] ? `<div><span class="cal-detail-label">Empacador</span>${VP.esc(r['Packer'])}</div>` : ''}
          ${r['Notes'] ? `<div><span class="cal-detail-label">Notas</span><span style="color:var(--amber-text)">${VP.esc(r['Notes'])}</span></div>` : ''}
        </div>
        <div class="cal-detail-section-title">Pedidos</div>
        ${orderBlocksHtml}
        <div class="cal-detail-section-title">Fotos</div>
        ${photoGrid}
        <div class="cal-detail-section-title">Historial</div>
        <div id="cal-detail-timeline"><div class="vp-loading">Cargando…</div></div>
      </div>
      <div class="modal-actions">
        <button class="btn" id="cal-detail-close">Cerrar</button>
      </div>
    </div>
  </div>`;

  document.getElementById('cal-detail-close').addEventListener('click', closeCalDetailModal);
  document.getElementById('modal-overlay').addEventListener('click', e => {
    if (e.target.id === 'modal-overlay') closeCalDetailModal();
  });

  loadAndRenderAuditTrail(r['QC ID'], allIds);
}

function closeCalDetailModal() {
  openModalQcId = null;
  const modalRoot = document.getElementById('modal-container');
  if (modalRoot) modalRoot.innerHTML = '';
}

function createModalRoot() {
  const div = document.createElement('div');
  div.id = 'modal-container';
  document.body.appendChild(div);
  return div;
}
