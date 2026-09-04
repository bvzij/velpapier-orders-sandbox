/* ============================================================================
   analytics.js — the whole picture, computed client-side from four sheets.
   All is attributed by Created Date unless a block says otherwise,
   so "September revenue" means orders placed in September.
   ==========================================================================*/

VP.mountNav('analisis');

const PAID = ['Pagado', 'Enviado', 'Archivado'];
const SHIPPED = ['Enviado', 'Archivado'];

const isPaid    = r => PAID.includes(r['Status']);
const isShipped = r => SHIPPED.includes(r['Status']);
const price     = r => Number(r['Price']) || 0;
const created   = r => VP.asDate(r['Created Date']);

const DATA = { orders: [], customers: [], qc: [], sessions: [], byId: {}, fullOrdersLoaded: false };
let periodDays = 30;

// Every order field anything on this page reads. Caching just these keeps
// the full-history entry inside sessionStorage's ~5MB quota -- storing the
// whole records overflows it, the write throws, and the entry silently
// never gets written, so every visit refetches from scratch.
// If a new block starts reading another order field, ADD IT HERE, or that
// field will read as undefined off a cache hit but fine on a cold load --
// an intermittent bug that is miserable to track down.
const ORDER_FIELDS = [
  'Status', 'Price', 'Created Date', 'Customer ID',
  'Products', 'Primary Username', 'Channel',
  'Packed Date', 'Shipped Date',
];

function slimOrders(resp) {
  return {
    records: (resp.records || []).map(r => {
      const o = {};
      for (const f of ORDER_FIELDS) o[f] = r[f];
      return o;
    }),
  };
}

function rebuildById() {
  DATA.byId = {};
  DATA.customers.forEach(x => { DATA.byId[x['Customer ID']] = x; });
}

// While the full order history hasn't landed yet, the 90-day/1-year/Todo
// buttons would show numbers computed from only the 30-day fast-path data
// -- silently wrong, not just incomplete. So they stay disabled, with a
// visible note, until ensureFullOrders() resolves.
function setUpdating(on) {
  const note = document.getElementById('an-updating-note');
  if (note) note.style.display = on ? '' : 'none';
  document.querySelectorAll('#an-period .vp-period-btn').forEach(b => {
    if (b.dataset.days === '30') return; // 30-day view is always safe to click
    b.disabled = on;
  });
}

// Full order history is only needed once the person picks a period longer
// than the 30-day fast-path default (or "all time"). Fetched once, in the
// background, then cached like everything else -- so the FIRST screen the
// person sees is always small and fast, never a stale/wrong snapshot.
function ensureFullOrders() {
  if (DATA.fullOrdersLoaded) return;
  // getCached returns fresh cached data synchronously (in .data) when a
  // fresh (<2min) entry exists -- in that case there's no real wait, so
  // skip the "updating" flicker entirely instead of always flashing it on.
    const rFull = VP.getCached('action=orders', fresh => {
    DATA.orders = fresh.records || [];
    DATA.fullOrdersLoaded = true;
    setUpdating(false);
    render();
  }, { slim: slimOrders, cacheKey: 'orders_analytics_slim' });
  if (rFull.data) {
    DATA.orders = rFull.data.records || [];
    DATA.fullOrdersLoaded = true;
    // Must re-enable the period buttons here too: they start disabled in
    // the HTML, and setUpdating(false) is the only thing that ever turns
    // them back on. On a cache hit there's no wait to announce, but the
    // buttons still need enabling -- forgetting that left them dead.
    setUpdating(false);
    render();
  } else {
    setUpdating(true);
  }
}

/* ── Boot ───────────────────────────────────────────────────────────── */

