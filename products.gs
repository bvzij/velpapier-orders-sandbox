// ═══════════════════════════════════════════════════════════════════════════
// PRODUCTOS — listings editor, TikTok/Shopify export, AI copy + attributes
// ═══════════════════════════════════════════════════════════════════════════
//
// Second script file of the same Apps Script project as apps-script.gs. It
// shares every global (openSheetCached, ensureHeader, logAudit, ...). Every
// function here starts with `prod` so nothing can silently shadow a function
// in apps-script.gs (the duplicate importTikTokOrders lesson).
//
// Routing: apps-script.gs sends every action that starts with "prod_" here:
//   doGet  -> prodDispatchGet(action, e, identity)
//   doPost -> prodDispatchPost(action, body, identity)   (before the global lock,
//             so a 20-second AI call never blocks other people's saves; write
//             actions take the lock themselves below)
// All prod_ actions are admin-only.
//
// Sheets (all in the Product Catalog spreadsheet, created automatically on
// first use — nobody needs to make them by hand):
//   Listings, Listing Variants, Listing Templates, Listing Exports,
//   Listing History, Product Attributes (long format: one row per value,
//   built for analysis — join on Parent ID / Catalog ID).
// Settings live in Script Properties: PROD_SETTINGS (JSON), and the secrets
// ANTHROPIC_API_KEY (+ optional AI_MODEL). The image upload reuses
// IMAGE_SERVICE_URL / IMAGE_SERVICE_KEY from apps-script.gs.

const PROD_SHEETS = {
  listings: { name: 'Listings', text: ['Listing ID', 'Parent ID', 'Shopify Product ID', 'TikTok Product ID'], headers: [
    'Listing ID', 'Parent ID', 'Status', 'Title', 'Shopify Title', 'Description', 'Description HTML', 'Key Features',
    'Brand', 'Template ID', 'TikTok Props', 'Shopify Category', 'Shopify Type', 'Tags', 'Shopify Handle',
    'SEO Title', 'SEO Description', 'Images', 'Option 1 Name', 'Option 2 Name', 'Weight g', 'Length cm',
    'Width cm', 'Height cm', 'Attributes', 'Attributes Source', 'AI Model', 'AI Generated At', 'Notes',
    'Shopify Product ID', 'TikTok Product ID', 'Last Export TikTok', 'Last Export Shopify',
    'Created By', 'Created Date', 'Updated By', 'Updated Date'] },
  variants: { name: 'Listing Variants', text: ['Listing ID', 'Catalog ID', 'Your SKU', 'Barcode', 'Shopify Variant ID'], headers: [
    'Listing ID', 'Catalog ID', 'Position', 'Option 1', 'Option 2', 'Your SKU', 'Price MXN', 'Compare At MXN',
    'Cost MXN', 'Stock', 'Barcode', 'Image URL', 'Full Image URL', 'Weight g', 'Shopify Variant ID', 'Updated Date'] },
  templates: { name: 'Listing Templates', text: ['Template ID', 'Drive File ID', 'Category ID'], headers: [
    'Template ID', 'Platform', 'Name', 'Category Path', 'Category ID', 'Drive File ID', 'File Name',
    'Config', 'Version', 'Active', 'Uploaded By', 'Uploaded Date'] },
  exports: { name: 'Listing Exports', text: ['Export ID'], headers: [
    'Export ID', 'Date', 'User', 'Platform', 'Template ID', 'Listing IDs', 'Rows', 'File Name'] },
  history: { name: 'Listing History', text: ['Listing ID'], headers: ['Listing ID', 'Date', 'User', 'Action', 'Snapshot'] },
  attributes: { name: 'Product Attributes', text: ['Parent ID', 'Listing ID'], headers: [
    'Parent ID', 'Listing ID', 'Attribute', 'Value', 'Value Number', 'Source', 'Updated Date'] },
};

const PROD_STATUSES = ['Borrador', 'Listo', 'Exportado', 'Archivado'];
const PROD_DEFAULT_MODEL = 'claude-sonnet-5-5';
const PROD_CELL_MAX = 49000;   // Sheets cell limit is 50,000 characters

// The attribute schema the AI fills in. Keys stay English snake_case so the
// analysis side never breaks; values are Spanish, lowercase. Change this list
// freely: old rows keep their keys, new keys simply start appearing.
const PROD_ATTRIBUTE_SCHEMA = {
  product_type: 'texto — qué es, en singular (ej. "marcador", "cuaderno", "acuarela")',
  product_subtype: 'texto — más específico (ej. "marcador de alcohol", "sketchbook")',
  category_group: 'uno de: arte, escritura, papel, organización, manualidades, accesorios, escolar, oficina, otro',
  brand: 'texto', product_line: 'texto — línea o serie',
  medium: 'lista — alcohol, base agua, acrílico, óleo, acuarela, gouache, pigmento, grafito, carbón, cera, pastel seco, pastel óleo, tinta, gel, ...',
  technique_uses: 'lista — lettering, caligrafía, ilustración, bocetos, manga, cómic, journaling, scrapbooking, coloreado, pintura, diseño, tareas escolares, oficina, manualidades, ...',
  tip_types: 'lista — pincel, cincel, fino, bala, doble punta, biselado, ...', tip_size_mm: 'lista de números',
  color_count: 'número', color_families: 'lista — pastel, neón, metálico, tierra, tonos piel, grises, primarios, vintage, glitter, ...',
  specific_colors: 'lista de colores concretos', pack_quantity: 'número de piezas',
  size_format: 'texto (ej. "A5", "carta")', dimensions_cm: 'texto (ej. "21 x 14.8")', page_count: 'número',
  paper_weight_gsm: 'número', paper_type: 'texto', binding: 'texto (espiral, cosido, pegado, ...)',
  cover_material: 'texto', material: 'lista', finish: 'lista — mate, brillante, satinado, texturizado, ...',
  refillable: 'true/false', erasable: 'true/false', water_resistant: 'true/false', lightfast: 'true/false',
  non_toxic: 'true/false', acid_free: 'true/false', blendable: 'true/false',
  skill_level: 'lista — principiante, intermedio, profesional',
  audience: 'lista — niños, adolescentes, adultos, artistas, estudiantes, oficina',
  age_min: 'número', aesthetic: 'lista — kawaii, minimalista, vintage, floral, pastel, boho, clásico, infantil, ...',
  themes: 'lista', occasions: 'lista — regreso a clases, navidad, san valentín, día del niño, día de las madres, regalo, ...',
  giftable: 'true/false', includes: 'lista — qué trae la caja', country_of_origin: 'texto',
  price_positioning: 'uno de: económico, medio, premium', keywords: 'lista — palabras con las que un cliente lo buscaría',
  extra: 'objeto — cualquier otro rasgo útil que no encaje arriba, clave_snake_case: valor',
};

// ─── Routing ────────────────────────────────────────────────────────────────

