// qc.js — Vel Papier QC capture page logic

const API = 'https://script.google.com/macros/s/AKfycbyeywjfBWA0hFSy_3U3A2iYLE2TlPN22pBOELJ97N-FTAkgXkEAk6Af0aG1O3DjK8OjHw/exec';

let API_TOKEN = localStorage.getItem('vp_token') || '';

let allActiveOrders = [];   // all Pagado/No Pagado orders, fetched once per session
let selected = null;        // { tracking_id, order_ids:[], customer_id, username, products, label }
let selectedAddonIds = new Set();  // order_ids of add-on orders the user checked
let currentQcId = null;     // QC row id once a draft exists on the server
let uploadsInFlight = 0;
const photos = { content: null, gift: null, box: null };

// ── Draft persistence ───────────────────────────────────────────────────────
// Source of truth is the QC sheet itself (Status='Borrador').
// localStorage is only a fast local cache, used to avoid an extra round trip
// and as a fallback if the network is briefly unavailable.

function draftKey(trackingId) {
  return 'vp_qc_draft_' + (trackingId || 'no_tracking');
}

function saveDraftLocal() {
  if (!selected) return;
  const draft = {
    qc_id:    currentQcId,
    addonIds: Array.from(selectedAddonIds),
    photos:   photos,
    notes:    document.getElementById('qc-notes').value,
  };
  try {
    localStorage.setItem(draftKey(selected.tracking_id), JSON.stringify(draft));
  } catch (e) { /* storage full or unavailable — non-fatal */ }
}

function loadDraftLocal(trackingId) {
  try {
    const raw = localStorage.getItem(draftKey(trackingId));
    return raw ? JSON.parse(raw) : null;
  } catch (e) { return null; }
}

function clearDraftLocal(trackingId) {
  try { localStorage.removeItem(draftKey(trackingId)); } catch (e) { /* ignore */ }
}

// Push current photos/notes/addons to the server draft row.
// Creates the row on first call (sets currentQcId), updates it after.
async function syncDraftToServer() {
  if (!selected || !photos.content) return;  // nothing worth saving yet
  try {
    const res = await apiPost({
      action:        'save_qc_draft',
      qc_id:         currentQcId || undefined,
      tracking_id:   selected.tracking_id || ('MAN-' + Date.now()),
      order_ids:     [...selected.order_ids, ...Array.from(selectedAddonIds)],
      customer_id:   selected.customer_id,
      username:      selected.username,
      packer:        document.getElementById('packer-select').value,
      photo_content: photos.content ? photos.content.url : '',
      photo_gift:    (photos.gift || {}).url || '',
      photo_box:     (photos.box || {}).url || '',
      notes:         document.getElementById('qc-notes').value.trim(),
    });
    if (res.qc_id) currentQcId = res.qc_id;
    saveDraftLocal();
  } catch (e) {
    console.error('[syncDraftToServer] failed, keeping local draft only:', e);
    saveDraftLocal();
  }
}


// ── Auth (reuses the shared password/token pattern) ────────────────────────

