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


// ── Sync current progress to the Sheet ──────────────────────────────────────

let syncSeq = 0;

async function syncToSheet() {
  if (!selected) return;
  if (gallery.content.length === 0 && gallery.box.length === 0) return;
  const mySeq = ++syncSeq;
  try {
    const allOrders = [...selected.order_ids, ...selectedAddons];
    const res = await apiPost({
      action:        'save_qc',
      qc_id:         currentQcId || undefined,
      tracking_id:   selected.tracking_id || ('MAN-' + Date.now()),
      order_ids:     allOrders,
      customer_id:   selected.customer_id,
      username:      selected.username,
      packer:        document.getElementById('packer-select').value,
      content_urls:  gallery.content.map(p => p.url),
      box_urls:      gallery.box.map(p => p.url),
      notes:         document.getElementById('qc-notes').value.trim(),
    });
    if (res.qc_id) currentQcId = res.qc_id;
  } catch (e) {
    console.error('[syncToSheet] failed:', e);
  }
}


// ── Init ─────────────────────────────────────────────────────────────────

document.getElementById('packer-select').value = localStorage.getItem('vp_packer') || 'Mariana';
document.getElementById('packer-select').onchange = e => localStorage.setItem('vp_packer', e.target.value);

(async function init() {
  await ensureAuth();
  await loadPending();
  setInterval(() => {
    // Only poll while looking at the list — never interrupt an active capture session
    if (document.getElementById('view-pending').style.display !== 'none') {
      refreshQcBadges();
    }
  }, 8000);
})();


// ── Pending list ─────────────────────────────────────────────────────────

async function loadPending() {
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

  renderPendingList();
}

