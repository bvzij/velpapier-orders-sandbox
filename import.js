// import.js — Vel Papier · Importar v2 (2026-10-23)
// Flow: 1) Importar (CSV + PDF -> n8n "tiktok-import" -> VPS /process -> Apps Script)
//       2) Configure this import (sort, Lápiz, NO POSTAL, extras, Notas, fun fact)
//       3) Generar PDF (n8n "importar-api" -> VPS /importar op=render), then the
//          printed extras are marked Anotado + linked (Apps Script import_finalize).
// History (7 days) keeps the original files, the import result and the outputs
// in Drive, so any import can be re-opened and re-generated without re-importing.

const N8N_URL          = 'https://n8n.srv2017849.hstgr.cloud/webhook/tiktok-import';
const N8N_IMPORTAR_URL = 'https://n8n.srv2017849.hstgr.cloud/webhook/importar-api';

const DEFAULTS = {
  slip: { font: 'atkinson', name_size: 7.5, sku_size: 8.5, seller_size: 8.5, qty_size: 11, header_size: 7,
          total_size: 12, note_size: 9, order_size: 7.5, extras_size: 8.5, lapiz_size: 26,
          lapiz_text: 'Lápiz Infinito', deadline_size: 15, footer_id_size: 9, user_size: 12, row_note_size: 8,
          item_line_width: 0.8, item_line_style: 'solid' },
  sticker: { font: 'roboto', width_mm: 50, height_mm: 25, margin_top: 2, margin_right: 2.5, margin_bottom: 2,
             margin_left: 2.5, title_size: 9, answer_size: 7.5, align: 'center', gap_mm: 0.8 },
  // invert: TikTok's printer stacks the first printed page at the bottom, so the
  // file is written in reverse to get the chosen order from the top (same as before).
  // group: none | newexist | extras | combined (new + existing, each split with/without extras)
  // group_first: 'a' = the first option of the grouping (Nuevos, or Con extras)
  // sub_first: 'a' = with extras first, inside each group (combined only)
  print: { sort: 'az', group: 'none', group_first: 'a', sub_first: 'a', blank_between: false, invert: true, lapiz: true },
};

let csvFile = null;
let pdfFile = null;

const S = {
  settings: JSON.parse(JSON.stringify(DEFAULTS)),
  settingsLoaded: false,
  importId: '',
  csvName: '', pdfName: '',
  csvB64: '', pdfB64: '',
  result: null,        // phase-1 response (without the big base64 fields once stored)
  legacyPdf: '',       // old-style annotated PDF from phase 1 (emergency only)
  combinedCsv: '',
  meta: [],            // shipments_meta
  ctx: null,           // import_context
  log: {},             // Import Log row
  opts: null,          // print options for THIS import
  extraSel: {},        // order_id -> {checked, tid}
  notaEdit: {},        // NOTA-... -> {text, assigned}
  giftUi: {},          // NOTA-... -> {open, q, recipient:{id,username}|null, newName}
  giftBusy: false,
  render: null,        // {report, pdf, plan, at, manual}
  dupeFilter: 'all',   // 'all' | 'new_only' -- hide shipments whose Tracking ID already exists in Orders
  facts: null,
  factId: '',
  copies: null,
  busy: false,
};

// ── small helpers ─────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const esc = s => VP.esc(s == null ? '' : s);
const plural = (n, a, b) => `${n} ${n === 1 ? a : b}`;

function fileToB64(file) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result).split(',')[1] || '');
    r.onerror = () => rej(new Error('No se pudo leer ' + file.name));
    r.readAsDataURL(file);
  });
}
function textToB64(t) { return btoa(unescape(encodeURIComponent(t))); }
function b64ToText(b) { return decodeURIComponent(escape(atob(b))); }
function b64ToBlob(b64, mime) {
  const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
  return new Blob([bytes], { type: mime });
}
function openPdf(b64, filename) {
  const url = URL.createObjectURL(b64ToBlob(b64, 'application/pdf'));
  window.open(url, '_blank');
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 120000);
}
function downloadB64(b64, mime, filename) {
  const url = URL.createObjectURL(b64ToBlob(b64, mime));
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
function mxStamp() {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Mexico_City', year: 'numeric', month: '2-digit',
    day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).formatToParts(new Date());
  const g = t => (p.find(x => x.type === t) || {}).value || '00';
  return `${g('year')}${g('month')}${g('day')}-${g('hour')}${g('minute')}${g('second')}`;
}
function normUser(u) { return String(u || '').trim().replace(/^@/, '').toLowerCase(); }
function showToast(msg, isError = false) { VP.toast ? VP.toast(msg, isError) : alert(msg); }
function showError(msg) { const b = $('error-box'); b.innerHTML = esc(msg); b.style.display = 'block'; }
function hideError() { $('error-box').style.display = 'none'; }
function setProgress(visible, label = '', pct = 0) {
  $('progress-wrap').style.display = visible ? 'block' : 'none';
  $('progress-label').style.display = visible ? 'block' : 'none';
  $('progress-bar').style.width = `${pct}%`;
  $('progress-label').textContent = label;
}
function extractErrorMessage(rawText) {
  try {
    const j = JSON.parse(rawText);
    if (j.detail && j.detail.error_message) return j.detail.error_message + (j.detail.where ? ` (${j.detail.where})` : '');
    if (typeof j.detail === 'string') return j.detail;
    if (j.error) return j.error;
    if (j.message) return j.message;
  } catch (e) { /* not JSON */ }
  return String(rawText || '').slice(0, 300) || 'respuesta vacía';
}

// The new n8n workflow "importar-api" forwards JSON to the VPS (/importar).
async function callImporter(body) {
  const r = await fetch(N8N_IMPORTAR_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-VP-Session': VP.token },
    body: JSON.stringify(body),
  });
  const txt = await r.text();
  // TROUBLESHOOT: 404 = the n8n workflow "Importar API" is not published;
  // 401 = session expired (reload); 500 = open the n8n execution log.
  if (!r.ok) throw new Error(`Servidor de PDF (${r.status}): ${extractErrorMessage(txt)}`);
  let j;
  try { j = JSON.parse(txt); } catch (e) { throw new Error('Respuesta inválida del servidor de PDF'); }
  if (j && j.error) throw new Error(j.error);
  return j;
}

// ── tabs ──────────────────────────────────────────────────────────────────
function tab(name) {
  document.querySelectorAll('.imp-tab').forEach(b => b.classList.toggle('is-active', b.dataset.tab === name));
  document.querySelectorAll('.imp-pane').forEach(p => p.classList.toggle('is-active', p.id === 'pane-' + name));
  if (name === 'historial') loadHistory();
  if (name === 'datos') loadFacts().then(renderFactsPane);
  if (name === 'ajustes') renderSettings();
}

// ── settings (server-side, shared by every device) ───────────────────────
async function loadSettings() {
  try {
    const r = await VP.get('action=importar_settings_get');
    const s = r.settings || {};
    ['slip', 'sticker', 'print'].forEach(k => { S.settings[k] = Object.assign({}, DEFAULTS[k], s[k] || {}); });
  } catch (e) {
    console.warn('[importar] settings load failed', e);
  }
  S.settingsLoaded = true;
}