(async function init() {
  wirePeriod();
  try {
    await VP.ensureToken();

    // Fast path: only the last 30 days of orders, small payload, so the
    // first paint is quick and never shows a stale/wrong total. Full
    // history is fetched separately (see ensureFullOrders) only once the
    // person actually needs a longer period.
            const r30       = VP.getCached('action=orders&days=30', fresh => {
      if (!DATA.fullOrdersLoaded) { DATA.orders = fresh.records || []; render(); }
    });
    if (!r30.data) setUpdating(true);
    const rCustomers = VP.getCached('action=customers', fresh => { DATA.customers = fresh.records || []; rebuildById(); render(); });
    const rQc         = VP.getCached('action=qc',        fresh => { DATA.qc = fresh.records || []; render(); });
    const rSessions   = VP.getCached('action=sessions',  fresh => { DATA.sessions = fresh.records || []; render(); });

    let gotCache = false;
    if (r30.data)        { DATA.orders = r30.data.records || []; gotCache = true; }
    if (rCustomers.data) { DATA.customers = rCustomers.data.records || []; gotCache = true; }
    if (rQc.data)        { DATA.qc = rQc.data.records || []; gotCache = true; }
    if (rSessions.data)  { DATA.sessions = rSessions.data.records || []; gotCache = true; }

    if (gotCache) {
      rebuildById();
      render();
    } else {
      // No cache at all yet (first visit this session) -- await the SAME
      // in-flight fetches getCached already kicked off above (each writes
      // its own sessionStorage entry in its own .then()). We must not
      // issue separate VP.get() calls here -- that would race the cached
      // ones and never write the cache, silently defeating it on every
      // cold load.
      const [o, c, q, s] = await Promise.all([
        r30.pending,
        rCustomers.pending,
        rQc.pending.catch(() => ({ records: [] })),
        rSessions.pending.catch(() => ({ records: [] })),
      ]);
      DATA.orders    = o.records || [];
      DATA.customers = c.records || [];
      DATA.qc        = q.records || [];
      DATA.sessions  = s.records || [];
      rebuildById();
      render();
    }

        // Always prefetch full history in the background after the fast 30-day
    // view loads, regardless of which period is currently showing -- this
    // way the 90-day/1-year/Todo buttons re-enable themselves as soon as
    // possible, without waiting for the person to click one first.
    ensureFullOrders();
  } catch (e) {
    console.error('[analytics]', e);
    document.getElementById('an-content').innerHTML =
      `<div class="vp-empty-sm">No se pudieron cargar los datos.
       <a href="#" onclick="location.reload();return false">Reintentar</a></div>`;
  }
})();

function wirePeriod() {
  document.getElementById('an-period').addEventListener('click', e => {
    const btn = e.target.closest('.vp-period-btn');
    if (!btn || btn.disabled) return;
    periodDays = parseInt(btn.dataset.days, 10);
    document.querySelectorAll('.vp-period-btn').forEach(b => b.classList.toggle('is-active', b === btn));
    if (!periodDays || periodDays > 30) ensureFullOrders();
    render();
  });
}
/* ── Scope helpers ──────────────────────────────────────────────────── */

function scope() {
  if (!periodDays) {
    const dates = DATA.orders.map(created).filter(Boolean);
    const from = dates.length ? new Date(Math.min(...dates)) : new Date(0);
    return { from, to: new Date(), prevFrom: null, prevTo: null, days: 0 };
  }
  return VP.window_(periodDays);
}

function inScope(records, sc) {
  if (!sc.days) return records.slice();
  return records.filter(r => {
    const d = created(r);
    return d && d > sc.from && d <= sc.to;
  });
}

function inPrev(records, sc) {
  if (!sc.days) return [];
  return records.filter(r => {
    const d = created(r);
    return d && d > sc.prevFrom && d <= sc.prevTo;
  });
}

/* ── Render ─────────────────────────────────────────────────────────── */

// TEMPORARY: packing sessions are disabled while the team gets used to the
// general workflow first. Flip back to true to bring back the Empaque
// section here. Mirrors the same flag in qc.js.
const SESSIONS_ENABLED = false;

function render() {
  const sc   = scope();
  const now  = inScope(DATA.orders, sc);
  const prev = inPrev(DATA.orders, sc);

  document.getElementById('an-range').textContent = sc.days
    ? `${VP.fmtDate(sc.from)} — ${VP.fmtDate(sc.to)}`
    : `Historial completo · desde ${VP.fmtDate(sc.from)}`;
  document.getElementById('an-count').textContent =
    `${VP.num(now.length)} pedido${now.length !== 1 ? 's' : ''} en el periodo`;

  VP.resetCharts();
  document.getElementById('an-content').innerHTML = [
    blockHeadline(now, prev),
    blockRevenueOverTime(sc),
    blockChannelAndFunnel(now),
    blockProducts(now),
    blockCustomers(now, sc),
    blockGeography(now),
    blockFulfillment(now),
    SESSIONS_ENABLED ? blockPacking(sc) : '',
  ].join('');

  VP.paintCharts();
}

/* ── 1 · Headline ───────────────────────────────────────────────────── */

