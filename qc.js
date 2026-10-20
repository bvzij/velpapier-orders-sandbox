// qc.js — Vel Papier QC capture page logic (multi-photo galleries)

const API = 'https://script.google.com/macros/s/AKfycbyeywjfBWA0hFSy_3U3A2iYLE2TlPN22pBOELJ97N-FTAkgXkEAk6Af0aG1O3DjK8OjHw/exec';
const MAX_PHOTOS = 5;

// Packing sessions were fully removed (see ways-of-working / to-do list):
// the gate, banner, start/end-session flow, and the three-way
// Pendientes/Empacados/Historial split are gone. Session ID stays on
// existing QC rows as historical data, and the start_session/end_session/
// update_session_participants backend actions are untouched -- nothing in
// this file calls them anymore.
let API_TOKEN = localStorage.getItem('vp_token') || '';

let allActiveOrders = [];
let allQcRows = [];       // fetched once at page load, looked up in memory
let selected = null;      // { tracking_id, order_ids:[{id,channel}], customer_id, username }
let selectedAddons = [];  // [{id, channel}] for checked add-on orders
let currentQcId = null;
let uploadsInFlight = 0;
let savingInProgress = false; // true for the whole duration of a submitQC() call -- nothing else may re-enable the button while this is set
// For orders with no tracking ID: ONE id per capture session, created when
// the order is opened. It used to be 'MAN-' + Date.now() on every save, so
// two quick saves could create two separate QC rows (FIX_LOG 0.5).
let manualTrackingId = '';
let wakeLock = null;
let photoSyncsInFlight = 0; // pending pushAddPhoto/pushRemovePhoto calls -- the poll must not merge server state while one of these hasn't landed yet, or it overwrites a photo that uploaded fine but isn't in the sheet yet

// Photo galleries: array of {url} objects, up to MAX_PHOTOS each
const gallery = { content: [], box: [] };


// ── Auth ─────────────────────────────────────────────────────────────────

async function ensureAuth() {
  await VP.ensureToken();
  API_TOKEN = VP.token;
}

// Both go through the shared VP layer, which throws on backend errors
// (this page's own copies never checked them, so a failed save looked
// like a success -- FIX_LOG 0.4). 'already_shipped' is still returned as
// data because the callers below handle it themselves.
async function apiGet(query) {
  return VP.get(query);
}

async function apiPost(data) {
  return VP.post(data, { passErrors: ['already_shipped'] });
}


// ── Delta photo sync ─────────────────────────────────────────────────────
// Each add/remove is its own request that only touches ONE photo in ONE
// group. This is what lets two devices safely add photos to the same or
// different groups without ever wiping each other's work — unlike the old
// approach of syncing the entire local gallery array on every change.

let syncSeq = 0;

async function pushAddPhoto(group, url) {
  if (!selected) return null;
  const mySeq = ++syncSeq;
  try {
    const res = await apiPost({
      action:        'save_qc',
      qc_id:         currentQcId || undefined,
      // Session ID is intentionally NOT set here — only at finalize (Enviar).
      // Otherwise a row that's touched but never shipped would still count
      // as "packed in this session," polluting counts and history.
      tracking_id:   selected.tracking_id || manualTrackingId,
      order_ids:     [...selected.order_ids, ...selectedAddons],
      customer_id:   selected.customer_id,
      username:      selected.username,
      packer:        currentPacker(),
      [group === 'content' ? 'add_content' : 'add_box']: url,
    });
    if (res.error === 'already_shipped') return { blocked: true };
    if (res.error) throw new Error(res.error);
    if (mySeq === syncSeq && res.qc_id) currentQcId = res.qc_id;
    return res;
  } catch (e) {
    console.error('[pushAddPhoto] failed:', e);
    showToast('La foto se subió pero no se guardó en el registro: ' + e.message, true);
    return null;
  }
}

async function pushRemovePhoto(group, url) {
  if (!selected || !currentQcId) return null;
  try {
    const res = await apiPost({
      action:      'save_qc',
      qc_id:       currentQcId,
      tracking_id: selected.tracking_id || manualTrackingId,
      [group === 'content' ? 'remove_content' : 'remove_box']: url,
    });
    if (res.error === 'already_shipped') return { blocked: true };
    if (res.error) throw new Error(res.error);
    return res;
  } catch (e) {
    console.error('[pushRemovePhoto] failed:', e);
    showToast('No se pudo quitar la foto del registro: ' + e.message, true);
    return null;
  }
}

async function pushNotesAndOrders() {
  if (!selected) return;
  if (!currentQcId && gallery.content.length === 0 && gallery.box.length === 0) return;
  try {
    const res = await apiPost({
      action:        'save_qc',
      qc_id:         currentQcId || undefined,
      tracking_id:   selected.tracking_id || manualTrackingId,
      order_ids:     [...selected.order_ids, ...selectedAddons],
      customer_id:   selected.customer_id,
      username:      selected.username,
      packer:        currentPacker(),
      notes:         document.getElementById('qc-notes').value.trim(),
    });
    if (res.error === 'already_shipped') {
      showToast('Este pedido ya fue enviado — no se pueden guardar más cambios', true);
      return;
    }
    if (res.qc_id) currentQcId = res.qc_id;
  } catch (e) {
    console.error('[pushNotesAndOrders] failed:', e);
    showToast('No se guardaron las notas: ' + e.message, true);
  }
}


// ── Init ─────────────────────────────────────────────────────────────────

// ── Packer tracking (UI disabled, backend kept intact) ─────────────────
// The packer picker UI (button + checklist modal) was removed since packing
// is currently done by one person. The underlying Session Participants /
// QC-row Packer plumbing is left fully working underneath, just fed by a
// hardcoded single-packer default instead of a checklist, so re-enabling
// multi-packer selection later only requires restoring the UI, not rebuilding
// this logic. Update DEFAULT_PACKER (or restore the checklist UI) when
// there's more than one packer again.
const DEFAULT_PACKER = 'Vel';
let knownPackers = [DEFAULT_PACKER];
let checkedPackers = [DEFAULT_PACKER];