async function ensureAuth() {
  await window.__qcAuthPromise;  // wait for password gate to resolve
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


// ── Init ─────────────────────────────────────────────────────────────────

document.getElementById('packer-select').value = localStorage.getItem('vp_packer') || 'Mariana';
document.getElementById('packer-select').onchange = e => localStorage.setItem('vp_packer', e.target.value);

(async function init() {
  await ensureAuth();
  await loadPending();
})();


// ── Pending list ─────────────────────────────────────────────────────────

async function loadPending() {
  const list = document.getElementById('pending-list');
  list.innerHTML = '<div class="empty-state">Cargando…</div>';

  try {
    const data = await apiGet('action=orders&status=Pagado,No Pagado');
    allActiveOrders = data.records || [];
  } catch (e) {
    list.innerHTML = '<div class="empty-state">Error al cargar. Desliza para reintentar.</div>';
    return;
  }

  const tikTokOrders = allActiveOrders.filter(r => r['Channel'] === 'TikTok' && r['Status'] === 'Pagado');

  if (tikTokOrders.length === 0) {
    list.innerHTML = '<div class="empty-state">Sin órdenes TikTok pendientes de empacar 🎉</div>';
    return;
  }

  // Group by tracking ID (combined orders share one tracking ID)
  const groups = {};
  tikTokOrders.forEach(r => {
    const tid = r['Tracking ID'] || ('order:' + r['Order ID']);
    if (!groups[tid]) groups[tid] = [];
    groups[tid].push(r);
  });

  list.innerHTML = Object.entries(groups).map(([tid, orders]) => {
    const first = orders[0];
    const username = first['Username'] || first['Primary Username'] || '—';
    const productsList = orders.map(o => o['Products']).filter(Boolean).join('; ');
    const orderIds = orders.map(o => o['Order ID']).filter(Boolean);

    return `
      <div class="pending-card" onclick='openCapture(${JSON.stringify({
        tracking_id: first['Tracking ID'] || '',
        order_ids: orderIds,
        customer_id: first['Customer ID'] || '',
        username: username,
        products: productsList,
      }).replace(/'/g, "&apos;")}).catch(e => console.error(e))'>
        <div class="pending-card-top">
          <span class="pending-username">@${escapeHtml(username)}</span>
          <span class="pending-count">${orders.length} pedido${orders.length !== 1 ? 's' : ''}</span>
        </div>
        <div class="pending-products">${escapeHtml(productsList || '—')}</div>
        ${first['Tracking ID'] ? `<div class="pending-tracking">${escapeHtml(first['Tracking ID'])}</div>` : ''}
      </div>`;
  }).join('');
}


// ── Capture view ─────────────────────────────────────────────────────────

async function openCapture(shipment) {
  selected = shipment;
  currentQcId = null;

  document.getElementById('ship-summary').innerHTML = `
    <div class="ship-summary-username">@${escapeHtml(shipment.username)}</div>
    <div class="ship-summary-products">${escapeHtml(shipment.products || '—')}</div>
    ${shipment.tracking_id ? `<div class="ship-summary-tracking">${escapeHtml(shipment.tracking_id)}</div>` : ''}
  `;

  renderAddonOrders(shipment.customer_id);

  // Reset to blank first
  selectedAddonIds = new Set();
  photos.content = null;
  photos.gift = null;
  photos.box = null;
  document.getElementById('qc-notes').value = '';

  // 1) Try the server first — the real source of truth (survives any device/browser change)
  let restored = false;
  if (shipment.tracking_id) {
    try {
      const data = await apiGet(`action=qc&tracking_ids=${encodeURIComponent(shipment.tracking_id)}`);
      const draftRow = (data.records || []).find(r => r['Status'] === 'Borrador');
      if (draftRow) {
        currentQcId = draftRow['QC ID'];
        photos.content = draftRow['Photo1 Content'] ? { url: draftRow['Photo1 Content'] } : null;
        photos.gift    = draftRow['Photo2 Gift']    ? { url: draftRow['Photo2 Gift'] }    : null;
        photos.box     = draftRow['Photo3 Box']     ? { url: draftRow['Photo3 Box'] }     : null;
        document.getElementById('qc-notes').value = draftRow['Notes'] || '';
        const savedOrderIds = String(draftRow['Order IDs'] || '').split(' + ').filter(Boolean);
        savedOrderIds.forEach(id => { if (!shipment.order_ids.includes(id)) selectedAddonIds.add(id); });
        restored = true;
      }
    } catch (e) {
      console.warn('[openCapture] could not reach server for draft, trying local cache:', e);
    }
  }

  // 2) Fall back to local cache if server had nothing (e.g. offline moment)
  if (!restored) {
    const local = loadDraftLocal(shipment.tracking_id);
    if (local) {
      currentQcId = local.qc_id || null;
      selectedAddonIds = new Set(local.addonIds || []);
      photos.content = local.photos?.content || null;
      photos.gift    = local.photos?.gift    || null;
      photos.box     = local.photos?.box     || null;
      document.getElementById('qc-notes').value = local.notes || '';
      restored = true;
    }
  }

  if (restored) showToast('Progreso anterior restaurado');

  // Reflect restored/reset state in the UI
  resetSlotVisual('content');
  resetSlotVisual('gift');
  resetSlotVisual('box');
  ['content', 'gift', 'box'].forEach(name => {
    if (photos[name]) setSlotState(name, 'done', photos[name].url);
  });
  selectedAddonIds.forEach(orderId => {
    const el = document.getElementById(`addon-${cssEscape(orderId)}`);
    if (el) el.classList.add('selected');
  });

  document.getElementById('view-pending').style.display = 'none';
  document.getElementById('view-capture').style.display = 'block';
  document.getElementById('qc-submit').disabled = !photos.content;
  window.scrollTo(0, 0);
}

function backToPending() {
  document.getElementById('view-capture').style.display = 'none';
  document.getElementById('view-pending').style.display = 'block';
  selected = null;
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
    <div class="addon-item" id="addon-${escapeAttr(o['Order ID'])}" onclick="toggleAddon('${escapeAttr(o['Order ID'])}')">
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

function toggleAddon(orderId) {
  const el = document.getElementById(`addon-${cssEscape(orderId)}`);
  if (selectedAddonIds.has(orderId)) {
    selectedAddonIds.delete(orderId);
    el.classList.remove('selected');
  } else {
    selectedAddonIds.add(orderId);
    el.classList.add('selected');
  }
  syncDraftToServer();
}


// ── Photo slots ──────────────────────────────────────────────────────────

function resetSlotVisual(name) {
  const slot = document.getElementById(`slot-${name}`);
  slot.className = name === 'content' ? 'slot required' : 'slot';
  const existingThumb = slot.querySelector('.slot-thumb');
  if (existingThumb) existingThumb.remove();
  const icon = slot.querySelector('.slot-icon');
  if (icon) icon.style.display = '';
  const spinner = slot.querySelector('.slot-spinner');
  if (spinner) spinner.remove();
}

function setSlotState(name, state, previewUrl) {
  const slot = document.getElementById(`slot-${name}`);
  const icon = slot.querySelector('.slot-icon');
  let spinner = slot.querySelector('.slot-spinner');
  let thumb = slot.querySelector('.slot-thumb');

  slot.classList.remove('done', 'retry', 'uploading');

  if (state === 'uploading') {
    slot.classList.add('uploading');
    if (icon) icon.style.display = 'none';
    if (!spinner) {
      spinner = document.createElement('div');
      spinner.className = 'slot-spinner';
      slot.insertBefore(spinner, slot.querySelector('.slot-label'));
    }
  } else if (state === 'done') {
    slot.classList.add('done');
    if (spinner) spinner.remove();
    if (icon) icon.style.display = 'none';
    if (!thumb && previewUrl) {
      thumb = document.createElement('img');
      thumb.className = 'slot-thumb';
      thumb.src = previewUrl;
      slot.insertBefore(thumb, slot.querySelector('.slot-label'));
    }
  } else if (state === 'retry') {
    slot.classList.add('retry');
    if (spinner) spinner.remove();
    if (thumb) thumb.remove();
    if (icon) icon.style.display = '';
  }
}

function bindSlot(name) {
  const input = document.querySelector(`#slot-${name} input`);
  input.onchange = async () => {
    const f = input.files[0];
    if (!f) return;
    const previewUrl = URL.createObjectURL(f);
    setSlotState(name, 'uploading');
    uploadsInFlight++;
    document.getElementById('qc-submit').disabled = true;
    try {
      photos[name] = await uploadPhoto(f, 'velpapier/qc');
      setSlotState(name, 'done', previewUrl);
      await syncDraftToServer();  // persist to the Sheet right away — this is the real safety net
    } catch (e) {
      console.error('[bindSlot] upload failed:', e);
      photos[name] = null;
      setSlotState(name, 'retry');
      showToast('Error al subir foto, intenta de nuevo', true);
    }
    uploadsInFlight--;
    document.getElementById('qc-submit').disabled = uploadsInFlight > 0 || !photos.content;
    input.value = '';  // allow re-selecting the same file
  };
}
['content', 'gift', 'box'].forEach(bindSlot);

document.getElementById('qc-notes').addEventListener('input', saveDraftLocal);
document.getElementById('qc-notes').addEventListener('change', syncDraftToServer);


// ── Submit ───────────────────────────────────────────────────────────────

async function submitQC() {
  const btn = document.getElementById('qc-submit');
  if (!photos.content) { showToast('Falta la foto de contenido', true); return; }

  btn.disabled = true;
  btn.textContent = 'Guardando…';

  const allOrderIds = [...selected.order_ids, ...Array.from(selectedAddonIds)];

  try {
    // Ensure the draft exists on the server before finalizing (covers the
    // rare case where the very first sync attempt failed silently).
    if (!currentQcId) await syncDraftToServer();

    const res = await apiPost({
      action:        'finalize_qc',
      qc_id:         currentQcId,
      tracking_id:   selected.tracking_id || ('MAN-' + Date.now()),
      order_ids:     allOrderIds,
      customer_id:   selected.customer_id,
      username:      selected.username,
      packer:        document.getElementById('packer-select').value,
      photo_content: photos.content.url,
      photo_gift:    (photos.gift || {}).url || '',
      photo_box:     (photos.box || {}).url || '',
      notes:         document.getElementById('qc-notes').value.trim(),
    });

    if (res.error) throw new Error(res.error);
    if (res.result !== 'created') throw new Error('Error desconocido');

    showToast('✓ Empacado y enviado');
    clearDraftLocal(selected.tracking_id);
    backToPending();
    loadPending();

  } catch (e) {
    showToast('Error: ' + e.message, true);
    btn.disabled = false;
    btn.textContent = 'Enviar';
  }
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
