// ═══════════════════════════════════════════════════════════════════════
// Empacar toolbar — bulk urgent tools
// Loaded AFTER qc.js; reads its globals (allActiveOrders, allQcRows,
// renderPendingList, apiPost, showToast, escapeHtml).
//
// Desktop (>= 900px): slim icon rail on the left, each tool opens a modal.
// Mobile: a small "tools" button bottom-left that toggles a tool menu.
//
// Anti-flicker: every tracking ID the server confirms as urgent goes into
// window.vpLocalUrgent. qc.js's urgentOf() treats that set as urgent, so a
// background poll that still carries pre-write QC data can never paint a
// card back to normal. Urgent is never removed, so the set is always safe.
// ═══════════════════════════════════════════════════════════════════════

window.vpLocalUrgent = window.vpLocalUrgent || new Set();

(function () {
  const BOX_DEFAULT = 10;

  // ── Styles ──────────────────────────────────────────────────────────
  const css = `
  .ut-rail { position: fixed; left: 16px; top: 76px; z-index: 90; display: none; flex-direction: column; gap: 6px;
    background: var(--surface); border: 0.5px solid var(--border); border-radius: var(--radius-lg); padding: 6px; }
  .ut-rail-btn { width: 64px; padding: 8px 4px; border: none; background: transparent; border-radius: var(--radius-md);
    cursor: pointer; color: var(--text); font-family: inherit; font-size: 10px; font-weight: 600; display: flex;
    flex-direction: column; align-items: center; gap: 4px; line-height: 1.15; }
  .ut-rail-btn:hover { background: var(--surface2); }
  .ut-rail-btn svg { color: var(--red-text); }
  .ut-fab { position: fixed; bottom: 20px; left: 20px; width: 48px; height: 48px; border-radius: 50%; border: none;
    background: var(--surface); color: var(--text); border: 0.5px solid var(--border-strong); display: flex;
    align-items: center; justify-content: center; box-shadow: 0 4px 16px rgba(0,0,0,0.15); cursor: pointer; z-index: 60; }
  .ut-fab.open { background: var(--text); color: var(--surface); }
  .ut-menu { position: fixed; bottom: 78px; left: 20px; z-index: 61; display: none; flex-direction: column; gap: 4px;
    background: var(--surface); border: 0.5px solid var(--border-strong); border-radius: var(--radius-lg); padding: 6px;
    box-shadow: 0 8px 24px rgba(0,0,0,0.15); }
  .ut-menu.open { display: flex; }
  .ut-menu button { text-align: left; padding: 10px 12px; border: none; background: transparent; font-family: inherit;
    font-size: 14px; font-weight: 600; color: var(--text); border-radius: var(--radius-md); cursor: pointer; }
  .ut-menu button:active { background: var(--surface2); }
  @media (min-width: 900px) { .ut-rail { display: flex; } .ut-fab, .ut-menu { display: none !important; } }

  .ut-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.4); z-index: 400; display: none;
    align-items: center; justify-content: center; padding: 16px; }
  .ut-overlay.open { display: flex; }
  .ut-modal { background: var(--surface); color: var(--text); border-radius: var(--radius-lg); width: 100%; max-width: 460px;
    max-height: calc(100vh - 32px); display: flex; flex-direction: column; overflow: hidden; }
  .ut-head { padding: 14px 16px; border-bottom: 0.5px solid var(--border); display: flex; align-items: center; gap: 8px; }
  .ut-head h3 { margin: 0; font-size: 15px; font-weight: 700; flex: 1; }
  .ut-x { border: none; background: transparent; font-size: 22px; line-height: 1; cursor: pointer; color: var(--text-muted); }
  .ut-body { padding: 12px 16px; overflow-y: auto; flex: 1; }
  .ut-foot { padding: 12px 16px; border-top: 0.5px solid var(--border); display: flex; gap: 8px; }
  .ut-btn { flex: 1; padding: 11px; border-radius: var(--radius-md); border: none; font-family: inherit; font-size: 14px;
    font-weight: 700; cursor: pointer; background: var(--surface2); color: var(--text); }
  .ut-btn.primary { background: #b42318; color: #fff; }
  .ut-btn:disabled { opacity: 0.55; cursor: default; }
  .ut-btn.busy::before { content: ''; display: inline-block; width: 12px; height: 12px; margin-right: 8px;
    border: 2px solid currentColor; border-right-color: transparent; border-radius: 50%;
    animation: ut-spin .7s linear infinite; vertical-align: -2px; }
  @keyframes ut-spin { to { transform: rotate(360deg); } }

  .ut-search { position: relative; margin-bottom: 10px; }
  .ut-search input { width: 100%; box-sizing: border-box; padding: 9px 36px 9px 12px; font-size: 14px; font-family: inherit;
    border: 0.5px solid var(--border-strong); border-radius: var(--radius-md); background: var(--bg); color: var(--text); }
  .ut-clear { position: absolute; right: 7px; top: 50%; transform: translateY(-50%); width: 22px; height: 22px;
    border-radius: 50%; border: none; background: var(--text-faint); color: var(--surface); font-size: 13px; line-height: 22px;
    padding: 0; cursor: pointer; display: none; }
  .ut-list { max-height: calc(20 * 41px); overflow-y: auto; border: 0.5px solid var(--border); border-radius: var(--radius-md); }
  .ut-row { display: flex; align-items: center; gap: 10px; padding: 0 12px; min-height: 41px; box-sizing: border-box;
    border-bottom: 0.5px solid var(--border); cursor: pointer; font-size: 14px; }
  .ut-row:last-child { border-bottom: none; }
  .ut-row input { width: 18px; height: 18px; accent-color: #b42318; flex: 0 0 auto; }
  .ut-id { font-weight: 600; font-variant-numeric: tabular-nums; word-break: break-all; }
  .ut-user { color: var(--text-muted); font-size: 12px; }
  .ut-empty { padding: 20px; text-align: center; color: var(--text-muted); font-size: 13px; }
  .ut-count { font-size: 12px; color: var(--text-muted); margin-bottom: 8px; }

  .ut-box { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
  .ut-box .n { width: 20px; font-size: 11px; color: var(--text-faint); text-align: right; flex: 0 0 auto; }
  .ut-box input { flex: 0 0 200px; width: 200px; padding: 8px 10px; font-size: 14px; font-family: inherit;
    border: 0.5px solid var(--border-strong); border-radius: var(--radius-md); background: var(--bg); color: var(--text);
    font-variant-numeric: tabular-nums; min-width: 0; }
  .ut-box input.bad { border-color: var(--red-text); color: var(--red-text); }
  .ut-box input.warn { border-color: var(--amber-text); color: var(--amber-text); }
  .ut-st { font-size: 12px; color: var(--text-muted); min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .ut-st.bad { color: var(--red-text); font-weight: 600; }
  .ut-st.warn { color: var(--amber-text); font-weight: 600; }
  @media (max-width: 420px) { .ut-box input { flex: 1 1 auto; width: auto; } .ut-st { max-width: 40%; } }
  .ut-add { display: flex; align-items: center; gap: 8px; margin: 10px 0 14px; }
  .ut-step { display: flex; align-items: center; border: 0.5px solid var(--border-strong); border-radius: var(--radius-md); overflow: hidden; }
  .ut-step button { width: 30px; height: 34px; border: none; background: var(--surface2); color: var(--text); font-size: 16px; cursor: pointer; }
  .ut-step span { width: 32px; text-align: center; font-size: 13px; font-weight: 700; }
  .ut-bulk-label { font-size: 12px; font-weight: 700; color: var(--text-muted); margin-bottom: 6px; }
  .ut-bulk { width: 100%; box-sizing: border-box; min-height: 90px; padding: 8px 10px; font-size: 13px; font-family: inherit;
    border: 0.5px solid var(--border-strong); border-radius: var(--radius-md); background: var(--bg); color: var(--text); resize: vertical; }
  .ut-warnlist { margin: 8px 0 0; padding: 0; list-style: none; font-size: 13px; }
  .ut-warnlist li { padding: 6px 0; border-bottom: 0.5px solid var(--border); display: flex; justify-content: space-between; gap: 8px; }
  `;
  const st = document.createElement('style');
  st.textContent = css;
  document.head.appendChild(st);

  const esc = s => (typeof escapeHtml === 'function' ? escapeHtml(s) : String(s == null ? '' : s));
  const flame = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2s5 4.5 5 10a5 5 0 0 1-10 0c0-2 1-3.5 1-3.5S9 11 11 11c0-4 1-9 1-9z"/></svg>';
  const listIcon = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 11 12 14 22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>';
  const typeIcon = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>';

  // ── Shell: rail, fab, menu, modal overlay ───────────────────────────
  const shell = document.createElement('div');
  shell.innerHTML = `
    <div class="ut-rail">
      <button class="ut-rail-btn" data-tool="list">${listIcon}<span>Urgentes<br>lista</span></button>
      <button class="ut-rail-btn" data-tool="bulk">${typeIcon}<span>Urgentes<br>por ID</span></button>
    </div>
    <button class="ut-fab" aria-label="Herramientas">${flame}</button>
    <div class="ut-menu">
      <button data-tool="list">Marcar urgentes (lista)</button>
      <button data-tool="bulk">Marcar urgentes por ID</button>
    </div>
    <div class="ut-overlay"><div class="ut-modal"></div></div>`;
  document.body.appendChild(shell);

  const fab = shell.querySelector('.ut-fab');
  const menu = shell.querySelector('.ut-menu');
  const overlay = shell.querySelector('.ut-overlay');
  const modal = shell.querySelector('.ut-modal');
  let saving = false;

  fab.addEventListener('click', () => { menu.classList.toggle('open'); fab.classList.toggle('open'); });
  shell.querySelectorAll('[data-tool]').forEach(b => b.addEventListener('click', () => {
    menu.classList.remove('open'); fab.classList.remove('open');
    if (b.dataset.tool === 'list') openListTool(); else openBulkTool();
  }));
  overlay.addEventListener('click', e => { if (e.target === overlay && !saving) closeModal(); });
  function openModal(html) { modal.innerHTML = html; overlay.classList.add('open'); }
  function closeModal() { overlay.classList.remove('open'); modal.innerHTML = ''; }

  // ── Data helpers (all in memory, no server calls) ───────────────────
  const cleanId = s => String(s == null ? '' : s).replace(/["'\s\u00a0\u200b]/g, '');
  const isUrgent = tid => window.vpLocalUrgent.has(tid) ||
    !!(allQcRows || []).find(r => r['Tracking ID'] === tid && r['Urgent']);

  // Outstanding TikTok shipments, grouped by Tracking ID — same rules as
  // the Pendientes list (Pagado, not finalized). Orders without a tracking
  // ID can't hold an urgent flag (it lives on the shipment), so they're
  // reported separately.
  function buildIndex() {
    const finalized = new Set((allQcRows || []).filter(r => r['Status'] === 'Enviado').map(r => r['Tracking ID']));
    const packedIds = new Set();
    (allQcRows || []).filter(r => r['Status'] === 'Enviado').forEach(r => {
      String(r['TikTok Order IDs'] || '').split('+').map(cleanId).filter(Boolean).forEach(id => packedIds.add(id));
    });
    const shipments = {}, byOrderId = {}, noTracking = new Set();
    (allActiveOrders || []).filter(r => r['Channel'] === 'TikTok' && r['Status'] === 'Pagado').forEach(r => {
      const oid = cleanId(r['Order ID']);
      const tid = String(r['Tracking ID'] || '').trim();
      if (!oid) return;
      if (!tid) { noTracking.add(oid); return; }
      if (finalized.has(tid)) { packedIds.add(oid); return; }
      if (!shipments[tid]) {
        shipments[tid] = {
          tracking_id: tid,
          username: r['Username'] || r['Primary Username'] || '',
          customer_id: r['Customer ID'] || '',
          ids: [],
          date: new Date(r['Created Date'] || r['Created Time'] || 0).getTime() || 0,
        };
      }
      const s = shipments[tid];
      if (s.ids.indexOf(oid) < 0) s.ids.push(oid);
      const d = new Date(r['Created Date'] || r['Created Time'] || 0).getTime() || 0;
      if (d && (!s.date || d < s.date)) s.date = d;
      byOrderId[oid] = s;
    });
    return { shipments, byOrderId, packedIds, noTracking };
  }

  // One request for everything; UI updates exactly once, after success.
  async function submitShipments(list, btn) {
    if (saving || !list.length) return false;
    saving = true;
    btn.disabled = true; btn.classList.add('busy');
    try {
      const res = await apiPost({
        action: 'bulk_set_urgent',
        shipments: list.map(s => ({
          tracking_id: s.tracking_id, username: s.username,
          customer_id: s.customer_id, tiktok_order_ids: s.ids,
        })),
      });
      if (!res || !res.ok) throw new Error((res && res.error) || 'Error desconocido');
      (res.marked || []).concat(res.already || []).forEach(t => window.vpLocalUrgent.add(t));
      closeModal();
      if (typeof renderPendingList === 'function' && typeof currentTab !== 'undefined' && currentTab === 'pending') renderPendingList();
      const n = (res.marked || []).length;
      const shipped = (res.skipped_shipped || []).length;
      showToast(`${n} envío${n !== 1 ? 's' : ''} marcado${n !== 1 ? 's' : ''} como urgente${shipped ? ` · ${shipped} ya empacado${shipped !== 1 ? 's' : ''}` : ''}`);
      return true;
    } catch (e) {
      showToast('No se pudo guardar: ' + e.message, true);
      return false;
    } finally {
      saving = false;
      btn.disabled = false; btn.classList.remove('busy');
    }
  }

  // ════════════════════════════════════════════════════════════════════
  // Tool 1 — checklist of outstanding shipments (not yet urgent)
  // ════════════════════════════════════════════════════════════════════
  function openListTool() {
    const idx = buildIndex();
    const rows = Object.values(idx.shipments)
      .filter(s => !isUrgent(s.tracking_id))
      .sort((a, b) => a.date - b.date);
    const checked = new Set();

    openModal(`
      <div class="ut-head"><h3>Marcar urgentes</h3><button class="ut-x" aria-label="Cerrar">×</button></div>
      <div class="ut-body">
        <div class="ut-search">
          <input type="text" placeholder="Buscar Order ID o usuario…" autocomplete="off">
          <button class="ut-clear" aria-label="Borrar búsqueda">×</button>
        </div>
        <div class="ut-count"></div>
        <div class="ut-list"></div>
      </div>
      <div class="ut-foot">
        <button class="ut-btn" data-act="cancel">Cancelar</button>
        <button class="ut-btn primary" data-act="ok" disabled>Marcar urgentes</button>
      </div>`);

    const input = modal.querySelector('.ut-search input');
    const clear = modal.querySelector('.ut-clear');
    const listEl = modal.querySelector('.ut-list');
    const countEl = modal.querySelector('.ut-count');
    const okBtn = modal.querySelector('[data-act="ok"]');

    function refreshFooter() {
      okBtn.disabled = checked.size === 0;
      okBtn.textContent = checked.size ? `Marcar ${checked.size} como urgente${checked.size !== 1 ? 's' : ''}` : 'Marcar urgentes';
    }
    function render() {
      const q = input.value.trim().toLowerCase();
      const qId = cleanId(q);
      clear.style.display = q ? 'block' : 'none';
      const vis = q ? rows.filter(s => s.username.toLowerCase().includes(q) || (qId && s.ids.some(id => id.includes(qId)))) : rows;
      countEl.textContent = `${vis.length} de ${rows.length} envíos pendientes`;
      if (!vis.length) {
        listEl.innerHTML = `<div class="ut-empty">${rows.length ? 'Sin resultados' : 'No hay envíos pendientes sin marcar'}</div>`;
        return;
      }
      listEl.innerHTML = vis.map(s => `
        <label class="ut-row">
          <input type="checkbox" data-tid="${esc(s.tracking_id)}" ${checked.has(s.tracking_id) ? 'checked' : ''}>
          <span><span class="ut-id">${s.ids.map(esc).join(' + ')}</span> <span class="ut-user">${esc(s.username)}</span></span>
        </label>`).join('');
    }
    listEl.addEventListener('change', e => {
      const t = e.target.dataset && e.target.dataset.tid;
      if (!t) return;
      if (e.target.checked) checked.add(t); else checked.delete(t);
      refreshFooter();
    });
    input.addEventListener('input', render);
    clear.addEventListener('click', () => { input.value = ''; render(); input.focus(); });
    modal.querySelector('.ut-x').addEventListener('click', () => { if (!saving) closeModal(); });
    modal.querySelector('[data-act="cancel"]').addEventListener('click', () => { if (!saving) closeModal(); });
    okBtn.addEventListener('click', () => {
      submitShipments(rows.filter(s => checked.has(s.tracking_id)), okBtn);
    });
    render(); refreshFooter();
  }

  // ════════════════════════════════════════════════════════════════════
  // Tool 2 — type / paste Order IDs
  // ════════════════════════════════════════════════════════════════════
  function openBulkTool() {
    let idx = buildIndex();
    const boxes = new Array(BOX_DEFAULT).fill('');
    let addN = 10;

    openModal(`
      <div class="ut-head"><h3>Urgentes por Order ID</h3><button class="ut-x" aria-label="Cerrar">×</button></div>
      <div class="ut-body">
        <div class="ut-boxes"></div>
        <div class="ut-add">
          <button class="ut-btn" data-act="add" style="flex:0 0 auto;padding:8px 12px;font-size:13px">+ Agregar casillas</button>
          <div class="ut-step"><button data-act="minus">−</button><span class="ut-n">10</span><button data-act="plus">+</button></div>
        </div>
        <div class="ut-bulk-label">Pegar varios a la vez (uno por línea)</div>
        <textarea class="ut-bulk" placeholder='"586686277967382067	"&#10;"586686077038069250	"'></textarea>
        <button class="ut-btn" data-act="spread" style="width:100%;margin-top:6px;font-size:13px">Pasar a la lista</button>
      </div>
      <div class="ut-foot">
        <button class="ut-btn" data-act="cancel">Cancelar</button>
        <button class="ut-btn primary" data-act="ok">Marcar urgentes</button>
      </div>`);

    const boxesEl = modal.querySelector('.ut-boxes');
    const okBtn = modal.querySelector('[data-act="ok"]');

    function boxRow(i) {
      const d = document.createElement('div');
      d.className = 'ut-box';
      d.innerHTML = `<span class="n">${i + 1}</span><input type="text" inputmode="numeric" autocomplete="off"><span class="ut-st"></span>`;
      const inp = d.querySelector('input');
      inp.value = boxes[i];
      inp.addEventListener('input', () => { boxes[i] = inp.value; updateStatuses(); });
      return d;
    }
    function renderBoxes() {
      boxesEl.innerHTML = '';
      boxes.forEach((_, i) => boxesEl.appendChild(boxRow(i)));
      updateStatuses();
    }

    // Per-box verdict: ok / already urgent / duplicate / packed / no tracking / not found
    function verdicts() {
      const seen = {};
      return boxes.map(raw => {
        const id = cleanId(raw);
        if (!id) return { kind: 'empty' };
        if (seen[id]) return { kind: 'dup', id };
        seen[id] = true;
        const s = idx.byOrderId[id];
        if (s) return isUrgent(s.tracking_id) ? { kind: 'already', id, s } : { kind: 'ok', id, s };
        if (idx.packedIds.has(id)) return { kind: 'packed', id };
        if (idx.noTracking.has(id)) return { kind: 'notrack', id };
        return { kind: 'notfound', id };
      });
    }
    function updateStatuses() {
      const v = verdicts();
      boxesEl.querySelectorAll('.ut-box').forEach((row, i) => {
        const inp = row.querySelector('input');
        const stEl = row.querySelector('.ut-st');
        const r = v[i];
        inp.classList.remove('bad', 'warn');
        stEl.className = 'ut-st';
        let txt = '';
        if (r.kind === 'ok') txt = `(${r.s.username || '—'})`;
        else if (r.kind === 'already') txt = `(${r.s.username || '—'}) · ya urgente`;
        else if (r.kind === 'dup') txt = 'Repetido';
        else if (r.kind === 'packed') { txt = 'Ya empacado'; inp.classList.add('warn'); stEl.classList.add('warn'); }
        else if (r.kind === 'notrack') { txt = 'Sin guía aún'; inp.classList.add('bad'); stEl.classList.add('bad'); }
        else if (r.kind === 'notfound') { txt = 'No encontrado'; inp.classList.add('bad'); stEl.classList.add('bad'); }
        stEl.textContent = txt;
      });
    }

    function appendBoxes(n) {
      const start = boxes.length;
      for (let k = 0; k < n; k++) boxes.push('');
      for (let i = start; i < boxes.length; i++) boxesEl.appendChild(boxRow(i));
      updateStatuses();
    }

    modal.querySelector('[data-act="minus"]').addEventListener('click', () => { addN = Math.max(1, addN - 1); modal.querySelector('.ut-n').textContent = addN; });
    modal.querySelector('[data-act="plus"]').addEventListener('click', () => { addN = Math.min(100, addN + 1); modal.querySelector('.ut-n').textContent = addN; });
    modal.querySelector('[data-act="add"]').addEventListener('click', () => appendBoxes(addN));

    modal.querySelector('[data-act="spread"]').addEventListener('click', () => {
      const ta = modal.querySelector('.ut-bulk');
      const ids = ta.value.split(/[\r\n,;]+/).map(cleanId).filter(Boolean);
      if (!ids.length) return;
      let k = 0;
      for (let i = 0; i < boxes.length && k < ids.length; i++) if (!cleanId(boxes[i])) boxes[i] = ids[k++];
      while (k < ids.length) boxes.push(ids[k++]);
      ta.value = '';
      renderBoxes();
    });

    modal.querySelector('.ut-x').addEventListener('click', () => { if (!saving) closeModal(); });
    modal.querySelector('[data-act="cancel"]').addEventListener('click', () => { if (!saving) closeModal(); });

    okBtn.addEventListener('click', () => {
      idx = buildIndex(); // pick up anything the 20s poll changed meanwhile
      updateStatuses();
      const v = verdicts();
      const good = v.filter(r => r.kind === 'ok');
      const problems = v.filter(r => r.kind === 'notfound' || r.kind === 'packed' || r.kind === 'notrack');

      const toSend = [];
      const tids = new Set();
      good.forEach(r => { if (!tids.has(r.s.tracking_id)) { tids.add(r.s.tracking_id); toSend.push(r.s); } });

      if (!problems.length) {
        if (!toSend.length) { showToast('No hay Order IDs nuevos para marcar', true); return; }
        submitShipments(toSend, okBtn);
        return;
      }
      showProblems(problems, toSend);
    });

    function showProblems(problems, toSend) {
      const label = { notfound: 'No encontrado', packed: 'Ya empacado', notrack: 'Sin guía aún' };
      const layer = document.createElement('div');
      layer.className = 'ut-overlay open';
      layer.style.zIndex = 410;
      layer.innerHTML = `
        <div class="ut-modal" style="max-width:400px">
          <div class="ut-head"><h3>⚠ ${problems.length} Order ID${problems.length !== 1 ? 's' : ''} no se pueden marcar</h3></div>
          <div class="ut-body">
            <ul class="ut-warnlist">${problems.map(p => `<li><span class="ut-id">${esc(p.id)}</span><span class="ut-st ${p.kind === 'packed' ? 'warn' : 'bad'}">${label[p.kind]}</span></li>`).join('')}</ul>
            <div style="font-size:13px;color:var(--text-muted);margin-top:12px">${toSend.length
              ? `¿Marcar los otros ${toSend.length} envío${toSend.length !== 1 ? 's' : ''} y omitir estos?`
              : 'No queda ningún Order ID válido para marcar.'}</div>
          </div>
          <div class="ut-foot">
            <button class="ut-btn" data-act="back">Volver a la lista</button>
            ${toSend.length ? '<button class="ut-btn primary" data-act="go">Continuar</button>' : ''}
          </div>
        </div>`;
      document.body.appendChild(layer);
      layer.querySelector('[data-act="back"]').addEventListener('click', () => layer.remove());
      const go = layer.querySelector('[data-act="go"]');
      if (go) go.addEventListener('click', async () => {
        const ok = await submitShipments(toSend, go);
        layer.remove();
        if (!ok) updateStatuses();
      });
    }

    renderBoxes();
  }
})();
