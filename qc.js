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
let photoSyncsInFlight = 0;
// Bumped every time an order is opened or closed. Every slow network call
// remembers the value it started with and drops its result if it changed --
// otherwise a reply meant for order A lands inside order B (the "previous
// person's thumbnail" bug, and the cause of a photo being saved onto the
// wrong QC row and then vanishing).
let captureGen = 0;
// Bumped on every local photo add/remove. A poll that started before the
// last local change carries an outdated picture of the server and must not
// be merged -- that is what made a deleted photo pop back up.
let localEditSeq = 0;
// url -> promise of the background save for a just-uploaded photo. Deleting
// that photo waits for it, otherwise the delete arrives before the add and
// the add then puts the photo back on the sheet.
const pendingAdds = new Map();
const OPEN_ORDER_KEY = 'vp_qc_open_order'; // pending pushAddPhoto/pushRemovePhoto calls -- the poll must not merge server state while one of these hasn't landed yet, or it overwrites a photo that uploaded fine but isn't in the sheet yet

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

// Snapshot of the order a photo belongs to, taken when the photo is picked.
// The save always goes to THIS order, even if the user has since moved on.
function captureContext() {
  return {
    gen:         captureGen,
    sel:         selected,
    tracking_id: selected.tracking_id || manualTrackingId,
    order_ids:   [...selected.order_ids, ...selectedAddons],
    qc_id:       currentQcId,
  };
}

async function pushAddPhoto(group, url, ctx) {
  if (!ctx || !ctx.sel) return null;
  const mySeq = ++syncSeq;
  const stillHere = () => ctx.gen === captureGen;
  try {
    const res = await apiPost({
      action:        'save_qc',
      // Only reuse a QC ID while still in the same order -- and never one
      // from another order (the backend now double-checks this too).
      qc_id:         (stillHere() ? currentQcId : ctx.qc_id) || undefined,
      // Session ID is intentionally NOT set here — only at finalize (Enviar).
      tracking_id:   ctx.tracking_id,
      order_ids:     ctx.order_ids,
      customer_id:   ctx.sel.customer_id,
      username:      ctx.sel.username,
      packer:        currentPacker(),
      [group === 'content' ? 'add_content' : 'add_box']: url,
    });
    if (res.error === 'already_shipped') return { blocked: true };
    if (res.error) throw new Error(res.error);
    if (stillHere() && mySeq === syncSeq && res.qc_id) currentQcId = res.qc_id;
    return res;
  } catch (e) {
    console.error('[pushAddPhoto] failed:', e);
    showToast('La foto se subió pero no se guardó en el registro: ' + e.message, true);
    return null;
  }
}

async function pushRemovePhoto(group, url) {
  if (!selected) return null;
  if (!currentQcId) return { skipped: true };  // no QC row yet -> nothing on the sheet to remove
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
  const gen = captureGen;
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
    if (res.qc_id && gen === captureGen) currentQcId = res.qc_id;
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
  restoreOpenOrder();
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
  const gen = captureGen;
  const tid = selected.tracking_id;
  const editSeqAtStart = localEditSeq;
  try {
    const data = await apiGet(`action=qc&tracking_ids=${encodeURIComponent(tid)}`);
    // The user may have left this order (or opened another) while the
    // request was out. Applying it now would paint order A's photos and
    // QC ID onto order B -- drop it.
    if (gen !== captureGen || !selected || selected.tracking_id !== tid) return;
    const row = (data.records || []).find(r => r['Tracking ID'] === tid);
    if (!row) return;
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
    if (!isEditingShipped && !savingInProgress && photoSyncsInFlight === 0 && localEditSeq === editSeqAtStart) {
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
  } finally {
    pollingCapture = false;
  }
}

// If the phone killed this tab while the camera was open (low memory --
// the browser gets reloaded from scratch when you come back), reopen the
// order the packer was working on instead of dumping them on the list.
function restoreOpenOrder() {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(OPEN_ORDER_KEY) || 'null'); } catch (e) {}
  if (!saved || !saved.shipment) return;
  if (Date.now() - (saved.ts || 0) > 10 * 60 * 1000) { try { localStorage.removeItem(OPEN_ORDER_KEY); } catch (e) {} return; }
  cameFromTab = saved.fromTab || 'pending';
  openCapture(saved.shipment, { keepTab: true });
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
  if (tab === 'history') { historyPage = 0; renderHistoryList(); loadHistoryCustomers(); }
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
// Customer ID -> "primary alias1 alias2" (lowercase). The username saved on a
// QC row is a snapshot from the day it was packed, so after a merge or a
// primary/alias swap it no longer matches the customer's current names. The
// history search looks the customer up by ID instead.
let historyCustomerText = {};
let historyCustomersLoading = false;
async function loadHistoryCustomers() {
  if (historyCustomersLoading || Object.keys(historyCustomerText).length) return;
  historyCustomersLoading = true;
  try {
    const data = await apiGet('action=customers');
    const map = {};
    (data.records || []).forEach(c => {
      const id = String(c['Customer ID'] || '').trim();
      if (!id) return;
      const aliases = String(c['Aliases'] || '').split(',').map(x => x.trim()).filter(Boolean);
      map[id] = [String(c['Primary Username'] || '').trim(), ...aliases].join(' ').toLowerCase();
    });
    historyCustomerText = map;
    if (currentTab === 'history') renderHistoryList();
  } catch (e) {
    console.warn('[history] customers not loaded, searching by saved username only', e);
  } finally {
    historyCustomersLoading = false;
  }
}

