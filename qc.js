// qc.js — Vel Papier QC capture page logic (multi-photo galleries)

const API = 'https://script.google.com/macros/s/AKfycbyeywjfBWA0hFSy_3U3A2iYLE2TlPN22pBOELJ97N-FTAkgXkEAk6Af0aG1O3DjK8OjHw/exec';
const MAX_PHOTOS = 5;

let API_TOKEN = localStorage.getItem('vp_token') || '';

let allActiveOrders = [];
let allQcRows = [];       // fetched once at page load, looked up in memory
let selected = null;      // { tracking_id, order_ids:[{id,channel}], customer_id, username }
let selectedAddons = [];  // [{id, channel}] for checked add-on orders
let currentQcId = null;
let uploadsInFlight = 0;
let activeSession = null; // { 'Session ID', 'Start Time', ... } or null if no session running

// Photo galleries: array of {url} objects, up to MAX_PHOTOS each
const gallery = { content: [], box: [] };


// ── Auth ─────────────────────────────────────────────────────────────────

async function ensureAuth() {
  await window.__qcAuthPromise;
  for (;;) {
    if (API_TOKEN) {
      try {
        const r = await fetch(`${API}?action=ping&token=${encodeURIComponent(API_TOKEN)}`);
        if ((await r.json()).ok) return;
      } catch (e) { /* fall through */ }
    }
    const input = prompt('Token de API:');
    if (input === null) {
      document.body.innerHTML = '<p style="text-align:center;margin-top:4rem;font-family:sans-serif">Acceso denegado.</p>';
      throw new Error('unauthenticated');
    }
    API_TOKEN = input.trim();
    localStorage.setItem('vp_token', API_TOKEN);
  }
}

async function apiGet(query) {
  const r = await fetch(`${API}?${query}&token=${encodeURIComponent(API_TOKEN)}`);
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}

async function apiPost(data) {
  const r = await fetch(API, {
    method:  'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body:    JSON.stringify({ ...data, token: API_TOKEN }),
  });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
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
      tracking_id:   selected.tracking_id || ('MAN-' + Date.now()),
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
    return null;
  }
}

async function pushRemovePhoto(group, url) {
  if (!selected || !currentQcId) return null;
  try {
    const res = await apiPost({
      action:      'save_qc',
      qc_id:       currentQcId,
      tracking_id: selected.tracking_id || ('MAN-' + Date.now()),
      [group === 'content' ? 'remove_content' : 'remove_box']: url,
    });
    if (res.error === 'already_shipped') return { blocked: true };
    if (res.error) throw new Error(res.error);
    return res;
  } catch (e) {
    console.error('[pushRemovePhoto] failed:', e);
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
      tracking_id:   selected.tracking_id || ('MAN-' + Date.now()),
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
  }
}


// ── Init ─────────────────────────────────────────────────────────────────

// Known packer names (persisted, editable via the modal's "+" field)
let knownPackers = JSON.parse(localStorage.getItem('vp_known_packers') || '["Bob","Mariana","Mau"]');
// Which of them are actively packing right now (persisted per device)
let checkedPackers = JSON.parse(localStorage.getItem('vp_checked_packers') || '[]');

function saveKnownPackers() { localStorage.setItem('vp_known_packers', JSON.stringify(knownPackers)); }
function saveCheckedPackers() { localStorage.setItem('vp_checked_packers', JSON.stringify(checkedPackers)); }

function currentPacker() {
  // Used for the single "Packer" column on each QC row — first checked name, or blank
  return checkedPackers[0] || '';
}

function updatePackersBtnLabel() {
  const label = document.getElementById('packers-btn-label');
  label.textContent = checkedPackers.length ? checkedPackers.join(', ') : '—';
}
updatePackersBtnLabel();

