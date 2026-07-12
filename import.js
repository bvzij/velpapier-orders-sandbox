// import.js — Vel Papier TikTok Import Page

const API         = 'https://script.google.com/macros/s/AKfycbxhe5-A1DGPVcDtAs1KU9zlMQvCYTv26w-ZJ0OSpL8PUfGHsfuoMYeroa4b4_Qf8eT7jQ/exec';
const N8N_URL     = 'https://n8n.srv1040167.hstgr.cloud/webhook/tiktok-import';
const VP_TOKEN    = '0924';  // X-VP-Token header for N8N

let API_TOKEN = localStorage.getItem('vp_token') || '';

// Files selected by user
let csvFile = null;
let pdfFile = null;

// Result data (kept for PDF re-download + modal)
let lastPdfBase64   = null;
let lastMatches     = [];
let allCustomers    = [];   // fetched from Apps Script for modal dropdown
let activeMatchIdx  = null; // which match card is being resolved


// ── Auth ──────────────────────────────────────────────────────────────────────

async function ensureAuth() {
  for (;;) {
    if (API_TOKEN) {
      try {
        const r = await fetch(`${API}?action=ping&token=${encodeURIComponent(API_TOKEN)}`);
        if ((await r.json()).ok) return;
      } catch (e) { /* fall through */ }
    }
    const input = prompt('Contraseña:');
    if (input === null) {
      document.body.innerHTML = '<p style="text-align:center;margin-top:4rem;font-family:sans-serif">Acceso denegado.</p>';
      throw new Error('unauthenticated');
    }
    API_TOKEN = input.trim();
    localStorage.setItem('vp_token', API_TOKEN);
  }
}


// ── File handling ─────────────────────────────────────────────────────────────

function handleZoneClick() {
  // If neither file selected yet, pick CSV first
  if (!csvFile) { document.getElementById('csv-input').click(); return; }
  if (!pdfFile) { document.getElementById('pdf-input').click(); return; }
  // Both selected — clicking again re-picks CSV
  document.getElementById('csv-input').click();
}

function handleFile(type, file) {
  if (!file) return;
  if (type === 'csv') {
    csvFile = file;
  } else {
    pdfFile = file;
  }
  updateDropZone();
  hideError();
  document.getElementById('run-btn').disabled = !(csvFile && pdfFile);
}

function updateDropZone() {
  const zone   = document.getElementById('drop-zone');
  const status = document.getElementById('drop-status');
  const label  = document.getElementById('drop-label');
  const hint   = document.getElementById('drop-hint');
  const icon   = document.getElementById('drop-icon');

  const chips = [];
  if (csvFile) chips.push(`<span class="drop-file-chip csv">📋 ${escHtml(csvFile.name)}</span>`);
  if (pdfFile) chips.push(`<span class="drop-file-chip pdf">📦 ${escHtml(pdfFile.name)}</span>`);
  status.innerHTML = chips.join('');

  if (csvFile && pdfFile) {
    zone.classList.add('ready');
    icon.textContent  = '✓';
    label.textContent = 'Archivos listos';
    hint.textContent  = 'Haz clic para cambiar alguno';
  } else if (csvFile || pdfFile) {
    icon.textContent  = '📂';
    label.textContent = csvFile ? 'CSV listo — falta el PDF' : 'PDF listo — falta el CSV';
    hint.textContent  = 'Haz clic para agregar el archivo que falta';
  }
}

// Drag-and-drop on single zone
const zone = document.getElementById('drop-zone');
zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('drag-over'); });
zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
zone.addEventListener('drop', e => {
  e.preventDefault();
  zone.classList.remove('drag-over');
  Array.from(e.dataTransfer.files).forEach(file => {
    if (file.name.endsWith('.csv')) handleFile('csv', file);
    if (file.name.endsWith('.pdf')) handleFile('pdf', file);
  });
});


// ── Main import ───────────────────────────────────────────────────────────────

async function runImport() {
  await ensureAuth();
  hideError();
  hideSummary();

  const btn = document.getElementById('run-btn');
  btn.disabled = true;

  setProgress(true, 'Enviando archivos…', 15);

  try {
    const fd = new FormData();
    fd.append('csv', csvFile);
    fd.append('pdf', pdfFile);

    setProgress(true, 'Procesando… esto puede tardar 30–90 segundos', 40);

    const resp = await fetch(N8N_URL, {
      method:  'POST',
      headers: { 'X-VP-Token': VP_TOKEN },
      body:    fd,
    });

    setProgress(true, 'Recibiendo resultados…', 85);

    if (!resp.ok) {
      const txt = await resp.text();
      throw new Error(`Error ${resp.status}: ${txt}`);
    }

    const data = await resp.json();
    setProgress(true, 'Listo', 100);
    setTimeout(() => setProgress(false), 600);

    handleResult(data);

  } catch (err) {
    setProgress(false);
    showError(err.message || 'Error desconocido');
    btn.disabled = false;
  }
}