function saveKnownPackers() { /* no-op while the picker UI is disabled */ }
function saveCheckedPackers() { /* no-op while the picker UI is disabled */ }

function currentPacker() {
  // Used for the single "Packer" column on each QC row — first checked name, or blank
  return checkedPackers[0] || '';
}

function updatePackersBtnLabel() { /* no-op: packer button removed from the UI */ }

(async function init() {
  await ensureAuth();
  switchTab('pending');
  await loadPending();
  setInterval(() => {
    if (document.getElementById('view-pending').style.display !== 'none') {
      refreshQcBadges();
    } else if (document.getElementById('view-capture').style.display !== 'none') {
      pollCaptureUpdates();
    }
  }, 4000);
})();

// While inside an order, quietly check the server for photos another device
// may have added/removed, and merge them in — this is the real-time sync
// that was missing before (previously only the list view polled).
let pollingCapture = false;
async function pollCaptureUpdates() {
  if (!selected || !selected.tracking_id || pollingCapture) return;
  pollingCapture = true;
  try {
    const data = await apiGet(`action=qc&tracking_ids=${encodeURIComponent(selected.tracking_id)}`);
    const row = (data.records || [])[0];
    if (!row) { pollingCapture = false; return; }
    if (!currentQcId && row['QC ID']) currentQcId = row['QC ID'];

    const nowShipped = row['Status'] === 'Enviado';
    if (nowShipped && !shippedLockShown && !localFinalizeInProgress) {
      shippedLockShown = true;
      applyShippedLock(true);
    }

    // Never merge server photos into a gallery that's mid-edit on this
    // device (editing a shipped order overwrites wholesale on save — pulling
    // in server changes mid-edit would be confusing and could clobber intent).
    // Also never merge while a save is actually in flight -- the server's
    // row can still reflect the pre-save state for several seconds after
    // submitQC() was called, and overwriting the local gallery with that
    // stale snapshot is exactly what made photos flash away mid-save.
    if (!isEditingShipped && !savingInProgress && photoSyncsInFlight === 0) {
      ['content', 'box'].forEach(group => {
        const cols = group === 'content'
          ? ['Content1','Content2','Content3','Content4','Content5']
          : ['Box1','Box2','Box3','Box4','Box5'];
        const serverUrls = cols.map(c => row[c]).filter(Boolean);
        const localUrls = gallery[group].filter(p => !p.uploading).map(p => p.url);

        // Only touch the gallery if the server genuinely has something new —
        // avoids clobbering a photo that's mid-upload on this exact device.
        const hasNew = serverUrls.some(u => !localUrls.includes(u));
        const hasRemoved = localUrls.some(u => !serverUrls.includes(u));
        if (hasNew || hasRemoved) {
          const uploadingPlaceholders = gallery[group].filter(p => p.uploading);
          gallery[group] = [...serverUrls.map(url => ({ url })), ...uploadingPlaceholders];
          renderGallery(group);
        }
      });
      if (!savingInProgress) {
        document.getElementById('qc-submit').disabled = gallery.content.length === 0;
      }
    }
  } catch (e) {
    console.warn('[pollCaptureUpdates] failed:', e);
  }
  pollingCapture = false;
}
let shippedLockShown = false;
let localFinalizeInProgress = false;

// ── Pending list ─────────────────────────────────────────────────────────

let hasLoadedOnce = false;

function applyPendingData(ordersData, qcData) {
  allActiveOrders = ordersData.records || [];
  allQcRows = qcData.records || [];
  hasLoadedOnce = true;
}

// Manual refresh button -- bypasses the sessionStorage cache so a stuck or
// stale list (e.g. after the tab was backgrounded a long time) can always
// be force-reloaded without waiting for the 20s auto-refresh.
async function manualRefresh() {
  const icon = document.getElementById('refresh-icon');
  if (icon) icon.classList.add('spinning');
  try {
    if (currentTab === 'history') { historyPage = 0; await refreshQcBadges(); }
    else await loadPending(true); // forceFresh -- a manual refresh must never be a silent no-op served from cache
  } catch (e) {
    console.warn('[manualRefresh] failed:', e);
  } finally {
    if (icon) icon.classList.remove('spinning');
  }
}

