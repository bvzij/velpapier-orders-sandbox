/* ============================================================================
   calidad.js — the photographic record of everything that left the building.
   Filters live in a sidebar (always visible on desktop, a drawer on mobile);
   results render as tiles or as a compact list.
   ==========================================================================*/

VP.mountNav('calidad');

const CONTENT_COLS = ['Content1', 'Content2', 'Content3', 'Content4', 'Content5'];
const BOX_COLS     = ['Box1', 'Box2', 'Box3', 'Box4', 'Box5'];

let QC = [], ORDERS_BY_ID = {};
let currentPage = 1;
const PER_PAGE = 100;
let viewMode = localStorage.getItem('vp_cal_viewmode') || 'tiles';
let customerFilter = '';   // exact username once picked from the combo
let allUsernames = [];

function applyQcData(q, o) {
  QC = (q.records || []).filter(r => r['Status'] === 'Enviado');
  QC.sort((a, b) => String(b['Timestamp'] || '').localeCompare(String(a['Timestamp'] || '')));
  ORDERS_BY_ID = {};
  (o.records || []).forEach(r => { ORDERS_BY_ID[r['Order ID']] = r; });
  allUsernames = [...new Set(QC.map(r => String(r['Primary Username'] || '').trim()).filter(Boolean))].sort();
}

/* ── Boot ───────────────────────────────────────────────────────────── */

(async function init() {
  wire();
  applyViewMode(viewMode);
  try {
    await VP.ensureToken();

    // Cache-first: show instantly if we have a prior snapshot, refresh
    // quietly in the background, re-render when fresh data lands.
    let gotCache = false;
    let cq = { records: [] }, co = { records: [] };

    const cachedQ = VP.getCached('action=qc', fresh => { cq = fresh; applyQcData(fresh, co); render(); });
    const cachedO = VP.getCached('action=orders', fresh => { co = fresh; applyQcData(cq, fresh); render(); });

    if (cachedQ) { cq = cachedQ; gotCache = true; }
    if (cachedO) { co = cachedO; gotCache = true; }

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
  return {
    tiktok:  String(r['TikTok Order IDs']  || '').split(' + ').filter(Boolean),
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

  if (from) {
    const fromMs = new Date(from + 'T00:00:00').getTime();
    rows = rows.filter(r => { const d = VP.asDate(r['Timestamp']); return d && d.getTime() >= fromMs; });
  }
  if (to) {
    const toMs = new Date(to + 'T23:59:59').getTime();
    rows = rows.filter(r => { const d = VP.asDate(r['Timestamp']); return d && d.getTime() <= toMs; });
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
    el.innerHTML = `<div class="vp-empty-sm">${anyFilterActive()
      ? 'Ningún envío coincide con esos filtros.'
      : 'Todavía no hay envíos registrados.'}</div>`;
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

function cardHtml(r) {
  const photos = photosOf(r);
  const ids    = orderIdsOf(r);
  const prods  = productSummary(r);

  // The strip is a 3-column grid, so with 4+ photos we show 2 plus a counter
  // tile — otherwise the counter wraps onto its own row and the card breaks.
  const visible = photos.length > 3 ? photos.slice(0, 2) : photos.slice(0, 3);
  const cells = visible.map(u =>
    `<img src="${VP.esc(u)}" loading="lazy" alt="" data-lightbox="1" onclick="VP.lightbox('${u.replace(/'/g, "\\'")}')">`).join('');
  const extra = photos.length > 3
    ? `<div class="vp-qc-photos-more" data-lightbox="1" onclick="VP.lightbox('${photos[2].replace(/'/g, "\\'")}')">+${photos.length - 2}</div>`
    : '';

  return `<article class="vp-qc-card" data-qcid="${VP.esc(r['QC ID'] || '')}">
    <div class="vp-qc-photos">
      ${photos.length ? cells + extra : '<div class="vp-qc-nophoto">Sin fotos</div>'}
    </div>
    <div class="vp-qc-body">
      <div class="vp-qc-user">${VP.esc(r['Primary Username'] || '—')}</div>
      <div class="vp-qc-meta">
        <code>${VP.esc(r['Tracking ID'] || '—')}</code><br>
        ${VP.esc(VP.fmtDateTime(r['Timestamp']))}
        ${prods.length ? `<br><span style="color:var(--text-faint)">${VP.esc(prods.slice(0, 3).join(', '))}${prods.length > 3 ? ` +${prods.length - 3}` : ''}</span>` : ''}
        ${r['Notes'] ? `<br><span style="color:var(--amber-text)">${VP.esc(r['Notes'])}</span>` : ''}
      </div>
      <div class="vp-qc-tags">${channelTags(ids)}</div>
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

function showOrderDetailModal(r) {
  const modalRoot = document.getElementById('modal-container') || createModalRoot();
  const ids = orderIdsOf(r);
  const photos = photosOf(r);

  const allOrderIds = [...ids.tiktok, ...ids.shopify, ...ids.manual];
  const orders = allOrderIds.map(id => ORDERS_BY_ID[id]).filter(Boolean);

  const orderBlocks = orders.length
    ? orders.map(o => {
        const items = VP.parseProducts(o['Products'] || '');
        const itemRows = items.length
          ? items.map(p => `<div class="cal-detail-item"><span>${VP.esc(p.qty)}×</span><span>${VP.esc(p.name)}</span></div>`).join('')
          : '<div class="cal-detail-item cal-detail-item--empty">Sin detalle de productos</div>';
        return `<div class="cal-detail-order">
          <div class="cal-detail-order-head">
            <span class="cal-detail-order-id">${VP.esc(o['Order ID'] || '—')}</span>
            <span class="cal-detail-order-price">${o['Price'] ? VP.mxn(o['Price']) : '—'}</span>
          </div>
          ${itemRows}
        </div>`;
      }).join('')
    : '<div class="vp-empty-sm">No se encontraron los pedidos originales.</div>';

  const photoGrid = photos.length
    ? `<div class="cal-detail-photos">${photos.map(u =>
        `<img src="${VP.esc(u)}" loading="lazy" alt="" onclick="VP.lightbox('${u.replace(/'/g, "\\'")}')">`).join('')}</div>`
    : '<div class="vp-empty-sm">Sin fotos</div>';

  modalRoot.innerHTML = `<div class="modal-overlay" id="modal-overlay">
    <div class="modal cal-detail-modal">
      <div class="modal-title">${VP.esc(r['Primary Username'] || 'Sin usuario')}</div>
      <div class="cal-detail-scroll">
        <div class="cal-detail-meta">
          <div><span class="cal-detail-label">Guía</span><code>${VP.esc(r['Tracking ID'] || '—')}</code></div>
          <div><span class="cal-detail-label">Empacado</span>${VP.esc(VP.fmtDateTime(r['Timestamp']))}</div>
          ${r['Packer'] ? `<div><span class="cal-detail-label">Empacador</span>${VP.esc(r['Packer'])}</div>` : ''}
          ${r['Notes'] ? `<div><span class="cal-detail-label">Notas</span><span style="color:var(--amber-text)">${VP.esc(r['Notes'])}</span></div>` : ''}
        </div>
        <div class="cal-detail-section-title">Pedidos</div>
        ${orderBlocks}
        <div class="cal-detail-section-title">Fotos</div>
        ${photoGrid}
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
}

function closeCalDetailModal() {
  const modalRoot = document.getElementById('modal-container');
  if (modalRoot) modalRoot.innerHTML = '';
}

function createModalRoot() {
  const div = document.createElement('div');
  div.id = 'modal-container';
  document.body.appendChild(div);
  return div;
}