// ── file handling ─────────────────────────────────────────────────────────
function handleZoneClick() { $('file-input').click(); }
function handleFileInput(files) {
  Array.from(files).forEach(file => {
    const n = file.name.toLowerCase();
    if (n.endsWith('.csv')) handleFile('csv', file);
    else if (n.endsWith('.pdf')) handleFile('pdf', file);
  });
}
function handleFile(type, file) {
  if (!file) return;
  if (type === 'csv') csvFile = file; else pdfFile = file;
  updateDropZone();
  hideError();
  $('run-btn').disabled = !(csvFile && pdfFile);
}
function updateDropZone() {
  const zone = $('drop-zone'), label = $('drop-label'), hint = $('drop-hint'), icon = $('drop-icon');
  const chips = [];
  if (csvFile) chips.push(`<span class="drop-file-chip csv">📄 ${esc(csvFile.name)}</span>`);
  if (pdfFile) chips.push(`<span class="drop-file-chip pdf">📦 ${esc(pdfFile.name)}</span>`);
  $('drop-status').innerHTML = chips.join('');
  if (csvFile && pdfFile) {
    zone.classList.add('ready'); icon.textContent = '✅';
    label.textContent = 'Archivos listos'; hint.textContent = 'Haz clic para cambiarlos';
  } else if (csvFile || pdfFile) {
    zone.classList.remove('ready'); icon.textContent = '📂';
    label.textContent = csvFile ? 'CSV listo — falta el PDF' : 'PDF listo — falta el CSV';
    hint.textContent = 'Arrastra o haz clic para agregar el archivo que falta';
  }
}
(function wireDrop() {
  const zone = $('drop-zone');
  zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('drag-over'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
  zone.addEventListener('drop', e => { e.preventDefault(); zone.classList.remove('drag-over'); handleFileInput(e.dataTransfer.files); });
})();

window.addEventListener('beforeunload', e => {
  if (S.result && !S.render) { e.preventDefault(); e.returnValue = ''; }
});

// ── 1) IMPORT ─────────────────────────────────────────────────────────────
async function runImport() {
  await VP.ensureToken();
  hideError();
  resetImportUi();
  const btn = $('run-btn');
  btn.disabled = true;
  try {
    if (!S.settingsLoaded) await loadSettings();
    S.importId = 'IMP-' + mxStamp();
    S.csvName = csvFile.name; S.pdfName = pdfFile.name;
    setProgress(true, 'Leyendo archivos…', 8);
    S.csvB64 = await fileToB64(csvFile);
    S.pdfB64 = await fileToB64(pdfFile);
    const fd = new FormData();
    fd.append('csv', csvFile);
    fd.append('pdf', pdfFile);
    setProgress(true, 'Importando… esto puede tardar 30–90 segundos', 35);
    const resp = await fetch(N8N_URL, { method: 'POST', headers: { 'X-VP-Session': VP.token }, body: fd });
    setProgress(true, 'Recibiendo resultados…', 80);
    if (!resp.ok) throw new Error(`Error ${resp.status}: ${extractErrorMessage(await resp.text())}`);
    const data = await resp.json();
    setProgress(true, 'Cargando pedidos pendientes de los clientes…', 90);
    await startImport(data, { reopen: false });
    setProgress(false);
  } catch (err) {
    setProgress(false);
    showError(err.message || 'Error desconocido');
    btn.disabled = false;
  }
}

function resetImportUi() {
  ['summary-card', 'matches-section', 'new-customers-section', 'configure'].forEach(id => { $(id).style.display = 'none'; });
  Object.assign(S, { result: null, legacyPdf: '', combinedCsv: '', meta: [], ctx: null, log: {}, opts: null,
    extraSel: {}, notaEdit: {}, giftUi: {}, render: null, factId: '', copies: null });
}

async function startImport(data, opts) {
  S.legacyPdf = data.pdf_base64 || '';
  S.combinedCsv = data.csv_base64 || '';
  const slim = Object.assign({}, data);
  delete slim.pdf_base64; delete slim.csv_base64;
  S.result = slim;
  S.meta = (data.shipments_meta || []);
  S.dupeFilter = 'all';
  S.opts = Object.assign({}, DEFAULTS.print, S.settings.print, (S.log && S.log['Settings'] && S.log['Settings'].print) || {});

  const s = data.summary || {};
  $('s-import-id').textContent = '· ' + S.importId;
  $('s-inserted').textContent = s.inserted ?? 0;
  $('s-dupes').textContent = s.duplicates ?? 0;
  $('s-matches').textContent = s.possible_matches ?? 0;
  $('summary-card').style.display = 'block';

  const matches = data.possible_matches || [];
  if (matches.length) {
    lastMatches = matches;
    $('matches-section').style.display = 'block';
    fetchCustomersForModal().then(() => renderMatches(lastMatches));
  }
  
  if (!data.shipments_meta) {
    // TROUBLESHOOT: the VPS still runs the old service.py (no shipments_meta).
    // Redo the VPS step of the deploy guide. Meanwhile the old PDF works.
    showError('El servidor (VPS) aún no tiene la versión nueva. Puedes descargar el PDF anotado como antes.');
    $('configure').style.display = 'block';
    $('configure').innerHTML = legacyButtonsHtml();
    return;
  }
  if (data.warnings && data.warnings.length) showError('⚠ ' + data.warnings.join(' · '));

  await loadContext();
  initSelections();
  renderPendingNew();
  renderConfigure();
  if (opts.reopen) goReview(); else showImportModal();
  if (!opts.reopen) saveImportToHistory();
}

// Step 2 lives under the summary on the Importar tab: jump straight to it.
function goReview() {
  tab('importar');
  setTimeout(() => {
    const el = $('configure');
    if (el && el.style.display !== 'none') el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, 60);
}

// Pop-up right after an import: the numbers + the way to step 2.
function showImportModal() {
  const c = counts();
  const list = infos();
  const fb = list.filter(i => i.slip && i.slip.ok === false).length;
  const notas = (S.ctx.notas || []).length;
  const pending = (S.ctx.candidates || []).filter(x => x.status !== 'Anotado').length;
  const sum = S.result.summary || {};
  const matches = sum.possible_matches || 0;
  const m = VP.showModal(`
    <h3 style="margin:0 0 4px;font-size:16px">✓ Importación lista</h3>
    <div class="imp-muted" style="margin-bottom:10px">${esc(S.importId)}</div>
    <div class="imp-stats">
      <div class="imp-stat"><b>${sum.inserted ?? 0}</b><span>Insertadas</span></div>
      <div class="imp-stat"><b>${sum.duplicates ?? 0}</b><span>Duplicadas</span></div>
      <div class="imp-stat"><b>${c.newC}</b><span>Clientes nuevos</span></div>
      <div class="imp-stat"><b>${c.existingC}</b><span>Existentes</span></div>
      <div class="imp-stat"><b>${c.postcards}</b><span>Postales</span></div>
      <div class="imp-stat"><b>${notas}</b><span>Notas</span></div>
      <div class="imp-stat"><b>${pending}</b><span>Extras pendientes</span></div>
    </div>
    ${matches ? `<div class="imp-warn">⚠ ${plural(matches, 'posible cliente duplicado', 'posibles clientes duplicados')}: resuélvelos antes de generar el PDF.</div>` : ''}
    ${c.unknownC ? `<div class="imp-warn">⚠ ${plural(c.unknownC, 'envío sin cliente asignado', 'envíos sin cliente asignado')}.</div>` : ''}
    ${fb ? `<div class="imp-bad">${plural(fb, 'hoja saldrá', 'hojas saldrán')} en formato básico (el motivo aparece en el paso 2).</div>` : ''}
    <div class="imp-muted" style="margin-top:10px">Siguiente paso: revisar los ajustes de esta importación y generar el PDF.</div>
    <div class="imp-btns"><button class="imp-btn primary" id="imp-go">Revisar y generar PDF</button></div>`, { maxWidth: '520px' });
  m.el.querySelector('#imp-go').addEventListener('click', () => { m.close(); goReview(); });
}

// Phase-1 results + original files go to the 7-day history in the background.
let uploadChain = Promise.resolve();
function setUploadState(t) { const el = $('upload-state'); if (el) el.textContent = t; }
function queueUpload(kind, name, mime, b64) {
  uploadChain = uploadChain.then(async () => {
    setUploadState(`Guardando en historial: ${name}…`);
    try {
      await VP.post({ action: 'import_file_save', import_id: S.importId, kind, name, mime, base64: b64 });
      setUploadState('✓ Guardado en historial');
    } catch (e) {
      // TROUBLESHOOT: Drive upload failed (Apps Script import_file_save). The
      // import itself is fine; only "Reabrir" from Historial won't have this file.
      setUploadState(`⚠ No se guardó ${name} en el historial: ${e.message}`);
    }
  });
  return uploadChain;
}
function logFields(fields) {
  return VP.post({ action: 'import_log_save', import_id: S.importId, fields })
    .then(r => { if (r && r.log) S.log = r.log; })
    .catch(e => console.warn('[importar] log save failed', e));
}
function saveImportToHistory() {
  const c = counts();
  logFields({
    'CSV Name': S.csvName, 'PDF Name': S.pdfName, 'Shipments': c.shipments,
    'Inserted': (S.result.summary || {}).inserted || 0, 'Duplicates': (S.result.summary || {}).duplicates || 0,
    'New Customers': c.newC, 'Existing Customers': c.existingC, 'Unknown Customers': c.unknownC, 'Postcards': c.postcards,
  });
  queueUpload('original_csv', S.csvName, 'text/csv', S.csvB64);
  queueUpload('original_pdf', S.pdfName, 'application/pdf', S.pdfB64);
  queueUpload('result', 'resultado.json', 'application/json', textToB64(JSON.stringify(S.result)));
}

async function loadContext() {
  const ships = S.meta.filter(m => m.in_pdf);
  const usernames = {};
  ships.forEach(m => { usernames[m.tracking_id] = m.username; });
  try {
    S.ctx = await VP.post({ action: 'import_context', tracking_ids: ships.map(m => m.tracking_id), usernames });
  } catch (e) {
    S.ctx = { shipments: {}, candidates: [], notas: [] };
    showError('No se pudieron cargar los pedidos pendientes: ' + e.message);
  }
}

// ── model ─────────────────────────────────────────────────────────────────
function infos() {
  return S.meta.filter(m => m.in_pdf && (S.dupeFilter !== 'new_only' || m.inserted !== false)).map(m => {
    const c = (S.ctx && S.ctx.shipments && S.ctx.shipments[m.tracking_id]) || {};
    const cust = c.customer_id || m.customer_id || '';
    let count = (c.shipment_count !== undefined && c.shipment_count !== null) ? c.shipment_count : m.shipment_count;
    // Customer not created yet (created when the PDF is generated): new customer, first shipment.
    const pending = !cust && m.tier === 'pending_new';
    if (pending) count = 0;
    else if (!cust || count === undefined) count = null;
    return {
      pending, tid: m.tracking_id, username: m.username || '', cust, count,
      kind: count === null ? 'unknown' : count === 0 ? 'new' : 'existing',
      ship_by: c.ship_by || m.ship_by || '', deadline: m.deadline, slip: m.slip || {}, order_ids: m.order_ids || [],
      primary_username: c.primary_username || '', dup: m.inserted === false,
    };
  });
}

// Tracking IDs hidden by the "Solo nuevas" filter -- these must still be
// explicitly excluded when generating, so the VPS "never drop a page it
// found in the source PDF" safety net doesn't silently print them anyway.
function dupExcludedTids() {
  if (S.dupeFilter !== 'new_only') return [];
  return S.meta.filter(m => m.in_pdf && m.inserted === false).map(m => m.tracking_id);
}
function countLabel(i) { return i.count === null ? '? env' : i.count === 0 ? 'Nuevo' : `${i.count} env`; }

function custTids(list) {
  const m = {};
  list.forEach(i => { if (i.cust) (m[i.cust] = m[i.cust] || []).push(i.tid); });
  return m;
}

// candidate -> customer of this import (Customer ID, or username for unlinked Manual rows)
function candidateCust(c, list) {
  if (c.customer_id) return c.customer_id;
  const u = normUser(c.username);
  const hit = list.find(i => normUser(i.username) === u || normUser(i.primary_username) === u);
  return hit ? (hit.cust || 'USER:' + hit.tid) : '';
}

function initSelections() {
  const list = infos();
  const ct = custTids(list);
  const tids = new Set(list.map(i => i.tid));
  S.extraSel = {};
  (S.ctx.candidates || []).forEach(c => {
    const cust = candidateCust(c, list);
    const options = cust.startsWith('USER:') ? [cust.slice(5)] : (ct[cust] || []);
    const prelinked = c.status === 'Anotado' && tids.has(c.linked_shipment);
    S.extraSel[c.order_id] = {
      checked: prelinked,
      tid: prelinked ? c.linked_shipment : (options.length === 1 ? options[0] : ''),
      prelinked,
    };
  });
  S.notaEdit = {};
  (S.ctx.notas || []).forEach(n => { S.notaEdit[n.order_id] = { text: n.text, keys: parseList(n.assigned), giftQty: {} }; });
  S.factId = (S.log && S.log['Fun Fact ID']) || '';
}

function extrasCountByTid() {
  const m = {};
  Object.entries(S.extraSel).forEach(([oid, s]) => { if (s.checked && s.tid) m[s.tid] = (m[s.tid] || 0) + 1; });
  return m;
}

// Stack order = order of the printed pile, top first.
function stack() {
  const o = S.opts;
  const list = infos();
  const byName = (a, b) => a.username.localeCompare(b.username, 'es', { sensitivity: 'base' }) || a.tid.localeCompare(b.tid);
  let cmp = byName;
  if (o.sort === 'za') cmp = (a, b) => -byName(a, b);
  if (o.sort === 'deadline') cmp = (a, b) => (a.ship_by || '9999').localeCompare(b.ship_by || '9999') || byName(a, b);
  const sorted = [...list].sort(cmp);
  const ex = extrasCountByTid();
  const hasEx = i => !!ex[i.tid];
  const pair = (x, y) => (o.group_first === 'b' ? [y, x] : [x, y]);
  const subPair = arr => {
    const withEx = arr.filter(hasEx), plain = arr.filter(i => !hasEx(i));
    const withSub = { label: 'Con extras', items: withEx }, plainSub = { label: 'Sin extras', items: plain };
    return o.sub_first === 'b' ? [plainSub, withSub] : [withSub, plainSub];
  };
  // sections: printed one after another; blank page between sections if chosen
  let sections;
  if (o.group === 'newexist') {
    sections = pair({ label: 'Nuevos', subs: [{ label: '', items: sorted.filter(i => i.kind === 'new') }] },
                    { label: 'Existentes', subs: [{ label: '', items: sorted.filter(i => i.kind !== 'new') }] });
  } else if (o.group === 'extras') {
    sections = pair({ label: 'Con productos extra', subs: [{ label: '', items: sorted.filter(hasEx) }] },
                    { label: 'Sin extras', subs: [{ label: '', items: sorted.filter(i => !hasEx(i)) }] });
  } else if (o.group === 'combined') {
    sections = pair({ label: 'Nuevos', subs: subPair(sorted.filter(i => i.kind === 'new')) },
                    { label: 'Existentes', subs: subPair(sorted.filter(i => i.kind !== 'new')) });
  } else {
    sections = [{ label: '', subs: [{ label: '', items: sorted }] }];
  }
  const groups = [];
  sections.forEach((sec, si) => sec.subs.forEach(sub => {
    if (!sub.items.length) return;
    groups.push({ label: sec.label && sub.label ? sec.label + ' · ' + sub.label : (sec.label || sub.label), items: sub.items, section: si });
  }));
  // One postcard / one Lápiz per CUSTOMER: the first of their shipments in the pile.
  const seen = {};
  groups.forEach(g => g.items.forEach(i => {
    i.primary = !i.cust || !seen[i.cust];
    if (i.cust) seen[i.cust] = true;
    i.no_postal = i.kind === 'existing' && !i.primary;
    i.lapiz = !!o.lapiz && i.kind === 'new' && i.primary;
  }));
  return groups;
}

function counts() {
  const list = infos();
  const custKind = {};
  list.forEach(i => { if (i.cust) custKind[i.cust] = i.kind; });
  const kinds = Object.values(custKind);
  const pendingNames = new Set(list.filter(i => i.pending).map(i => normUser(i.username)));
  return {
    shipments: list.length,
    newC: kinds.filter(k => k === 'new').length + pendingNames.size,
    existingC: kinds.filter(k => k === 'existing').length,
    unknownC: list.filter(i => !i.cust && !i.pending).length,
    postcards: kinds.filter(k => k === 'existing').length,
  };
}

function candidateById(oid) { return (S.ctx.candidates || []).find(c => c.order_id === oid); }

function extraTitle(c) {
  const n = VP.itemCount(c.products);
  if (c.channel === 'Shopify') {
    const num = String(c.shopify_order_number || '').replace(/^#/, '');
    return `Shopify ${num ? '#' + num : ''} · ${plural(n, 'producto', 'productos')}`.replace('  ', ' ');
  }
  if (c.channel === 'Nota') return 'Nota';
  return `Manual · ${plural(n, 'producto', 'productos')}`;
}
// Lines for the slip: one item per product; a note sits under the order's last product.
function extraItems(c) {
  if (c.channel === 'Nota') return [{ text: c.products, note: '' }];
  const items = VP.parseProducts(c.products).map(p => ({ text: `${p.qty}× ${p.name}`, note: '' }));
  if (c.notes && !/^https?:\/\//.test(c.notes.trim()) && items.length) {
    items[items.length - 1].note = 'Nota: ' + c.notes;
  }
  return items;
}
function extraLines(c) {
  if (c.channel === 'Nota') return [c.products];
  const lines = VP.parseProducts(c.products).map(p => `${p.qty}× ${p.name}`);
  if (c.notes && !/^https?:\/\//.test(c.notes.trim())) lines.push('Nota: ' + c.notes);
  return lines;
}

// ── configure UI ──────────────────────────────────────────────────────────
// Print-order controls. mode 'import' changes this import only (S.opts);
// mode 'settings' edits the defaults that every new import starts from.
function printOptionsHtml(mode) {
  const isSet = mode === 'settings';
  const o = isSet ? S.settings.print : S.opts;
  const grouped = o.group !== 'none';
  const combined = o.group === 'combined';
  const first = o.group === 'extras' ? ['Con extras', 'Sin extras'] : ['Nuevos', 'Existentes'];
  const attr = (k, isCheck) => isSet
    ? `id="set-print-${k}" onchange="IMP.settingsChanged()"`
    : `data-k="${k}" data-c="${isCheck ? 1 : 0}" onchange="IMP.setOptEl(this)"`;
  const sel = (k, label, opts, disabled) => `<label>${label}<select ${attr(k)}${disabled ? ' disabled' : ''}>${
    opts.map(([v, t]) => `<option value="${v}"${String(o[k]) === v ? ' selected' : ''}>${t}</option>`).join('')}</select></label>`;
  const chk = (k, label, disabled) => `<label>${label} <input type="checkbox" ${attr(k, true)} ${o[k] ? 'checked' : ''}${disabled ? ' disabled' : ''} style="width:auto"></label>`;
  return `<div class="imp-grid">
    ${sel('sort', 'Orden', [['az', 'A → Z (usuario TikTok)'], ['za', 'Z → A (usuario TikTok)'], ['deadline', 'Fecha límite (la más próxima)']])}
    ${sel('group', 'Agrupar', [['none', 'Sin agrupar'], ['newexist', 'Nuevos / existentes'], ['extras', 'Con / sin extras'], ['combined', 'Nuevos y existentes, cada uno con / sin extras']])}
    ${sel('group_first', 'Primer grupo', [['a', first[0] + ' primero'], ['b', first[1] + ' primero']], !grouped)}
    ${sel('sub_first', 'Dentro de cada grupo', [['a', 'Con extras primero'], ['b', 'Sin extras primero']], !combined)}
    ${chk('blank_between', 'Hoja en blanco entre grupos', !grouped)}
    ${chk('lapiz', '"' + esc(S.settings.slip.lapiz_text) + '" en clientes nuevos')}
    ${chk('invert', 'Invertir para la impresora (la primera hoja impresa queda abajo)')}
  </div>`;
}
function setOptEl(el) { setOpt(el.dataset.k, el.dataset.c === '1' ? el.checked : el.value); }
function settingsChanged() { S.settings = readSettingsForm(); renderSettings(); }

// ── Notas list: filter pills per customer, products of the order or of the whole shipment ──
function noteOwner(n, list) { return (list.find(x => x.tid === n.linked_shipment) || {}).username || '?'; }
// Products a note can be linked to. Default: the products of ITS order. "Todos": every product of the shipment.
function noteProducts(n, all) {
  const base = parseCands(n.candidates);
  if (!all) return base;
  const seen = new Set(base.map(c => c.label));
  const m = S.meta.find(x => x.tracking_id === n.linked_shipment) || {};
  const extra = [];
  (m.products || []).forEach(p => {
    const label = p.variation ? `${p.product} (${p.variation})` : p.product;
    if (!label || seen.has(label)) return;
    seen.add(label);
    extra.push({ label, product: p.product || '', variation: p.variation || '', seller_sku: '', qty: p.qty || 1 });
  });
  return base.concat(extra);
}
function notaBlockHtml(notas, list) {
  S.notaAll = S.notaAll || {};
  const owners = {};
  notas.forEach(n => { const u = noteOwner(n, list); owners[u] = (owners[u] || 0) + 1; });
  const filt = S.noteFilter && owners[S.noteFilter] ? S.noteFilter : 'all';
  S.noteFilter = filt;
  const shown = filt === 'all' ? notas : notas.filter(n => noteOwner(n, list) === filt);
  const pill = (key, label, count) => `<button data-f="${esc(key)}" onclick="IMP.noteFilter(this.dataset.f)" style="padding:4px 10px;border-radius:99px;font:inherit;font-size:12.5px;cursor:pointer;border:0.5px solid var(--border-strong);background:${filt === key ? 'var(--text)' : 'var(--surface)'};color:${filt === key ? 'var(--surface)' : 'var(--text)'}">${esc(label)} · ${count}</button>`;
  const pills = [pill('all', 'Todos', notas.length)].concat(Object.keys(owners).sort((x, y) => x.localeCompare(y, 'es')).map(u => pill(u, u, owners[u]))).join('');
  return `<div class="imp-card">
      <h3><span class="nota-tag">Nota</span> Mensajes en esta importación <small>· ${notas.length}</small></h3>
      <div style="display:flex;gap:6px;flex-wrap:wrap;margin:6px 0 10px">${pills}</div>
      <div class="imp-muted" style="margin-bottom:6px">Ya están en Pedidos como Anotado. Marca a qué producto(s) se refiere cada mensaje: en la hoja saldrá en negrita debajo de ese producto. Si un mensaje habla de varios productos, duplícalo y pon cada parte en su producto.</div>
      ${shown.map(n => noteBoxHtml(n, list)).join('')}
    </div>`;
}
// ── Regalo sin mensaje: gift for a product of a shipment that has no buyer/seller note ──
function giftShipResultsHtml() {
  const nq = normUser(S.giftShipQ || '');
  if (nq.length < 2) return '<div class="imp-muted">Escribe al menos 2 letras del usuario…</div>';
  const hits = infos().filter(i => normUser(i.username).includes(nq) || String(i.tid || '').includes(nq)).slice(0, 8);
  if (!hits.length) return '<div class="imp-muted">Ningún envío de esta importación coincide.</div>';
  return hits.map(i => `<div class="imp-list-item"><button class="imp-mini" data-tid="${esc(i.tid)}" onclick="IMP.giftShipPick(this.dataset.tid)">Elegir</button> ${esc(i.username)} <span class="imp-muted">· ${esc(i.tid)}</span></div>`).join('');
}
function giftPickerHtml(list) {
  const visible = new Set(list.map(i => i.tid));
  const virt = (S.virtualNotas || []).filter(n => visible.has(n.linked_shipment));
  return `<div class="imp-card">
    <h3>🎁 Regalo sin mensaje <small>· para un producto que no tiene nota del cliente ni del vendedor</small></h3>
    <input type="text" id="gift-ship-q" value="${esc(S.giftShipQ || '')}" placeholder="Usuario del cliente que hace el regalo" style="width:100%;box-sizing:border-box;padding:6px 8px;border:0.5px solid var(--border-strong);border-radius:8px;font:inherit;font-size:13px" oninput="IMP.giftShipSearch(this.value)">
    <div id="gift-ship-res">${giftShipResultsHtml()}</div>
    ${virt.map(n => noteBoxHtml(n, list)).join('')}
  </div>`;
}
function giftOnlyBoxHtml(n, list) {
  const ed = S.notaEdit[n.order_id] || { text: '', keys: [] };
  const i = list.find(x => x.tid === n.linked_shipment) || {};
  const prods = noteProducts(n, true);
  return `<div class="imp-nota">
    <b>${esc(i.username || '')}</b> · 🎁 Regalo sin mensaje
    <div style="margin-top:6px;font-size:12.5px"><b>¿Qué producto(s) del envío se regalan?</b></div>
    ${prods.length ? prods.map(p => `<label style="display:flex;gap:6px;align-items:flex-start;font-size:13px;margin:3px 0">
        <input type="checkbox" data-nota="${esc(n.order_id)}" data-label="${esc(p.label)}" ${(ed.keys || []).includes(p.label) ? 'checked' : ''}
          onchange="IMP.toggleNotaKey(this.dataset.nota, this.dataset.label, this.checked)" style="margin-top:3px">
        <span>${esc(p.label)}${(p.qty || 1) > 1 ? ` <span class="imp-muted">(${p.qty} pedidos)</span>` : ''}</span>
        ${(p.qty || 1) > 1 && (ed.keys || []).includes(p.label) ? `<span style="margin-left:auto;white-space:nowrap;font-size:12.5px">regalar
          <input type="number" min="1" max="${p.qty}" value="${giftQtyOf(ed, p)}" data-nota="${esc(n.order_id)}" data-label="${esc(p.label)}" data-max="${p.qty}"
            onchange="IMP.setGiftQty(this.dataset.nota, this.dataset.label, this.value, this.dataset.max)" style="width:56px;padding:3px 5px;border:0.5px solid var(--border-strong);border-radius:6px;font:inherit"></span>` : ''}</label>`).join('')
      : '<div class="imp-muted">Este envío no tiene productos en el CSV.</div>'}
    ${n.virtual ? `<div class="imp-btns" style="margin-top:6px"><button class="imp-mini" data-nota="${esc(n.order_id)}" onclick="IMP.giftVirtualClose(this.dataset.nota)">Quitar</button></div>` : ''}
    ${giftBoxHtml(n, list)}
  </div>`;
}
function noteBoxHtml(n, list) {
  if (n.source === 'Regalo') return giftOnlyBoxHtml(n, list);
  const ed = S.notaEdit[n.order_id] || { text: n.text, keys: parseList(n.assigned) };
  const i = list.find(x => x.tid === n.linked_shipment) || {};
  const all = !!(S.notaAll || {})[n.order_id];
  const prods = noteProducts(n, all);
  return `<div class="imp-nota">
    <b>${esc(i.username || '')}</b> · ${n.source === 'Vendedor' ? 'Nota del vendedor' : 'Mensaje del cliente'} · pedido ${esc(n.nota_pedido)}
    ${n.original && n.original !== ed.text ? `<div class="imp-muted">Original: ${esc(n.original)}</div>` : ''}
    <textarea data-nota="${esc(n.order_id)}" oninput="IMP.editNota(this.dataset.nota, this.value)">${esc(ed.text)}</textarea>
    <div style="margin-top:6px;font-size:12.5px"><b>¿A qué producto(s) se refiere?</b>
      <button data-nota="${esc(n.order_id)}" onclick="IMP.noteAll(this.dataset.nota)" style="margin-left:8px;font:inherit;font-size:12px;background:none;border:none;color:var(--blue-text, #185fa5);cursor:pointer;text-decoration:underline">${all ? 'Solo productos de este pedido' : 'Ver todos los productos del envío'}</button></div>
    ${prods.length ? prods.map(p => `<label style="display:flex;gap:6px;align-items:flex-start;font-size:13px;margin:3px 0">
        <input type="checkbox" data-nota="${esc(n.order_id)}" data-label="${esc(p.label)}" ${(ed.keys || []).includes(p.label) ? 'checked' : ''}
          onchange="IMP.toggleNotaKey(this.dataset.nota, this.dataset.label, this.checked)" style="margin-top:3px">
        <span>${esc(p.label)}${(p.qty || 1) > 1 ? ` <span class="imp-muted">(${p.qty} pedidos)</span>` : ''}</span>
        ${(p.qty || 1) > 1 && (ed.keys || []).includes(p.label) ? `<span style="margin-left:auto;white-space:nowrap;font-size:12.5px">regalar
          <input type="number" min="1" max="${p.qty}" value="${giftQtyOf(ed, p)}" data-nota="${esc(n.order_id)}" data-label="${esc(p.label)}" data-max="${p.qty}"
            onchange="IMP.setGiftQty(this.dataset.nota, this.dataset.label, this.value, this.dataset.max)" style="width:56px;padding:3px 5px;border:0.5px solid var(--border-strong);border-radius:6px;font:inherit"></span>` : ''}</label>`).join('')
      : '<div class="imp-muted">Este pedido no tiene productos en el CSV.</div>'}
    <div class="imp-btns" style="margin-top:6px">
      <button class="imp-mini" data-nota="${esc(n.order_id)}" onclick="IMP.duplicateNota(this.dataset.nota)">Duplicar nota (para otro producto)</button>
    </div>
    ${giftBoxHtml(n, list)}
  </div>`;
}
function noteFilter(f) { S.noteFilter = f; renderConfigure(); }
function noteAll(oid) { S.notaAll = S.notaAll || {}; S.notaAll[oid] = !S.notaAll[oid]; renderConfigure(); }

function renderConfigure() {
  const el = $('configure');
  el.style.display = 'block';
  const list = infos();
  const c = counts();
  const groups = stack();
  const flat = groups.flatMap(g => g.items);
  const fallbacks = list.filter(i => i.slip && i.slip.ok === false);
  const noDeadline = list.filter(i => !i.ship_by);
  const ct = custTids(list);

  const dupCount = S.meta.filter(m => m.in_pdf && m.inserted === false).length;
  const dupHtml = dupCount ? `
    <div class="imp-card">
      <h3>Guías ya importadas <small>· ${dupCount} de ${S.meta.filter(m => m.in_pdf).length} ya existen en el sistema</small></h3>
      <div class="imp-btns">
        <button class="imp-btn${S.dupeFilter !== 'new_only' ? ' primary' : ''}" onclick="IMP.setDupeFilter('all')">Todas (${S.meta.filter(m => m.in_pdf).length})</button>
        <button class="imp-btn${S.dupeFilter === 'new_only' ? ' primary' : ''}" onclick="IMP.setDupeFilter('new_only')">Solo nuevas (${S.meta.filter(m => m.in_pdf).length - dupCount})</button>
      </div>
      <div class="imp-muted" style="margin-top:4px">Con "Solo nuevas" las guías repetidas no se imprimen ni aparecen en notas, extras o conteos.</div>
    </div>` : '';

  const statsHtml = `
    <div class="imp-card">
      <h3>Esta importación <small>· ${esc(S.importId)}</small></h3>
      <div class="imp-stats">
        <div class="imp-stat"><b>${c.shipments}</b><span>Envíos</span></div>
        <div class="imp-stat"><b>${c.newC}</b><span>Clientes nuevos</span></div>
        <div class="imp-stat"><b>${c.existingC}</b><span>Clientes existentes</span></div>
        <div class="imp-stat"><b>${c.postcards}</b><span>Postales</span></div>
        ${c.unknownC ? `<div class="imp-stat" style="background:var(--amber-bg)"><b>${c.unknownC}</b><span>Sin cliente</span></div>` : ''}
      </div>
      ${c.unknownC ? `<div class="imp-warn">⚠ ${plural(c.unknownC, 'envío no tiene', 'envíos no tienen')} cliente asignado (se imprimen con "? env", sin Lápiz ni postal). Resuelve los posibles duplicados de arriba para corregirlo.</div>` : ''}
      ${noDeadline.length ? `<div class="imp-warn">⚠ ${plural(noDeadline.length, 'envío sin', 'envíos sin')} fecha límite leída: ${noDeadline.map(i => esc('' + i.username)).join(', ')}</div>` : ''}
    </div>`;

  const fbHtml = fallbacks.length ? `
    <div class="imp-card">
      <h3>Hojas en formato básico <small>· se imprimen como antes (solo usuario y envíos)</small></h3>
      ${fallbacks.map(i => `<div class="imp-bad"><b>${esc(i.username)}</b> · ${esc(i.tid)} — ${esc(i.slip.reason || '')}${i.slip.detail ? ': ' + esc(i.slip.detail) : ''}</div>`).join('')}
      <div class="imp-muted">Los productos extra de estos envíos no se imprimen; al generar el PDF verás la lista para anotarlos a mano.</div>
    </div>` : '';

  // Notas: one block per note piece. Its text can be edited, it is linked to products
  // of THIS order with checkboxes, and it can be split into more pieces (duplicate).
  const visibleTids = new Set(list.map(i => i.tid));
  const visNotas = (S.ctx.notas || []).filter(n => visibleTids.has(n.linked_shipment));
  const notaHtml = (visNotas.length ? notaBlockHtml(visNotas, list) : '') + giftPickerHtml(list);

  // Extras per customer
  const byCust = {};
  (S.ctx.candidates || []).forEach(cd => {
    const cust = candidateCust(cd, list);
    if (cust) (byCust[cust] = byCust[cust] || []).push(cd);
  });
  const custName = cust => {
    if (cust.startsWith('USER:')) return '' + ((list.find(i => i.tid === cust.slice(5)) || {}).username || '');
    const tids = ct[cust] || [];
    return tids.map(t => '' + (list.find(i => i.tid === t) || {}).username).join(' / ');
  };
  const extrasHtml = Object.keys(byCust).length ? `
    <div class="imp-card">
      <h3>Pedidos pendientes de Shopify / Manual <small>· marca lo que va en el paquete</small></h3>
      <div class="imp-muted" style="margin-bottom:4px">Solo lo marcado se imprime en la hoja. Al generar el PDF quedan como Anotado y vinculados al pedido de TikTok.</div>
      ${Object.entries(byCust).map(([cust, cds]) => {
        const tids = cust.startsWith('USER:') ? [cust.slice(5)] : (ct[cust] || []);
        return `<div class="imp-cust">
          <div class="imp-cust-head">${esc(custName(cust))} <span class="imp-muted">${cust.startsWith('USER:') ? '(sin Customer ID, por usuario)' : esc(cust)}</span>
            <button class="imp-mini" style="margin-left:6px" data-cust="${esc(cust)}" onclick="IMP.markAll(this.dataset.cust)">Marcar todos</button></div>
          ${cds.map(cd => {
            const sel = S.extraSel[cd.order_id] || {};
            return `<div class="imp-item">
              <input type="checkbox" ${sel.checked ? 'checked' : ''} data-oid="${esc(cd.order_id)}" onchange="IMP.toggleExtra(this.dataset.oid, this.checked)">
              <div style="flex:1;min-width:0">
                <div><b>${cd.channel === 'Nota' ? '<span class="nota-tag">Nota</span>' : esc(extraTitle(cd))}</b>
                  ${cd.status === 'No Pagado' ? ' <span class="imp-nopagado">⚠ No pagado</span>' : ''}
                  ${sel.prelinked ? ' <span class="imp-muted">(ya estaba anotado)</span>' : ''}</div>
                <div class="imp-muted">${esc(extraLines(cd).join(' · '))}</div>
                ${tids.length > 1 ? `<div style="margin-top:4px">Va con:
                  <select data-oid="${esc(cd.order_id)}" onchange="IMP.setExtraTid(this.dataset.oid, this.value)">
                    <option value="">— elegir pedido —</option>
                    ${tids.map(t => { const ii = list.find(x => x.tid === t) || {}; return `<option value="${esc(t)}"${sel.tid === t ? ' selected' : ''}>${esc(ii.username)} · ${esc(t)}</option>`; }).join('')}
                  </select></div>` : ''}
              </div>
            </div>`;
          }).join('')}
        </div>`;
      }).join('')}
    </div>` : `<div class="imp-card"><h3>Pedidos pendientes de Shopify / Manual</h3><div class="imp-muted">Ningún cliente de esta importación tiene pedidos pendientes.</div></div>`;

  // Multiple shipments of one customer -> NO POSTAL
  const multi = Object.entries(ct).filter(([cust, tids]) => tids.length > 1);
  const multiHtml = multi.length ? `
    <div class="imp-card">
      <h3>Clientes con varios envíos <small>· una sola postal / un solo Lápiz</small></h3>
      ${multi.map(([cust, tids]) => {
        const items = flat.filter(i => i.cust === cust);
        return `<div class="imp-list-item"><b>${esc(cust)}</b>: ${items.map(i => `${esc(i.username)}${i.no_postal ? ' <b>NO POSTAL</b>' : i.primary ? ' ✓' : ''}`).join(' · ')}</div>`;
      }).join('')}
    </div>` : '';

  const optHtml = `
    <div class="imp-card">
      <h3>Orden de impresión <small>· solo para esta importación</small></h3>
      ${printOptionsHtml('import')}
      <div class="imp-muted" style="margin-top:8px">Pila de arriba hacia abajo: ${groups.length ? groups.map(g => (g.label ? `<b>${esc(g.label)}</b>: ` : '') + g.items.slice(0, 6).map(i => esc('' + i.username)).join(', ') + (g.items.length > 6 ? ` … (+${g.items.length - 6})` : '')).join(' | ') : 'sin envíos'}</div>
    </div>`;

  const genHtml = `
    <div class="imp-card">
      <h3>Generar PDF de guías</h3>
      <div class="imp-btns">
        <button class="imp-btn primary" id="gen-btn" onclick="IMP.generate('full')" ${S.busy ? 'disabled' : ''}>${S.render ? 'Volver a generar PDF' : 'Generar PDF'}</button>
        <button class="imp-btn" onclick="IMP.generate('basic')" ${S.busy ? 'disabled' : ''}>Generar en formato básico</button>
        ${S.combinedCsv ? '<button class="imp-btn" onclick="IMP.downloadCombinedCsv()">CSV combinado</button>' : ''}
      </div>
      ${S.render ? renderReportHtml() : ''}
    </div>`;

  el.innerHTML = dupHtml + statsHtml + fbHtml + notaHtml + extrasHtml + multiHtml + optHtml + genHtml + funFactCardHtml();
  if (!S.facts) loadFacts().then(() => { const f = $('ff-card'); if (f) f.outerHTML = funFactCardHtml(); });
}

function legacyButtonsHtml() {
  return `<div class="imp-card"><h3>PDF anotado (como antes)</h3><div class="imp-btns">
    ${S.legacyPdf ? '<button class="imp-btn primary" onclick="IMP.downloadLegacy()">Descargar PDF anotado</button>' : ''}
    ${S.combinedCsv ? '<button class="imp-btn" onclick="IMP.downloadCombinedCsv()">CSV combinado</button>' : ''}</div></div>`;
}

function setOpt(k, v) { S.opts[k] = v; renderConfigure(); }
function setDupeFilter(v) {
  if (S.dupeFilter === v) return;
  S.dupeFilter = v;
  if (S.render) showToast('Filtro cambiado — vuelve a generar el PDF');
  renderConfigure();
}
function toggleExtra(oid, on) {
  const s = S.extraSel[oid];
  if (s) s.checked = on;
  renderConfigure();
}
function setExtraTid(oid, tid) { const s = S.extraSel[oid]; if (s) s.tid = tid; renderConfigure(); }
function markAll(cust) {
  const list = infos();
  (S.ctx.candidates || []).forEach(c => { if (candidateCust(c, list) === cust && S.extraSel[c.order_id]) S.extraSel[c.order_id].checked = true; });
  renderConfigure();
}
function editNota(id, text) { (S.notaEdit[id] = S.notaEdit[id] || {}).text = text; }
// ── Regalo: a note says a product is a gift for someone else ─────────────
// Creates one Manual entry (Pagado, price 0) per product under the RECIPIENT. If she is in
// this batch, the entry shows up in her pending list at once, ticked, and prints on her slip.
function shortTitle(s) { return String(s || '').split(/\s+[-\u2013\u2014]\s+/)[0].trim(); }
// Candidate products of an order: [{label, product, variation, seller_sku, qty}].
// Older imports stored plain labels; those still work (no Seller SKU, qty 1).
function parseCands(v) {
  let a = v;
  if (typeof v === 'string') {
    const s = v.trim();
    if (!s) return [];
    if (s[0] === '[') { try { a = JSON.parse(s); } catch (e) { a = s.split(';'); } } else a = s.split(';');
  }
  if (!Array.isArray(a)) return [];
  return a.map(x => typeof x === 'string'
    ? { label: x.trim(), product: x.trim(), variation: '', seller_sku: '', qty: 1 }
    : { label: String(x.label || ''), product: String(x.product || x.label || ''), variation: String(x.variation || ''),
        seller_sku: String(x.seller_sku || ''), qty: parseInt(x.qty, 10) || 1 }).filter(c => c.label);
}
function giftLine(gifter, c, giveaway) {
  const clean = t => String(t || '').replace(/;/g, ',').replace(/\s+/g, ' ').trim();
  const kind = giveaway ? 'GIVEAWAY DE ' : 'REGALO DE ';
  const parts = [kind + clean(gifter), clean(shortTitle(c.product)), clean(c.variation), clean(c.seller_sku)].filter(Boolean);
  return `${c.qty || 1}x ` + parts.join(' · ');
}
function giftShipSearch(q) {
  S.giftShipQ = q;
  const el = $('gift-ship-res');
  if (el) el.innerHTML = giftShipResultsHtml();
}
function giftShipPick(tid) {
  const id = 'NEW:' + tid + ':' + Date.now();
  (S.virtualNotas = S.virtualNotas || []).push({ order_id: id, linked_shipment: tid, text: '', source: 'Regalo', candidates: '', nota_pedido: '', assigned: '', gift: null, virtual: true });
  S.giftShipQ = '';
  giftOpen(id);
}
function giftVirtualClose(id) {
  S.virtualNotas = (S.virtualNotas || []).filter(x => x.order_id !== id);
  delete S.giftUi[id]; delete S.notaEdit[id];
  renderConfigure();
}
function giftItemsFor(n) {
  // the gift can use any product the checkboxes show (this order, or the whole shipment)
  const keys = (S.notaEdit[n.order_id] || {}).keys || [];
  const all = n.source === 'Regalo' || !!(S.notaAll || {})[n.order_id];
  const ed = S.notaEdit[n.order_id] || {};
  return noteProducts(n, all).filter(c => keys.includes(c.label))
    .map(c => Object.assign({}, c, { qty: giftQtyOf(ed, c), ordered: c.qty || 1 }));
}
// How many of a product are given away: the number the user chose, never more than ordered.
function giftQtyOf(ed, p) {
  const ordered = p.qty || 1;
  const q = parseInt((ed.giftQty || {})[p.label], 10);
  return Math.min(ordered, Math.max(1, isNaN(q) ? ordered : q));
}
function setGiftQty(oid, label, val, max) {
  const e = (S.notaEdit[oid] = S.notaEdit[oid] || { text: '', keys: [], giftQty: {} });
  e.giftQty = e.giftQty || {};
  const mx = parseInt(max, 10) || 1;
  e.giftQty[label] = Math.min(mx, Math.max(1, parseInt(val, 10) || 1));
  renderConfigure();
}
async function ensureCustomers() { if (!allCustomers.length) await fetchCustomersForModal(); }
function activityOf(c) {
  const v = c['Order Count'] !== undefined ? c['Order Count'] : c['Shipment Count'];
  return Number(v) || 0;
}
// Matches first (typed letters at the start), then by how active the customer is.
function sortByMatchThenActivity(list, nq) {
  const rank = c => {
    const names = [c['Primary Username'], ...String(c['Aliases'] || '').split(',')].map(normUser);
    return names.some(n => n.startsWith(nq)) ? 0 : 1;
  };
  return list.sort((a, b) => (rank(a) - rank(b)) || (activityOf(b) - activityOf(a)) ||
    String(a['Primary Username'] || '').localeCompare(String(b['Primary Username'] || ''), 'es'));
}
function giftResultsHtml(oid) {
  const ui = S.giftUi[oid] || {};
  const nq = normUser(ui.q || '');
  if (nq.length < 2) return '<div class="imp-muted">Escribe al menos 2 letras del usuario…</div>';
  if (!allCustomers.length) return '<div class="imp-muted">Cargando clientes…</div>';
  const hits = sortByMatchThenActivity(allCustomers.filter(c => {
    if (String(c['Primary Username'] || '').indexOf('(merged') >= 0) return false;
    return normUser(c['Primary Username']).includes(nq) ||
      String(c['Aliases'] || '').split(',').some(a => normUser(a).includes(nq));
  }), nq).slice(0, 8);
  const exact = allCustomers.some(c => normUser(c['Primary Username']) === nq);
  return hits.map(c => `<div class="imp-list-item"><button class="imp-mini" data-nota="${esc(oid)}" data-cid="${esc(c['Customer ID'])}" data-user="${esc(c['Primary Username'])}" onclick="IMP.giftPick(this.dataset.nota, this.dataset.cid, this.dataset.user)">Elegir</button>
      ${esc(c['Primary Username'])} <span class="imp-muted">· ${esc(c['Customer ID'])} · ${plural(activityOf(c), 'pedido', 'pedidos')}</span></div>`).join('')
    + (exact ? '' : `<div class="imp-list-item"><button class="imp-mini" data-nota="${esc(oid)}" onclick="IMP.giftPickNew(this.dataset.nota)">Crear cliente nuevo "${esc((ui.q || '').trim())}"</button></div>`);
}
function giftBoxHtml(n, list) {
  const g = n.gift;
  if (g && (g.order_ids || []).length) {
    const isGA = !!g.giveaway;
    const inBatch = !isGA && list.filter(x => x.cust && x.cust === g.recipient).length > 0;
    return `<div style="margin-top:8px;padding:6px 8px;background:#e7f4df;border-radius:8px;font-size:13px;color:#2a4a14">
      🎁 ${isGA ? 'Giveaway creado' : `Regalo creado para <b>${esc(g.username)}</b>`} (${plural(g.order_ids.length, 'producto', 'productos')})${isGA ? ' · se empaca desde Pedidos' : inBatch ? ' · va en su paquete de este lote' : ' · queda pendiente para su próximo pedido'}
      <button class="imp-mini" style="margin-left:6px" data-nota="${esc(n.order_id)}" onclick="IMP.giftUndo(this.dataset.nota)">Deshacer</button></div>`;
  }
  const ui = S.giftUi[n.order_id] || {};
  if (!ui.open) {
    return `<div class="imp-btns" style="margin-top:6px"><button class="imp-mini" data-nota="${esc(n.order_id)}" onclick="IMP.giftOpen(this.dataset.nota)">🎁 Regalo para…</button></div>`;
  }
  const gifter = (list.find(x => x.tid === n.linked_shipment) || {}).username || '';
  const items = giftItemsFor(n);
  const ga = !!ui.giveaway;
  const who = ga ? '<b>Giveaway</b> <span class="imp-muted">(sin cliente)</span>'
    : ui.recipient ? `${esc(ui.recipient.username)} <span class="imp-muted">(${esc(ui.recipient.id)})</span>`
    : ui.newName ? `${esc(ui.newName)} <span class="imp-muted">(cliente nuevo)</span>` : '';
  const ready = items.length && (ga || ui.recipient || ui.newName);
  const searchDisabled = ga ? ' disabled' : '';
  const greyed = ga ? 'opacity:0.35;pointer-events:none;' : '';
  return `<div style="margin-top:8px;padding:8px;border:0.5px solid #d9c25a;border-radius:10px;background:#fffdf3">
    <b>🎁 Regalo para…</b>
    <label style="display:flex;gap:6px;align-items:center;font-size:13px;margin:6px 0">
      <input type="checkbox" data-nota="${esc(n.order_id)}" ${ga ? 'checked' : ''} onchange="IMP.giftGiveaway(this.dataset.nota, this.checked)">
      Giveaway (regalo sin cliente: se empaca desde Pedidos)</label>
    <div style="${greyed}">
    ${who && !ga ? `<div style="margin:6px 0">Destinatario: ${who} <button class="imp-mini" data-nota="${esc(n.order_id)}" onclick="IMP.giftChange(this.dataset.nota)">Cambiar</button></div>`
          : `<div style="margin:6px 0"><input type="text" id="gift-q-${esc(n.order_id)}" value="${esc(ui.q || '')}" placeholder="Usuario del destinatario" style="width:100%;box-sizing:border-box;padding:6px 8px;border:0.5px solid #d9c25a;border-radius:8px;font:inherit;font-size:13px"${searchDisabled}
              data-nota="${esc(n.order_id)}" oninput="IMP.giftSearch(this.dataset.nota, this.value)"><div id="gift-res-${esc(n.order_id)}">${ga ? '' : giftResultsHtml(n.order_id)}</div></div>`}
    </div>
    <div style="font-size:12.5px;margin-top:4px"><b>Se creará (Manual, Pagado, $0):</b></div>
    ${items.length ? items.map(c => `<div class="imp-list-item">• ${esc(giftLine(gifter, c, ga))}</div>`).join('')
                   : '<div class="imp-warn">Marca primero a qué producto(s) se refiere el regalo (casillas de arriba).</div>'}
    <div class="imp-btns" style="margin-top:6px">
      <button class="imp-btn primary" ${ready && !S.giftBusy ? '' : 'disabled'} data-nota="${esc(n.order_id)}" onclick="IMP.giftCreate(this.dataset.nota)">Crear ${ga ? 'giveaway' : 'regalo'}</button>
      <button class="imp-btn" data-nota="${esc(n.order_id)}" onclick="IMP.giftClose(this.dataset.nota)">Cancelar</button>
    </div></div>`;
}
function giftGiveaway(oid, on) {
  const ui = (S.giftUi[oid] = S.giftUi[oid] || { open: true });
  ui.giveaway = !!on;
  if (on) { ui.recipient = null; ui.newName = ''; ui.q = ''; }
  renderConfigure();
}
async function giftOpen(oid) {
  S.giftUi[oid] = { open: true, q: '', recipient: null, newName: '' };
  renderConfigure();
  try { await ensureCustomers(); const el = $('gift-res-' + oid); if (el) el.innerHTML = giftResultsHtml(oid); }
  catch (e) { /* TROUBLESHOOT: customer list failed to load (Apps Script action=customers); the search shows "Cargando…" */ }
}
function giftClose(oid) { S.giftUi[oid] = {}; renderConfigure(); }
function giftChange(oid) { const u = S.giftUi[oid] || {}; S.giftUi[oid] = { open: true, q: '', recipient: null, newName: '' }; renderConfigure(); }
function giftSearch(oid, q) {
  const ui = (S.giftUi[oid] = S.giftUi[oid] || { open: true });
  ui.q = q;
  const el = $('gift-res-' + oid);
  if (el) el.innerHTML = giftResultsHtml(oid);
}
function giftPick(oid, cid, username) { const ui = S.giftUi[oid]; ui.recipient = { id: cid, username }; ui.newName = ''; renderConfigure(); }
function giftPickNew(oid) { const ui = S.giftUi[oid]; ui.newName = String(ui.q || '').trim().replace(/^@/, ''); ui.recipient = null; renderConfigure(); }
async function giftCreate(oid) {
  if (S.giftBusy) return;
  const n = (S.ctx.notas || []).find(x => x.order_id === oid) || (S.virtualNotas || []).find(x => x.order_id === oid);
  const ui = S.giftUi[oid] || {};
  if (!n) return;
  const list = infos();
  const gifterInfo = list.find(x => x.tid === n.linked_shipment) || {};
  const ga = !!ui.giveaway;
  const items = giftItemsFor(n);
  if (!items.length) { showToast('Marca primero a qué producto(s) se refiere el regalo', true); return; }
  if (!ga && !ui.recipient && !ui.newName) { showToast('Elige al destinatario o marca Giveaway', true); return; }
  if (!ga && ui.recipient && ui.recipient.id && ui.recipient.id === (gifterInfo.cust || n.customer_id)) {
    showToast('El destinatario es el mismo cliente que hace el regalo', true); return;
  }
  S.giftBusy = true; renderConfigure();
  try {
    const r = await VP.post({
      action: 'gift_create', nota_order_id: n.virtual ? '' : oid, tracking_id: n.virtual ? n.linked_shipment : '',
      gifter_username: gifterInfo.username || '', giveaway: ga,
      recipient_customer_id: (!ga && ui.recipient) ? ui.recipient.id : '', new_username: (!ga && ui.newName) || '',
      items: items.map(c => ({ label: c.label, text: giftLine(gifterInfo.username || '', c, ga), qty: c.qty, ordered: c.ordered })),
    });
    S.giftUi[oid] = {};
    if (n.virtual) { S.virtualNotas = (S.virtualNotas || []).filter(x => x.order_id !== oid); delete S.notaEdit[oid]; }
    if (r.created_customer) allCustomers = [];
    await loadContext();
    initSelectionsKeep();
    (r.order_ids || []).forEach(id => { if (S.extraSel[id] && !ga) S.extraSel[id].checked = true; });
    const inBatch = !ga && infos().some(x => x.cust && x.cust === r.recipient_id);
    if (S.render && inBatch) (S.render.giftNotice = S.render.giftNotice || []).push(r.recipient_username);
    showToast(ga ? 'Giveaway creado: se empaca desde Pedidos'
      : inBatch ? `Regalo creado: ya está en la lista de ${r.recipient_username} para esta importación`
      : `Regalo creado para ${r.recipient_username}: queda pendiente para su próximo pedido`);
  } catch (e) {
    // TROUBLESHOOT: message comes from Apps Script gift_create. "ya tiene un regalo" = use Deshacer first.
    showToast('No se pudo crear: ' + e.message, true);
  }
  S.giftBusy = false;
  renderConfigure();
}
async function giftUndo(oid) {
  if (!confirm('¿Deshacer el regalo? Se borran las entradas del destinatario que todavía no se han usado.')) return;
  try {
    const r = await VP.post({ action: 'gift_undo', nota_order_id: oid });
    await loadContext();
    initSelectionsKeep();
    renderConfigure();
    showToast((r.deleted || []).length
      ? `Regalo deshecho (${plural(r.deleted.length, 'entrada borrada', 'entradas borradas')})${(r.kept || []).length ? `; ${plural(r.kept.length, 'se quedó', 'se quedaron')} porque ya se usaron` : ''}`
      : 'No se borró nada: las entradas ya se usaron');
  } catch (e) { showToast('No se pudo deshacer: ' + e.message, true); }
}

// Products are stored as a list of labels ("Product (Variation)") on each note piece.
function parseList(v) {
  if (Array.isArray(v)) return v.map(String);
  const s = String(v || '').trim();
  if (!s) return [];
  if (s[0] === '[') { try { const a = JSON.parse(s); if (Array.isArray(a)) return a.map(String); } catch (e) { /* not JSON */ } }
  return s.split(';').map(x => x.trim()).filter(Boolean);
}
function toggleNotaKey(id, label, on) {
  const e = (S.notaEdit[id] = S.notaEdit[id] || { text: '', keys: [] });
  e.keys = (e.keys || []).filter(k => k !== label);
  if (on) e.keys.push(label);
  renderConfigure();
}
// Splits a note: a new piece with the same text, not linked to any product yet.
async function duplicateNota(oid) {
  try {
    const r = await VP.post({ action: 'nota_duplicate', order_id: oid });
    showToast('Nota duplicada: ' + (r.order_id || ''));
    await loadContext();
    initSelectionsKeep();
    renderConfigure();
  } catch (e) { showToast('No se pudo duplicar: ' + e.message, true); }
}

// ── 3) GENERATE ───────────────────────────────────────────────────────────
function buildPlan(mode) {
  const groups = stack();
  const ships = {};
  // Every note piece of each shipment, with its text and the products it is linked to.
  const segsByTid = {};
  (S.ctx.notas || []).forEach(n => {
    const ed = S.notaEdit[n.order_id] || { text: n.text, keys: [] };
    const g = n.gift;
    if (g && (g.labels || []).length) {
      // the gifted product(s) do not all go in the gifter's box: say how many, under that product
      const who = g.giveaway ? 'GIVEAWAY' : g.username;
      g.labels.forEach(lbl => {
        const q = (g.qtys || {})[lbl] || 1;
        const tot = (g.ordered || {})[lbl] || q;
        (segsByTid[n.linked_shipment] = segsByTid[n.linked_shipment] || []).push({
          order_id: n.nota_pedido, source: 'gift', text: `${q}/${tot} es para ${who} – NO va en este paquete`, keys: [lbl] });
      });
    }
    const text = String(ed.text == null ? n.text : ed.text).trim();
    if (!text) return;
    (segsByTid[n.linked_shipment] = segsByTid[n.linked_shipment] || []).push({
      order_id: n.nota_pedido, source: n.source === 'Vendedor' ? 'seller' : 'buyer', text, keys: ed.keys || [] });
  });
  const extrasByTid = {};
  Object.entries(S.extraSel).forEach(([oid, s]) => {
    if (!s.checked || !s.tid) return;
    const c = candidateById(oid);
    if (c) (extrasByTid[s.tid] = extrasByTid[s.tid] || []).push({ title: extraTitle(c), channel: c.channel || 'Manual', items: extraItems(c), order_id: oid });
  });
  groups.forEach(g => g.items.forEach(i => {
    ships[i.tid] = {
      username: i.username, count_label: countLabel(i), no_postal: i.no_postal, lapiz: i.lapiz,
  giftOpen, giftClose, giftChange, giftSearch, giftPick, giftPickNew, giftCreate, giftUndo, giftGiveaway, noteFilter, noteAll, setGiftQty,
  giftShipSearch, giftShipPick, giftVirtualClose,
      note_segments: segsByTid[i.tid] || [],
    };
  }));
  let seq = [];
  let prevSection = null;
  groups.forEach(g => {
    if (prevSection !== null && g.section !== prevSection && S.opts.blank_between) seq.push({ type: 'blank' });
    prevSection = g.section;
    g.items.forEach(i => seq.push({ type: 'shipment', tracking_id: i.tid }));
  });
  if (S.opts.invert) seq = seq.reverse();
  return { mode, sequence: seq, shipments: ships, extrasByTid, exclude: dupExcludedTids() };
}

async function generate(mode) {
  if (S.busy) return;
  hideError();
  const missing = Object.entries(S.extraSel).filter(([oid, s]) => s.checked && !s.tid);
  if (missing.length) {
    showError(`Elige a qué pedido de TikTok va ${plural(missing.length, 'el producto extra marcado', 'cada uno de los productos extra marcados')} (clientes con varios envíos).`);
    return;
  }
  if (!infos().length) { showError('No hay guías nuevas para imprimir. Elige "Todas" si quieres reimprimir.'); return; }
  const dupLeft = unresolvedMatches();
  if (dupLeft.length && !confirm(`Quedan ${plural(dupLeft.length, 'posible cliente duplicado sin resolver', 'posibles clientes duplicados sin resolver')} (${dupLeft.map(m => m.username).join(', ')}).\n\nSi continúas se crearán como clientes NUEVOS. ¿Continuar?`)) return;
  S.busy = true;
  renderConfigure();
  setProgress(true, 'Generando PDF…', 40);
  try {
    if (!S.pdfB64 || !S.csvB64) throw new Error('Faltan los archivos originales. Reabre la importación desde Historial.');
    await commitPendingCustomers();
    const plan = buildPlan(mode);
    const sendPlan = Object.assign({}, plan);
    delete sendPlan.extrasByTid;
    const res = await callImporter({ op: 'render', csv_base64: S.csvB64, pdf_base64: S.pdfB64, plan: sendPlan,
                                     settings: { slip: S.settings.slip } });
    setProgress(true, 'Marcando productos como Anotado…', 80);
    S.render = { report: res.report || {}, pdf: res.pdf_base64, plan, at: new Date(), mode };
    openPdf(res.pdf_base64, `guias_${S.importId}.pdf`);
    await finalizeLinks();
    S.render.manual = manualList();
    setProgress(false);
    S.busy = false;
    renderConfigure();
    const rep = S.render.report;
    logFields({ 'PDF Generated': new Date().toISOString(), 'Rebuilt': rep.rebuilt || 0, 'Basic': rep.basic || 0,
                'Settings': { print: S.opts, slip: S.settings.slip }, 'Linked': S.log['Linked'] || {} });
    queueUpload('output_pdf', `guias_${S.importId}.pdf`, 'application/pdf', res.pdf_base64);
    showToast(`PDF listo: ${rep.rebuilt || 0} hojas nuevas, ${rep.basic || 0} en formato básico`);
  } catch (e) {
    setProgress(false);
    S.busy = false;
    renderConfigure();
    showError('No se pudo generar el PDF: ' + e.message + (S.legacyPdf ? ' — Mientras tanto puedes usar el PDF anotado de la importación (botón abajo).' : ''));
    if (S.legacyPdf) $('configure').insertAdjacentHTML('afterbegin', legacyButtonsHtml());
  }
}

// ── deferred customer creation ────────────────────────────────────────────
// The import (VPS) no longer creates customers. Possible duplicates are resolved
// above; whatever is still new is created here, when the PDF is generated.
function usernameHasCustomer(u) { return infos().some(i => i.cust && normUser(i.username) === normUser(u)); }
function unresolvedMatches() { return ((S.result && S.result.possible_matches) || []).filter(m => !usernameHasCustomer(m.username)); }
function matchToPayload(m) {
  const e = m.enriched || {};
  return { primary_username: e['Primary Username'] || m.username, first_name: e['First Name'] || '', surname: e['Surname'] || '',
    street: e['Street + Number'] || '', city: e['City'] || '', state: e['State'] || '', zip: e['ZIP'] || '',
    phone_partial: e['Phone Partial'] || '', initials: e['Initials (TT Format)'] || '' };
}
function pendingToCommit() {
  const fresh = ((S.result && S.result.pending_new_customers) || []).filter(c => !usernameHasCustomer(c.primary_username));
  return fresh.concat(unresolvedMatches().map(matchToPayload));
}
function renderPendingNew() {
  const all = (S.result && S.result.pending_new_customers) || [];
  const box = $('new-customers-section');
  if (!all.length) { box.style.display = 'none'; return; }
  $('new-customers-list').innerHTML = all.map(c => {
    const done = usernameHasCustomer(c.primary_username);
    return `<span class="new-customer-chip">${done ? '✓' : '🕓'} ${esc(c.primary_username)}</span>`;
  }).join('');
  box.style.display = 'block';
}
async function commitPendingCustomers() {
  const list = pendingToCommit();
  if (!list.length) return;
  setProgress(true, 'Creando clientes nuevos…', 55);
  const r = await VP.post({ action: 'import_commit_customers', customers: list });
  if (r && r.error) throw new Error(r.error);
  await loadContext();
  initSelectionsKeep();
  renderPendingNew();
  const c = counts();
  logFields({ 'New Customers': c.newC, 'Unknown Customers': c.unknownC });
  const made = ((r && r.created) || []).filter(x => !x.existed).length;
  if (made) showToast(`${plural(made, 'cliente nuevo creado', 'clientes nuevos creados')}`);
}

// Only what is REALLY printed becomes Anotado. Unprinted items stay as they were.
async function finalizeLinks() {
  const rep = (S.render && S.render.report && S.render.report.shipments) || {};
  const rebuilt = new Set(Object.keys(rep).filter(t => rep[t].mode === 'rebuilt'));
  const prev = (S.log && S.log['Linked']) || {};
  const links = [];
  const newLinked = {};
  Object.entries(S.extraSel).forEach(([oid, s]) => {
    if (!s.checked || !s.tid || !rebuilt.has(s.tid)) return;
    const c = candidateById(oid) || {};
    const prevStatus = prev[oid] ? prev[oid].prev : (c.status === 'Anotado' ? 'Pagado' : c.status);
    if (s.prelinked && !prev[oid] && c.linked_shipment === s.tid) return;   // human link, already right
    links.push({ order_id: oid, tracking_id: s.tid });
    newLinked[oid] = { tid: s.tid, prev: prevStatus || 'Pagado' };
  });
  const unlinks = [];
  const hiddenTids = new Set(dupExcludedTids());
  Object.entries(prev).forEach(([oid, p]) => {
    if (hiddenTids.has(p.tid)) { newLinked[oid] = p; return; }   // hidden duplicate: keep its link as it was
    if (!newLinked[oid]) unlinks.push({ order_id: oid, restore_status: p.prev || 'Pagado' });
  });
  Object.entries(S.extraSel).forEach(([oid, s]) => {
    if (s.prelinked && !s.checked && !prev[oid]) unlinks.push({ order_id: oid, restore_status: 'Pagado' });
  });
  const nota_edits = [];
  (S.ctx.notas || []).forEach(n => {
    const ed = S.notaEdit[n.order_id] || {};
    const text = String(ed.text == null ? n.text : ed.text).trim();
    const keys = ed.keys || [];
    const keysChanged = JSON.stringify(keys) !== JSON.stringify(parseList(n.assigned));
    if (text !== String(n.text).trim() || keysChanged) nota_edits.push({ order_id: n.order_id, text, assigned: JSON.stringify(keys) });
  });
  if (!links.length && !unlinks.length && !nota_edits.length) return;
  try {
    const r = await VP.post({ action: 'import_finalize', tracking_ids: infos().map(i => i.tid), links, unlinks, nota_edits });
    S.log['Linked'] = newLinked;
    S.render.finalize = r;
    await loadContext();
    initSelectionsKeep();
  } catch (e) {
    // TROUBLESHOOT: Apps Script import_finalize failed. The PDF is fine, but
    // the extras were NOT marked Anotado -- mark them by hand in Pedidos.
    S.render.finalizeError = e.message;
  }
}
// After finalize the context is reloaded; keep the user's choices.
function initSelectionsKeep() {
  const keep = S.extraSel;
  const keepNota = S.notaEdit;
  initSelections();
  Object.keys(S.extraSel).forEach(oid => { if (keep[oid]) S.extraSel[oid] = Object.assign(S.extraSel[oid], { checked: keep[oid].checked, tid: keep[oid].tid || S.extraSel[oid].tid }); });
  Object.keys(keepNota).forEach(id => { if (S.notaEdit[id]) S.notaEdit[id] = keepNota[id]; });
}

// Per CUST: what must be added by hand because the slip fell back to basic.
function manualList() {
  const rep = (S.render.report && S.render.report.shipments) || {};
  const plan = S.render.plan;
  const list = infos();
  const out = {};
  Object.entries(rep).forEach(([tid, r]) => {
    if (r.mode === 'rebuilt') return;
    const ship = plan.shipments[tid] || {};
    const i = list.find(x => x.tid === tid) || { username: '', cust: '' };
    const items = [];
    if (ship.lapiz) items.push(`Agregar: ${S.settings.slip.lapiz_text}`);
    (plan.extrasByTid[tid] || []).forEach(x => {
      const c = candidateById(x.order_id) || {};
      items.push(c.channel === 'Nota' ? `Nota: ${c.products}` : x.title.replace(' · ', ' - ').replace('productos', 'Productos').replace('producto', 'Producto'));
    });
    if (!items.length) return;
    const key = i.cust || ('' + i.username);
    (out[key] = out[key] || { name: '' + i.username, items: [] }).items.push(...items);
  });
  return out;
}

function renderReportHtml() {
  const r = S.render;
  const rep = r.report || {};
  const list = infos();
  const basics = Object.entries(rep.shipments || {}).filter(([t, x]) => x.mode !== 'rebuilt' && x.code !== 'BASIC_REQUESTED');
  const manual = r.manual || {};
  return `
    <div class="${basics.length ? 'imp-warn' : 'imp-ok'}" style="margin-top:10px">
      ${r.mode === 'basic' ? 'PDF en formato básico.' : `✓ ${rep.rebuilt || 0} hojas nuevas · ${rep.basic || 0} en formato básico`} · ${rep.pages || 0} páginas · ${VP.fmtDateTime(r.at)}
    </div>
    ${basics.map(([t, x]) => { const i = list.find(z => z.tid === t) || {}; return `<div class="imp-bad">${esc(i.username || '')} · ${esc(t)} — ${esc(x.reason)}${x.detail ? ': ' + esc(x.detail) : ''}</div>`; }).join('')}
    ${(rep.warnings || []).map(w => `<div class="imp-warn">${esc(w)}</div>`).join('')}
    ${(r.giftNotice || []).length ? `<div class="imp-warn">⚠ El regalo para ${esc(r.giftNotice.join(', '))} se agregó después de generar el PDF. Vuelve a generar el PDF para que salga en su hoja.</div>` : ''}
    ${Object.keys(manual).length ? `<div class="imp-bad"><b>Anotar a mano (no se imprimió en la hoja):</b>
      ${Object.entries(manual).map(([k, m]) => `<div class="imp-fallback-cust">${esc(k)} · ${esc(m.name)}</div><ul>${m.items.map(x => `<li>${esc(x)}</li>`).join('')}</ul>`).join('')}
      <div class="imp-muted">Estos productos NO se marcaron como Anotado.</div></div>` : ''}
    ${r.finalize ? `<div class="imp-muted">Pedidos: ${r.finalize.linked || 0} anotados, ${r.finalize.unlinked || 0} desvinculados, ${r.finalize.edited || 0} notas editadas${(r.finalize.skipped || []).length ? ' · ⚠ ' + r.finalize.skipped.map(s => esc(s.order_id + ' (' + s.reason + ')')).join(', ') : ''}</div>` : ''}
    ${r.finalizeError ? `<div class="imp-bad">⚠ No se pudieron marcar los productos extra como Anotado: ${esc(r.finalizeError)}. Márcalos a mano en Pedidos.</div>` : ''}
    <div class="imp-btns"><button class="imp-btn" onclick="IMP.reopenPdf()">Abrir PDF otra vez</button></div>`;
}

function reopenPdf() { if (S.render && S.render.pdf) openPdf(S.render.pdf, `guias_${S.importId}.pdf`); }
function downloadLegacy() { if (S.legacyPdf) openPdf(S.legacyPdf, `guias_anotadas_${S.importId}.pdf`); }
function downloadCombinedCsv() { if (S.combinedCsv) downloadB64(S.combinedCsv, 'text/csv', `Combined_Orders_To_Ship_${S.importId}.csv`); }

// ── fun facts (postcard stickers) ─────────────────────────────────────────
async function loadFacts() {
  try { S.facts = (await VP.get('action=funfacts_list')).facts || []; }
  catch (e) { S.facts = S.facts || []; console.warn('[importar] fun facts load failed', e); }
  return S.facts;
}
function pendingFacts() { return (S.facts || []).filter(f => f['Status'] !== 'Usado'); }
function currentFact() {
  const all = S.facts || [];
  if (S.factId) return all.find(f => f['ID'] === S.factId) || null;
  return pendingFacts()[0] || null;
}
function funFactCardHtml() {
  if (!S.result) return '';
  const c = counts();
  const f = currentFact();
  const copies = S.copies == null ? c.postcards : S.copies;
  const pend = pendingFacts();
  return `<div class="imp-card" id="ff-card">
    <h3>Dato curioso para las postales <small>· ${plural(c.postcards, 'cliente existente', 'clientes existentes')}</small></h3>
    ${S.facts == null ? '<div class="imp-muted">Cargando…</div>' : f ? `
      <div class="imp-fact"><div class="grow"><div class="t">${esc(f['Title'])}</div><div>${esc(f['Answer'])}</div>
        ${f['Status'] === 'Usado' ? `<div class="imp-muted">Usado en ${esc(f['Used Import'] || '')}</div>` : ''}</div></div>
      <div class="imp-row">
        ${pend.length > 1 && !(S.log && S.log['Fun Fact ID']) ? `<select onchange="IMP.pickFact(this.value)">${pend.map(p => `<option value="${esc(p['ID'])}"${p['ID'] === (f && f['ID']) ? ' selected' : ''}>${esc(p['Title']).slice(0, 60)}</option>`).join('')}</select>` : ''}
        <label>Copias <input type="number" min="0" step="1" value="${copies}" onchange="IMP.setCopies(this.value)"></label>
      </div>
      <div class="imp-btns"><button class="imp-btn primary" onclick="IMP.generateStickers()">Generar stickers (${copies})</button></div>
      ${pend.length <= 3 ? `<div class="imp-warn">Quedan ${pend.length} datos curiosos en el pool. Agrega más en la pestaña "Datos curiosos".</div>` : ''}`
    : '<div class="imp-warn">No hay datos curiosos en el pool. Agrégalos en la pestaña "Datos curiosos".</div>'}
  </div>`;
}
function pickFact(id) { S.factId = id; refreshFactCard(); }
function setCopies(v) { S.copies = Math.max(0, parseInt(v, 10) || 0); refreshFactCard(); }
function refreshFactCard() { const el = $('ff-card'); if (el) el.outerHTML = funFactCardHtml(); }

async function generateStickers() {
  const f = currentFact();
  if (!f) return;
  const copies = S.copies == null ? counts().postcards : S.copies;
  try {
    setProgress(true, 'Generando stickers…', 50);
    const r = await callImporter({ op: 'funfacts', fact: { title: f['Title'], answer: f['Answer'] }, copies,
                                   settings: { sticker: S.settings.sticker } });
    setProgress(false);
    openPdf(r.pdf_base64, `stickers_${S.importId}.pdf`);
    if (r.info && r.info.warning) showError('⚠ ' + r.info.warning);
    S.factId = f['ID'];
    await VP.post({ action: 'funfacts_mark_used', id: f['ID'], import_id: S.importId });
    logFields({ 'Fun Fact ID': f['ID'], 'Fun Fact Title': f['Title'], 'Stickers': copies });
    S.log['Fun Fact ID'] = f['ID'];
    queueUpload('stickers_pdf', `stickers_${S.importId}.pdf`, 'application/pdf', r.pdf_base64);
    await loadFacts();
    refreshFactCard();
  } catch (e) {
    setProgress(false);
    showError('No se pudieron generar los stickers: ' + e.message);
  }
}

// ── Historial ─────────────────────────────────────────────────────────────
async function loadHistory() {
  const el = $('hist-list');
  el.innerHTML = 'Cargando…';
  try {
    const recs = (await VP.get('action=import_log_list&days=7')).records || [];
    if (!recs.length) { el.innerHTML = 'Sin importaciones en los últimos 7 días.'; return; }
    el.innerHTML = recs.map(r => {
      const files = r['Files'] || {};
      const btn = (kind, label) => files[kind] ? `<button class="imp-mini" onclick="IMP.histFile('${esc(r['Import ID'])}','${kind}')">${label}</button>` : '';
      return `<div class="imp-hist">
        <div><b>${esc(VP.fmtDateTime(r['Created']))}</b> · ${esc(r['By'] || '')} · <span class="imp-muted">${esc(r['Import ID'])}</span></div>
        <div class="imp-muted">${r['Shipments'] || 0} envíos · ${r['New Customers'] || 0} nuevos · ${r['Existing Customers'] || 0} existentes
          ${r['PDF Generated'] ? ` · PDF: ${r['Rebuilt'] || 0} nuevas / ${r['Basic'] || 0} básicas` : ' · <b>PDF sin generar</b>'}
          ${r['Fun Fact Title'] ? ` · Dato: ${esc(r['Fun Fact Title'])} (${r['Stickers'] || 0})` : ''}</div>
        <div class="imp-btns" style="margin-top:6px">
          ${btn('output_pdf', 'PDF guías')}${btn('stickers_pdf', 'Stickers')}${btn('original_pdf', 'PDF original')}${btn('original_csv', 'CSV original')}
          ${S.result && !S.render && S.importId === r['Import ID'] ? '<button class="imp-mini" onclick="IMP.goReview()"><b>Ir a revisar (paso 2)</b></button>' : ''}
          ${files.original_pdf && files.original_csv && files.result ? `<button class="imp-mini" onclick="IMP.reopen('${esc(r['Import ID'])}')"><b>Reabrir</b></button>` : ''}
          ${r['Status'] === 'Archivos borrados' ? '<span class="imp-muted">archivos borrados (más de 7 días)</span>' : ''}
        </div></div>`;
    }).join('');
    S.histRecords = recs;
  } catch (e) {
    el.innerHTML = `<div class="imp-bad">No se pudo cargar el historial: ${esc(e.message)}</div>`;
  }
}
async function fetchHistFile(id, kind) {
  return VP.get(`action=import_file_get&import_id=${encodeURIComponent(id)}&kind=${encodeURIComponent(kind)}`);
}
async function histFile(id, kind) {
  try {
    showToast('Descargando…');
    const f = await fetchHistFile(id, kind);
    if (/pdf/.test(f.mime || '') || /\.pdf$/i.test(f.name)) openPdf(f.base64, f.name);
    else downloadB64(f.base64, f.mime || 'application/octet-stream', f.name);
  } catch (e) { showToast('Error: ' + e.message, true); }
}
// Re-open: no re-import, nothing written again -- only the configure step.
async function reopen(id) {
  const rec = (S.histRecords || []).find(r => r['Import ID'] === id);
  if (!rec) return;
  if (S.result && S.importId === id) { goReview(); return; }      // already open: just go to step 2
  if (S.result && !S.render && !confirm('Hay una importación abierta sin PDF generado. ¿Reabrir otra de todos modos?')) return;
  tab('importar');
  hideError();
  resetImportUi();
  setProgress(true, 'Cargando archivos del historial…', 30);
  try {
    if (!S.settingsLoaded) await loadSettings();
    const [csvF, pdfF, resF] = await Promise.all([fetchHistFile(id, 'original_csv'), fetchHistFile(id, 'original_pdf'), fetchHistFile(id, 'result')]);
    S.importId = id;
    S.csvName = rec['CSV Name']; S.pdfName = rec['PDF Name'];
    S.csvB64 = csvF.base64; S.pdfB64 = pdfF.base64;
    S.log = rec;
    setProgress(true, 'Cargando pedidos pendientes…', 70);
    await startImport(JSON.parse(b64ToText(resF.base64)), { reopen: true });
    setProgress(false);
    showToast('Importación reabierta: ' + id);
  } catch (e) {
    setProgress(false);
    showError('No se pudo reabrir: ' + e.message);
  }
}

// ── Datos curiosos pane ───────────────────────────────────────────────────
function parseBulk(text) {
  const t = String(text || '').replace(/\r/g, '').trim();
  if (!t) return [];
  const lines = t.split('\n');
  if (lines.some(l => l.includes('\t'))) {
    return lines.map(l => l.split('\t')).filter(p => p[0] && p[0].trim())
      .map(p => ({ title: p[0].trim(), answer: (p.slice(1).join(' ') || '').trim() }));
  }
  return t.split(/\n\s*\n/).map(b => b.split('\n').map(x => x.trim()).filter(Boolean))
    .filter(b => b.length).map(b => ({ title: b[0], answer: b.slice(1).join(' ') }));
}
function ffPreview() {
  const items = parseBulk($('ff-bulk').value);
  const bad = items.filter(i => !i.answer);
  $('ff-preview').innerHTML = items.length
    ? `${plural(items.length, 'dato listo', 'datos listos')} para agregar${bad.length ? ` · <b style="color:#a32d2d">${plural(bad.length, 'sin respuesta', 'sin respuesta')}</b>` : ''}`
    : '';
  $('ff-add-btn').disabled = !items.length;
}
// ── fun facts from a file: .xlsx / .xls (SheetJS) or .csv / .tsv / .txt ──
function parseDelimited(text) {
  text = String(text || '').replace(/^\uFEFF/, '');
  const first = text.split(/\r?\n/, 1)[0] || '';
  const count = ch => first.split(ch).length - 1;
  const delim = [['\t', count('\t')], [';', count(';')], [',', count(',')]].sort((a, b) => b[1] - a[1])[0];
  const d = delim[1] > 0 ? delim[0] : ',';
  const rows = []; let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; }
      else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === d) { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows;
}
function plainKey(x) { return String(x || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase(); }
async function ffFile(file) {
  if (!file) return;
  try {
    let rows;
    if (/\.(csv|tsv|txt)$/i.test(file.name)) {
      rows = parseDelimited(new TextDecoder('utf-8').decode(await file.arrayBuffer()));
    } else {
      // TROUBLESHOOT: XLSX undefined = the SheetJS script in import.html did not load (offline / blocked).
      if (typeof XLSX === 'undefined') throw new Error('No cargó el lector de Excel. Revisa la conexión y recarga la página, o usa un archivo .csv.');
      const wb = XLSX.read(await file.arrayBuffer(), { type: 'array' });
      rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: '', blankrows: false });
    }
    rows = rows.filter(r => r.some(c => String(c).trim() !== ''));
    let tCol = 0, aCol = 1;
    if (rows.length) {
      const head = rows[0].map(plainKey);
      const ti = head.findIndex(x => ['titulo', 'title', 'pregunta', 'question'].includes(x));
      const ai = head.findIndex(x => ['respuesta', 'answer'].includes(x));
      if (ti >= 0 || ai >= 0) {
        tCol = ti >= 0 ? ti : 0; aCol = ai >= 0 ? ai : (tCol === 0 ? 1 : 0);
        rows.shift();
      }
    }
    const clean = x => String(x == null ? '' : x).replace(/[\t\r\n]+/g, ' ').trim();
    const lines = rows.map(r => [clean(r[tCol]), clean(r[aCol])]).filter(p => p[0]).map(p => p[0] + '\t' + p[1]);
    if (!lines.length) { showToast('No se encontraron datos en el archivo', true); return; }
    const box = $('ff-bulk');
    box.value = (box.value.trim() ? box.value.replace(/\s+$/, '') + '\n' : '') + lines.join('\n');
    ffPreview();
    showToast(`${plural(lines.length, 'dato leído', 'datos leídos')} del archivo. Revisa y pulsa "Agregar al pool".`);
  } catch (e) { showToast('Error al leer el archivo: ' + e.message, true); }
}
function ffTemplate() {
  if (typeof XLSX === 'undefined') { showToast('No cargó el lector de Excel; recarga la página', true); return; }
  const ws = XLSX.utils.aoa_to_sheet([['Título', 'Respuesta'],
    ['¿Cuántos años puede durar el papel washi?', 'Más de 1,000 años si se guarda bien.']]);
  ws['!cols'] = [{ wch: 50 }, { wch: 90 }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Datos curiosos');
  XLSX.writeFile(wb, 'datos_curiosos_plantilla.xlsx');
}
async function ffAdd() {
  const items = parseBulk($('ff-bulk').value);
  if (!items.length) return;
  try {
    const r = await VP.post({ action: 'funfacts_save', ops: items.map(i => ({ op: 'add', title: i.title, answer: i.answer })) });
    S.facts = r.facts || [];
    $('ff-bulk').value = '';
    ffPreview();
    renderFactsPane();
    showToast(`✓ ${plural(items.length, 'dato agregado', 'datos agregados')}`);
  } catch (e) { showToast('Error: ' + e.message, true); }
}
async function ffOp(op) {
  if (op.op === 'delete' && !confirm('¿Borrar este dato curioso?')) return;
  if (op.op === 'edit') {
    const f = (S.facts || []).find(x => x['ID'] === op.id) || {};
    const title = prompt('Título:', f['Title'] || '');
    if (title === null) return;
    const answer = prompt('Respuesta:', f['Answer'] || '');
    if (answer === null) return;
    op.title = title; op.answer = answer;
  }
  try {
    const r = await VP.post({ action: 'funfacts_save', ops: [op] });
    S.facts = r.facts || [];
    renderFactsPane();
  } catch (e) { showToast('Error: ' + e.message, true); }
}
function renderFactsPane() {
  const pend = pendingFacts();
  const used = (S.facts || []).filter(f => f['Status'] === 'Usado').slice().reverse();
  $('ff-count').textContent = `· ${pend.length} pendientes (el primero se usa en la próxima importación)`;
  $('ff-list').innerHTML = pend.length ? pend.map((f, k) => `
    <div class="imp-fact"><div class="grow"><div class="t">${k + 1}. ${esc(f['Title'])}</div><div>${esc(f['Answer'])}</div></div>
      <button class="imp-mini" title="Subir" onclick="IMP.ffOp({op:'move',id:'${esc(f['ID'])}',dir:-1})">↑</button>
      <button class="imp-mini" title="Bajar" onclick="IMP.ffOp({op:'move',id:'${esc(f['ID'])}',dir:1})">↓</button>
      <button class="imp-mini" onclick="IMP.ffOp({op:'edit',id:'${esc(f['ID'])}'})">Editar</button>
      <button class="imp-mini" onclick="IMP.ffpOpen('${esc(f['ID'])}')">Imprimir</button>
      <button class="imp-mini" onclick="IMP.ffOp({op:'delete',id:'${esc(f['ID'])}'})">Borrar</button></div>`).join('')
    : 'El pool está vacío.';
  $('ff-used').innerHTML = used.length ? used.map(f => `
    <div class="imp-fact"><div class="grow"><div class="t">${esc(f['Title'])}</div><div>${esc(f['Answer'])}</div>
      <div class="imp-muted">${esc(VP.fmtDateTime(f['Used Date']))} · ${esc(f['Used Import'] || '')}</div></div>
      <button class="imp-mini" onclick="IMP.ffOp({op:'restore',id:'${esc(f['ID'])}'})">Devolver al pool</button></div>`).join('')
    : '—';
}

// ── Imprimir dato curioso manualmente desde el Pool ─────────────────────────
let ffpFactId = null, ffpOrigTitle = '', ffpOrigAnswer = '';
function ffpOpen(id) {
  const f = (S.facts || []).find(x => x['ID'] === id);
  if (!f) return;
  ffpFactId = id;
  ffpOrigTitle = f['Title'] || '';
  ffpOrigAnswer = f['Answer'] || '';
  $('ffp-title').value = ffpOrigTitle;
  $('ffp-answer').value = ffpOrigAnswer;
  $('ffp-copies').value = 1;
  const m = (S.settings && S.settings.sticker) || {};
  $('ffp-margin-top').value = m.margin_top != null ? m.margin_top : 0;
  $('ffp-margin-right').value = m.margin_right != null ? m.margin_right : 0;
  $('ffp-margin-bottom').value = m.margin_bottom != null ? m.margin_bottom : 0;
  $('ffp-margin-left').value = m.margin_left != null ? m.margin_left : 0;
  $('ffp-mark-used').checked = true;
  $('ff-print-modal').style.display = 'flex';
}
function ffpClose() { $('ff-print-modal').style.display = 'none'; ffpFactId = null; }
function ffpStickerSettings() {
  return Object.assign({}, (S.settings && S.settings.sticker) || {}, {
    margin_top: parseFloat($('ffp-margin-top').value) || 0,
    margin_right: parseFloat($('ffp-margin-right').value) || 0,
    margin_bottom: parseFloat($('ffp-margin-bottom').value) || 0,
    margin_left: parseFloat($('ffp-margin-left').value) || 0,
  });
}
async function ffpTest() {
  const title = $('ffp-title').value.trim();
  const answer = $('ffp-answer').value.trim();
  try {
    const r = await callImporter({ op: 'funfacts', test: true, copies: 1, fact: { title, answer }, settings: { sticker: ffpStickerSettings() } });
    openPdf(r.pdf_base64, 'stickers_prueba.pdf');
  } catch (e) { showToast('Error: ' + e.message, true); }
}
async function ffpPrint() {
  if (!ffpFactId) return;
  const title = $('ffp-title').value.trim();
  const answer = $('ffp-answer').value.trim();
  const copies = Math.max(0, parseInt($('ffp-copies').value, 10) || 0);
  const markUsed = $('ffp-mark-used').checked;
  if (!title || !copies) { showToast('Falta título o copias', true); return; }
  try {
    const stickerSettings = ffpStickerSettings();
    // save margins as new defaults
    const s = JSON.parse(JSON.stringify(S.settings));
    s.sticker = Object.assign({}, s.sticker, {
      margin_top: stickerSettings.margin_top, margin_right: stickerSettings.margin_right,
      margin_bottom: stickerSettings.margin_bottom, margin_left: stickerSettings.margin_left,
    });
    await VP.post({ action: 'importar_settings_save', settings: s });
    S.settings = s;
    // if text changed, update it in the sheet
    if (title !== ffpOrigTitle || answer !== ffpOrigAnswer) {
      const r2 = await VP.post({ action: 'funfacts_save', ops: [{ op: 'edit', id: ffpFactId, title, answer }] });
      S.facts = r2.facts || S.facts;
    }
    const r = await callImporter({ op: 'funfacts', copies, fact: { title, answer }, settings: { sticker: stickerSettings } });
    openPdf(r.pdf_base64, `stickers_manual_${ffpFactId}.pdf`);
    if (markUsed) {
      await VP.post({ action: 'funfacts_mark_used', id: ffpFactId, import_id: 'manual' });
    }
    await loadFacts();
    renderFactsPane();
    ffpClose();
    showToast('✓ Impreso');
  } catch (e) { showToast('Error: ' + e.message, true); }
}

// ── Ajustes pane ──────────────────────────────────────────────────────────
const SLIP_FIELDS = [
  ['name_size', 'Nombre del producto'], ['sku_size', 'SKU (variación)'], ['seller_size', 'Seller SKU'],
  ['qty_size', 'Cantidad (Qty)'], ['total_size', 'Qty Total'], ['note_size', 'Mensajes / notas'],
  ['order_size', 'Order ID (notas)'], ['extras_size', 'Productos extra'], ['lapiz_size', 'Lápiz Infinito'],
  ['deadline_size', 'Fecha límite (pie)'], ['footer_id_size', 'Order ID (pie)'], ['user_size', 'Usuario (rojo)'],
  ['header_size', 'Encabezados'],
  ['item_line_width', 'Línea entre productos (grosor, pt)'],
  ['row_note_size', 'Nota bajo el producto (negrita, pt)'],
];
const STICKER_FIELDS = [
  ['width_mm', 'Ancho (mm)'], ['height_mm', 'Alto (mm)'], ['margin_top', 'Margen arriba (mm)'],
  ['margin_right', 'Margen derecha (mm)'], ['margin_bottom', 'Margen abajo (mm)'], ['margin_left', 'Margen izquierda (mm)'],
  ['title_size', 'Título (pt, máx.)'], ['answer_size', 'Respuesta (pt, máx.)'], ['gap_mm', 'Espacio título-respuesta (mm)'],
];
const FONT_OPTS = [['atkinson', 'Atkinson Hyperlegible'], ['roboto', 'Roboto'], ['helvetica', 'Helvetica']];

async function renderSettings() {
  if (!S.settingsLoaded) await loadSettings();
  const s = S.settings;
  const fontSel = (id, v) => `<select id="${id}">${FONT_OPTS.map(([k, l]) => `<option value="${k}"${v === k ? ' selected' : ''}>${l}</option>`).join('')}</select>`;
  const num = (grp, k, l) => `<label>${l}<input type="number" step="0.5" id="set-${grp}-${k}" value="${esc(s[grp][k])}"></label>`;
  const p = s.print;
  $('settings-form').innerHTML = `
    <div class="imp-card"><h3>Hoja de empaque <small>· tamaños en puntos (pt)</small></h3>
      <div class="imp-grid">
        <label>Fuente ${fontSel('set-slip-font', s.slip.font)}</label>
        <label>Texto Lápiz <input type="text" id="set-slip-lapiz_text" value="${esc(s.slip.lapiz_text)}"></label>
        ${SLIP_FIELDS.map(([k, l]) => num('slip', k, l)).join('')}
        <label>Línea entre productos (tipo) <select id="set-slip-item_line_style">
          <option value="solid"${s.slip.item_line_style === 'solid' ? ' selected' : ''}>Continua</option>
          <option value="dashed"${s.slip.item_line_style === 'dashed' ? ' selected' : ''}>- - - - (guiones)</option>
        </select></label>
      </div></div>
    <div class="imp-card"><h3>Hoja de prueba <small>· para revisar cómo se ve; no se guarda ni se sube</small></h3>
      <div class="imp-row">
        <select id="set-test-mode">
          <option value="single">Una hoja (pedido normal)</option>
          <option value="large">Dos hojas (pedido muy grande)</option>
        </select>
        <button class="imp-btn" onclick="IMP.testSlip()">Generar PDF de prueba</button>
      </div>
      <div class="imp-muted">Usa los ajustes de esta pantalla, también los que aún no has guardado. Para ver los cambios en una importación real, guarda primero.</div>
    </div>
    <div class="imp-card"><h3>Stickers de datos curiosos</h3>
      <div class="imp-grid">
        <label>Fuente ${fontSel('set-sticker-font', s.sticker.font)}</label>
        <label>Alineación <select id="set-sticker-align"><option value="center"${s.sticker.align === 'center' ? ' selected' : ''}>Centrado</option><option value="left"${s.sticker.align === 'left' ? ' selected' : ''}>Izquierda</option></select></label>
        ${STICKER_FIELDS.map(([k, l]) => num('sticker', k, l)).join('')}
      </div>
      <div class="imp-btns"><button class="imp-btn" onclick="IMP.testSticker()">Imprimir página de prueba</button></div>
      <div class="imp-muted">La página de prueba dibuja un rectángulo en los márgenes. Ajusta hasta que quede centrado en el sticker.</div></div>
    <div class="imp-card"><h3>Orden de impresión por defecto <small>· cada importación nueva empieza con esto</small></h3>
      ${printOptionsHtml('settings')}</div>
    <div class="imp-btns"><button class="imp-btn primary" onclick="IMP.saveSettings()">Guardar ajustes</button>
      <button class="imp-btn" onclick="IMP.resetSettings()">Restaurar valores de fábrica</button></div>
    <div class="imp-muted" style="margin-top:6px">Se guardan en el servidor: valen para todos los dispositivos.</div>
    ${purgeCardHtml()}`;
  renderPurgeOut();
}
function readSettingsForm() {
  const s = JSON.parse(JSON.stringify(S.settings));
  s.slip.font = $('set-slip-font').value;
  s.slip.lapiz_text = $('set-slip-lapiz_text').value.trim() || DEFAULTS.slip.lapiz_text;
  SLIP_FIELDS.forEach(([k]) => { const v = parseFloat($('set-slip-' + k).value); if (!isNaN(v)) s.slip[k] = v; });
  s.slip.item_line_style = $('set-slip-item_line_style').value;
  s.sticker.font = $('set-sticker-font').value;
  s.sticker.align = $('set-sticker-align').value;
  STICKER_FIELDS.forEach(([k]) => { const v = parseFloat($('set-sticker-' + k).value); if (!isNaN(v)) s.sticker[k] = v; });
  ['sort', 'group', 'group_first', 'sub_first'].forEach(k => { s.print[k] = $('set-print-' + k).value; });
  ['blank_between', 'invert', 'lapiz'].forEach(k => { s.print[k] = $('set-print-' + k).checked; });
  return s;
}
async function saveSettings() {
  const s = readSettingsForm();
  try {
    await VP.post({ action: 'importar_settings_save', settings: s });
    S.settings = s;
    showToast('✓ Ajustes guardados');
  } catch (e) { showToast('Error: ' + e.message, true); }
}
function resetSettings() {
  if (!confirm('¿Restaurar todos los ajustes de Importar a los valores de fábrica? (Se guardan al pulsar "Guardar ajustes".)')) return;
  S.settings = JSON.parse(JSON.stringify(DEFAULTS));
  renderSettings();
}

// ── delete order (Ajustes) ──────────────────────────────────────────────
async function deleteOrderPreview() {
  const orderId = $('del-order-id').value.trim();
  if (!orderId) return;
  $('del-order-result').innerHTML = '<div class="imp-muted">Buscando…</div>';
  try {
    const r = await VP.post({ action: 'delete_order_preview', order_id: orderId });
    renderDeletePreview(r);
  } catch (e) {
    $('del-order-result').innerHTML = `<div class="imp-muted">Error: ${esc(e.message)}</div>`;
  }
}

function renderDeletePreview(r) {
  const photoCount = (r.qc_photos.content || 0) + (r.qc_photos.box || 0);
  const hasWarnings = photoCount > 0 || (r.linked_orders && r.linked_orders.length > 0);
  let html = `<div class="modal-field"><div class="modal-field-label">Pedido</div>
    <div class="modal-field-value">${esc(r.order_id)} · ${esc(r.channel || '')} · ${esc(r.status || '')}</div></div>`;

  if (photoCount > 0) {
    html += `<div class="modal-field" style="color:var(--amber)"><div class="modal-field-label">⚠ Fotos de QC guardadas</div>
      <div class="modal-field-value">${r.qc_photos.content} de contenido, ${r.qc_photos.box} de caja — se perderán si continúas</div></div>`;
  }
  if (r.linked_orders && r.linked_orders.length > 0) {
    const list = r.linked_orders.map(o => `${esc(o.order_id)} (${esc(o.username || '')}, ${esc(o.status)})`).join(', ');
    html += `<div class="modal-field" style="color:var(--amber)"><div class="modal-field-label">⚠ Pedidos Anotado vinculados a este envío</div>
      <div class="modal-field-value">${list} — pasarán a Pagado, sin vínculo</div></div>`;
  }
  if (!hasWarnings) {
    html += `<div class="imp-muted">Sin fotos de QC ni pedidos vinculados.</div>`;
  }
  html += `<div class="imp-btns" style="margin-top:0.75rem">
    <button class="imp-btn" style="background:var(--red,#c0392b);color:#fff" onclick="IMP.deleteOrderConfirm('${esc(r.order_id)}')">Eliminar definitivamente</button>
  </div>`;
  $('del-order-result').innerHTML = html;
}

async function deleteOrderConfirm(orderId) {
  if (!confirm(`¿Eliminar el pedido ${orderId} por completo? Esta acción no se puede deshacer.`)) return;
  try {
    const r = await VP.post({ action: 'delete_order', order_id: orderId });
    showToast(`✓ Pedido ${r.order_id} eliminado (historial: ${r.history_removed} fila(s), desvinculados: ${(r.unlinked_orders || []).length})`);
    $('del-order-id').value = '';
    $('del-order-result').innerHTML = '';
  } catch (e) {
    showToast('Error: ' + e.message, true);
  }
}
async function testSlip() {
  const mode = $('set-test-mode').value;
  const s = readSettingsForm();
  try {
    setProgress(true, 'Generando hoja de prueba…', 50);
    const r = await callImporter({ op: 'test_slip', mode, settings: { slip: s.slip } });
    setProgress(false);
    openPdf(r.pdf_base64, `hoja_prueba_${mode}.pdf`);
  } catch (e) { setProgress(false); showToast('Error: ' + e.message, true); }
}
async function testSticker() {
  const s = readSettingsForm();
  try {
    const r = await callImporter({ op: 'funfacts', test: true, copies: 1, fact: {}, settings: { sticker: s.sticker } });
    openPdf(r.pdf_base64, 'stickers_prueba.pdf');
  } catch (e) { showToast('Error: ' + e.message, true); }
}

// ── Borrar un pedido de TikTok (admin) ────────────────────────────────────
// Search -> see exactly what goes -> confirm (+ a second confirmation with the
// photos if the shipment has quality photos). The server enforces both.
S.purge = {};
function isAdmin() { try { return VP.getRole() === 'admin'; } catch (e) { return false; } }
function thumbUrl(u) {
  return /res\.cloudinary\.com\/.+\/upload\//.test(u) ? u.replace('/upload/', '/upload/w_240,h_240,c_fill,q_auto,f_auto/') : u;
}
function photoGridHtml(items) {
  return `<div style="display:flex;flex-wrap:wrap;gap:8px;margin:8px 0">${(items || []).map(p => `
    <div style="text-align:center;font-size:11px;color:var(--text-muted)">
      <img src="${esc(thumbUrl(p.url))}" data-u="${esc(p.url)}" onclick="VP.lightbox(this.dataset.u)" alt=""
           style="width:96px;height:96px;object-fit:cover;border-radius:8px;cursor:zoom-in;display:block;background:var(--surface2)">
      ${esc(p.label || '')}</div>`).join('')}</div>`;
}
function purgeCardHtml() {
  if (!isAdmin()) return '';
  return `<div class="imp-card" style="border-color:#d99;margin-top:1rem">
    <h3 style="color:#a32d2d">Zona peligrosa · Borrar un pedido de TikTok</h3>
    <div class="imp-muted" style="margin-bottom:8px">Borra el envío por completo: pedido, mensajes importados, historial de importación y registro de Empacar con sus fotos. Los productos de Shopify / Manual y las notas anotadas en ese envío no se borran: quedan sin vincular. Después se puede volver a importar.</div>
    <div class="imp-row">
      <input type="text" id="purge-q" placeholder="Guía (JMX…), ID de pedido o usuario" style="min-width:260px" onkeydown="if(event.key==='Enter')IMP.purgeSearch()">
      <button class="imp-btn" onclick="IMP.purgeSearch()">Buscar</button>
    </div>
    <div id="purge-out"></div></div>`;
}
function renderPurgeOut() {
  const el = $('purge-out');
  if (!el) return;
  const p = S.purge || {};
  if (p.loading) {
    el.innerHTML = `<div class="imp-muted" id="purge-busy" style="padding:10px 0">${esc(p.label || 'Trabajando…')} <span id="purge-secs"></span></div>`;
    tickPurgeTimer(); return;
  }
  if (p.error) { el.innerHTML = `<div class="imp-bad">${esc(p.error)}</div>`; return; }
  if (p.done) {
    const d = p.done.deleted || {};
    const ph = d.photos || {};
    const open = S.result && S.meta.some(m => m.tracking_id === p.done.tracking_id);
    el.innerHTML = `<div class="imp-ok"><b>✓ Borrado:</b> ${esc(p.done.tracking_id)}<br>
      ${d.orders || 0} pedido · ${d.notas || 0} notas importadas · ${d.history_rows || 0} filas de historial · ${d.qc_rows || 0} registro(s) de Empacar${ph.requested ? ` · fotos: ${ph.deleted || 0} borradas` : ''}</div>
      ${ph.error ? `<div class="imp-warn">⚠ ${esc(ph.error)}</div>` : ''}
      ${(p.done.unlinked || []).length ? `<div class="imp-muted">Sin vincular: ${p.done.unlinked.map(u => esc(u.order_id) + ' → ' + esc(u.to_status)).join(' · ')}</div>` : ''}
      ${p.done.customers && p.done.customers !== 'ok' ? `<div class="imp-warn">${esc(p.done.customers)}</div>` : ''}
      <div class="imp-muted" style="margin-top:6px">Ya se puede volver a importar este pedido.${open ? ' La importación que tienes abierta ya no es válida: vuelve a importar los archivos.' : ''}</div>`;
    return;
  }
  if (p.plan) {
    const pl = p.plan, t = (pl.tiktok || [])[0] || {};
    const unlink = pl.unlink || [];
    el.innerHTML = `
      <div style="margin:8px 0"><button class="imp-mini" onclick="IMP.purgeBack()">← Volver a los resultados</button></div>
      <div class="imp-cust-head">${esc(pl.tracking_id)} <span class="imp-muted">· ${esc(t.username || '')} · ${esc(t.customer_id || '')} · ${esc(t.status || '')}</span></div>
      <div class="imp-muted">${esc(t.order_id || '')} — ${esc(t.products || '')}</div>
      <div style="margin-top:8px"><b>Se borrará por completo:</b>
        <div class="imp-list-item">• El pedido de TikTok en Pedidos</div>
        <div class="imp-list-item">• ${plural((pl.notas_csv || []).length, 'mensaje importado del CSV', 'mensajes importados del CSV')}</div>
        <div class="imp-list-item">• ${plural(pl.history_rows || 0, 'fila del historial de importación', 'filas del historial de importación')}</div>
        <div class="imp-list-item">• ${plural(pl.qc_rows || 0, 'registro de Empacar', 'registros de Empacar')}${pl.photos ? ` con <b>${plural(pl.photos, 'foto', 'fotos')}</b>` : ''}</div>
      </div>
      ${unlink.length ? `<div style="margin-top:8px"><b>Se conservan, sin vincular:</b>${unlink.map(u => `<div class="imp-list-item">• ${esc(u.channel)} ${esc(u.order_id)} — ${esc(u.products)} <span class="imp-muted">→ ${esc(u.to_status)}</span></div>`).join('')}</div>` : ''}
      ${pl.photos ? `<div class="imp-bad" style="margin-top:8px"><b>⚠ Este envío ya tiene ${plural(pl.photos, 'foto', 'fotos')} de calidad subidas:</b>${photoGridHtml(pl.photo_items)}Se borrarán junto con el pedido.</div>` : ''}
      ${(pl.warnings || []).map(w => `<div class="imp-warn">⚠ ${esc(w)}</div>`).join('')}
      ${(pl.blockers || []).map(b => `<div class="imp-bad">${esc(b.reason)}</div>`).join('')}
      <div class="imp-btns">
        ${(pl.blockers || []).length ? '' : '<button class="imp-btn" style="background:#a32d2d;color:#fff;border-color:#a32d2d" onclick="IMP.purgeAsk()">Borrar definitivamente…</button>'}
      </div>`;
    return;
  }
  if (p.matches) {
    el.innerHTML = p.matches.length ? p.matches.map(m => `
      <div class="imp-cust"><div class="imp-cust-head">${esc(m.tracking_id)} <span class="imp-muted">· ${esc(m.username)} · ${esc(m.customer_id)} · ${esc(m.status)}</span></div>
        <div class="imp-muted">${esc(m.order_ids)} — ${esc(m.products)}</div>
        <div class="imp-btns" style="margin-top:4px"><button class="imp-mini" data-tid="${esc(m.tracking_id)}" onclick="IMP.purgePick(this.dataset.tid)">Seleccionar</button></div></div>`).join('')
      : '<div class="imp-muted">No se encontró ningún envío de TikTok con eso.</div>';
  }
}
// Runs one slow server call with a visible label and a seconds counter.
// Only one of these runs at a time (double clicks are ignored).
let purgeTimer = null;
function tickPurgeTimer() {
  clearInterval(purgeTimer);
  const start = (S.purge || {}).since || Date.now();
  const tick = () => {
    const el = $('purge-secs');
    if (!el) { clearInterval(purgeTimer); return; }
    el.textContent = `· ${Math.round((Date.now() - start) / 1000)} s`;
  };
  tick();
  purgeTimer = setInterval(tick, 1000);
}
async function purgeCall(label, body) {
  if (S.purgeBusy) return null;
  S.purgeBusy = true;
  S.purge = { loading: true, label: label, since: Date.now() }; renderPurgeOut();
  try { return await VP.post(Object.assign({ action: 'order_purge_preview' }, body)); }
  finally { S.purgeBusy = false; clearInterval(purgeTimer); }
}
async function purgeSearch() {
  const q = ($('purge-q') || {}).value ? $('purge-q').value.trim() : '';
  if (q.length < 3) { showToast('Escribe al menos 3 caracteres', true); return; }
  try {
    const r = await purgeCall('Buscando el envío…', { query: q });
    if (r) { S.purgeMatches = r.matches || []; S.purge = { matches: S.purgeMatches }; }
  } catch (e) { S.purge = { error: e.message }; }
  renderPurgeOut();
}
// The search results stay in memory: selecting one never searches again.
async function purgePick(tid) {
  try {
    const r = await purgeCall('Revisando el envío (puede tardar unos segundos)…', { tracking_id: tid });
    if (r) S.purge = { plan: r.plan };
  } catch (e) { S.purge = { error: e.message }; }
  renderPurgeOut();
}
// Back shows the results already loaded: no new search.
function purgeBack() {
  S.purge = { matches: S.purgeMatches || [] };
  renderPurgeOut();
}
// Prompt 1 (always): permanent. Prompt 2 (only with photos): shows them again.
function purgeAsk() {
  const pl = (S.purge || {}).plan;
  if (!pl || (pl.blockers || []).length) return;
  const t = (pl.tiktok || [])[0] || {};
  const m = VP.showModal(`
    <h3 style="margin:0 0 8px;font-size:16px">¿Borrar este envío?</h3>
    <div style="margin-bottom:8px"><b>${esc(pl.tracking_id)}</b> · ${esc(t.username || '')}</div>
    <div class="imp-bad"><b>Esto es permanente y no se puede deshacer.</b></div>
    <div class="imp-btns"><button class="imp-btn" id="pg-no">Cancelar</button>
      <button class="imp-btn" id="pg-yes" style="background:#a32d2d;color:#fff;border-color:#a32d2d">${pl.photos ? 'Continuar' : 'Sí, borrar definitivamente'}</button></div>`, { maxWidth: '460px' });
  m.el.querySelector('#pg-no').addEventListener('click', () => m.close());
  m.el.querySelector('#pg-yes').addEventListener('click', () => { m.close(); if (pl.photos) purgeAskPhotos(); else purgeRun(false); });
}
function purgeAskPhotos() {
  const pl = S.purge.plan;
  const m = VP.showModal(`
    <h3 style="margin:0 0 8px;font-size:16px;color:#a32d2d">⚠ Hay fotos de calidad subidas</h3>
    <div style="margin-bottom:4px">Este envío tiene <b>${plural(pl.photos, 'foto', 'fotos')}</b> en Empacar. Se borrarán junto con el pedido:</div>
    ${photoGridHtml(pl.photo_items)}
    <div class="imp-bad"><b>Esto no se puede deshacer.</b> ¿Seguro que quieres continuar?</div>
    <div class="imp-btns"><button class="imp-btn" id="pg-no2">Cancelar</button>
      <button class="imp-btn" id="pg-yes2" style="background:#a32d2d;color:#fff;border-color:#a32d2d">Sí, borrar todo, incluidas las fotos</button></div>`, { maxWidth: '620px' });
  m.el.querySelector('#pg-no2').addEventListener('click', () => m.close());
  m.el.querySelector('#pg-yes2').addEventListener('click', () => { m.close(); purgeRun(true); });
}
async function purgeRun(withPhotos) {
  const pl = (S.purge || {}).plan;
  if (!pl || S.purgeBusy) return;
  S.purgeBusy = true;
  S.purge = { loading: true, label: 'Borrando… no cierres esta página', since: Date.now() }; renderPurgeOut();
  try {
    // TROUBLESHOOT: "unauthorized" = the signed-in user is not an admin; any other
    // error comes straight from Apps Script (order_purge), read its message.
    const r = await VP.post({ action: 'order_purge', tracking_id: pl.tracking_id, confirm: 'BORRAR', confirm_photos: !!withPhotos });
    S.purge = { done: r };
    S.purgeMatches = (S.purgeMatches || []).filter(m => m.tracking_id !== pl.tracking_id);
    showToast('Envío borrado');
  } catch (e) { S.purge = { error: e.message, plan: pl }; }
  finally { S.purgeBusy = false; clearInterval(purgeTimer); }
  renderPurgeOut();
}

// ── possible matches (same flow as before; refreshes the configure step) ──
let lastMatches = [];
let allCustomers = [];
let activeMatchIdx = null;

function renderMatches(matches) {
  $('matches-list').innerHTML = matches.map((m, i) => `
    <div class="match-card" id="match-card-${i}">
      <div class="match-card-top"><div class="match-username">${esc(m.username)}</div><div class="match-score">${m.score}% similitud</div></div>
      <div class="match-row">Posible match: <strong>${esc(m.matched_to)}</strong></div>
      <div class="match-row">Tracking: <strong>${esc(m.tracking_id)}</strong></div>
      <div class="match-actions">
        <button class="match-btn primary" onclick="quickConfirm(${i})" style="flex:1.4">✓ Confirmar: ${esc(m.matched_to)}</button>
        <button class="match-btn" onclick="openMatchModal(${i})">Ver detalle</button>
        <button class="match-btn" onclick="toggleAssignDropdown(${i})">Otro ▾</button>
      </div>
      <div class="match-assign-wrap" id="match-assign-${i}">
        <select id="match-select-${i}"><option value="">— Cargando clientes… —</option></select>
        <button class="match-assign-confirm" onclick="confirmAssign(${i})">Confirmar asignación</button>
      </div>
      <div class="match-assigned" id="match-assigned-${i}">✓ Alias asignado</div>
    </div>`).join('');
}
function toggleAssignDropdown(i) {
  const wrap = $(`match-assign-${i}`);
  const open = wrap.style.display === 'block';
  wrap.style.display = open ? 'none' : 'block';
  if (!open) populateSelectDropdown(`match-select-${i}`);
}
async function fetchCustomersForModal() {
  try { allCustomers = (await VP.get('action=customers')).records || []; } catch (e) { allCustomers = []; }
}
function customerOptions() {
  return '<option value="">— Seleccionar cliente —</option>' + allCustomers
    .filter(c => String(c['Primary Username'] || '').indexOf('(merged→') < 0)
    .map(c => `<option value="${esc(c['Customer ID'])}">${esc(c['Primary Username'])} (${esc(c['Customer ID'])})</option>`).join('');
}
function populateSelectDropdown(id) { const s = $(id); if (s) s.innerHTML = customerOptions(); }
async function confirmAssign(i) {
  const custId = ($(`match-select-${i}`) || {}).value;
  if (!custId) { showToast('Selecciona un cliente primero', true); return; }
  await doAddAlias(lastMatches[i].username, custId, i);
}
async function quickConfirm(i) {
  const m = lastMatches[i];
  const found = allCustomers.find(c => c['Primary Username'] === m.matched_to);
  if (!found) { showToast('No se encontró el cliente sugerido, usa "Otro"', true); return; }
  await doAddAlias(m.username, found['Customer ID'], i);
}
async function confirmModalAssign() {
  const custId = $('modal-customer-select').value;
  if (!custId) { showToast('Selecciona un cliente primero', true); return; }
  await doAddAlias(lastMatches[activeMatchIdx].username, custId, activeMatchIdx);
  closeModal();
}
async function doAddAlias(username, customerId, cardIdx) {
  try {
    await VP.post({ action: 'add_alias', customer_id: customerId, alias: username });
    await VP.post({ action: 'stamp_customer_ids' });
    const a = $(`match-assigned-${cardIdx}`); if (a) a.style.display = 'block';
    const w = $(`match-assign-${cardIdx}`); if (w) w.style.display = 'none';
    showToast(`${username} asignado como alias`);
    if (S.result && S.result.shipments_meta) {
      await loadContext();
      initSelectionsKeep();
      renderConfigure();
    }
  } catch (err) { showToast(`Error al asignar: ${err.message}`, true); }
}
function openMatchModal(i) {
  activeMatchIdx = i;
  const m = lastMatches[i];
  const e = m.enriched || {};
  $('modal-username').textContent = `${m.username}`;
  $('modal-score').textContent = `${m.score}%`;
  $('modal-matched-to').textContent = m.matched_to || '—';
  setModalField('modal-name', [e['First Name'], e['Surname']].filter(Boolean).join(' '));
  setModalField('modal-address', e['Street + Number']);
  setModalField('modal-location', [e['City'], e['State'], e['ZIP']].filter(Boolean).join(' / '));
  setModalField('modal-phone', e['Phone Partial']);
  const sel = $('modal-customer-select');
  sel.innerHTML = customerOptions();
  const found = allCustomers.find(c => c['Primary Username'] === m.matched_to);
  if (found) sel.value = found['Customer ID'];
  $('match-modal').classList.add('open');
}
function closeModal() { $('match-modal').classList.remove('open'); activeMatchIdx = null; }
function setModalField(id, val) {
  const el = $(id);
  if (!el) return;
  el.textContent = val || 'No disponible';
  el.classList.toggle('empty', !val);
}
$('match-modal').addEventListener('click', function (e) { if (e.target === this) closeModal(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });

// ── public handlers for inline onclick ────────────────────────────────────
window.IMP = {
  tab, setOpt, setDupeFilter, toggleExtra, setExtraTid, markAll, editNota, toggleNotaKey, duplicateNota, generate, reopenPdf,
  giftOpen, giftClose, giftChange, giftSearch, giftPick, giftPickNew, giftCreate, giftUndo, giftGiveaway, noteFilter, noteAll, setGiftQty,  giftOpen, giftClose, giftChange, giftSearch, giftPick, giftPickNew, giftCreate, giftUndo, giftGiveaway, noteFilter, noteAll, setGiftQty,
  giftShipSearch, giftShipPick, giftVirtualClose,  downloadLegacy, downloadCombinedCsv, pickFact, setCopies, generateStickers, histFile, reopen,
  ffPreview, ffAdd, ffOp, ffFile, ffTemplate, goReview, saveSettings, resetSettings, testSticker,
  ffpOpen, ffpClose, ffpTest, ffpPrint,
  purgeSearch, purgePick, purgeBack, purgeAsk, purgeAskPhotos, purgeRun, setOptEl, settingsChanged, testSlip,
  deleteOrderPreview, deleteOrderConfirm,
};

(async function init() {
  try { await VP.ensureToken(); } catch (e) { return; }
  loadSettings();
})();
