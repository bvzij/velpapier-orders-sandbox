/* ============================================================================
   calidad.js — the photographic record of everything that left the building.
   Two ways in: by shipment (what went in this box) or by session (what we
   packed that afternoon).
   ==========================================================================*/

VP.mountNav('calidad');

const CONTENT_COLS = ['Content1', 'Content2', 'Content3', 'Content4', 'Content5'];
const BOX_COLS     = ['Box1', 'Box2', 'Box3', 'Box4', 'Box5'];
const PAGE = 36;

let QC = [], SESSIONS = [], ORDERS_BY_ID = {};
let view = 'envios';
let shown = PAGE;

/* ── Boot ───────────────────────────────────────────────────────────── */

(async function init() {
  wire();
  try {
    await VP.ensureToken();
    const [q, s, o] = await Promise.all([
      VP.get('action=qc'),
      VP.get('action=sessions').catch(() => ({ records: [] })),
      VP.get('action=orders').catch(() => ({ records: [] })),
    ]);
    QC = (q.records || []).filter(r => r['Status'] === 'Enviado');
    QC.sort((a, b) => String(b['Timestamp'] || '').localeCompare(String(a['Timestamp'] || '')));
    SESSIONS = (s.records || []).sort((a, b) =>
      String(b['Start Time'] || '').localeCompare(String(a['Start Time'] || '')));
    (o.records || []).forEach(r => { ORDERS_BY_ID[r['Order ID']] = r; });

    fillFilters();
    render();
  } catch (e) {
    console.error('[calidad]', e);
    document.getElementById('cal-content').innerHTML =
      `<div class="vp-empty-sm">No se pudo cargar el historial.
       <a href="#" onclick="location.reload();return false">Reintentar</a></div>`;
  }
})();

function wire() {
  document.getElementById('cal-view').addEventListener('click', e => {
    const btn = e.target.closest('.vp-period-btn');
    if (!btn) return;
    view = btn.dataset.view;
    document.querySelectorAll('#cal-view .vp-period-btn')
      .forEach(b => b.classList.toggle('is-active', b === btn));
    document.getElementById('cal-filters').style.display = view === 'envios' ? 'flex' : 'none';
    shown = PAGE;
    render();
  });

  ['cal-search', 'cal-packer', 'cal-session'].forEach(id => {
    const el = document.getElementById(id);
    el.addEventListener(id === 'cal-search' ? 'input' : 'change', () => { shown = PAGE; render(); });
  });

  document.getElementById('cal-more').addEventListener('click', () => {
    shown += PAGE;
    render();
  });
}

function fillFilters() {
  const packers = [...new Set(QC.map(r => String(r['Packer'] || '').trim()).filter(Boolean))].sort();
  document.getElementById('cal-packer').innerHTML =
    '<option value="">Todos los empacadores</option>' +
    packers.map(p => `<option value="${VP.esc(p)}">${VP.esc(p)}</option>`).join('');

  const sids = [...new Set(QC.map(r => String(r['Session ID'] || '').trim()).filter(Boolean))]
    .sort().reverse();
  document.getElementById('cal-session').innerHTML =
    '<option value="">Todas las sesiones</option>' +
    sids.map(s => `<option value="${VP.esc(s)}">${VP.esc(s)}</option>`).join('');
}

/* ── Helpers ────────────────────────────────────────────────────────── */

const photosOf = r => [...CONTENT_COLS, ...BOX_COLS].map(c => r[c]).filter(Boolean);

function orderIdsOf(r) {
  return {
    tiktok:  String(r['TikTok Order IDs']  || '').split(' + ').filter(Boolean),
    shopify: String(r['Shopify Order IDs'] || '').split(' + ').filter(Boolean),
    manual:  String(r['Manual Order IDs']  || '').split(' + ').filter(Boolean),
  };
}