function blockHeadline(now, prev) {
  const rev      = now.filter(isPaid).reduce((s, r) => s + price(r), 0);
  const revPrev  = prev.filter(isPaid).reduce((s, r) => s + price(r), 0);
  const cnt      = now.length, cntPrev = prev.length;
  const paidNow  = now.filter(isPaid);
  const aov      = paidNow.length ? rev / paidNow.length : 0;
  const paidPrev = prev.filter(isPaid);
  const aovPrev  = paidPrev.length ? revPrev / paidPrev.length : 0;
  const items    = now.reduce((s, r) => s + VP.itemCount(r['Products']), 0);
  const itemsPrev= prev.reduce((s, r) => s + VP.itemCount(r['Products']), 0);

  const stat = (label, val, prevVal, fmt) => {
    const d = VP.pctChange(val, prevVal);
    let delta;
    if (d === null) delta = `<span class="vp-stat-delta flat">sin base previa</span>`;
    else if (Math.abs(d) < 0.5) delta = `<span class="vp-stat-delta flat">sin cambio</span>`;
    else delta = `<span class="vp-stat-delta ${d > 0 ? 'up' : 'down'}">${d > 0 ? '↑' : '↓'} ${Math.abs(d).toFixed(0)}%</span>`;
    return `<div class="vp-stat">
      <div class="vp-stat-label">${VP.esc(label)}</div>
      <div class="vp-stat-value">${fmt(val)}</div>
      <div class="vp-stat-foot">${delta}</div>
    </div>`;
  };

  return `<section class="vp-section" style="margin-top:0">
    <div class="vp-stats">
      ${stat('Ingresos',        rev,   revPrev,  VP.mxn)}
      ${stat('Pedidos',         cnt,   cntPrev,  VP.num)}
      ${stat('Ticket promedio', aov,   aovPrev,  VP.mxn)}
      ${stat('Artículos',       items, itemsPrev, VP.num)}
    </div>
  </section>`;
}

/* ── 2 · Revenue over time ──────────────────────────────────────────── */

function blockRevenueOverTime(sc) {
  // Bucket width adapts so the chart always shows a readable number of
  // points. 30-day view goes down to one bucket per calendar day -- with
  // two-line labels (weekday + date) the chart has room for it. The
  // monthly tier (1 año / Todo) uses real calendar months via
  // bucketByMonth, so each point lands on the 1st, not a rolling 30-day
  // cutoff that drifts away from real month boundaries over time.
  let buckets, per, note, useMonths = false;
  if (!sc.days || sc.days >= 365)     { buckets = 12; useMonths = true; note = 'por mes'; }
  else if (sc.days > 45)              { buckets = 13; per = 7;  note = 'por semana'; }
  else                                { buckets = 30; per = 1;  note = 'por día'; }

  const paid = DATA.orders.filter(isPaid);
  const revB = useMonths
    ? VP.bucketByMonth(paid, 'Created Date', buckets, rs => rs.reduce((s, r) => s + price(r), 0))
    : VP.bucketBy(paid, 'Created Date', buckets, per, rs => rs.reduce((s, r) => s + price(r), 0));
  const cntB = useMonths
    ? VP.bucketByMonth(DATA.orders, 'Created Date', buckets, rs => rs.length)
    : VP.bucketBy(DATA.orders, 'Created Date', buckets, per, rs => rs.length);

  // The current, still-in-progress month gets two extra things instead of
  // being plotted like a normal completed month:
  //  - its label reads "en curso" (rather than dropping in low and reading
  //    like a crash -- it's not, it's just a partial month)
  //  - a separate dashed trend line projects where the month is headed,
  //    based on the average DAILY pace of the last 3 completed months.
  //    3 months, not 12: this business has ~7 months of history, so a
  //    trailing quarter is long enough to smooth out one unusually good
  //    or bad month, short enough to track recent growth rather than
  //    dilute it against months when the business was much smaller.
  //    There isn't enough history yet for a same-month-last-year
  //    comparison to mean anything.
  let projectedTotal = null;
  let currentMonthLabel = null;
  if (useMonths) {
    const lastBucket = revB[revB.length - 1];
    const now = new Date();
    const isCurrentMonth = lastBucket && lastBucket.start.getFullYear() === now.getFullYear()
      && lastBucket.start.getMonth() === now.getMonth();
    if (isCurrentMonth) {
      currentMonthLabel = 'en curso';
      const daysElapsed = now.getDate();
      const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();

      // Growth-based projection, not a flat average: this business has
      // been growing month over month, so averaging raw revenue across
      // the last few months would drag the projection down toward the
      // slower, older months instead of reflecting the current trajectory.
      // Instead: look at the last few completed months, measure the
      // month-over-month % change between each consecutive pair, average
      // those changes, and apply that average growth rate forward from
      // the most recent completed month.
      const completedMonths = revB.slice(0, -1).slice(-4); // need 4 to get 3 deltas
      if (completedMonths.length >= 2) {
        const growthRates = [];
        for (let i = 1; i < completedMonths.length; i++) {
          const prev = completedMonths[i - 1].value;
          const curr = completedMonths[i].value;
          if (prev > 0) growthRates.push((curr - prev) / prev);
        }
        const lastCompleted = completedMonths[completedMonths.length - 1].value;
        if (growthRates.length) {
          const avgGrowth = growthRates.reduce((s, g) => s + g, 0) / growthRates.length;
          projectedTotal = Math.round(lastCompleted * (1 + avgGrowth));
        } else {
          // Only one completed month available (early days) -- nothing to
          // measure growth against yet, so fall back to a flat daily-rate
          // projection off that single month instead of showing nothing.
          const daysInLast = new Date(completedMonths[completedMonths.length - 1].start.getFullYear(),
            completedMonths[completedMonths.length - 1].start.getMonth() + 1, 0).getDate();
                    projectedTotal = Math.round((lastCompleted / daysInLast) * daysInMonth);
        }
      }
    }
  }

  // Label style depends on bucket width:
  //  - per-day (30-day view): two lines, weekday abbreviation + date
  //  - per-week (90-day view): two lines, month abbreviation + week number
  //  - per-month (1 año/Todo): single line, month abbreviation (or
  //    "en curso" for the current, still-in-progress month)
  // Monthly buckets label off the bucket START, not end -- bucketByMonth's
  // "end" is the 1st of the NEXT month, which would mislabel every point
  // one month ahead.
  const weekNumber = d => {
    const start = new Date(d.getFullYear(), 0, 1);
    const days = Math.floor((d - start) / VP.DAY);
    return Math.ceil((days + start.getDay() + 1) / 7);
  };
  const dayLabel = d => per === 1 ? `${VP.WEEKDAYS_ES[d.getDay()]}|${VP.shortDate(d)}` : VP.shortDate(d);
  const weekLabel = d => `${VP.shortDate(d)}|Sem ${weekNumber(d)}`;
  const monthLabel = d => VP.MONTHS_ES[d.getMonth()];

  const revPoints = revB.map((b, i) => ({
    label: useMonths
      ? (i === revB.length - 1 && currentMonthLabel ? `${monthLabel(b.start)}|${currentMonthLabel}` : monthLabel(b.start))
      : (per === 7 ? weekLabel(b.end) : dayLabel(b.end)),
    value: Math.round(b.value),
  }));
  const cntLabels = cntB.map((b, i) => useMonths
    ? (i === cntB.length - 1 && currentMonthLabel ? `${monthLabel(b.start)}|${currentMonthLabel}` : monthLabel(b.start))
    : (per === 7 ? weekLabel(b.end) : dayLabel(b.end)));

  return `<section class="vp-section">
    <div class="vp-section-head">
      <h2 class="vp-section-title">Ingresos en el tiempo</h2>
      <span class="vp-section-note">${VP.esc(note)}</span>
    </div>
    <div class="vp-panel" style="margin-bottom:14px">
      ${VP.chartSlot(w => VP.chart.area(revPoints, { width: w, height: 230, fmt: VP.mxn, accent: '#3b6d11', projectedTotal }), 230)}
    </div>
    <div class="vp-panel">
      <div class="vp-panel-head">
        <span class="vp-panel-title">Pedidos por periodo</span>
      </div>
      ${VP.chartSlot(w => VP.chart.bars(cntLabels, [{ name: 'Pedidos', color: '#185fa5', values: cntB.map(b => b.value) }], { width: w, height: 170 }), 170)}
    </div>
  </section>`;
}