function prodDispatchGet(action, e, identity) {
  if (!requireAdmin(identity.role)) return jsonResponse({ error: 'unauthorized' });
  try {
    if (action === 'prod_bootstrap') return prodBootstrapAction_();
    if (action === 'prod_template_file') return prodTemplateFileAction_(e);
    if (action === 'prod_catalog') return prodCatalogAction_(e);
    if (action === 'prod_sku_lookup') return prodSkuLookupAction_(e);
    return jsonResponse({ error: 'Acción desconocida: ' + action });   // frontend newer than backend -> deploy products.gs again
  } catch (err) {
    return jsonResponse({ error: err.message });
  }
}

function prodDispatchPost(action, body, identity) {
  if (!requireAdmin(identity.role)) return jsonResponse({ error: 'unauthorized' });
  try {
    // slow, no sheet writes -> outside the global lock
    if (action === 'prod_ai') return prodWithAudit_(() => prodAiAction_(body));
    if (action === 'prod_upload_image') return prodWithAudit_(() => prodUploadImageAction_(body));
    // writes -> one at a time, like every other save in the dashboard
    const writers = {
      prod_save: prodSaveAction_, prod_archive: prodArchiveAction_, prod_template_save: prodTemplateSaveAction_,
      prod_template_toggle: prodTemplateToggleAction_, prod_export_done: prodExportDoneAction_,
      prod_settings_save: prodSettingsSaveAction_,
    };
    if (!writers[action]) return jsonResponse({ error: 'Acción desconocida: ' + action });   // frontend newer than backend -> deploy products.gs again
    return withWriteLock(() => prodWithAudit_(() => writers[action](body)));
  } catch (err) {
    return jsonResponse({ error: err.message });
  }
}

function prodWithAudit_(fn) {
  const out = fn();
  try { queueAuditEntries(); } catch (e) { /* audit is best-effort */ }
  return out;
}

// ─── Sheet helpers ──────────────────────────────────────────────────────────

let _prodSheetCache = {};
function prodSheet_(key) {
  const def = PROD_SHEETS[key];
  if (_prodSheetCache[def.name]) return _prodSheetCache[def.name];
  const ss = openSheetCached(PRODUCT_CATALOG_SHEET_ID);
  let sh = ss.getSheetByName(def.name);
  if (!sh) {
    sh = ss.insertSheet(def.name);
    sh.getRange(1, 1, 1, def.headers.length).setValues([def.headers]).setFontWeight('bold');
    sh.setFrozenRows(1);
    def.text.forEach(name => {   // ID columns stay plain text so Sheets never reformats them
      sh.getRange(1, def.headers.indexOf(name) + 1, sh.getMaxRows(), 1).setNumberFormat('@');
    });
  } else {
    // add any column a newer version of this file expects (one read, one write)
    const have = sh.getRange(1, 1, 1, Math.max(sh.getLastColumn(), 1)).getValues()[0].map(String);
    const missing = def.headers.filter(h => have.indexOf(h) < 0);
    if (missing.length) sh.getRange(1, sh.getLastColumn() + 1, 1, missing.length).setValues([missing]).setFontWeight('bold');
  }
  _prodSheetCache[def.name] = sh;
  return sh;
}

// -> { sheet, headers, rows: [{ _row, 'Header': value, ... }] }
function prodTable_(key) {
  const sh = prodSheet_(key);
  const data = sh.getDataRange().getValues();
  const headers = (data[0] || []).map(String);
  const rows = [];
  for (let r = 1; r < data.length; r++) {
    const o = { _row: r + 1 };
    let any = false;
    headers.forEach((h, i) => { o[h] = data[r][i]; if (data[r][i] !== '' && data[r][i] != null) any = true; });
    if (any) rows.push(o);
  }
  return { sheet: sh, headers: headers, rows: rows };
}

function prodRowArray_(headers, obj) {
  return headers.map(h => (obj[h] === undefined || obj[h] === null) ? '' : obj[h]);
}

// Replaces every row whose `keyCol` is in keySet with newRows (rewrite in one go).
function prodReplaceRows_(key, keyCol, keySet, newObjs) {
  const t = prodTable_(key);
  const keep = t.rows.filter(r => !keySet[String(r[keyCol])]);
  const all = keep.map(r => prodRowArray_(t.headers, r)).concat(newObjs.map(o => prodRowArray_(t.headers, o)));
  const sh = t.sheet;
  const oldCount = Math.max(sh.getLastRow() - 1, 0);
  if (oldCount) sh.getRange(2, 1, oldCount, t.headers.length).clearContent();
  if (all.length) {
    forceTextFormat(sh, t.headers, PROD_SHEETS[key].text, 2, all.length);
    sh.getRange(2, 1, all.length, t.headers.length).setValues(all);
  }
}

function prodJson_(v, fallback) {
  if (v === '' || v == null) return fallback;
  try { return JSON.parse(String(v)); } catch (e) { return fallback; }
}
function prodClip_(s) { s = String(s == null ? '' : s); return s.length > PROD_CELL_MAX ? s.slice(0, PROD_CELL_MAX) : s; }
function prodNum_(v) { if (v === '' || v == null) return ''; const n = Number(String(v).replace(/[^\d.\-]/g, '')); return isFinite(n) ? n : ''; }
function prodStr_(v, n) { return String(v == null ? '' : v).trim().slice(0, n || 500); }

function prodSettings_() {
  const raw = PropertiesService.getScriptProperties().getProperty('PROD_SETTINGS');
  const s = prodJson_(raw, {}) || {};
  return Object.assign({
    brand_default: 'No brand', shopify_vendor: 'Vel Papier', shopify_status: 'Draft',
    tiktok_defaults: {}, ai_voice: '', default_weight_g: '', default_dims_cm: '',
  }, s);
}

function prodUserName_() { return _currentIdentity ? _currentIdentity.name : 'Desconocido'; }

// ─── Catalog helpers (Product Parents / Product Variants) ──────────────────

function prodCatalog_() {
  const ps = getProductParentsSheet(), vs = getProductVariantsSheet();
  const pd = ps.getDataRange().getValues(), vd = vs.getDataRange().getValues();
  const ph = pd[0].map(String), vh = vd[0].map(String);
  const parents = {}, variants = {}, mergedTo = {}, skuOwner = {};
  for (let r = 1; r < pd.length; r++) {
    const id = String(pd[r][ph.indexOf('Parent ID')] || '').trim();
    if (!id) continue;
    parents[id] = { row: r + 1, id: id, name: String(pd[r][ph.indexOf('Parent Name')] || ''),
      image: ph.indexOf('Image URL') >= 0 ? String(pd[r][ph.indexOf('Image URL')] || '') : '' };
  }
  for (let r = 1; r < vd.length; r++) {
    const id = String(vd[r][vh.indexOf('Catalog ID')] || '').trim();
    if (!id) continue;
    const name = String(vd[r][vh.indexOf('Variant Name')] || '');
    const m = name.match(/\(merged→([^)]+)\)/);
    if (m) mergedTo[id] = m[1].trim();
    const sku = vh.indexOf('Your SKU') >= 0 ? String(vd[r][vh.indexOf('Your SKU')] || '').trim() : '';
    const parent = String(vd[r][vh.indexOf('Parent ID')] || '').trim();
    variants[id] = { row: r + 1, id: id, parent: parent, name: name, sku: sku, merged: !!m };
    // Seller SKUs routinely repeat across a product's own variants (one vendor
    // code for several colors/styles), so this is PARENT ownership, not a
    // one-to-one lookup: many catalog variants, one parent, as long as they
    // all agree on which parent that is.
    if (sku && !m) {
      const k = sku.toUpperCase();
      if (!skuOwner[k]) skuOwner[k] = { parentId: parent, variantIds: [] };
      skuOwner[k].variantIds.push(id);
    }
  }
  return { ps: ps, vs: vs, ph: ph, vh: vh, parents: parents, variants: variants, mergedTo: mergedTo, skuOwner: skuOwner };
}

