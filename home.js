/* ============================================================================
   home.js — landing page
   One question per block: how are we doing, what needs me, where do I go.
   ==========================================================================*/

VP.mountNav('inicio');

const PAID_STATES = ['Pagado', 'Enviado', 'Archivado'];
const isPaid  = r => PAID_STATES.includes(r['Status']);
const price   = r => Number(r['Price']) || 0;
const created = r => VP.asDate(r['Created Date']);

let ORDERS = [];

(async function init() {
  paintDateline();
  try {
    await VP.ensureToken();
    const [ordersData, sessionData] = await Promise.all([
      VP.get('action=orders'),
      VP.get('action=active_session').catch(() => ({ session: null })),
    ]);
    ORDERS = ordersData.records || [];
    paintStats();
    paintAlerts(sessionData.session || null);
    paintRevenueChart();
    paintHeroLine(sessionData.session || null);
  } catch (e) {
    console.error('[home] load failed', e);
    document.getElementById('hero-line').textContent =
      'No se pudieron cargar los datos. Revisa la conexión y recarga.';
    document.getElementById('alerts').innerHTML =
      '<div class="vp-alert"><span class="vp-alert-dot" style="background:var(--red-text)"></span>' +
      '<span class="vp-alert-text">Error al cargar. <a href="#" onclick="location.reload();return false">Reintentar</a></span></div>';
    document.getElementById('home-revenue-chart').innerHTML =
      '<div class="vp-empty-sm">Sin datos</div>';
  }
})();

/* ── Hero ───────────────────────────────────────────────────────────── */

