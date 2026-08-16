// uploader.js — Vel Papier photo upload abstraction.
// Swap PROVIDER + one function to move off Cloudinary later.

const PHOTO_PROVIDER = 'cloudinary';

// Compress an image file client-side before upload.
// Kills the "raw 4MB phone photo crashes upload" problem at the root.
async function compressImage(file, maxDim = 1600, quality = 0.8) {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, maxDim / Math.max(bmp.width, bmp.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bmp.width * scale);
  canvas.height = Math.round(bmp.height * scale);
  canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
  return new Promise(res => canvas.toBlob(res, 'image/jpeg', quality));
}

// Upload a photo file. Returns { url, bytes }.
// folder: Cloudinary folder path, e.g. 'velpapier/qc'
async function uploadPhoto(file, folder) {
  console.log('[uploadPhoto] start', file.name, file.size);
  const blob = await compressImage(file);
  console.log('[uploadPhoto] compressed', blob ? blob.size : 'NULL BLOB');

  if (PHOTO_PROVIDER === 'cloudinary') {
    const sig = await apiGet(`action=get_upload_signature&folder=${encodeURIComponent(folder)}`);
    console.log('[uploadPhoto] signature response', sig);
    if (sig.error) throw new Error(sig.error);

    const fd = new FormData();
    fd.append('file', blob, 'photo.jpg');
    fd.append('api_key', sig.api_key);
    fd.append('timestamp', sig.timestamp);
    fd.append('folder', sig.folder);
    fd.append('signature', sig.signature);

    const r = await fetch(`https://api.cloudinary.com/v1_1/${sig.cloud}/image/upload`, {
      method: 'POST',
      body: fd,
    });
    if (!r.ok) throw new Error('upload HTTP ' + r.status);
    const j = await r.json();
    return { url: j.secure_url, bytes: j.bytes };
  }

  throw new Error('Unknown photo provider: ' + PHOTO_PROVIDER);
}

// Thumbnail helper for history/QC review views.
// Requires a named transformation 't_qc_thumb' created once in Cloudinary console
// (Settings → Upload → Named transformations: t_qc_thumb = w_200,q_auto,f_auto)
function thumbUrl(url) {
  return url ? url.replace('/upload/', '/upload/t_qc_thumb/') : '';
}
