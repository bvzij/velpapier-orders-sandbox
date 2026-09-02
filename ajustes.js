/* ============================================================================
   ajustes.js — Settings page: theme preference + duplicate-customer tool.
   ==========================================================================*/

(function initTheme() {
  const buttons = document.querySelectorAll('#aj-theme-toggle .vp-period-btn');
  function reflect() {
    const current = VP.getTheme();
    buttons.forEach(b => b.classList.toggle('is-active', b.dataset.theme === current));
  }
  buttons.forEach(b => {
    b.addEventListener('click', () => {
      VP.setTheme(b.dataset.theme);
      reflect();
    });
  });
  reflect();
})();

document.getElementById('aj-scan-duplicates').addEventListener('click', scanDuplicates);

async function scanDuplicates() {
  const btn = document.getElementById('aj-scan-duplicates');
  const content = document.getElementById('aj-duplicates-content');
  btn.disabled = true;
  btn.textContent = 'Buscando…';
  content.innerHTML = '<div class="vp-loading">Comparando clientes, puede tardar un momento…</div>';

  try {
    await VP.ensureToken();
    const data = await VP.get('action=find_duplicate_customers');
    renderDuplicates(data.pairs || []);
  } catch (e) {
    content.innerHTML = `<div class="vp-empty-sm">Error al buscar duplicados: ${VP.esc(e.message)}</div>`;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Buscar duplicados';
  }
}

function renderDuplicates(pairs) {
  const content = document.getElementById('aj-duplicates-content');

  if (!pairs.length) {
    content.innerHTML = '<div class="vp-empty-sm">No se encontraron duplicados probables.</div>';
    return;
  }

  content.innerHTML = `<div style="font-size:12px;color:var(--text-muted);margin-bottom:10px">
    ${VP.num(pairs.length)} par${pairs.length !== 1 ? 'es' : ''} probable${pairs.length !== 1 ? 's' : ''} encontrado${pairs.length !== 1 ? 's' : ''}
  </div>` + pairs.map(pairHtml).join('');

  content.querySelectorAll('.aj-dup-merge-btn').forEach(el => {
    el.addEventListener('click', () => handleMerge(el));
  });
  content.querySelectorAll('.aj-dup-dismiss-btn').forEach(el => {
    el.addEventListener('click', () => el.closest('.aj-dup-pair').remove());
  });
}

function customerDetailHtml(c) {
  const lines = [
    c['Phone Full'] || c['Phone Partial'] || '',
    [c['Street + Number'], c['City'], c['State']].filter(Boolean).join(', '),
    c['ZIP'] || '',
    c['Aliases'] ? `Alias: ${c['Aliases']}` : '',
  ].filter(Boolean);
  return lines.map(l => VP.esc(l)).join('<br>');
}

function pairHtml(pair) {
  const a = pair.customer_a, b = pair.customer_b;
  return `<div class="aj-dup-pair" data-a="${VP.esc(a['Customer ID'])}" data-b="${VP.esc(b['Customer ID'])}">
    <div class="aj-dup-header">
      <span>Coincidencia probable</span>
      <span class="aj-dup-score">${pair.score}%</span>
    </div>
    <div class="aj-dup-compare">
      <div class="aj-dup-side">
        <div class="aj-dup-username">${VP.esc(a['Primary Username'] || a['Customer ID'])}</div>
        <div class="aj-dup-detail">${customerDetailHtml(a)}</div>
      </div>
      <div class="aj-dup-side">
        <div class="aj-dup-username">${VP.esc(b['Primary Username'] || b['Customer ID'])}</div>
        <div class="aj-dup-detail">${customerDetailHtml(b)}</div>
      </div>
    </div>
    <div class="aj-dup-actions">
      <button class="refresh-btn aj-dup-dismiss-btn">No son iguales</button>
      <button class="refresh-btn aj-dup-merge-btn" data-keep="a">Usar «${VP.esc(a['Primary Username'] || a['Customer ID'])}» como principal</button>
      <button class="refresh-btn aj-dup-merge-btn" data-keep="b">Usar «${VP.esc(b['Primary Username'] || b['Customer ID'])}» como principal</button>
    </div>
  </div>`;
}

async function handleMerge(btn) {
  const pairEl = btn.closest('.aj-dup-pair');
  const idA = pairEl.dataset.a;
  const idB = pairEl.dataset.b;
  const keepId = btn.dataset.keep === 'a' ? idA : idB;
  const loseId = btn.dataset.keep === 'a' ? idB : idA;

  pairEl.querySelectorAll('button').forEach(b => { b.disabled = true; });
  btn.textContent = 'Fusionando…';

  try {
    await VP.post({ action: 'merge_customers', keep_id: keepId, merge_id: loseId });
    pairEl.style.opacity = '0.5';
    pairEl.innerHTML = `<div style="padding:12px;font-size:13px;color:var(--green-text)">✓ Fusionado correctamente</div>`;
  } catch (e) {
    pairEl.querySelectorAll('button').forEach(b => { b.disabled = false; });
    btn.textContent = 'Error, intenta de nuevo';
  }
}