// Follows merge markers ("(merged→VAR-012)") to the surviving variant.
function prodLiveCatalogId_(cat, id) {
  let cur = id, hops = 0;
  while (cur && cat.mergedTo[cur] && hops < 10) { cur = cat.mergedTo[cur]; hops++; }
  return cur;
}

// ─── GET prod_bootstrap ─────────────────────────────────────────────────────

function prodBootstrapAction_() {
  const cat = prodCatalog_();
  const lt = prodTable_('listings'), vt = prodTable_('variants'), tt = prodTable_('templates');
  const byListing = {};
  vt.rows.forEach(r => {
    const lid = String(r['Listing ID']);
    (byListing[lid] = byListing[lid] || []).push(prodVariantOut_(r, cat));
  });
  const listings = lt.rows.map(r => {
    const l = prodListingOut_(r);
    l.variants = (byListing[l.listing_id] || []).sort((a, b) => a.position - b.position);
    return l;
  });
  const templates = tt.rows.map(r => ({
    template_id: String(r['Template ID']), platform: String(r['Platform']), name: String(r['Name']),
    category_path: String(r['Category Path']), category_id: String(r['Category ID']),
    file_name: String(r['File Name']), version: String(r['Version']), active: String(r['Active']) !== 'FALSE' && r['Active'] !== false,
    uploaded_by: String(r['Uploaded By']), uploaded: String(r['Uploaded Date']), config: prodJson_(r['Config'], {}),
  }));
  const skus = {};
  Object.keys(cat.skuOwner).forEach(k => { skus[k] = cat.skuOwner[k].parentId; });
  const props = PropertiesService.getScriptProperties();
  return jsonResponse({
    listings: listings, templates: templates, settings: prodSettings_(), skus: skus,
    ai_enabled: !!props.getProperty('ANTHROPIC_API_KEY'),
    ai_model: props.getProperty('AI_MODEL') || PROD_DEFAULT_MODEL,
    images_enabled: !!props.getProperty('IMAGE_SERVICE_KEY'),
    attribute_schema: PROD_ATTRIBUTE_SCHEMA, attribute_vocab: prodAttributeVocab_(),
    statuses: PROD_STATUSES,
  });
}

function prodListingOut_(r) {
  return {
    listing_id: String(r['Listing ID']), parent_id: String(r['Parent ID'] || ''), status: String(r['Status'] || 'Borrador'),
    title: String(r['Title'] || ''), shopify_title: String(r['Shopify Title'] || ''),
    description: String(r['Description'] || ''), description_html: String(r['Description HTML'] || ''),
    key_features: String(r['Key Features'] || ''), brand: String(r['Brand'] || ''),
    template_id: String(r['Template ID'] || ''), tiktok_props: prodJson_(r['TikTok Props'], {}),
    shopify_category: String(r['Shopify Category'] || ''), shopify_type: String(r['Shopify Type'] || ''),
    tags: prodJson_(r['Tags'], []), shopify_handle: String(r['Shopify Handle'] || ''),
    seo_title: String(r['SEO Title'] || ''), seo_description: String(r['SEO Description'] || ''),
    images: prodJson_(r['Images'], []), option1_name: String(r['Option 1 Name'] || ''), option2_name: String(r['Option 2 Name'] || ''),
    weight_g: r['Weight g'], length_cm: r['Length cm'], width_cm: r['Width cm'], height_cm: r['Height cm'],
    attributes: prodJson_(r['Attributes'], {}), attributes_source: String(r['Attributes Source'] || ''),
    ai_model: String(r['AI Model'] || ''), ai_at: String(r['AI Generated At'] || ''), notes: String(r['Notes'] || ''),
    shopify_product_id: String(r['Shopify Product ID'] || ''), tiktok_product_id: String(r['TikTok Product ID'] || ''),
    last_export_tiktok: String(r['Last Export TikTok'] || ''), last_export_shopify: String(r['Last Export Shopify'] || ''),
    created_by: String(r['Created By'] || ''), created: String(r['Created Date'] || ''),
    updated_by: String(r['Updated By'] || ''), updated: String(r['Updated Date'] || ''),
  };
}

function prodVariantOut_(r, cat) {
  const raw = String(r['Catalog ID'] || '');
  const live = cat ? prodLiveCatalogId_(cat, raw) : raw;
  return {
    catalog_id: live, catalog_id_was: live !== raw ? raw : '', position: Number(r['Position']) || 0,
    option1: String(r['Option 1'] || ''), option2: String(r['Option 2'] || ''), sku: String(r['Your SKU'] || ''),
    price: r['Price MXN'], compare_at: r['Compare At MXN'], cost: r['Cost MXN'], stock: r['Stock'],
    barcode: String(r['Barcode'] || ''), image: String(r['Image URL'] || ''), image_full: String(r['Full Image URL'] || ''),
    weight_g: r['Weight g'], shopify_variant_id: String(r['Shopify Variant ID'] || ''),
  };
}

// GET prod_catalog -> catalog_list (parents, variants, units sold) plus the
// full-size photo URLs, for the "link to an existing product" picker.
function prodCatalogAction_(e) {
  const base = JSON.parse(catalogListAction(e).getContent());
  const ps = getProductParentsSheet(), vs = getProductVariantsSheet();
  const fullOf = (sheet, idHeader) => {
    const d = sheet.getDataRange().getValues(), h = d[0].map(String);
    const iId = h.indexOf(idHeader), iF = h.indexOf('Full Image URL');
    const m = {};
    if (iId < 0 || iF < 0) return m;
    for (let r = 1; r < d.length; r++) { const id = String(d[r][iId] || '').trim(); if (id && d[r][iF]) m[id] = String(d[r][iF]); }
    return m;
  };
  const pFull = fullOf(ps, 'Parent ID'), vFull = fullOf(vs, 'Catalog ID');
  (base.parents || []).forEach(p => {
    p.full_image = pFull[p.parent_id] || '';
    (p.variants || []).forEach(v => { v.full_image = vFull[v.catalog_id] || ''; });
  });
  return jsonResponse(base);
}

// GET prod_sku_lookup&sku=A1234 -> which parent (if any) already owns this
// Seller SKU, with enough to show in the "is this the same product?" prompt.
// Called when a SKU field loses focus in the editor, not on every keystroke.
function prodSkuLookupAction_(e) {
  const sku = prodStr_(e.parameter.sku, 60).toUpperCase();
  if (!sku) return jsonResponse({ found: false });
  const cat = prodCatalog_();
  const owner = cat.skuOwner[sku];
  if (!owner) return jsonResponse({ found: false });
  const p = cat.parents[owner.parentId];
  if (!p) return jsonResponse({ found: false });   // orphaned row, shouldn't happen
  const names = owner.variantIds.map(id => cat.variants[id]).filter(Boolean).map(v => v.name).filter(Boolean);
  return jsonResponse({ found: true, parent_id: p.id, parent_name: p.name, parent_image: p.image, variant_names: names });
}