function productSummary(r) {
  const ids = orderIdsOf(r);
  const all = [...ids.tiktok, ...ids.shopify, ...ids.manual];
  const names = [];
  all.forEach(id => {
    const o = ORDERS_BY_ID[id];
    if (o && o['Products']) {
      VP.parseProducts(o['Products']).forEach(p => names.push(`${p.qty}× ${p.name}`));
    }
  });
  return names;
}

/* ── Render ─────────────────────────────────────────────────────────── */

function render() {
  document.getElementById('cal-count').textContent =
    `${VP.num(QC.length)} envío${QC.length !== 1 ? 's' : ''} con registro fotográfico`;

  if (view === 'envios') renderShipments();
  else renderSessions();
}

function renderShipments() {
  const q       = document.getElementById('cal-search').value.trim().toLowerCase();
  const packer  = document.getElementById('cal-packer').value;
  const session = document.getElementById('cal-session').value;

  let rows = QC;
  if (packer)  rows = rows.filter(r => String(r['Packer'] || '').trim() === packer);
  if (session) rows = rows.filter(r => String(r['Session ID'] || '').trim() === session);
  if (q) {
    rows = rows.filter(r =>
      String(r['Primary Username'] || '').toLowerCase().includes(q) ||
      String(r['Tracking ID'] || '').toLowerCase().includes(q));
  }

  const el = document.getElementById('cal-content');
  const more = document.getElementById('cal-more');

  if (!rows.length) {
    el.innerHTML = `<div class="vp-empty-sm">${q || packer || session
      ? 'Ningún envío coincide con ese filtro.'
      : 'Todavía no hay envíos registrados.'}</div>`;
    more.style.display = 'none';
    return;
  }

  const visible = rows.slice(0, shown);
  el.innerHTML = `<div class="vp-qc-grid">${visible.map(cardHtml).join('')}</div>`;
  more.style.display = rows.length > shown ? 'inline-flex' : 'none';
  more.textContent = `Cargar más (${VP.num(rows.length - shown)} restantes)`;
}

function cardHtml(r) {
  const photos = photosOf(r);
  const ids    = orderIdsOf(r);
  const prods  = productSummary(r);

  // The strip is a 3-column grid, so with 4+ photos we show 2 plus a counter
  // tile — otherwise the counter wraps onto its own row and the card breaks.
  const visible = photos.length > 3 ? photos.slice(0, 2) : photos.slice(0, 3);
  const cells = visible.map(u =>
    `<img src="${VP.esc(u)}" loading="lazy" alt="" onclick="VP.lightbox('${u.replace(/'/g, "\\'")}')">`).join('');
  const extra = photos.length > 3
    ? `<div class="vp-qc-photos-more" onclick="VP.lightbox('${photos[2].replace(/'/g, "\\'")}')">+${photos.length - 2}</div>`
    : '';

  const tags = [
    ids.tiktok.length  ? `<span class="vp-qc-tag tiktok">TikTok · ${ids.tiktok.length}</span>`   : '',
    ids.shopify.length ? `<span class="vp-qc-tag shopify">Shopify · ${ids.shopify.length}</span>` : '',
    ids.manual.length  ? `<span class="vp-qc-tag manual">Manual · ${ids.manual.length}</span>`   : '',
    r['Packer'] ? `<span class="vp-qc-tag">${VP.esc(r['Packer'])}</span>` : '',
  ].filter(Boolean).join('');

  return `<article class="vp-qc-card">
    <div class="vp-qc-photos">
      ${photos.length ? cells + extra : '<div class="vp-qc-nophoto">Sin fotos</div>'}
    </div>
    <div class="vp-qc-body">
      <div class="vp-qc-user">${VP.esc(r['Primary Username'] || '—')}</div>
      <div class="vp-qc-meta">
        <code>${VP.esc(r['Tracking ID'] || '—')}</code><br>
        ${VP.esc(VP.fmtDateTime(r['Timestamp']))}
        ${r['Session ID'] ? ` · ${VP.esc(r['Session ID'])}` : ''}
        ${prods.length ? `<br><span style="color:var(--text-faint)">${VP.esc(prods.slice(0, 3).join(', '))}${prods.length > 3 ? ` +${prods.length - 3}` : ''}</span>` : ''}
        ${r['Notes'] ? `<br><span style="color:var(--amber-text)">${VP.esc(r['Notes'])}</span>` : ''}
      </div>
      <div class="vp-qc-tags">${tags}</div>
    </div>
  </article>`;
}

