// uploader.js — Vel Papier photo upload abstraction.
// Swap PROVIDER + one function to move off Cloudinary later.
//
// 2026-10-19 hardening (FIX_LOG 5.2): null-blob guard, fallback when the
// browser can't decode the file directly (e.g. some HEIC cases), bitmap
// memory released after each photo (iPhones ran out after many photos),
// 30 s timeout per attempt, 3 attempts with backoff, compression aligned
// to the documented standard, and no more console logging of signatures.

const PHOTO_PROVIDER = 'cloudinary';
const PHOTO_MAX_DIM = 1280;     // px, longest side
const PHOTO_QUALITY = 0.82;     // JPEG quality
const UPLOAD_TIMEOUT_MS = 30000;
const UPLOAD_ATTEMPTS = 3;

// Draws the file onto a canvas. createImageBitmap is fastest; when it
// can't decode the file, fall back to an <img> element.
async function decodeToCanvas(file, maxDim) {
  let source = null, w = 0, h = 0, cleanup = () => {};
  try {
    let bmp;
    try { bmp = await createImageBitmap(file, { resizeWidth: maxDim, resizeQuality: 'high' }); }
    catch (e2) { bmp = await createImageBitmap(file); }
    source = bmp; w = bmp.width; h = bmp.height;
    cleanup = () => { try { bmp.close(); } catch (e) {} };
  } catch (e) {
    const url = URL.createObjectURL(file);
    const img = await new Promise((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error('No se pudo leer la foto. Intenta tomarla de nuevo.'));
      el.src = url;
    });
    source = img; w = img.naturalWidth; h = img.naturalHeight;
    cleanup = () => URL.revokeObjectURL(url);
  }
  if (!w || !h) { cleanup(); throw new Error('La foto está vacía. Intenta tomarla de nuevo.'); }
  const scale = Math.min(1, maxDim / Math.max(w, h));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(w * scale);
  canvas.height = Math.round(h * scale);
  canvas.getContext('2d').drawImage(source, 0, 0, canvas.width, canvas.height);
  cleanup();
  return canvas;
}

// Compress an image file client-side before upload. Re-encoding through a
// canvas also strips EXIF data (including GPS) from the photo.
async function compressImage(file, maxDim = PHOTO_MAX_DIM, quality = PHOTO_QUALITY) {
  const canvas = await decodeToCanvas(file, maxDim);
  const blob = await new Promise(res => canvas.toBlob(res, 'image/jpeg', quality));
  canvas.width = canvas.height = 0;   // free the canvas memory right away
  if (!blob || !blob.size) throw new Error('No se pudo procesar la foto. Intenta de nuevo.');
  return blob;
}

function fetchWithTimeout(url, options, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  return fetch(url, Object.assign({}, options, { signal: ctrl.signal }))
    .finally(() => clearTimeout(timer));
}

// Upload a photo file. Returns { url, bytes }.
// folder: Cloudinary folder path, e.g. 'velpapier/qc'
async function uploadPhoto(file, folder) {
  const blob = await compressImage(file);

  if (PHOTO_PROVIDER === 'cloudinary') {
    let lastErr = null;
    for (let attempt = 1; attempt <= UPLOAD_ATTEMPTS; attempt++) {
      try {
        // A fresh signature per attempt (signatures carry a timestamp).
        const sig = await VP.get(`action=get_upload_signature&folder=${encodeURIComponent(folder)}`);
        const fd = new FormData();
        fd.append('file', blob, 'photo.jpg');
        fd.append('api_key', sig.api_key);
        fd.append('timestamp', sig.timestamp);
        fd.append('folder', sig.folder);
        fd.append('signature', sig.signature);
        const r = await fetchWithTimeout(`https://api.cloudinary.com/v1_1/${sig.cloud}/image/upload`,
          { method: 'POST', body: fd }, UPLOAD_TIMEOUT_MS);
        if (!r.ok) throw new Error('La subida falló (HTTP ' + r.status + ')');
        const j = await r.json();
        if (!j.secure_url) throw new Error('La subida no devolvió un enlace');
        return { url: j.secure_url, bytes: j.bytes };
      } catch (e) {
        lastErr = e.name === 'AbortError' ? new Error('La subida tardó demasiado (conexión lenta)') : e;
        if (attempt < UPLOAD_ATTEMPTS) await new Promise(r => setTimeout(r, 1500 * attempt));
      }
    }
    throw lastErr;
  }

  throw new Error('Unknown photo provider: ' + PHOTO_PROVIDER);
}

// Thumbnail helper for history/QC review views.
// Requires a named transformation 't_qc_thumb' created once in Cloudinary console
// (Settings → Upload → Named transformations: t_qc_thumb = w_200,q_auto,f_auto)
function thumbUrl(url) {
  return url ? url.replace('/upload/', '/upload/t_qc_thumb/') : '';
}
