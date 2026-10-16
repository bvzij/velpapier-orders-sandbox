const API = 'https://script.google.com/macros/s/AKfycbyeywjfBWA0hFSy_3U3A2iYLE2TlPN22pBOELJ97N-FTAkgXkEAk6Af0aG1O3DjK8OjHw/exec';

const HIDE_TIKTOK_FROM_MAIN_TABS = true; // set to true when TikTok tab is fully tested

let API_TOKEN = localStorage.getItem('vp_token') || '';

async function ensureAuth() {
  await VP.ensureToken();
  API_TOKEN = VP.token;
}

// Maps internal field names (used throughout the UI) to the new Orders sheet column names.
const FIELD_MAP = {
  ID: 'Order ID',
  Cliente: 'Primary Username',
  Producto: 'Products',
  Precio: 'Price',
  Notas: 'Notes',
  Status: 'Status',
  Channel: 'Channel',
  CustomerId: 'Customer ID',
  ShopifyOrderId: 'Shopify Order ID',
  ShopifyOrderNumber: 'Shopify Order Number',
  'Fecha Creación': 'Created Date',
  ArchiveDate: 'Archive Date'
};

const STATUS_FLOW = ['No Pagado', 'Pagado', 'Enviado', 'Archivado'];
function nextStatuses(current) {
  const idx = STATUS_FLOW.indexOf(current);
  if (idx === -1 || idx === STATUS_FLOW.length - 1) return [];
  return STATUS_FLOW.slice(idx + 1);
}

// ── UNDO / REDO (status changes only) ───────────────────────
// Button state now reflects the server's one undo/redo slot (per
// logged-in person), not a local array -- fetched once on load and
// refreshed after every undo/redo, rather than guessed from local state
// that could be stale across tabs/devices.
async function updateUndoRedoButtons() {
  const undoBtn = document.getElementById('undo-btn');
  const redoBtn = document.getElementById('redo-btn');
  try {
    const status = await apiGet('action=undo_redo_status');
    if (undoBtn) undoBtn.disabled = !status.can_undo;
    if (redoBtn) redoBtn.disabled = !status.can_redo;
  } catch (e) {
    // Fail safe: if the status check itself fails, disable both rather
    // than leave stale enabled buttons that might 'No hay nada que...'
    // on click.
    if (undoBtn) undoBtn.disabled = true;
    if (redoBtn) redoBtn.disabled = true;
  }
}

async function performStatusUpdate(orderId, status) {
  const payload = { action: 'update_order_status', order_id: orderId, status: status };
  return apiPost(payload);
}

// Delegates to the server's own one-slot-per-person undo/redo (see
// undo_last_action / redo_last_action in apps-script.gs). The server
// looks up the real logged Before/After value itself -- this no longer
// trusts a locally-remembered from_status/to_status, so it stays correct
// even across devices/tabs for the same logged-in person.
async function performUndo() {
  try {
    const result = await apiPost({ action: 'undo_last_action' });
    if (result.error) throw new Error(result.error);
    if (result.record_type === 'Order') {
      const rec = allRecords.find(r => String(r.ID) === String(result.record_id));
      if (rec && result.field === 'Status') rec.Status = result.restored_value;
    }
    updateUndoRedoButtons();
    renderAll();
    if (searchSelectedCliente) runSearch(searchSelectedCliente);
    showToast(`↩ Deshecho: ${result.field} → ${result.restored_value}`);
  } catch (e) { showToast('Error: ' + e.message); }
}

async function performRedo() {
  try {
    const result = await apiPost({ action: 'redo_last_action' });
    if (result.error) throw new Error(result.error);
    if (result.record_type === 'Order') {
      const rec = allRecords.find(r => String(r.ID) === String(result.record_id));
      if (rec && result.field === 'Status') rec.Status = result.restored_value;
    }
    updateUndoRedoButtons();
    renderAll();
    if (searchSelectedCliente) runSearch(searchSelectedCliente);
    showToast(`↪ Rehecho: ${result.field} → ${result.restored_value}`);
  } catch (e) { showToast('Error: ' + e.message); }
}

function statusPillClass(status) {
  if (status === 'No Pagado') return 'pill-nopagado';
  if (status === 'Pagado') return 'pill-pagado';
  return 'pill-enviado';
}

function channelTag(channel) {
  const cls = channel === 'TikTok' ? 'channel-tiktok' : channel === 'Shopify' ? 'channel-shopify' : 'channel-manual';
  return `<span class="channel-tag ${cls}">${escapeHtml(channel || 'Manual')}</span>`;
}

function mapFromApi(r) {
  return {
    ID: r['Order ID'],
    Cliente: r['Primary Username'] || '',
    Producto: r['Products'] || '',
    Precio: Number(r['Price']) || 0,
    Notas: r['Notes'] || '',
    Status: r['Status'] || 'No Pagado',
    Channel: r['Channel'] || 'Manual',
    CustomerId: r['Customer ID'] || '',
    ShopifyOrderId: r['Shopify Order ID'] || '',
    // Was never mapped in, so shopifyOrderLine() always fell back to the
    // bare "Shopify" label instead of "Shopify #1234".
    ShopifyOrderNumber: r['Shopify Order Number'] || '',
    // Needed so a non-TikTok order can be linked to the TikTok shipment it
    // physically travels with -- Linked Shipment stores the tracking ID.
    TrackingId: r['Tracking ID'] || '',
    LinkedShipment: r['Linked Shipment'] || '',
    ArchiveDate: r['Archive Date'] || '',
    'Fecha Creación': r['Created Date']
  };
}

function mapToApiFields(fields) {
  const out = {};
  Object.entries(fields).forEach(([k, v]) => { out[FIELD_MAP[k] || k] = v; });
  return out;
}

function isShipped(status) { return status === 'Enviado' || status === 'Archivado'; }

let allRecords = [];
let activeRecords = [];
let enviadoRecords = [];
let archivedRecords = [];
let tabDataLoaded = { enviado: false, archivo: false, qc: false };
let shopifyPendingGroupsList = [];
let allCustomers = {}; // keyed by lowercase username → { name, shipmentCount }
let customersById = {}; // keyed by Customer ID → Primary Username, for backfilling missing order-level usernames
let pendingMatchesByShopifyOrderId = {}; // keyed by Shopify Order ID → pending match record, for the merge review UI
let currentTab = 'activos';
let currentSort = 'newest';
let pendingAction = null;
let bulkItems = [{ producto: '', precio: '', notas: '' }];