function historySearchBlob(r) {
  const ids = [
    ...String(r['TikTok Order IDs'] || '').split(' + ').filter(Boolean),
    ...String(r['Shopify Order IDs'] || '').split(' + ').filter(Boolean),
    ...String(r['Manual Order IDs'] || '').split(' + ').filter(Boolean),
  ];
  const custText = historyCustomerText[String(r['Customer ID'] || '').trim()] || '';
  return [r['Primary Username'] || '', r['Tracking ID'] || '', custText, ...ids].join(' ').toLowerCase();
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

// ── Packing filter: Todos / TikTok / Mayoristas (remembered per device) ──
// Mayorista orders come from the Mayoristas tab as Orders rows with
// Channel 'Mayorista' (Order ID MAY-###). Anotado on a TikTok shipment ->
// they ride inside that TikTok card as an add-on, exactly like Manual.
// Not Anotado -> they ship on their own and get their own card here.
let packFilter = localStorage.getItem('vp_pack_filter') || 'all';
function setPackFilter(f) {
  packFilter = f;
  try { localStorage.setItem('vp_pack_filter', f); } catch (e) { /* best-effort */ }
  renderPendingList();
}

// The mirror row's Notes are written by the Mayoristas sync, e.g.
// "Mayoreo MAY-004 · Saldo pendiente $5,862 · Paquetería: Estafeta · Guía: 123"
function mayoristaNoteInfo(o) {
  const n = String((o && o['Notes']) || '');
  const pick = re => { const m = n.match(re); return m ? m[1].trim() : ''; };
  return {
    saldo: pick(/Saldo pendiente ([^·]+)/), guia: pick(/Guía: ([^·]+)/), paq: pick(/Paquetería: ([^·]+)/),
    peso: pick(/Peso: ([^·]+)/), medidas: pick(/Medidas: ([^·]+)/),
    empacado: /Empacado ✓/.test(n),
    sinAnotar: /Con TikTok \(sin anotar\)/.test(n),      // meant to ride inside a TikTok package, not linked to one yet
    porCotizar: /envío por cotizar/i.test(n),            // we bill the shipping and its cost is not known yet
  };
}

function renderPackFilterBar(counts) {
  const list = document.getElementById('pending-list');
  if (!document.getElementById('pack-filter-style')) {
    const st = document.createElement('style');
    st.id = 'pack-filter-style';
    st.textContent = `
      .pack-filter { display:flex; gap:6px; margin-bottom:10px; }
      .pack-chip { flex:1; border:0.5px solid var(--border-strong); background:var(--surface); color:var(--text-muted); border-radius:20px; padding:7px 6px; font-size:12.5px; font-family:inherit; cursor:pointer; }
      .pack-chip.is-active { background:var(--text); color:var(--surface); border-color:var(--text); }
      .pack-chip b { font-weight:700; margin-left:3px; }
      .pending-card--may { border-left:3px solid #534ab7; }
      .may-pack-badge { display:inline-block; font-size:10.5px; font-weight:700; letter-spacing:.3px; text-transform:uppercase; padding:2px 7px; border-radius:20px; background:#ecebfa; color:#534ab7; margin-right:6px; }
      .may-pack-warn { font-size:12px; font-weight:600; color:#b54708; margin-top:5px; }
      .may-pack-items { margin-top:10px; padding:10px 12px; background:var(--surface2); border-radius:10px; font-size:13px; }
      .may-pack-items li { display:flex; gap:10px; padding:4px 0; }
      .may-pack-items li span:first-child { font-weight:700; min-width:34px; }`;
    document.head.appendChild(st);
  }
  let bar = document.getElementById('pack-filter');
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'pack-filter';
    bar.className = 'pack-filter';
    list.parentNode.insertBefore(bar, list);
  }
  bar.innerHTML = [['all', 'Todos'], ['tiktok', 'TikTok'], ['mayorista', 'Mayoristas']]
    .map(([k, l]) => `<button class="pack-chip${packFilter === k ? ' is-active' : ''}" onclick="setPackFilter('${k}')">${l}<b>${counts[k]}</b></button>`).join('');
}

