const { deepEqual } = require('../utils/compare');
const { isSctl } = require('./role.policy');
const { FEN_BOL_DEPTS } = require('../constants/stages');
const { CLIENT_DOC_TYPES } = require('./container.policy');
const { fileMeta } = require('../models/file.model');

const STAFF_DOC_TYPES = ['Transfer Letter', 'Landing Certificate', 'Inspection Act', 'Exit Note', 'Gate Pass', 'PAAR', 'Bill of Lading',
  'Duty Receipt', 'Manifest', 'SGD', 'Assessment Notice', 'SON Remita Payment Receipt', 'Other'];
const DOC_FIELDS = new Set(['id', 'name', 'type', 'uploadedBy', 'uploadedByRole', 'date', 'sizeKB', 'fileId', 'mime', 'onBehalfOf', 'replaces', 'rejected']);
function withoutKeys(o, keys) { const x = Object.assign({}, o); for (const k of keys) delete x[k]; return x; }
function isClientDocOf(c, d) {
  if (d.uploadedByRole === 'importer' || d.uploadedByRole === 'agent') return true;
  return !d.uploadedByRole && (d.uploadedBy === c.owner || d.uploadedBy === c.agent);
}

// Rules for every change to a job's documents (and the files behind documents and invoices).
// Returns null if fine, or a plain-language reason.
async function checkDocumentChanges(oldArr, newArr, user, profile) {
  const oldById = new Map(oldArr.map(c => [c.id, c]));
  const isClient = user.role === 'importer' || user.role === 'agent';
  for (const c of newArr) {
    const prev = oldById.get(c.id);
    if (!prev) continue;
    const pd = Array.isArray(prev.documents) ? prev.documents : [];
    const nd = Array.isArray(c.documents) ? c.documents : [];
    const label = c.containerNumber;

    // new invoice files must really exist and be the uploader's own
    const prevInv = new Set((prev.invoices || []).map(i => i && i.id));
    for (const inv of (c.invoices || [])) {
      if (!inv || prevInv.has(inv.id) || !inv.fileId) continue;
      const f = await fileMeta(inv.fileId);
      if (!f) return 'The invoice file was not found on the server. Upload it again.';
      if (f.uploaded_by !== user.id) return 'That invoice file was uploaded by someone else.';
    }

    if (deepEqual(pd, nd)) continue;
    if (nd.length < pd.length) return 'Documents cannot be removed from ' + label + '.';

    for (let i = 0; i < pd.length; i++) {
      const p = pd[i], n = nd[i];
      if (deepEqual(p, n)) continue;
      if (!n || typeof n !== 'object') return 'Invalid document.';
      if (p.id && n.id !== p.id) return 'Existing documents cannot be changed. Upload the corrected one instead.';
      const n2 = withoutKeys(n, ['rejected']);
      if (!deepEqual(withoutKeys(p, ['id']), withoutKeys(n2, ['id']))) return 'Existing documents cannot be changed. Upload the corrected one instead.';
      if (!n.rejected) {
        if (isClient) return 'Existing documents cannot be changed. Upload the corrected one instead.';
        continue; // staff giving an older document an id so it can be tracked
      }
      if (p.rejected) return 'That document is already rejected.';
      if (isClient) return 'Only BILBT staff can reject a document.';
      if (!isSctl(user) && !FEN_BOL_DEPTS.includes(user.department)) return 'Only Admin, Documentation or DTI staff can reject a document.';
      if (!isClientDocOf(c, p)) return 'Only a document sent by the importer or agent can be rejected.';
      if (typeof n.id !== 'string' || !n.id) return 'Invalid document.';
      const r = n.rejected;
      if (!r || typeof r !== 'object' || Object.keys(r).some(k => !['by', 'date', 'reason'].includes(k))) return 'Invalid rejection.';
      if (typeof r.reason !== 'string' || r.reason.trim().length < 3 || r.reason.length > 500) return 'Say what is wrong with the document (at least a few words) when rejecting it.';
      if (!profile || r.by !== profile.name) return 'The rejection must be recorded under your own name.';
      if (nd.some(x => x && x.replaces === n.id)) return 'That document has already been replaced.';
    }

    const added = nd.slice(pd.length);
    if (added.length > 5) return 'Too many documents in one go.';
    const ids = new Set(nd.slice(0, pd.length).map(d => d && d.id).filter(Boolean));
    for (const d of added) {
      if (!d || typeof d !== 'object') return 'Invalid document.';
      if (Object.keys(d).some(k => !DOC_FIELDS.has(k))) return 'Invalid document.';
      if (d.rejected) return 'A new document cannot start out rejected.';
      if (typeof d.id !== 'string' || !d.id || d.id.length > 60 || ids.has(d.id)) return 'Invalid document.';
      ids.add(d.id);
      if (typeof d.name !== 'string' || !d.name || d.name.length > 200) return 'Invalid document.';
      if (!profile || d.uploadedBy !== profile.name) return 'A document must be uploaded under your own name.';
      if (d.uploadedByRole !== (isClient ? user.role : 'staff')) return 'Invalid document.';
      if (isClient) {
        if (!CLIENT_DOC_TYPES.includes(d.type)) return 'Importers and agents can only upload a Bill of Lading, a PAAR, or Other documents.';
      } else if (!STAFF_DOC_TYPES.includes(d.type)) return 'Unknown document type.';
      if (!d.fileId) return 'Choose the file to upload — a document must come with its file.';
      const f = await fileMeta(d.fileId);
      if (!f) return 'The file was not found on the server. Upload it again.';
      if (f.uploaded_by !== user.id) return 'That file was uploaded by someone else.';
      if (d.onBehalfOf !== undefined && d.onBehalfOf !== null) {
        if (isClient) return 'Only BILBT staff can upload on behalf of someone else.';
        if (!isSctl(user) && !FEN_BOL_DEPTS.includes(user.department)) return 'Only Admin, Documentation or DTI staff can upload on behalf of an importer or agent.';
        if (d.onBehalfOf !== c.owner && d.onBehalfOf !== c.agent) return 'You can only upload on behalf of the importer or agent on this job.';
      }
      if (d.replaces) {
        const target = nd.slice(0, pd.length).find(x => x && x.id === d.replaces);
        if (!target || !target.rejected) return 'You can only replace a document that has been rejected.';
        if (nd.some(x => x !== d && x && x.replaces === d.replaces)) return 'That rejected document has already been replaced.';
        if (d.type !== target.type) return 'The replacement has to be the same kind of document.';
        if (isClient && target.uploadedBy !== profile.name) return 'You can only replace your own rejected documents.';
      }
    }
  }
  return null;
}

// A chat message may carry one attached file: it must be a real stored file the sender uploaded.
async function checkMessageFiles(full, parsed, user) {
  const fullIds = new Set(full.map(m => m.id));
  let n = 0;
  for (const m of parsed) {
    if (fullIds.has(m.id) || !m.fileId) continue;
    if (++n > 5) return 'Too many attachments in one go.';
    if (typeof m.fileId !== 'string') return 'Invalid attachment.';
    const f = await fileMeta(m.fileId);
    if (!f) return 'The attached file was not found on the server. Attach it again.';
    if (f.uploaded_by !== user.id) return 'That file was uploaded by someone else.';
  }
  return null;
}

module.exports = { STAFF_DOC_TYPES, DOC_FIELDS, withoutKeys, isClientDocOf, checkDocumentChanges, checkMessageFiles };