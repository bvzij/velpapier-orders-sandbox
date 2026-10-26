// exportadores.js — Vel Papier product exporters (Productos page).
//
// 1) TikTok bulk-upload template (.xlsx, one file per TikTok category)
//    parseTikTokTemplate(arrayBuffer) -> config (columns, mandatory flags,
//      dropdown options, category, first data row). Run once when a template
//      is uploaded in Productos -> Plantillas; the config is stored in Sheets.
//    fillTikTokTemplate(arrayBuffer, config, rows) -> Blob (.xlsx)
//      Writes rows into TikTok's ORIGINAL file by editing its XML directly,
//      so every dropdown, hidden sheet and validation TikTok expects stays
//      untouched. (Rewriting the file with SheetJS would drop them and TikTok
//      would likely reject the upload.)
// 2) Shopify product CSV: buildShopifyCsv(products) -> string
//
// Needs JSZip (loaded from cdnjs in productos.html). Pure functions, no DOM
// access beyond DOMParser/XMLSerializer, so it can be tested outside a browser.
(function (root) {
  'use strict';

  const NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';

  // ── small helpers ─────────────────────────────────────────────────────────
  function parseXml(s) { return new root.DOMParser().parseFromString(s, 'application/xml'); }
  function serialize(doc) { return new root.XMLSerializer().serializeToString(doc); }
  function byTag(node, tag) { return Array.from(node.getElementsByTagNameNS(NS, tag)); }
  function firstTag(node, tag) { return node.getElementsByTagNameNS(NS, tag)[0] || null; }

  function colToNum(col) { let n = 0; for (let i = 0; i < col.length; i++) n = n * 26 + (col.charCodeAt(i) - 64); return n; }
  function numToCol(n) { let s = ''; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; }
  function splitRef(ref) { const m = /^([A-Z]+)(\d+)$/.exec(String(ref || '').replace(/\$/g, '')); return m ? { col: m[1], row: parseInt(m[2], 10) } : null; }

  function textOf(node) {
    // concatenates every <t> descendant (handles rich-text shared strings)
    if (!node) return '';
    const ts = byTag(node, 't');
    if (!ts.length) return node.textContent || '';
    return ts.map(t => t.textContent || '').join('');
  }

  async function openBook(buf) {
    if (!root.JSZip) throw new Error('JSZip no está cargado');   // productos.html must load jszip before exportadores.js
    const zip = await root.JSZip.loadAsync(buf);
    const wbXml = await zip.file('xl/workbook.xml').async('string');
    const relsXml = await zip.file('xl/_rels/workbook.xml.rels').async('string');
    const wb = parseXml(wbXml), rels = parseXml(relsXml);
    const relTarget = {};
    Array.from(rels.getElementsByTagName('Relationship')).forEach(r => { relTarget[r.getAttribute('Id')] = r.getAttribute('Target'); });
    const sheets = {};
    byTag(wb, 'sheet').forEach(s => {
      let t = relTarget[s.getAttribute('r:id')] || '';
      t = t.charAt(0) === '/' ? t.slice(1) : 'xl/' + t;
      sheets[s.getAttribute('name')] = t;
    });
    let shared = [];
    const ssFile = zip.file('xl/sharedStrings.xml');
    if (ssFile) shared = byTag(parseXml(await ssFile.async('string')), 'si').map(textOf);
    return { zip, sheets, shared };
  }

  function cellValue(c, shared) {
    const t = c.getAttribute('t');
    if (t === 's') { const v = firstTag(c, 'v'); return v ? (shared[parseInt(v.textContent, 10)] || '') : ''; }
    if (t === 'inlineStr') return textOf(firstTag(c, 'is'));
    const v = firstTag(c, 'v');
    return v ? v.textContent : '';
  }

  // Reads every cell of a sheet into { 'A1': 'value', ... } (rows <= maxRow).
  async function readSheet(book, name, maxRow) {
    const path = book.sheets[name];
    if (!path || !book.zip.file(path)) return { cells: {}, doc: null };
    const doc = parseXml(await book.zip.file(path).async('string'));
    const cells = {};
    byTag(doc, 'row').forEach(r => {
      const rn = parseInt(r.getAttribute('r'), 10);
      if (maxRow && rn > maxRow) return;
      byTag(r, 'c').forEach(c => { const v = cellValue(c, book.shared); if (v !== '') cells[c.getAttribute('r')] = v; });
    });
    return { cells, doc };
  }

  function columnValues(cells, col) {
    return Object.keys(cells).filter(k => splitRef(k) && splitRef(k).col === col)
      .sort((a, b) => splitRef(a).row - splitRef(b).row).map(k => cells[k]);
  }

  // ── 1a. Parse a TikTok template ──────────────────────────────────────────
  async function parseTikTokTemplate(buf) {
    const book = await openBook(buf);
    if (!book.sheets.Template) throw new Error('El archivo no tiene la hoja «Template». ¿Es una plantilla de TikTok?');   // wrong file -> download the template again from Seller Center
    const { cells, doc } = await readSheet(book, 'Template', 6);

    // first data row = the frozen pane's top-left cell (A7 in every template seen so far)
    let dataStartRow = 7;
    const pane = firstTag(doc, 'pane');
    if (pane && splitRef(pane.getAttribute('topLeftCell'))) dataStartRow = splitRef(pane.getAttribute('topLeftCell')).row;

    const columns = [];
    Object.keys(cells).filter(k => splitRef(k).row === 1).sort((a, b) => colToNum(splitRef(a).col) - colToNum(splitRef(b).col)).forEach(ref => {
      const col = splitRef(ref).col;
      const req = String(cells[col + '4'] || '').trim().toLowerCase();
      columns.push({
        col: col,
        key: cells[ref],
        label: String(cells[col + '3'] || cells[ref]),
        required: req.indexOf('conditionally') === 0 ? 'conditional' : (req === 'mandatory' ? 'required' : 'optional'),
        help: String(cells[col + '5'] || '').slice(0, 600),
      });
    });
    if (!columns.length) throw new Error('No se encontraron columnas en la fila 1 de «Template»');

    const category = (await readSheet(book, 'Category')).cells;
    const categoryPath = category.A1 || cells['A' + dataStartRow] || '';
    const categoryId = category.B1 || '';

    // dropdown options, read from the sheet's data validations
    const options = {};
    const sheetCache = {};
    async function sheetCells(name) { if (!sheetCache[name]) sheetCache[name] = (await readSheet(book, name)).cells; return sheetCache[name]; }
    const dvs = byTag(doc, 'dataValidation');
    for (let i = 0; i < dvs.length; i++) {
      const dv = dvs[i];
      if (dv.getAttribute('type') !== 'list') continue;
      const firstRef = splitRef(String(dv.getAttribute('sqref') || '').split(' ')[0].split(':')[0]);
      if (!firstRef) continue;
      const colDef = columns.find(c => c.col === firstRef.col);
      if (!colDef || options[colDef.key]) continue;
      const f = firstTag(dv, 'formula1');
      const formula = f ? f.textContent.trim() : '';
      let list = [];
      let m;
      if (formula.charAt(0) === '"') {
        list = formula.replace(/^"|"$/g, '').split(',').map(s => s.trim()).filter(Boolean);
      } else if ((m = /^OFFSET\((\w+)!\$([A-Z]+)\$1,MATCH\([^,]+,\1!\$([A-Z]+)\$1:\$[A-Z]+\$\d+/i.exec(formula))) {
        const sc = await sheetCells(m[1]);
        const valCol = m[2], keyCol = m[3];
        Object.keys(sc).forEach(ref => {
          const p = splitRef(ref);
          if (p.col === keyCol && sc[ref] === categoryPath && sc[valCol + p.row] != null) list.push(sc[valCol + p.row]);
        });
      } else if ((m = /^'?([^'!]+)'?!\$([A-Z]+)\$(\d+):\$([A-Z]+)\$(\d+)$/.exec(formula))) {
        const sc = await sheetCells(m[1]);
        const lo = parseInt(m[3], 10), hi = Math.min(parseInt(m[5], 10), lo + 2000);
        for (let r = lo; r <= hi; r++) if (sc[m[2] + r] != null) list.push(sc[m[2] + r]);
      }
      list = Array.from(new Set(list.map(String)));
      if (list.length) options[colDef.key] = list;
    }

    return {
      platform: 'tiktok',
      version: String(cells.A2 || ''),
      category_path: categoryPath,
      category_id: String(categoryId),
      data_start_row: dataStartRow,
      columns: columns,
      options: options,
    };
  }

  // ── 1b. Fill a TikTok template ───────────────────────────────────────────
  // rows: [{ product_name: '…', price: 129, … }] keyed by TikTok's row-1 keys.
  // Numbers stay numbers; everything else is written as text.
  async function fillTikTokTemplate(buf, config, rows, outType) {
    const book = await openBook(buf);
    const path = book.sheets.Template;
    const doc = parseXml(await book.zip.file(path).async('string'));
    const ssPath = 'xl/sharedStrings.xml';
    const ssDoc = book.zip.file(ssPath) ? parseXml(await book.zip.file(ssPath).async('string')) : null;
    if (!ssDoc) throw new Error('La plantilla no tiene sharedStrings.xml');   // unexpected template format -> download it again from TikTok
    const sst = ssDoc.documentElement;
    let added = 0;
    function addShared(text) {
      const si = ssDoc.createElementNS(NS, 'si');
      const t = ssDoc.createElementNS(NS, 't');
      t.setAttributeNS('http://www.w3.org/XML/1998/namespace', 'xml:space', 'preserve');
      t.appendChild(ssDoc.createTextNode(text));
      si.appendChild(t);
      sst.appendChild(si);
      return book.shared.length + (added++);
    }

    const start = config.data_start_row || 7;
    const colByKey = {};
    (config.columns || []).forEach(c => { colByKey[c.key] = c.col; });
    const sheetData = firstTag(doc, 'sheetData');
    const rowEls = {};
    byTag(sheetData, 'row').forEach(r => { rowEls[parseInt(r.getAttribute('r'), 10)] = r; });

    // wipe whatever sits in the data area (the template pre-fills A7 with the category)
    Object.keys(rowEls).forEach(k => {
      if (parseInt(k, 10) < start) return;
      byTag(rowEls[k], 'c').forEach(c => { while (c.firstChild) c.removeChild(c.firstChild); c.removeAttribute('t'); });
    });

    function getRow(rn) {
      if (rowEls[rn]) return rowEls[rn];
      const el = doc.createElementNS(NS, 'row');
      el.setAttribute('r', String(rn));
      const after = Object.keys(rowEls).map(Number).filter(n => n > rn).sort((a, b) => a - b)[0];
      if (after) sheetData.insertBefore(el, rowEls[after]); else sheetData.appendChild(el);
      rowEls[rn] = el;
      return el;
    }
    function getCell(rowEl, ref) {
      const cells = byTag(rowEl, 'c');
      for (let i = 0; i < cells.length; i++) if (cells[i].getAttribute('r') === ref) return cells[i];
      const n = colToNum(splitRef(ref).col);
      const c = doc.createElementNS(NS, 'c');
      c.setAttribute('r', ref);
      const next = cells.find(x => colToNum(splitRef(x.getAttribute('r')).col) > n);
      if (next) rowEl.insertBefore(c, next); else rowEl.appendChild(c);
      return c;
    }

    let maxCol = 1;
    rows.forEach((data, i) => {
      const rn = start + i;
      const rowEl = getRow(rn);
      rowEl.removeAttribute('spans');
      Object.keys(data).forEach(key => {
        const col = colByKey[key];
        let val = data[key];
        if (!col || val == null || val === '') return;
        maxCol = Math.max(maxCol, colToNum(col));
        const c = getCell(rowEl, col + rn);
        while (c.firstChild) c.removeChild(c.firstChild);
        const v = doc.createElementNS(NS, 'v');
        if (typeof val === 'number' && isFinite(val)) {
          c.removeAttribute('t');
          v.appendChild(doc.createTextNode(String(val)));
        } else {
          c.setAttribute('t', 's');
          v.appendChild(doc.createTextNode(String(addShared(String(val)))));
        }
        c.appendChild(v);
      });
    });

    const cnt = parseInt(sst.getAttribute('count') || '0', 10);
    const uniq = parseInt(sst.getAttribute('uniqueCount') || String(book.shared.length), 10);
    sst.setAttribute('count', String(cnt + added));
    sst.setAttribute('uniqueCount', String(uniq + added));
    const dim = firstTag(doc, 'dimension');
    if (dim) dim.setAttribute('ref', 'A1:' + numToCol(Math.max(maxCol, (config.columns || []).length)) + Math.max(start - 1 + rows.length, 6));

    book.zip.file(path, serialize(doc));
    book.zip.file(ssPath, serialize(ssDoc));
    return book.zip.generateAsync({
      type: outType || 'blob', compression: 'DEFLATE',
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });
  }

  // Turns saved listings into TikTok rows (one row per variant).
  // listing: { title, description, brand, images:[{full}], option1_name, option2_name,
  //            weight_g, length_cm, width_cm, height_cm, tiktok_props:{key:value},
  //            variants:[{option1, option2, sku, price, stock, image_full}] }
  function tiktokRowsFor(listing, config) {
    const out = [];
    const imgs = (listing.images || []).map(im => im.full || im.thumb).filter(Boolean).slice(0, 9);
    const imgKeys = ['main_image', 'image_2', 'image_3', 'image_4', 'image_5', 'image_6', 'image_7', 'image_8', 'image_9'];
    const variants = (listing.variants && listing.variants.length) ? listing.variants : [{}];
    const num = v => (v === '' || v == null || isNaN(Number(v))) ? '' : Number(v);
    variants.forEach(v => {
      const r = {
        category: config.category_path,
        brand: listing.brand && listing.brand !== 'No brand' ? listing.brand : '',
        product_name: listing.title,
        product_description: listing.description,
        parcel_weight: num(listing.weight_g),
        parcel_length: num(listing.length_cm),
        parcel_width: num(listing.width_cm),
        parcel_height: num(listing.height_cm),
        price: num(v.price),
        quantity: num(v.stock === '' || v.stock == null ? 0 : v.stock),
        seller_sku: v.sku || '',
      };
      imgs.forEach((u, i) => { r[imgKeys[i]] = u; });
      if (listing.option1_name && v.option1) {
        r.property_name_1 = listing.option1_name;
        r.property_value_1 = v.option1;
        if (v.image_full || v.image) r.property_1_image = v.image_full || v.image;
        if (listing.option2_name && v.option2) { r.property_name_2 = listing.option2_name; r.property_value_2 = v.option2; }
      }
      const props = listing.tiktok_props || {};
      Object.keys(props).forEach(k => { if (props[k] !== '' && props[k] != null) r[k] = props[k]; });
      out.push(r);
    });
    return out;
  }

  // ── 2. Shopify CSV ───────────────────────────────────────────────────────
  const SHOPIFY_HEADERS = ['Title', 'URL handle', 'Description', 'Vendor', 'Product category', 'Type', 'Tags',
    'Published on online store', 'Status', 'SKU', 'Variant Barcodes', 'Option1 name', 'Option1 value', 'Option1 Linked To',
    'Option2 name', 'Option2 value', 'Option2 Linked To', 'Option3 name', 'Option3 value', 'Option3 Linked To', 'Price',
    'Compare-at price', 'Cost per item', 'Charge tax', 'Tax code', 'Unit price total measure', 'Unit price total measure unit',
    'Unit price base measure', 'Unit price base measure unit', 'Inventory tracker', 'Inventory quantity',
    'Continue selling when out of stock', 'Weight value (grams)', 'Weight unit for display', 'Requires shipping',
    'Fulfillment service', 'Product image URL', 'Image position', 'Image alt text', 'Variant image URL', 'Gift card',
    'SEO title', 'SEO description', 'Color (product.metafields.shopify.color-pattern)', 'Google Shopping / Google product category',
    'Google Shopping / Gender', 'Google Shopping / Age group', 'Google Shopping / Manufacturer part number (MPN)',
    'Google Shopping / Ad group name', 'Google Shopping / Ads labels', 'Google Shopping / Condition',
    'Google Shopping / Custom product', 'Google Shopping / Custom label 0', 'Google Shopping / Custom label 1',
    'Google Shopping / Custom label 2', 'Google Shopping / Custom label 3', 'Google Shopping / Custom label 4',
    'Packed product length', 'Packed product width', 'Packed product height', 'Packed product dimension unit'];

  function csvCell(v) {
    const s = v == null ? '' : String(v);
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  function textToHtml(text) {
    // plain description (TikTok style, line breaks + bullets) -> simple HTML for Shopify
    const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const blocks = String(text || '').split(/\n\s*\n/);
    return blocks.map(b => {
      const lines = b.split('\n').map(l => l.trim()).filter(Boolean);
      if (!lines.length) return '';
      if (lines.every(l => /^[•\-\*✓✔▪·]/.test(l))) return '<ul>' + lines.map(l => '<li>' + esc(l.replace(/^[•\-\*✓✔▪·]\s*/, '')) + '</li>').join('') + '</ul>';
      return '<p>' + lines.map(esc).join('<br>') + '</p>';
    }).join('');
  }

  // products: same listing shape as tiktokRowsFor, plus shopify_* fields
  function buildShopifyCsv(products, settings) {
    settings = settings || {};
    const lines = [SHOPIFY_HEADERS.map(csvCell).join(',')];
    products.forEach(p => {
      const handle = p.shopify_handle;
      const imgs = (p.images || []).map(im => im.full || im.thumb).filter(Boolean);
      const variants = (p.variants && p.variants.length) ? p.variants : [{}];
      const n = Math.max(variants.length, imgs.length, 1);
      for (let i = 0; i < n; i++) {
        const v = variants[i];
        const row = {};
        row['URL handle'] = handle;
        if (i === 0) {
          Object.assign(row, {
            'Title': p.shopify_title || p.title,
            'Description': p.description_html || textToHtml(p.description),
            'Vendor': p.brand && p.brand !== 'No brand' ? p.brand : (settings.shopify_vendor || 'Vel Papier'),
            'Product category': p.shopify_category || '',
            'Type': p.shopify_type || '',
            'Tags': (p.tags || []).join(', '),
            'Published on online store': 'TRUE',
            'Status': settings.shopify_status || 'Draft',
            'Gift card': 'FALSE',
            'SEO title': p.seo_title || '',
            'SEO description': p.seo_description || '',
          });
        }
        if (v) {
          Object.assign(row, {
            'SKU': v.sku || '',
            'Variant Barcodes': v.barcode || '',
            'Price': v.price === '' || v.price == null ? '' : Number(v.price).toFixed(2),
            'Compare-at price': v.compare_at ? Number(v.compare_at).toFixed(2) : '',
            'Cost per item': v.cost ? Number(v.cost).toFixed(2) : '',
            'Charge tax': 'TRUE',
            'Inventory tracker': 'shopify',
            'Inventory quantity': v.stock === '' || v.stock == null ? 0 : v.stock,
            'Continue selling when out of stock': 'DENY',
            'Weight value (grams)': v.weight_g || p.weight_g || '',
            'Weight unit for display': 'g',
            'Requires shipping': 'TRUE',
            'Fulfillment service': 'manual',
            'Variant image URL': v.image_full || v.image || '',
            'Packed product length': p.length_cm || '',
            'Packed product width': p.width_cm || '',
            'Packed product height': p.height_cm || '',
            'Packed product dimension unit': (p.length_cm || p.width_cm || p.height_cm) ? 'cm' : '',
          });
          if (p.option1_name) {
            if (i === 0) row['Option1 name'] = p.option1_name;
            row['Option1 value'] = v.option1 || '';
            if (p.option2_name) { if (i === 0) row['Option2 name'] = p.option2_name; row['Option2 value'] = v.option2 || ''; }
          } else if (i === 0) {
            row['Option1 name'] = 'Title';
            row['Option1 value'] = 'Default Title';
          }
        }
        if (imgs[i]) { row['Product image URL'] = imgs[i]; row['Image position'] = i + 1; row['Image alt text'] = i === 0 ? (p.title || '') : ''; }
        lines.push(SHOPIFY_HEADERS.map(h => csvCell(row[h])).join(','));
      }
    });
    return lines.join('\r\n') + '\r\n';
  }

  root.VPExport = { parseTikTokTemplate, fillTikTokTemplate, tiktokRowsFor, buildShopifyCsv, textToHtml, SHOPIFY_HEADERS, colToNum, numToCol };
})(typeof window !== 'undefined' ? window : globalThis);