// ── Handle result ─────────────────────────────────────────────────────────────

function handleResult(data) {
  const s = data.summary || {};

  // Store for re-download + modal
  lastPdfBase64 = data.pdf_base64 || null;
  lastMatches   = data.possible_matches || [];

  // Summary card
  document.getElementById('s-inserted').textContent = s.inserted ?? 0;
  document.getElementById('s-dupes').textContent    = s.duplicates ?? 0;
  document.getElementById('s-matches').textContent  = s.possible_matches ?? 0;
  document.getElementById('summary-card').style.display = 'block';

  // Auto-open PDF immediately
  if (lastPdfBase64) {
    openAndDownloadPDF();
  }

  // Possible matches
  if (lastMatches.length > 0) {
    renderMatches(lastMatches);
    document.getElementById('matches-section').style.display = 'block';
    fetchCustomersForModal();
  }

  // New customers created
  const newC = data.new_customers || [];
  if (newC.length > 0) {
    const list = document.getElementById('new-customers-list');
    list.innerHTML = newC.map(c =>
      `<span class="new-customer-chip">✓ ${escHtml(c.username)}</span>`
    ).join('');
    document.getElementById('new-customers-section').style.display = 'block';
  }

  showToast(`Importación completa — ${s.inserted} órden(es) insertada(s)`);
}


// ── PDF open + download ───────────────────────────────────────────────────────

function openAndDownloadPDF() {
  if (!lastPdfBase64) return;
  const bytes = Uint8Array.from(atob(lastPdfBase64), c => c.charCodeAt(0));
  const blob  = new Blob([bytes], { type: 'application/pdf' });
  const url   = URL.createObjectURL(blob);

  // Open in browser (Chrome opens PDF natively; also triggers OS default viewer)
  window.open(url, '_blank');

  // Also trigger a download
  const a = Object.assign(document.createElement('a'), {
    href:     url,
    download: `guias_anotadas_${new Date().toISOString().slice(0,10)}.pdf`,
  });
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);

  // Don't revoke immediately — keep blob alive for the opened tab
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

function downloadPDF() {
  openAndDownloadPDF();
}


// ── Possible matches ──────────────────────────────────────────────────────────

function renderMatches(matches) {
  const list = document.getElementById('matches-list');
  list.innerHTML = matches.map((m, i) => `
    <div class="match-card" id="match-card-${i}">
      <div class="match-card-top">
        <div class="match-username">@${escHtml(m.username)}</div>
        <div class="match-score">${m.score}% similitud</div>
      </div>
      <div class="match-row">Posible match: <strong>${escHtml(m.matched_to)}</strong></div>
      <div class="match-row">Tracking: <strong>${escHtml(m.tracking_id)}</strong></div>
      <div class="match-actions">
        <button class="match-btn primary" onclick="openMatchModal(${i})">Ver detalle</button>
        <button class="match-btn" onclick="toggleAssignDropdown(${i})">Asignar alias ▾</button>
      </div>
      <div class="match-assign-wrap" id="match-assign-${i}">
        <select id="match-select-${i}">
          <option value="">— Cargando clientes… —</option>
        </select>
        <button class="match-assign-confirm" onclick="confirmAssign(${i})">Confirmar asignación</button>
      </div>
      <div class="match-assigned" id="match-assigned-${i}">✓ Alias asignado</div>
    </div>
  `).join('');
}

function toggleAssignDropdown(i) {
  const wrap = document.getElementById(`match-assign-${i}`);
  const isOpen = wrap.style.display === 'block';
  wrap.style.display = isOpen ? 'none' : 'block';
  if (!isOpen) populateSelectDropdown(`match-select-${i}`);
}

async function fetchCustomersForModal() {
  try {
    const r = await fetch(`${API}?action=customers&token=${encodeURIComponent(API_TOKEN)}`);
    const data = await r.json();
    allCustomers = data.records || [];
  } catch (e) {
    allCustomers = [];
  }
}

function populateSelectDropdown(selectId) {
  const sel = document.getElementById(selectId);
  if (!sel) return;
  sel.innerHTML = '<option value="">— Seleccionar cliente —</option>' +
    allCustomers.map(c =>
      `<option value="${escHtml(c['Customer ID'])}">${escHtml(c['Primary Username'])} (${escHtml(c['Customer ID'])})</option>`
    ).join('');
}