// ── HELPERS ──────────────────────────────────────────────────
function daysSince(dateStr) { if (!dateStr) return 0; return Math.floor((new Date() - new Date(dateStr)) / 86400000); }
function formatMXN(n) { if (n === undefined || n === null || n === '') return '—'; return '$' + Number(n).toLocaleString('es-MX', { minimumFractionDigits: 0, maximumFractionDigits: 2 }); }
function formatDate(dateStr) { if (!dateStr) return ''; return new Date(dateStr).toLocaleDateString('es-MX', { day: '2-digit', month: '2-digit', year: '2-digit', timeZone: 'America/Mexico_City' }); }
// Date + time, Mexico City. Created Date has always stored a full ISO
// timestamp -- only the display was truncating it to the date.
function formatDateTime(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleString('es-MX', {
    day: '2-digit', month: '2-digit', year: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
    timeZone: 'America/Mexico_City',
  });
}
function showToast(msg) { const t = document.getElementById('toast'); t.textContent = msg; t.classList.add('show'); setTimeout(() => t.classList.remove('show'), 2500); }function getInitials(name) { return (name || '?').replace('@', '').substring(0, 2).toUpperCase(); }
function isUnnamedCliente(cliente) { return !cliente || !cliente.trim() || cliente.trim().toLowerCase().includes('sin nombre'); }
function previousStatus(status) { if (status === 'Pagado') return 'No Pagado'; if (status === 'Enviado') return 'Pagado'; return null; }
function escapeHtml(s) { return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
function summarizeProductCount(productsStr) {
  if (!productsStr) return '—';
  const parts = productsStr.split(';').map(s => s.trim()).filter(Boolean);
  if (parts.length === 0) return '—';
  let total = 0;
  parts.forEach(p => {
    const m = p.match(/^(\d+)\s*x/i);
    total += m ? parseInt(m[1], 10) : 1;
  });
  return total === 1 ? '1 producto' : `${total} productos`;
}
const SHOPIFY_STORE_HANDLE = '41uqww-0a';

function shopifyOrderLine(r) {
  const count = summarizeProductCount(r.Producto);

  if (r.Channel === 'Shopify' && r.ShopifyOrderId) {
    const label = r.ShopifyOrderNumber ? `Shopify ${r.ShopifyOrderNumber}` : 'Shopify';
    const url = `https://admin.shopify.com/store/${SHOPIFY_STORE_HANDLE}/orders/${r.ShopifyOrderId}`;
    return `<a href="${url}" target="_blank" rel="noopener noreferrer" class="notas-link" title="Ver pedido en Shopify" onclick="event.stopPropagation()">${escapeHtml(label)}</a> · ${count}`;
  }

  if (r.Channel === 'TikTok' && r.ID) {
    // TikTok orders can combine multiple Order IDs (e.g. "123 + 456") when
    // several TikTok orders ship together. Link each one separately, using
    // its own ID as the label instead of the generic word "TikTok".
    const ids = String(r.ID).split('+').map(s => s.trim()).filter(Boolean);
    const links = ids.map(id =>
      `<a href="https://seller-mx.tiktok.com/order/detail?order_no=${encodeURIComponent(id)}&shop_region=MX" target="_blank" rel="noopener noreferrer" class="notas-link" title="Ver pedido en TikTok">${escapeHtml(id)}</a>`
    );
    return `${links.join(' + ')} · ${count}`;
  }

  // Manual entries have no order number and no parsable product list --
  // the Products field is one free-text line typed by hand. Summarising it
  // as "1 producto" hid the only information the entry actually carries.
  if (r.Producto) return escapeHtml(r.Producto);

  return count;
}
function renderNotas(notas) {
  if (!notas) return '';
  if (/^https?:\/\//.test(notas.trim())) {
    const match = notas.match(/orders\/(\d+)/);
    const orderId = match ? match[1] : '';
    return `<a href="${escapeHtml(notas.trim())}" target="_blank" rel="noopener noreferrer" class="notas-link" title="Ver pedido en Shopify" onclick="event.stopPropagation()">Ver en Shopify ${orderId ? ` <span class="order-id-faint">#${orderId}</span>` : ''}</a>`;
  }
  return escapeHtml(notas);
}

// ── BULK ITEMS ───────────────────────────────────────────────
function saveBulkState() {
  bulkItems = bulkItems.map((_, i) => ({
    producto: (document.querySelector(`.bulk-producto[data-idx="${i}"]`) || {}).value || '',
    precio:   (document.querySelector(`.bulk-precio[data-idx="${i}"]`)   || {}).value || '',
    notas:    (document.querySelector(`.bulk-notas[data-idx="${i}"]`)    || {}).value || '',
  }));
}

function addBulkItem() { saveBulkState(); bulkItems.push({ producto: '', precio: '', notas: '' }); renderBulkItems(); }

function removeBulkItem(idx) { saveBulkState(); bulkItems.splice(idx, 1); if (!bulkItems.length) bulkItems = [{ producto: '', precio: '', notas: '' }]; renderBulkItems(); }

function renderBulkItems() {
  const container = document.getElementById('bulk-items-container');
  container.innerHTML = '';
  bulkItems.forEach((item, i) => {
    const row = document.createElement('div');
    row.className = 'bulk-item-row';
    row.innerHTML = `
      <div class="bulk-item-header">
        <span class="bulk-item-label">${bulkItems.length > 1 ? 'Producto ' + (i + 1) : 'Producto'}</span>
        ${bulkItems.length > 1 ? '<button class="btn btn-xs btn-danger remove-bulk-btn">✕</button>' : ''}
      </div>
      <div class="form-group" style="margin-bottom:6px"><input type="text" class="bulk-producto" data-idx="${i}" placeholder="Nombre del producto..." value="${item.producto}" /></div>
      <div class="form-group" style="margin-bottom:6px"><input type="number" class="bulk-precio" data-idx="${i}" placeholder="Precio (MXN)" min="0" step="1" value="${item.precio}" /></div>
      <div class="form-group" style="margin-bottom:0"><input type="text" class="bulk-notas" data-idx="${i}" placeholder="Nota opcional..." value="${item.notas}" /></div>`;
    const removeBtn = row.querySelector('.remove-bulk-btn');
    if (removeBtn) removeBtn.addEventListener('click', () => removeBulkItem(i));
    container.appendChild(row);
  });
}

function renderGiftToggle() {
  const checkbox = document.getElementById('gift-checkbox');
  const giftSection = document.getElementById('gift-recipient-section');
  if (!checkbox || !giftSection) return;
  giftSection.style.display = checkbox.checked ? 'block' : 'none';
}

// ── SEARCH ───────────────────────────────────────────────────
let searchSelectedCliente = null;

function handleSearchInput() {
  const val = document.getElementById('global-search').value.trim().toLowerCase();
  const list = document.getElementById('search-autocomplete-list');
  updateClearBtn();
  if (!val) { list.style.display = 'none'; return; }
  const clientes = getUniqueClientes().filter(c => {
    const val_lower = val.toLowerCase();
    return c.name.toLowerCase().startsWith(val_lower) ||
      (c.aliases || []).some(a => a.toLowerCase().startsWith(val_lower));
  }).slice(0, 8);
  if (!clientes.length) { list.style.display = 'none'; return; }
  list.innerHTML = '';
  clientes.forEach(c => {
    const item = document.createElement('div');
    item.className = 'autocomplete-item';
    item.innerHTML = `<span>${c.name}</span>`;
    item.addEventListener('mousedown', e => { e.preventDefault(); selectSearchCliente(c.name, c.customerId); });
    list.appendChild(item);
  });
  list.style.display = 'block';
}

let searchSelectedCustomerId = null;

function selectSearchCliente(name, customerId) {
  searchSelectedCliente = name;
  searchSelectedCustomerId = customerId || null;
  document.getElementById('global-search').value = name;
  document.getElementById('search-autocomplete-list').style.display = 'none';
  updateClearBtn();
  runSearch(name);
}

function hideSearchAutocomplete() { setTimeout(() => { const l = document.getElementById('search-autocomplete-list'); if (l) l.style.display = 'none'; }, 150); }

function clearSearch() {
  searchSelectedCliente = null;
  document.getElementById('global-search').value = '';
  document.getElementById('search-autocomplete-list').style.display = 'none';
  updateClearBtn();
  document.getElementById('search-panel').style.display = 'none';
  document.getElementById('main-panel').style.display = 'block';
}

function updateClearBtn() { document.getElementById('search-clear-btn').style.display = document.getElementById('global-search').value ? 'flex' : 'none'; }

// Known limitation, unchanged by this edit: matching is still by the raw
// Cliente text, not Customer ID, so an order stored under a slightly
// different username string for the same customer won't appear here.
let searchFilter = 'Todos';

// Matches by Customer ID when we have one (the correct, reliable way --
// different channels often store a different raw username string for the
// same real person). Falls back to the typed text only for orders with no
// Customer ID at all (genuinely unresolved orders).
function runSearch(name) {
  const val = name.toLowerCase();
  const custId = searchSelectedCustomerId;
  document.getElementById('search-panel').style.display = 'block';
  document.getElementById('main-panel').style.display = 'none';
  const byDateDesc = (a, b) => new Date(b['Fecha Creación'] || 0) - new Date(a['Fecha Creación'] || 0);
  const matches = r => custId ? r.CustomerId === custId : (r.Cliente || '').toLowerCase() === val;

  let all = allRecords.filter(matches).sort(byDateDesc);
  if (!all.length) {
    document.getElementById('search-results').innerHTML = `<div class="empty-state">Sin resultados para "${name}"</div>`;
    renderSearchFilterBar(0);
    return;
  }

  renderSearchFilterBar(all.length);

  if (searchFilter === 'Por cobrar') all = all.filter(r => r.Status === 'No Pagado');
  else if (searchFilter === 'Por enviar') all = all.filter(r => r.Status === 'Pagado');
  else if (searchFilter === 'Enviado') all = all.filter(r => r.Status === 'Enviado');
  else if (searchFilter === 'Archivo') all = all.filter(r => r.Status === 'Archivado');
  else if (searchFilter === 'Activos') all = all.filter(r => r.Status === 'No Pagado' || r.Status === 'Pagado');
  else if (searchFilter === 'TikTok') all = all.filter(r => r.Channel === 'TikTok');
  else if (searchFilter === 'Shopify') all = all.filter(r => r.Channel === 'Shopify');
  // 'Todos' -- no filter

  const results = document.getElementById('search-results');
  results.innerHTML = '';
  if (!all.length) { results.innerHTML = `<div class="empty-state">Sin resultados en este filtro</div>`; return; }

  const active   = all.filter(r => r.Status === 'No Pagado' || r.Status === 'Pagado');
  const shipped  = all.filter(r => r.Status === 'Enviado');
  const archived = all.filter(r => r.Status === 'Archivado');

  function appendGroup(records, labelText, greyedOut) {
    if (!records.length) return;
    if (labelText) { const l = document.createElement('div'); l.className = 'section-label'; l.textContent = labelText; results.appendChild(l); }
    groupByCliente(records).forEach(grp => {
      const cliente = grp.name;
      const group = document.createElement('div'); group.className = 'customer-group' + (greyedOut ? ' customer-group--faded' : '');
      group.innerHTML = `<div class="customer-header${isUnnamedCliente(cliente) ? ' customer-header--unnamed' : ''}"><div class="customer-avatar">${getInitials(cliente)}</div><div class="customer-name customer-name--clickable">${cliente}</div></div>`;
      const searchCustId = (grp.items[0] && grp.items[0].CustomerId) || '';
      const searchNameEl = group.querySelector('.customer-name');
      if (searchNameEl && searchCustId) searchNameEl.addEventListener('click', () => openCustomerHistory(searchCustId, cliente));
      // showActions stays true in every tier -- Enviado/Archivado rows are
      // greyed out visually, not disabled; Editar/Eliminar/Estado still work.
      grp.items.forEach(r => group.appendChild(renderOrderRow(r, true)));
      results.appendChild(group);
    });
  }

  appendGroup(active, searchFilter === 'Todos' ? 'Activos' : '', false);
  if (shipped.length && searchFilter === 'Todos') { const d = document.createElement('div'); d.className = 'search-divider'; d.textContent = 'Enviado'; results.appendChild(d); }
  appendGroup(shipped, '', true);
  if (archived.length && searchFilter === 'Todos') { const d = document.createElement('div'); d.className = 'search-divider'; d.textContent = 'Archivado'; results.appendChild(d); }
  appendGroup(archived, '', true);
}

function renderSearchFilterBar(totalCount) {
  const bar = document.getElementById('search-filter-bar');
  if (!bar) return;
  if (!totalCount) { bar.innerHTML = ''; return; }
  const options = ['Todos', 'Activos', 'Por cobrar', 'Por enviar', 'Enviado', 'Archivo', 'TikTok', 'Shopify'];
  bar.innerHTML = options.map(o =>
    `<button class="search-filter-btn${o === searchFilter ? ' active' : ''}" data-filter="${escapeHtml(o)}">${escapeHtml(o)}</button>`
  ).join('');
  bar.querySelectorAll('.search-filter-btn').forEach(btn => btn.addEventListener('click', () => {
    searchFilter = btn.dataset.filter;
    if (searchSelectedCliente) runSearch(searchSelectedCliente);
  }));
}

// ── CLIENT AUTOCOMPLETE ──────────────────────────────────────
function handleClienteInput() {
  const val = document.getElementById('new-cliente').value.trim().toLowerCase();
  const list = document.getElementById('autocomplete-list');
  if (!val) { list.style.display = 'none'; return; }
  const clientes = getUniqueClientes().filter(c => {
    const val_lower = val.toLowerCase();
    return c.name.toLowerCase().startsWith(val_lower) ||
      (c.aliases || []).some(a => a.toLowerCase().startsWith(val_lower));
  }).slice(0, 8);
  if (!clientes.length) { list.style.display = 'none'; return; }
  list.innerHTML = '';
  clientes.forEach(c => {
    const item = document.createElement('div');
    item.className = 'autocomplete-item';
    item.innerHTML = `<span>${c.name}</span>`;
    item.addEventListener('mousedown', e => { e.preventDefault(); selectCliente(c.name); });
    list.appendChild(item);
  });
  list.style.display = 'block';
}

function selectCliente(name) {
  document.getElementById('new-cliente').value = name;
  document.getElementById('autocomplete-list').style.display = 'none';
  const first = document.querySelector('.bulk-producto');
  if (first) first.focus();
}

function hideAutocomplete() { setTimeout(() => { const l = document.getElementById('autocomplete-list'); if (l) l.style.display = 'none'; }, 150); }

function handleGiftRecipientInput() {
  const val = (document.getElementById('gift-recipient').value || '').trim().toLowerCase();
  const list = document.getElementById('gift-autocomplete-list');
  if (!val) { list.style.display = 'none'; return; }
  const clientes = getUniqueClientes().filter(c => {
    return c.name.toLowerCase().startsWith(val) ||
      (c.aliases || []).some(a => a.toLowerCase().startsWith(val));
  }).slice(0, 8);
  if (!clientes.length) { list.style.display = 'none'; return; }
  list.innerHTML = '';
  clientes.forEach(c => {
    const item = document.createElement('div');
    item.className = 'autocomplete-item';
    item.innerHTML = `<span>${c.name}</span>`;
    item.addEventListener('mousedown', e => {
      e.preventDefault();
      document.getElementById('gift-recipient').value = c.name;
      list.style.display = 'none';
    });
    list.appendChild(item);
  });
  list.style.display = 'block';
}

function getUniqueClientes() {
  const seen = {};
  Object.entries(allCustomers).forEach(([key, c]) => {
    const primary = (c.name || '').trim();
    if (!primary) return;
    const k = primary.toLowerCase();
    if (!seen[k]) seen[k] = { name: primary, aliases: c.aliases || [], customerId: c.customerId || '' };
  });
  return Object.values(seen).sort((a, b) => a.name.localeCompare(b.name, 'es'));
}

// ── MODALS ───────────────────────────────────────────────────
function showConfirmModal(message, onConfirm) {
  pendingAction = onConfirm;
  const c = document.getElementById('modal-container');
  c.innerHTML = `<div class="modal-overlay" id="modal-overlay"><div class="modal"><div class="modal-title">Confirmar acción</div><div class="modal-body">${message}</div><div class="modal-actions"><button class="btn" id="modal-cancel-btn">Cancelar</button><button class="btn btn-primary" id="modal-confirm-btn">Confirmar</button></div></div></div>`;
  document.getElementById('modal-cancel-btn').addEventListener('click', closeModal);
  document.getElementById('modal-confirm-btn').addEventListener('click', () => { const a = pendingAction; closeModal(); if (a) a(); });
}

function showEditModal(id) {
  const r = allRecords.find(r => r.ID === id);
  if (!r) return;
  const c = document.getElementById('modal-container');
  c.innerHTML = `<div class="modal-overlay" id="modal-overlay"><div class="modal"><div class="modal-title">Editar pedido</div><div class="edit-form">
    <input type="text" id="edit-cliente" value="${(r.Cliente || '').replace(/"/g, '&quot;')}" placeholder="Usuario TikTok" />
    <input type="text" id="edit-producto" value="${(r.Producto || '').replace(/"/g, '&quot;')}" placeholder="Producto" />
    <input type="number" id="edit-precio" value="${r.Precio || 0}" placeholder="Precio" min="0" step="1" />
    <select id="edit-status"><option value="No Pagado" ${r.Status === 'No Pagado' ? 'selected' : ''}>No Pagado</option><option value="Pagado" ${r.Status === 'Pagado' ? 'selected' : ''}>Pagado</option><option value="Enviado" ${r.Status === 'Enviado' ? 'selected' : ''}>Enviado</option><option value="Archivado" ${r.Status === 'Archivado' ? 'selected' : ''}>Archivado</option></select>
    <input type="text" id="edit-notas" value="${(r.Notas || '').replace(/"/g, '&quot;')}" placeholder="Notas (opcional)" />
  </div><div class="modal-actions"><button class="btn" id="edit-cancel-btn">Cancelar</button><button class="btn btn-primary" id="edit-save-btn">Guardar</button></div></div></div>`;
  document.getElementById('edit-cancel-btn').addEventListener('click', closeModal);
  document.getElementById('edit-save-btn').addEventListener('click', () => saveEdit(id));
}

function closeModal() { document.getElementById('modal-container').innerHTML = ''; pendingAction = null; }

function showNewOrderModal(prefillUsername) {
  const c = document.getElementById('modal-container');
  c.innerHTML = `<div class="modal-overlay" id="modal-overlay"><div class="modal"><div class="modal-title">Nueva orden</div><div class="edit-form">
    <input type="text" id="no-username" placeholder="Usuario" autocomplete="off" value="${escapeHtml(prefillUsername || '')}" />
    <select id="no-channel">
      <option value="Manual" selected>Manual</option>
      <option value="TikTok">TikTok</option>
      <option value="Shopify">Shopify</option>
    </select>
    <textarea id="no-products" rows="3" placeholder="2x Libreta A5 - Cobre&#10;1x Libreta A5 - Cafe"></textarea>
    <input type="number" id="no-price" placeholder="Precio" min="0" step="1" />
    <input type="text" id="no-notes" placeholder="Notas (opcional)" />
    <input type="text" id="no-shopify-id" placeholder="Shopify Order ID (opcional)" />
  </div><div class="modal-actions"><button class="btn" id="no-cancel-btn">Cancelar</button><button class="btn btn-primary" id="no-save-btn">Guardar</button></div></div></div>`;
  document.getElementById('no-cancel-btn').addEventListener('click', closeModal);
  document.getElementById('no-save-btn').addEventListener('click', submitNewOrder);
}

async function submitNewOrder() {
  const username = document.getElementById('no-username').value.trim();
  const channel = document.getElementById('no-channel').value;
  const products = document.getElementById('no-products').value.trim();
  const price = parseFloat(document.getElementById('no-price').value) || 0;
  const notes = document.getElementById('no-notes').value.trim();
  const shopifyId = document.getElementById('no-shopify-id').value.trim();
  if (!username || !products) { showToast('Faltan datos'); return; }
  try {
    const result = await apiPost({ action: 'create_order', username, channel, products, price, notes, shopify_order_id: shopifyId });
    if (result.result !== 'created') throw new Error(result.error || 'Error');
    allRecords.push({ ID: result.order_id, Cliente: username, Channel: channel, Producto: products, Precio: price, Notas: notes, Status: result.status || 'No Pagado', CustomerId: result.customer_id || '', ShopifyOrderId: shopifyId, 'Fecha Creación': new Date().toISOString() });
    closeModal();
    renderAll();
    showToast('✓ Orden agregada');
  } catch (e) { showToast('Error: ' + e.message); }
}

// ── TikTok shipment linking ─────────────────────────────────
// A Shopify or manual order often travels inside a TikTok shipment's
// package. Linked Shipment records that, storing the TikTok order's
// TRACKING ID -- the same convention saveQC's finalize step already uses.
//
// "Active" = the customer has a TikTok order still in Pagado: imported
// with its shipping label but not yet shipped through QC. Same test the
// "Tiene Pedido de TikTok" badge uses.
const LINK_CANDIDATE_LIMIT = 5;

function getTikTokLinkCandidates(customerId) {
  if (!customerId) return { candidates: [], active: null };
  const all = allRecords
    .filter(r => r.CustomerId === customerId && r.Channel === 'TikTok' && r.TrackingId)
    .sort((a, b) => new Date(b['Fecha Creación'] || 0) - new Date(a['Fecha Creación'] || 0));
  return { candidates: all.slice(0, LINK_CANDIDATE_LIMIT), active: all.find(r => r.Status === 'Pagado') || null };
}

// idPrefix keeps ids unique when several pickers live in one modal (the
// bulk modal has one shared picker plus one per row).
function renderLinkPicker(idPrefix, customerId, compact) {
  const { candidates, active } = getTikTokLinkCandidates(customerId);
  if (!candidates.length) return '';
  const options = candidates.map(r =>
    `<option value="${escapeHtml(r.TrackingId)}"${active && r.ID === active.ID ? ' selected' : ''}>${escapeHtml(r.ID + ' — ' + formatDateTime(r['Fecha Creación']))}</option>`
  ).join('');
  return `<label class="link-picker${compact ? ' link-picker--compact' : ''}">
    <input type="checkbox" class="link-picker-check" id="${idPrefix}-check"${active ? ' checked' : ''} />
    <span class="link-picker-label">Enviar con TikTok</span>
    <select class="link-picker-select" id="${idPrefix}-select">${options}</select>
  </label>`;
}

function readLinkPicker(idPrefix) {
  const chk = document.getElementById(idPrefix + '-check');
  const sel = document.getElementById(idPrefix + '-select');
  if (!chk || !sel || !chk.checked) return '';
  return sel.value || '';
}

// Writes any combination of fields on one order. update_order_status only
// handles Status; linking needs Linked Shipment written in the SAME call
// so status and link can never half-apply.
async function performOrderUpdate(orderId, fields) {
  return apiPost({ action: 'update_order', order_id: orderId, fields: fields });
}

function showStatusModal(id, currentStatus) {
  const next = nextStatuses(currentStatus);
  if (!next.length) { showToast('Sin siguiente estado'); return; }
  const rec0 = allRecords.find(r => String(r.ID) === String(id));
  // A TikTok order IS the shipment -- it is never linked into another one.
  const linkHtml = (rec0 && rec0.Channel !== 'TikTok') ? renderLinkPicker('single-link', rec0.CustomerId, false) : '';
  const c = document.getElementById('modal-container');
  c.innerHTML = `<div class="modal-overlay" id="modal-overlay"><div class="modal"><div class="modal-title">Actualizar estado</div><div class="status-options">${next.map(s => `<button class="btn btn-block status-option-btn" data-status="${escapeHtml(s)}">${escapeHtml(s)}</button>`).join('')}</div>${linkHtml}<div class="modal-actions"><button class="btn" id="status-cancel-btn">Cancelar</button></div></div></div>`;
  c.querySelectorAll('.status-option-btn').forEach(btn => btn.addEventListener('click', () => {
    const link = readLinkPicker('single-link');
    updateOrderStatusNew(id, btn.dataset.status, link);
    closeModal();
  }));
  document.getElementById('status-cancel-btn').addEventListener('click', closeModal);
}

async function updateOrderStatusNew(id, status, linkTrackingId) {
  try {
    const rec = allRecords.find(r => r.ID === id);
    const fields = { Status: status };
    if (linkTrackingId) fields['Linked Shipment'] = linkTrackingId;
    const result = await performOrderUpdate(id, fields);
    if (result.result !== 'updated') throw new Error(result.error || 'Error');
    if (rec) {
      rec.Status = status;
      if (linkTrackingId) rec.LinkedShipment = linkTrackingId;
    }
    updateUndoRedoButtons(); // this change is now undoable -- refresh the button state
    renderAll();
    if (searchSelectedCliente) runSearch(searchSelectedCliente);
    showToast(linkTrackingId ? `✓ ${status} · vinculado` : `✓ Estado actualizado a ${status}`);
  } catch (e) { showToast('Error: ' + e.message); }
}

let bulkModalSelectedStatus = null;
let bulkCurrentOrders = [];

// Two ways to set a status here, deliberately: the pills at the top apply
// to every CHECKED row at once (the common case), while each row's own
// dropdown overrides that for just that row. "No cambiar" is the row
// default, so a row only moves if you explicitly ask it to or it's checked
// under a pill. Same shape for linking: one shared picker at the top, plus
// a per-row picker that wins when set.
function showBulkStatusModal(group) {
  bulkModalSelectedStatus = null;
  const cliente = group.name;
  const orders = group.items.filter(r => ['No Pagado', 'Pagado'].includes(r.Status));
  if (!orders.length) { showToast('Sin pedidos pendientes'); return; }
  bulkCurrentOrders = orders;
  const custId = (orders[0] && orders[0].CustomerId) || '';
  const statusOpts = ['No Pagado', 'Pagado', 'Enviado', 'Archivado'];

  const c = document.getElementById('modal-container');
  c.innerHTML = `<div class="modal-overlay" id="modal-overlay"><div class="modal bulk-status-modal">
    <div class="modal-title">Cambiar estado · ${escapeHtml(cliente)}</div>
    <div class="bulk-section-label">Aplicar a los seleccionados</div>
    <div class="status-pills">${['No Pagado', 'Pagado', 'Enviado'].map(s => `<button class="status-pill-toggle" data-status="${escapeHtml(s)}">${escapeHtml(s)}</button>`).join('')}</div>
    ${renderLinkPicker('bulk-link', custId, false)}
    <div class="bulk-section-label">Pedidos</div>
    <div class="bulk-order-list">${orders.map((r, i) => `<div class="bulk-order-item">
        <input type="checkbox" class="bulk-order-check" data-row="${i}" checked />
        <div class="bulk-order-main">
          <span class="bulk-order-product">${shopifyOrderLine(r)}</span>
          <span class="bulk-order-meta">${escapeHtml(formatDateTime(r['Fecha Creación']))}</span>
        </div>
        <span class="status-pill ${statusPillClass(r.Status)}">${escapeHtml(r.Status)}</span>
        <select class="bulk-row-status" data-row="${i}">
          <option value="">No cambiar</option>
          ${statusOpts.map(s => `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`).join('')}
        </select>
        ${r.Channel !== 'TikTok' ? renderLinkPicker('bulk-row-' + i + '-link', r.CustomerId, true) : ''}
      </div>`).join('')}</div>
    <div class="modal-actions"><button class="btn" id="bulk-status-cancel-btn">Cerrar</button><button class="btn btn-primary" id="bulk-status-confirm-btn" disabled>Confirmar</button></div>
  </div></div>`;

  document.getElementById('bulk-status-cancel-btn').addEventListener('click', closeModal);
  c.querySelectorAll('.status-pill-toggle').forEach(btn => btn.addEventListener('click', () => {
    // Clicking the active pill again clears it, so you can go back to
    // "per-row only" without closing the modal.
    bulkModalSelectedStatus = bulkModalSelectedStatus === btn.dataset.status ? null : btn.dataset.status;
    c.querySelectorAll('.status-pill-toggle').forEach(b => b.classList.toggle('active', b.dataset.status === bulkModalSelectedStatus));
    updateBulkConfirmState();
  }));
  c.querySelectorAll('.bulk-order-check, .bulk-row-status, .link-picker-check, .link-picker-select')
    .forEach(el => el.addEventListener('change', updateBulkConfirmState));
  document.getElementById('bulk-status-confirm-btn').addEventListener('click', applyBulkStatus);
  updateBulkConfirmState();
}

// Resolves what each row would actually do, so the Confirmar button and
// the save path can never disagree about it.
function bulkRowPlan() {
  const sharedLink = readLinkPicker('bulk-link');
  const plan = [];
  bulkCurrentOrders.forEach((r, i) => {
    const chk = document.querySelector(`.bulk-order-check[data-row="${i}"]`);
    const sel = document.querySelector(`.bulk-row-status[data-row="${i}"]`);
    const checked = chk ? chk.checked : false;
    const rowStatus = sel ? sel.value : '';
    const rowLink = readLinkPicker('bulk-row-' + i + '-link');

    const status = rowStatus || (checked && bulkModalSelectedStatus ? bulkModalSelectedStatus : '');
    const link = rowLink || (checked ? sharedLink : '');
    const statusChanges = status && status !== r.Status;
    const linkChanges = link && link !== r.LinkedShipment;
    if (!statusChanges && !linkChanges) return;
    plan.push({ id: String(r.ID), status: statusChanges ? status : '', link: linkChanges ? link : '' });
  });
  return plan;
}

function updateBulkConfirmState() {
  const btn = document.getElementById('bulk-status-confirm-btn');
  if (btn) btn.disabled = bulkRowPlan().length === 0;
}

async function applyBulkStatus() {
  const plan = bulkRowPlan();
  if (!plan.length) { showToast('Nada que cambiar'); return; }
  let done = 0;
  try {
    for (const p of plan) {
      const fields = {};
      if (p.status) fields.Status = p.status;
      if (p.link) fields['Linked Shipment'] = p.link;
      const result = await performOrderUpdate(p.id, fields);
      if (result.result !== 'updated') continue;
      const rec = allRecords.find(r => String(r.ID) === p.id);
      if (rec) {
        if (p.status) rec.Status = p.status;
        if (p.link) rec.LinkedShipment = p.link;
      }
      done++;
    }
    closeModal();
    updateUndoRedoButtons();
    renderAll();
    if (searchSelectedCliente) runSearch(searchSelectedCliente);
    showToast(`✓ ${done} pedido${done !== 1 ? 's' : ''} actualizado${done !== 1 ? 's' : ''}`);
  } catch (e) { showToast('Error: ' + e.message); }
}
function openCustomerHistory(customerId, displayName) {
  if (!customerId) { showToast('Cliente sin ID asociado'); return; }
  showCustomerHistoryModal(customerId, displayName);
}

async function showCustomerHistoryModal(customerId, displayName) {
  const c = document.getElementById('modal-container');
  c.innerHTML = `<div class="modal-overlay" id="modal-overlay"><div class="modal customer-history-modal"><div class="modal-title">Historial de ${escapeHtml(displayName || customersById[customerId] || customerId)}</div><div id="customer-history-list" class="customer-history-list"><div class="empty-state">Cargando...</div></div><div class="modal-actions"><button class="btn" id="history-close-btn">Cerrar</button></div></div></div>`;
  document.getElementById('history-close-btn').addEventListener('click', closeModal);
  try {
    const data = await apiGet('action=orders&customer_id=' + encodeURIComponent(customerId));
    const records = (data.records || []).map(mapFromApi).sort((a, b) => new Date(b['Fecha Creación'] || 0) - new Date(a['Fecha Creación'] || 0));
    const list = document.getElementById('customer-history-list');
    if (!list) return;
    if (!records.length) { list.innerHTML = '<div class="empty-state">Sin pedidos</div>'; return; }
    list.innerHTML = records.map(r => {
      const archiveInfo = r.ArchiveDate ? ` · Archivado: ${formatDate(r.ArchiveDate)}` : '';
      return `<div class="history-row"><div class="history-row-top"><span class="order-producto">${shopifyOrderLine(r)}</span><span class="order-precio">${formatMXN(r.Precio)}</span>${channelTag(r.Channel)}</div><div class="history-row-bottom"><span class="status-pill ${statusPillClass(r.Status)}">${escapeHtml(r.Status)}</span><span class="order-meta">${formatDate(r['Fecha Creación'])}${archiveInfo}</span></div></div>`;
    }).join('');
  } catch (e) {
    const list = document.getElementById('customer-history-list');
    if (list) list.innerHTML = '<div class="empty-state">Error al cargar historial</div>';
  }
}

// ── API CALLS ────────────────────────────────────────────────
async function apiPost(data) {
  const res = await fetch(API, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ ...data, token: API_TOKEN })
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const body = await res.json();
  // Apps Script answers HTTP 200 even for its own errors -- see the
  // matching fix in VP.post() (common.js).
  if (body && body.error) throw new Error(body.error);
  return body;
}