function paintDateline() {
  const now = new Date();
  const h = now.getHours();
  const greet = h < 12 ? 'Buenos días' : h < 19 ? 'Buenas tardes' : 'Buenas noches';
  document.getElementById('hero-greet').innerHTML = `${greet}<strong>.</strong>`;
  document.getElementById('hero-date').textContent =
    now.toLocaleDateString('es-MX', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
}

function paintHeroLine(session) {
  const readyToPack = ORDERS.filter(r => r['Status'] === 'Pagado').length;
  const unpaid      = ORDERS.filter(r => r['Status'] === 'No Pagado').length;

  const bits = [];
  if (session) {
    const packed = 0; // live count lives on the packing page; keep this line calm
    bits.push(`Hay una <b>sesión de empaque abierta</b>`);
  }
  if (readyToPack) bits.push(`<b>${readyToPack}</b> pedido${readyToPack !== 1 ? 's' : ''} listo${readyToPack !== 1 ? 's' : ''} para empacar`);
  if (unpaid)      bits.push(`<b>${unpaid}</b> sin pagar`);

  document.getElementById('hero-line').innerHTML = bits.length
    ? bits.join(' · ') + '.'
    : 'Nada pendiente ahora mismo. Todo el trabajo del día está cerrado.';
}

/* ── Stat cards ─────────────────────────────────────────────────────── */

function sumIn(records, from, to, filterFn) {
  return records.reduce((s, r) => {
    const d = created(r);
    if (!d || d <= from || d > to) return s;
    if (filterFn && !filterFn(r)) return s;
    return s + price(r);
  }, 0);
}

function statCard({ label, value, prev, sub, spark, tone }) {
  const delta = VP.pctChange(value, prev);
  let deltaHtml;
  if (delta === null) {
    deltaHtml = `<span class="vp-stat-delta flat">sin base previa</span>`;
  } else if (Math.abs(delta) < 0.5) {
    deltaHtml = `<span class="vp-stat-delta flat">sin cambio</span>`;
  } else {
    const up = delta > 0;
    deltaHtml = `<span class="vp-stat-delta ${up ? 'up' : 'down'}">${up ? '↑' : '↓'} ${Math.abs(delta).toFixed(0)}%</span>`;
  }
  return `<div class="vp-stat">
    <div class="vp-stat-label">${VP.esc(label)}</div>
    <div class="vp-stat-value"${tone ? ` style="color:${tone}"` : ''}>${VP.esc(value === null ? '—' : VP.mxn(value))}</div>
    <div class="vp-stat-foot">
      ${sub ? `<span class="vp-stat-sub">${VP.esc(sub)}</span>` : deltaHtml}
      ${spark || ''}
    </div>
  </div>`;
}

function paintStats() {
  const w  = VP.window_(7);
  const m  = VP.window_(30);
  const q  = VP.window_(90);

  const weekNow  = sumIn(ORDERS, w.from, w.to, isPaid);
  const weekPrev = sumIn(ORDERS, w.prevFrom, w.prevTo, isPaid);
  const monNow   = sumIn(ORDERS, m.from, m.to, isPaid);
  const monPrev  = sumIn(ORDERS, m.prevFrom, m.prevTo, isPaid);
  const quNow    = sumIn(ORDERS, q.from, q.to, isPaid);
  const quPrev   = sumIn(ORDERS, q.prevFrom, q.prevTo, isPaid);

  const unpaidRecords = ORDERS.filter(r => r['Status'] === 'No Pagado');
  const unpaidTotal   = unpaidRecords.reduce((s, r) => s + price(r), 0);

  // Sparkline series
  const weeks8  = VP.bucketBy(ORDERS.filter(isPaid), 'Created Date', 8, 7,  rs => rs.reduce((s, r) => s + price(r), 0));
  const months6 = VP.bucketBy(ORDERS.filter(isPaid), 'Created Date', 6, 30, rs => rs.reduce((s, r) => s + price(r), 0));
  const quart4  = VP.bucketBy(ORDERS.filter(isPaid), 'Created Date', 4, 90, rs => rs.reduce((s, r) => s + price(r), 0));

  document.getElementById('hero-stats').innerHTML = [
    statCard({ label: 'Semana',     value: weekNow, prev: weekPrev, spark: VP.chart.sparkline(weeks8.map(b => b.value)) }),
    statCard({ label: 'Mes',        value: monNow,  prev: monPrev,  spark: VP.chart.sparkline(months6.map(b => b.value)) }),
    statCard({ label: 'Trimestre',  value: quNow,   prev: quPrev,   spark: VP.chart.sparkline(quart4.map(b => b.value)) }),
    statCard({
      label: 'Por cobrar',
      value: unpaidTotal,
      prev: null,
      sub: `${unpaidRecords.length} pedido${unpaidRecords.length !== 1 ? 's' : ''} sin pagar`,
      tone: unpaidTotal > 0 ? 'var(--red-text)' : undefined,
    }),
  ].join('');
}

/* ── Attention list ─────────────────────────────────────────────────── */

function paintAlerts(session) {
  const now = new Date();
  const alerts = [];

  if (session) {
    alerts.push({
      href: 'qc.html',
      dot: '#a32d2d',
      html: `Sesión de empaque <b>${VP.esc(session['Session ID'] || '')}</b> abierta`,
      count: '',
    });
  }

  const staleUnpaid = ORDERS.filter(r => {
    if (r['Status'] !== 'No Pagado') return false;
    const d = created(r);
    return d && (now - d) / VP.DAY > 7;
  });
  if (staleUnpaid.length) {
    alerts.push({
      href: 'pedidos.html',
      dot: 'var(--red-text)',
      html: `Sin pagar por más de 7 días`,
      count: staleUnpaid.length,
    });
  }

  const readyToPack = ORDERS.filter(r => r['Status'] === 'Pagado');
  if (readyToPack.length) {
    alerts.push({
      href: 'qc.html',
      dot: 'var(--green-text)',
      html: `Pagados, listos para empacar`,
      count: readyToPack.length,
    });
  }

  const unlinked = ORDERS.filter(r =>
    !r['Customer ID'] && !['Enviado', 'Archivado'].includes(r['Status']));
  if (unlinked.length) {
    alerts.push({
      href: 'pedidos.html',
      dot: 'var(--amber-text)',
      html: `Pedidos activos sin cliente asignado`,
      count: unlinked.length,
    });
  }

  const el = document.getElementById('alerts');
  const note = document.getElementById('alerts-note');

  if (!alerts.length) {
    note.textContent = '';
    el.innerHTML = `<div class="vp-alert vp-alert--ok">
      <span class="vp-alert-dot" style="background:var(--green-border)"></span>
      <span class="vp-alert-text">Nada pendiente. Buen momento para cerrar la laptop.</span>
    </div>`;
    return;
  }

  note.textContent = `${alerts.length} punto${alerts.length !== 1 ? 's' : ''}`;
  el.innerHTML = alerts.map(a => `
    <a class="vp-alert" href="${a.href}">
      <span class="vp-alert-dot" style="background:${a.dot}"></span>
      <span class="vp-alert-text">${a.html}</span>
      ${a.count !== '' ? `<span class="vp-alert-count">${VP.esc(a.count)}</span>` : ''}
    </a>`).join('');
}

/* ── Revenue chart ──────────────────────────────────────────────────── */

function paintRevenueChart() {
  const buckets = VP.bucketBy(ORDERS.filter(isPaid), 'Created Date', 12, 7,
    rs => rs.reduce((s, r) => s + price(r), 0));

  const points = buckets.map(b => ({
    label: VP.shortDate(b.end),
    value: Math.round(b.value),
  }));

  VP.resetCharts();
  document.getElementById('home-revenue-chart').innerHTML =
    VP.chartSlot(w => VP.chart.area(points, { width: w, height: 210, fmt: v => VP.mxn(v), accent: '#3b6d11' }), 210);
  VP.paintCharts();
}
