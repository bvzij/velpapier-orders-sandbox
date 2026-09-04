/* ============================================================================
   common.js — Vel Papier shared runtime
   Everything lives under window.VP so it can never collide with the
   page-specific globals in app.js / qc.js / import.js.
   ==========================================================================*/

window.VP = (function () {

  const API = 'https://script.google.com/macros/s/AKfycbyeywjfBWA0hFSy_3U3A2iYLE2TlPN22pBOELJ97N-FTAkgXkEAk6Af0aG1O3DjK8OjHw/exec';
  const TOKEN_KEY = 'vp_token';
  const THEME_KEY = 'vp_theme';

  let token = localStorage.getItem(TOKEN_KEY) || '';

  /* ── Theme ──────────────────────────────────────────────────────────── */
  // Applied immediately (synchronously, at script-load time, before the
  // page has finished rendering) so there's no flash of the wrong theme
  // between when the page first paints and when JS would otherwise run.

  function getTheme() {
    return localStorage.getItem(THEME_KEY) || 'light';
  }

  function setTheme(theme) {
    const t = theme === 'dark' ? 'dark' : 'light';
    localStorage.setItem(THEME_KEY, t);
    document.documentElement.setAttribute('data-theme', t);
  }

  // Apply immediately on load, using whatever was last saved.
  document.documentElement.setAttribute('data-theme', getTheme());

  /* ── API ────────────────────────────────────────────────────────────── */

  function get(qs) {
    return fetch(`${API}?${qs}&token=${encodeURIComponent(token)}`)
      .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); });
  }

  const CACHE_PREFIX = 'vp_cache_';

  // Stale-while-revalidate GET: if a cached response exists for this exact
  // query, resolves with it INSTANTLY (no network wait), then separately
  // kicks off a real fetch and calls onFresh(data) once it lands -- so the
  // page can silently swap in up-to-date data a moment later. This is what
  // makes switching between dashboard pages feel instant instead of
  // re-showing a blank loading state every single time.
  //
  // Usage:
  //   const cached = VP.getCached('action=orders&...', freshData => { ...re-render... });
  //   if (cached) render(cached);  // show immediately if we had something
  //   else { const fresh = await VP.get('action=orders&...'); render(fresh); }
    const CACHE_TTL_MS = 2 * 60 * 1000; // 2 minutes -- long enough that tab-
                                       // switching feels instant, short
                                       // enough that stale data can't
                                       // linger for a whole session.

    // Returns { data, pending }. `data` is the cached value (or null if none
  // / stale). `pending` is the in-flight fetch promise when a background
  // refresh was kicked off (or null when the cache was already fresh and
  // no fetch was needed). Callers on a cold load (no cache yet) MUST await
  // `pending` instead of issuing their own separate VP.get() for the same
  // qs -- a second call would race this one and never write the cache,
  // silently defeating it every time the page loads with nothing cached.
    // opts.slim   — optional fn(response) => trimmed response. What it returns
  //               is what gets cached AND what callers receive, so only use
  //               it when the caller needs a subset of the fields.
  // opts.cacheKey — optional distinct key. Required whenever slim is used and
  //               another page caches the same qs in full, so the slim copy
  //               can't overwrite the full one (home vs analytics on orders).
  function getCached(qs, onFresh, opts) {
    opts = opts || {};
    const key = CACHE_PREFIX + (opts.cacheKey || qs);
    let cached = null;
    let isFresh = false;
    try {
      const raw = sessionStorage.getItem(key);
      if (raw) {
        const parsed = JSON.parse(raw);
        cached = parsed.data;
        isFresh = (Date.now() - parsed.ts) < CACHE_TTL_MS;
      }
    } catch (e) { /* corrupt cache entry, ignore */ }

        let pending = null;
    if (!isFresh) {
      pending = get(qs).then(fresh => {
        const toStore = opts.slim ? opts.slim(fresh) : fresh;
        try {
          sessionStorage.setItem(key, JSON.stringify({ ts: Date.now(), data: toStore }));
        } catch (e) {
          // Almost always QuotaExceededError: sessionStorage caps around
          // 5MB per origin and the full orders response is far too big to
          // fit. Drop any half-written entry so a later read can't pick up
          // garbage, and warn -- silently swallowing this is what made the
          // home page look like caching "just didn't work" for a while.
          try { sessionStorage.removeItem(key); } catch (_) {}
          console.warn('[VP] cache write failed for', key, '-- payload too large?', e);
        }
        if (onFresh) onFresh(toStore);
        return toStore;
      });
      pending.catch(() => { /* background refresh failed silently -- cached view stays as-is */ });
    }

    return { data: cached, pending };
  }

  function post(data) {
    return fetch(API, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ ...data, token }),
    }).then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); });
  }

  // Verifies the API token, prompting once if it's missing or stale.
    const TOKEN_PING_TTL_MS = 5 * 60 * 1000; // 5 minutes -- once a token has
                                            // been verified, don't re-ping
                                            // Apps Script on every single
                                            // page navigation; that round
                                            // trip was adding a real 1-2s
                                            // delay before ANY data fetch
                                            // could even start.
  const TOKEN_PING_KEY = 'vp_token_verified_at';

  async function ensureToken() {
    for (;;) {
      if (token) {
        const lastVerified = Number(sessionStorage.getItem(TOKEN_PING_KEY) || 0);
        if (Date.now() - lastVerified < TOKEN_PING_TTL_MS) return;
        try {
          const r = await fetch(`${API}?action=ping&token=${encodeURIComponent(token)}`);
          if ((await r.json()).ok) {
            sessionStorage.setItem(TOKEN_PING_KEY, String(Date.now()));
            return;
          }
        } catch (e) { /* fall through to prompt */ }
      }
      const input = prompt('Token de API:');
      if (input === null) {
        document.body.innerHTML = '<p style="text-align:center;margin-top:4rem;font-family:sans-serif">Acceso denegado.</p>';
        throw new Error('unauthenticated');
      }
      token = input.trim();
      localStorage.setItem(TOKEN_KEY, token);
    }
  }
  /* ── Navigation ─────────────────────────────────────────────────────── */

  const NAV = [
    { id: 'inicio',    href: 'index.html',     label: 'Inicio' },
    { id: 'pedidos',   href: 'pedidos.html',   label: 'Pedidos' },
    { id: 'empacar',   href: 'qc.html',        label: 'Empacar' },
    { id: 'calidad',   href: 'calidad.html',   label: 'Calidad' },
    { id: 'importar',  href: 'import.html',    label: 'Importar' },
    { id: 'analisis',  href: 'analytics.html', label: 'Análisis' },
    { id: 'ajustes',   href: 'ajustes.html',   label: 'Ajustes' },
  ];

    // Injects the persistent top bar. `active` is one of the NAV ids.
  function mountNav(active) {
    const el = document.createElement('nav');
    el.className = 'vp-nav';
    el.innerHTML = `
      <a class="vp-nav-mark" href="index.html" aria-label="Vel Papier — inicio">
        <span class="vp-nav-mark-name">Vel Papier</span>
        <span class="vp-nav-mark-sub">Operaciones</span>
      </a>
      <div class="vp-nav-links">
        ${NAV.map(n => `
          <a href="${n.href}" class="vp-nav-link${n.id === active ? ' is-active' : ''}">${n.label}</a>
        `).join('')}
      </div>
      <button class="vp-nav-theme-toggle" id="vp-nav-theme-toggle" type="button" aria-label="Cambiar tema">
        <svg class="vp-theme-icon-sun" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="4"/>
          <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/>
        </svg>
        <svg class="vp-theme-icon-moon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79Z"/>
        </svg>
      </button>`;
    document.body.insertBefore(el, document.body.firstChild);

    const toggleBtn = document.getElementById('vp-nav-theme-toggle');
    const reflectToggle = () => toggleBtn.classList.toggle('is-dark', getTheme() === 'dark');
    toggleBtn.addEventListener('click', () => {
      setTheme(getTheme() === 'dark' ? 'light' : 'dark');
      reflectToggle();
    });
    reflectToggle();
  }

  /* ── Formatting ─────────────────────────────────────────────────────── */

  const mxn = n => {
    if (n === undefined || n === null || n === '' || isNaN(Number(n))) return '—';
    return '$' + Number(n).toLocaleString('es-MX', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
  };

  const mxnExact = n => {
    if (n === undefined || n === null || n === '' || isNaN(Number(n))) return '—';
    return '$' + Number(n).toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  };

  const num = n => Number(n || 0).toLocaleString('es-MX');

  const esc = s => String(s === undefined || s === null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  function asDate(v) {
    if (!v) return null;
    const d = v instanceof Date ? v : new Date(v);
    return isNaN(d.getTime()) ? null : d;
  }

  const DAY = 86400000;

  function daysBetween(a, b) {
    if (!a || !b) return null;
    return (b.getTime() - a.getTime()) / DAY;
  }

  function fmtDate(v) {
    const d = asDate(v);
    if (!d) return '—';
    return d.toLocaleDateString('es-MX', { day: '2-digit', month: 'short', year: 'numeric' });
  }

  function fmtDateTime(v) {
    const d = asDate(v);
    if (!d) return '—';
    return d.toLocaleString('es-MX', {
      day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });
  }

  // 3725 → "1h 2m" ; 95 → "1m 35s"
  function fmtDuration(totalSeconds) {
    if (totalSeconds === null || totalSeconds === undefined || isNaN(totalSeconds)) return '—';
    const s = Math.max(0, Math.round(totalSeconds));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    if (h > 0) return `${h}h ${m}m`;
    if (m > 0) return `${m}m ${s % 60}s`;
    return `${s}s`;
  }

  function initials(name) {
    const parts = String(name || '').trim().split(/[\s_.\-]+/).filter(Boolean);
    if (!parts.length) return '?';
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }

  /* ── Products parsing ───────────────────────────────────────────────
     Orders store products as "2x Libreta A5 (Cobre); 1x Set Washi".
     Splits into [{qty, name}] and totals the item count.                */

  function parseProducts(str) {
    if (!str) return [];
    return String(str)
      .split(/[;\n]+/)
      .map(s => s.trim())
      .filter(Boolean)
      .map(line => {
        const m = line.match(/^(\d+)\s*x\s*(.+)$/i);
        return m
          ? { qty: parseInt(m[1], 10) || 1, name: m[2].trim() }
          : { qty: 1, name: line };
      });
  }

  function itemCount(str) {
    return parseProducts(str).reduce((s, p) => s + p.qty, 0);
  }

  // Strips the "(Variation)" suffix so variants of one product group together.
  function baseProductName(name) {
    return String(name || '').replace(/\s*\([^)]*\)\s*$/, '').trim();
  }

  /* ── Toast ──────────────────────────────────────────────────────────── */

  function toast(msg, isError) {
    let t = document.getElementById('vp-toast');
    if (!t) {
      t = document.createElement('div');
      t.id = 'vp-toast';
      t.className = 'toast';
      document.body.appendChild(t);
    }
    t.textContent = msg;
    t.style.background = isError ? 'var(--red-text)' : '';
    t.classList.add('show');
    clearTimeout(t._timer);
    t._timer = setTimeout(() => { t.classList.remove('show'); t.style.background = ''; }, 2800);
  }

  /* ── Lightbox ───────────────────────────────────────────────────────── */

  function lightbox(url) {
    const overlay = document.createElement('div');
    overlay.className = 'vp-lightbox';
    overlay.innerHTML = `<img src="${url}" alt="">`;
    const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey); };
    const onKey = e => { if (e.key === 'Escape') close(); };
    overlay.onclick = close;
    document.addEventListener('keydown', onKey);
    document.body.appendChild(overlay);
  }

  /* ========================================================================
     Charts — hand-rolled SVG. No libraries: the whole product runs on
     three files and a Google Sheet, and that constraint has served it well.
     Every chart returns an SVG string; callers drop it into innerHTML.
     ======================================================================*/

  const SERIES = ['#3b6d11', '#185fa5', '#854f0b', '#534ab7', '#a32d2d', '#6b6860'];

  /* Charts are sized from the DOM, never stretched. A page emits slots, then
     calls paintCharts() once the HTML is in place; resize re-runs them. */
  const _slots = [];
  function resetCharts() { _slots.length = 0; }
  function chartSlot(builder, height) {
    const id = 'vpc' + _slots.length;
    _slots.push({ id, builder });
    return `<div class="vp-chart-host" id="${id}" style="min-height:${height}px"></div>`;
  }
  function paintCharts() {
    _slots.forEach(({ id, builder }) => {
      const el = document.getElementById(id);
      if (!el) return;
      const w = Math.max(260, Math.round(el.clientWidth || 700));
      el.innerHTML = builder(w);
    });
  }
  let _rzTimer;
  window.addEventListener('resize', () => {
    clearTimeout(_rzTimer);
    _rzTimer = setTimeout(paintCharts, 180);
  });

  const svgEsc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  function niceCeil(v) {
    if (v <= 0) return 1;
    const mag = Math.pow(10, Math.floor(Math.log10(v)));
    const n = v / mag;
    const step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10;
    return step * mag;
  }

  /* Area / line chart.
     points: [{label, value}]  opts: {height, fmt, accent, showDots}      */
  function areaChart(points, opts = {}) {
    const H       = opts.height || 190;
    const padL    = 46, padR = 12, padT = 14, padB = 26;
    const W       = opts.width || 720;
    const fmt     = opts.fmt || (v => num(v));
    const accent  = opts.accent || SERIES[0];
    const n       = points.length;

    if (!n) return emptyChart(H);

    const maxRaw = Math.max(...points.map(p => p.value), 0);
    const max    = niceCeil(maxRaw || 1);
    const innerW = W - padL - padR;
    const innerH = H - padT - padB;
    const x = i => padL + (n === 1 ? innerW / 2 : (i / (n - 1)) * innerW);
    const y = v => padT + innerH - (v / max) * innerH;

    const line = points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join('');
    const area = `${line}L${x(n - 1).toFixed(1)},${(padT + innerH).toFixed(1)}L${x(0).toFixed(1)},${(padT + innerH).toFixed(1)}Z`;

    const gridVals = [0, max / 2, max];
    const grid = gridVals.map(v => `
      <line x1="${padL}" x2="${W - padR}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}"
            stroke="rgba(0,0,0,.07)" stroke-width="1"/>
      <text x="${padL - 8}" y="${(y(v) + 3.5).toFixed(1)}" text-anchor="end"
            class="vp-chart-axis">${svgEsc(fmt(v))}</text>`).join('');

    // Label every nth point so they never collide
    const every = Math.max(1, Math.ceil(n / 8));
    const xlabels = points.map((p, i) =>
      (i % every === 0 || i === n - 1)
        ? `<text x="${x(i).toFixed(1)}" y="${H - 7}" text-anchor="middle" class="vp-chart-axis">${svgEsc(p.label)}</text>`
        : '').join('');

    const dots = opts.showDots === false ? '' : points.map((p, i) => `
      <circle cx="${x(i).toFixed(1)}" cy="${y(p.value).toFixed(1)}" r="3"
              fill="var(--surface)" stroke="${accent}" stroke-width="2">
        <title>${svgEsc(p.label)}: ${svgEsc(fmt(p.value))}</title>
      </circle>`).join('');

    const gid = 'g' + Math.random().toString(36).slice(2, 8);

    return `<svg class="vp-chart" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img">
      <defs><linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="${accent}" stop-opacity=".20"/>
        <stop offset="100%" stop-color="${accent}" stop-opacity="0"/>
      </linearGradient></defs>
      ${grid}
      <path d="${area}" fill="url(#${gid})"/>
      <path d="${line}" fill="none" stroke="${accent}" stroke-width="2"
            stroke-linejoin="round" stroke-linecap="round"/>
      ${dots}${xlabels}
    </svg>`;
  }

  /* Grouped vertical bars. series: [{name, color, values:[]}], labels: [] */
  function barChart(labels, series, opts = {}) {
    const H    = opts.height || 190;
    const padL = 46, padR = 12, padT = 14, padB = 26;
    const W    = opts.width || 720;
    const fmt  = opts.fmt || (v => num(v));
    const n    = labels.length;
    if (!n || !series.length) return emptyChart(H);

    const maxRaw = Math.max(...series.flatMap(s => s.values), 0);
    const max    = niceCeil(maxRaw || 1);
    const innerW = W - padL - padR;
    const innerH = H - padT - padB;
    const slot   = innerW / n;
    const gap    = slot * 0.22;
    const bw     = (slot - gap) / series.length;
    const y      = v => padT + innerH - (v / max) * innerH;

    const grid = [0, max / 2, max].map(v => `
      <line x1="${padL}" x2="${W - padR}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}"
            stroke="rgba(0,0,0,.07)"/>
      <text x="${padL - 8}" y="${(y(v) + 3.5).toFixed(1)}" text-anchor="end"
            class="vp-chart-axis">${svgEsc(fmt(v))}</text>`).join('');

    const bars = labels.map((lb, i) => series.map((s, si) => {
      const v  = s.values[i] || 0;
      const bx = padL + i * slot + gap / 2 + si * bw;
      const by = y(v);
      const bh = Math.max(0, padT + innerH - by);
      return `<rect x="${bx.toFixed(1)}" y="${by.toFixed(1)}" width="${(bw - 1.5).toFixed(1)}"
                    height="${bh.toFixed(1)}" rx="2" fill="${s.color || SERIES[si % SERIES.length]}"
                    opacity=".92"><title>${svgEsc(s.name)} · ${svgEsc(lb)}: ${svgEsc(fmt(v))}</title></rect>`;
    }).join('')).join('');

    const every = Math.max(1, Math.ceil(n / 10));
    const xlabels = labels.map((lb, i) =>
      (i % every === 0 || i === n - 1)
        ? `<text x="${(padL + i * slot + slot / 2).toFixed(1)}" y="${H - 7}"
                 text-anchor="middle" class="vp-chart-axis">${svgEsc(lb)}</text>`
        : '').join('');

    return `<svg class="vp-chart" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img">
      ${grid}${bars}${xlabels}
    </svg>`;
  }

  /* Horizontal ranked bars — for "top N" lists where the label matters most.
     rows: [{label, value, sub}]                                          */
  function rankBars(rows, opts = {}) {
    const fmt = opts.fmt || (v => num(v));
    if (!rows.length) return `<div class="vp-empty-sm">Sin datos todavía</div>`;
    const max = Math.max(...rows.map(r => r.value), 1);
    const accent = opts.accent || SERIES[0];
    return `<div class="vp-rank">` + rows.map((r, i) => `
      <div class="vp-rank-row">
        <div class="vp-rank-idx">${i + 1}</div>
        <div class="vp-rank-body">
          <div class="vp-rank-top">
            <span class="vp-rank-label" title="${esc(r.label)}">${esc(r.label)}</span>
            <span class="vp-rank-val">${esc(fmt(r.value))}</span>
          </div>
          <div class="vp-rank-track">
            <div class="vp-rank-fill" style="width:${(r.value / max * 100).toFixed(1)}%;background:${accent}"></div>
          </div>
          ${r.sub ? `<div class="vp-rank-sub">${esc(r.sub)}</div>` : ''}
        </div>
      </div>`).join('') + `</div>`;
  }

  /* Donut. slices: [{label, value, color}] */
  function donut(slices, opts = {}) {
    const size = opts.size || 168;
    const r = size / 2, thick = opts.thickness || 26, ir = r - thick;
    const total = slices.reduce((s, x) => s + x.value, 0);
    if (!total) return emptyChart(size);

    let a0 = -Math.PI / 2;
    const paths = slices.map((s, i) => {
      const frac = s.value / total;
      const a1 = a0 + frac * Math.PI * 2;
      const large = frac > 0.5 ? 1 : 0;
      const p = (ang, rad) => `${(r + rad * Math.cos(ang)).toFixed(2)},${(r + rad * Math.sin(ang)).toFixed(2)}`;
      // Full-circle single slice needs two arcs or it renders as nothing
      const d = frac >= 0.999
        ? `M${p(a0, r)}A${r},${r} 0 1 1 ${p(a0 + Math.PI, r)}A${r},${r} 0 1 1 ${p(a0, r)}
           M${p(a0, ir)}A${ir},${ir} 0 1 0 ${p(a0 + Math.PI, ir)}A${ir},${ir} 0 1 0 ${p(a0, ir)}Z`
        : `M${p(a0, r)}A${r},${r} 0 ${large} 1 ${p(a1, r)}L${p(a1, ir)}A${ir},${ir} 0 ${large} 0 ${p(a0, ir)}Z`;
      a0 = a1;
      return `<path d="${d}" fill="${s.color || SERIES[i % SERIES.length]}" opacity=".92">
                <title>${svgEsc(s.label)}: ${((frac) * 100).toFixed(1)}%</title></path>`;
    }).join('');

    return `<svg class="vp-donut" viewBox="0 0 ${size} ${size}" role="img">
      ${paths}
      ${opts.centerTop ? `<text x="${r}" y="${r - 2}" text-anchor="middle" class="vp-donut-top">${svgEsc(opts.centerTop)}</text>` : ''}
      ${opts.centerSub ? `<text x="${r}" y="${r + 14}" text-anchor="middle" class="vp-donut-sub">${svgEsc(opts.centerSub)}</text>` : ''}
    </svg>`;
  }

  /* Tiny inline trend line for stat cards. */
  function sparkline(values, opts = {}) {
    const W = 96, H = 26, pad = 2;
    if (!values || values.length < 2) return '';
    const max = Math.max(...values), min = Math.min(...values);
    const span = (max - min) || 1;
    const x = i => pad + (i / (values.length - 1)) * (W - pad * 2);
    const y = v => H - pad - ((v - min) / span) * (H - pad * 2);
    const d = values.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('');
    const up = values[values.length - 1] >= values[0];
    const color = opts.color || (up ? '#3b6d11' : '#a32d2d');
    return `<svg class="vp-spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
      <path d="${d}" fill="none" stroke="${color}" stroke-width="1.6"
            stroke-linecap="round" stroke-linejoin="round" opacity=".75"/>
    </svg>`;
  }

  /* Horizontal distribution bars — one row per bucket, width relative to the
     largest bucket. These are current-state counts, not a funnel: an order
     sitting in "Archivado" is not a subset of "Enviado" today, so showing a
     stage-to-stage drop-off would be a lie. Pass showShare:true to add each
     bucket's share of the total instead. */
  function funnel(stages, opts = {}) {
    if (!stages.length) return `<div class="vp-empty-sm">Sin datos</div>`;
    const top   = Math.max(...stages.map(s => s.value), 1);
    const total = stages.reduce((a, s) => a + s.value, 0);
    const fmt   = opts.fmt || (v => num(v));
    return `<div class="vp-funnel">` + stages.map((s, i) => {
      const pct = s.value / top * 100;
      const drop = opts.showShare && total
        ? ((s.value / total) * 100).toFixed(0) + '%'
        : '';
      return `<div class="vp-funnel-row">
        <div class="vp-funnel-head">
          <span class="vp-funnel-label">${esc(s.label)}</span>
          <span class="vp-funnel-val">${esc(fmt(s.value))}${drop ? `<em>${drop}</em>` : ''}</span>
        </div>
        <div class="vp-funnel-track">
          <div class="vp-funnel-fill" style="width:${Math.max(pct, 1.5).toFixed(1)}%;background:${s.color || SERIES[i % SERIES.length]}"></div>
        </div>
      </div>`;
    }).join('') + `</div>`;
  }

  function emptyChart(h) {
    return `<div class="vp-empty-sm" style="height:${h}px;display:flex;align-items:center;justify-content:center">Sin datos todavía</div>`;
  }

  /* ── Period helpers ─────────────────────────────────────────────────── */

  // Rolling window ending now. Returns {from, to, prevFrom, prevTo}.
  function window_(days) {
    const to = new Date();
    const from = new Date(to.getTime() - days * DAY);
    const prevTo = from;
    const prevFrom = new Date(from.getTime() - days * DAY);
    return { from, to, prevFrom, prevTo, days };
  }

  function pctChange(curr, prev) {
    if (!prev) return curr ? null : 0;   // null = "no baseline"
    return ((curr - prev) / prev) * 100;
  }

  // Buckets records into n periods of `days` each, oldest first.
  function bucketBy(records, dateField, buckets, daysPer, valueFn) {
    const now = new Date();
    const out = [];
    for (let i = buckets - 1; i >= 0; i--) {
      const end = new Date(now.getTime() - i * daysPer * DAY);
      const start = new Date(end.getTime() - daysPer * DAY);
      const inRange = records.filter(r => {
        const d = asDate(r[dateField]);
        return d && d > start && d <= end;
      });
      out.push({
        start, end,
        records: inRange,
        value: valueFn ? valueFn(inRange) : inRange.length,
      });
    }
    return out;
  }

  const MONTHS_ES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
  const shortDate = d => `${d.getDate()} ${MONTHS_ES[d.getMonth()]}`;

  /* ── Public surface ─────────────────────────────────────────────────── */

  return {
    API, get, getCached, post, ensureToken, mountNav, NAV, getTheme, setTheme,
    mxn, mxnExact, num, esc, asDate, daysBetween, fmtDate, fmtDateTime,
    fmtDuration, initials, parseProducts, itemCount, baseProductName,
    toast, lightbox,
    chart: { area: areaChart, bars: barChart, rank: rankBars, donut, sparkline, funnel, SERIES },
    chartSlot, paintCharts, resetCharts,
    window_, pctChange, bucketBy, shortDate, MONTHS_ES, DAY,
    get token() { return token; },
  };
})();