function openPackersModal() {
  renderPackersChecklist();
  document.getElementById('packers-modal').style.display = 'flex';
}
function closePackersModal() {
  document.getElementById('packers-modal').style.display = 'none';
  updatePackersBtnLabel();
}
function renderPackersChecklist() {
  const box = document.getElementById('packers-checklist');
  box.innerHTML = knownPackers.map(name => `
    <label style="display:flex;align-items:center;gap:8px;font-size:14px;cursor:pointer">
      <input type="checkbox" value="${escapeAttr(name)}" ${checkedPackers.includes(name) ? 'checked' : ''} onchange="togglePacker('${escapeAttr(name)}')">
      ${escapeHtml(name)}
    </label>
  `).join('');
}
function togglePacker(name) {
  const idx = checkedPackers.indexOf(name);
  if (idx >= 0) checkedPackers.splice(idx, 1);
  else checkedPackers.push(name);
  saveCheckedPackers();
  pushParticipants();
}
function addManualPacker() {
  const input = document.getElementById('packer-manual-input');
  const name = input.value.trim();
  if (!name) return;
  if (!knownPackers.includes(name)) { knownPackers.push(name); saveKnownPackers(); }
  if (!checkedPackers.includes(name)) { checkedPackers.push(name); saveCheckedPackers(); }
  input.value = '';
  renderPackersChecklist();
  pushParticipants();
}

// Push the checked-packer list to the session row so every device sees the
// same "who's packing" state, instead of each device only knowing its own.
async function pushParticipants() {
  if (!activeSession) return;
  try {
    await apiPost({
      action: 'update_session_participants',
      session_id: activeSession['Session ID'],
      participants: checkedPackers,
    });
  } catch (e) {
    console.warn('[pushParticipants] failed:', e);
  }
}

