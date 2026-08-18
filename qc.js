// qc.js — Vel Papier QC capture page logic

const API = 'https://script.google.com/macros/s/AKfycbyeywjfBWA0hFSy_3U3A2iYLE2TlPN22pBOELJ97N-FTAkgXkEAk6Af0aG1O3DjK8OjHw/exec';

let API_TOKEN = localStorage.getItem('vp_token') || '';

let allActiveOrders = [];
let selected = null;
let selectedAddonIds = new Set();
let currentQcId = null;
let uploadsInFlight = 0;
const photos = { content: null, gift: null, box: null };


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

async function syncToSheet() {
  console.log('[syncToSheet] called, selected=', selected, 'photos=', photos);
  if (!selected) { console.log('[syncToSheet] EARLY RETURN: no selected'); return; }
  if (!photos.content && !photos.gift && !photos.box) { console.log('[syncToSheet] EARLY RETURN: no photos'); return; }
  try {
    const res = await apiPost({
      action:        'save_qc',
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
  } catch (e) {
    console.error('[syncToSheet] failed:', e);
  }
}

document.getElementById('packer-select').value = localStorage.getItem('vp_packer') || 'Mariana';
document.getElementById('packer-select').onchange = e => localStorage.setItem('vp_packer', e.target.value);

(async function init() {
  await ensureAuth();
  await loadPending();
})();

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

async function openCapture(shipment) {
  selected = shipment;
  currentQcId = null;

  document.getElementById('ship-summary').innerHTML = `
    <div class="ship-summary-username">@${escapeHtml(shipment.username)}</div>
    <div class="ship-summary-products">${escapeHtml(shipment.products || '—')}</div>
    ${shipment.tracking_id ? `<div class="ship-summary-tracking">${escapeHtml(shipment.tracking_id)}</div>` : ''}
  `;

  renderAddonOrders(shipment.customer_id);

  selectedAddonIds = new Set();
  photos.content = null;
  photos.gift = null;
  photos.box = null;
  document.getElementById('qc-notes').value = '';

  let restored = false;
  if (shipment.tracking_id) {
    try {
      const data = await apiGet(`action=qc&tracking_ids=${encodeURIComponent(shipment.tracking_id)}`);
      const row = (data.records || [])[0];
      if (row && (row['Photo1 Content'] || row['Photo2 Gift'] || row['Photo3 Box'])) {
        currentQcId = row['QC ID'];
        photos.content = row['Photo1 Content'] ? { url: row['Photo1 Content'] } : null;
        photos.gift    = row['Photo2 Gift']    ? { url: row['Photo2 Gift'] }    : null;
        photos.box     = row['Photo3 Box']     ? { url: row['Photo3 Box'] }     : null;
        document.getElementById('qc-notes').value = row['Notes'] || '';
        const savedOrderIds = String(row['Order IDs'] || '').split(' + ').filter(Boolean);
        savedOrderIds.forEach(id => { if (!shipment.order_ids.includes(id)) selectedAddonIds.add(id); });
        restored = true;
      }
    } catch (e) {
      console.warn('[openCapture] could not check for existing progress:', e);
    }
  }

  if (restored) showToast('Progreso anterior restaurado');

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
  currentQcId = null;
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
  syncToSheet();
}

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
      await syncToSheet();
    } catch (e) {
      console.error('[bindSlot] upload failed:', e);
      photos[name] = null;
      setSlotState(name, 'retry');
      showToast('Error al subir foto, intenta de nuevo', true);
    }
    uploadsInFlight--;
    document.getElementById('qc-submit').disabled = uploadsInFlight > 0 || !photos.content;
    input.value = '';
  };
}
['content', 'gift', 'box'].forEach(bindSlot);

document.getElementById('qc-notes').addEventListener('change', syncToSheet);

async function submitQC() {
  const btn = document.getElementById('qc-submit');
  if (!selected) { showToast('Error: no hay orden seleccionada', true); return; }
  if (!photos.content) { showToast('Falta la foto de contenido', true); return; }

  btn.disabled = true;
  btn.textContent = 'Guardando…';

  const allOrderIds = [...selected.order_ids, ...Array.from(selectedAddonIds)];

  try {
    const res = await apiPost({
      action:        'save_qc',
      qc_id:         currentQcId || undefined,
      finalize:      true,
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

    showToast('✓ Empacado y enviado');
    backToPending();
    loadPending();

  } catch (e) {
    showToast('Error: ' + e.message, true);
    btn.disabled = false;
    btn.textContent = 'Enviar';
  }
}

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