function apiGet(qs) {
  return fetch(`${API}?${qs}&token=${encodeURIComponent(API_TOKEN)}`)
    .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
    .then(body => {
      // Apps Script answers HTTP 200 even for its own errors -- see the
      // matching fix in VP.get() (common.js).
      if (body && body.error) throw new Error(body.error);
      return body;
    });
}

const CACHE_PREFIX = 'vp_cache_';

// Stale-while-revalidate: returns a cached response instantly (or null if
// none exists yet), while a real fetch runs in the background and calls
// onFresh(data) once it lands. Mirrors VP.getCached in common.js, kept
// local here since this page uses its own apiGet rather than VP.get.
function getCached(qs, onFresh) {
  const key = CACHE_PREFIX + qs;
  let cached = null;
  try {
    const raw = sessionStorage.getItem(key);
    if (raw) cached = JSON.parse(raw);
  } catch (e) { /* corrupt entry, ignore */ }

  apiGet(qs).then(fresh => {
    try { sessionStorage.setItem(key, JSON.stringify(fresh)); } catch (e) { /* storage full, non-fatal */ }
    if (onFresh) onFresh(fresh);
  }).catch(() => { /* background refresh failed silently */ });

  return cached;
}

function rebuildAllRecords() {
  allRecords = [...activeRecords, ...enviadoRecords, ...archivedRecords];
}