/* ── 3 · Channel + status funnel ────────────────────────────────────── */

function blockChannelAndFunnel(now) {
  const channels = ['TikTok', 'Shopify', 'Manual'];
  const colors   = { TikTok: '#185fa5', Shopify: '#3b6d11', Manual: '#854f0b' };

  const rows = channels.map(ch => {
    const rs = now.filter(r => r['Channel'] === ch);
    return {
      label: ch,
      value: rs.filter(isPaid).reduce((s, r) => s + price(r), 0),
      count: rs.length,
      color: colors[ch],
    };
  }).filter(r => r.count > 0);

  const totalRev = rows.reduce((s, r) => s + r.value, 0);

  const legend = rows.map(r => `
    <div class="vp-legend-row">
      <span class="vp-legend-dot" style="background:${r.color}"></span>
      <span class="vp-legend-name">${VP.esc(r.label)} · ${VP.num(r.count)} pedidos</span>
      <span class="vp-legend-val">${VP.mxn(r.value)}</span>
    </div>`).join('');

  const stages = [
    { label: 'No pagado', value: now.filter(r => r['Status'] === 'No Pagado').length, color: '#854f0b' },
    { label: 'Pagado',    value: now.filter(r => r['Status'] === 'Pagado').length,    color: '#185fa5' },
    { label: 'Enviado',   value: now.filter(r => r['Status'] === 'Enviado').length,   color: '#3b6d11' },
    { label: 'Archivado', value: now.filter(r => r['Status'] === 'Archivado').length, color: '#6b6860' },
  ];

  return `<section class="vp-section">
    <div class="vp-section-head">
      <h2 class="vp-section-title">Canales y estados</h2>
    </div>
    <div class="vp-grid-2">
      <div class="vp-panel">
        <div class="vp-panel-head"><span class="vp-panel-title">Ingresos por canal</span></div>
        ${rows.length
          ? VP.chart.donut(rows, { centerTop: VP.mxn(totalRev), centerSub: 'total' }) + `<div class="vp-legend">${legend}</div>`
          : '<div class="vp-empty-sm">Sin pedidos en el periodo</div>'}
      </div>
      <div class="vp-panel">
        <div class="vp-panel-head">
          <span class="vp-panel-title">Estado de los pedidos</span>
          <span class="vp-panel-note">dónde está cada pedido hoy</span>
        </div>
        ${VP.chart.funnel(stages, { showShare: true })}
      </div>
    </div>
  </section>`;
}