async function confirmAssign(i) {
  const sel   = document.getElementById(`match-select-${i}`);
  const custId = sel ? sel.value : '';
  if (!custId) { showToast('Selecciona un cliente primero', true); return; }
  const match = lastMatches[i];
  await doAddAlias(match.username, custId, i);
}

async function confirmModalAssign() {
  const custId = document.getElementById('modal-customer-select').value;
  if (!custId) { showToast('Selecciona un cliente primero', true); return; }
  const match = lastMatches[activeMatchIdx];
  await doAddAlias(match.username, custId, activeMatchIdx);
  closeModal();
}

async function doAddAlias(username, customerId, cardIdx) {
  try {
    const r = await fetch(API, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        action:      'add_alias',
        token:       API_TOKEN,
        customer_id: customerId,
        alias:       username,
      }),
    });
    const data = await r.json();
    if (data.error) throw new Error(data.error);

    // Stamp the customer ID on the unresolved orders
    await fetch(API, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        action: 'stamp_customer_ids',
        token:  API_TOKEN,
      }),
    });

    // Mark card as done
    const assigned = document.getElementById(`match-assigned-${cardIdx}`);
    if (assigned) assigned.style.display = 'block';
    const wrap = document.getElementById(`match-assign-${cardIdx}`);
    if (wrap) wrap.style.display = 'none';

    showToast(`@${username} asignado como alias`);
  } catch (err) {
    showToast(`Error al asignar: ${err.message}`, true);
  }
}


// ── Match modal ───────────────────────────────────────────────────────────────

function openMatchModal(i) {
  activeMatchIdx = i;
  const m = lastMatches[i];
  const e = m.enriched || {};

  document.getElementById('modal-username').textContent  = `@${m.username}`;
  document.getElementById('modal-score').textContent     = `${m.score}%`;
  document.getElementById('modal-matched-to').textContent = m.matched_to || '—';

  const name = [e['First Name'], e['Surname']].filter(Boolean).join(' ');
  setModalField('modal-name',    name);
  setModalField('modal-address', e['Street + Number']);
  setModalField('modal-location',
    [e['City'], e['State'], e['ZIP']].filter(Boolean).join(' / ')
  );
  setModalField('modal-phone', e['Phone Partial']);

  // Populate dropdown
  const sel = document.getElementById('modal-customer-select');
  sel.innerHTML = '<option value="">— Seleccionar cliente —</option>' +
    allCustomers.map(c =>
      `<option value="${escHtml(c['Customer ID'])}">${escHtml(c['Primary Username'])} (${escHtml(c['Customer ID'])})</option>`
    ).join('');

  // Pre-select the suggested match
  if (m.matched_to) {
    const found = allCustomers.find(c => c['Primary Username'] === m.matched_to);
    if (found) sel.value = found['Customer ID'];
  }

  document.getElementById('match-modal').classList.add('open');
}

function closeModal() {
  document.getElementById('match-modal').classList.remove('open');
  activeMatchIdx = null;
}

function setModalField(id, val) {
  const el = document.getElementById(id);
  if (!el) return;
  if (val) {
    el.textContent = val;
    el.classList.remove('empty');
  } else {
    el.textContent = 'No disponible';
    el.classList.add('empty');
  }
}

// Close modal on overlay click
document.getElementById('match-modal').addEventListener('click', function(e) {
  if (e.target === this) closeModal();
});

// Close modal on Esc
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') closeModal();
});


// ── UI helpers ────────────────────────────────────────────────────────────────

function setProgress(visible, label = '', pct = 0) {
  document.getElementById('progress-wrap').style.display  = visible ? 'block' : 'none';
  document.getElementById('progress-label').style.display = visible ? 'block' : 'none';
  document.getElementById('progress-bar').style.width     = `${pct}%`;
  document.getElementById('progress-label').textContent   = label;
}

function hideSummary() {
  document.getElementById('summary-card').style.display         = 'none';
  document.getElementById('matches-section').style.display      = 'none';
  document.getElementById('new-customers-section').style.display = 'none';
}

function showError(msg) {
  const box = document.getElementById('error-box');
  box.textContent = `Error: ${msg}`;
  box.style.display = 'block';
}

function hideError() {
  document.getElementById('error-box').style.display = 'none';
}

function showToast(msg, isError = false) {
  const t = document.getElementById('toast');
  t.textContent  = msg;
  t.style.background = isError ? 'var(--red-text)' : '';
  t.classList.add('show');
  setTimeout(() => { t.classList.remove('show'); t.style.background = ''; }, 3000);
}

function escHtml(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