function renderPendingList() {
  const list = document.getElementById('pending-list');
  const tikTokOrders = allActiveOrders.filter(r => r['Channel'] === 'TikTok' && r['Status'] === 'Pagado');

  if (tikTokOrders.length === 0) {
    list.innerHTML = '<div class="empty-state">Sin órdenes TikTok pendientes de empacar 🎉</div>';
    return;
  }

  const groups = {};
  tikTokOrders.forEach(r => {
    const tid = r['Tracking ID'] || ('order:' + r['Order ID']);
    if (!groups[tid]) groups[tid] = [];
    groups[tid].push(r);
  });

  list.innerHTML = Object.entries(groups).map(([tid, orders]) => {
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
          <span class="pending-username">@${escapeHtml(username)}</span>
          <span class="pending-count">${orders.length} pedido${orders.length !== 1 ? 's' : ''}</span>
        </div>
        ${first['Tracking ID'] ? `<div class="pending-tracking">${escapeHtml(first['Tracking ID'])}</div>` : ''}
        ${progressBadge}
      </div>`;
  }).join('');
}


// ── Capture view ─────────────────────────────────────────────────────────

function openCapture(shipment) {
  selected = shipment;
  currentQcId = null;
  selectedAddons = [];
  gallery.content = [];
  gallery.box = [];
  document.getElementById('qc-notes').value = '';

  document.getElementById('ship-summary').innerHTML = `
    <div class="ship-summary-username">@${escapeHtml(shipment.username)}</div>
    ${shipment.tracking_id ? `<div class="ship-summary-tracking">${escapeHtml(shipment.tracking_id)}</div>` : ''}
  `;

  renderAddonOrders(shipment.customer_id);

  // Restore from the already-loaded bulk QC data — instant, no network call
  let restored = false;
  if (shipment.tracking_id) {
    const row = allQcRows.find(r => r['Tracking ID'] === shipment.tracking_id);
    if (row) {
      currentQcId = row['QC ID'] || null;
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

  if (restored) showToast('Progreso anterior restaurado');

  renderGallery('content');
  renderGallery('box');
  selectedAddons.forEach(a => {
    const el = document.getElementById(`addon-${cssEscape(a.id)}`);
    if (el) el.classList.add('selected');
  });

  document.getElementById('view-pending').style.display = 'none';
  document.getElementById('view-capture').style.display = 'block';
  document.getElementById('qc-submit').disabled = gallery.content.length === 0;
  window.scrollTo(0, 0);
}

async function backToPending() {
  document.getElementById('view-capture').style.display = 'none';
  document.getElementById('view-pending').style.display = 'block';
  selected = null;
  currentQcId = null;
  await refreshQcBadges();
}

// Lightweight refresh: re-fetch only QC rows (small/fast) and re-render
// badges + list, without touching allActiveOrders or doing a full reload.
async function refreshQcBadges() {
  try {
    const qcData = await apiGet('action=qc');
    allQcRows = qcData.records || [];
    renderPendingList();
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
  syncToSheet();
}


// ── Photo galleries ──────────────────────────────────────────────────────

function renderGallery(group) {
  const galEl = document.getElementById(`gallery-${group}`);
  const btnEl = document.getElementById(`add-btn-${group}`);

  galEl.innerHTML = gallery[group].map((p, i) => `
    <div class="photo-thumb">
      <img src="${p.url}" loading="lazy" onclick="openLightbox('${p.url.replace(/'/g, "\\'")}')">
      <button class="photo-thumb-delete" onclick="deletePhoto('${group}', ${i})">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
      </button>
    </div>
  `).join('');

  if (gallery[group].length >= MAX_PHOTOS) {
    btnEl.classList.add('limit-reached');
  } else {
    btnEl.classList.remove('limit-reached');
  }
}

function deletePhoto(group, index) {
  if (!confirm('¿Eliminar esta foto?')) return;
  gallery[group].splice(index, 1);
  renderGallery(group);
  document.getElementById('qc-submit').disabled = gallery.content.length === 0;
  syncToSheet();
}

function bindAddButton(group) {
  const btn = document.getElementById(`add-btn-${group}`);
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
      await syncToSheet();
    } catch (e) {
      console.error(`[bindAddButton:${group}] upload failed:`, e);
      gallery[group].splice(placeholderIdx, 1);
      renderGallery(group);
      showToast('Error al subir foto, intenta de nuevo', true);
    }
    uploadsInFlight--;
    document.getElementById('qc-submit').disabled = uploadsInFlight > 0 || gallery.content.length === 0;
  };
}
['content', 'box'].forEach(bindAddButton);

function renderUploadingPlaceholder(group, idx) {
  const galEl = document.getElementById(`gallery-${group}`);
  const div = document.createElement('div');
  div.className = 'photo-thumb uploading';
  div.id = `uploading-${group}-${idx}`;
  div.innerHTML = '<div class="spinner"></div>';
  galEl.appendChild(div);
}

document.getElementById('qc-notes').addEventListener('change', syncToSheet);


// ── Submit ───────────────────────────────────────────────────────────────

async function submitQC() {
  const btn = document.getElementById('qc-submit');
  if (!selected) { showToast('Error: no hay orden seleccionada', true); return; }
  if (gallery.content.length === 0) { showToast('Falta al menos una foto de contenido', true); return; }

  btn.disabled = true;
  btn.textContent = 'Guardando…';

  const allOrders = [...selected.order_ids, ...selectedAddons];

  try {
    const res = await apiPost({
      action:        'save_qc',
      qc_id:         currentQcId || undefined,
      finalize:      true,
      tracking_id:   selected.tracking_id || ('MAN-' + Date.now()),
      order_ids:     allOrders,
      customer_id:   selected.customer_id,
      username:      selected.username,
      packer:        document.getElementById('packer-select').value,
      content_urls:  gallery.content.map(p => p.url),
      box_urls:      gallery.box.map(p => p.url),
      notes:         document.getElementById('qc-notes').value.trim(),
    });

    if (res.error) throw new Error(res.error);

    showToast('✓ Empacado y enviado');
    backToPending();
    loadPending();

  } catch (e) {
    showToast('Error: ' + e.message, true);
    btn.disabled = false;
    btn.textContent = 'Enviar';
  }
}


// ── Lightbox ─────────────────────────────────────────────────────────────

function openLightbox(url) {
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.9);z-index:500;display:flex;align-items:center;justify-content:center;padding:20px;-webkit-tap-highlight-color:transparent';
  overlay.innerHTML = `<img src="${url}" style="max-width:100%;max-height:100%;object-fit:contain;border-radius:8px">`;
  overlay.onclick = () => overlay.remove();
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