async function loadPending(forceFresh) {
  document.getElementById('view-pending').style.display = 'block';
  const list = document.getElementById('pending-list');

  // Cache-first: if we have a snapshot from earlier this session, show it
  // instantly instead of a blank "Cargando..." state, then quietly refresh
  // in the background. A 20s auto-refresh timer (see below) keeps this
  // page from ever drifting far out of date during active packing, since
  // stale pack-status here risks a real double-pack mistake.
  // forceFresh (set only by the manual refresh button) skips this entirely
  // -- previously a hit here made the button finish instantly with no
  // real network call, which looked exactly like "the button doesn't work."
  if (!forceFresh) {
    let gotCache = false;
    let cachedOrdersData = { records: [] }, cachedQcData = { records: [] };

    // VP.getCached returns { data, pending } -- an object that is ALWAYS
    // truthy, even with nothing cached. Treating it as the payload meant
    // gotCache was always true and applyPendingData read `.records` off
    // the wrapper (undefined), wiping allActiveOrders to [] on every call
    // and returning before the real fetch. That is what emptied the
    // pending list every 20s, and why only the manual refresh fixed it.
    const ordersRes = VP.getCached('action=orders&status=Pagado,No Pagado,Anotado', fresh => {
      cachedOrdersData = fresh;
      applyPendingData(cachedOrdersData, cachedQcData);
      renderPendingList();
    });
    const qcRes = VP.getCached('action=qc', fresh => {
      cachedQcData = fresh;
      applyPendingData(cachedOrdersData, cachedQcData);
      renderPendingList();
    });

    if (ordersRes.data) { cachedOrdersData = ordersRes.data; gotCache = true; }
    if (qcRes.data)     { cachedQcData = qcRes.data; gotCache = true; }

    if (gotCache) {
      applyPendingData(cachedOrdersData, cachedQcData);
      renderPendingList();
      return;
    }
  }

  list.innerHTML = '<div class="empty-state">Cargando…</div>';
  try {
    let [ordersData, qcData] = await Promise.all([
      apiGet('action=orders&status=Pagado,No Pagado,Anotado'),
      apiGet('action=qc'),
    ]);
    // Apps Script occasionally returns a valid-but-empty response under load
    // (same flakiness already worked around in the Python import service's
    // _fetch_customers retry logic). An orders response with zero records
    // here is almost always this glitch, not a real "nothing to pack" state
    // -- so retry once before trusting it, rather than showing a false
    // "all done" empty state that could get an order skipped.
    if ((ordersData.records || []).length === 0) {
      console.warn('[loadPending] orders came back empty on first try, retrying once...');
      await new Promise(r => setTimeout(r, 600));
      ordersData = await apiGet('action=orders&status=Pagado,No Pagado,Anotado');
    }
    applyPendingData(ordersData, qcData);
  } catch (e) {
    list.innerHTML = '<div class="empty-state">Error al cargar. Desliza para reintentar.</div>';
    return;
  }

  renderPendingList();
}

// Keeps the pending list from drifting stale during an active packing
// session -- forces a real (non-cached) refresh every 20s so this page
// never shows an order as "still needs packing" long after someone else
// already packed it.
setInterval(() => {
  // tab-history lives inside view-pending, so this must also check which
  // tab is actually showing -- otherwise the pending refresh keeps firing
  // (and re-rendering) while the user is reading Historial.
  if (currentTab === 'pending' && document.getElementById('view-pending').style.display !== 'none') {
    loadPending();
  }
}, 20000);

// ── Tabs: Pendientes / Historial ─────────────────────────────

let currentTab = 'pending';

function renderCurrentTab() {
  if (currentTab === 'history') renderHistoryList();
  else renderPendingList();
}

function switchTab(tab) {
  currentTab = tab;
  // view-pending itself must also be shown here -- it used to be turned
  // back on by checkSessionAndRoute() (now removed along with sessions),
  // and nothing replaced that responsibility. Without this line, leaving
  // an order via Volver left view-pending stuck at display:none forever,
  // which looked exactly like "the whole list disappeared."
  document.getElementById('view-pending').style.display = 'block';
  const tabs = { pending: 'tab-pending', history: 'tab-history' };
  Object.entries(tabs).forEach(([key, id]) => {
    document.getElementById(id).style.display = key === tab ? 'block' : 'none';
    const btn = document.getElementById(`tab-btn-${key}`);
    btn.style.background = key === tab ? 'var(--text)' : 'var(--surface2)';
    btn.style.color = key === tab ? 'var(--surface)' : 'var(--text-muted)';
  });
  if (tab === 'history') { historyPage = 0; renderHistoryList(); }
}

function setHistorySort(mode) {
  historySortMode = mode;
  historyPage = 0;
  renderHistoryList();
}

function runHistorySearch() {
  historyPage = 0;
  renderHistoryList();
}

// Flat, paginated list of everything ever packed -- no session grouping.
// allQcRows is already loaded for the pending view; Historial reuses it
// instead of a separate fetch, filtered to Enviado and sorted newest-first.
const HISTORY_PAGE_SIZE = 20;
let historyPage = 0;

// Same multi-field match as Calidad's search (searchBlob in calidad.js):
// username, tracking ID, and every TikTok/Shopify/Manual order ID in one
// box. Product names are left out here -- unlike Calidad, QC rows don't
// carry the full Orders data needed to resolve a product name, and
// fetching the whole Orders sheet just for this search isn't worth it.
function historySearchBlob(r) {
  const ids = [
    ...String(r['TikTok Order IDs'] || '').split(' + ').filter(Boolean),
    ...String(r['Shopify Order IDs'] || '').split(' + ').filter(Boolean),
    ...String(r['Manual Order IDs'] || '').split(' + ').filter(Boolean),
  ];
  return [r['Primary Username'] || '', r['Tracking ID'] || '', ...ids].join(' ').toLowerCase();
}

let historySortMode = 'new-old';