// Distinct values per attribute (most used first) so the AI reuses existing
// words instead of inventing synonyms ("acuarela" vs "watercolor").
function prodAttributeVocab_() {
  const t = prodTable_('attributes');
  const counts = {};
  t.rows.forEach(r => {
    const a = String(r['Attribute'] || ''), v = String(r['Value'] || '');
    if (!a || !v || a.indexOf('extra.') === 0) return;
    counts[a] = counts[a] || {};
    counts[a][v] = (counts[a][v] || 0) + 1;
  });
  const out = {};
  Object.keys(counts).forEach(a => {
    out[a] = Object.keys(counts[a]).sort((x, y) => counts[a][y] - counts[a][x]).slice(0, 40);
  });
  return out;
}

// ─── POST prod_save ─────────────────────────────────────────────────────────
// { listing: { listing_id?, parent_id?, title, ..., variants: [...] } }
function prodSaveAction_(body) {
  const inL = body.listing || {};
  const now = nowISO(), user = prodUserName_();
  const status = PROD_STATUSES.indexOf(inL.status) >= 0 ? inL.status : 'Borrador';
  const title = prodStr_(inL.title, 300);
  if (!title && !prodStr_(inL.key_features, 50)) return jsonResponse({ error: 'Escribe al menos un título o las características clave' });   // empty form
  const inVariants = Array.isArray(inL.variants) ? inL.variants.slice(0, 200) : [];

  // ---- validate SKUs. A Seller SKU is the vendor's own code, typed as-is:
  // never auto-generated, and allowed to repeat across this listing's own
  // variants (the vendor often uses one code for several colors/styles).
  // It only becomes a problem if it already belongs to a DIFFERENT parent --
  // and even then, the fix is usually to link this listing to that parent
  // (the same product, bought in a later batch), not to reject the save.
  const cat = prodCatalog_();
  const lt = prodTable_('listings'), vt = prodTable_('variants');
  const listingId = prodStr_(inL.listing_id, 20) || prodNextId_(lt.rows, 'Listing ID', 'LST-', 4);
  const isNew = !lt.rows.some(r => String(r['Listing ID']) === listingId);
  const skuLinks = (inL.sku_links && typeof inL.sku_links === 'object') ? inL.sku_links : {};   // { "A1234": "PARENT-041" } -- user already said "same product"
  const myParentIn = prodStr_(inL.parent_id, 40);
  let forcedParentId = '';   // set below if a confirmed link overrides inL.parent_id
  for (let i = 0; i < inVariants.length; i++) {
    const sku = prodStr_(inVariants[i].sku, 60);
    if (!sku) continue;
    if (/\s/.test(sku)) return jsonResponse({ error: 'El SKU «' + sku + '» no puede tener espacios' });
    const k = sku.toUpperCase();
    const owner = cat.skuOwner[k];   // { parentId, variantIds[] } | undefined
    if (!owner) continue;
    if (owner.parentId === myParentIn || owner.parentId === forcedParentId) continue;   // already our product
    if (skuLinks[sku] === '__different__' || skuLinks[k] === '__different__') continue;   // user confirmed: coincidence, different product
    if (skuLinks[sku] === owner.parentId || skuLinks[k] === owner.parentId) { forcedParentId = owner.parentId; continue; }   // user confirmed: same product
    // Stable error code ('sku_conflict') so the frontend can catch this one
    // case and show the "same product?" prompt -- the human text is separate
    // because it varies per SKU and VP.post()'s passErrors matches on `error`.
    return jsonResponse({ error: 'sku_conflict', message: 'El SKU «' + sku + '» ya existe en otro producto del catálogo',
      sku: sku, existing_parent_id: owner.parentId });
  }

  // ---- parent: link to an existing catalog product or create a new one
  let parentId = forcedParentId || myParentIn;
  const newParentRows = [];
  if (parentId && !cat.parents[parentId]) return jsonResponse({ error: 'El producto del catálogo ' + parentId + ' ya no existe' });   // merged or deleted -> pick it again
  if (!parentId) {
    parentId = generateParentID(Object.keys(cat.parents).map(id => ({ parentId: id })));
    const p = { 'Parent ID': parentId, 'Parent Name': title || prodStr_(inL.key_features, 80), 'Created Date': now };
    newParentRows.push(prodRowArray_(cat.ph, p));
    cat.parents[parentId] = { id: parentId, name: p['Parent Name'], image: '' };
  }

  const variantsIn = inVariants.length ? inVariants : [{ option1: '', option2: '' }];

  // ---- variants: create missing catalog variants, keep SKU/photo in sync
  const allVarIds = Object.keys(cat.variants).map(id => ({ catalogId: id }));
  const newVariantRows = [];
  const catUpdates = [];   // [row, header, value]
  const outVariants = variantsIn.map((v, i) => {
    let cid = v.catalog_id ? prodLiveCatalogId_(cat, String(v.catalog_id)) : '';
    if (cid && !cat.variants[cid]) cid = '';
    const opt1 = prodStr_(v.option1, 50), opt2 = prodStr_(v.option2, 50);
    const sku = prodStr_(v.sku, 60);
    const img = prodStr_(v.image, 500), imgFull = prodStr_(v.image_full, 500);
    if (!cid) {
      cid = generateCatalogID(allVarIds);
      allVarIds.push({ catalogId: cid });
      const row = { 'Catalog ID': cid, 'Parent ID': parentId, 'Variant Name': [opt1, opt2].filter(Boolean).join(', '),
        'Your SKU': sku, 'TikTok SKU IDs': '', 'Notes': 'Creado en Productos (' + listingId + ')', 'Created Date': now,
        'Image URL': img, 'Full Image URL': imgFull };
      newVariantRows.push(row);
      cat.variants[cid] = { id: cid, parent: parentId, sku: sku };
    } else {
      const cv = cat.variants[cid];
      if (sku && sku !== cv.sku) catUpdates.push([cv.row, 'Your SKU', sku]);
      if (img) { catUpdates.push([cv.row, 'Image URL', img]); if (imgFull) catUpdates.push([cv.row, 'Full Image URL', imgFull]); }
    }
    return {
      'Listing ID': listingId, 'Catalog ID': cid, 'Position': i + 1, 'Option 1': opt1, 'Option 2': opt2, 'Your SKU': sku,
      'Price MXN': prodNum_(v.price), 'Compare At MXN': prodNum_(v.compare_at), 'Cost MXN': prodNum_(v.cost),
      'Stock': prodNum_(v.stock), 'Barcode': prodStr_(v.barcode, 60).replace(/\s+/g, ''), 'Image URL': img,
      'Full Image URL': imgFull, 'Weight g': prodNum_(v.weight_g), 'Shopify Variant ID': prodStr_(v.shopify_variant_id, 60),
      'Updated Date': now,
    };
  });

  // ---- write catalog rows (new parents/variants + updates)
  if (newParentRows.length) {
    const start = cat.ps.getLastRow() + 1;
    forceTextFormat(cat.ps, cat.ph, ['Parent ID'], start, newParentRows.length);
    cat.ps.getRange(start, 1, newParentRows.length, cat.ph.length).setValues(newParentRows);
    logAuditEvent('prod_create_parent', 'Parent', parentId, { name: newParentRows[0][cat.ph.indexOf('Parent Name')], listing: listingId });
  }
  const images = (Array.isArray(inL.images) ? inL.images : []).slice(0, 9)
    .map(im => ({ thumb: prodStr_(im.thumb, 500), full: prodStr_(im.full || im.thumb, 500) })).filter(im => im.full);
  if (newVariantRows.length) {
    ['Your SKU', 'Image URL', 'Full Image URL'].forEach(h => ensureHeader(cat.vs, h));
    const vh = cat.vs.getRange(1, 1, 1, cat.vs.getLastColumn()).getValues()[0].map(String);
    const start = cat.vs.getLastRow() + 1;
    forceTextFormat(cat.vs, vh, ['Catalog ID', 'Parent ID', 'TikTok SKU IDs', 'Your SKU', 'Image URL', 'Full Image URL'], start, newVariantRows.length);
    cat.vs.getRange(start, 1, newVariantRows.length, vh.length).setValues(newVariantRows.map(o => prodRowArray_(vh, o)));
    newVariantRows.forEach(o => logAuditEvent('prod_create_variant', 'Variant', o['Catalog ID'], { parent: parentId, sku: o['Your SKU'], listing: listingId }));
  }
  if (catUpdates.length) {
    const vh = cat.vs.getRange(1, 1, 1, cat.vs.getLastColumn()).getValues()[0].map(String);
    catUpdates.forEach(u => {
      const col = vh.indexOf(u[1]) >= 0 ? vh.indexOf(u[1]) + 1 : ensureHeader(cat.vs, u[1]) + 1;
      const cell = cat.vs.getRange(u[0], col);
      const before = cell.getValue();
      if (String(before) === String(u[2])) return;
      cell.setNumberFormat('@').setValue(u[2]);
      logAudit('prod_sync_variant', 'Variant', String(cat.vs.getRange(u[0], vh.indexOf('Catalog ID') + 1).getValue()), u[1], before, u[2]);
    });
  }
  // main photo of the listing becomes the catalog parent's photo (Empacar/Productos use it)
  if (images.length && cat.parents[parentId] && cat.parents[parentId].row && cat.parents[parentId].image !== images[0].thumb) {
    const pRow = cat.parents[parentId].row;
    const c1 = ensureHeader(cat.ps, 'Image URL') + 1, c2 = ensureHeader(cat.ps, 'Full Image URL') + 1;
    cat.ps.getRange(pRow, c1).setNumberFormat('@').setValue(images[0].thumb || images[0].full);
    cat.ps.getRange(pRow, c2).setNumberFormat('@').setValue(images[0].full);
  } else if (images.length && newParentRows.length) {
    const pRow = cat.ps.getLastRow();
    const c1 = ensureHeader(cat.ps, 'Image URL') + 1, c2 = ensureHeader(cat.ps, 'Full Image URL') + 1;
    cat.ps.getRange(pRow, c1).setNumberFormat('@').setValue(images[0].thumb || images[0].full);
    cat.ps.getRange(pRow, c2).setNumberFormat('@').setValue(images[0].full);
  }

  // ---- the listing row
  const prev = lt.rows.find(r => String(r['Listing ID']) === listingId);
  const attributes = (inL.attributes && typeof inL.attributes === 'object') ? inL.attributes : {};
  let handle = prodStr_(inL.shopify_handle, 120) || (prev && String(prev['Shopify Handle'] || '')) || prodSlug_(title || listingId);
  const tags = (Array.isArray(inL.tags) ? inL.tags : String(inL.tags || '').split(',')).map(t => prodStr_(t, 60)).filter(Boolean).slice(0, 40);
  const rowObj = {
    'Listing ID': listingId, 'Parent ID': parentId, 'Status': status, 'Title': title,
    'Shopify Title': prodStr_(inL.shopify_title, 255), 'Description': prodClip_(inL.description),
    'Description HTML': prodClip_(inL.description_html), 'Key Features': prodClip_(inL.key_features),
    'Brand': prodStr_(inL.brand, 120), 'Template ID': prodStr_(inL.template_id, 40),
    'TikTok Props': JSON.stringify(inL.tiktok_props || {}), 'Shopify Category': prodStr_(inL.shopify_category, 300),
    'Shopify Type': prodStr_(inL.shopify_type, 120), 'Tags': JSON.stringify(tags), 'Shopify Handle': handle,
    'SEO Title': prodStr_(inL.seo_title, 120), 'SEO Description': prodStr_(inL.seo_description, 320),
    'Images': JSON.stringify(images), 'Option 1 Name': prodStr_(inL.option1_name, 20), 'Option 2 Name': prodStr_(inL.option2_name, 20),
    'Weight g': prodNum_(inL.weight_g), 'Length cm': prodNum_(inL.length_cm), 'Width cm': prodNum_(inL.width_cm), 'Height cm': prodNum_(inL.height_cm),
    'Attributes': prodClip_(JSON.stringify(attributes)), 'Attributes Source': prodStr_(inL.attributes_source, 20),
    'AI Model': prodStr_(inL.ai_model, 60), 'AI Generated At': prodStr_(inL.ai_at, 40), 'Notes': prodClip_(inL.notes),
    'Shopify Product ID': prodStr_(inL.shopify_product_id, 60) || (prev ? String(prev['Shopify Product ID'] || '') : ''),
    'TikTok Product ID': prodStr_(inL.tiktok_product_id, 60) || (prev ? String(prev['TikTok Product ID'] || '') : ''),
    'Last Export TikTok': prev ? prev['Last Export TikTok'] : '', 'Last Export Shopify': prev ? prev['Last Export Shopify'] : '',
    'Created By': prev ? prev['Created By'] : user, 'Created Date': prev ? prev['Created Date'] : now,
    'Updated By': user, 'Updated Date': now,
  };
  if (prev) {
    forceTextFormat(lt.sheet, lt.headers, PROD_SHEETS.listings.text, prev._row, 1);
    lt.sheet.getRange(prev._row, 1, 1, lt.headers.length).setValues([prodRowArray_(lt.headers, rowObj)]);
  } else {
    const start = lt.sheet.getLastRow() + 1;
    forceTextFormat(lt.sheet, lt.headers, PROD_SHEETS.listings.text, start, 1);
    lt.sheet.getRange(start, 1, 1, lt.headers.length).setValues([prodRowArray_(lt.headers, rowObj)]);
  }
  const keySet = {}; keySet[listingId] = true;
  prodReplaceRows_('variants', 'Listing ID', keySet, outVariants);
  prodReplaceRows_('attributes', 'Listing ID', keySet, prodFlattenAttributes_(attributes, parentId, listingId, rowObj['Attributes Source'] || 'manual', now));

  // ---- history + audit
  const hs = prodSheet_('history');
  hs.getRange(hs.getLastRow() + 1, 1, 1, 5).setValues([[listingId, now, user, isNew ? 'create' : 'update',
    prodClip_(JSON.stringify({ listing: rowObj, variants: outVariants }))]]);
  logAuditEvent(isNew ? 'prod_create_listing' : 'prod_update_listing', 'Listing', listingId,
    { title: title, status: status, variants: outVariants.length, parent: parentId });

  const saved = prodListingOut_(rowObj);
  saved.variants = outVariants.map(o => prodVariantOut_(o, null));
  return jsonResponse({ ok: true, listing: saved, created_parent: newParentRows.length ? parentId : '', created_variants: newVariantRows.length });
}

