// pick.js — Empacar: lista visual de productos, problemas, escáner de guías, modo continuo.
//
// Loaded AFTER qc.js (see qc.html). It does not edit qc.js behaviour: it wraps four
// qc.js functions (openCapture, backToPending, submitQC, refreshSubmitState) and
// exposes window.vpPick, which two tiny hooks in renderPendingList() call to paint the
// yellow "problem" state. Everything is guarded, so if this file fails to load the
// Empacar page keeps working exactly as before.
//
// Backend: pick_lines, save_pick, empacar_settings, user_settings_save, catalog_set_fields
// (see apps-script_PICK_BLOCK.gs).
(function () {
  'use strict';
  if (typeof VP === 'undefined' || typeof document === 'undefined') return;

  const PK = window.vpPick = {};

  // ── Constants ────────────────────────────────────────────────────────────
  const DEFAULT_FLAGS = {
    pickListEnabled: true, pickLockRequired: false, problemOverrideAllowed: true,
    productScanEnabled: true, lowStockEnabled: true, batchPickEnabled: false,
  };
  const REASONS = [['no_encontrado', 'No encontrado'], ['sobrevendido', 'Sobrevendido'], ['danado', 'Dañado'], ['otro', 'Otro']];
  const MODE_KEY = 'vp_pk_scanmode';
  // Pinned (exact version, > 2 weeks old). jsDelivr first, cdnjs as backup.
  const QR_LIB_URLS = [
    'https://cdn.jsdelivr.net/npm/html5-qrcode@2.3.8/html5-qrcode.min.js',
    'https://cdnjs.cloudflare.com/ajax/libs/html5-qrcode/2.3.8/html5-qrcode.min.js',
  ];
  const WANTED_FORMATS = ['code_128', 'qr_code', 'ean_13', 'ean_8', 'code_39', 'upc_a', 'itf', 'codabar', 'data_matrix'];

  // ── State ────────────────────────────────────────────────────────────────
  const S = {
    flags: Object.assign({}, DEFAULT_FLAGS),
    scanMode: localStorage.getItem(MODE_KEY) === 'continuous' ? 'continuous' : 'manual',
    visible: false,      // the pick section exists for the open order
    expanded: true,
    loaded: false, loading: false, error: '',
    lines: [],           // server lines + local state: packed, problem, reason, note, method, code
    dirty: false, saving: false, sending: false,
    sessionOpen: '',
    baseAt: '', savedBy: '', savedAt: '',
  };
  PK.state = S;

  // ── Small helpers ────────────────────────────────────────────────────────
  const $ = id => document.getElementById(id);
  const esc = s => (typeof escapeHtml === 'function' ? escapeHtml(s) : String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])));
  const escA = s => (typeof escapeAttr === 'function' ? escapeAttr(s) : esc(s));
  const toast = (m, err) => { try { showToast(m, !!err); } catch (e) { console.log('[pick]', m); } };
  const enc = encodeURIComponent;
  const vib = p => { try { if (navigator.vibrate) navigator.vibrate(p); } catch (e) {} };
  const normKey = s => String(s == null ? '' : s).toUpperCase().replace(/[^A-Z0-9]/g, '');
  const isAdmin = () => { try { return (VP.getRole && VP.getRole()) === 'admin'; } catch (e) { return false; } };
  const meName = () => { try { return String(VP.getUserName() || '').toUpperCase(); } catch (e) { return ''; } };
  const initials = s => String(s || '?').split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0]).join('').toUpperCase() || '?';
  const reasonLabel = r => (REASONS.find(x => x[0] === r) || [0, 'Problema'])[1];
  const fmtWhen = iso => {
    const d = new Date(iso); if (isNaN(d.getTime())) return '';
    const t = d.toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' });
    return d.toDateString() === new Date().toDateString() ? t : d.toLocaleDateString('es-MX', { day: 'numeric', month: 'short' }) + ' ' + t;
  };

  function qcRowOf(tid) {
    if (!tid || typeof allQcRows === 'undefined') return null;
    return allQcRows.find(r => r['Tracking ID'] === tid) || null;
  }
  function curTracking() {
    if (typeof selected === 'undefined' || !selected) return '';
    return selected.tracking_id || (typeof manualTrackingId !== 'undefined' ? manualTrackingId : '');
  }
  function rowShipped() { const q = qcRowOf(curTracking()); return !!(q && q['Status'] === 'Enviado'); }
  function readOnly() { return rowShipped() && !(typeof isEditingShipped !== 'undefined' && isEditingShipped); }
  function refreshSubmit() { try { if (typeof refreshSubmitState === 'function') refreshSubmitState(); } catch (e) {} }

  // ── Styles ───────────────────────────────────────────────────────────────
  function injectStyle() {
    if ($('vp-pick-style')) return;
    const st = document.createElement('style');
    st.id = 'vp-pick-style';
    st.textContent = `
:root{--pk-green:#1f8a4c;--pk-green-bg:#e6f5ec;--pk-yellow:#d9a400;--pk-yellow-bg:#fff4cc;--pk-yellow-text:#6b4e00;--pk-red:#b42318}
[data-theme="dark"]{--pk-green:#4cc47f;--pk-green-bg:#12301f;--pk-yellow:#e0b020;--pk-yellow-bg:#3a3114;--pk-yellow-text:#f3d479;--pk-red:#ff7b6e}
.pending-card--problem{background:var(--pk-yellow-bg);border:1px solid var(--pk-yellow)}
.pending-card--problem:active{filter:brightness(.96)}
.pk-card-note{font-size:12px;margin-top:6px;color:var(--text-muted)}
.pk-card-note--problem{color:var(--pk-yellow-text);font-weight:700}
.pk-card-note--ok{color:var(--pk-green);font-weight:600}
.pk-tool{flex:0 0 auto;height:34px;min-width:34px;padding:0 9px;border:0.5px solid var(--border-strong);border-radius:var(--radius-md);background:var(--surface2);color:var(--text);font-family:inherit;font-size:12px;font-weight:700;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:5px}
.pk-tool:active{transform:scale(.96)}
.pk-mode.cont{background:var(--text);color:var(--surface)}
.pk-section{margin-bottom:14px}
.pk-open-btn{width:100%;padding:13px;font-size:14px;font-weight:700;font-family:inherit;border:1px solid var(--border-strong);border-radius:var(--radius-lg);background:var(--surface);color:var(--text);cursor:pointer}
.pk-open-btn:disabled{opacity:.6}
.pk-err{margin-top:6px;font-size:12px;color:var(--pk-red)}
.pk-card{background:var(--surface);border:0.5px solid var(--border);border-radius:var(--radius-lg);padding:10px}
.pk-head{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.pk-title{font-size:14px;font-weight:700;flex:1;min-width:120px}
.pk-chip{font-size:11px;font-weight:700;padding:3px 8px;border-radius:99px;background:var(--surface2);color:var(--text-muted)}
.pk-chip.ok{background:var(--pk-green-bg);color:var(--pk-green)}
.pk-chip.prob{background:var(--pk-yellow-bg);color:var(--pk-yellow-text)}
.pk-sub{font-size:11px;color:var(--text-muted);margin:4px 0 6px}
.pk-grp{font-size:11px;font-weight:700;color:var(--text-muted);text-transform:uppercase;letter-spacing:.4px;margin:10px 0 4px}
.pk-row{display:grid;grid-template-columns:56px 1fr auto;gap:10px;align-items:center;padding:8px;margin-top:6px;border:1px solid var(--border);border-radius:var(--radius-md);background:var(--bg)}
.pk-row.part{border-left:4px solid var(--pk-green)}
.pk-row.done{background:var(--pk-green-bg);border-color:var(--pk-green)}
.pk-row.prob{background:var(--pk-yellow-bg);border-color:var(--pk-yellow)}
.pk-img{position:relative;width:56px;height:56px;border-radius:8px;overflow:hidden;background:var(--surface2);display:flex;align-items:center;justify-content:center;cursor:pointer}
.pk-img img{width:100%;height:100%;object-fit:cover;display:block}
.pk-ph{font-size:16px;font-weight:700;color:var(--text-muted)}
.pk-approx{position:absolute;right:2px;bottom:1px;font-style:normal;font-size:11px;font-weight:700;background:rgba(0,0,0,.55);color:#fff;border-radius:6px;padding:0 4px}
.pk-info{min-width:0}
.pk-name{font-size:13px;font-weight:700;line-height:1.25;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.pk-var{font-size:12px;color:var(--text-muted);margin-top:2px}
.pk-meta{font-size:11px;margin-top:3px;color:var(--text-muted)}
.pk-meta.warn{color:var(--pk-yellow-text);font-weight:700}
.pk-meta button{border:none;background:none;color:var(--text-muted);font-size:11px;padding:0;margin-left:4px;cursor:pointer;text-decoration:underline;font-family:inherit}
.pk-ctl{display:flex;align-items:center;gap:6px}
.pk-btn{width:40px;height:40px;border-radius:10px;border:1px solid var(--border-strong);background:var(--surface);color:var(--text);font-size:18px;font-weight:700;font-family:inherit;cursor:pointer;display:flex;align-items:center;justify-content:center;padding:0}
.pk-btn:disabled,.pk-cnt:disabled{opacity:.45}
.pk-btn:active{transform:scale(.94)}
.pk-check.on{background:var(--pk-green);border-color:var(--pk-green);color:#fff}
.pk-prob{font-size:16px}
.pk-row.prob .pk-prob{background:var(--pk-yellow);border-color:var(--pk-yellow);color:#000}
.pk-cnt{min-width:48px;height:40px;border-radius:10px;border:1px solid var(--border-strong);background:var(--surface);color:var(--text);font-size:14px;font-weight:700;font-family:inherit;cursor:pointer}
.pk-row.done .pk-cnt{background:var(--pk-green);border-color:var(--pk-green);color:#fff}
.pk-save{width:100%;margin-top:10px;padding:13px;font-size:14px;font-weight:700;font-family:inherit;border:none;border-radius:var(--radius-lg);background:var(--text);color:var(--surface);cursor:pointer}
.pk-save:disabled{opacity:.45}
.pk-empty{padding:12px;font-size:13px;color:var(--text-muted);text-align:center}
.pk-hint{font-size:12px;font-weight:600;margin:0 0 8px;padding:8px 10px;border-radius:var(--radius-md);background:var(--surface2);color:var(--text-muted)}
.pk-hint.ok{background:var(--pk-green-bg);color:var(--pk-green)}
.pk-hint.prob{background:var(--pk-yellow-bg);color:var(--pk-yellow-text)}
.pk-sheet-bg{position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:400;display:flex;align-items:flex-end;justify-content:center}
.pk-sheet{width:100%;max-width:480px;background:var(--surface);border-radius:18px 18px 0 0;padding:16px 16px calc(16px + env(safe-area-inset-bottom));display:flex;flex-direction:column;gap:8px}
.pk-sheet-title{font-size:15px;font-weight:700}
.pk-sheet-sub{font-size:12px;color:var(--text-muted);margin-bottom:2px}
.pk-reason{padding:13px;font-size:14px;font-weight:700;font-family:inherit;border:1px solid var(--border-strong);border-radius:12px;background:var(--bg);color:var(--text);cursor:pointer}
.pk-reason.on{background:var(--pk-yellow);border-color:var(--pk-yellow);color:#000}
.pk-clear{color:var(--pk-red)}
.pk-cancel{background:none;border-color:transparent;color:var(--text-muted)}
.pk-note{padding:11px;font-size:14px;font-family:inherit;border:1px solid var(--border-strong);border-radius:12px;background:var(--bg);color:var(--text)}
.pk-scan{position:fixed;inset:0;z-index:450;background:#000;color:#fff;display:flex;flex-direction:column;transition:box-shadow .15s}
.pk-scan.ok{box-shadow:inset 0 0 0 10px #1f8a4c}
.pk-scan.bad{box-shadow:inset 0 0 0 10px #d92d20}
.pk-scan-top{display:flex;align-items:center;justify-content:space-between;padding:calc(12px + env(safe-area-inset-top)) 14px 10px}
.pk-scan-title{font-size:15px;font-weight:700}
.pk-scan-btn{padding:9px 14px;border-radius:10px;border:1px solid rgba(255,255,255,.4);background:rgba(255,255,255,.12);color:#fff;font-size:13px;font-weight:700;font-family:inherit;cursor:pointer}
.pk-scan-view{position:relative;flex:1;min-height:0;overflow:hidden;background:#111}
.pk-scan-view video{width:100%;height:100%;object-fit:cover}
#pk-reader{width:100%;height:100%;display:none}
.pk-scan-frame{position:absolute;left:7%;right:7%;top:30%;height:28%;border:2px solid rgba(255,255,255,.85);border-radius:14px;box-shadow:0 0 0 999px rgba(0,0,0,.35);pointer-events:none}
.pk-scan-status{padding:10px 14px;font-size:13px;font-weight:600;text-align:center;min-height:40px}
.pk-scan-status.ok{color:#6ee7a0}.pk-scan-status.bad{color:#ff8f85}
.pk-scan-bottom{display:flex;gap:8px;padding:0 14px calc(14px + env(safe-area-inset-bottom))}
.pk-scan-bottom input{flex:1;min-width:0;padding:11px;border-radius:10px;border:1px solid rgba(255,255,255,.35);background:rgba(255,255,255,.1);color:#fff;font-size:14px;font-family:inherit}
.pk-scan-bottom input::placeholder{color:rgba(255,255,255,.55)}
`;
    document.head.appendChild(st);
  }

  // ── Settings ─────────────────────────────────────────────────────────────
  function paintMode() {
    const b = $('pk-mode-btn'); if (!b) return;
    const cont = S.scanMode === 'continuous';
    b.classList.toggle('cont', cont);
    b.textContent = cont ? 'Continuo' : 'Manual';
    b.title = 'Modo de escaneo: ' + (cont ? 'continuo (reabre la cámara después de cada envío)' : 'manual');
  }
  function setMode(mode, save) {
    S.scanMode = mode === 'continuous' ? 'continuous' : 'manual';
    try { localStorage.setItem(MODE_KEY, S.scanMode); } catch (e) {}
    paintMode();
    if (save) VP.post({ action: 'user_settings_save', scan_mode: S.scanMode }).catch(e => console.warn('[pick] could not save scan mode', e)); // not critical: the device keeps its own copy
  }
  async function waitForToken() {
    for (let i = 0; i < 100; i++) { try { if (VP.token) return true; } catch (e) {} await new Promise(r => setTimeout(r, 300)); }
    return false;
  }
  async function loadSettings() {
    try {
      if (!(await waitForToken())) return;
      const res = await VP.get('action=empacar_settings');
      if (res && res.flags) Object.assign(S.flags, res.flags);
      if (res && res.user && res.user.scanMode && res.user.scanMode !== S.scanMode) setMode(res.user.scanMode, false);
      if (S.visible) { renderSection(); refreshSubmit(); updateHint(); }
    } catch (e) { console.warn('[pick] settings not loaded (backend not deployed yet?)', e); } // defaults stay in effect
  }

  // ── Pending list hooks (called from qc.js renderPendingList) ─────────────
  PK.problemCls = function (tid) {
    const q = qcRowOf(tid);
    return q && q['Pick Status'] === 'Problema' ? ' pending-card--problem' : '';
  };
  PK.cardNote = function (tid) {
    const q = qcRowOf(tid); if (!q) return '';
    const st = q['Pick Status']; if (!st) return '';
    const by = q['Pick By'] ? ' · ' + q['Pick By'] : '';
    if (st === 'Problema') return '<div class="pk-card-note pk-card-note--problem">⚠ ' + esc(q['Pick Problems'] || 'Producto con problema') + '</div>';
    if (st === 'Completo') return '<div class="pk-card-note pk-card-note--ok">✓ Productos completos' + esc(by) + '</div>';
    return '<div class="pk-card-note">Productos: parcial' + esc(by) + '</div>';
  };

  // ── Pick section (capture view) ──────────────────────────────────────────
  function ensureSection() {
    let el = $('pk-section');
    if (el) return el;
    const anchor = $('capture-editable-area');
    if (!anchor || !anchor.parentNode) return null;
    el = document.createElement('div');
    el.id = 'pk-section';
    el.className = 'pk-section';
    anchor.parentNode.insertBefore(el, anchor);
    el.addEventListener('click', onSectionClick);
    el.addEventListener('error', onImgError, true);   // <img> errors do not bubble: capture phase
    return el;
  }
  function ensureHint() {
    let el = $('pk-send-hint');
    if (el) return el;
    const btn = $('qc-submit');
    if (!btn || !btn.parentNode) return null;
    el = document.createElement('div');
    el.id = 'pk-send-hint';
    el.className = 'pk-hint';
    el.style.display = 'none';
    btn.parentNode.insertBefore(el, btn);
    return el;
  }

  function lineState(l) { return l.problem ? 'prob' : (l.packed >= l.qty ? 'done' : (l.packed > 0 ? 'part' : 'todo')); }
  function summary() {
    let pieces = 0, packed = 0, missing = 0; const problems = [];
    S.lines.forEach(l => {
      pieces += l.qty; packed += Math.min(l.packed, l.qty);
      if (l.problem) problems.push(l); else if (l.packed < l.qty) missing++;
    });
    return { pieces, packed, missing, problems, lines: S.lines.length };
  }

  function imgHtml(l, i) {
    const ph = initials(l.name);
    if (!l.image) return '<div class="pk-img" data-act="img" data-i="' + i + '" data-ph="' + escA(ph) + '"><span class="pk-ph">' + esc(ph) + '</span></div>';
    return '<div class="pk-img" data-act="img" data-i="' + i + '" data-ph="' + escA(ph) + '"><img src="' + escA(l.image) + '" alt="" loading="lazy" referrerpolicy="no-referrer">' + (l.image_approx ? '<i class="pk-approx">≈</i>' : '') + '</div>';
  }
  function onImgError(ev) {
    const img = ev.target;
    if (!img || img.tagName !== 'IMG') return;
    const w = img.parentNode; if (!w) return;
    const ph = w.getAttribute('data-ph') || '?';
    img.remove();
    w.insertAdjacentHTML('afterbegin', '<span class="pk-ph">' + esc(ph) + '</span>');
  }
  function ctlHtml(l, i, ro) {
    const d = ro ? ' disabled' : '';
    const prob = '<button class="pk-btn pk-prob" data-act="prob" data-i="' + i + '"' + d + ' aria-label="Marcar problema">⚠</button>';
    if (l.qty === 1) return '<button class="pk-btn pk-check' + (l.packed >= 1 ? ' on' : '') + '" data-act="check" data-i="' + i + '"' + d + ' aria-label="Empacado">' + (l.packed >= 1 ? '✓' : '') + '</button>' + prob;
    return '<button class="pk-btn" data-act="dec" data-i="' + i + '"' + d + ' aria-label="Menos">−</button>' +
      '<button class="pk-cnt" data-act="full" data-i="' + i + '"' + d + '>' + l.packed + '/' + l.qty + '</button>' +
      '<button class="pk-btn" data-act="inc" data-i="' + i + '"' + d + ' aria-label="Más">+</button>' + prob;
  }
  function rowHtml(l, i, ro) {
    const lowStock = S.flags.lowStockEnabled && l.stock !== null && l.stock !== undefined && l.low_stock_at !== null && l.low_stock_at !== undefined && l.stock <= l.low_stock_at;
    const meta = [];
    if (l.problem) meta.push('<div class="pk-meta warn">⚠ ' + esc(reasonLabel(l.reason)) + (l.note ? ' — ' + esc(l.note) : '') + '</div>');
    if (l.image_approx) meta.push('<div class="pk-meta">≈ foto de otra variante</div>');
    if (lowStock) meta.push('<div class="pk-meta warn">Stock bajo (quedan ' + esc(l.stock) + ')</div>');
    if (!l.catalog_id) meta.push('<div class="pk-meta">Sin ligar al catálogo</div>');
    if (isAdmin() && l.catalog_id) meta.push('<div class="pk-meta"><button data-act="setimg" data-i="' + i + '">📷 ' + (l.image ? 'cambiar' : 'poner') + ' foto</button></div>');
    return '<div class="pk-row ' + lineState(l) + '">' + imgHtml(l, i) +
      '<div class="pk-info"><div class="pk-name">' + esc(l.name || l.label) + '</div>' +
      (l.variation ? '<div class="pk-var">' + esc(l.variation) + '</div>' : '') + meta.join('') + '</div>' +
      '<div class="pk-ctl">' + ctlHtml(l, i, ro) + '</div></div>';
  }
  function groupTitle(l) {
    if (l.channel === 'TikTok') return 'Pedido TikTok …' + String(l.order_id).slice(-6);
    return 'Agregado · ' + (l.channel || 'Manual') + ' ' + l.order_id;
  }

  function renderSection() {
    const el = ensureSection(); if (!el) return;
    if (!S.visible || !S.flags.pickListEnabled) { el.style.display = 'none'; el.innerHTML = ''; return; }
    el.style.display = 'block';
    if (!S.loaded) {
      el.innerHTML = '<button class="pk-open-btn" data-act="open"' + (S.loading ? ' disabled' : '') + '>' + (S.loading ? 'Cargando productos…' : '📦 Ver productos') + '</button>' +
        (S.error ? '<div class="pk-err">' + esc(S.error) + '</div>' : '');
      return;
    }
    const ro = readOnly();
    const m = summary();
    const chip = m.problems.length ? '<span class="pk-chip prob">⚠ ' + m.problems.length + ' con problema</span>'
      : (m.lines && !m.missing ? '<span class="pk-chip ok">✓ Completo</span>' : '<span class="pk-chip">' + m.packed + '/' + m.pieces + ' piezas</span>');
    const hasBar = S.lines.some(l => l.barcode);
    let html = '<div class="pk-card"><div class="pk-head"><div class="pk-title">Productos · ' + m.pieces + ' pieza' + (m.pieces !== 1 ? 's' : '') + '</div>' + chip +
      (S.flags.productScanEnabled && hasBar && !ro ? '<button class="pk-tool" data-act="scanprod" title="Escanear productos">▦ Escanear</button>' : '') +
      '<button class="pk-tool" data-act="toggle" aria-label="Plegar">' + (S.expanded ? '▴' : '▾') + '</button>' +
      '<button class="pk-tool" data-act="close" aria-label="Cerrar lista">✕</button></div>';
    if (S.savedBy) html += '<div class="pk-sub">Revisado por ' + esc(S.savedBy) + (S.savedAt ? ' · ' + esc(fmtWhen(S.savedAt)) : '') + '</div>';
    if (S.expanded) {
      if (!S.lines.length) {
        html += '<div class="pk-empty">No se encontraron productos para este envío en el historial de TikTok.</div>';
      } else {
        let lastGrp = null; const multi = new Set(S.lines.map(l => l.channel + '|' + l.order_id)).size > 1;
        S.lines.forEach((l, i) => {
          const g = l.channel + '|' + l.order_id;
          if (multi && g !== lastGrp) { html += '<div class="pk-grp">' + esc(groupTitle(l)) + '</div>'; lastGrp = g; }
          html += rowHtml(l, i, ro);
        });
        if (!ro) html += '<button class="pk-save" data-act="save"' + (!S.dirty || S.saving ? ' disabled' : '') + '>' + (S.saving ? 'Guardando…' : (S.dirty ? 'Guardar productos' : (S.savedAt ? '✓ Guardado' : 'Guardar productos'))) + '</button>';
      }
    }
    html += '</div>';
    el.innerHTML = html;
  }

  function updateHint() {
    const el = ensureHint(); if (!el) return;
    let txt = '', cls = '';
    if (S.visible && S.flags.pickListEnabled && !rowShipped() && !(typeof isEditingShipped !== 'undefined' && isEditingShipped)) {
      if (!S.loaded) {
        if (S.flags.pickLockRequired) txt = 'Abre «Ver productos» y completa la lista antes de enviar.';
      } else if (S.lines.length) {
        const m = summary();
        if (S.dirty) txt = 'Guarda los productos antes de enviar.';
        else if (m.missing) txt = 'Faltan ' + m.missing + ' producto' + (m.missing !== 1 ? 's' : '') + ' por marcar.';
        else if (m.problems.length) { txt = 'Hay ' + m.problems.length + ' producto' + (m.problems.length !== 1 ? 's' : '') + ' con problema — al enviar se pedirá confirmación.'; cls = 'prob'; }
        else { txt = '✓ Todos los productos están listos.'; cls = 'ok'; }
      }
    }
    el.className = 'pk-hint' + (cls ? ' ' + cls : '');
    el.textContent = txt;
    el.style.display = txt ? 'block' : 'none';
  }

  function markDirty() { S.dirty = true; updateHint(); refreshSubmit(); }

  // ── Load / save ──────────────────────────────────────────────────────────
  function pickQs() {
    const orderIds = selected.order_ids || [];
    const tt = [];
    orderIds.filter(o => o.channel === 'TikTok').forEach(o => String(o.id).split('+').forEach(x => { const d = x.replace(/\D/g, ''); if (d && tt.indexOf(d) < 0) tt.push(d); }));
    const addons = [];
    orderIds.filter(o => o.channel !== 'TikTok').concat(typeof selectedAddons !== 'undefined' ? selectedAddons : []).forEach(o => {
      if (o && o.id && !addons.some(a => String(a.id) === String(o.id))) addons.push({ id: String(o.id), channel: o.channel || '' });
    });
    const q = qcRowOf(curTracking());
    return 'action=pick_lines&tracking_id=' + enc(curTracking()) + '&ids=' + enc(tt.join(',')) +
      '&addons=' + enc(addons.map(a => (a.channel ? a.channel + ':' : '') + a.id).join(',')) +
      '&saved=' + (q && q['Pick At'] ? '1' : '0');
  }

  async function load() {
    if (S.loading || typeof selected === 'undefined' || !selected) return;
    S.loading = true; S.error = ''; renderSection();
    const gen = typeof captureGen !== 'undefined' ? captureGen : 0;
    try {
      const qs = pickQs();
      const res = await (S.pre && S.pre.qs === qs ? S.pre.p : VP.get(qs));
      S.pre = null;
      if (gen !== (typeof captureGen !== 'undefined' ? captureGen : 0)) return;   // another order was opened meanwhile
      if (res.flags) Object.assign(S.flags, res.flags);
      const saved = res.saved || {};
      S.lines = (res.lines || []).map(l => {
        const s = saved[l.key];
        return Object.assign({}, l, {
          packed: s ? Math.min(l.qty, Math.max(0, s.packed || 0)) : 0,
          problem: !!(s && s.state === 'problema'), reason: s ? (s.reason || '') : '', note: s ? (s.note || '') : '',
          method: 'tap', code: '',
        });
      });
      S.savedBy = res.saved_by || ''; S.savedAt = res.saved_at || '';
      S.baseAt = (res.qc && res.qc.at) || '';
      S.sessionOpen = new Date().toISOString();
      S.loaded = true; S.dirty = false; S.expanded = true;
    } catch (e) {
      S.pre = null;
      S.error = 'No se pudieron cargar los productos: ' + (e.message || e);   // backend not updated yet, or no connection: press the button to retry
    } finally {
      S.loading = false;
      if (gen === (typeof captureGen !== 'undefined' ? captureGen : 0)) { renderSection(); updateHint(); refreshSubmit(); }
    }
  }

  function payload(kind) {
    return {
      action: 'save_pick', save_kind: kind, tracking_id: curTracking(),
      username: selected.username, customer_id: selected.customer_id, order_ids: selected.order_ids,
      session_open: S.sessionOpen,
      lines: S.lines.map(l => ({
        key: l.key, order_id: l.order_id, channel: l.channel, catalog_id: l.catalog_id, sku_id: l.sku_id, label: l.label,
        qty_ordered: l.qty, qty_packed: l.packed, problem: !!l.problem, reason: l.reason || '', note: l.note || '',
        method: l.method || 'tap', code: l.code || '',
      })),
    };
  }

  function applySaved(res) {
    S.dirty = false; S.savedBy = res.saved_by || S.savedBy; S.savedAt = res.saved_at || S.savedAt;
    const tid = curTracking();
    let row = qcRowOf(tid);
    if (!row && typeof allQcRows !== 'undefined') {
      row = { 'QC ID': res.qc_id, 'Tracking ID': tid, 'Status': 'Activo' };
      allQcRows.push(row);
    }
    if (row) {
      row['Pick Status'] = res.pick_status || ''; row['Pick Problems'] = res.pick_problems || '';
      row['Pick By'] = res.saved_by || ''; row['Pick At'] = res.saved_at || '';
    }
    try { if (typeof currentQcId !== 'undefined' && !currentQcId && res.qc_id) currentQcId = res.qc_id; } catch (e) {}
    const prev = res.previous || {};
    if (prev.by && prev.at && prev.at !== S.baseAt && String(prev.by).toUpperCase() !== meName()) {
      toast('⚠ ' + prev.by + ' también guardó productos hace poco. Se guardó tu versión.', true);
    }
    S.baseAt = res.saved_at || S.baseAt;
  }

  async function save() {
    if (S.saving || !S.dirty || !S.loaded || typeof selected === 'undefined' || !selected) return;
    S.saving = true; renderSection();
    const gen = typeof captureGen !== 'undefined' ? captureGen : 0;
    try {
      const res = await VP.post(payload('guardar'));
      if (gen !== (typeof captureGen !== 'undefined' ? captureGen : 0)) return;
      applySaved(res);
      toast('✓ Productos guardados');
    } catch (e) {
      toast('No se pudo guardar: ' + (e.message || e), true);   // ticks stay on screen: press Guardar again
    } finally {
      S.saving = false;
      if (gen === (typeof captureGen !== 'undefined' ? captureGen : 0)) { renderSection(); updateHint(); refreshSubmit(); }
    }
  }

  function pickFile() {
    return new Promise(resolve => {
      const inp = document.createElement('input');
      inp.type = 'file'; inp.accept = 'image/*'; inp.style.display = 'none';
      inp.onchange = () => resolve(inp.files && inp.files[0] ? inp.files[0] : null);
      document.body.appendChild(inp);
      inp.click();
      setTimeout(() => inp.remove(), 60000);
    });
  }
  function fileToDataUrl(file) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = () => reject(new Error('No se pudo leer el archivo'));
      r.readAsDataURL(file);
    });
  }

  async function setImage(i) {
    const l = S.lines[i];
    if (!l || !l.catalog_id) { toast('Esta línea no está ligada al catálogo', true); return; }
    const file = await pickFile();
    if (!file) return;
    if (file.size > 15 * 1024 * 1024) { toast('La foto es demasiado grande (máx 15MB)', true); return; }
    toast('Subiendo foto…');
    try {
      const dataUrl = await fileToDataUrl(file);
      const res = await VP.post({ action: 'catalog_upload_image', catalog_id: l.catalog_id, file_name: file.name, file_data: dataUrl });
      if (!res || !res.ok) throw new Error((res && res.error) || 'Error desconocido');
      S.lines.forEach(x => { if (x.catalog_id === l.catalog_id) { x.image = res.thumb_url; x.image_approx = false; } });
      renderSection();
      toast('✓ Foto guardada');
    } catch (e) { toast('No se pudo subir la foto: ' + (e.message || e), true); }   // only admins can change catalog photos
  }

  // ── Section clicks ───────────────────────────────────────────────────────
  function onSectionClick(ev) {
    const b = ev.target.closest('[data-act]'); if (!b || b.disabled) return;
    const act = b.getAttribute('data-act'), i = parseInt(b.getAttribute('data-i'), 10);
    const l = isNaN(i) ? null : S.lines[i];
    if (act === 'open') { load(); return; }
    if (act === 'toggle') { S.expanded = !S.expanded; renderSection(); return; }
    if (act === 'close') {
      if (S.dirty && !confirm('Tienes productos sin guardar. ¿Cerrar la lista sin guardar?')) return;
      S.loaded = false; S.lines = []; S.dirty = false; S.error = '';
      renderSection(); updateHint(); refreshSubmit(); return;
    }
    if (act === 'save') { save(); return; }
    if (act === 'scanprod') { PK.scanProduct(); return; }
    if (!l) return;
    if (act === 'img') { if (l.image && typeof openLightbox === 'function') openLightbox(l.image); return; }
    if (act === 'setimg') { setImage(i); return; }
    if (readOnly()) return;
    if (act === 'prob') { openSheet(i); return; }
    if (act === 'check') {
      if (l.problem) { l.problem = false; l.reason = ''; l.note = ''; l.packed = l.qty; }
      else l.packed = l.packed >= 1 ? 0 : 1;
      l.method = 'tap';
    } else if (act === 'inc') { l.packed = Math.min(l.qty, l.packed + 1); l.method = 'tap'; }
    else if (act === 'dec') { l.packed = Math.max(0, l.packed - 1); l.method = 'tap'; }
    else if (act === 'full') { l.packed = l.packed >= l.qty ? 0 : l.qty; l.method = 'tap'; }
    else return;
    markDirty(); renderSection();
  }

  // ── Problem sheet ────────────────────────────────────────────────────────
  function closeSheet() { const s = $('pk-sheet'); if (s) s.remove(); }
  function openSheet(i) {
    closeSheet();
    const l = S.lines[i]; if (!l) return;
    const el = document.createElement('div');
    el.id = 'pk-sheet'; el.className = 'pk-sheet-bg';
    el.innerHTML = '<div class="pk-sheet"><div class="pk-sheet-title">¿Qué pasa con este producto?</div>' +
      '<div class="pk-sheet-sub">' + esc(l.qty) + '× ' + esc(l.label) + '</div>' +
      REASONS.map(r => '<button class="pk-reason' + (l.problem && l.reason === r[0] ? ' on' : '') + '" data-r="' + r[0] + '">' + r[1] + '</button>').join('') +
      '<input id="pk-note" class="pk-note" maxlength="150" placeholder="Nota (opcional)" value="' + escA(l.note || '') + '">' +
      (l.problem ? '<button class="pk-reason pk-clear" data-r="__clear">Quitar problema</button>' : '') +
      '<button class="pk-reason pk-cancel" data-r="__cancel">Cancelar</button></div>';
    el.addEventListener('click', ev => {
      if (ev.target === el) { closeSheet(); return; }
      const b = ev.target.closest('[data-r]'); if (!b) return;
      const r = b.getAttribute('data-r');
      if (r === '__cancel') { closeSheet(); return; }
      if (r === '__clear') { l.problem = false; l.reason = ''; l.note = ''; }
      else { l.problem = true; l.reason = r; l.note = (el.querySelector('#pk-note').value || '').trim().slice(0, 150); }
      closeSheet(); markDirty(); renderSection();
    });
    document.body.appendChild(el);
  }

  // ── Enviar lock ──────────────────────────────────────────────────────────
  PK.sendBlocked = function () {
    if (!S.flags.pickListEnabled || typeof selected === 'undefined' || !selected || !S.visible) return false;
    if (typeof isEditingShipped !== 'undefined' && isEditingShipped) return false;
    if (rowShipped()) return false;
    if (!S.loaded) return !!S.flags.pickLockRequired;
    if (!S.lines.length) return false;
    if (S.dirty || S.saving) return true;
    return summary().missing > 0;
  };

  PK.beforeSend = async function () {
    if (!S.flags.pickListEnabled || typeof selected === 'undefined' || !selected || !S.visible) return true;
    if (typeof isEditingShipped !== 'undefined' && isEditingShipped) return true;
    if (!S.loaded) {
      if (S.flags.pickLockRequired) { toast('Abre y completa la lista de productos primero', true); return false; }
      return true;
    }
    if (!S.lines.length) return true;
    const m = summary();
    if (S.dirty) { toast('Guarda los productos antes de enviar', true); return false; }
    if (m.missing > 0) { toast('Faltan ' + m.missing + ' producto(s) por marcar', true); return false; }
    if (m.problems.length) {
      if (!S.flags.problemOverrideAllowed) { toast('Hay productos con problema; no se puede enviar así', true); return false; }
      const txt = m.problems.map(l => '• ' + l.qty + '× ' + l.label + ' — ' + reasonLabel(l.reason)).join('\n');
      if (!confirm('Hay productos con problema:\n' + txt + '\n\n¿Enviar de todos modos?')) return false;
      try { await VP.post(payload('enviar_override')); }
      catch (e) { console.warn('[pick] could not log the override', e); }   // sending is not blocked by a failed log write
    }
    return true;
  };

  PK.afterSend = function () {
    if (S.scanMode !== 'continuous') return;
    setTimeout(() => {
      const pending = $('view-pending');
      if (pending && pending.style.display !== 'none' && !Scan.active) PK.startScan();
    }, 500);
  };

  // ── Order open / close ───────────────────────────────────────────────────
  function resetState() {
    S.loaded = false; S.loading = false; S.error = ''; S.lines = [];
    S.dirty = false; S.saving = false; S.sending = false;
    S.savedBy = ''; S.savedAt = ''; S.baseAt = ''; S.sessionOpen = '';
    closeSheet();
  }
  PK.onOpen = function (shipment) {
    resetState();
    const standaloneMay = (shipment.order_ids || []).length === 1 && shipment.order_ids[0].channel === 'Mayorista' && /^MAY-\d+$/.test(shipment.tracking_id || '');
    S.visible = !standaloneMay;   // a standalone wholesale order already shows its own contents list
    S.pre = null;
    if (S.visible && S.flags.pickListEnabled) { try { const q = pickQs(); S.pre = { qs: q, p: VP.get(q) }; S.pre.p.catch(() => {}); } catch (e) { S.pre = null; } }   // loads silently in the background; the button just shows it
    renderSection(); updateHint(); refreshSubmit();
  };
  PK.onClose = function () {
    resetState(); S.visible = false;
    renderSection(); updateHint();
  };

  // ── Scanner ──────────────────────────────────────────────────────────────
  const Scan = { active: false, cfg: null, stream: null, timer: 0, html5: null, last: '', lastAt: 0, torchTrack: null, torchOn: false };

  function setStatus(txt, cls) {
    const s = $('pk-scan-status'); if (s) { s.textContent = txt; s.className = 'pk-scan-status' + (cls ? ' ' + cls : ''); }
    const o = $('pk-scan');
    if (o && cls) { o.classList.remove('ok', 'bad'); o.classList.add(cls); setTimeout(() => { const o2 = $('pk-scan'); if (o2) o2.classList.remove('ok', 'bad'); }, 450); }
  }
  function loadLib() {
    if (window.Html5Qrcode) return Promise.resolve();
    return new Promise((resolve, reject) => {
      let n = 0;
      const next = () => {
        if (n >= QR_LIB_URLS.length) { reject(new Error('No se pudo cargar la librería del escáner')); return; }   // offline or blocked: use the manual input
        const sc = document.createElement('script');
        sc.src = QR_LIB_URLS[n++]; sc.onload = () => (window.Html5Qrcode ? resolve() : next()); sc.onerror = next;
        document.head.appendChild(sc);
      };
      next();
    });
  }
  async function startNative(video) {
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
    if (!Scan.active) { stream.getTracks().forEach(t => t.stop()); return; }
    Scan.stream = stream; video.srcObject = stream; await video.play();
    let formats = WANTED_FORMATS;
    try { const sup = await window.BarcodeDetector.getSupportedFormats(); formats = WANTED_FORMATS.filter(f => sup.indexOf(f) >= 0); } catch (e) {}
    if (!formats.length) throw new Error('El navegador no soporta ningún formato de código');
    const detector = new window.BarcodeDetector({ formats: formats });
    try {
      const track = stream.getVideoTracks()[0];
      const caps = track.getCapabilities ? track.getCapabilities() : null;
      if (caps && caps.torch) { Scan.torchTrack = track; const tb = $('pk-torch'); if (tb) tb.style.display = ''; }
    } catch (e) {}
    const tick = () => {
      if (!Scan.active) return;
      Scan.timer = setTimeout(async () => {
        try { if (video.readyState >= 2) { const codes = await detector.detect(video); if (codes && codes.length) handleRaw(codes[0].rawValue); } } catch (e) {}
        tick();
      }, 140);
    };
    tick();
  }
  async function startHtml5() {
    await loadLib();
    if (!Scan.active) return;
    $('pk-video').style.display = 'none';
    const reader = $('pk-reader'); reader.style.display = 'block';
    const F = window.Html5QrcodeSupportedFormats || {};
    const formats = ['CODE_128', 'QR_CODE', 'EAN_13', 'EAN_8', 'CODE_39', 'UPC_A', 'ITF', 'CODABAR', 'DATA_MATRIX'].map(k => F[k]).filter(v => v !== undefined);
    Scan.html5 = new window.Html5Qrcode('pk-reader', { formatsToSupport: formats, useBarCodeDetectorIfSupported: true, verbose: false });
    await Scan.html5.start({ facingMode: 'environment' },
      { fps: 10, qrbox: (w, h) => ({ width: Math.floor(w * 0.9), height: Math.floor(Math.min(h * 0.6, w * 0.5)) }) },
      txt => handleRaw(txt), () => {});
  }

  function openScanner(cfg) {
    if (Scan.active) return;
    injectStyle();
    Scan.active = true; Scan.cfg = cfg; Scan.last = ''; Scan.lastAt = 0; Scan.torchOn = false; Scan.torchTrack = null;
    const el = document.createElement('div');
    el.id = 'pk-scan'; el.className = 'pk-scan';
    el.innerHTML = '<div class="pk-scan-top"><div class="pk-scan-title">' + esc(cfg.title) + '</div><button class="pk-scan-btn" data-s="close">Cerrar</button></div>' +
      '<div class="pk-scan-view"><video id="pk-video" playsinline muted></video><div id="pk-reader"></div><div class="pk-scan-frame"></div></div>' +
      '<div class="pk-scan-status" id="pk-scan-status">Apunta la cámara al código</div>' +
      '<div class="pk-scan-bottom"><button class="pk-scan-btn" id="pk-torch" data-s="torch" style="display:none">🔦</button>' +
      '<input id="pk-manual" type="text" placeholder="' + escA(cfg.manualHint || 'Escribir código') + '" autocomplete="off" autocapitalize="characters">' +
      '<button class="pk-scan-btn" data-s="go">Ir</button></div>';
    el.addEventListener('click', ev => {
      const b = ev.target.closest('[data-s]'); if (!b) return;
      const a = b.getAttribute('data-s');
      if (a === 'close') stopScan();
      else if (a === 'go') submitManual();
      else if (a === 'torch' && Scan.torchTrack) {
        Scan.torchOn = !Scan.torchOn;
        Scan.torchTrack.applyConstraints({ advanced: [{ torch: Scan.torchOn }] }).catch(() => {});
      }
    });
    el.querySelector('#pk-manual').addEventListener('keydown', ev => { if (ev.key === 'Enter') { ev.preventDefault(); submitManual(); } });
    document.body.appendChild(el);

    (async () => {
      try {
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error('Este navegador no permite usar la cámara');
        if ('BarcodeDetector' in window) {
          try { await startNative($('pk-video')); return; }
          catch (e) { console.warn('[pick] native scanner failed, using fallback', e); stopTracks(); }
        }
        await startHtml5();
      } catch (e) {
        setStatus('No se pudo abrir la cámara: ' + (e && e.message ? e.message : e) + '. Escribe el código abajo.', 'bad');   // camera permission denied or no camera: manual input still works
      }
    })();
  }
  function submitManual() {
    const inp = $('pk-manual'); if (!inp) return;
    const v = inp.value.trim(); if (!v) return;
    inp.value = ''; Scan.last = ''; handleRaw(v);
  }
  function stopTracks() {
    clearTimeout(Scan.timer);
    if (Scan.stream) { try { Scan.stream.getTracks().forEach(t => t.stop()); } catch (e) {} Scan.stream = null; }
    if (Scan.html5) { const h = Scan.html5; Scan.html5 = null; try { h.stop().then(() => h.clear()).catch(() => {}); } catch (e) {} }
  }
  function stopScan() {
    Scan.active = false;
    stopTracks();
    const el = $('pk-scan'); if (el) el.remove();
  }
  PK.stopScan = stopScan;

  function handleRaw(raw) {
    const code = String(raw == null ? '' : raw).trim();
    if (!code || !Scan.active) return;
    const now = Date.now();
    if (code === Scan.last && now - Scan.lastAt < (Scan.cfg.minGap || 2500)) return;   // a camera reads the same label many times a second
    Scan.last = code; Scan.lastAt = now;
    vib(40);
    Scan.cfg.onCode(code);
  }

  PK.startScan = function () {
    openScanner({ title: 'Escanea la guía', manualHint: 'Escribir guía', minGap: 2500, onCode: onLabelCode });
  };
  PK.scanProduct = function () {
    if (!S.loaded) { toast('Primero abre la lista de productos', true); return; }
    openScanner({ title: 'Escanea los productos', manualHint: 'Escribir código', minGap: 1400, onCode: onProductCode });
  };

  // ── Label matching ───────────────────────────────────────────────────────
  function codeCandidates(raw) {
    const out = [];
    const add = s => { const k = normKey(s); if (k.length >= 5 && out.indexOf(k) < 0) out.push(k); };
    const t = String(raw || '').trim();
    add(t);
    try { const u = new URL(t); u.searchParams.forEach(v => add(v)); u.pathname.split('/').forEach(add); add(u.hash.replace('#', '')); } catch (e) {}
    (t.match(/[A-Za-z0-9][A-Za-z0-9-]{6,}/g) || []).forEach(add);
    (t.match(/\d{9,}/g) || []).forEach(add);
    return out;
  }
  const splitIds = v => String(v == null ? '' : v).split(/[+,]/).map(normKey).filter(Boolean);

  function findMatch(cands) {
    const orders = typeof allActiveOrders !== 'undefined' ? allActiveOrders : [];
    const qcs = typeof allQcRows !== 'undefined' ? allQcRows : [];
    const tt = orders.filter(r => r['Channel'] === 'TikTok');
    for (let k = 0; k < cands.length; k++) {
      const c = cands[k];
      let hit = tt.filter(r => normKey(r['Tracking ID']) === c);
      if (!hit.length) hit = tt.filter(r => splitIds(r['Order ID']).indexOf(c) >= 0);
      if (hit.length) {
        const tid = hit[0]['Tracking ID'];
        let group = tid ? tt.filter(r => String(r['Tracking ID']) === String(tid)) : [hit[0]];
        const paid = group.filter(r => r['Status'] === 'Pagado');
        if (paid.length) group = paid;
        return { kind: 'order', orders: group };
      }
      const q = qcs.find(r => normKey(r['Tracking ID']) === c || splitIds(r['TikTok Order IDs']).indexOf(c) >= 0);
      if (q) return { kind: 'qc', row: q };
    }
    return null;
  }
  PK.matchLabel = code => findMatch(codeCandidates(code));

  function shipmentFrom(m) {
    if (m.kind === 'order') {
      const first = m.orders[0];
      return {
        tracking_id: first['Tracking ID'] || '',
        order_ids: m.orders.map(o => ({ id: o['Order ID'], channel: 'TikTok' })).filter(o => o.id),
        customer_id: first['Customer ID'] || '',
        username: first['Username'] || first['Primary Username'] || '—',
      };
    }
    const r = m.row;
    return {
      tracking_id: r['Tracking ID'] || '',
      order_ids: String(r['TikTok Order IDs'] || '').split(' + ').map(s => s.trim()).filter(Boolean).map(id => ({ id: id, channel: 'TikTok' })),
      customer_id: r['Customer ID'] || '',
      username: r['Primary Username'] || '—',
    };
  }
  function openMatch(m) {
    try { openCapture(shipmentFrom(m)); } catch (e) { toast('No se pudo abrir la orden: ' + (e.message || e), true); }
  }
  function onLabelCode(code) {
    const m = PK.matchLabel(code);
    if (m) { stopScan(); openMatch(m); return; }
    setStatus('✕ Guía no encontrada: ' + code, 'bad');
    vib([80, 60, 80]);
    toast('Guía no encontrada: ' + code, true);
  }

  // ── Product barcode resolution (dormant until the Barcode column is filled) ─
  // A code also matches the line's Catalog ID, so labels printed by the label tool
  // (Code 128 of the Catalog ID) work without registering official barcodes.
  PK.resolveBarcode = function (code) {
    const c = normKey(code); if (!c) return { status: 'unknown' };
    let pool = S.lines.filter(l => l.barcode && normKey(l.barcode) === c);
    if (!pool.length) pool = S.lines.filter(l => l.catalog_id && normKey(l.catalog_id) === c);
    if (!pool.length) return { status: 'unknown' };
    const open = pool.find(l => l.packed < l.qty);
    return open ? { status: 'ok', line: open } : { status: 'full', line: pool[0] };
  };
  function onProductCode(code) {
    const r = PK.resolveBarcode(code);
    if (r.status === 'ok') {
      const l = r.line;
      l.packed++; l.method = 'scan'; l.code = code;
      if (l.problem && l.packed >= l.qty) { l.problem = false; l.reason = ''; l.note = ''; }
      markDirty(); renderSection();
      setStatus('✓ ' + l.label + '  ' + l.packed + '/' + l.qty, 'ok');
      vib(60);
    } else if (r.status === 'full') {
      setStatus('✕ Ya está completo: ' + r.line.label, 'bad'); vib([80, 60, 80]);
    } else {
      setStatus('✕ Este código no pertenece a esta orden', 'bad'); vib([80, 60, 80]);
    }
  }

  // ── Keyboard-wedge scanners (USB / Bluetooth handhelds type the code + Enter) ─
  function startWedge() {
    let buf = '', lastKey = 0;
    document.addEventListener('keydown', ev => {
      if (Scan.active) return;
      const t = ev.target;
      if (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
      if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
      const now = Date.now();
      if (ev.key === 'Enter') {
        const code = buf; buf = '';
        if (code.length >= 6) { ev.preventDefault(); routeWedge(code); }
        return;
      }
      if (!ev.key || ev.key.length !== 1) return;
      if (now - lastKey > 80) buf = '';   // a person types slower than a scanner: start over
      buf += ev.key; lastKey = now;
    });
  }
  function routeWedge(code) {
    const cap = $('view-capture');
    if (cap && cap.style.display !== 'none') { if (S.loaded && S.lines.some(l => l.barcode || l.catalog_id)) onProductCode(code); return; }
    const m = PK.matchLabel(code);
    if (m) openMatch(m); else toast('Guía no encontrada: ' + code, true);
  }

  // ── Dormant: batch pick aggregation (pure; the UI comes later) ───────────
  // perShipment = [{ tracking_id, lines:[{catalog_id, sku_id, label, qty, order_id, image}] }]
  PK.aggregate = function (perShipment) {
    const map = {};
    perShipment.forEach(s => (s.lines || []).forEach(l => {
      const k = l.catalog_id || l.sku_id || l.label;
      const a = map[k] = map[k] || { catalog_id: l.catalog_id, label: l.label, image: l.image, total: 0, orders: [] };
      a.total += l.qty; a.orders.push({ tracking_id: s.tracking_id, order_id: l.order_id, qty: l.qty });
    }));
    return Object.keys(map).map(k => map[k]).sort((a, b) => a.label.localeCompare(b.label, 'es'));
  };

  // ── Wrap qc.js functions ─────────────────────────────────────────────────
  function wrap(name, factory) {
    const orig = window[name];
    if (typeof orig !== 'function') { console.warn('[pick] qc.js function not found, hook skipped:', name); return; }
    window[name] = factory(orig);
  }
  function wrapAll() {
    wrap('openCapture', orig => function (shipment) {
      const r = orig.apply(this, arguments);
      try { PK.onOpen(shipment || {}); } catch (e) { console.warn('[pick] onOpen failed', e); }
      return r;
    });
    wrap('backToPending', orig => function () {
      if (S.dirty && !S.sending && !confirm('Tienes productos sin guardar. ¿Salir sin guardar?')) return Promise.resolve();
      try { PK.onClose(); } catch (e) { console.warn('[pick] onClose failed', e); }
      return orig.apply(this, arguments);
    });
    wrap('refreshSubmitState', orig => function () {
      orig.apply(this, arguments);
      try {
        if (typeof savingInProgress !== 'undefined' && savingInProgress) return;
        if (PK.sendBlocked()) { const b = $('qc-submit'); if (b) b.disabled = true; }
      } catch (e) { console.warn('[pick] lock check failed', e); }
    });
    wrap('submitQC', orig => async function () {
      if (S.sending) return;
      let gated = false;
      try {
        if (typeof selected !== 'undefined' && selected && !(typeof isEditingShipped !== 'undefined' && isEditingShipped) &&
            gallery.content.length > 0 && uploadsInFlight === 0 && !savingInProgress) {
          S.sending = true;
          if (!(await PK.beforeSend())) { S.sending = false; refreshSubmit(); return; }
          gated = true;
        }
      } catch (e) { console.warn('[pick] beforeSend failed', e); }
      try {
        const r = await orig.apply(this, arguments);
        if (gated && typeof selected !== 'undefined' && selected === null) PK.afterSend();   // backToPending ran = it was sent
        return r;
      } finally { S.sending = false; }
    });
  }

  // ── Toolbar (scan button + mode switch next to the search box) ───────────
  function injectToolbar() {
    const row = document.querySelector('.packer-row');
    if (!row || $('pk-scan-btn')) return;
    const scan = document.createElement('button');
    scan.id = 'pk-scan-btn'; scan.type = 'button'; scan.className = 'pk-tool'; scan.title = 'Escanear guía';
    scan.setAttribute('aria-label', 'Escanear guía');
    scan.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2"/><line x1="7" y1="8" x2="7" y2="16"/><line x1="11" y1="8" x2="11" y2="16"/><line x1="15" y1="8" x2="15" y2="16"/><line x1="18" y1="8" x2="18" y2="16"/></svg>';
    scan.onclick = () => PK.startScan();
    const mode = document.createElement('button');
    mode.id = 'pk-mode-btn'; mode.type = 'button'; mode.className = 'pk-tool pk-mode';
    mode.onclick = () => {
      setMode(S.scanMode === 'continuous' ? 'manual' : 'continuous', true);
      toast(S.scanMode === 'continuous' ? 'Modo continuo: la cámara se reabre después de cada envío' : 'Modo manual');
    };
    row.appendChild(scan); row.appendChild(mode);
    paintMode();
  }

  // ── Init ─────────────────────────────────────────────────────────────────
  injectStyle();
  injectToolbar();
  wrapAll();
  startWedge();
  loadSettings();
})();