(async function init() {
  await ensureAuth();
  await checkSessionAndRoute();
  setInterval(() => {
    if (!activeSession) return;
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
    if (!isEditingShipped) {
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
      document.getElementById('qc-submit').disabled = gallery.content.length === 0;
    }
  } catch (e) {
    console.warn('[pollCaptureUpdates] failed:', e);
  }
  pollingCapture = false;
}
let shippedLockShown = false;
let localFinalizeInProgress = false;

// Checks whether a session is currently active and shows the right view:
// gate (no session) vs. pending list + live banner (session running).
async function checkSessionAndRoute() {
  // Hide both views while we determine state — prevents the wrong one flashing
  document.getElementById('view-session-gate').style.display = 'none';
  document.getElementById('session-banner').style.display = 'none';
  document.getElementById('header-end-session-btn').style.display = 'none';
  document.getElementById('view-pending').style.display = 'none';
  try {
    const data = await apiGet('action=active_session');
    activeSession = data.session || null;
  } catch (e) {
    console.error('[checkSessionAndRoute] failed:', e);
    activeSession = null;
  }

  if (activeSession) {
    document.getElementById('session-banner').style.display = 'flex';
    document.getElementById('header-end-session-btn').style.display = 'block';
    // Adopt whoever is already marked as packing on this session (server is
    // the source of truth) instead of trusting only this device's local list.
    const liveParticipants = String(activeSession['Participants'] || '')
      .split(',').map(s => s.trim()).filter(Boolean);
    if (liveParticipants.length) {
      checkedPackers = liveParticipants;
      saveCheckedPackers();
      liveParticipants.forEach(name => { if (!knownPackers.includes(name)) knownPackers.push(name); });
      saveKnownPackers();
    }
    updatePackersBtnLabel();
    switchTab('pending');
    await loadPending();
  } else {
    document.getElementById('view-session-gate').style.display = 'block';
  }
}

let startingSession = false;

async function handleStartSession() {
  if (startingSession) return;
  startingSession = true;
  const btn = document.getElementById('start-session-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Cargando…'; }
  try {
    const res = await apiPost({ action: 'start_session' });
    if (res.error) throw new Error(res.error);
    if (res.result === 'already_active') {
      showToast('Te uniste a la sesión ' + res.session_id);
    } else {
      showToast('Sesión iniciada: ' + res.session_id);
    }
    await checkSessionAndRoute();
  } catch (e) {
    showToast('Error al iniciar sesión: ' + e.message, true);
  }
  startingSession = false;
  if (btn) { btn.disabled = false; btn.textContent = 'Iniciar / unirse a sesión'; }
}

async function handleEndSession() {
  if (!activeSession) return;
  if (!confirm('¿Finalizar la sesión de empaque actual?')) return;
  try {
    const res = await apiPost({
      action: 'end_session',
      session_id: activeSession['Session ID'],
      participants: checkedPackers,
    });
    if (res.error) throw new Error(res.error);
    showSessionSummary(res);
    activeSession = null;
    await checkSessionAndRoute();
  } catch (e) {
    showToast('Error al finalizar sesión: ' + e.message, true);
  }
}

function showSessionSummary(summary) {
  const startMs = summary.start_time ? Date.parse(summary.start_time) : activeSessionStartMs;
  const totalSec = startMs ? Math.round((Date.now() - startMs) / 1000) : null;

  const lines = [
    `📦 ${summary.total_packages} paquete${summary.total_packages !== 1 ? 's' : ''} empacado${summary.total_packages !== 1 ? 's' : ''}`,
    `🧩 ${summary.total_items} artículo${summary.total_items !== 1 ? 's' : ''} en total`,
    totalSec !== null ? `⏱ Duración: ${formatHM(totalSec)}` : '',
    (totalSec !== null && summary.total_packages > 0)
      ? `⚡ Promedio: ${formatMS(Math.round(totalSec / summary.total_packages))} por paquete` : '',
    summary.participants && summary.participants.length ? `👥 ${summary.participants.join(', ')}` : '',
  ].filter(Boolean);

  alert('Sesión finalizada\n\n' + lines.join('\n'));
}

// 3725 -> "1h 2m"
function formatHM(totalSeconds) {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.round((totalSeconds % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

// 95 -> "1m 35s"
function formatMS(totalSeconds) {
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

let activeSessionStartMs = null;


// ── Pending list ─────────────────────────────────────────────────────────

async function loadPending() {
  document.getElementById('view-pending').style.display = 'block';
  const list = document.getElementById('pending-list');
  list.innerHTML = '<div class="empty-state">Cargando…</div>';

  try {
    const [ordersData, qcData] = await Promise.all([
      apiGet('action=orders&status=Pagado,No Pagado'),
      apiGet('action=qc'),
    ]);
    allActiveOrders = ordersData.records || [];
    allQcRows = qcData.records || [];
  } catch (e) {
    list.innerHTML = '<div class="empty-state">Error al cargar. Desliza para reintentar.</div>';
    return;
  }

  updateSessionBanner();
  renderPendingList();
}

function updateSessionBanner() {
  if (!activeSession) return;
  if (!activeSessionStartMs) {
    const parsed = Date.parse(activeSession['Start Time']);
    activeSessionStartMs = isNaN(parsed) ? Date.now() : parsed;
  }
  const count = allQcRows.filter(r => r['Session ID'] === activeSession['Session ID'] && r['Status'] === 'Enviado').length;
  document.getElementById('session-live-count').textContent = `Sesión activa · ${count} empacado${count !== 1 ? 's' : ''}`;
}

// ── Tabs: Pendientes / Empacados (this session) / Historial ────────────────

let currentTab = 'pending';

function renderCurrentTab() {
  if (currentTab === 'packed') renderPackedList();
  else renderPendingList();
}

function switchTab(tab) {
  currentTab = tab;
  const tabs = { pending: 'tab-pending', packed: 'tab-packed', history: 'tab-history' };
  Object.entries(tabs).forEach(([key, id]) => {
    document.getElementById(id).style.display = key === tab ? 'block' : 'none';
    const btn = document.getElementById(`tab-btn-${key}`);
    btn.style.background = key === tab ? 'var(--text)' : 'var(--surface2)';
    btn.style.color = key === tab ? 'var(--surface)' : 'var(--text-muted)';
  });
  if (tab === 'packed') renderPackedList();
  if (tab === 'history') renderHistoryList();
}

function renderPackedList() {
  const list = document.getElementById('packed-list');
  if (!activeSession) { list.innerHTML = '<div class="empty-state">Sin sesión activa</div>'; return; }

  let rows = allQcRows.filter(r => r['Session ID'] === activeSession['Session ID'] && r['Status'] === 'Enviado');

  const searchInput = document.getElementById('search-input');
  const query = searchInput ? searchInput.value.trim().toLowerCase() : '';
  if (query) {
    rows = rows.filter(r =>
      (r['Primary Username'] || '').toLowerCase().includes(query) ||
      (r['Tracking ID'] || '').toLowerCase().includes(query)
    );
  }

  if (rows.length === 0) {
    list.innerHTML = `<div class="empty-state">${query ? 'Sin resultados para "' + escapeHtml(query) + '"' : 'Nada empacado todavía en esta sesión'}</div>`;
    return;
  }

  list.innerHTML = rows.map(row => {
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
    return `
      <div class="pending-card" onclick='openCapture(${JSON.stringify({
        tracking_id: row['Tracking ID'] || '',
        order_ids: orderIds,
        customer_id: row['Customer ID'] || '',
        username: row['Primary Username'] || '',
      }).replace(/'/g, "&apos;")})'>
        <div class="pending-card-top">
          <span class="pending-username">${escapeHtml(row['Primary Username'] || '—')}</span>
          <span class="pending-count">✓ Enviado</span>
        </div>
        <div class="pending-tracking">${escapeHtml(row['Tracking ID'] || '')}</div>
        <div class="pending-progress">${photoCount} foto${photoCount !== 1 ? 's' : ''}</div>
      </div>`;
  }).join('');
}

let historySessions = null;  // cached after first load this page-session
let historySessionsFinished = [];  // filtered+indexed list actually shown/clicked in the UI

async function renderHistoryList() {
  const list = document.getElementById('history-list');
  list.innerHTML = '<div class="empty-state">Cargando…</div>';
  try {
    if (!historySessions) {
      const data = await apiGet('action=sessions');
      historySessions = data.records || [];
    }
    const finished = historySessions.filter(s => s['Status'] === 'Finalizada');
    historySessionsFinished = finished;  // toggleHistorySession indexes into THIS array, not the raw one
    if (finished.length === 0) {
      list.innerHTML = '<div class="empty-state">Sin sesiones anteriores</div>';
      return;
    }
    list.innerHTML = finished.map((s, i) => `
      <div class="pending-card" onclick="toggleHistorySession(${i})" id="history-session-${i}">
        <div class="pending-card-top">
          <span class="pending-username">${escapeHtml(s['Session ID'])}</span>
          <span class="pending-count">${escapeHtml(String(s['Total Packages'] || 0))} paq. (al finalizar)</span>
        </div>
        <div class="pending-tracking">${escapeHtml(s['Participants'] || '—')}</div>
        <div id="history-session-detail-${i}" style="display:none;margin-top:10px"></div>
      </div>
    `).join('');
  } catch (e) {
    list.innerHTML = '<div class="empty-state">Error al cargar el historial</div>';
  }
}

async function toggleHistorySession(i) {
  const detail = document.getElementById(`history-session-detail-${i}`);
  const isOpen = detail.style.display !== 'none';
  detail.style.display = isOpen ? 'none' : 'block';
  if (isOpen || detail.dataset.loaded) return;

  detail.innerHTML = '<div style="font-size:12px;color:var(--text-faint)">Cargando…</div>';
  try {
    const sessionId = historySessionsFinished[i]['Session ID'];
    const data = await apiGet(`action=qc&session_id=${encodeURIComponent(sessionId)}`);
    const rows = (data.records || []).filter(r => r['Status'] === 'Enviado');
    detail.innerHTML = rows.length === 0
      ? '<div style="font-size:12px;color:var(--text-faint)">Sin registros</div>'
      : rows.map((row, ri) => {
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
          return `<div style="font-size:12px;padding:8px 0;border-top:0.5px solid var(--border);cursor:pointer" onclick='event.stopPropagation(); openCapture(${JSON.stringify({
            tracking_id: row['Tracking ID'] || '',
            order_ids: orderIds,
            customer_id: row['Customer ID'] || '',
            username: row['Primary Username'] || '',
          }).replace(/'/g, "&apos;")})'>
            <strong>${escapeHtml(row['Primary Username'] || '—')}</strong> · ${escapeHtml(row['Tracking ID'] || '')} · ${photoCount} foto${photoCount !== 1 ? 's' : ''}
          </div>`;
        }).join('');
    detail.dataset.loaded = '1';
  } catch (e) {
    detail.innerHTML = '<div style="font-size:12px;color:var(--red-text)">Error al cargar</div>';
  }
}

function renderPendingList() {
  const list = document.getElementById('pending-list');
  const tikTokOrders = allActiveOrders.filter(r => r['Channel'] === 'TikTok' && r['Status'] === 'Pagado');

  if (tikTokOrders.length === 0) {
    list.innerHTML = '<div class="empty-state">Sin órdenes TikTok pendientes de empacar 🎉</div>';
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

  // Search filter — by username or tracking ID
  const searchInput = document.getElementById('search-input');
  const query = searchInput ? searchInput.value.trim().toLowerCase() : '';
  let filteredEntries = Object.entries(groups);
  if (query) {
    filteredEntries = filteredEntries.filter(([tid, orders]) => {
      const username = (orders[0]['Username'] || orders[0]['Primary Username'] || '').toLowerCase();
      return username.includes(query) || tid.toLowerCase().includes(query);
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

  list.innerHTML = entries.map(([tid, orders]) => {
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

    return `
      <div class="pending-card" onclick='openCapture(${JSON.stringify({
        tracking_id: first['Tracking ID'] || '',
        order_ids: orderIds,
        customer_id: first['Customer ID'] || '',
        username: username,
      }).replace(/'/g, "&apos;")})'>
        <div class="pending-card-top">
          <span class="pending-username">${escapeHtml(username)}</span>
          <span class="pending-count">${orders.length} pedido${orders.length !== 1 ? 's' : ''}</span>
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

function openCapture(shipment) {
  pendingScrollY = window.scrollY;
  selected = shipment;
  currentQcId = null;
  shippedLockShown = false;
  isEditingShipped = false;
  selectedAddons = [];
  gallery.content = [];
  gallery.box = [];
  document.getElementById('qc-notes').value = '';

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

      const shopifyIds = String(row['Shopify Order IDs'] || '').split(' + ').filter(Boolean);
      const manualIds  = String(row['Manual Order IDs']  || '').split(' + ').filter(Boolean);
      shopifyIds.forEach(id => selectedAddons.push({ id, channel: 'Shopify' }));
      manualIds.forEach(id  => selectedAddons.push({ id, channel: 'Manual' }));

      if (gallery.content.length || gallery.box.length) restored = true;
    }
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

async function backToPending() {
  document.getElementById('view-capture').style.display = 'none';
  document.getElementById('view-pending').style.display = 'block';
  selected = null;
  currentQcId = null;
  localFinalizeInProgress = false;
  await refreshQcBadges();
  window.scrollTo(0, pendingScrollY);
}

async function refreshQcBadges() {
  try {
    const [qcData, sessionData] = await Promise.all([
      apiGet('action=qc'),
      apiGet('action=active_session'),
    ]);
    allQcRows = qcData.records || [];

    // Session ended on another device — route this one back to the gate too.
    if (activeSession && !sessionData.session) {
      activeSession = null;
      await checkSessionAndRoute();
      return;
    }

    if (sessionData.session) {
      activeSession = sessionData.session;
      const liveParticipants = String(activeSession['Participants'] || '')
        .split(',').map(s => s.trim()).filter(Boolean);
      // Only adopt if it actually differs, to avoid clobbering a checkbox
      // the user is mid-click on this exact device
      if (liveParticipants.join(',') !== checkedPackers.join(',')) {
        checkedPackers = liveParticipants;
        saveCheckedPackers();
        updatePackersBtnLabel();
      }
    }
    updateSessionBanner();
    if (currentTab === 'packed') renderPackedList();
    else renderPendingList();
  } catch (e) {
    console.warn('[refreshQcBadges] failed:', e);
  }
}

function renderAddonOrders(customerId) {
  const section = document.getElementById('addon-section');
  const list = document.getElementById('addon-list');

  if (!customerId) { section.style.display = 'none'; return; }

  const addons = allActiveOrders.filter(r =>
    r['Customer ID'] === customerId &&
    r['Channel'] !== 'TikTok' &&
    !['Enviado', 'Archivado'].includes(r['Status'])
  );

  if (addons.length === 0) { section.style.display = 'none'; return; }

  section.style.display = 'block';
  list.innerHTML = addons.map(o => `
    <div class="addon-item" id="addon-${escapeAttr(o['Order ID'])}" onclick="toggleAddon('${escapeAttr(o['Order ID'])}', '${escapeAttr(o['Channel'])}')">
      <div class="addon-checkbox">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>
      </div>
      <div class="addon-text">
        <div class="addon-channel">${escapeHtml(o['Channel'] || '')}</div>
        <div class="addon-products">${escapeHtml(o['Products'] || '—')}</div>
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
      const res = await pushAddPhoto(group, uploaded.url);
      if (res && res.blocked) {
        // Reaching here means the lock didn't prevent the click (edge case,
        // e.g. race with a poll). Auto-unlock edit mode and keep the photo
        // the user just took — no extra popup, the checkbox is confirmation enough.
        document.getElementById('edit-shipped-checkbox').checked = true;
        toggleEditShipped();
      }
    } catch (e) {
      console.error(`[bindAddButton:${group}] upload failed:`, e);
      gallery[group].splice(placeholderIdx, 1);
      renderGallery(group);
      showToast('Error al subir foto, intenta de nuevo', true);
    }
    uploadsInFlight--;
    document.getElementById('qc-submit').disabled = uploadsInFlight > 0 || (!isEditingShipped && gallery.content.length === 0);
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

  // Editing an already-shipped order: full overwrite based on THIS device's
  // current gallery, explicitly confirmed. Does not touch order/ship status
  // again (already shipped) — just corrects the photos on record.
  if (isEditingShipped) {
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
    }
    return;
  }

  localFinalizeInProgress = true;  // suppress "shipped elsewhere" false-positive from our own poll tick

  btn.disabled = true;
  btn.textContent = 'Guardando…';

  const allOrders = [...selected.order_ids, ...selectedAddons];

  try {
    const res = await apiPost({
      action:        'save_qc',
      qc_id:         currentQcId || undefined,
      finalize:      true,
      session_id:    activeSession ? activeSession['Session ID'] : '',
      tracking_id:   selected.tracking_id || ('MAN-' + Date.now()),
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
      localFinalizeInProgress = false;
      btn.disabled = false;
      btn.textContent = 'Enviar';
      return;
    }
    if (res.error) throw new Error(res.error);

    showToast('✓ Empacado y enviado');
    backToPending();

  } catch (e) {
    showToast('Error: ' + e.message, true);
    localFinalizeInProgress = false;
    btn.disabled = false;
    btn.textContent = 'Enviar';
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

function escapeHtml(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

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