function renderHistoryList() {
  const list = document.getElementById('history-list-tab');
  let rows = allQcRows.filter(r => r['Status'] === 'Enviado');

  const searchInput = document.getElementById('history-search-input');
  const query = searchInput ? searchInput.value.trim().toLowerCase() : '';
  if (query) rows = rows.filter(r => historySearchBlob(r).includes(query));

  // QC rows carry no date column (saveQC writes Shipped Date to the Orders
  // sheet, not this one), which is why sorting on it did nothing. QC ID is
  // 'QC-<zero-padded row>-<rand>', so it sorts reliably by creation order.
  rows = rows.slice().sort((a, b) => {
    const aT = String(a['QC ID'] || '');
    const bT = String(b['QC ID'] || '');
    return historySortMode === 'old-new' ? aT.localeCompare(bT) : bT.localeCompare(aT);
  });

  if (rows.length === 0) {
    list.innerHTML = `<div class="empty-state">${query ? 'Sin resultados para "' + escapeHtml(query) + '"' : 'Nada empacado todav\u00eda'}</div>`;
    return;
  }

  const start = historyPage * HISTORY_PAGE_SIZE;
  const pageRows = rows.slice(start, start + HISTORY_PAGE_SIZE);
  const hasMore = rows.length > start + HISTORY_PAGE_SIZE;

  list.innerHTML = pageRows.map(row => {
    const photoCount = ['Content1','Content2','Content3','Content4','Content5','Box1','Box2','Box3','Box4','Box5']
      .filter(c => row[c]).length;
    const tikTokIds = String(row['TikTok Order IDs'] || '').split(' + ').filter(Boolean);
    const shopifyIds = String(row['Shopify Order IDs'] || '').split(' + ').filter(Boolean);
    const manualIds = String(row['Manual Order IDs'] || '').split(' + ').filter(Boolean);
    const orderIds = [
      ...tikTokIds.map(id => ({ id, channel: 'TikTok' })),
      ...shopifyIds.map(id => ({ id, channel: 'Shopify' })),
      ...manualIds.map(id => ({ id, channel: 'Manual' })),
    ];
    const ttIdHtml = tikTokIds.length
      ? ` <span class="vp-qc-ttid-prominent">${escapeHtml(tikTokIds[0])}${tikTokIds.length > 1 ? ' +' + (tikTokIds.length - 1) : ''}</span>`
      : '';
    return `
      <div class="pending-card" onclick='openCapture(${JSON.stringify({
        tracking_id: row['Tracking ID'] || '',
        order_ids: orderIds,
        customer_id: row['Customer ID'] || '',
        username: row['Primary Username'] || '',
      }).replace(/'/g, "&apos;")})'>
        <div class="pending-card-top">
          <span class="pending-username">${escapeHtml(row['Primary Username'] || '\u2014')}${ttIdHtml}</span>
          <span class="pending-count">\u2713 Enviado</span>
        </div>
        <div class="pending-tracking">${escapeHtml(row['Tracking ID'] || '')}</div>
        <div class="pending-progress">${photoCount} foto${photoCount !== 1 ? 's' : ''}</div>
      </div>`;
  }).join('') + (hasMore
    ? `<button class="qc-submit" style="margin-top:10px" onclick="historyPage++; renderHistoryList()">Cargar m\u00e1s</button>`
    : '');
}

function anotadoOrdersByTracking() {
  const out = {};
  allActiveOrders.forEach(r => {
    if (r['Channel'] === 'TikTok' || r['Status'] !== 'Anotado') return;
    const tid = String(r['Linked Shipment'] || '').trim();
    if (!tid) return;
    (out[tid] = out[tid] || []).push(r);
  });
  return out;
}

function renderPendingList() {
  const list = document.getElementById('pending-list');
  const tikTokOrders = allActiveOrders.filter(r => r['Channel'] === 'TikTok' && r['Status'] === 'Pagado');
  if (tikTokOrders.length === 0) {
    // "Nothing pending" and "nothing has loaded yet" look identical from
    // this filter alone -- hasLoadedOnce (set in loadPending) tells them
    // apart, so a failed/incomplete load is never mistaken for a real
    // empty queue.
    list.innerHTML = hasLoadedOnce
      ? '<div class="empty-state">Sin órdenes TikTok pendientes de empacar 🎉</div>'
      : '<div class="empty-state">⚠ La lista no cargó correctamente. Toca el botón de actualizar.</div>';
    return;
  }

  // Tracking IDs already finalized (possibly on another device) — drop them
  const finalizedTids = new Set(
    allQcRows.filter(r => r['Status'] === 'Enviado').map(r => r['Tracking ID'])
  );

  const groups = {};
  tikTokOrders.forEach(r => {
    const tid = r['Tracking ID'] || ('order:' + r['Order ID']);
    if (finalizedTids.has(tid)) return;
    if (!groups[tid]) groups[tid] = [];
    groups[tid].push(r);
  });

  // Shopify/Manual orders written on a shipment's label in Pedidos
  // (Status Anotado, Linked Shipment = that tracking ID). Shown on the
  // card here and pre-selected as add-ons when the shipment is opened.
  const anotadoByTid = anotadoOrdersByTracking();

  // Search filter — by username or tracking ID
  const searchInput = document.getElementById('search-input');
  const query = searchInput ? searchInput.value.trim().toLowerCase() : '';
  let filteredEntries = Object.entries(groups);
  if (query) {
    filteredEntries = filteredEntries.filter(([tid, orders]) => {
      const username = (orders[0]['Username'] || orders[0]['Primary Username'] || '').toLowerCase();
      const ttIds = orders.map(o => String(o['Order ID'] || '')).join(' ').toLowerCase();
      return username.includes(query) || tid.toLowerCase().includes(query) || ttIds.includes(query);
    });
  }

  const sortSelect = document.getElementById('sort-select');
  const sortMode = sortSelect ? sortSelect.value : 'az';
  const entries = filteredEntries;
  entries.sort(([, aOrders], [, bOrders]) => {
    const aUser = (aOrders[0]['Username'] || aOrders[0]['Primary Username'] || '').toLowerCase();
    const bUser = (bOrders[0]['Username'] || bOrders[0]['Primary Username'] || '').toLowerCase();
    const aDate = new Date(aOrders[0]['Created Date'] || aOrders[0]['Created Time'] || 0).getTime();
    const bDate = new Date(bOrders[0]['Created Date'] || bOrders[0]['Created Time'] || 0).getTime();
    if (sortMode === 'old-new') return aDate - bDate;
    if (sortMode === 'az') return aUser.localeCompare(bUser);
    if (sortMode === 'za') return bUser.localeCompare(aUser);
    return bDate - aDate; // new-old (default)
  });

  if (entries.length === 0) {
    list.innerHTML = `<div class="empty-state">${query ? 'Sin resultados para "' + escapeHtml(query) + '"' : 'Sin órdenes TikTok pendientes de empacar 🎉'}</div>`;
    return;
  }

  const urgentOf = tid => { const q = allQcRows.find(r => r['Tracking ID'] === tid); return !!(q && q['Urgent']); };
  const userOf = ([, o]) => (o[0]['Username'] || o[0]['Primary Username'] || '').toLowerCase();
  const urgentEntries = entries.filter(([tid]) => urgentOf(tid)).sort((a, b) => userOf(a).localeCompare(userOf(b)));
  const normalEntries = entries.filter(([tid]) => !urgentOf(tid));
  list.innerHTML = [...urgentEntries, ...normalEntries].map(([tid, orders]) => {
    const first = orders[0];
    const username = first['Username'] || first['Primary Username'] || '—';
    const orderIds = orders.map(o => ({ id: o['Order ID'], channel: 'TikTok' })).filter(o => o.id);

    const qcRow = allQcRows.find(r => r['Tracking ID'] === tid);
    const photoCount = qcRow
      ? ['Content1','Content2','Content3','Content4','Content5','Box1','Box2','Box3','Box4','Box5']
          .filter(c => qcRow[c]).length
      : 0;
    const progressBadge = photoCount > 0
      ? `<div class="pending-progress">✓ ${photoCount} foto${photoCount !== 1 ? 's' : ''} guardada${photoCount !== 1 ? 's' : ''}</div>`
      : '';

    // Every order in this list is TikTok (renderPendingList filters to
    // Channel === 'TikTok' before building groups), so orderIds here are
    // always TikTok Order IDs -- no channel check needed before showing them.
    const ttIdHtml = orderIds.length
      ? ` <span class="vp-qc-ttid-prominent">${escapeHtml(orderIds[0].id)}${orderIds.length > 1 ? ' +' + (orderIds.length - 1) : ''}</span>`
      : '';
    return `
      <div class="pending-card${urgentOf(tid) ? ' pending-card--urgent' : ''}" onclick='openCapture(${JSON.stringify({
        tracking_id: first['Tracking ID'] || '',
        order_ids: orderIds,
        customer_id: first['Customer ID'] || '',
        username: username,
      }).replace(/'/g, "&apos;")})'>
        <div class="pending-card-top">
          <span class="pending-username">${escapeHtml(username)}${ttIdHtml}</span>
          <span class="pending-count">${orders.length} pedido${orders.length !== 1 ? 's' : ''}${(anotadoByTid[tid] || []).length ? ' · ' + ['Shopify','Manual'].map(ch => { const n = anotadoByTid[tid].filter(o => (o['Channel'] || 'Manual') === ch).length; return n ? '+' + n + ' ' + ch : ''; }).filter(Boolean).join(', ') : ''}</span>
        </div>
        ${first['Tracking ID'] ? `<div class="pending-tracking">${escapeHtml(first['Tracking ID'])}</div>` : ''}
        ${progressBadge}
      </div>`;
  }).join('');
}