function applyActiveData(activeData, customersData, matchesData) {
  activeRecords = (activeData.records || []).map(mapFromApi);
  allCustomers = {};
  customersById = {};
  (customersData.records || []).forEach(c => {
    const primary = String(c['Primary Username'] || '').trim();
    const custId = String(c['Customer ID'] || '').trim();
    if (custId) customersById[custId] = primary;
    if (!primary) return;
    const aliases = c['Aliases'] ? String(c['Aliases']).split(',').map(a => a.trim()).filter(Boolean) : [];
    const entry = { name: primary, shipmentCount: parseInt(c['Shipment Count'], 10) || 0, aliases, customerId: custId };
    [primary, ...aliases].forEach(a => { if (a) allCustomers[a.toLowerCase()] = entry; });
  });
  pendingMatchesByShopifyOrderId = {};
  (matchesData.records || []).forEach(m => {
    pendingMatchesByShopifyOrderId[String(m['Shopify Order ID'])] = m;
  });
  rebuildAllRecords();
}

async function fetchActive() {
  let gotCache = false;
  let cachedActive = { records: [] }, cachedCustomers = { records: [] }, cachedMatches = { records: [] };

  const freshActive = getCached('action=orders&status=' + encodeURIComponent('No Pagado,Pagado'), fresh => {
    cachedActive = fresh;
    applyActiveData(cachedActive, cachedCustomers, cachedMatches);
    renderAll();
  });
  const freshCustomers = getCached('action=customers', fresh => {
    cachedCustomers = fresh;
    applyActiveData(cachedActive, cachedCustomers, cachedMatches);
    renderAll();
  });
  const freshMatches = getCached('action=shopify_matches', fresh => {
    cachedMatches = fresh;
    applyActiveData(cachedActive, cachedCustomers, cachedMatches);
    renderAll();
  });

  if (freshActive)    { cachedActive = freshActive; gotCache = true; }
  if (freshCustomers) { cachedCustomers = freshCustomers; gotCache = true; }
  if (freshMatches)   { cachedMatches = freshMatches; gotCache = true; }

  if (gotCache) {
    applyActiveData(cachedActive, cachedCustomers, cachedMatches);
    return;
  }

  const [activeData, customersData, matchesData] = await Promise.all([
    apiGet('action=orders&status=' + encodeURIComponent('No Pagado,Pagado')),
    apiGet('action=customers'),
    apiGet('action=shopify_matches')
  ]);
  applyActiveData(activeData, customersData, matchesData);
}

async function fetchEnviado() {
  const data = await apiGet('action=orders&status=Enviado');
  enviadoRecords = (data.records || []).map(mapFromApi);
  tabDataLoaded.enviado = true;
  rebuildAllRecords();
}

async function fetchArchivo() {
  const data = await apiGet('action=orders&status=Archivado');
  archivedRecords = (data.records || []).map(mapFromApi);
  tabDataLoaded.archivo = true;
  rebuildAllRecords();
}

// Shopify orders that could not be auto-linked to a customer wait as their
// own "Pending" rows and never show up in the normal order tabs via Status
// (they're already real orders, just missing a Customer ID) -- this pulls
// the SAME grouped-by-person view the Ajustes bulk tool uses, so the count
// here and the count in the nav badge and the count inside the tool itself
// can never drift apart; there is exactly one source of truth
// (action=shopify_matches_review) for "how many people are still pending".
// Kept deliberately separate from fetchActive/loadRecords: a failure here
// must never block or slow down loading the main order list.
async function fetchShopifyPending() {
  try {
    const data = await apiGet('action=shopify_matches_review');
    shopifyPendingGroupsList = data.groups || [];
  } catch (e) {
    /* silent: the tab/badge just keep showing their last known value */
  }
  renderShopifyPendingTab();
}

async function loadRecords() {
  const icon = document.getElementById('refresh-icon');
  icon.classList.add('spinning');
  try {
    await fetchActive();
    renderAll();
    if (searchSelectedCliente) runSearch(searchSelectedCliente);
  } catch (e) {
    console.error('loadRecords failed:', e);
    showToast('Error al cargar datos: ' + e.message);
  } finally {
    icon.classList.remove('spinning');
  }
}

async function manualRefresh() {
  const icon = document.getElementById('refresh-icon');
  icon.classList.add('spinning');
  try {
    tabDataLoaded.enviado = false;
    tabDataLoaded.archivo = false;
    enviadoRecords = [];
    archivedRecords = [];
    const fetches = [fetchActive()];
    if (currentTab === 'enviado') fetches.push(fetchEnviado());
    else if (currentTab === 'archivo') fetches.push(fetchArchivo());
    await Promise.all(fetches);
    renderAll();
    if (searchSelectedCliente) runSearch(searchSelectedCliente);
  } catch (e) {
    showToast('Error al cargar datos');
  } finally {
    icon.classList.remove('spinning');
  }
}

async function autoRefresh() {
  try {
    if (currentTab === 'enviado' && tabDataLoaded.enviado) await fetchEnviado();
    else if (currentTab === 'archivo' && tabDataLoaded.archivo) await fetchArchivo();
    else if (currentTab !== 'enviado' && currentTab !== 'archivo') await fetchActive();
    renderAll();
    if (searchSelectedCliente) runSearch(searchSelectedCliente);
  } catch (e) { /* silent */ }
}

async function loadEnviadoTab() {
  const el = document.getElementById('enviado-list');
  if (el) el.innerHTML = '<div class="empty-state">Cargando enviados...</div>';
  try {
    await fetchEnviado();
    renderAll();
    if (searchSelectedCliente) runSearch(searchSelectedCliente);
  } catch (e) {
    if (el) el.innerHTML = '<div class="empty-state">Error al cargar. <a href="#" onclick="loadEnviadoTab();return false">Reintentar</a></div>';
    showToast('Error al cargar pedidos enviados');
  }
}

async function loadArchivoTab() {
  const el = document.getElementById('archivo-list');
  if (el) el.innerHTML = '<div class="empty-state">Cargando archivo...</div>';
  try {
    await fetchArchivo();
    renderAll();
    if (searchSelectedCliente) runSearch(searchSelectedCliente);
  } catch (e) {
    if (el) el.innerHTML = '<div class="empty-state">Error al cargar. <a href="#" onclick="loadArchivoTab();return false">Reintentar</a></div>';
    showToast('Error al cargar archivo');
  }
}