/* ── 4 · Products ───────────────────────────────────────────────────── */

function blockProducts(now) {
  const byName = {};      // grouped by base product (variants merged)
  const byVariant = {};   // full string, variant included

  now.forEach(r => {
    VP.parseProducts(r['Products']).forEach(p => {
      const base = VP.baseProductName(p.name);
      byName[base]   = (byName[base]   || 0) + p.qty;
      byVariant[p.name] = (byVariant[p.name] || 0) + p.qty;
    });
  });

  const topBase = Object.entries(byName)
    .sort((a, b) => b[1] - a[1]).slice(0, 12)
    .map(([label, value]) => ({ label, value }));

  const topVariant = Object.entries(byVariant)
    .sort((a, b) => b[1] - a[1]).slice(0, 12)
    .map(([label, value]) => ({ label, value }));

  const totalItems = Object.values(byName).reduce((s, v) => s + v, 0);

  // Items-per-order distribution
  const dist = {};
  now.forEach(r => {
    const n = VP.itemCount(r['Products']);
    const bucket = n >= 10 ? '10+' : String(n);
    dist[bucket] = (dist[bucket] || 0) + 1;
  });
  const distKeys = Object.keys(dist).sort((a, b) => {
    if (a === '10+') return 1;
    if (b === '10+') return -1;
    return Number(a) - Number(b);
  });

  return `<section class="vp-section">
    <div class="vp-section-head">
      <h2 class="vp-section-title">Productos</h2>
      <span class="vp-section-note">${VP.num(totalItems)} artículos en el periodo</span>
    </div>
    <div class="vp-grid-2">
      <div class="vp-panel">
        <div class="vp-panel-head">
          <span class="vp-panel-title">Más vendidos</span>
          <span class="vp-panel-note">variantes agrupadas</span>
        </div>
        ${VP.chart.rank(topBase, { accent: '#3b6d11' })}
      </div>
      <div class="vp-panel">
        <div class="vp-panel-head">
          <span class="vp-panel-title">Por variante</span>
          <span class="vp-panel-note">modelo exacto</span>
        </div>
        ${VP.chart.rank(topVariant, { accent: '#534ab7' })}
      </div>
    </div>
    <div class="vp-panel" style="margin-top:14px">
      <div class="vp-panel-head">
        <span class="vp-panel-title">Artículos por pedido</span>
        <span class="vp-panel-note">cuántos pedidos llevan N artículos</span>
      </div>
      ${VP.chartSlot(w => VP.chart.bars(distKeys, [{ name: 'Pedidos', color: '#854f0b', values: distKeys.map(k => dist[k]) }], { width: w, height: 160 }), 160)}
    </div>
  </section>`;
}

/* ── 5 · Customers ──────────────────────────────────────────────────── */