// ── Capture view ─────────────────────────────────────────────────────────

let pendingScrollY = 0;

let isEditingShipped = false;  // true only when the user explicitly checks "Editar de todos modos"

function applyShippedLock(isShipped) {
  const banner = document.getElementById('shipped-lock-banner');
  const area = document.getElementById('capture-editable-area');
  const checkbox = document.getElementById('edit-shipped-checkbox');
  const submitBtn = document.getElementById('qc-submit');

  if (isShipped) {
    banner.style.display = 'block';
    checkbox.checked = isEditingShipped;
    if (!isEditingShipped) {
      area.classList.add('locked');
      submitBtn.style.display = 'none';
    } else {
      area.classList.remove('locked');
      submitBtn.style.display = 'block';
      submitBtn.textContent = 'Guardar cambios';
      submitBtn.disabled = false;  // was hidden (display:none) while locked, so its old disabled state is stale
    }
  } else {
    banner.style.display = 'none';
    area.classList.remove('locked');
    submitBtn.style.display = 'block';
  }
}

function toggleEditShipped() {
  isEditingShipped = document.getElementById('edit-shipped-checkbox').checked;
  applyShippedLock(true);
}

async function toggleUrgent() {
  if (!selected) return;
  const box = document.getElementById('urgent-checkbox');
  const wanted = box.checked;
  try {
    const res = await apiPost({
      action:      'save_qc',
      qc_id:       currentQcId || undefined,
      tracking_id: selected.tracking_id || manualTrackingId,
      order_ids:   [...selected.order_ids, ...selectedAddons],
      customer_id: selected.customer_id,
      username:    selected.username,
      packer:      currentPacker(),
      urgent:      wanted,
    });
    if (res.error) throw new Error(res.error);
    if (res.qc_id) currentQcId = res.qc_id;
    const row = allQcRows.find(r => r['QC ID'] === res.qc_id);
    if (row) row['Urgent'] = wanted ? 'Sí' : '';
  } catch (e) {
    box.checked = !wanted;
    showToast('No se pudo guardar la urgencia: ' + e.message, true);
  }
}