function renderSessions() {
  const el = document.getElementById('cal-content');
  document.getElementById('cal-more').style.display = 'none';

  const finished = SESSIONS.filter(s => s['Status'] === 'Finalizada');
  const active   = SESSIONS.filter(s => s['Status'] === 'Activa');

  if (!finished.length && !active.length) {
    el.innerHTML = '<div class="vp-empty-sm">Todavía no hay sesiones registradas.</div>';
    return;
  }

  const rowsFor = sid => QC.filter(r => String(r['Session ID'] || '') === sid);

  const block = (s, isActive) => {
    const sid   = s['Session ID'];
    const rows  = rowsFor(sid);
    const start = VP.asDate(s['Start Time']);
    const end   = VP.asDate(s['End Time']);
    const mins  = start && end ? (end - start) / 60000 : null;
    const pkgs  = rows.length;
    const items = Number(s['Total Items']) || 0;

    return `<div class="vp-sess" id="sess-${VP.esc(sid)}">
      <button class="vp-sess-head" onclick="toggleSession('${VP.esc(sid)}')">
        <svg class="vp-sess-chev" width="14" height="14" viewBox="0 0 24 24" fill="none"
             stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="9 18 15 12 9 6"></polyline>
        </svg>
        <span>
          <span class="vp-sess-id">${VP.esc(sid)}${isActive ? ' · en curso' : ''}</span><br>
          <span class="vp-sess-when">${VP.esc(start ? VP.fmtDateTime(start) : '—')}${s['Participants'] ? ' · ' + VP.esc(s['Participants']) : ''}</span>
        </span>
        <span class="vp-sess-stats">
          <span class="vp-sess-stat"><span class="vp-sess-stat-v">${VP.num(pkgs)}</span><br><span class="vp-sess-stat-l">paquetes</span></span>
          <span class="vp-sess-stat"><span class="vp-sess-stat-v">${VP.num(items)}</span><br><span class="vp-sess-stat-l">artículos</span></span>
          <span class="vp-sess-stat"><span class="vp-sess-stat-v">${mins !== null ? VP.fmtDuration(mins * 60) : '—'}</span><br><span class="vp-sess-stat-l">duración</span></span>
        </span>
      </button>
      <div class="vp-sess-body" style="display:none" id="sessbody-${VP.esc(sid)}"></div>
    </div>`;
  };

  el.innerHTML =
    (active.length ? `<div class="vp-eyebrow">En curso</div>` + active.map(s => block(s, true)).join('') + '<div style="height:1.25rem"></div>' : '') +
    (finished.length ? `<div class="vp-eyebrow">Finalizadas</div>` + finished.map(s => block(s, false)).join('') : '');
}

// Lazily fills a session's photo grid the first time it's opened.
window.toggleSession = function (sid) {
  const wrap = document.getElementById('sess-' + sid);
  const body = document.getElementById('sessbody-' + sid);
  const open = body.style.display !== 'none';

  body.style.display = open ? 'none' : 'block';
  wrap.classList.toggle('is-open', !open);
  if (open || body.dataset.loaded) return;

  const rows = QC.filter(r => String(r['Session ID'] || '') === sid);
  body.innerHTML = rows.length
    ? `<div class="vp-qc-grid">${rows.map(cardHtml).join('')}</div>`
    : '<div class="vp-empty-sm">Esta sesión no tiene envíos registrados.</div>';
  body.dataset.loaded = '1';
};