function prodNextId_(rows, col, prefix, pad) {
  let max = 0;
  rows.forEach(r => { const s = String(r[col] || ''); if (s.indexOf(prefix) === 0) { const n = parseInt(s.slice(prefix.length), 10); if (n > max) max = n; } });
  return prefix + String(max + 1).padStart(pad, '0');
}

function prodSlug_(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || ('producto-' + Date.now());
}

// attributes object -> long rows: one per value (lists become several rows)
function prodFlattenAttributes_(attrs, parentId, listingId, source, now) {
  const out = [];
  function push(key, v) {
    if (v === null || v === undefined || v === '') return;
    if (Array.isArray(v)) { v.forEach(x => push(key, x)); return; }
    if (typeof v === 'object') { Object.keys(v).forEach(k => push(key + '.' + k, v[k])); return; }
    const isNum = typeof v === 'number' && isFinite(v);
    out.push({ 'Parent ID': parentId, 'Listing ID': listingId, 'Attribute': key,
      'Value': typeof v === 'boolean' ? (v ? 'sí' : 'no') : String(v).trim().toLowerCase().slice(0, 300),
      'Value Number': isNum ? v : '', 'Source': source, 'Updated Date': now });
  }
  Object.keys(attrs || {}).forEach(k => push(k, attrs[k]));
  return out.slice(0, 400);
}

