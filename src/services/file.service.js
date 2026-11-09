// Upload, download and clean-up of files. Rules live here, SQL in models/file.model.js, and who may open a
// file in policies/file.policy.js. Upload and download return { status, body } like the auth service;
// a successful download returns { status: 200, file } for the controller to stream.

const crypto = require('crypto');
const { kvGet } = require('../models/kv.model');
const { profileOf, findUserById, idFileIds } = require('../models/user.model');
const fileModel = require('../models/file.model');
const { canOpenSharedFile, canOpenIdPhoto } = require('../policies/file.policy');
const { FILE_MAX_BYTES, FILE_TYPES } = require('../constants/files');

const fail = (status, message) => ({ status, body: { error: message } });

function fileExtOf(name) { const m = /\.([A-Za-z0-9]+)$/.exec(String(name || '')); return m ? m[1].toLowerCase() : ''; }
function looksLikeType(ext, buf) {
  const starts = (sig, off) => buf.length >= (off || 0) + sig.length && sig.every((b, i) => buf[(off || 0) + i] === b);
  if (ext === 'pdf') return starts([0x25, 0x50, 0x44, 0x46]);
  if (ext === 'png') return starts([0x89, 0x50, 0x4e, 0x47]);
  if (ext === 'jpg' || ext === 'jpeg') return starts([0xff, 0xd8, 0xff]);
  if (ext === 'webp') return starts([0x52, 0x49, 0x46, 0x46]) && starts([0x57, 0x45, 0x42, 0x50], 8);
  if (ext === 'docx' || ext === 'xlsx') return starts([0x50, 0x4b]);
  if (ext === 'doc' || ext === 'xls') return starts([0xd0, 0xcf, 0x11, 0xe0]);
  return true; // csv / txt: plain text
}

async function uploadFile(user, rawName, body) {
  const name = String(rawName || '').replace(/[\\/\0]/g, '_').trim().slice(0, 200);
  const ext = fileExtOf(name);
  if (!name) return fail(400, 'The file needs a name.');
  if (!FILE_TYPES[ext]) return fail(400, 'That file type is not allowed. Use PDF, an image (PNG, JPG, WEBP), Word, Excel, CSV or text.');
  if (!Buffer.isBuffer(body) || body.length === 0) return fail(400, 'That file is empty.');
  if (body.length > FILE_MAX_BYTES) return fail(413, 'That file is larger than 10 MB.');
  if (!looksLikeType(ext, body)) return fail(400, 'That file does not look like a real .' + ext + ' file.');
  const id = crypto.randomUUID();
  await fileModel.insertFile({ id, name, mime: FILE_TYPES[ext], size: body.length, data: body, uploadedBy: user.id });
  return { status: 200, body: { id, name, mime: FILE_TYPES[ext], size: body.length } };
}

async function downloadFile(user, rawId) {
  const f = await fileModel.findFileWithData(String(rawId).slice(0, 80));
  if (!f) return fail(404, 'That file was not found.');
  let ok = f.uploaded_by === user.id;
  if (!ok) {
    const profile = await profileOf(user);
    const containers = (await kvGet('containers')) || [];
    const messages = (await kvGet('messages')) || [];
    ok = canOpenSharedFile(user, profile, f, containers, messages);
  }
  if (!ok) ok = canOpenIdPhoto(user, await findUserById(f.uploaded_by), f);
  if (!ok) return fail(403, 'You do not have access to that file.');
  return { status: 200, file: f };
}

// Sign-up sends the ID photo as a data URL. It is stored as a file owned by the new account, and the account record
// keeps only the file's id. Returns { id } or { error }.
async function storeIdPhoto(ownerId, dataUrl, originalName) {
  const m = /^data:(image\/(png|jpeg|webp));base64,([A-Za-z0-9+/=\s]+)$/.exec(String(dataUrl));
  if (!m) return { error: 'The ID photo must be a PNG, JPG or WEBP image.' };
  const buf = Buffer.from(m[3].replace(/\s/g, ''), 'base64');
  const ext = m[2] === 'jpeg' ? 'jpg' : m[2];
  if (!buf.length || buf.length > FILE_MAX_BYTES) return { error: 'The ID photo must be smaller than 10 MB.' };
  if (!looksLikeType(ext, buf)) return { error: 'That ID photo does not look like a real image.' };
  const id = crypto.randomUUID();
  const base = String(originalName || 'id-photo').replace(/[\\/\0]/g, '_').replace(/\.[A-Za-z0-9]+$/, '').slice(0, 150) || 'id-photo';
  await fileModel.insertFile({ id, name: base + '.' + ext, mime: m[1], size: buf.length, data: buf, uploadedBy: ownerId });
  return { id };
}
async function removeStoredFile(id) { try { await fileModel.removeFiles([id]); } catch (e) { /* the clean-up will catch it */ } }

async function cleanupOrphanFiles() {
  try {
    const full = await kvGet('containers');
    if (!Array.isArray(full)) return;
    const used = new Set(await idFileIds());
    for (const m of ((await kvGet('messages')) || [])) if (m && m.fileId) used.add(m.fileId);
    for (const c of full) {
      for (const d of (c.documents || [])) if (d && d.fileId) used.add(d.fileId);
      for (const i of (c.invoices || [])) if (i && i.fileId) used.add(i.fileId);
    }
    const gone = (await fileModel.idsOlderThanOneDay()).filter(id => !used.has(id));
    if (gone.length) await fileModel.removeFiles(gone);
  } catch (e) { console.error('file cleanup failed:', e.message); }
}

module.exports = { fileExtOf, looksLikeType, uploadFile, downloadFile, cleanupOrphanFiles, storeIdPhoto, removeStoredFile };