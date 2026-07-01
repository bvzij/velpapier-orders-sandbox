const API = 'https://script.google.com/macros/s/AKfycbyDArHQIjYhN_Hy_U1CrXbklXLjGabNIuk7u9eisNrQHXG3v_UBGZcXgZm8ipm4bI7c/exec';

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
let undoStack = [];
let redoStack = [];
const MAX_UNDO_DEPTH = 20;

function pushUndoEntry(entry) {
  undoStack.push(entry);
  if (undoStack.length > MAX_UNDO_DEPTH) undoStack.shift();
  redoStack = [];
  updateUndoRedoButtons();
}

function updateUndoRedoButtons() {
  const undoBtn = document.getElementById('undo-btn');
  const redoBtn = document.getElementById('redo-btn');
  if (undoBtn) undoBtn.disabled = undoStack.length === 0;
  if (redoBtn) redoBtn.disabled = redoStack.length === 0;
}

async function performStatusUpdate(orderId, status) {
  const payload = { action: 'update_order_status', order_id: orderId, status: status };
  return apiPost(payload);
}

async function performUndo() {
  if (!undoStack.length) return;
  const entry = undoStack.pop();
  try {
    const result = await performStatusUpdate(entry.order_id, entry.from_status);
    if (result.result !== 'updated') throw new Error(result.error || 'Error');
    const rec = allRecords.find(r => String(r.ID) === String(entry.order_id));
    if (rec) rec.Status = entry.from_status;
    redoStack.push(entry);
    if (redoStack.length > MAX_UNDO_DEPTH) redoStack.shift();
    updateUndoRedoButtons();
    renderAll();
    if (searchSelectedCliente) runSearch(searchSelectedCliente);
    showToast(`↩ Deshecho: ${entry.to_status} → ${entry.from_status}`);
  } catch (e) { undoStack.push(entry); showToast('Error: ' + e.message); }
}