function openCapture(shipment) {
  cameFromTab = currentTab;
  pendingScrollY = window.scrollY;
  selected = shipment;
  manualTrackingId = shipment.tracking_id ? '' : 'MAN-' + Date.now();
  requestWakeLock();
  currentQcId = null;
  shippedLockShown = false;
  isEditingShipped = false;
  selectedAddons = [];
  gallery.content = [];
  gallery.box = [];
  document.getElementById('qc-notes').value = '';
  document.getElementById('urgent-checkbox').checked = false;

  document.getElementById('ship-summary').innerHTML = `
    <div class="ship-summary-username">${escapeHtml(shipment.username)}</div>
    ${shipment.tracking_id ? `<div class="ship-summary-tracking">${escapeHtml(shipment.tracking_id)}</div>` : ''}
  `;

  renderAddonOrders(shipment.customer_id);

  let restored = false;
  let rowIsShipped = false;
  if (shipment.tracking_id) {
    const row = allQcRows.find(r => r['Tracking ID'] === shipment.tracking_id);
    if (row) {
      currentQcId = row['QC ID'] || null;
      rowIsShipped = row['Status'] === 'Enviado';
      gallery.content = ['Content1','Content2','Content3','Content4','Content5']
        .map(c => row[c]).filter(Boolean).map(url => ({ url }));
      gallery.box = ['Box1','Box2','Box3','Box4','Box5']
        .map(c => row[c]).filter(Boolean).map(url => ({ url }));
      document.getElementById('qc-notes').value = row['Notes'] || '';
      document.getElementById('urgent-checkbox').checked = !!row['Urgent'];

      const shopifyIds = String(row['Shopify Order IDs'] || '').split(' + ').filter(Boolean);
      const manualIds  = String(row['Manual Order IDs']  || '').split(' + ').filter(Boolean);
      shopifyIds.forEach(id => selectedAddons.push({ id, channel: 'Shopify' }));
      manualIds.forEach(id  => selectedAddons.push({ id, channel: 'Manual' }));

      if (gallery.content.length || gallery.box.length) restored = true;
    }
  }

  // Anotado orders for this shipment come pre-selected -- they were
  // already written on this label in Pedidos. Finalize then moves them to
  // Enviado together with the TikTok order. Not on an already-shipped row
  // (that view is a read-only look back).
  if (shipment.tracking_id && !rowIsShipped) {
    (anotadoOrdersByTracking()[shipment.tracking_id] || []).forEach(o => {
      const id = String(o['Order ID']);
      if (!selectedAddons.some(a => String(a.id) === id)) selectedAddons.push({ id, channel: o['Channel'] });
    });
  }

  if (restored && !rowIsShipped) showToast('Progreso anterior restaurado');

  renderGallery('content');
  renderGallery('box');
  selectedAddons.forEach(a => {
    const el = document.getElementById(`addon-${cssEscape(a.id)}`);
    if (el) el.classList.add('selected');
  });

  document.getElementById('view-pending').style.display = 'none';
  document.getElementById('view-capture').style.display = 'block';
  const submitBtn = document.getElementById('qc-submit');
  submitBtn.disabled = gallery.content.length === 0;
  submitBtn.textContent = 'Enviar';  // reset — otherwise a previous "Guardando…" sticks forever
  applyShippedLock(rowIsShipped);
  window.scrollTo(0, 0);
}

// Always returns to the pending list -- previously this branched on a
// session that no longer exists, so every save silently redirected to the
// (now-removed) session gate instead of back to work.
// Returns to whichever tab the order was opened from -- going into an
// order from Historial and landing back on Pendientes loses your place.
let cameFromTab = 'pending';

async function backToPending() {
  document.getElementById('view-capture').style.display = 'none';
  releaseWakeLock();
  selected = null;
  currentQcId = null;
  localFinalizeInProgress = false;
  switchTab(cameFromTab);
  await refreshQcBadges();
  window.scrollTo(0, pendingScrollY);
}

async function refreshQcBadges() {
  try {
    const qcData = await apiGet('action=qc');
    try { sessionStorage.setItem('vp_cache_action=qc', JSON.stringify({ ts: Date.now(), data: qcData })); } catch (e) { /* cache is best-effort */ }
    allQcRows = qcData.records || [];
    renderCurrentTab();
  } catch (e) {
    console.warn('[refreshQcBadges] failed:', e);
  }
}

const SHOPIFY_STORE_HANDLE = '41uqww-0a';

function addonLabel(o) {
  const ch = o['Channel'] || 'Manual';
  if (ch !== 'Shopify') return ch;
  const n = String(o['Shopify Order Number'] || '').trim().replace(/^#/, '');
  return n ? `Shopify #${n}` : 'Shopify';
}

function parseAddonProducts(str) {
  return String(str || '').split(';').map(x => x.trim()).filter(Boolean).map(p => {
    const m = p.match(/^(\d+)\s*x\s*(.*)$/i);
    return m ? { qty: parseInt(m[1], 10), name: m[2] } : { qty: 1, name: p };
  });
}

function addonQtyText(o) {
  const total = parseAddonProducts(o['Products']).reduce((s, p) => s + p.qty, 0);
  if (!total) return '—';
  return total === 1 ? '1 producto' : `${total} productos`;
}

function openAddonModal(orderId) {
  const o = allActiveOrders.find(r => String(r['Order ID']) === String(orderId));
  if (!o) return;
  const items = parseAddonProducts(o['Products']);
  const rows = items.length
    ? items.map(p => `<li style="display:flex;gap:10px;padding:8px 0;border-bottom:1px solid var(--border)"><span style="font-weight:700;min-width:34px">${p.qty}×</span><span>${escapeHtml(p.name)}</span></li>`).join('')
    : '<li style="padding:8px 0">—</li>';
  VP.showModal(
    `<h3 style="font-size:16px;font-weight:700;margin:0 40px 12px 0">${escapeHtml(addonLabel(o))}</h3><ul style="list-style:none;margin:0;padding:0">${rows}</ul>`,
    { maxWidth: '480px' }
  );
}

function renderAddonOrders(customerId) {
  const section = document.getElementById('addon-section');
  const list = document.getElementById('addon-list');

  const tid = selected ? selected.tracking_id : '';
  const linkedHere = r => r['Status'] === 'Anotado' && tid && String(r['Linked Shipment'] || '') === tid;
  // Customer's open Shopify/Manual orders, plus anything Anotado on THIS
  // shipment (even under another customer ID). Orders Anotado on a
  // DIFFERENT shipment are left out -- they belong to that package.
  const addons = allActiveOrders.filter(r =>
    r['Channel'] !== 'TikTok' &&
    !['Enviado', 'Archivado'].includes(r['Status']) &&
    (linkedHere(r) || (customerId && r['Customer ID'] === customerId && r['Status'] !== 'Anotado'))
  );

  if (addons.length === 0) { section.style.display = 'none'; return; }

  section.style.display = 'block';
  list.innerHTML = addons.map(o => `
    <div class="addon-item" id="addon-${escapeAttr(o['Order ID'])}" onclick="openAddonModal('${escapeAttr(o['Order ID'])}')">
      <div class="addon-checkbox" onclick="event.stopPropagation(); toggleAddon('${escapeAttr(o['Order ID'])}', '${escapeAttr(o['Channel'])}')">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>
      </div>
      <div class="addon-text">
<div class="addon-channel">${o['Shopify Order ID'] ? `<a href="https://admin.shopify.com/store/${SHOPIFY_STORE_HANDLE}/orders/${escapeAttr(o['Shopify Order ID'])}" target="_blank" rel="noopener noreferrer" style="color:inherit;text-decoration:underline" onclick="event.stopPropagation()">${escapeHtml(addonLabel(o))}</a>` : escapeHtml(addonLabel(o))}</div>
        <div class="addon-products">${escapeHtml(addonQtyText(o))}</div>
      </div>
    </div>
  `).join('');
}

function toggleAddon(orderId, channel) {
  const el = document.getElementById(`addon-${cssEscape(orderId)}`);
  const idx = selectedAddons.findIndex(a => a.id === orderId);
  if (idx >= 0) {
    selectedAddons.splice(idx, 1);
    el.classList.remove('selected');
  } else {
    selectedAddons.push({ id: orderId, channel: channel });
    el.classList.add('selected');
  }
  pushNotesAndOrders();
}


// ── Photo galleries ──────────────────────────────────────────────────────

function renderGallery(group) {
  const galEl = document.getElementById(`gallery-${group}`);

  galEl.innerHTML = gallery[group].map((p, i) => `
    <div class="photo-thumb">
      <img src="${p.url}" loading="lazy" onclick="openLightbox('${p.url.replace(/'/g, "\\'")}')">
      <button class="photo-thumb-delete" onclick="deletePhoto('${group}', ${i})">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
      </button>
    </div>
  `).join('');

  const atLimit = gallery[group].length >= MAX_PHOTOS;
  [`add-btn-${group}`, `add-btn-${group}-gallery`].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    el.classList.toggle('limit-reached', atLimit);
  });
}