function blockCustomers(now, sc) {
  // Spend and order count per customer, in scope
  const agg = {};
  now.forEach(r => {
    const id = r['Customer ID'] || ('__' + (r['Primary Username'] || 'sin-nombre'));
    if (!agg[id]) agg[id] = { id, name: r['Primary Username'] || '—', spend: 0, orders: 0, items: 0 };
    if (isPaid(r)) agg[id].spend += price(r);
    agg[id].orders += 1;
    agg[id].items  += VP.itemCount(r['Products']);
  });
  const list = Object.values(agg);

  const topSpend = list.slice().sort((a, b) => b.spend - a.spend).slice(0, 10);
  const topFreq  = list.slice().sort((a, b) => b.orders - a.orders).slice(0, 10);

  // New vs returning, judged on the customer's own history (not just scope)
  const firstOrderById = {};
  DATA.orders.forEach(r => {
    const id = r['Customer ID'];
    if (!id) return;
    const d = created(r);
    if (!d) return;
    if (!firstOrderById[id] || d < firstOrderById[id]) firstOrderById[id] = d;
  });

  let newCust = 0, returning = 0;
  const seen = new Set();
  now.forEach(r => {
    const id = r['Customer ID'];
    if (!id || seen.has(id)) return;
    seen.add(id);
    const first = firstOrderById[id];
    if (first && sc.days && first > sc.from) newCust++;
    else if (first) returning++;
  });

  // Lifetime repeat distribution across the whole customer base
  const ordersPerCustomer = {};
  DATA.orders.forEach(r => {
    const id = r['Customer ID'];
    if (!id) return;
    ordersPerCustomer[id] = (ordersPerCustomer[id] || 0) + 1;
  });
  const counts = Object.values(ordersPerCustomer);
  const oneTime  = counts.filter(c => c === 1).length;
  const two      = counts.filter(c => c === 2).length;
  const threeFive= counts.filter(c => c >= 3 && c <= 5).length;
  const sixPlus  = counts.filter(c => c >= 6).length;
  const repeatRate = counts.length ? ((counts.length - oneTime) / counts.length) * 100 : 0;

  const loyalty = [
    { label: '1 pedido',    value: oneTime,   color: '#9e9b94' },
    { label: '2 pedidos',   value: two,       color: '#185fa5' },
    { label: '3–5 pedidos', value: threeFive, color: '#3b6d11' },
    { label: '6 o más',     value: sixPlus,   color: '#534ab7' },
  ].filter(s => s.value > 0);

  const table = rows => `<table class="vp-table"><thead><tr>
      <th>Cliente</th><th class="num">Pedidos</th><th class="num">Artículos</th><th class="num">Total</th>
    </tr></thead><tbody>
    ${rows.map(c => `<tr>
      <td class="vp-table-name">${VP.esc(c.name)}</td>
      <td class="num">${VP.num(c.orders)}</td>
      <td class="num">${VP.num(c.items)}</td>
      <td class="num">${VP.mxn(c.spend)}</td>
    </tr>`).join('')}
  </tbody></table>`;

  return `<section class="vp-section">
    <div class="vp-section-head">
      <h2 class="vp-section-title">Clientes</h2>
      <span class="vp-section-note">${VP.num(seen.size)} clientes distintos en el periodo</span>
    </div>

    <div class="vp-grid-3" style="margin-bottom:14px">
      <div class="vp-stat">
        <div class="vp-stat-label">Clientes nuevos</div>
        <div class="vp-stat-value">${VP.num(newCust)}</div>
        <div class="vp-stat-foot"><span class="vp-stat-sub">primera compra en el periodo</span></div>
      </div>
      <div class="vp-stat">
        <div class="vp-stat-label">Clientes que volvieron</div>
        <div class="vp-stat-value">${VP.num(returning)}</div>
        <div class="vp-stat-foot"><span class="vp-stat-sub">ya habían comprado antes</span></div>
      </div>
      <div class="vp-stat">
        <div class="vp-stat-label">Tasa de recompra</div>
        <div class="vp-stat-value">${repeatRate.toFixed(0)}%</div>
        <div class="vp-stat-foot"><span class="vp-stat-sub">histórico, toda la base</span></div>
      </div>
    </div>

    <div class="vp-grid-2">
      <div class="vp-panel">
        <div class="vp-panel-head"><span class="vp-panel-title">Top clientes por valor</span></div>
        ${topSpend.length ? table(topSpend) : '<div class="vp-empty-sm">Sin datos</div>'}
      </div>
      <div class="vp-panel">
        <div class="vp-panel-head"><span class="vp-panel-title">Top clientes por frecuencia</span></div>
        ${topFreq.length ? table(topFreq) : '<div class="vp-empty-sm">Sin datos</div>'}
      </div>
    </div>

    <div class="vp-panel" style="margin-top:14px">
      <div class="vp-panel-head">
        <span class="vp-panel-title">Lealtad — pedidos por cliente</span>
        <span class="vp-panel-note">histórico completo</span>
      </div>
      ${VP.chart.funnel(loyalty, { fmt: v => VP.num(v) + ' clientes', showShare: true })}
    </div>
  </section>`;
}

/* ── 6 · Geography ──────────────────────────────────────────────────── */

function blockGeography(now) {
  const states = {}, cities = {};
  now.forEach(r => {
    const c = DATA.byId[r['Customer ID']];
    if (!c) return;
    const st = String(c['State'] || '').trim();
    const ci = String(c['City'] || '').trim();
    if (st) states[st] = (states[st] || 0) + 1;
    if (ci) cities[ci] = (cities[ci] || 0) + 1;
  });

  const topStates = Object.entries(states).sort((a, b) => b[1] - a[1]).slice(0, 12)
    .map(([label, value]) => ({ label, value }));
  const topCities = Object.entries(cities).sort((a, b) => b[1] - a[1]).slice(0, 12)
    .map(([label, value]) => ({ label, value }));

  const known = Object.values(states).reduce((s, v) => s + v, 0);
  const coverage = now.length ? (known / now.length) * 100 : 0;

  return `<section class="vp-section">
    <div class="vp-section-head">
      <h2 class="vp-section-title">A dónde enviamos</h2>
      <span class="vp-section-note">${coverage.toFixed(0)}% de los pedidos tienen dirección registrada</span>
    </div>
    <div class="vp-grid-2">
      <div class="vp-panel">
        <div class="vp-panel-head"><span class="vp-panel-title">Estados</span></div>
        ${VP.chart.rank(topStates, { accent: '#185fa5', fmt: v => VP.num(v) + ' pedidos' })}
      </div>
      <div class="vp-panel">
        <div class="vp-panel-head"><span class="vp-panel-title">Ciudades</span></div>
        ${VP.chart.rank(topCities, { accent: '#534ab7', fmt: v => VP.num(v) + ' pedidos' })}
      </div>
    </div>
  </section>`;
}

