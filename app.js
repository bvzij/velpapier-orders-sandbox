const API = 'https://script.google.com/macros/s/AKfycbwfNI4lYple4BPRNkFLyFyMuoW9no6kRna_nuq1eDNbnPrrx6yeqooEy3s-sVJiJmrczg/exec';

// Maps internal field names (used throughout the UI) to the new Orders sheet column names.
const FIELD_MAP = {
  ID: 'Order ID',
  Cliente: 'Primary Username',
  Producto: 'Products',
  Precio: 'Price',
  Notas: 'Notes',
  Status: 'Status',
  'Fecha Creación': 'Created Date'
};

function mapFromApi(r) {
  return {
    ID: r['Order ID'],
    Cliente: r['Primary Username'] || '',
    Producto: r['Products'] || '',
    Precio: Number(r['Price']) || 0,
    Notas: r['Notes'] || '',
    Status: r['Status'] || 'No Pagado',
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
let currentTab = 'activos';
let currentSort = 'default';
let pendingAction = null;
let bulkItems = [{ producto: '', precio: '', notas: '' }];

// ── HELPERS ──────────────────────────────────────────────────
function daysSince(dateStr) { if (!dateStr) return 0; return Math.floor((new Date() - new Date(dateStr)) / 86400000); }
function formatMXN(n) { if (n === undefined || n === null || n === '') return '—'; return '$' + Number(n).toLocaleString('es-MX', { minimumFractionDigits: 0, maximumFractionDigits: 2 }); }
function formatDate(dateStr) { if (!dateStr) return ''; return new Date(dateStr).toLocaleDateString('es-MX', { day: '2-digit', month: '2-digit', year: '2-digit' }); }
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
  const clientes = getUniqueClientes().filter(c => c.name.toLowerCase().includes(val));
  if (!clientes.length) { list.style.display = 'none'; return; }
  list.innerHTML = '';
  clientes.slice(0, 8).forEach(c => {
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
  const active = allRecords.filter(r => ['No Pagado', 'Pagado', 'Empacado'].includes(r.Status) && (r.Cliente || '').toLowerCase() === val);
  const archived = allRecords.filter(r => ['Enviado', 'Archivado'].includes(r.Status) && (r.Cliente || '').toLowerCase() === val);
  const results = document.getElementById('search-results');
  results.innerHTML = '';
  if (!active.length && !archived.length) { results.innerHTML = `<div class="empty-state">Sin resultados para "${name}"</div>`; return; }
  function appendGroup(records, labelText, showActs) {
    if (!records.length) return;
    if (labelText) { const l = document.createElement('div'); l.className = 'section-label'; l.textContent = labelText; results.appendChild(l); }
    const { groups, order } = groupByCliente(records);
    order.forEach(cliente => {
      const items = groups[cliente];
      const group = document.createElement('div'); group.className = 'customer-group';
      group.innerHTML = `<div class="customer-header${isUnnamedCliente(cliente) ? ' customer-header--unnamed' : ''}"><div class="customer-avatar">${getInitials(cliente)}</div><div class="customer-name">${cliente}</div></div>`;
      items.forEach(r => group.appendChild(renderOrderRow(r, showActs)));
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
  const clientes = getUniqueClientes().filter(c => c.name.toLowerCase().includes(val));
  if (!clientes.length) { list.style.display = 'none'; return; }
  list.innerHTML = '';
  clientes.slice(0, 6).forEach(c => {
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
    if (c) { const k = c.toLowerCase(); if (!seen[k]) seen[k] = { name: c, count: 0 }; seen[k].count++; }
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
    <select id="edit-status"><option value="No Pagado" ${r.Status === 'No Pagado' ? 'selected' : ''}>No Pagado</option><option value="Pagado" ${r.Status === 'Pagado' ? 'selected' : ''}>Pagado</option><option value="Empacado" ${r.Status === 'Empacado' ? 'selected' : ''}>Empacado</option><option value="Enviado" ${r.Status === 'Enviado' ? 'selected' : ''}>Enviado</option><option value="Archivado" ${r.Status === 'Archivado' ? 'selected' : ''}>Archivado</option></select>
    <input type="text" id="edit-notas" value="${(r.Notas || '').replace(/"/g, '&quot;')}" placeholder="Notas (opcional)" />
  </div><div class="modal-actions"><button class="btn" id="edit-cancel-btn">Cancelar</button><button class="btn btn-primary" id="edit-save-btn">Guardar</button></div></div></div>`;
  document.getElementById('edit-cancel-btn').addEventListener('click', closeModal);
  document.getElementById('edit-save-btn').addEventListener('click', () => saveEdit(id));
  document.getElementById('modal-overlay').addEventListener('click', e => { if (e.target.id === 'modal-overlay') closeModal(); });
}

function closeModal() { document.getElementById('modal-container').innerHTML = ''; pendingAction = null; }

// ── API CALLS ────────────────────────────────────────────────
async function apiPost(data) {
  const res = await fetch(API, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify(data)
  });
  return res.json();
}

async function loadRecords() {
  const icon = document.getElementById('refresh-icon');
  icon.classList.add('spinning');
  try {
    const res = await fetch(API + '?action=orders');
    const data = await res.json();
    allRecords = (data.records || []).map(mapFromApi);
    renderAll();
    if (searchSelectedCliente) runSearch(searchSelectedCliente);
  } catch (e) {
    showToast('Error al cargar datos');
  } finally {
    icon.classList.remove('spinning');
  }
}

async function updateStatus(id, status) {
  try {
    const result = await apiPost({ action: 'update', id: id, fields: mapToApiFields({ Status: status }) });
    if (!result.success) throw new Error(result.error || 'Error');
    const rec = allRecords.find(r => r.ID === id);
    if (rec) rec.Status = status;
    renderAll();
    if (searchSelectedCliente) runSearch(searchSelectedCliente);
    const msgs = { 'Pagado': '✓ Marcado como pagado', 'Enviado': '✓ Marcado como enviado', 'No Pagado': '↩ Revertido a No Pagado' };
    showToast(msgs[status] || '✓ Actualizado');
  } catch (e) { showToast('Error: ' + e.message); }
}

function requestStatusChange(id, status, label) { showConfirmModal(`¿Marcar este pedido como <strong>${label}</strong>?`, () => updateStatus(id, status)); }
function requestUndo(id, currentStatus) { const p = previousStatus(currentStatus); if (!p) return; showConfirmModal(`¿Revertir a <strong>${p}</strong>?`, () => updateStatus(id, p)); }

function requestRenameCliente(oldName) {
  const c = document.getElementById('modal-container');
  c.innerHTML = `<div class="modal-overlay" id="modal-overlay"><div class="modal"><div class="modal-title">Cambiar nombre de cliente</div><div class="edit-form" style="position:relative"><input type="text" id="rename-cliente" value="${oldName.replace(/"/g, '&quot;')}" placeholder="Nuevo nombre" autocomplete="off" /><div class="autocomplete-list" id="rename-autocomplete-list" style="display:none"></div></div><div class="modal-actions"><button class="btn" id="rename-cancel-btn">Cancelar</button><button class="btn btn-primary" id="rename-save-btn">Guardar</button></div></div></div>`;
  const input = document.getElementById('rename-cliente');
  const list = document.getElementById('rename-autocomplete-list');
  input.addEventListener('input', () => {
    const val = input.value.trim().toLowerCase();
    if (!val) { list.style.display = 'none'; return; }
    const clientes = getUniqueClientes().filter(cl => cl.name.toLowerCase().includes(val) && cl.name !== oldName);
    if (!clientes.length) { list.style.display = 'none'; return; }
    list.innerHTML = '';
    clientes.slice(0, 6).forEach(cl => {
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
    const targets = allRecords.filter(r => (r.Cliente || 'Sin nombre').toLowerCase() === oldName.toLowerCase());
    closeModal();
    try {
      for (const r of targets) {
        await apiPost({ action: 'update', id: r.ID, fields: mapToApiFields({ Cliente: newName }) });
        r.Cliente = newName;
      }
      renderAll();
      if (searchSelectedCliente) runSearch(searchSelectedCliente);
      showToast(`✓ ${targets.length} pedidos actualizados a "${newName}"`);
    } catch (e) { showToast('Error: ' + e.message); }
  });
  document.getElementById('modal-overlay').addEventListener('click', e => { if (e.target.id === 'modal-overlay') closeModal(); });
}

function requestBulkUpdate(cliente, fromStatus, toStatus, toLabel) {
  const targets = allRecords.filter(r => (r.Cliente || '').toLowerCase() === cliente.toLowerCase() && r.Status === fromStatus);
  if (!targets.length) { showToast('Sin pedidos para actualizar'); return; }
  showConfirmModal(`¿Marcar todos los pedidos de <strong>${cliente}</strong> como <strong>${toLabel}</strong>? (${targets.length} items)`, async () => {
    try {
      for (const r of targets) {
        const result = await apiPost({ action: 'update', id: r.ID, fields: mapToApiFields({ Status: toStatus }) });
        if (result.success) r.Status = toStatus;
      }
      renderAll();
      if (searchSelectedCliente) runSearch(searchSelectedCliente);
      showToast(`✓ ${targets.length} pedidos actualizados`);
    } catch (e) { showToast('Error: ' + e.message); }
  });
}

function requestDelete(id, producto) {
  const label = /^https?:\/\/admin\.shopify\.com\//.test(producto || '') ? 'este pedido de Shopify' : producto;
  showConfirmModal(`¿Eliminar <strong>${label}</strong>? Esta acción no se puede deshacer.`, async () => {
    try {
      const result = await apiPost({ action: 'delete', id: id });
      if (!result.success) throw new Error(result.error || 'Error');
      allRecords = allRecords.filter(r => r.ID !== id);
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
    const result = await apiPost({ action: 'update', id: id, fields: mapToApiFields({ Cliente: cliente, Producto: producto, Precio: precio, Status: status, Notas: notas }) });
    if (!result.success) throw new Error(result.error || 'Error');
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
  const status = document.getElementById('new-status').value;
  if (!cliente) { showToast('Falta el usuario TikTok'); return; }
  saveBulkState();
  const items = bulkItems.filter(item => item.producto.trim());
  if (!items.length) { showToast('Falta al menos un producto'); return; }
  try {
    for (const item of items) {
      const result = await apiPost({ action: 'create', fields: mapToApiFields({ Cliente: cliente, Producto: item.producto, Precio: parseFloat(item.precio) || 0, Status: status, ...(item.notas && { Notas: item.notas }) }) });
      if (result.success) {
        allRecords.push({ ID: result.id, Cliente: cliente, Producto: item.producto, Precio: parseFloat(item.precio) || 0, Notas: item.notas || '', Status: status, 'Fecha Creación': new Date().toISOString() });
      }
    }
    document.getElementById('new-cliente').value = '';
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

  let pillClass = 'pill-nopagado', pillText = `No Pagado${isOverdueUnpaid ? ' ⚠' : ''}`;
  if (status === 'Pagado') { pillClass = 'pill-pagado'; pillText = `Pagado${isOverduePaid ? ' ⚠' : ''}`; }
  if (status === 'Empacado') { pillClass = 'pill-enviado'; pillText = 'Empacado'; }
  if (status === 'Enviado') { pillClass = 'pill-enviado'; pillText = 'Enviado'; }
  if (status === 'Archivado') { pillClass = 'pill-enviado'; pillText = 'Archivado'; }

  const metaParts = [formatDate(created), days === 0 ? 'hoy' : `hace ${days}d`].filter(Boolean);
  const notasHtml = renderNotas(r.Notas);
  const id = r.ID;

  const row = document.createElement('div');
  row.className = rowClass;

  const info = document.createElement('div');
  info.innerHTML = `<div class="order-producto">${escapeHtml(r.Producto) || '—'}</div><div class="order-meta">${metaParts.join(' · ')}${notasHtml ? ' · ' + notasHtml : ''}</div>`;

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
  if (showActions && status === 'No Pagado') {
    const btn = document.createElement('button'); btn.className = 'btn btn-sm btn-pagado'; btn.textContent = 'Pagado';
    btn.addEventListener('click', () => requestStatusChange(id, 'Pagado', 'Pagado'));
    actionCell.appendChild(btn);
  } else if (showActions && status === 'Pagado') {
    const btn = document.createElement('button'); btn.className = 'btn btn-sm btn-enviado'; btn.textContent = 'Enviado';
    btn.addEventListener('click', () => requestStatusChange(id, 'Enviado', 'Enviado'));
    actionCell.appendChild(btn);
  }

  row.appendChild(info); row.appendChild(hoverZone); row.appendChild(precio); row.appendChild(pill); row.appendChild(actionCell);
  row.addEventListener('mouseenter', () => hoverZone.classList.add('visible'));
  row.addEventListener('mouseleave', () => hoverZone.classList.remove('visible'));
  return row;
}

function groupByCliente(records) {
  const groups = {}, order = [];
  sortRecords(records).forEach(r => {
    const c = r.Cliente || 'Sin nombre';
    const key = c.toLowerCase();
    if (!groups[key]) { groups[key] = { name: c, items: [] }; order.push(key); }
    groups[key].items.push(r);
  });
  const out = {};
  order.forEach(k => { out[groups[k].name] = groups[k].items; });
  return { groups: out, order: order.map(k => groups[k].name) };
}

function renderGrouped(records, containerId, showActions) {
  const el = document.getElementById(containerId);
  el.innerHTML = '';
  if (!records.length) { el.innerHTML = '<div class="empty-state">Sin pedidos aquí</div>'; return; }
  const { groups, order } = groupByCliente(records);
  order.forEach(cliente => {
    const items = groups[cliente];
    const unpaid = items.filter(r => r.Status === 'No Pagado').reduce((s, r) => s + (r.Precio || 0), 0);
    const hasUnpaid = items.some(r => r.Status === 'No Pagado');
    const hasPaid = items.some(r => r.Status === 'Pagado');

    const group = document.createElement('div'); group.className = 'customer-group';
    const header = document.createElement('div'); header.className = 'customer-header' + (isUnnamedCliente(cliente) ? ' customer-header--unnamed' : '');
    header.innerHTML = `<div class="customer-avatar">${getInitials(cliente)}</div><div class="customer-name">${cliente}</div><span class="customer-owed">${unpaid > 0 ? '· Por cobrar: ' + formatMXN(unpaid) : ''}</span><div class="customer-bulk-actions"></div>`;

    const bulk = header.querySelector('.customer-bulk-actions');
    const renameBtn = document.createElement('button');
    renameBtn.className = 'btn btn-xs btn-edit'; renameBtn.textContent = '✎'; renameBtn.title = 'Cambiar nombre';
    renameBtn.addEventListener('click', () => requestRenameCliente(cliente));
    bulk.appendChild(renameBtn);
    if (showActions && hasUnpaid) {
      const btn = document.createElement('button'); btn.className = 'btn btn-sm btn-pagado'; btn.textContent = 'Todo pagado';
      btn.addEventListener('click', () => requestBulkUpdate(cliente, 'No Pagado', 'Pagado', 'Pagado'));
      bulk.appendChild(btn);
    }
    if (showActions && hasPaid) {
      const btn = document.createElement('button'); btn.className = 'btn btn-sm btn-enviado'; btn.textContent = 'Todo enviado';
      btn.addEventListener('click', () => requestBulkUpdate(cliente, 'Pagado', 'Enviado', 'Enviado'));
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
  const active = allRecords.filter(r => ['No Pagado', 'Pagado', 'Empacado'].includes(r.Status));
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
  const twoWeeksAgo = new Date(Date.now() - 14 * 86400000);
  const activos = allRecords.filter(r => ['No Pagado', 'Pagado', 'Empacado'].includes(r.Status));
  const cobrar = allRecords.filter(r => r.Status === 'No Pagado');
  const enviar = allRecords.filter(r => r.Status === 'Pagado');
  const archivo = allRecords.filter(r => ['Enviado', 'Archivado'].includes(r.Status) && new Date(r['Fecha Creación']) >= twoWeeksAgo);

  document.getElementById('badge-activos').textContent = activos.length;
  document.getElementById('badge-cobrar').textContent = cobrar.length;
  document.getElementById('badge-enviar').textContent = enviar.length;
  document.getElementById('badge-archivo').textContent = archivo.length;

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
  renderGrouped(archivo, 'archivo-list', false);
  renderAnalytics();
  renderClientList();
}

function switchTab(tab) {
  currentTab = tab;
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelector(`[data-tab="${tab}"]`).classList.add('active');
  ['activos', 'cobrar', 'enviar', 'archivo', 'analytics'].forEach(t => {
    document.getElementById(`tab-${t}`).style.display = t === tab ? 'block' : 'none';
  });
}

// ── INIT ─────────────────────────────────────────────────────
renderBulkItems();
loadRecords();
setInterval(loadRecords, 30000);