// ── QC History tab ──────────────────────────────────────────────────

let allQCRows = [];
let qcHistoryVisibleCount = 50;
const QC_HISTORY_PAGE_SIZE = 50;

async function loadQCTab() {
  const list = document.getElementById('qc-history-list');
  if (list) list.innerHTML = '<div class="empty-state">Cargando historial de control de calidad...</div>';
  try {
    const [qcData, sessionsData] = await Promise.all([
      apiGet('action=qc'),
      apiGet('action=sessions'),
    ]);
    allQCRows = (qcData.records || []).filter(r => r['Status'] === 'Enviado');
    // Most recent first
    allQCRows.sort((a, b) => String(b['Timestamp'] || '').localeCompare(String(a['Timestamp'] || '')));

    const sessionSelect = document.getElementById('qc-session-filter');
    const sessions = (sessionsData.records || [])
      .filter(s => s['Status'] === 'Finalizada')
      .sort((a, b) => String(b['Start Time'] || '').localeCompare(String(a['Start Time'] || '')));
    sessionSelect.innerHTML = '<option value="">Todas las sesiones</option>' +
      sessions.map(s => `<option value="${escapeHtml(s['Session ID'])}">${escapeHtml(s['Session ID'])} (${escapeHtml(String(s['Total Packages'] || 0))} paq.)</option>`).join('');

    tabDataLoaded.qc = true;
    qcHistoryVisibleCount = QC_HISTORY_PAGE_SIZE;
    renderQCHistory();
  } catch (e) {
    if (list) list.innerHTML = '<div class="empty-state">Error al cargar. <a href="#" onclick="loadQCTab();return false">Reintentar</a></div>';
    showToast('Error al cargar el historial de control de calidad');
  }
}

function renderQCHistory() {
  const list = document.getElementById('qc-history-list');
  const loadMoreBtn = document.getElementById('qc-load-more-btn');
  if (!list) return;

  const query = (document.getElementById('qc-search-input').value || '').trim().toLowerCase();
  const sessionFilter = document.getElementById('qc-session-filter').value;

  let rows = allQCRows;
  if (sessionFilter) rows = rows.filter(r => r['Session ID'] === sessionFilter);
  if (query) {
    rows = rows.filter(r =>
      String(r['Primary Username'] || '').toLowerCase().includes(query) ||
      String(r['Tracking ID'] || '').toLowerCase().includes(query)
    );
  }

  if (rows.length === 0) {
    list.innerHTML = `<div class="empty-state">${query || sessionFilter ? 'Sin resultados' : 'Sin envíos registrados todavía'}</div>`;
    loadMoreBtn.style.display = 'none';
    return;
  }

  const visible = rows.slice(0, qcHistoryVisibleCount);
  list.innerHTML = visible.map(row => {
    const photoCols = ['Content1','Content2','Content3','Content4','Content5','Box1','Box2','Box3','Box4','Box5'];
    const photos = photoCols.map(c => row[c]).filter(Boolean);
    const orderIdCols = ['TikTok Order IDs', 'Shopify Order IDs', 'Manual Order IDs'];
    const orderCount = orderIdCols.reduce((sum, c) => sum + String(row[c] || '').split(' + ').filter(Boolean).length, 0);
    const when = formatQCTimestamp(row['Timestamp']);

    return `
      <div class="qc-history-card">
        <div class="qc-history-thumbs">
          ${photos.slice(0, 4).map(url => `<img src="${url}" loading="lazy" onclick="openQCLightbox('${url.replace(/'/g, "\\'")}')">`).join('')}
          ${photos.length > 4 ? `<div class="qc-history-more">+${photos.length - 4}</div>` : ''}
          ${photos.length === 0 ? '<div class="qc-history-nophoto">Sin fotos</div>' : ''}
        </div>
        <div class="qc-history-info">
          <div class="qc-history-username">${escapeHtml(row['Primary Username'] || '—')}</div>
          <div class="qc-history-meta">${escapeHtml(row['Tracking ID'] || '')} · ${orderCount} pedido${orderCount !== 1 ? 's' : ''} · ${escapeHtml(row['Packer'] || '—')}</div>
          <div class="qc-history-meta" style="color:var(--text-faint)">${when} ${row['Session ID'] ? '· ' + escapeHtml(row['Session ID']) : ''}</div>
        </div>
      </div>`;
  }).join('');

  loadMoreBtn.style.display = rows.length > qcHistoryVisibleCount ? 'inline-block' : 'none';
}

function loadMoreQCHistory() {
  qcHistoryVisibleCount += QC_HISTORY_PAGE_SIZE;
  renderQCHistory();
}

function formatQCTimestamp(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleString('es-MX', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function openQCLightbox(url) {
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.9);z-index:900;display:flex;align-items:center;justify-content:center;padding:20px;cursor:pointer';
  overlay.innerHTML = `<img src="${url}" style="max-width:100%;max-height:100%;object-fit:contain;border-radius:8px">`;
  const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  overlay.onclick = close;
  document.addEventListener('keydown', onKey);
  document.body.appendChild(overlay);
}

async function updateStatus(id, status) {
  try {
    const rec = allRecords.find(r => r.ID === id);
    const fromStatus = rec ? rec.Status : null;
    const result = await performStatusUpdate(id, status);
    if (result.result !== 'updated') throw new Error(result.error || 'Error');
    if (rec) rec.Status = status;
    updateUndoRedoButtons(); // this change is now undoable -- refresh the button state
    renderAll();
    if (searchSelectedCliente) runSearch(searchSelectedCliente);
    const msgs = { 'Pagado': '✓ Marcado como pagado', 'Enviado': '✓ Marcado como enviado', 'No Pagado': '↩ Revertido a No Pagado' };
    showToast(msgs[status] || '✓ Actualizado');
  } catch (e) { showToast('Error: ' + e.message); }
}

function requestUndo(id, currentStatus) { const p = previousStatus(currentStatus); if (!p) return; showConfirmModal(`¿Revertir a <strong>${p}</strong>?`, () => updateStatus(id, p)); }

function requestRenameCliente(group) {
  const oldName = group.name;
  const targets = group.items;
  const c = document.getElementById('modal-container');
  c.innerHTML = `<div class="modal-overlay" id="modal-overlay"><div class="modal"><div class="modal-title">Cambiar nombre de cliente</div><div class="edit-form" style="position:relative"><input type="text" id="rename-cliente" value="${oldName.replace(/"/g, '&quot;')}" placeholder="Nuevo nombre" autocomplete="off" /><div class="autocomplete-list" id="rename-autocomplete-list" style="display:none"></div></div><div class="modal-actions"><button class="btn" id="rename-cancel-btn">Cancelar</button><button class="btn btn-primary" id="rename-save-btn">Guardar</button></div></div></div>`;
  const input = document.getElementById('rename-cliente');
  const list = document.getElementById('rename-autocomplete-list');
  input.addEventListener('input', () => {
    const val = input.value.trim().toLowerCase();
    if (!val) { list.style.display = 'none'; return; }
    const clientes = getUniqueClientes().filter(cl => cl.name.toLowerCase().startsWith(val) && cl.name !== oldName).slice(0, 8);
    if (!clientes.length) { list.style.display = 'none'; return; }
    list.innerHTML = '';
    clientes.forEach(cl => {
      const item = document.createElement('div');
      item.className = 'autocomplete-item';
      item.innerHTML = `<span>${cl.name}</span>`;
      item.addEventListener('mousedown', e => { e.preventDefault(); input.value = cl.name; list.style.display = 'none'; });
      list.appendChild(item);
    });
    list.style.display = 'block';
  });
  input.addEventListener('blur', () => { setTimeout(() => { list.style.display = 'none'; }, 150); });
  document.getElementById('rename-cancel-btn').addEventListener('click', closeModal);
  document.getElementById('rename-save-btn').addEventListener('click', async () => {
    const newName = input.value.trim();
    if (!newName) { showToast('Falta el nombre'); return; }
    if (newName === oldName) { closeModal(); return; }
    closeModal();
    try {
      for (const r of targets) {
        const result = await apiPost({ action: 'update_order', order_id: r.ID, fields: mapToApiFields({ Cliente: newName }) });
        if (result.result !== 'updated') throw new Error(result.error || 'Error');
        r.Cliente = newName;
      }
      renderAll();
      if (searchSelectedCliente) runSearch(searchSelectedCliente);
      showToast(`✓ ${targets.length} pedidos actualizados a "${newName}"`);
    } catch (e) { showToast('Error: ' + e.message); }
  });
}

function requestDelete(id, producto) {
  const label = /^https?:\/\/admin\.shopify\.com\//.test(producto || '') ? 'este pedido de Shopify' : producto;
  showConfirmModal(`¿Eliminar <strong>${label}</strong>? Esta acción no se puede deshacer.`, async () => {
    try {
      const result = await apiPost({ action: 'delete_order', order_id: id });
      if (result.result !== 'deleted') throw new Error(result.error || 'Error');
      activeRecords = activeRecords.filter(r => r.ID !== id);
      enviadoRecords = enviadoRecords.filter(r => r.ID !== id);
      archivedRecords = archivedRecords.filter(r => r.ID !== id);
      rebuildAllRecords();
      renderAll();
      if (searchSelectedCliente) runSearch(searchSelectedCliente);
      showToast('✓ Pedido eliminado');
    } catch (e) { showToast('Error: ' + e.message); }
  });
}

async function saveEdit(id) {
  const cliente = document.getElementById('edit-cliente').value.trim();
  const producto = document.getElementById('edit-producto').value.trim();
  const precio = parseFloat(document.getElementById('edit-precio').value) || 0;
  const status = document.getElementById('edit-status').value;
  const notas = document.getElementById('edit-notas').value.trim();
  if (!cliente || !producto) { showToast('Faltan datos'); return; }
  try {
    const result = await apiPost({ action: 'update_order', order_id: id, fields: mapToApiFields({ Cliente: cliente, Producto: producto, Precio: precio, Status: status, Notas: notas }) });
    if (result.result !== 'updated') throw new Error(result.error || 'Error');
    const rec = allRecords.find(r => r.ID === id);
    if (rec) { rec.Cliente = cliente; rec.Producto = producto; rec.Precio = precio; rec.Status = status; rec.Notas = notas; }
    closeModal();
    renderAll();
    if (searchSelectedCliente) runSearch(searchSelectedCliente);
    showToast('✓ Pedido actualizado');
  } catch (e) { showToast('Error: ' + e.message); }
}