/* ── 7 · Fulfillment speed ──────────────────────────────────────────── */

function blockFulfillment(now) {
  const packLags = [], shipLags = [];
  now.forEach(r => {
    const c = created(r);
    const p = VP.asDate(r['Packed Date']);
    const s = VP.asDate(r['Shipped Date']);
    if (c && p && p >= c) packLags.push(VP.daysBetween(c, p));
    if (p && s && s >= p) shipLags.push(VP.daysBetween(p, s));
  });

  const median = arr => {
    if (!arr.length) return null;
    const a = arr.slice().sort((x, y) => x - y);
    const mid = Math.floor(a.length / 2);
    return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
  };
  const avg = arr => arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : null;

  const fmtDays = d => d === null ? '—' : (d < 1 ? `${Math.round(d * 24)} h` : `${d.toFixed(1)} d`);

  // How fast, bucketed
  const buckets = { 'Mismo día': 0, '1 día': 0, '2–3 días': 0, '4–7 días': 0, 'Más de 7': 0 };
  packLags.forEach(d => {
    if (d < 1) buckets['Mismo día']++;
    else if (d < 2) buckets['1 día']++;
    else if (d < 4) buckets['2–3 días']++;
    else if (d <= 7) buckets['4–7 días']++;
    else buckets['Más de 7']++;
  });
  const bKeys = Object.keys(buckets).filter(k => buckets[k] > 0);

  // QC photo coverage on shipped orders
  const shippedNow = now.filter(isShipped);
  const qcTrackings = new Set(DATA.qc.map(q => q['Tracking ID']).filter(Boolean));
  const withQC = shippedNow.filter(r => qcTrackings.has(r['Tracking ID'])).length;
  const qcPct = shippedNow.length ? (withQC / shippedNow.length) * 100 : 0;

  return `<section class="vp-section">
    <div class="vp-section-head">
      <h2 class="vp-section-title">Ritmo de cumplimiento</h2>
      <span class="vp-section-note">de pedido a empaque, y de empaque a envío</span>
    </div>

    <div class="vp-grid-3" style="margin-bottom:14px">
      <div class="vp-stat">
        <div class="vp-stat-label">Pedido → empacado</div>
        <div class="vp-stat-value">${fmtDays(median(packLags))}</div>
        <div class="vp-stat-foot"><span class="vp-stat-sub">mediana · promedio ${fmtDays(avg(packLags))}</span></div>
      </div>
      <div class="vp-stat">
        <div class="vp-stat-label">Empacado → enviado</div>
        <div class="vp-stat-value">${fmtDays(median(shipLags))}</div>
        <div class="vp-stat-foot"><span class="vp-stat-sub">mediana · ${VP.num(shipLags.length)} envíos</span></div>
      </div>
      <div class="vp-stat">
        <div class="vp-stat-label">Con foto de calidad</div>
        <div class="vp-stat-value">${qcPct.toFixed(0)}%</div>
        <div class="vp-stat-foot"><span class="vp-stat-sub">${VP.num(withQC)} de ${VP.num(shippedNow.length)} enviados</span></div>
      </div>
    </div>

    <div class="vp-panel">
      <div class="vp-panel-head">
        <span class="vp-panel-title">Qué tan rápido se empaca</span>
        <span class="vp-panel-note">${VP.num(packLags.length)} pedidos con fecha de empaque</span>
      </div>
      ${bKeys.length
        ? VP.chartSlot(w => VP.chart.bars(bKeys, [{ name: 'Pedidos', color: '#3b6d11', values: bKeys.map(k => buckets[k]) }], { width: w, height: 160 }), 160)
        : '<div class="vp-empty-sm">Todavía no hay pedidos empacados con fecha registrada</div>'}
    </div>
  </section>`;
}

/* ── 8 · Packing sessions & packers ─────────────────────────────────── */