function renderPendingList() {
  const list = document.getElementById('pending-list');
  const tikTokOrders = allActiveOrders.filter(r => r['Channel'] === 'TikTok' && r['Status'] === 'Pagado');
  // Mayorista orders that ship on their own (not Anotado on a TikTok label).
  const soloMayorista = allActiveOrders.filter(r => r['Channel'] === 'Mayorista' && (r['Status'] === 'Pagado' || r['Status'] === 'No Pagado'));

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

  // Shopify/Manual/Mayorista orders written on a shipment's label in
  // Pedidos (Status Anotado, Linked Shipment = that tracking ID). Shown on
  // the card here and pre-selected as add-ons when the shipment is opened.
  const anotadoByTid = anotadoOrdersByTracking();

  // One entry per card. A standalone Mayorista order is keyed by its own
  // MAY-### ID -- that is also its QC record's Tracking ID.
  const allEntries = Object.entries(groups).map(([tid, orders]) => ({
    tid, orders, kind: 'tiktok',
    hasMay: (anotadoByTid[tid] || []).some(o => o['Channel'] === 'Mayorista'),
  }));
  soloMayorista.forEach(r => {
    const tid = String(r['Order ID']);
    if (!finalizedTids.has(tid)) allEntries.push({ tid, orders: [r], kind: 'mayorista', hasMay: true });
  });

  const counts = {
    all: allEntries.length,
    tiktok: allEntries.filter(e => e.kind === 'tiktok').length,
    mayorista: allEntries.filter(e => e.hasMay).length,
  };
  renderPackFilterBar(counts);

  if (allEntries.length === 0) {
    // "Nothing pending" and "nothing has loaded yet" look identical from
    // this filter alone -- hasLoadedOnce (set in loadPending) tells them
    // apart, so a failed/incomplete load is never mistaken for a real
    // empty queue.
    list.innerHTML = hasLoadedOnce
      ? '<div class="empty-state">Sin órdenes pendientes de empacar 🎉</div>'
      : '<div class="empty-state">⚠ La lista no cargó correctamente. Toca el botón de actualizar.</div>';
    return;
  }

  let entries = allEntries.filter(e => packFilter === 'all' || (packFilter === 'tiktok' ? e.kind === 'tiktok' : e.hasMay));

  // Search filter — by username, tracking ID, TikTok Order ID, MAY-### or guía
  const searchInput = document.getElementById('search-input');
  const query = searchInput ? searchInput.value.trim().toLowerCase() : '';
  if (query) {
    entries = entries.filter(({ tid, orders }) => {
      const username = (orders[0]['Username'] || orders[0]['Primary Username'] || '').toLowerCase();
      const ids = orders.map(o => String(o['Order ID'] || '')).join(' ').toLowerCase();
      const notes = orders.map(o => String(o['Notes'] || '')).join(' ').toLowerCase();
      return username.includes(query) || tid.toLowerCase().includes(query) || ids.includes(query) || notes.includes(query);
    });
  }

  const sortSelect = document.getElementById('sort-select');
  const sortMode = sortSelect ? sortSelect.value : 'az';
  const userOfE = e => (e.orders[0]['Username'] || e.orders[0]['Primary Username'] || '').toLowerCase();
  const dateOfE = e => new Date(e.orders[0]['Created Date'] || e.orders[0]['Created Time'] || 0).getTime();
  entries.sort((a, b) => {
    if (sortMode === 'old-new') return dateOfE(a) - dateOfE(b);
    if (sortMode === 'az') return userOfE(a).localeCompare(userOfE(b));
    if (sortMode === 'za') return userOfE(b).localeCompare(userOfE(a));
    return dateOfE(b) - dateOfE(a); // new-old (default)
  });

  if (entries.length === 0) {
    const what = packFilter === 'mayorista' ? 'pedidos de mayoreo' : packFilter === 'tiktok' ? 'órdenes TikTok' : 'órdenes';
    list.innerHTML = `<div class="empty-state">${query ? 'Sin resultados para "' + escapeHtml(query) + '"' : 'Sin ' + what + ' pendientes de empacar 🎉'}</div>`;
    return;
  }

  const urgentOf = tid => {
    if (window.vpLocalUrgent && window.vpLocalUrgent.has(tid)) return true;
    const q = allQcRows.find(r => r['Tracking ID'] === tid); return !!(q && q['Urgent']);
  };
  const urgentEntries = entries.filter(e => urgentOf(e.tid)).sort((a, b) => userOfE(a).localeCompare(userOfE(b)));
  const normalEntries = entries.filter(e => !urgentOf(e.tid));

  const photoBadge = tid => {
    const qcRow = allQcRows.find(r => r['Tracking ID'] === tid);
    const n = qcRow ? ['Content1','Content2','Content3','Content4','Content5','Box1','Box2','Box3','Box4','Box5'].filter(c => qcRow[c]).length : 0;
    return n > 0 ? `<div class="pending-progress">✓ ${n} foto${n !== 1 ? 's' : ''} guardada${n !== 1 ? 's' : ''}</div>` : '';
  };
  const openAttr = shipment => `onclick='openCapture(${JSON.stringify(shipment).replace(/'/g, "&apos;")})'`;

  list.innerHTML = [...urgentEntries, ...normalEntries].map(({ tid, orders, kind }) => {
    const first = orders[0];
    const username = first['Username'] || first['Primary Username'] || '—';
    const urgentCls = urgentOf(tid) ? ' pending-card--urgent' : '';

    if (kind === 'mayorista') {
      const info = mayoristaNoteInfo(first);
      const pieces = parseAddonProducts(first['Products']).reduce((s, p) => s + p.qty, 0);
      return `
      <div class="pending-card pending-card--may${urgentCls}" ${openAttr({
        tracking_id: tid,
        order_ids: [{ id: tid, channel: 'Mayorista' }],
        customer_id: first['Customer ID'] || '',
        username: username,
      })}>
        <div class="pending-card-top">
          <span class="pending-username">${escapeHtml(username)} <span class="vp-qc-ttid-prominent">${escapeHtml(tid)}</span></span>
          <span class="pending-count">${pieces} pieza${pieces !== 1 ? 's' : ''}</span>
        </div>
        <div class="pending-tracking"><span class="may-pack-badge">Mayoreo</span>${info.sinAnotar ? 'va con TikTok (sin anotar)' : 'envío propio'}${info.paq ? ' · ' + escapeHtml(info.paq) : ''}${info.guia ? ' · guía ' + escapeHtml(info.guia) : ''}${info.empacado ? ' · <b>✓ empacado</b>' + (info.peso ? ' ' + escapeHtml(info.peso) : '') : ''}</div>
        ${info.sinAnotar ? '<div class="may-pack-warn">⚠ Va dentro de un envío de TikTok, pero aún no está anotado en ninguno</div>' : ''}
        ${info.saldo ? `<div class="may-pack-warn">⚠ Saldo pendiente ${escapeHtml(info.saldo)} — confirmar pago antes de enviar</div>` : ''}
        ${!info.saldo && info.porCotizar ? '<div class="may-pack-warn">⚠ Falta cotizar el envío</div>' : ''}
        ${photoBadge(tid)}
      </div>`;
    }

    const orderIds = orders.map(o => ({ id: o['Order ID'], channel: 'TikTok' })).filter(o => o.id);
    // Every order in a TikTok card is TikTok, so orderIds here are always
    // TikTok Order IDs -- no channel check needed before showing them.
    const ttIdHtml = orderIds.length
      ? ` <span class="vp-qc-ttid-prominent">${escapeHtml(orderIds[0].id)}${orderIds.length > 1 ? ' +' + (orderIds.length - 1) : ''}</span>`
      : '';
    const extras = anotadoByTid[tid] || [];
    const extrasText = extras.length
      ? ' · ' + ['Shopify', 'Manual', 'Mayorista'].map(ch => { const n = extras.filter(o => (o['Channel'] || 'Manual') === ch).length; return n ? '+' + n + ' ' + ch : ''; }).filter(Boolean).join(', ')
      : '';
    const owing = extras.filter(o => o['Channel'] === 'Mayorista' && mayoristaNoteInfo(o).saldo);
    return `
      <div class="pending-card${urgentCls}" ${openAttr({
        tracking_id: first['Tracking ID'] || '',
        order_ids: orderIds,
        customer_id: first['Customer ID'] || '',
        username: username,
      })}>
        <div class="pending-card-top">
          <span class="pending-username">${escapeHtml(username)}${ttIdHtml}</span>
          <span class="pending-count">${orders.length} pedido${orders.length !== 1 ? 's' : ''}${extrasText}</span>
        </div>
        ${first['Tracking ID'] ? `<div class="pending-tracking">${extras.some(o => o['Channel'] === 'Mayorista') ? '<span class="may-pack-badge">+ Mayoreo</span>' : ''}${escapeHtml(first['Tracking ID'])}</div>` : ''}
        ${owing.length ? `<div class="may-pack-warn">⚠ Mayoreo con saldo pendiente: ${owing.map(o => escapeHtml(o['Order ID'] + ' ' + mayoristaNoteInfo(o).saldo)).join(', ')}</div>` : ''}
        ${photoBadge(tid)}
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

function openCapture(shipment, opts) {
  opts = opts || {};
  if (!opts.keepTab) cameFromTab = currentTab;
  pendingScrollY = window.scrollY;
  captureGen++;
  selected = shipment;
  manualTrackingId = shipment.tracking_id ? '' : 'MAN-' + Date.now();
  try {
    localStorage.setItem(OPEN_ORDER_KEY, JSON.stringify({ shipment, fromTab: cameFromTab, ts: Date.now() }));
  } catch (e) { /* best-effort */ }
  requestWakeLock();
  currentQcId = null;
  shippedLockShown = false;
  isEditingShipped = false;
  selectedAddons = [];
  gallery.content = [];
  gallery.box = [];
  document.getElementById('qc-notes').value = '';

  const idsHtml = (shipment.order_ids || []).map(o =>
    `<div style="font-size:13px;margin-top:4px">${escapeHtml(o.channel || '')} · <strong>${escapeHtml(o.id)}</strong></div>`
  ).join('');
  // A standalone Mayorista order has no TikTok packing slip -- the item
  // list shown here IS the packing list.
  const standaloneMay = (shipment.order_ids || []).length === 1 && shipment.order_ids[0].channel === 'Mayorista' && /^MAY-\d+$/.test(shipment.tracking_id || '');
  const mayHtml = (shipment.order_ids || []).filter(o => o.channel === 'Mayorista').map(o => {
    const r = allActiveOrders.find(x => String(x['Order ID']) === String(o.id));
    if (!r) return '';
    const info = mayoristaNoteInfo(r);
    const items = parseAddonProducts(r['Products']);
    return `<div class="may-pack-items">
      <div style="font-weight:700;margin-bottom:4px">Contenido · ${items.reduce((s, p) => s + p.qty, 0)} piezas</div>
      <ul style="list-style:none;margin:0;padding:0">${items.map(p => `<li><span>${p.qty}×</span><span>${escapeHtml(p.name)}</span></li>`).join('')}</ul>
      ${info.paq || info.guia ? `<div style="margin-top:6px;color:var(--text-muted)">${escapeHtml([info.paq, info.guia ? 'guía ' + info.guia : ''].filter(Boolean).join(' · '))}</div>` : ''}
      ${info.saldo ? `<div class="may-pack-warn">⚠ Saldo pendiente ${escapeHtml(info.saldo)}</div>` : ''}
      ${!info.saldo && info.porCotizar ? '<div class="may-pack-warn">⚠ Falta cotizar el envío</div>' : ''}
      ${info.sinAnotar ? '<div class="may-pack-warn">⚠ Va con un envío de TikTok, pero aún no está anotado</div>' : ''}
      ${standaloneMay ? `<div class="may-pack-pkg" style="margin-top:12px">
        <div style="font-weight:700;margin-bottom:6px">Datos del paquete <span style="font-weight:400;color:var(--text-muted)">· para cotizar el envío</span></div>
        <div style="display:flex;gap:8px">
          <input id="may-peso" type="number" inputmode="decimal" step="0.1" min="0" placeholder="Peso (kg)" value="${escapeAttr(String(info.peso || '').replace(/[^\d.,]/g, ''))}" style="width:34%;padding:9px;border:0.5px solid var(--border-strong);border-radius:8px;font-family:inherit;font-size:14px;background:var(--bg);color:var(--text)">
          <input id="may-medidas" type="text" placeholder="Medidas cm: 40x30x25" value="${escapeAttr(info.medidas || '')}" style="flex:1;min-width:0;padding:9px;border:0.5px solid var(--border-strong);border-radius:8px;font-family:inherit;font-size:14px;background:var(--bg);color:var(--text)">
        </div>
      </div>` : ''}
    </div>`;
  }).join('');
  document.getElementById('ship-summary').innerHTML = `
    <div class="ship-summary-username">${escapeHtml(shipment.username)}</div>
    ${idsHtml}
    ${shipment.tracking_id && !/^MAY-\d+$/.test(shipment.tracking_id) ? `<div class="ship-summary-tracking">${escapeHtml(shipment.tracking_id)}</div>` : ''}
    ${mayHtml}
  `;

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

  if (restored && !rowIsShipped && !opts.keepTab) showToast('Progreso anterior restaurado');

  renderAddonOrders();
  renderGallery('content');
  renderGallery('box');

  document.getElementById('view-pending').style.display = 'none';
  document.getElementById('view-capture').style.display = 'block';
  const submitBtn = document.getElementById('qc-submit');
  submitBtn.disabled = gallery.content.length === 0;
  submitBtn.textContent = 'Enviar';  // reset — otherwise a previous "Guardando…" sticks forever
  applyShippedLock(rowIsShipped);
  // A standalone wholesale order is packed BEFORE it can ship: the packer saves photos,
  // weight and measures (the office quotes the shipping from them) and the order stays
  // here until it is paid and ready to hand to the carrier -- then "Enviar".
  const oldPk = document.getElementById('may-packed-btn');
  if (oldPk) oldPk.remove();
  if (standaloneMay && !rowIsShipped) {
    const pk = document.createElement('button');
    pk.id = 'may-packed-btn';
    pk.className = 'qc-submit';
    pk.style.cssText = 'background:#534ab7;margin-bottom:8px';
    pk.textContent = '📦 Guardar como empacado (falta enviar)';
    pk.disabled = gallery.content.length === 0;
    pk.onclick = markMayoristaPacked;
    submitBtn.parentNode.insertBefore(pk, submitBtn);
  }
  window.scrollTo(0, 0);

  // The list's QC data can be up to 20 s old -- check the server right
  // away instead of waiting for the first 4 s poll tick.
  pollCaptureUpdates();
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
  captureGen++;
  try { localStorage.removeItem(OPEN_ORDER_KEY); } catch (e) {}
  selected = null;
  selectedAddons = [];
  gallery.content = [];
  gallery.box = [];
  renderGallery('content');
  renderGallery('box');
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
  if (ch === 'Mayorista') return 'Mayoreo ' + o['Order ID'] + (mayoristaNoteInfo(o).saldo ? ' · ⚠ saldo ' + mayoristaNoteInfo(o).saldo : '');
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

function addonNamesText(o) {
  const names = parseAddonProducts(o['Products'])
    .map(p => String(p.name).replace(/\s*\n\s*/g, ', '))
    .sort((a, b) => a.localeCompare(b, 'es'));
  if (!names.length) return '—';
  return names.length > 2 ? names.slice(0, 2).join(', ') + ' +' + (names.length - 2) : names.join(', ');
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

// Only Shopify/Manual orders the office has marked Anotado on THIS
// shipment's label are offered. Orders that are merely open for the same
// customer are NOT shown -- the office decides what goes in the box, by
// setting Anotado in Pedidos. Anything already saved on this QC row stays
// visible too, so it can still be un-ticked.
function renderAddonOrders() {
  const section = document.getElementById('addon-section');
  const list = document.getElementById('addon-list');

  const tid = selected ? selected.tracking_id : '';
  const savedIds = new Set(selectedAddons.map(a => String(a.id)));
  const addons = allActiveOrders.filter(r =>
    r['Channel'] !== 'TikTok' && (
      savedIds.has(String(r['Order ID'])) ||
      (tid && r['Status'] === 'Anotado' && String(r['Linked Shipment'] || '').trim() === tid)
    )
  );

  if (addons.length === 0) { section.style.display = 'none'; list.innerHTML = ''; return; }

  section.style.display = 'block';
  list.innerHTML = addons.map(o => `
    <div class="addon-item${savedIds.has(String(o['Order ID'])) ? ' selected' : ''}" id="addon-${cssEscape(o['Order ID'])}" onclick="openAddonModal('${escapeAttr(o['Order ID'])}')">
      <div class="addon-checkbox" onclick="event.stopPropagation(); toggleAddon('${escapeAttr(o['Order ID'])}', '${escapeAttr(o['Channel'])}')">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>
      </div>
      <div class="addon-text">
        <div class="addon-channel">${o['Shopify Order ID'] ? `<a href="https://admin.shopify.com/store/${SHOPIFY_STORE_HANDLE}/orders/${escapeAttr(o['Shopify Order ID'])}" target="_blank" rel="noopener noreferrer" style="color:inherit;text-decoration:underline" onclick="event.stopPropagation()">${escapeHtml(addonLabel(o))}</a>` : escapeHtml(addonLabel(o))}</div>
        <div class="addon-products">${escapeHtml(addonNamesText(o))} · ${escapeHtml(addonQtyText(o))}</div>
      </div>
    </div>
  `).join('');
}

function toggleAddon(orderId, channel) {
  const el = document.getElementById(`addon-${cssEscape(orderId)}`);
  const idx = selectedAddons.findIndex(a => String(a.id) === String(orderId));
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

// Small Cloudinary preview instead of the full 1280px photo -- ten full
// photos decoded at once is real memory on a low-end phone. Falls back to
// the original if Cloudinary refuses the resize.
function smallThumb(url) {
  return /res\.cloudinary\.com\/.+\/upload\//.test(url) ? url.replace('/upload/', '/upload/w_240,c_limit,q_auto/') : url;
}

function renderGallery(group) {
  const galEl = document.getElementById(`gallery-${group}`);

  galEl.innerHTML = gallery[group].map((p, i) => p.uploading
    ? '<div class="photo-thumb uploading"><div class="spinner"></div></div>'
    : `
    <div class="photo-thumb">
      <img src="${smallThumb(p.url)}" loading="lazy" onerror="if(this.src!=='${p.url.replace(/'/g, "\\'")}')this.src='${p.url.replace(/'/g, "\\'")}'" onclick="openLightbox('${p.url.replace(/'/g, "\\'")}')">
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
  const item = gallery[group][index];
  if (!item || item.uploading) return;
  if (!confirm('¿Eliminar esta foto?')) return;
  const gen = captureGen;
  index = gallery[group].indexOf(item);
  if (index < 0) return;
  const removedUrl = item.url;

  // If editing a shipped order, deletion is local-only until "Guardar cambios"
  // is pressed (full overwrite) — no per-photo server call in that mode.
  if (isEditingShipped) {
    gallery[group].splice(index, 1);
    renderGallery(group);
    return;
  }

  gallery[group].splice(index, 1);
  localEditSeq++;
  renderGallery(group);
  document.getElementById('qc-submit').disabled = gallery.content.length === 0;
  photoSyncsInFlight++;
  let res = null;
  try {
    const pending = pendingAdds.get(removedUrl);
    if (pending) await pending;
    res = await pushRemovePhoto(group, removedUrl);
  } finally {
    photoSyncsInFlight--;
    localEditSeq++;
  }
  if (gen !== captureGen) return;
  if (!res) {
    // Server didn't confirm -- put the thumbnail back so the screen matches the sheet.
    gallery[group].splice(Math.min(index, gallery[group].length), 0, { url: removedUrl });
    renderGallery(group);
    document.getElementById('qc-submit').disabled = gallery.content.length === 0;
    return;
  }
  if (res.blocked) {
    showToast('Este pedido ya fue enviado — no se puede modificar', true);
    gallery[group].splice(index, 0, { url: removedUrl });  // restore — server refused
    renderGallery(group);
  }
}

function refreshSubmitState() {
  if (savingInProgress) return;
  document.getElementById('qc-submit').disabled =
    uploadsInFlight > 0 || (!isEditingShipped && gallery.content.length === 0);
  const pk = document.getElementById('may-packed-btn');
  if (pk) pk.disabled = uploadsInFlight > 0 || gallery.content.length === 0;
}

// Standalone wholesale order: save photos + weight + measures and mark it packed.
// Does NOT finalize -- nothing ships yet. In Mayoristas the order moves to Listo and
// the office quotes the shipping (or sends the package data to the customer).
async function markMayoristaPacked() {
  if (!selected || savingInProgress) return;
  const mayId = (selected.order_ids[0] || {}).id;
  if (gallery.content.length === 0) { showToast('Falta al menos una foto de contenido', true); return; }
  if (uploadsInFlight > 0) { showToast('Espera a que terminen de subir las fotos', true); return; }
  const peso = ((document.getElementById('may-peso') || {}).value || '').trim();
  const medidas = ((document.getElementById('may-medidas') || {}).value || '').trim();
  if ((!peso || !medidas) && !confirm('Falta el peso o las medidas: con eso se cotiza el envío. ¿Guardar de todos modos?')) return;
  const btn = document.getElementById('may-packed-btn');
  const gen = captureGen;
  savingInProgress = true;
  btn.disabled = true;
  btn.textContent = 'Guardando…';
  try {
    if (photoSyncsInFlight > 0) {
      const t0 = Date.now();
      while (photoSyncsInFlight > 0 && Date.now() - t0 < 15000) await new Promise(r => setTimeout(r, 200));
    }
    // 1) photos + notes exactly as they stand now (not a finalize)
    const r1 = await apiPost({
      action:       'save_qc',
      qc_id:        currentQcId || undefined,
      tracking_id:  selected.tracking_id,
      order_ids:    selected.order_ids,
      customer_id:  selected.customer_id,
      username:     selected.username,
      packer:       currentPacker(),
      content_urls: gallery.content.filter(p => !p.uploading).map(p => p.url),
      box_urls:     gallery.box.filter(p => !p.uploading).map(p => p.url),
      notes:        document.getElementById('qc-notes').value.trim(),
    });
    if (r1.error === 'already_shipped') throw new Error('Este pedido ya fue enviado desde otro dispositivo');
    if (r1.error) throw new Error(r1.error);
    if (r1.qc_id) currentQcId = r1.qc_id;
    // 2) packed: weight + measures, Apartado -> Listo
    const r2 = await apiPost({ action: 'mayoreo_mark_packed', order_id: mayId, peso_kg: peso, medidas: medidas });
    if (r2.error) throw new Error(r2.error);
    showToast(r2.needs_quote ? '✓ Empacado — falta cotizar el envío' : '✓ Empacado — falta enviar');
    if (gen === captureGen) backToPending();
  } catch (e) {
    showToast('Error: ' + e.message, true);
    btn.disabled = false;
    btn.textContent = '📦 Guardar como empacado (falta enviar)';
  } finally {
    savingInProgress = false;
  }
}

function bindAddButton(group, btnId) {
  const btn = document.getElementById(btnId);
  const input = btn.querySelector('input');
  input.onchange = async () => {
    const f = input.files[0];
    input.value = '';
    if (!f || !selected) return;
    if (gallery[group].length >= MAX_PHOTOS) return;

    // Everything below belongs to the order that was open right now, even
    // if the packer leaves it before the upload finishes.
    const ctx = captureContext();
    // A plain marker object (no blob preview URL -- that held the full
    // camera photo in memory and was never released).
    const placeholder = { url: '', uploading: true };
    gallery[group].push(placeholder);
    renderGallery(group);
    uploadsInFlight++;
    document.getElementById('qc-submit').disabled = true;

    let uploaded = null;
    try {
      uploaded = await uploadPhoto(f, 'velpapier/qc');
    } catch (e) {
      console.error(`[bindAddButton:${group}] upload failed:`, e);
    }
    uploadsInFlight--;
    const stillHere = ctx.gen === captureGen;

    if (!uploaded) {
      if (stillHere) {
        const i = gallery[group].indexOf(placeholder);
        if (i >= 0) gallery[group].splice(i, 1);
        renderGallery(group);
        refreshSubmitState();
      }
      showToast('Error al subir foto, intenta de nuevo', true);
      return;
    }

    localEditSeq++;
    if (stillHere) {
      const i = gallery[group].indexOf(placeholder);
      if (i >= 0) gallery[group][i] = { url: uploaded.url };
      else gallery[group].push({ url: uploaded.url });
      renderGallery(group);
      refreshSubmitState();
    }

    // Save to the sheet in the background, always against the order the
    // photo was taken for (ctx). The 4 s poll must know this is in flight
    // (photoSyncsInFlight), or it would wipe the thumbnail before it lands.
    photoSyncsInFlight++;
    const addPromise = pushAddPhoto(group, uploaded.url, ctx);
    pendingAdds.set(uploaded.url, addPromise);
    addPromise.then(res => {
      if (!stillHere || ctx.gen !== captureGen) {
        if (res && !res.blocked) showToast(`Foto guardada en el pedido de ${ctx.sel.username}`);
        return;
      }
      // Ignore 'blocked' when THIS device just finalized: the finalize
      // call already carried the full photo list, so nothing was lost.
      if (res && res.blocked && selected && !localFinalizeInProgress) {
        document.getElementById('edit-shipped-checkbox').checked = true;
        toggleEditShipped();
      }
    }).finally(() => { photoSyncsInFlight--; localEditSeq++; pendingAdds.delete(uploaded.url); });
  };
}
bindAddButton('content', 'add-btn-content');
bindAddButton('content', 'add-btn-content-gallery');
bindAddButton('box', 'add-btn-box');
bindAddButton('box', 'add-btn-box-gallery');

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

  // A wholesale order normally only ships once fully paid -- the office
  // may still say "send it", so this asks instead of blocking.
  const owing = [...selected.order_ids, ...selectedAddons]
    .filter(o => o.channel === 'Mayorista')
    .map(o => allActiveOrders.find(x => String(x['Order ID']) === String(o.id)))
    .filter(r => r && (mayoristaNoteInfo(r).saldo || mayoristaNoteInfo(r).porCotizar || (selected.order_ids.length === 1 && mayoristaNoteInfo(r).sinAnotar)));
  if (owing.length && !confirm(owing.map(r => {
      const i = mayoristaNoteInfo(r);
      return `${r['Order ID']}: ` + [i.saldo ? 'saldo pendiente ' + i.saldo : '', !i.saldo && i.porCotizar ? 'falta cotizar el envío' : '', i.sinAnotar ? 'iba con un envío de TikTok sin anotar' : ''].filter(Boolean).join(' · ');
    }).join('\n') + '\n\nEste pedido de mayoreo aún no está listo para salir. ¿Enviar de todos modos?')) {
    btn.disabled = false;
    btn.textContent = 'Enviar';
    return;
  }

  localFinalizeInProgress = true;  // suppress "shipped elsewhere" false-positive from our own poll tick

  savingInProgress = true;
  btn.disabled = true;
  btn.textContent = 'Guardando…';

  const allOrders = [...selected.order_ids, ...selectedAddons];
  const gen = captureGen;

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
    if (gen === captureGen) backToPending();

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