async function createRecord() {
  const cliente = document.getElementById('new-cliente').value.trim();
  const channel = document.getElementById('new-channel').value;
  const status = document.getElementById('new-status').value;
  const isGift = document.getElementById('gift-checkbox').checked;
  const recipient = isGift ? (document.getElementById('gift-recipient').value || '').trim() : '';

  if (!cliente) { showToast('Falta el usuario'); return; }
  if (isGift && !recipient) { showToast('Falta el destinatario'); return; }

  saveBulkState();
  const items = bulkItems.filter(item => item.producto.trim());
  if (!items.length) { showToast('Falta al menos un producto'); return; }

  try {
    for (const item of items) {
      if (isGift) {
        // Order for the buyer — NO MANDAR prefix, price 0, status Pagado
        const buyerProduct = 'NO MANDAR - ' + item.producto;
        const buyerResult = await apiPost({
          action: 'create_order',
          username: cliente,
          channel: 'Manual',
          products: buyerProduct,
          price: 0,
          notes: item.notas || '',
          shopify_order_id: '',
          status: 'Pagado'
        });
        if (buyerResult.result === 'created') {
          activeRecords.push({
            ID: buyerResult.order_id,
            Cliente: cliente,
            Channel: 'Manual',
            Producto: buyerProduct,
            Precio: 0,
            Notas: item.notas || '',
            Status: 'Pagado',
            CustomerId: buyerResult.customer_id || '',
            'Fecha Creación': new Date().toISOString()
          });
          rebuildAllRecords();
        }

        // Order for the recipient — REGALO DE prefix, price 0, status Pagado
        const recipientProduct = 'REGALO DE ' + cliente + ' - ' + item.producto;
        const recipientResult = await apiPost({
          action: 'create_order',
          username: recipient,
          channel: 'Manual',
          products: recipientProduct,
          price: 0,
          notes: item.notas || '',
          shopify_order_id: '',
          status: 'Pagado'
        });
        if (recipientResult.result === 'created') {
          activeRecords.push({
            ID: recipientResult.order_id,
            Cliente: recipient,
            Channel: 'Manual',
            Producto: recipientProduct,
            Precio: 0,
            Notas: item.notas || '',
            Status: 'Pagado',
            CustomerId: recipientResult.customer_id || '',
            'Fecha Creación': new Date().toISOString()
          });
          rebuildAllRecords();
        }

      } else {
        // Normal order
        const result = await apiPost({
          action: 'create_order',
          username: cliente,
          channel,
          products: item.producto,
          price: parseFloat(item.precio) || 0,
          notes: item.notas || '',
          shopify_order_id: '',
          status
        });
        if (result.result === 'created') {
          activeRecords.push({
            ID: result.order_id,
            Cliente: cliente,
            Channel: channel,
            Producto: item.producto,
            Precio: parseFloat(item.precio) || 0,
            Notas: item.notas || '',
            Status: result.status || 'No Pagado',
            CustomerId: result.customer_id || '',
            'Fecha Creación': new Date().toISOString()
          });
          rebuildAllRecords();
        }
      }
    }

    // Reset form
    document.getElementById('new-cliente').value = '';
    document.getElementById('new-channel').value = 'Manual';
    document.getElementById('new-status').value = 'No Pagado';
    document.getElementById('gift-checkbox').checked = false;
    document.getElementById('gift-recipient').value = '';
    document.getElementById('gift-recipient-section').style.display = 'none';
    bulkItems = [{ producto: '', precio: '', notas: '' }];
    renderBulkItems();
    renderAll();
    showToast(isGift ? '✓ Regalo registrado (2 entradas)' : `✓ ${items.length} pedido${items.length > 1 ? 's' : ''} agregado${items.length > 1 ? 's' : ''}`);
  } catch (e) { showToast('Error: ' + e.message); }
}

// ── SORTING ──────────────────────────────────────────────────
function sortRecords(records) {
  if (currentSort === 'az') return [...records].sort((a, b) => (a.Cliente || '').localeCompare(b.Cliente || ''));
  if (currentSort === 'za') return [...records].sort((a, b) => (b.Cliente || '').localeCompare(a.Cliente || ''));
  if (currentSort === 'most' || currentSort === 'least') {
    const totals = {};
    allRecords.forEach(r => { const c = r.Cliente || ''; totals[c] = (totals[c] || 0) + (r.Precio || 0); });
    return [...records].sort((a, b) => currentSort === 'most' ? (totals[b.Cliente] || 0) - (totals[a.Cliente] || 0) : (totals[a.Cliente] || 0) - (totals[b.Cliente] || 0));
  }
  if (currentSort === 'newest') return [...records].sort((a, b) => new Date(b['Fecha Creación'] || 0) - new Date(a['Fecha Creación'] || 0));
  if (currentSort === 'oldest') return [...records].sort((a, b) => new Date(a['Fecha Creación'] || 0) - new Date(b['Fecha Creación'] || 0));
  if (currentSort === 'tiktok-ready') {
    const hasTikTok = r => r.CustomerId && allRecords.some(x => x.CustomerId === r.CustomerId && x.Channel === 'TikTok' && x.Status === 'Pagado');
    return [...records].sort((a, b) => {
      const ta = hasTikTok(a) ? 0 : 1;
      const tb = hasTikTok(b) ? 0 : 1;
      if (ta !== tb) return ta - tb;
      return (a.Cliente || '').localeCompare(b.Cliente || '', 'es');
    });
  }
  return records;
}

function setSort(val) { currentSort = val; renderAll(); if (searchSelectedCliente) runSearch(searchSelectedCliente); }

// ── RENDERING ────────────────────────────────────────────────
function renderOrderRow(r, showActions) {
  const status = r.Status || 'No Pagado';
  const created = r['Fecha Creación'];
  const days = daysSince(created);
  const isOverdueUnpaid = status === 'No Pagado' && days >= 3;
  const isOverduePaid = status === 'Pagado' && days >= 7;

  let rowClass = 'order-row';
  if (isOverdueUnpaid) rowClass += ' overdue-unpaid';
  else if (isOverduePaid) rowClass += ' overdue-paid';
  if (isShipped(status)) rowClass += ' shipped-row';

  let pillClass = statusPillClass(status), pillText = status === 'No Pagado' ? `No Pagado${isOverdueUnpaid ? ' ⚠' : ''}` : status === 'Pagado' ? `Pagado${isOverduePaid ? ' ⚠' : ''}` : status;

  const metaParts = [formatDateTime(created), days === 0 ? 'hoy' : `hace ${days}d`].filter(Boolean);
  const notasHtml = renderNotas(r.Notas);
  const id = r.ID;

  const row = document.createElement('div');
  row.className = rowClass;

  const info = document.createElement('div');
  // The username used to repeat on every row even though the group header
  // directly above already shows it once. Only the channel tag stays here;
  // opening the customer's history moved onto that header name.
  info.innerHTML = `<div class="order-userline">${channelTag(r.Channel)}</div><div class="order-producto">${shopifyOrderLine(r)}</div><div class="order-meta">${metaParts.join(' · ')}${notasHtml ? ' · ' + notasHtml : ''}</div>`;

  const hoverZone = document.createElement('div');
  hoverZone.className = 'row-hover-zone';

  const editBtn = document.createElement('button');
  editBtn.className = 'btn btn-xs btn-edit'; editBtn.textContent = 'Editar';
  editBtn.addEventListener('click', () => showEditModal(id));
  hoverZone.appendChild(editBtn);

  const delBtn = document.createElement('button');
  delBtn.className = 'btn btn-xs btn-danger'; delBtn.textContent = 'Eliminar';
  delBtn.addEventListener('click', () => requestDelete(id, r.Producto || 'este pedido'));
  hoverZone.appendChild(delBtn);

  const prev = previousStatus(status);
  if (prev && showActions) {
    const undoBtn = document.createElement('button');
    undoBtn.className = 'btn btn-xs btn-undo'; undoBtn.textContent = '↩'; undoBtn.title = `Revertir a ${prev}`;
    undoBtn.addEventListener('click', () => requestUndo(id, status));
    hoverZone.appendChild(undoBtn);
  }

  const precio = document.createElement('div');
  precio.className = 'order-precio'; precio.textContent = formatMXN(r.Precio);

  const pill = document.createElement('span');
  pill.className = `status-pill ${pillClass}`; pill.textContent = pillText;

  const actionCell = document.createElement('div');
  actionCell.className = 'order-actions';
  if (showActions && nextStatuses(status).length) {
    const btn = document.createElement('button'); btn.className = 'btn btn-sm btn-enviado'; btn.textContent = 'Estado ▾';
    btn.addEventListener('click', () => showStatusModal(id, status));
    actionCell.appendChild(btn);
  }

  row.appendChild(info); row.appendChild(hoverZone); row.appendChild(precio); row.appendChild(pill); row.appendChild(actionCell);
  row.addEventListener('mouseenter', () => hoverZone.classList.add('visible'));
  row.addEventListener('mouseleave', () => hoverZone.classList.remove('visible'));
  return row;
}

// Grouping key: Customer ID when present, otherwise fall back to the
// username (for orders whose customer hasn't been resolved yet).
function customerGroupKey(r) {
  const cid = (r.CustomerId || '').trim();
  if (cid) return 'cid:' + cid.toLowerCase();
  // No Customer ID at all -- this order is genuinely unresolved. Give it its
  // OWN unique group (keyed by Order ID), instead of collapsing every
  // unresolved order into one shared "Sin nombre" bucket. This is what lets
  // each pending order be renamed/reviewed independently.
  return 'pending:' + (r.ID || '').trim();
}

// Returns an ordered array of { key, name, items }. Orders are grouped by
// Customer ID so aliases of the same customer collapse into one group; the
// representative Primary Username is kept as the display label.
let pendingMergeCounter = 0; // resets each render pass, gives stable-per-render numbering

function groupByCliente(records) {
  const groups = {}, order = [];
  pendingMergeCounter = 0;
  sortRecords(records).forEach(r => {
    const key = customerGroupKey(r);
    if (!groups[key]) {
      let name;
      if (r.CustomerId) {
        name = (customersById[r.CustomerId] || r.Cliente || 'Sin nombre').replace(/^@/, '');
      } else {
        pendingMergeCounter++;
        name = pendingMergeCounter === 1 ? 'Pendiente de fusión' : `Pendiente de fusión ${pendingMergeCounter}`;
      }
      groups[key] = { key, name, items: [], pendingMatch: pendingMatchesByShopifyOrderId[r.ShopifyOrderId] || null };
      order.push(key);
    }
    groups[key].items.push(r);
  });
  return order.map(k => groups[k]);
}

function renderGrouped(records, containerId, showActions) {
  const el = document.getElementById(containerId);
  el.innerHTML = '';
  if (!records.length) { el.innerHTML = '<div class="empty-state">Sin pedidos aquí</div>'; return; }
  groupByCliente(records).forEach(grp => {
    const cliente = grp.name;
    const items = grp.items;
    const unpaid = items.filter(r => r.Status === 'No Pagado').reduce((s, r) => s + (r.Precio || 0), 0);

    const group = document.createElement('div'); group.className = 'customer-group';
    const header = document.createElement('div'); header.className = 'customer-header' + (isUnnamedCliente(cliente) ? ' customer-header--unnamed' : '');
    const custData = allCustomers[(cliente || '').toLowerCase()];
    const shipBadge = custData && custData.shipmentCount > 0 ? ` <span class="shipment-count">(${custData.shipmentCount})</span>` : '';
    const custId = (items[0] && items[0].CustomerId) || '';
    const hasPendingTikTok = allRecords.some(r =>
      r.CustomerId && r.CustomerId === custId &&
      r.Channel === 'TikTok' &&
      r.Status === 'Pagado'
    );
    const tikTokIndicator = hasPendingTikTok
    ? `<span style="display:inline-flex;align-items:center;background:var(--green-bg);color:var(--green-text);border:1px solid var(--green-border);border-radius:99px;padding:1px 8px;font-size:10px;font-weight:600;margin-left:6px;letter-spacing:0.2px">Tiene Pedido de TikTok</span>`
    : '';
    header.setAttribute('data-tiktok-ready', hasPendingTikTok);
    group.setAttribute('data-tiktok-ready', hasPendingTikTok);
        // Careful: only show the suggested-customer hint for orders that are
    // genuinely still pending review -- never for orders already grouped
    // under a confirmed Customer ID, to avoid implying uncertainty about a
    // match that's already settled.
    const suggestionHtml = grp.pendingMatch
      ? `<div class="pending-match-hint">Posible cliente: <strong>${escapeHtml(grp.pendingMatch['Suggested Customer Name'] || '—')}</strong> (${grp.pendingMatch['Match Score']}%)</div>`
      : '';

    header.innerHTML = `<div class="customer-avatar">${getInitials(cliente)}</div><div class="customer-name customer-name--clickable">${cliente}${shipBadge}${tikTokIndicator}</div><span class="customer-owed">${unpaid > 0 ? '· Por cobrar: ' + formatMXN(unpaid) : ''}</span><div class="customer-bulk-actions"></div>`;
    const headerNameEl = header.querySelector('.customer-name');
    if (headerNameEl && custId) headerNameEl.addEventListener('click', () => openCustomerHistory(custId, cliente));

    if (suggestionHtml) {
      const hintEl = document.createElement('div');
      hintEl.innerHTML = suggestionHtml;
      header.appendChild(hintEl.firstChild);
    }

    const bulk = header.querySelector('.customer-bulk-actions');
    const renameBtn = document.createElement('button');
    renameBtn.className = 'btn btn-xs btn-edit'; renameBtn.textContent = '✎'; renameBtn.title = 'Cambiar nombre';
    renameBtn.addEventListener('click', () => requestRenameCliente(grp));
    bulk.appendChild(renameBtn);
    const addBtn = document.createElement('button');
    addBtn.className = 'btn btn-xs btn-add-quick';
    addBtn.textContent = '+'; addBtn.title = 'Agregar pedido';
    addBtn.addEventListener('click', () => showNewOrderModal(cliente));
    bulk.appendChild(addBtn);
    if (grp.pendingMatch) {
      const mergeBtn = document.createElement('button');
      mergeBtn.className = 'btn btn-xs btn-enviado'; mergeBtn.textContent = 'Revisar cliente';
      mergeBtn.title = 'Confirmar o corregir a qué cliente pertenece este pedido';
      mergeBtn.addEventListener('click', () => showMergeReviewModal(grp.pendingMatch));
      bulk.appendChild(mergeBtn);
    }
    if (showActions) {
      const btn = document.createElement('button'); btn.className = 'btn btn-sm btn-enviado'; btn.textContent = 'Cambiar estado';
      btn.addEventListener('click', () => showBulkStatusModal(grp));
      bulk.appendChild(btn);
    }
    group.appendChild(header);
    items.forEach(r => group.appendChild(renderOrderRow(r, showActions)));
    el.appendChild(group);
  });
}