async function deletePhoto(group, index) {
  if (!confirm('¿Eliminar esta foto?')) return;
  const removedUrl = gallery[group][index].url;

  // If editing a shipped order, deletion is local-only until "Guardar cambios"
  // is pressed (full overwrite) — no per-photo server call in that mode.
  if (isEditingShipped) {
    gallery[group].splice(index, 1);
    renderGallery(group);
    return;
  }

  gallery[group].splice(index, 1);
  renderGallery(group);
  document.getElementById('qc-submit').disabled = gallery.content.length === 0;
  const res = await pushRemovePhoto(group, removedUrl);
  if (res && res.blocked) {
    showToast('Este pedido ya fue enviado — no se puede modificar', true);
    gallery[group].splice(index, 0, { url: removedUrl });  // restore — server refused
    renderGallery(group);
  }
}

function bindAddButton(group, btnId) {
  const btn = document.getElementById(btnId);
  const input = btn.querySelector('input');
  input.onchange = async () => {
    const f = input.files[0];
    input.value = '';
    if (!f) return;
    if (gallery[group].length >= MAX_PHOTOS) return;

    const previewUrl = URL.createObjectURL(f);
    const placeholderIdx = gallery[group].length;
    gallery[group].push({ url: previewUrl, uploading: true });
    renderUploadingPlaceholder(group, placeholderIdx);
    uploadsInFlight++;
    document.getElementById('qc-submit').disabled = true;

    try {
      const uploaded = await uploadPhoto(f, 'velpapier/qc');
      gallery[group][placeholderIdx] = { url: uploaded.url };
      renderGallery(group);
      uploadsInFlight--;
      if (!savingInProgress) {
        document.getElementById('qc-submit').disabled = uploadsInFlight > 0 || (!isEditingShipped && gallery.content.length === 0);
      }

      // Sync to the sheet in the background — the thumbnail and the submit
      // button are already usable at this point, they don't need to wait
      // for this slower, secondary round-trip to Apps Script. But the 4s
      // poll must know this is in flight too (photoSyncsInFlight) -- it
      // reads the server's row, which doesn't have this photo yet until
      // this call lands, and would otherwise wipe the thumbnail right back
      // out thinking the server is the source of truth.
      photoSyncsInFlight++;
      pushAddPhoto(group, uploaded.url).then(res => {
        // Ignore 'blocked' when THIS device just finalized: the finalize
        // call already carried the full photo list, so nothing was lost.
        if (res && res.blocked && selected && !localFinalizeInProgress) {
          document.getElementById('edit-shipped-checkbox').checked = true;
          toggleEditShipped();
        }
      }).finally(() => { photoSyncsInFlight--; });
    } catch (e) {
      console.error(`[bindAddButton:${group}] upload failed:`, e);
      gallery[group].splice(placeholderIdx, 1);
      renderGallery(group);
      showToast('Error al subir foto, intenta de nuevo', true);
      uploadsInFlight--;
      if (!savingInProgress) {
        document.getElementById('qc-submit').disabled = uploadsInFlight > 0 || (!isEditingShipped && gallery.content.length === 0);
      }
    }
  };
}
bindAddButton('content', 'add-btn-content');
bindAddButton('content', 'add-btn-content-gallery');
bindAddButton('box', 'add-btn-box');
bindAddButton('box', 'add-btn-box-gallery');

function renderUploadingPlaceholder(group, idx) {
  const galEl = document.getElementById(`gallery-${group}`);
  const div = document.createElement('div');
  div.className = 'photo-thumb uploading';
  div.id = `uploading-${group}-${idx}`;
  div.innerHTML = '<div class="spinner"></div>';
  galEl.appendChild(div);
}

document.getElementById('qc-notes').addEventListener('change', pushNotesAndOrders);