// ─── POST prod_archive ──────────────────────────────────────────────────────
// { listing_id, archived: true|false }  (archive is reversible; nothing is deleted)
function prodArchiveAction_(body) {
  const id = prodStr_(body.listing_id, 20);
  const lt = prodTable_('listings');
  const row = lt.rows.find(r => String(r['Listing ID']) === id);
  if (!row) return jsonResponse({ error: 'Producto no encontrado: ' + id });   // reload the page
  const col = lt.headers.indexOf('Status') + 1;
  const before = String(row['Status']);
  const after = body.archived ? 'Archivado' : 'Borrador';
  lt.sheet.getRange(row._row, col).setValue(after);
  logAudit('prod_archive', 'Listing', id, 'Status', before, after);
  return jsonResponse({ ok: true, listing_id: id, status: after });
}

// ─── Templates ──────────────────────────────────────────────────────────────

function prodTemplatesFolder_() {
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty('PROD_TEMPLATES_FOLDER_ID');
  if (id) { try { return DriveApp.getFolderById(id); } catch (e) { /* deleted: make a new one */ } }
  const f = DriveApp.createFolder('Vel Papier — Plantillas de productos');
  props.setProperty('PROD_TEMPLATES_FOLDER_ID', f.getId());
  return f;
}

// { platform: 'tiktok', name, file_name, file_data (base64, no data: prefix), config }
function prodTemplateSaveAction_(body) {
  const cfg = body.config || {};
  const platform = body.platform === 'shopify' ? 'shopify' : 'tiktok';
  const b64 = String(body.file_data || '').replace(/^data:[^,]+,/, '');
  if (!b64) return jsonResponse({ error: 'Falta el archivo de la plantilla' });
  let bytes;
  try { bytes = Utilities.base64Decode(b64); } catch (e) { return jsonResponse({ error: 'No se pudo leer el archivo' }); }   // corrupted upload -> try again
  if (bytes.length > 10 * 1024 * 1024) return jsonResponse({ error: 'La plantilla pesa más de 10 MB' });
  const fileName = prodStr_(body.file_name, 150) || 'plantilla.xlsx';
  const file = prodTemplatesFolder_().createFile(Utilities.newBlob(bytes, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', fileName));
  const tt = prodTable_('templates');
  const tid = prodNextId_(tt.rows, 'Template ID', 'TPL-', 3);
  const catPath = prodStr_(cfg.category_path, 300);
  // a newer upload for the same TikTok category replaces the old one (kept, just inactive)
  const activeCol = tt.headers.indexOf('Active') + 1;
  tt.rows.forEach(r => {
    if (String(r['Platform']) === platform && String(r['Category Path']) === catPath && String(r['Active']) !== 'FALSE') {
      tt.sheet.getRange(r._row, activeCol).setValue('FALSE');
    }
  });
  const rowObj = {
    'Template ID': tid, 'Platform': platform, 'Name': prodStr_(body.name, 120) || catPath.split('/').pop() || fileName,
    'Category Path': catPath, 'Category ID': prodStr_(cfg.category_id, 40), 'Drive File ID': file.getId(),
    'File Name': fileName, 'Config': prodClip_(JSON.stringify(cfg)), 'Version': prodStr_(cfg.version, 40),
    'Active': 'TRUE', 'Uploaded By': prodUserName_(), 'Uploaded Date': nowISO(),
  };
  const start = tt.sheet.getLastRow() + 1;
  forceTextFormat(tt.sheet, tt.headers, PROD_SHEETS.templates.text, start, 1);
  tt.sheet.getRange(start, 1, 1, tt.headers.length).setValues([prodRowArray_(tt.headers, rowObj)]);
  logAuditEvent('prod_template_upload', 'Template', tid, { name: rowObj['Name'], category: catPath, file: fileName });
  return jsonResponse({ ok: true, template_id: tid });
}

// GET ?action=prod_template_file&template_id=TPL-001 -> { file_name, file_data }
function prodTemplateFileAction_(e) {
  const tid = prodStr_(e.parameter.template_id, 20);
  const tt = prodTable_('templates');
  const r = tt.rows.find(x => String(x['Template ID']) === tid);
  if (!r) return jsonResponse({ error: 'Plantilla no encontrada: ' + tid });   // reload the page
  let blob;
  try { blob = DriveApp.getFileById(String(r['Drive File ID'])).getBlob(); }
  catch (err) { return jsonResponse({ error: 'El archivo de la plantilla ya no está en Drive. Súbela otra vez.' }); }   // someone deleted it in Drive -> upload the template again
  return jsonResponse({ file_name: String(r['File Name']), file_data: Utilities.base64Encode(blob.getBytes()) });
}

// { template_id, active: true|false }
function prodTemplateToggleAction_(body) {
  const tid = prodStr_(body.template_id, 20);
  const tt = prodTable_('templates');
  const r = tt.rows.find(x => String(x['Template ID']) === tid);
  if (!r) return jsonResponse({ error: 'Plantilla no encontrada: ' + tid });
  const v = body.active ? 'TRUE' : 'FALSE';
  tt.sheet.getRange(r._row, tt.headers.indexOf('Active') + 1).setValue(v);
  logAudit('prod_template_toggle', 'Template', tid, 'Active', String(r['Active']), v);
  return jsonResponse({ ok: true });
}

// ─── POST prod_export_done ──────────────────────────────────────────────────
// { platform, template_id, listing_ids: [], rows, file_name }  -> logs + stamps listings
function prodExportDoneAction_(body) {
  const platform = body.platform === 'shopify' ? 'shopify' : 'tiktok';
  const ids = (Array.isArray(body.listing_ids) ? body.listing_ids : []).map(x => String(x));
  const now = nowISO();
  const lt = prodTable_('listings');
  const stampCol = lt.headers.indexOf(platform === 'tiktok' ? 'Last Export TikTok' : 'Last Export Shopify') + 1;
  const statusCol = lt.headers.indexOf('Status') + 1;
  lt.rows.forEach(r => {
    if (ids.indexOf(String(r['Listing ID'])) < 0) return;
    lt.sheet.getRange(r._row, stampCol).setValue(now);
    if (String(r['Status']) !== 'Archivado') lt.sheet.getRange(r._row, statusCol).setValue('Exportado');
  });
  const et = prodTable_('exports');
  const eid = prodNextId_(et.rows, 'Export ID', 'EXP-', 4);
  et.sheet.getRange(et.sheet.getLastRow() + 1, 1, 1, et.headers.length).setValues([prodRowArray_(et.headers, {
    'Export ID': eid, 'Date': now, 'User': prodUserName_(), 'Platform': platform, 'Template ID': prodStr_(body.template_id, 20),
    'Listing IDs': ids.join(', '), 'Rows': Number(body.rows) || 0, 'File Name': prodStr_(body.file_name, 150),
  })]);
  logAuditEvent('prod_export', 'Listing', ids.join(','), { platform: platform, rows: body.rows, file: body.file_name });
  return jsonResponse({ ok: true, export_id: eid, at: now });
}

// ─── POST prod_settings_save ────────────────────────────────────────────────
function prodSettingsSaveAction_(body) {
  const s = body.settings || {};
  const clean = {
    brand_default: prodStr_(s.brand_default, 120) || 'No brand',
    shopify_vendor: prodStr_(s.shopify_vendor, 120) || 'Vel Papier',
    shopify_status: s.shopify_status === 'Active' ? 'Active' : 'Draft',
    tiktok_defaults: {},
    ai_voice: prodStr_(s.ai_voice, 3000),
    default_weight_g: prodNum_(s.default_weight_g),
    default_dims_cm: prodStr_(s.default_dims_cm, 40),
  };
  Object.keys(s.tiktok_defaults || {}).forEach(k => {
    const v = prodStr_(s.tiktok_defaults[k], 200);
    if (v) clean.tiktok_defaults[prodStr_(k, 80)] = v;
  });
  PropertiesService.getScriptProperties().setProperty('PROD_SETTINGS', JSON.stringify(clean));
  logAuditEvent('prod_settings_save', 'Settings', 'PROD_SETTINGS', clean);
  return jsonResponse({ ok: true, settings: clean });
}

// ─── POST prod_upload_image ─────────────────────────────────────────────────
// { file_name, file_data: 'data:image/jpeg;base64,...' } -> { thumb_url, full_url }
// Same VPS image service as catalog_upload_image, but nothing is written to a
// sheet here — the editor keeps the URLs and saves them with the listing.
function prodUploadImageAction_(body) {
  const dataUrl = String(body.file_data || '');
  const m = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (!m) return jsonResponse({ error: 'Formato de imagen no válido' });   // frontend sent something else -> hard refresh
  if (!/^image\/(jpeg|jpg|png|webp)$/i.test(m[1])) return jsonResponse({ error: 'Tipo de archivo no permitido: ' + m[1] });   // jpg/png/webp only
  let bytes;
  try { bytes = Utilities.base64Decode(m[2]); } catch (e) { return jsonResponse({ error: 'No se pudo leer el archivo' }); }
  if (bytes.length > 15 * 1024 * 1024) return jsonResponse({ error: 'La foto es demasiado grande (máx 15MB)' });
  const key = PropertiesService.getScriptProperties().getProperty('IMAGE_SERVICE_KEY');
  if (!key) return jsonResponse({ error: 'IMAGE_SERVICE_KEY no está configurada en el proyecto' });   // Apps Script -> Project Settings -> Script Properties
  const imgKey = 'LST-' + Utilities.getUuid().replace(/-/g, '').slice(0, 12);
  const boundary = '----vpProd' + Utilities.getUuid().replace(/-/g, '');
  const fileName = prodStr_(body.file_name, 100).replace(/[^\w.\-]/g, '_') || 'photo.jpg';
  const head = Utilities.newBlob('--' + boundary + '\r\nContent-Disposition: form-data; name="key"\r\n\r\n' + imgKey + '\r\n' +
    '--' + boundary + '\r\nContent-Disposition: form-data; name="file"; filename="' + fileName + '"\r\nContent-Type: ' + m[1] + '\r\n\r\n').getBytes();
  const tail = Utilities.newBlob('\r\n--' + boundary + '--\r\n').getBytes();
  const payload = Utilities.newBlob(head.concat(bytes, tail)).getBytes();
  let res;
  try {
    res = UrlFetchApp.fetch(IMAGE_SERVICE_URL + '/upload', {
      method: 'post', contentType: 'multipart/form-data; boundary=' + boundary, payload: payload,
      headers: { 'X-Service-Key': key }, muteHttpExceptions: true,
    });
  } catch (e) {
    return jsonResponse({ error: 'No se pudo conectar con el servicio de imágenes: ' + e.message });   // VPS/service down -> check "docker ps" on the VPS
  }
  let data = null;
  try { data = JSON.parse(res.getContentText()); } catch (e) { /* not JSON */ }
  if (res.getResponseCode() !== 200 || !data || !data.ok) {
    return jsonResponse({ error: (data && data.detail) || ('El servicio de imágenes respondió con error ' + res.getResponseCode()) });   // see the image-service container logs
  }
  logAuditEvent('prod_upload_image', 'Image', imgKey, { full: data.full_url });
  return jsonResponse({ ok: true, key: imgKey, thumb_url: data.thumb_url, full_url: data.full_url });
}

// ─── POST prod_ai ───────────────────────────────────────────────────────────
// { mode: 'copy' | 'attributes', input: { key_features, title, description, variants_hint,
//   option1_name, option2_name, category, brand, prices, images: [url] } }
// Two separate modes so each call stays short (Apps Script gives an outside
// request ~60 s); the editor fires both at the same time.
function prodAiAction_(body) {
  const props = PropertiesService.getScriptProperties();
  const apiKey = props.getProperty('ANTHROPIC_API_KEY');
  if (!apiKey) return jsonResponse({ error: 'La IA no está configurada todavía (falta ANTHROPIC_API_KEY)' });   // Apps Script -> Project Settings -> Script Properties -> ANTHROPIC_API_KEY
  const model = props.getProperty('AI_MODEL') || PROD_DEFAULT_MODEL;
  const mode = body.mode === 'attributes' ? 'attributes' : 'copy';
  const inp = body.input || {};
  const settings = prodSettings_();
  const facts = [
    'Características que escribió el usuario:\n' + prodStr_(inp.key_features, 6000),
    inp.title ? 'Título actual: ' + prodStr_(inp.title, 300) : '',
    inp.description ? 'Descripción actual:\n' + prodStr_(inp.description, 4000) : '',
    inp.variants_hint ? 'Variantes (como las escribió el usuario, una por línea):\n' + prodStr_(inp.variants_hint, 3000) : '',
    inp.option1_name ? 'Nombre de la opción 1: ' + prodStr_(inp.option1_name, 30) : '',
    inp.option2_name ? 'Nombre de la opción 2: ' + prodStr_(inp.option2_name, 30) : '',
    inp.category ? 'Categoría TikTok: ' + prodStr_(inp.category, 200) : '',
    inp.brand ? 'Marca: ' + prodStr_(inp.brand, 100) : '',
    inp.prices ? 'Precios (MXN): ' + prodStr_(inp.prices, 200) : '',
  ].filter(Boolean).join('\n\n');

  let system, instructions, maxTokens;
  if (mode === 'copy') {
    maxTokens = 2500;
    system = 'Eres el redactor de fichas de producto de Vel Papier, una tienda mexicana de papelería y material de arte que vende en TikTok Shop y Shopify. ' +
      'Escribes en español de México, tono cálido y claro, sin exagerar ni prometer lo que no está en los datos. Nunca inventes especificaciones: ' +
      'si un dato no aparece en las características o en las fotos, no lo menciones. Sin emojis en el título.' +
      (settings.ai_voice ? '\n\nIndicaciones de estilo de la tienda:\n' + settings.ai_voice : '');
    instructions = 'Devuelve SOLO un objeto JSON válido, sin texto antes ni después y sin ```, con esta forma:\n' +
      '{"title": "título para TikTok, máximo 255 caracteres: tipo de producto + marca/línea + rasgo clave + cantidad o medida; sin MAYÚSCULAS sostenidas",\n' +
      ' "shopify_title": "título corto para Shopify, máximo 70 caracteres",\n' +
      ' "description": "texto plano para TikTok: un párrafo de 2 frases, línea en blanco, luego 3 a 6 viñetas que empiezan con \\"• \\" (cada una máximo 250 caracteres), y si se sabe qué incluye la caja, una línea en blanco y \\"Incluye:\\" con viñetas. Usa \\\\n para los saltos de línea.",\n' +
      ' "option1_name": "nombre de la opción principal, máximo 20 caracteres (ej. \\"Color\\"), o \\"\\" si no hay variantes",\n' +
      ' "option2_name": "segunda opción o \\"\\"",\n' +
      ' "variants": [{"input": "la línea original del usuario", "option1": "valor limpio, máximo 50 caracteres", "option2": ""}],\n' +
      ' "tags": ["de 5 a 12 etiquetas en minúsculas"],\n' +
      ' "seo_title": "máximo 70 caracteres", "seo_description": "máximo 160 caracteres"}\n' +
      'Si el usuario dio variantes, devuelve una entrada en "variants" por cada línea, en el mismo orden.';
  } else {
    maxTokens = 2000;
    system = 'Eres analista de catálogo de Vel Papier (papelería y material de arte, México). Describes cada producto con atributos estructurados ' +
      'para análisis de compras: deben ser consistentes entre productos. Todos los valores de texto en español y en minúsculas. ' +
      'Nunca inventes: si un atributo no se puede saber por los datos o las fotos, usa null (o [] para listas).';
    const vocab = prodAttributeVocab_();
    instructions = 'Devuelve SOLO un objeto JSON válido, sin texto antes ni después y sin ```, con exactamente estas claves:\n' +
      JSON.stringify(PROD_ATTRIBUTE_SCHEMA, null, 1) +
      '\n\nNúmeros como números, true/false como booleanos, listas como arreglos de strings.' +
      (Object.keys(vocab).length ? '\n\nValores que ya existen en el catálogo (reutilízalos cuando signifiquen lo mismo, en vez de inventar sinónimos):\n' + JSON.stringify(vocab) : '');
  }

  const content = [];
  (Array.isArray(inp.images) ? inp.images : []).slice(0, 4).forEach(u => {
    if (/^https:\/\//i.test(String(u))) content.push({ type: 'image', source: { type: 'url', url: String(u) } });
  });
  content.push({ type: 'text', text: facts + '\n\n' + instructions });

  function call(withImages) {
    const msgContent = withImages ? content : content.filter(c => c.type === 'text');
    return UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
      method: 'post', contentType: 'application/json', muteHttpExceptions: true,
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      payload: JSON.stringify({ model: model, max_tokens: maxTokens, system: system, messages: [{ role: 'user', content: msgContent }] }),
    });
  }
  let res;
  try {
    res = call(true);
    // a photo URL the API could not fetch -> try once more with text only
    if (res.getResponseCode() === 400 && content.length > 1 && /image|url/i.test(res.getContentText())) res = call(false);
  } catch (e) {
    return jsonResponse({ error: 'No se pudo conectar con la IA: ' + e.message });   // timeout (>60 s) or network -> try again; shorten the features text if it keeps happening
  }
  const code = res.getResponseCode();
  let data = null;
  try { data = JSON.parse(res.getContentText()); } catch (e) { /* not JSON */ }
  if (code !== 200 || !data) {
    const msg = data && data.error && data.error.message ? data.error.message : ('HTTP ' + code);
    return jsonResponse({ error: 'La IA respondió con error: ' + msg });   // 401 = wrong ANTHROPIC_API_KEY; 404 = AI_MODEL name not valid; 429/529 = busy, try again
  }
  const text = (data.content || []).filter(c => c.type === 'text').map(c => c.text).join('');
  const parsed = prodExtractJson_(text);
  if (!parsed) return jsonResponse({ error: 'La IA no devolvió un JSON válido. Intenta de nuevo.' });   // rare; a retry almost always works
  logAuditEvent('prod_ai', 'AI', mode, { model: model, in_tokens: data.usage && data.usage.input_tokens, out_tokens: data.usage && data.usage.output_tokens });
  return jsonResponse({ ok: true, mode: mode, model: model, at: nowISO(), result: parsed });
}

function prodExtractJson_(text) {
  const s = String(text || '').replace(/```json|```/g, '').trim();
  try { return JSON.parse(s); } catch (e) { /* fall through */ }
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a >= 0 && b > a) { try { return JSON.parse(s.slice(a, b + 1)); } catch (e) { /* give up */ } }
  return null;
}

// Used by resolveLineItemsBatch() in apps-script.gs (Step 1b): Your SKU -> variant.
// TikTok's "Seller SKU" (and Shopify's line-item SKU) equals the Your SKU set here,
// so orders of products created in Productos land on the right Catalog ID even when
// the TikTok title differs from the catalog name.
function prodYourSkuIndex_(vData, vHeaders, variants) {
  const iSku = vHeaders.indexOf('Your SKU');
  const out = {};
  if (iSku < 0) return out;
  variants.forEach(v => {
    if (!v.rowIndex) return;
    const sku = String((vData[v.rowIndex - 1] || [])[iSku] || '').trim().toUpperCase();
    if (sku) out[sku] = v;
  });
  return out;
}