function renderAnalytics() {
  if (!document.getElementById('an-shipped-revenue')) return;  // moved to analytics.html
  const shipped = allRecords.filter(r => isShipped(r.Status));
  const paid = allRecords.filter(r => r.Status === 'Pagado');
  const unpaid = allRecords.filter(r => r.Status === 'No Pagado');
  const shippedRev = shipped.reduce((s, r) => s + (r.Precio || 0), 0);
  const paidRev = paid.reduce((s, r) => s + (r.Precio || 0), 0);
  const unpaidRev = unpaid.reduce((s, r) => s + (r.Precio || 0), 0);
  const now = new Date();
  const startWeek = new Date(now); startWeek.setDate(now.getDate() - now.getDay());
  const startMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const thisWeek = allRecords.filter(r => new Date(r['Fecha Creación']) >= startWeek);
  const thisMonth = allRecords.filter(r => new Date(r['Fecha Creación']) >= startMonth);

  document.getElementById('an-shipped-revenue').textContent = formatMXN(shippedRev);
  document.getElementById('an-shipped-count').textContent = `${shipped.length} pedidos enviados`;
  document.getElementById('an-received-revenue').textContent = formatMXN(shippedRev + paidRev);
  document.getElementById('an-pending-ship').textContent = `De los cuales ${formatMXN(paidRev)} aún sin enviar`;
  document.getElementById('an-month-revenue').textContent = formatMXN(thisMonth.reduce((s, r) => s + (r.Precio || 0), 0));
  document.getElementById('an-month-count').textContent = `${thisMonth.length} pedidos creados`;
  document.getElementById('an-week-revenue').textContent = formatMXN(thisWeek.reduce((s, r) => s + (r.Precio || 0), 0));
  document.getElementById('an-week-count').textContent = `${thisWeek.length} pedidos creados`;
  document.getElementById('an-breakdown-unpaid').textContent = formatMXN(unpaidRev);
  document.getElementById('an-breakdown-paid').textContent = formatMXN(paidRev);
  document.getElementById('an-breakdown-total').textContent = formatMXN(unpaidRev + paidRev);

  const totals = {};
  allRecords.forEach(r => {
    const c = r.Cliente || 'Sin nombre';
    if (!totals[c]) totals[c] = { total: 0, count: 0 };
    totals[c].total += r.Precio || 0;
    totals[c].count++;
  });
  document.getElementById('an-top-clients').innerHTML = Object.entries(totals)
    .sort((a, b) => b[1].total - a[1].total).slice(0, 8)
    .map(([name, d]) => `<div class="top-client-row"><span class="top-client-name">${name}</span><span class="top-client-val">${d.count} pedido${d.count !== 1 ? 's' : ''}</span><span class="top-client-amount">${formatMXN(d.total)}</span></div>`).join('');
}

function renderClientList() {
  const el = document.getElementById('client-list-scroll');
  if (!el) return;
  const active = allRecords.filter(r => ['No Pagado', 'Pagado'].includes(r.Status));
  const seen = {};
  active.forEach(r => {
    const c = r.Cliente || 'Sin nombre';
    const k = c.toLowerCase();
    if (!seen[k]) seen[k] = { name: c, count: 0 };
    seen[k].count++;
  });
  const sorted = Object.values(seen).sort((a, b) => a.name.localeCompare(b.name, 'es'));
  el.innerHTML = '';
  if (!sorted.length) {
    el.innerHTML = '<div style="font-size:12px;color:var(--text-faint);padding:4px">Sin clientes activos</div>';
    return;
  }
  sorted.forEach(c => {
    const item = document.createElement('div');
    item.className = 'client-list-item';
    item.innerHTML = `
      <div class="client-list-avatar">${getInitials(c.name)}</div>
      <span class="client-list-name">${escapeHtml(c.name)}</span>
      <span class="client-list-count">${c.count}</span>`;
    item.addEventListener('click', () => selectSearchCliente(c.name));
    el.appendChild(item);
  });
}

function renderAll() {
  const activos = allRecords.filter(r => ['No Pagado', 'Pagado'].includes(r.Status) && (!HIDE_TIKTOK_FROM_MAIN_TABS || r.Channel !== 'TikTok'));
  const cobrar = allRecords.filter(r => r.Status === 'No Pagado' && (!HIDE_TIKTOK_FROM_MAIN_TABS || r.Channel !== 'TikTok'));
  const enviar = allRecords.filter(r => r.Status === 'Pagado' && (!HIDE_TIKTOK_FROM_MAIN_TABS || r.Channel !== 'TikTok'));
  const enviado = allRecords.filter(r => r.Status === 'Enviado');
  const archivo = allRecords.filter(r => r.Status === 'Archivado');

  document.getElementById('badge-activos').textContent = activos.length;
  document.getElementById('badge-cobrar').textContent = cobrar.length;
  document.getElementById('badge-enviar').textContent = enviar.length;
  document.getElementById('badge-enviado').textContent = tabDataLoaded.enviado ? enviado.length : '';
  document.getElementById('badge-archivo').textContent = tabDataLoaded.archivo ? archivo.length : '';

  const unpaidTotal = cobrar.reduce((s, r) => s + (r.Precio || 0), 0);
  const paidTotal = enviar.reduce((s, r) => s + (r.Precio || 0), 0);
  const alerts = cobrar.filter(r => daysSince(r['Fecha Creación']) >= 3).length + enviar.filter(r => daysSince(r['Fecha Creación']) >= 7).length;

  document.getElementById('stat-unpaid-amount').textContent = formatMXN(unpaidTotal);
  document.getElementById('stat-unpaid-count').textContent = `${cobrar.length} item${cobrar.length !== 1 ? 's' : ''}`;
  document.getElementById('stat-paid-pending').textContent = formatMXN(paidTotal);
  document.getElementById('stat-paid-count').textContent = `${enviar.length} item${enviar.length !== 1 ? 's' : ''}`;
  document.getElementById('stat-alerts').textContent = alerts;
  document.getElementById('stat-total').textContent = formatMXN(unpaidTotal + paidTotal);

  ['cobrar', 'enviar'].forEach(tab => {
    document.getElementById(`badge-${tab}`).classList.toggle('has-items', parseInt(document.getElementById(`badge-${tab}`).textContent) > 0);
  });

  renderGrouped(activos, 'activos-list', true);
  renderGrouped(cobrar, 'cobrar-list', true);
  renderGrouped(enviar, 'enviar-list', true);
  renderGrouped(enviado, 'enviado-list', true);
  renderGrouped(archivo, 'archivo-list', false);
  renderAnalytics();
  renderClientList();
  renderTikTokTab();
}

function renderTikTokTab() {
  const tikTokOrders = allRecords.filter(r => r.Channel === 'TikTok' && r.Status === 'Pagado');

  // Update badge
  document.getElementById('badge-tiktok').textContent = tikTokOrders.length;

  const container = document.getElementById('tiktok-list');
  if (!container) return;

  if (tikTokOrders.length === 0) {
    container.innerHTML = '<div style="color:var(--text-faint);font-size:13px;padding:1rem 0">Sin órdenes TikTok pendientes</div>';
    return;
  }

  // Group by import date (Created Date, first 10 chars = YYYY-MM-DD)
  const groups = {};
  tikTokOrders.forEach(r => {
    const day = (r['Fecha Creación'] || '').slice(0, 10) || 'Sin fecha';
    if (!groups[day]) groups[day] = [];
    groups[day].push(r);
  });

  // Sort groups newest first
  const sortedDays = Object.keys(groups).sort((a, b) => b.localeCompare(a));

  container.innerHTML = sortedDays.map(day => {
    const orders = groups[day];
    const rows = orders.map(r => {
      const username = escapeHtml(r.Cliente || '—');
      const products = escapeHtml(r.Producto || '—');
      const price    = r.Precio ? `$${Number(r.Precio).toFixed(2)}` : '—';
      const tracking = escapeHtml(r['Tracking ID'] || '');
      return `
        <div style="display:flex;align-items:center;justify-content:space-between;padding:10px 12px;border-bottom:0.5px solid var(--border);gap:12px">
          <div style="min-width:0">
            <div style="font-weight:600;font-size:13px;margin-bottom:2px">@${username}</div>
            <div style="font-size:12px;color:var(--text-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${products}</div>
            ${tracking ? `<div style="font-size:11px;color:var(--text-faint);margin-top:2px">${tracking}</div>` : ''}
          </div>
          <div style="font-size:13px;font-weight:600;white-space:nowrap">${price}</div>
        </div>`;
    }).join('');

    return `
      <div style="background:var(--surface);border:0.5px solid var(--border);border-radius:var(--radius-lg);margin-bottom:1rem;overflow:hidden">
        <div style="padding:10px 12px;background:var(--surface2);border-bottom:0.5px solid var(--border);display:flex;align-items:center;justify-content:space-between">
          <div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;color:var(--text-muted)">Importado ${day}</div>
          <div style="font-size:11px;color:var(--text-faint)">${orders.length} orden${orders.length !== 1 ? 'es' : ''}</div>
        </div>
        ${rows}
      </div>`;
  }).join('');
}

// Deliberately visible-but-not-blocking (see the to-do list item this came
// from): a pending Shopify match means an order exists that isn't yet
// attached to a real customer, so it's easy to pack and ship without ever
// noticing the match was never confirmed. This can't be allowed to stop a
// packer from working -- it just needs to be impossible to miss. The nav
// badge (common.js) and this tab both read the same endpoint as the
// Ajustes bulk tool, so all three numbers always agree.
function renderShopifyPendingTab() {
  const n = shopifyPendingGroupsList.length;
  const badge = document.getElementById('badge-shopify-pend');
  if (badge) {
    badge.textContent = n;
    badge.classList.toggle('has-items', n > 0);
  }

  const container = document.getElementById('shopify-pend-list');
  if (!container) return;

  if (n === 0) {
    container.innerHTML = '<div style="color:var(--text-faint);font-size:13px;padding:1rem 0">Sin pedidos de Shopify pendientes de confirmar. 🎉</div>';
    return;
  }

  container.innerHTML = shopifyPendingGroupsList.map(g => {
    const best = g.candidates && g.candidates[0];
    const orders = (g.order_names || []).length
      ? g.order_names.slice(0, 4).join(', ') + (g.order_names.length > 4 ? ` +${g.order_names.length - 4} más` : '')
      : `${g.match_ids.length} pedido${g.match_ids.length !== 1 ? 's' : ''}`;
    const suggestion = best
      ? `Sugerido: <strong>${escapeHtml(best.username || best.name || best.customer_id)}</strong> (${best.same_shopify_id ? 'ID de Shopify coincide' : best.score + '%'})`
      : 'Sin sugerencia — requiere crear cliente o revisar a mano';
    return `
      <div style="display:flex;align-items:center;justify-content:space-between;padding:10px 12px;border-bottom:0.5px solid var(--border);gap:12px">
        <div style="min-width:0">
          <div style="font-weight:600;font-size:13px;margin-bottom:2px">${escapeHtml(g.incoming.name || g.incoming.email || g.incoming.phone || 'Sin datos')}</div>
          <div style="font-size:12px;color:var(--text-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(orders)}</div>
          <div style="font-size:11.5px;color:var(--text-faint);margin-top:2px">${suggestion}</div>
        </div>
      </div>`;
  }).join('');
}

