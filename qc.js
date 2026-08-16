// qc.js — Vel Papier QC capture page logic

const API = 'https://script.google.com/macros/s/AKfycby9_wvcACIMS-aVcNmJWatiRtbWFH8TvqWJFNnjNcPjZstsqOOc-QmFz4iIWGcu27pHvg/exec';

let API_TOKEN = localStorage.getItem('vp_token') || '';

let allActiveOrders = [];   // all Pagado/No Pagado orders, fetched once per session
let selected = null;        // { tracking_id, order_ids:[], customer_id, username, products, label }
let selectedAddonIds = new Set();  // order_ids of add-on orders the user checked
const photos = { content: null, gift: null, box: null };


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
      }).replace(/'/g, "&apos;")})'>
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

function openCapture(shipment) {
  selected = shipment;
  selectedAddonIds = new Set();
  photos.content = null;
  photos.gift = null;
  photos.box = null;
  document.getElementById('qc-notes').value = '';
  resetSlotVisual('content');
  resetSlotVisual('gift');
  resetSlotVisual('box');

  document.getElementById('ship-summary').innerHTML = `
    <div class="ship-summary-username">@${escapeHtml(shipment.username)}</div>
    <div class="ship-summary-products">${escapeHtml(shipment.products || '—')}</div>
    ${shipment.tracking_id ? `<div class="ship-summary-tracking">${escapeHtml(shipment.tracking_id)}</div>` : ''}
  `;

  renderAddonOrders(shipment.customer_id);

  document.getElementById('view-pending').style.display = 'none';
  document.getElementById('view-capture').style.display = 'block';
  document.getElementById('qc-submit').disabled = true;
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
    try {
      photos[name] = await uploadPhoto(f, 'velpapier/qc');
      setSlotState(name, 'done', previewUrl);
    } catch (e) {
      photos[name] = null;
      setSlotState(name, 'retry');
      showToast('Error al subir foto, intenta de nuevo', true);
    }
    document.getElementById('qc-submit').disabled = !photos.content;
    input.value = '';  // allow re-selecting the same file
  };
}
['content', 'gift', 'box'].forEach(bindSlot);


// ── Submit ───────────────────────────────────────────────────────────────

async function submitQC() {
  const btn = document.getElementById('qc-submit');
  if (!photos.content) { showToast('Falta la foto de contenido', true); return; }

  btn.disabled = true;
  btn.textContent = 'Guardando…';

  const allOrderIds = [...selected.order_ids, ...Array.from(selectedAddonIds)];

  try {
    const res = await apiPost({
      action:        'create_qc',
      tracking_id:   selected.tracking_id || ('MAN-' + Date.now()),
      order_ids:     allOrderIds,
      customer_id:   selected.customer_id,
      username:      selected.username,
      packer:        document.getElementById('packer-select').value,
      photo_content: photos.content.url,
      photo_gift:    (photos.gift || {}).url || '',
      photo_box:     (photos.box || {}).url || '',
      skus:          '',
      notes:         document.getElementById('qc-notes').value.trim(),
    });

    if (res.result === 'duplicate') {
      showToast('⚠ Esta guía ya tiene QC registrado');
      backToPending();
      loadPending();
      return;
    }
    if (res.result !== 'created') throw new Error(res.error || 'Error desconocido');

    showToast('✓ Empacado y enviado');
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