// ── Submit ───────────────────────────────────────────────────────────────

async function submitQC() {
  const btn = document.getElementById('qc-submit');
  if (!selected) { showToast('Error: no hay orden seleccionada', true); return; }
  if (gallery.content.length === 0) { showToast('Falta al menos una foto de contenido', true); return; }
  if (uploadsInFlight > 0) { showToast('Espera a que terminen de subir las fotos', true); return; }
  if (!isEditingShipped && gallery.box.length === 0 &&
      !confirm('No hay foto de la caja cerrada. ¿Enviar de todos modos?')) return;
  // Let background photo saves land first, so finalize never races them
  // (FIX_LOG 5.1). Capped at 15 s; finalize carries the full list anyway.
  if (photoSyncsInFlight > 0) {
    btn.disabled = true;
    btn.textContent = 'Guardando fotos…';
    const t0 = Date.now();
    while (photoSyncsInFlight > 0 && Date.now() - t0 < 15000) await new Promise(r => setTimeout(r, 200));
  }

  // Editing an already-shipped order: full overwrite based on THIS device's
  // current gallery, explicitly confirmed. Does not touch order/ship status
  // again (already shipped) — just corrects the photos on record.
  if (isEditingShipped) {
    savingInProgress = true;
    btn.disabled = true;
    btn.textContent = 'Guardando…';
    try {
      const res = await apiPost({
        action:               'save_qc',
        qc_id:                currentQcId,
        tracking_id:          selected.tracking_id,
        confirm_edit_shipped: true,
        content_urls:  gallery.content.filter(p => !p.uploading).map(p => p.url),
        box_urls:      gallery.box.filter(p => !p.uploading).map(p => p.url),
        notes:         document.getElementById('qc-notes').value.trim(),
      });
      if (res.error) throw new Error(res.error);
      showToast('✓ Cambios guardados');
      backToPending();
    } catch (e) {
      showToast('Error: ' + e.message, true);
      btn.disabled = false;
      btn.textContent = 'Guardar cambios';
    } finally {
      savingInProgress = false;
    }
    return;
  }

  localFinalizeInProgress = true;  // suppress "shipped elsewhere" false-positive from our own poll tick

  savingInProgress = true;
  btn.disabled = true;
  btn.textContent = 'Guardando…';

  const allOrders = [...selected.order_ids, ...selectedAddons];

  try {
    const res = await apiPost({
      action:        'save_qc',
      qc_id:         currentQcId || undefined,
      finalize:      true,
      tracking_id:   selected.tracking_id || manualTrackingId,
      order_ids:     allOrders,
      customer_id:   selected.customer_id,
      username:      selected.username,
      packer:        currentPacker(),
      content_urls:  gallery.content.filter(p => !p.uploading).map(p => p.url),
      box_urls:      gallery.box.filter(p => !p.uploading).map(p => p.url),
      notes:         document.getElementById('qc-notes').value.trim(),
    });

    if (res.error === 'already_shipped') {
      showToast('Este pedido ya fue enviado desde otro dispositivo', true);
      btn.disabled = false;
      btn.textContent = 'Enviar';
      return;
    }
    if (res.error) throw new Error(res.error);

    // Apps Script's own execution log viewer is no longer available, so
    // the server sends its own step-by-step timing back on the response
    // (see _timings in apps-script.gs) -- printed here as one readable
    // table in the console instead of a second browser tab.
    if (res._timings) {
      console.log('[submitQC timings]');
      console.table(res._timings);
    }

    showToast('✓ Empacado y enviado');
    backToPending();

  } catch (e) {
    showToast('Error: ' + e.message, true);
    btn.disabled = false;
    btn.textContent = 'Enviar';
  } finally {
    // Previously savingInProgress was only reset inside each explicit exit
    // path above. If backToPending() itself threw after the success toast
    // (no visible error, nothing obviously wrong), nothing ever reset it --
    // the button stayed disabled forever with no error shown. finally runs
    // no matter how this block exits, so that's no longer possible.
    localFinalizeInProgress = false;
    savingInProgress = false;
  }
}
// ── Lightbox ─────────────────────────────────────────────────────────────

function openLightbox(url) {
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.9);z-index:500;display:flex;align-items:center;justify-content:center;padding:20px;-webkit-tap-highlight-color:transparent';
  overlay.innerHTML = `<img src="${url}" style="max-width:100%;max-height:100%;object-fit:contain;border-radius:8px">`;
  const close = () => {
    overlay.remove();
    document.removeEventListener('keydown', onKey);
  };
  const onKey = (ev) => { if (ev.key === 'Escape') close(); };
  overlay.onclick = close;
  document.addEventListener('keydown', onKey);
  document.body.appendChild(overlay);
}


// ── Helpers ──────────────────────────────────────────────────────────────

// One escape helper for the whole dashboard lives in common.js (FIX_LOG 4.2).
function escapeHtml(s) {
  return VP.esc(s);
}

// Keeps the phone screen awake while a packing capture is open (FIX_LOG 5.5).
// Silently does nothing on browsers without the Wake Lock API.
async function requestWakeLock() {
  try {
    if ('wakeLock' in navigator && !wakeLock) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    }
  } catch (e) { wakeLock = null; }
}
function releaseWakeLock() {
  try { if (wakeLock) wakeLock.release(); } catch (e) {}
  wakeLock = null;
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && selected) requestWakeLock();
});

function escapeAttr(s) {
  return String(s || '').replace(/'/g, "\\'").replace(/"/g, '&quot;');
}

function cssEscape(s) {
  return String(s || '').replace(/[^a-zA-Z0-9_-]/g, '_');
}

function showToast(msg, isError = false) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.style.background = isError ? '#a32d2d' : '';
  t.classList.add('show');
  setTimeout(() => { t.classList.remove('show'); t.style.background = ''; }, 2800);
}