function switchTab(tab) {
  currentTab = tab;
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelector(`[data-tab="${tab}"]`).classList.add('active');
  ['activos', 'cobrar', 'enviar', 'enviado', 'archivo', 'tiktok', 'shopify-pend'].forEach(t => {
    const node = document.getElementById(`tab-${t}`);
    if (!node) return;
    node.style.display = t === tab ? 'block' : 'none';
  });
  if (tab === 'enviado' && !tabDataLoaded.enviado) loadEnviadoTab();
  else if (tab === 'archivo' && !tabDataLoaded.archivo) loadArchivoTab();
}

document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });

// ── INIT ─────────────────────────────────────────────────────
(async () => {
  await ensureAuth();
  renderBulkItems();
  updateUndoRedoButtons();
  loadRecords();
  fetchShopifyPending();
  setInterval(autoRefresh, 10000);
  setInterval(fetchShopifyPending, 60000);
  setInterval(async () => {
    try {
      const data = await apiGet('action=customers');
      allCustomers = {};
      customersById = {};
      (data.records || []).forEach(c => {
        const primary = String(c['Primary Username'] || '').trim();
        const custId = String(c['Customer ID'] || '').trim();
        if (custId) customersById[custId] = primary;
        if (!primary) return;
        const aliases = c['Aliases'] ? String(c['Aliases']).split(',').map(a => a.trim()).filter(Boolean) : [];
        const entry = { name: primary, shipmentCount: parseInt(c['Shipment Count'], 10) || 0, aliases, customerId: custId };
        [primary, ...aliases].forEach(a => { if (a) allCustomers[a.toLowerCase()] = entry; });
      });
    } catch (e) { /* silent */ }
  }, 60000);
})();

// ═══════════════════════════════════════════════════════════════════════════
// MERGE REVIEW MODAL
// Add this block anywhere in app.js (e.g. right after showCustomerHistoryModal).
// ═══════════════════════════════════════════════════════════════════════════

// Returns a human message for a given match score, in ~10-15% bands.
function confidenceMessage(score) {
  if (score >= 90) return 'Casi con toda seguridad es la misma persona.';
  if (score >= 75) return 'Muy probablemente es la misma persona.';
  if (score >= 60) return 'Probablemente es la misma persona.';
  if (score >= 45) return 'Podría ser la misma persona, pero no es claro.';
  if (score >= 30) return 'Coincidencia débil — revisa con cuidado.';
  return 'Coincidencia muy débil — probablemente sea otra persona.';
}

// Simple field-level similarity, reusing the same normalized approach as
// the backend scorer (kept intentionally simple here -- this is only for
// display sorting, not a real match decision, which already happened server-side).
function fieldSimilarity(a, b) {
  a = String(a || '').toLowerCase().trim();
  b = String(b || '').toLowerCase().trim();
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.includes(b) || b.includes(a)) return 0.6;
  return 0;
}

// Builds the sorted comparison rows: exact matches first, then partial,
// then complete mismatches at the bottom.
function buildComparisonRows(match, customer) {
  const rows = [
    { label: 'Nombre',   incoming: match['Incoming Name'],  onFile: `${customer['First Name'] || ''} ${customer['Surname'] || ''}`.trim() },
    { label: 'Teléfono', incoming: match['Incoming Phone'], onFile: customer['Phone Full'] || customer['Phone Partial'] || '' },
    { label: 'Usuario',  incoming: match['Incoming Username'], onFile: customer['Primary Username'] || '' },
    { label: 'Email',    incoming: match['Incoming Email'], onFile: customer['Email'] || '' },
    { label: 'Ciudad',   incoming: (match['Incoming Address'] || '').split(' / ')[0] || '', onFile: customer['City'] || '' },
    { label: 'Estado',   incoming: (match['Incoming Address'] || '').split(' / ')[1] || '', onFile: customer['State'] || '' },
    { label: 'CP',       incoming: (match['Incoming Address'] || '').split(' / ')[2] || '', onFile: customer['ZIP'] || '' },
  ];
  rows.forEach(r => { r.score = fieldSimilarity(r.incoming, r.onFile); });
  return rows.sort((a, b) => b.score - a.score);
}

function comparisonRowHtml(row) {
  const tier = row.score === 1 ? 'match-exact' : row.score > 0 ? 'match-partial' : 'match-none';
  return `<div class="compare-row ${tier}">
    <div class="compare-label">${escapeHtml(row.label)}</div>
    <div class="compare-incoming">${escapeHtml(row.incoming) || '—'}</div>
    <div class="compare-onfile">${escapeHtml(row.onFile) || '—'}</div>
  </div>`;
}

async function submitMergeDecision(matchId, decision, customerId, clickedBtn) {
  const actionsArea = document.getElementById('merge-actions');
  if (actionsArea) {
    actionsArea.querySelectorAll('button').forEach(b => { b.disabled = true; });
  }
  const originalText = clickedBtn ? clickedBtn.textContent : '';
  if (clickedBtn) clickedBtn.textContent = 'Guardando...';

  try {
    await apiPost({ action: 'resolve_shopify_match', match_id: matchId, decision, customer_id: customerId || '' });
    showToast('✓ Cliente actualizado');
    closeModal();
    loadRecords();
  } catch (e) {
    showToast('Error: ' + e.message);
    if (actionsArea) {
      actionsArea.querySelectorAll('button').forEach(b => { b.disabled = false; });
    }
    if (clickedBtn) clickedBtn.textContent = originalText;
  }
}

async function showMergeReviewModal(match) {
  const c = document.getElementById('modal-container');
  const score = Number(match['Match Score']) || 0;
  const suggestedId = match['Suggested Customer ID'];

  c.innerHTML = `<div class="modal-overlay" id="modal-overlay"><div class="modal merge-review-modal">
    <div class="modal-title">Revisar cliente sugerido</div>
    <div class="merge-confidence">
      <div class="merge-confidence-pct">${score}%</div>
      <div class="merge-confidence-msg">${escapeHtml(confidenceMessage(score))}</div>
    </div>
    <div id="merge-compare-area"><div class="empty-state">Cargando...</div></div>
    <div class="modal-actions" id="merge-actions"></div>
  </div></div>`;

  const compareArea = document.getElementById('merge-compare-area');
  const actionsArea = document.getElementById('merge-actions');

  // Fetch the suggested customer's full record for the comparison.
  let suggestedCustomer = null;
  if (suggestedId) {
    try {
      const data = await apiGet('action=customers&customer_id=' + encodeURIComponent(suggestedId));
      suggestedCustomer = data || null;
    } catch (e) { /* fall through, handled below */ }
  }

  if (suggestedCustomer) {
    try {
      const rows = buildComparisonRows(match, suggestedCustomer);
      compareArea.innerHTML = `
        <div class="compare-header">
          <div></div>
          <div>En el pedido</div>
          <div>${escapeHtml(suggestedCustomer['Primary Username'] || suggestedId)}</div>
        </div>
        ${rows.map(comparisonRowHtml).join('')}
      `;
    } catch (err) {
      console.error('buildComparisonRows failed:', err);
      compareArea.innerHTML = '<div class="empty-state">Error: ' + escapeHtml(err.message) + '</div>';
    }
  } else {
    compareArea.innerHTML = '<div class="empty-state">No se encontró información del cliente sugerido</div>';
  }

    const confirmBtn = document.createElement('button');
  confirmBtn.className = 'btn btn-enviado';
  confirmBtn.textContent = 'Confirmar: es esta persona';
  confirmBtn.disabled = !suggestedId;
  confirmBtn.addEventListener('click', () => submitMergeDecision(match['Match ID'], 'confirm', null, confirmBtn));
  actionsArea.appendChild(confirmBtn);

  const relinkBtn = document.createElement('button');
  relinkBtn.className = 'btn';
  relinkBtn.textContent = 'Es otra persona (buscar)';
  relinkBtn.addEventListener('click', () => showRelinkPicker(match));
  actionsArea.appendChild(relinkBtn);

  const newBtn = document.createElement('button');
  newBtn.className = 'btn';
  newBtn.textContent = 'Crear cliente nuevo';
  newBtn.addEventListener('click', () => submitMergeDecision(match['Match ID'], 'new', null, newBtn));
  actionsArea.appendChild(newBtn);

  const closeBtn = document.createElement('button');
  closeBtn.className = 'btn';
  closeBtn.textContent = 'Cerrar';
  closeBtn.addEventListener('click', closeModal);
  actionsArea.appendChild(closeBtn);
}

// ═══════════════════════════════════════════════════════════════════════════
// REPLACE the existing showRelinkPicker() function with this one.
// It opens a small searchable list INSIDE the existing modal-container,
// instead of using the browser's ugly native prompt().
// ═══════════════════════════════════════════════════════════════════════════

function showRelinkPicker(match) {
  const c = document.getElementById('modal-container');

  const options = Object.keys(customersById)
    .map(id => ({ id, name: customersById[id] || id }))
    .filter(o => o.name)
    .sort((a, b) => a.name.localeCompare(b.name));

  c.innerHTML = `<div class="modal-overlay" id="modal-overlay"><div class="modal relink-picker-modal">
    <div class="modal-title">Buscar cliente correcto</div>
    <input type="text" id="relink-search" class="search-input relink-search-input" placeholder="Escribe un nombre de usuario..." autocomplete="off" />
    <div id="relink-results" class="relink-results"></div>
    <div class="modal-actions">
      <button class="btn" id="relink-cancel-btn">Cancelar</button>
    </div>
  </div></div>`;

  document.getElementById('relink-cancel-btn').addEventListener('click', () => showMergeReviewModal(match));

  const searchInput = document.getElementById('relink-search');
  const resultsEl = document.getElementById('relink-results');

  function renderResults(query) {
    const q = query.trim().toLowerCase();
    const filtered = q
      ? options.filter(o => o.name.toLowerCase().includes(q)).slice(0, 25)
      : options.slice(0, 25);

    if (!filtered.length) {
      resultsEl.innerHTML = '<div class="empty-state">Sin resultados</div>';
      return;
    }

    resultsEl.innerHTML = filtered.map(o =>
      `<div class="relink-option" data-id="${escapeHtml(o.id)}">${escapeHtml(o.name)} <span class="relink-option-id">${escapeHtml(o.id)}</span></div>`
    ).join('');

    resultsEl.querySelectorAll('.relink-option').forEach(el => {
      el.addEventListener('click', () => {
        submitMergeDecision(match['Match ID'], 'relink', el.getAttribute('data-id'), el);
      });
    });
  }

  searchInput.addEventListener('input', () => renderResults(searchInput.value));
  renderResults('');
  searchInput.focus();
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
      applied += res.applied || 0;
      (res.results || []).filter(r => !r.ok).forEach(r => failed.push(r));
    } catch (e) {
      aborted = e.message;                              //Bob// already-applied batches stay applied; the reload shows what is left
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