async function performRedo() {
  if (!redoStack.length) return;
  const entry = redoStack.pop();
  try {
    const result = await performStatusUpdate(entry.order_id, entry.to_status);
    if (result.result !== 'updated') throw new Error(result.error || 'Error');
    const rec = allRecords.find(r => String(r.ID) === String(entry.order_id));
    if (rec) rec.Status = entry.to_status;
    undoStack.push(entry);
    if (undoStack.length > MAX_UNDO_DEPTH) undoStack.shift();
    updateUndoRedoButtons();
    renderAll();
    if (searchSelectedCliente) runSearch(searchSelectedCliente);
    showToast(`↪ Rehecho: ${entry.from_status} → ${entry.to_status}`);
  } catch (e) { redoStack.push(entry); showToast('Error: ' + e.message); }
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
let tabDataLoaded = { enviado: false, archivo: false };
let allCustomers = {}; // keyed by lowercase username → { name, shipmentCount }
let currentTab = 'activos';
let currentSort = 'newest';
let pendingAction = null;
let bulkItems = [{ producto: '', precio: '', notas: '' }];

// ── HELPERS ──────────────────────────────────────────────────
function daysSince(dateStr) { if (!dateStr) return 0; return Math.floor((new Date() - new Date(dateStr)) / 86400000); }
function formatMXN(n) { if (n === undefined || n === null || n === '') return '—'; return '$' + Number(n).toLocaleString('es-MX', { minimumFractionDigits: 0, maximumFractionDigits: 2 }); }
function formatDate(dateStr) { if (!dateStr) return ''; return new Date(dateStr).toLocaleDateString('es-MX', { day: '2-digit', month: '2-digit', year: '2-digit', timeZone: 'America/Mexico_City' }); }
function showToast(msg) { const t = document.getElementById('toast'); t.textContent = msg; t.classList.add('show'); setTimeout(() => t.classList.remove('show'), 2500); }
function getInitials(name) { return (name || '?').replace('@', '').substring(0, 2).toUpperCase(); }
function isUnnamedCliente(cliente) { return !cliente || !cliente.trim() || cliente.trim().toLowerCase().includes('sin nombre'); }
function previousStatus(status) { if (status === 'Pagado') return 'No Pagado'; if (status === 'Enviado') return 'Pagado'; return null; }
function escapeHtml(s) { return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
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

// ── SEARCH ───────────────────────────────────────────────────
let searchSelectedCliente = null;

function handleSearchInput() {
  const val = document.getElementById('global-search').value.trim().toLowerCase();
  const list = document.getElementById('search-autocomplete-list');
  updateClearBtn();
  if (!val) { list.style.display = 'none'; return; }
  const clientes = getUniqueClientes().filter(c => c.name.toLowerCase().startsWith(val)).slice(0, 8);
  if (!clientes.length) { list.style.display = 'none'; return; }
  list.innerHTML = '';
  clientes.forEach(c => {
    const item = document.createElement('div');
    item.className = 'autocomplete-item';
    item.innerHTML = `<span>${c.name}</span><span class="autocomplete-freq">${c.count} pedido${c.count !== 1 ? 's' : ''}</span>`;
    item.addEventListener('mousedown', e => { e.preventDefault(); selectSearchCliente(c.name); });
    list.appendChild(item);
  });
  list.style.display = 'block';
}

function selectSearchCliente(name) {
  searchSelectedCliente = name;
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

function runSearch(name) {
  const val = name.toLowerCase();
  document.getElementById('search-panel').style.display = 'block';
  document.getElementById('main-panel').style.display = 'none';
  const active = allRecords.filter(r => ['No Pagado', 'Pagado'].includes(r.Status) && (r.Cliente || '').toLowerCase() === val);
  const archived = allRecords.filter(r => ['Enviado', 'Archivado'].includes(r.Status) && (r.Cliente || '').toLowerCase() === val);
  const results = document.getElementById('search-results');
  results.innerHTML = '';
  if (!active.length && !archived.length) { results.innerHTML = `<div class="empty-state">Sin resultados para "${name}"</div>`; return; }
  function appendGroup(records, labelText, showActs) {
    if (!records.length) return;
    if (labelText) { const l = document.createElement('div'); l.className = 'section-label'; l.textContent = labelText; results.appendChild(l); }
    groupByCliente(records).forEach(grp => {
      const cliente = grp.name;
      const group = document.createElement('div'); group.className = 'customer-group';
      group.innerHTML = `<div class="customer-header${isUnnamedCliente(cliente) ? ' customer-header--unnamed' : ''}"><div class="customer-avatar">${getInitials(cliente)}</div><div class="customer-name">${cliente}</div></div>`;
      grp.items.forEach(r => group.appendChild(renderOrderRow(r, showActs)));
      results.appendChild(group);
    });
  }
  if (active.length) appendGroup(active, 'Activos', true);
  if (archived.length) {
    if (active.length) { const d = document.createElement('div'); d.className = 'search-divider'; d.textContent = 'Archivo'; results.appendChild(d); }
    appendGroup(archived, active.length ? '' : 'Archivo', false);
  }
}

// ── CLIENT AUTOCOMPLETE ──────────────────────────────────────
function handleClienteInput() {
  const val = document.getElementById('new-cliente').value.trim().toLowerCase();
  const list = document.getElementById('autocomplete-list');
  if (!val) { list.style.display = 'none'; return; }
  const clientes = getUniqueClientes().filter(c => c.name.toLowerCase().startsWith(val)).slice(0, 8);
  if (!clientes.length) { list.style.display = 'none'; return; }
  list.innerHTML = '';
  clientes.forEach(c => {
    const item = document.createElement('div');
    item.className = 'autocomplete-item';
    item.innerHTML = `<span>${c.name}</span><span class="autocomplete-freq">${c.count} pedido${c.count !== 1 ? 's' : ''}</span>`;
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

function getUniqueClientes() {
  const seen = {};
  allRecords.forEach(r => {
    const c = r.Cliente;
    if (!c) return;
    const k = c.toLowerCase();
    if (!seen[k]) seen[k] = { name: c, count: 0 };
    if (r.Channel === 'TikTok' || r.Channel === 'Shopify') seen[k].count++;
  });
  return Object.values(seen).sort((a, b) => b.count - a.count);
}

// ── MODALS ───────────────────────────────────────────────────
function showConfirmModal(message, onConfirm) {
  pendingAction = onConfirm;
  const c = document.getElementById('modal-container');
  c.innerHTML = `<div class="modal-overlay" id="modal-overlay"><div class="modal"><div class="modal-title">Confirmar acción</div><div class="modal-body">${message}</div><div class="modal-actions"><button class="btn" id="modal-cancel-btn">Cancelar</button><button class="btn btn-primary" id="modal-confirm-btn">Confirmar</button></div></div></div>`;
  document.getElementById('modal-cancel-btn').addEventListener('click', closeModal);
  document.getElementById('modal-confirm-btn').addEventListener('click', () => { const a = pendingAction; closeModal(); if (a) a(); });
  document.getElementById('modal-overlay').addEventListener('click', e => { if (e.target.id === 'modal-overlay') closeModal(); });
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
  document.getElementById('modal-overlay').addEventListener('click', e => { if (e.target.id === 'modal-overlay') closeModal(); });
}

function closeModal() { document.getElementById('modal-container').innerHTML = ''; pendingAction = null; }

function showNewOrderModal() {
  const c = document.getElementById('modal-container');
  c.innerHTML = `<div class="modal-overlay" id="modal-overlay"><div class="modal"><div class="modal-title">Nueva orden</div><div class="edit-form">
    <input type="text" id="no-username" placeholder="Usuario" autocomplete="off" />
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
  document.getElementById('modal-overlay').addEventListener('click', e => { if (e.target.id === 'modal-overlay') closeModal(); });
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

function showStatusModal(id, currentStatus) {
  const next = nextStatuses(currentStatus);
  if (!next.length) { showToast('Sin siguiente estado'); return; }
  const c = document.getElementById('modal-container');
  c.innerHTML = `<div class="modal-overlay" id="modal-overlay"><div class="modal"><div class="modal-title">Actualizar estado</div><div class="status-options">${next.map(s => `<button class="btn btn-block status-option-btn" data-status="${escapeHtml(s)}">${escapeHtml(s)}</button>`).join('')}</div><div class="modal-actions"><button class="btn" id="status-cancel-btn">Cancelar</button></div></div></div>`;
  c.querySelectorAll('.status-option-btn').forEach(btn => btn.addEventListener('click', () => { updateOrderStatusNew(id, btn.dataset.status); closeModal(); }));
  document.getElementById('status-cancel-btn').addEventListener('click', closeModal);
  document.getElementById('modal-overlay').addEventListener('click', e => { if (e.target.id === 'modal-overlay') closeModal(); });
}

async function updateOrderStatusNew(id, status) {
  try {
    const rec = allRecords.find(r => r.ID === id);
    const fromStatus = rec ? rec.Status : null;
    const result = await performStatusUpdate(id, status);
    if (result.result !== 'updated') throw new Error(result.error || 'Error');
    if (rec) rec.Status = status;
    pushUndoEntry({ order_id: id, from_status: fromStatus, to_status: status });
    renderAll();
    if (searchSelectedCliente) runSearch(searchSelectedCliente);
    showToast(`✓ Estado actualizado a ${status}`);
  } catch (e) { showToast('Error: ' + e.message); }
}

let bulkModalSelectedStatus = null;

function showBulkStatusModal(group) {
  bulkModalSelectedStatus = null;
  const cliente = group.name;
  const orders = group.items.filter(r => ['No Pagado', 'Pagado'].includes(r.Status));
  if (!orders.length) { showToast('Sin pedidos pendientes'); return; }
  const c = document.getElementById('modal-container');
  c.innerHTML = `<div class="modal-overlay" id="modal-overlay"><div class="modal bulk-status-modal">
    <div class="modal-title">Cambiar estado · ${escapeHtml(cliente)}</div>
    <div class="status-pills">${['No Pagado', 'Pagado', 'Enviado'].map(s => `<button class="status-pill-toggle" data-status="${escapeHtml(s)}">${escapeHtml(s)}</button>`).join('')}</div>
    <div class="bulk-order-list">${orders.map(r => `<label class="bulk-order-item"><input type="checkbox" class="bulk-order-check" data-id="${escapeHtml(String(r.ID))}" checked /><span class="bulk-order-product">${escapeHtml(r.Producto) || '—'}</span><span class="status-pill ${statusPillClass(r.Status)}">${escapeHtml(r.Status)}</span></label>`).join('')}</div>
    <div class="modal-actions"><button class="btn" id="bulk-status-cancel-btn">Cerrar</button><button class="btn btn-primary" id="bulk-status-confirm-btn" disabled>Confirmar</button></div>
  </div></div>`;
  document.getElementById('bulk-status-cancel-btn').addEventListener('click', closeModal);
  document.getElementById('modal-overlay').addEventListener('click', e => { if (e.target.id === 'modal-overlay') closeModal(); });
  c.querySelectorAll('.status-pill-toggle').forEach(btn => btn.addEventListener('click', () => {
    bulkModalSelectedStatus = btn.dataset.status;
    c.querySelectorAll('.status-pill-toggle').forEach(b => b.classList.toggle('active', b === btn));
    updateBulkConfirmState();
  }));
  c.querySelectorAll('.bulk-order-check').forEach(chk => chk.addEventListener('change', updateBulkConfirmState));
  document.getElementById('bulk-status-confirm-btn').addEventListener('click', () => { if (bulkModalSelectedStatus) applyBulkStatus(bulkModalSelectedStatus); });
}

function updateBulkConfirmState() {
  const anyChecked = document.querySelectorAll('.bulk-order-check:checked').length > 0;
  const btn = document.getElementById('bulk-status-confirm-btn');
  if (btn) btn.disabled = !(anyChecked && bulkModalSelectedStatus);
}

async function applyBulkStatus(status) {
  const ids = Array.from(document.querySelectorAll('.bulk-order-check:checked')).map(ch => ch.dataset.id);
  if (!ids.length) { showToast('Selecciona al menos un pedido'); return; }
  try {
    const entries = [];
    for (const id of ids) {
      const rec = allRecords.find(r => String(r.ID) === id);
      const fromStatus = rec ? rec.Status : null;
      const result = await performStatusUpdate(id, status);
      if (result.result === 'updated') {
        if (rec) rec.Status = status;
        entries.push({ order_id: id, from_status: fromStatus, to_status: status });
      }
    }
    entries.forEach(pushUndoEntry);
    closeModal();
    renderAll();
    if (searchSelectedCliente) runSearch(searchSelectedCliente);
    showToast(`✓ ${entries.length} pedidos actualizados a ${status}`);
  } catch (e) { showToast('Error: ' + e.message); }
}

function openCustomerHistory(customerId, displayName) {
  if (!customerId) { showToast('Cliente sin ID asociado'); return; }
  showCustomerHistoryModal(customerId, displayName);
}

async function showCustomerHistoryModal(customerId, displayName) {
  const c = document.getElementById('modal-container');
  c.innerHTML = `<div class="modal-overlay" id="modal-overlay"><div class="modal customer-history-modal"><div class="modal-title">Historial de ${escapeHtml(displayName || customerId)}</div><div id="customer-history-list" class="customer-history-list"><div class="empty-state">Cargando...</div></div><div class="modal-actions"><button class="btn" id="history-close-btn">Cerrar</button></div></div></div>`;
  document.getElementById('history-close-btn').addEventListener('click', closeModal);
  document.getElementById('modal-overlay').addEventListener('click', e => { if (e.target.id === 'modal-overlay') closeModal(); });
  try {
    const res = await fetch(`${API}?action=orders&customer_id=${encodeURIComponent(customerId)}`);
    const data = await res.json();
    const records = (data.records || []).map(mapFromApi).sort((a, b) => new Date(b['Fecha Creación'] || 0) - new Date(a['Fecha Creación'] || 0));
    const list = document.getElementById('customer-history-list');
    if (!list) return;
    if (!records.length) { list.innerHTML = '<div class="empty-state">Sin pedidos</div>'; return; }
    list.innerHTML = records.map(r => {
      const archiveInfo = r.ArchiveDate ? ` · Archivado: ${formatDate(r.ArchiveDate)}` : '';
      return `<div class="history-row"><div class="history-row-top"><span class="order-producto">${escapeHtml(r.Producto) || '—'}</span>${channelTag(r.Channel)}</div><div class="history-row-bottom"><span class="status-pill ${statusPillClass(r.Status)}">${escapeHtml(r.Status)}</span><span class="order-meta">${formatDate(r['Fecha Creación'])}${archiveInfo}</span></div></div>`;
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
    body: JSON.stringify(data)
  });
  return res.json();
}

function rebuildAllRecords() {
  allRecords = [...activeRecords, ...enviadoRecords, ...archivedRecords];
}

async function fetchActive() {
  const [activeRes, customersRes] = await Promise.all([
    fetch(API + '?action=orders&status=' + encodeURIComponent('No Pagado,Pagado')),
    fetch(API + '?action=customers')
  ]);
  const [activeData, customersData] = await Promise.all([activeRes.json(), customersRes.json()]);
  activeRecords = (activeData.records || []).map(mapFromApi);
  allCustomers = {};
  (customersData.records || []).forEach(c => {
    const aliases = [c['Primary Username'], ...(c['Aliases'] ? String(c['Aliases']).split(',') : [])].map(a => (a || '').trim().toLowerCase()).filter(Boolean);
    aliases.forEach(a => { allCustomers[a] = { name: c['Primary Username'] || '', shipmentCount: parseInt(c['Shipment Count'], 10) || 0 }; });
  });
  rebuildAllRecords();
}

async function fetchEnviado() {
  const res = await fetch(API + '?action=orders&status=Enviado');
  const data = await res.json();
  enviadoRecords = (data.records || []).map(mapFromApi);
  tabDataLoaded.enviado = true;
  rebuildAllRecords();
}

async function fetchArchivo() {
  const res = await fetch(API + '?action=orders&status=Archivado');
  const data = await res.json();
  archivedRecords = (data.records || []).map(mapFromApi);
  tabDataLoaded.archivo = true;
  rebuildAllRecords();
}

async function loadRecords() {
  const icon = document.getElementById('refresh-icon');
  icon.classList.add('spinning');
  try {
    await fetchActive();
    renderAll();
    if (searchSelectedCliente) runSearch(searchSelectedCliente);
  } catch (e) {
    showToast('Error al cargar datos');
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

async function updateStatus(id, status) {
  try {
    const rec = allRecords.find(r => r.ID === id);
    const fromStatus = rec ? rec.Status : null;
    const result = await performStatusUpdate(id, status);
    if (result.result !== 'updated') throw new Error(result.error || 'Error');
    if (rec) rec.Status = status;
    pushUndoEntry({ order_id: id, from_status: fromStatus, to_status: status });
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
      item.innerHTML = `<span>${cl.name}</span><span class="autocomplete-freq">${cl.count} pedido${cl.count !== 1 ? 's' : ''}</span>`;
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
  document.getElementById('modal-overlay').addEventListener('click', e => { if (e.target.id === 'modal-overlay') closeModal(); });
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
  if (!cliente) { showToast('Falta el usuario TikTok'); return; }
  saveBulkState();
  const items = bulkItems.filter(item => item.producto.trim());
  if (!items.length) { showToast('Falta al menos un producto'); return; }
  try {
    for (const item of items) {
      const result = await apiPost({ action: 'create_order', username: cliente, channel, products: item.producto, price: parseFloat(item.precio) || 0, notes: item.notas || '', shopify_order_id: '', status });
      if (result.result === 'created') {
        activeRecords.push({ ID: result.order_id, Cliente: cliente, Channel: channel, Producto: item.producto, Precio: parseFloat(item.precio) || 0, Notas: item.notas || '', Status: result.status || 'No Pagado', CustomerId: result.customer_id || '', 'Fecha Creación': new Date().toISOString() });
        rebuildAllRecords();
      }
    }
    document.getElementById('new-cliente').value = '';
    document.getElementById('new-channel').value = 'Manual';
    document.getElementById('new-status').value = 'No Pagado';
    bulkItems = [{ producto: '', precio: '', notas: '' }];
    renderBulkItems();
    renderAll();
    showToast(`✓ ${items.length} pedido${items.length > 1 ? 's' : ''} agregado${items.length > 1 ? 's' : ''}`);
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

  const metaParts = [formatDate(created), days === 0 ? 'hoy' : `hace ${days}d`].filter(Boolean);
  const notasHtml = renderNotas(r.Notas);
  const id = r.ID;

  const row = document.createElement('div');
  row.className = rowClass;

  const info = document.createElement('div');
  info.innerHTML = `<div class="order-userline"><span class="order-username">${escapeHtml(r.Cliente) || '—'}</span>${channelTag(r.Channel)}</div><div class="order-producto">${escapeHtml(r.Producto) || '—'}</div><div class="order-meta">${metaParts.join(' · ')}${notasHtml ? ' · ' + notasHtml : ''}</div>`;
  const usernameEl = info.querySelector('.order-username');
  if (usernameEl) usernameEl.addEventListener('click', () => openCustomerHistory(r.CustomerId, r.Cliente));

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
  return 'user:' + (r.Cliente || 'Sin nombre').trim().toLowerCase();
}

// Returns an ordered array of { key, name, items }. Orders are grouped by
// Customer ID so aliases of the same customer collapse into one group; the
// representative Primary Username is kept as the display label.
function groupByCliente(records) {
  const groups = {}, order = [];
  sortRecords(records).forEach(r => {
    const key = customerGroupKey(r);
    if (!groups[key]) { groups[key] = { key, name: r.Cliente || 'Sin nombre', items: [] }; order.push(key); }
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
    header.innerHTML = `<div class="customer-avatar">${getInitials(cliente)}</div><div class="customer-name">${cliente}${shipBadge}</div><span class="customer-owed">${unpaid > 0 ? '· Por cobrar: ' + formatMXN(unpaid) : ''}</span><div class="customer-bulk-actions"></div>`;

    const bulk = header.querySelector('.customer-bulk-actions');
    const renameBtn = document.createElement('button');
    renameBtn.className = 'btn btn-xs btn-edit'; renameBtn.textContent = '✎'; renameBtn.title = 'Cambiar nombre';
    renameBtn.addEventListener('click', () => requestRenameCliente(grp));
    bulk.appendChild(renameBtn);
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
  const activos = allRecords.filter(r => ['No Pagado', 'Pagado'].includes(r.Status));
  const cobrar = allRecords.filter(r => r.Status === 'No Pagado');
  const enviar = allRecords.filter(r => r.Status === 'Pagado');
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
}

function switchTab(tab) {
  currentTab = tab;
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelector(`[data-tab="${tab}"]`).classList.add('active');
  ['activos', 'cobrar', 'enviar', 'enviado', 'archivo', 'analytics'].forEach(t => {
    document.getElementById(`tab-${t}`).style.display = t === tab ? 'block' : 'none';
  });
  if (tab === 'enviado' && !tabDataLoaded.enviado) loadEnviadoTab();
  else if (tab === 'archivo' && !tabDataLoaded.archivo) loadArchivoTab();
}

// ── INIT ─────────────────────────────────────────────────────
renderBulkItems();
updateUndoRedoButtons();
loadRecords();
setInterval(autoRefresh, 30000);