function blockPacking(sc) {
  const sessions = DATA.sessions
    .filter(s => s['Status'] === 'Finalizada')
    .filter(s => {
      if (!sc.days) return true;
      const d = VP.asDate(s['Start Time']);
      return d && d > sc.from && d <= sc.to;
    })
    .sort((a, b) => String(b['Start Time']).localeCompare(String(a['Start Time'])));

  const rows = sessions.map(s => {
    const start = VP.asDate(s['Start Time']);
    const end   = VP.asDate(s['End Time']);
    const mins  = start && end ? (end - start) / 60000 : null;
    const pkgs  = Number(s['Total Packages']) || 0;
    const items = Number(s['Total Items']) || 0;
    return {
      id: s['Session ID'], start, mins, pkgs, items,
      people: s['Participants'] || '—',
      perHour: mins && mins > 0 ? (pkgs / (mins / 60)) : null,
    };
  });

  const totalPkgs  = rows.reduce((s, r) => s + r.pkgs, 0);
  const totalItems = rows.reduce((s, r) => s + r.items, 0);
  const totalMins  = rows.reduce((s, r) => s + (r.mins || 0), 0);
  const avgPerHour = totalMins > 0 ? totalPkgs / (totalMins / 60) : null;

  // Packer leaderboard from QC rows (independent of who closed the session)
  const packerCount = {};
  DATA.qc.forEach(q => {
    if (q['Status'] !== 'Enviado') return;
    const t = VP.asDate(q['Timestamp']);
    if (sc.days && (!t || t <= sc.from || t > sc.to)) return;
    const p = String(q['Packer'] || '').trim();
    if (!p) return;
    packerCount[p] = (packerCount[p] || 0) + 1;
  });
  const packers = Object.entries(packerCount).sort((a, b) => b[1] - a[1])
    .map(([label, value]) => ({ label, value }));

  const sessionRows = rows.slice(0, 15).map(r => `<tr>
    <td class="vp-table-name">${VP.esc(r.id)}</td>
    <td>${VP.esc(r.start ? VP.fmtDate(r.start) : '—')}</td>
    <td>${VP.esc(r.people)}</td>
    <td class="num">${VP.num(r.pkgs)}</td>
    <td class="num">${VP.num(r.items)}</td>
    <td class="num">${r.mins !== null ? VP.fmtDuration(r.mins * 60) : '—'}</td>
    <td class="num">${r.perHour !== null ? r.perHour.toFixed(1) : '—'}</td>
  </tr>`).join('');

  return `<section class="vp-section">
    <div class="vp-section-head">
      <h2 class="vp-section-title">Empaque</h2>
      <span class="vp-section-note">${VP.num(sessions.length)} sesión${sessions.length !== 1 ? 'es' : ''} finalizada${sessions.length !== 1 ? 's' : ''}</span>
    </div>

    <div class="vp-grid-3" style="margin-bottom:14px">
      <div class="vp-stat">
        <div class="vp-stat-label">Paquetes empacados</div>
        <div class="vp-stat-value">${VP.num(totalPkgs)}</div>
        <div class="vp-stat-foot"><span class="vp-stat-sub">${VP.num(totalItems)} artículos en total</span></div>
      </div>
      <div class="vp-stat">
        <div class="vp-stat-label">Ritmo promedio</div>
        <div class="vp-stat-value">${avgPerHour !== null ? avgPerHour.toFixed(1) : '—'}</div>
        <div class="vp-stat-foot"><span class="vp-stat-sub">paquetes por hora</span></div>
      </div>
      <div class="vp-stat">
        <div class="vp-stat-label">Tiempo empacando</div>
        <div class="vp-stat-value">${totalMins ? VP.fmtDuration(totalMins * 60) : '—'}</div>
        <div class="vp-stat-foot"><span class="vp-stat-sub">suma de todas las sesiones</span></div>
      </div>
    </div>

    <div class="vp-grid-2">
      <div class="vp-panel">
        <div class="vp-panel-head">
          <span class="vp-panel-title">Sesiones recientes</span>
          <span class="vp-panel-note">últimas 15</span>
        </div>
        ${rows.length ? `<div style="overflow-x:auto"><table class="vp-table"><thead><tr>
          <th>Sesión</th><th>Fecha</th><th>Participantes</th>
          <th class="num">Paq.</th><th class="num">Art.</th><th class="num">Duración</th><th class="num">Paq/h</th>
        </tr></thead><tbody>${sessionRows}</tbody></table></div>`
        : '<div class="vp-empty-sm">Sin sesiones finalizadas en el periodo</div>'}
      </div>
      <div class="vp-panel">
        <div class="vp-panel-head">
          <span class="vp-panel-title">Paquetes por empacador</span>
          <span class="vp-panel-note">quien registró cada envío</span>
        </div>
        ${VP.chart.rank(packers, { accent: '#854f0b', fmt: v => VP.num(v) + ' paquetes' })}
      </div>
    </div>
  </section>`;
}
