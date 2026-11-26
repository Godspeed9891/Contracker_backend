const { deepEqual, isBlankVal, looseEqual } = require('../utils/compare');
const { kvGet } = require('../models/kv.model');
const { isSctl } = require('./role.policy');
const { FEN_BOL_DEPTS, DEFAULT_DEPT_STAGE_ACCESS, DERIVED_CONTAINER_KEYS } = require('../constants/stages');
const { labelOf, CAP_DEPTS, FIELD_CAPS } = require('../constants/containerFields');

// A job counts as "untouched" while nothing but its registration exists. (No longer used for deleting:
// any archived job may now be deleted by its terminal's Admin; kept because other code may still use it.)
function isUntouchedJob(c) {
  if ((c.stageIdx || 0) !== 0) return false;
  for (const k of ['documents', 'alerts', 'invoices', 'transportHistory', 'progressNotes', 'transporter', 'transferLetterNumber',
                   'invoiceNumber', 'exitNumber', 'aNumber', 'cNumber', 'returnDueDate', 'leftTerminalDate', 'returnedDate']) if (!isBlankVal(c[k])) return false;
  if (c.bolComplete) return false;
  if (Array.isArray(c.history) && c.history.length > 1) return false;
  const f = Object.assign({}, c.financial || {}); delete f.processingCharge; delete f.dutyStatus;
  return Object.values(f).every(isBlankVal);
}

// Which fields really differ between the stored job and the proposed one.
function changedContainerKeys(prev, next) {
  const keys = new Set([...Object.keys(prev), ...Object.keys(next)]);
  const out = [];
  for (const k of keys) {
    if (DERIVED_CONTAINER_KEYS.has(k)) continue;
    if (!looseEqual(prev[k], next[k], k)) out.push(k);
  }
  return out;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const validDate = s => DATE_RE.test(String(s)) && !isNaN(new Date(String(s) + 'T00:00:00Z'));
const NOTE_KEYS = new Set(['id', 'text', 'by', 'date', 'staffOnly', 'audience', 'replyTo', 'edited', 'editedAt', 'fileId', 'fileName', 'mime']);
const AUDIENCES = ['customs', 'importer', 'agent', 'staff'];
const noteText = t => typeof t === 'string' && t.trim().length > 0 && t.length <= 2000;

// Who sees the money on a job (the full breakdown, expenses, profit and the invoices): an Admin or Accountant, i.e. anyone
// with the finance permission. Everybody else only ever gets the processing charge written at first entry (see views/container.view.js).
function canSeeFinanceData(user, profile) {
  return !!user && user.role === 'admin' && hasCap(user, profile, 'finance');
}

// Every comment belongs to one section: customs, importer, agent, or staff (internal). A reply stays in its parent's section.
// Comments saved before sections existed are placed by their staffOnly flag, their parent, or who wrote them.
function noteAudience(job, n, depth) {
  if (!n) return 'staff';
  if (AUDIENCES.includes(n.audience)) return n.audience;
  if (n.staffOnly) return 'staff';
  const notes = (job && job.progressNotes) || [];
  if (n.replyTo && (depth || 0) < 20) {
    const par = notes.find(x => x && x.id === n.replyTo);
    if (par && par !== n) return noteAudience(job, par, (depth || 0) + 1);
  }
  if (job && n.by && n.by === job.owner) return 'importer';
  if (job && n.by && n.by === job.agent) return 'agent';
  return 'staff';
}
// Terminal staff read every section; importers, agents and customs read only their own; SCTL reads none.
function noteVisibleTo(user, job, n) {
  if (!user || user.role === 'sctl') return false;
  if (user.role === 'admin') return true;
  return noteAudience(job, n) === user.role;
}
function canSeeStaffNotes(user) { return !!user && user.role === 'admin'; }

// Comments on a job. Whoever may write one adds it under their own name, in their own section (staff choose any section),
// may reply inside a section they can see, and may edit (the text only) or delete their own comments, never anyone else's.
function checkNoteChanges(prevJob, nextJob, user, profile) {
  const prev = Array.isArray(prevJob.progressNotes) ? prevJob.progressNotes : [];
  const next = Array.isArray(nextJob.progressNotes) ? nextJob.progressNotes : [];
  if (!profile) return 'Your profile was not found.';
  if (user.role === 'sctl') return 'SCTL cannot write comments.';
  if (next.length > 500) return 'Too many comments on one job.';
  const prevById = new Map(prev.filter(n => n && n.id).map(n => [n.id, n]));
  const nextById = new Map();
  for (const n of next) {
    if (!n || typeof n !== 'object' || typeof n.id !== 'string' || !n.id || n.id.length > 60 || nextById.has(n.id)) return 'Invalid comment.';
    nextById.set(n.id, n);
  }
  for (const p of prev) {
    if (p && !nextById.has(p.id) && p.by !== profile.name) return 'You can only delete your own comments.';
  }
  for (const n of next) {
    const p = prevById.get(n.id);
    if (p) {
      if (deepEqual(p, n)) continue;
      if (p.by !== profile.name) return 'You can only edit your own comments.';
      const strip = o => { const x = Object.assign({}, o); delete x.text; delete x.edited; delete x.editedAt; return x; };
      if (!deepEqual(strip(p), strip(n))) return 'Only the text of a comment can be edited.';
      if (!noteText(n.text)) return 'A comment cannot be empty or longer than 2000 characters.';
      continue;
    }
    if (Object.keys(n).some(k => !NOTE_KEYS.has(k))) return 'Invalid comment.';
    if (n.edited || n.editedAt) return 'Invalid comment.';
    if (n.by !== profile.name) return 'A comment must be written under your own name.';
    if (!noteText(n.text)) return 'A comment cannot be empty or longer than 2000 characters.';
    if (typeof n.date !== 'string' || isNaN(new Date(n.date))) return 'Invalid comment.';
    if (n.fileId !== undefined && (typeof n.fileId !== 'string' || !n.fileId || n.fileId.length > 80)) return 'Invalid attachment.';
    if (n.fileName !== undefined && (typeof n.fileName !== 'string' || n.fileName.length > 200)) return 'Invalid attachment.';
    if (n.mime !== undefined && (typeof n.mime !== 'string' || n.mime.length > 120)) return 'Invalid attachment.';
    if ((n.fileName || n.mime) && !n.fileId) return 'Invalid attachment.';
    // the section
    let aud = n.audience;
    if (n.replyTo) {
      const par = prevById.get(n.replyTo) || nextById.get(n.replyTo);
      if (!par || par === n) return 'You can only reply to a comment you can see.';
      const pa = noteAudience(prevJob, par);
      if (aud !== undefined && aud !== pa) return 'A reply stays in the same section as the comment it answers.';
      aud = pa;
    }
    if (user.role !== 'admin') {
      if (aud !== user.role) return 'Write your comment in your own section.';
    } else if (!AUDIENCES.includes(aud)) return 'Choose which section the comment belongs to.';
    if (n.staffOnly !== undefined && n.staffOnly !== (aud === 'staff')) return 'Invalid comment.';
  }
  return null;
}

function jobVisibleTo(user, profile, c) {
  if (user.role === 'sctl') return true;
  if (c.archived) return user.role === 'admin' && c.terminalId === user.terminalId && hasCap(user, profile, 'archiveView');
  if (user.role === 'customs') return true;                // read-only, across terminals
  if (c.terminalId !== user.terminalId) return false;      // everyone else: their own terminal only
  if (user.role === 'admin') return true;
  if (!profile) return false;
  if (user.role === 'importer') return c.owner === profile.name;
  if (user.role === 'agent') return c.agent === profile.name;
  return false;
}

// Importers and agents may only fill in the delivery location and upload (pending) invoices on their own jobs.
function checkInvoiceAppend(prev, next, profile) {
  const prevIds = new Set(prev.map(i => i.id));
  for (const p of prev) {
    const n = next.find(i => i.id === p.id);
    if (!n || !deepEqual(n, p)) return 'Existing invoices cannot be changed by the importer or agent.';
  }
  for (const n of next) {
    if (prevIds.has(n.id)) continue;
    if (n.status !== 'pending' || n.paymentStatus !== 'unpaid') return 'A new invoice must start as pending and unpaid.';
    if (profile && n.uploadedBy !== profile.name) return 'An invoice must be uploaded under your own name.';
  }
  return null;
}

// Importers and agents may add Bill of Lading, PAAR and Other documents to their own jobs — add only, under their own name.
const CLIENT_DOC_TYPES = ['Bill of Lading', 'PAAR', 'Other'];
function checkClientJobWrite(oldArr, newArr, authUser, profile) {
  const oldById = new Map(oldArr.map(c => [c.id, c]));
  if (newArr.length !== oldArr.length || newArr.some(c => !oldById.has(c.id))) return 'Importers and agents cannot add or remove jobs.';
  for (const c of newArr) {
    const prev = oldById.get(c.id);
    for (const k of changedContainerKeys(prev, c)) {
      if (k === 'deliveryLocation') continue;
      if (k === 'documents') continue; // checked in full by checkDocumentChanges
      if (k === 'transporter' || k === 'transportHistory') {   // the importer or agent on a job may record the transporter and add a driver
        const x = c[k];
        if (x !== null && x !== undefined && x !== '' && (typeof x !== 'object' || JSON.stringify(x).length > 20000)) return 'Invalid transporter details.';
        continue;
      }
      if (k === 'financial') continue; // they only see a summary; the server keeps the stored breakdown
      if (k === 'progressNotes') { const err = checkNoteChanges(prev, c, authUser, profile); if (err) return err; continue; }
      if (k === 'invoices') { const err = checkInvoiceAppend(prev.invoices || [], c.invoices || [], profile); if (err) return err; continue; }
      return 'Importers and agents can only update the delivery location, upload invoices, write comments, and add a Bill of Lading, PAAR or Other document (not the ' + labelOf(k) + ' on ' + c.containerNumber + ').';
    }
  }
  return null;
}

// Customs may read every job and write comments on them, nothing else.
function checkCustomsJobWrite(oldArr, newArr, authUser, profile) {
  const oldById = new Map(oldArr.map(c => [c.id, c]));
  if (newArr.length !== oldArr.length || newArr.some(c => !oldById.has(c.id))) return 'Customs cannot add or remove jobs.';
  for (const c of newArr) {
    const prev = oldById.get(c.id);
    for (const k of changedContainerKeys(prev, c)) {
      if (k === 'financial') continue;
      if (k === 'progressNotes') { const err = checkNoteChanges(prev, c, authUser, profile); if (err) return err; continue; }
      return 'Customs can only write comments on a job (not change the ' + labelOf(k) + ' on ' + c.containerNumber + ').';
    }
  }
  return null;
}

// Can this staff member do this? Admin department: always. Otherwise their own on/off setting wins, then the department default.
function hasCap(authUser, profile, cap) {
  if (!authUser || authUser.role !== 'admin') return false;
  if (authUser.department === 'Admin') return true;
  const g = profile && profile.grants && profile.grants.caps ? profile.grants.caps[cap] : undefined;
  if (g === true) return true;
  if (g === false) return false;
  return !!CAP_DEPTS[cap] && CAP_DEPTS[cap].includes(authUser.department);
}

// Checks a proposed write to the `containers` collection. SCTL bypasses
// entirely (including deleting). Every other staff account is scoped to its
// OWN terminal — a job at another terminal can't be touched at all — and the
// department rules are re-checked field by field. A terminal's Admin
// department may also delete an ARCHIVED job at its own terminal.
async function checkContainersWrite(oldArr, newArr, authUser, profile) {
  oldArr = Array.isArray(oldArr) ? oldArr : [];
  if (!Array.isArray(newArr)) return 'Malformed container list.';
  if (!authUser) return 'Sign in required.';
  {
    // Only an archived job can be permanently deleted. Who may delete it is checked further down.
    const keepIds = new Set(newArr.map(c => c.id));
    for (const c of oldArr) {
      if (!keepIds.has(c.id) && !c.archived) {
        return 'Job ' + c.containerNumber + ' is still active. Archive it first; only archived jobs can be deleted.';
      }
    }
  }
  if (isSctl(authUser)) {
    // SCTL oversees every terminal: it may look at any job but never change one. Only the terminal's own staff do that.
    const oldIds = new Set(oldArr.map(c => c.id));
    const sameSet = newArr.length === oldArr.length && newArr.every(c => oldIds.has(c.id));
    const oldById = new Map(oldArr.map(c => [c.id, c]));
    if (!sameSet || newArr.some(c => changedContainerKeys(oldById.get(c.id), c).filter(k => k !== 'financial').length)) {
      return 'SCTL can view jobs but cannot change them. Only the bonded terminal\'s own staff can.';
    }
    return null;
  }
  if (authUser.role === 'importer' || authUser.role === 'agent') return checkClientJobWrite(oldArr, newArr, authUser, profile);
  if (authUser.role === 'customs') return checkCustomsJobWrite(oldArr, newArr, authUser, profile);
  if (authUser.role !== 'admin') return 'Only bonded terminal staff accounts can change job records.';

  const dept = authUser.department;
  const myTerminal = authUser.terminalId;
  const oldById = new Map(oldArr.map(c => [c.id, c]));
  const newById = new Map(newArr.map(c => [c.id, c]));

  for (const c of newArr) {
    if (!oldById.has(c.id)) {
      if (c.terminalId !== myTerminal) return 'You can only register jobs at your own terminal.';
      if (!hasCap(authUser, profile, 'fen')) return 'You are not allowed to register a new job.';
      if (!validDate(c.eta)) return 'An ETA date is required to register a job.';
    }
  }
  for (const c of oldArr) {
    if (!newById.has(c.id)) {
      if (c.terminalId !== myTerminal) return 'You can only manage jobs at your own terminal.';
      if (dept !== 'Admin') return "Only your terminal's Admin can delete a job (" + c.containerNumber + '). Ask for the deletion instead.';
    }
  }

  let stageCache = null;
  for (const c of newArr) {
    const prev = oldById.get(c.id);
    if (!prev) continue;
    const changed = changedContainerKeys(prev, c);
    if (!changed.length) continue;
    if (prev.terminalId !== myTerminal || c.terminalId !== myTerminal) {
      return 'You can only manage jobs at your own terminal.';
    }
    for (const k of changed) {
      if (k === 'stageIdx') {
        if (stageCache === null) {
          const settings = await kvGet('platform-settings');
          const terminals = await kvGet('terminals');
          const mine = (Array.isArray(terminals) ? terminals : []).find(t => t.id === myTerminal);
          stageCache = {
            platform: (settings && settings.deptStageAccess) || {},
            own: (mine && mine.deptStageAccess) || {}
          };
        }
        const granted = profile && profile.grants && Array.isArray(profile.grants.stages) ? profile.grants.stages : null;
        const access = (dept === 'Admin')
          ? null // a terminal's Admin may set any stage
          : (granted || (Array.isArray(stageCache.own[dept]) ? stageCache.own[dept] : (stageCache.platform[dept] || DEFAULT_DEPT_STAGE_ACCESS[dept] || [])));
        const allowed = (access && dept === 'Accountant') ? access.concat([6, 7, 8, 9, 10, 11, 12, 13, 14]) : access;
        if (allowed && !allowed.includes(c[k]) && !allowed.includes(prev[k])) {
          return 'The ' + dept + ' department is not allowed to move ' + c.containerNumber + ' to that stage.';
        }
        continue;
      }
      if (k === 'exitNumber' && c[k] !== null && c[k] !== undefined && c[k] !== '' && !/^X \d{1,12}$/.test(String(c[k]))) {
        return 'The exit number must be the letter X, a space, then the number (for example X 1776).';
      }
      if (k === 'archived' && c[k]) {
        const a = c[k];
        if (typeof a !== 'object' || Array.isArray(a) || (profile && a.by !== profile.name) ||
            (a.reason !== undefined && a.reason !== null && (typeof a.reason !== 'string' || a.reason.length > 500))) {
          return 'Invalid archive record.';
        }
      }
      if ((k === 'returnDueDate' || k === 'leftTerminalDate' || k === 'returnedDate') && c[k] !== null && c[k] !== undefined && c[k] !== '') {
        const d = String(c[k]);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || isNaN(new Date(d + 'T00:00:00Z'))) return 'The ' + labelOf(k) + ' must be a valid date.';
      }
      if (k === 'deleteRequest') {
        const r = c[k];
        if (r) {
          if (!c.archived) return 'Only an archived job can have a deletion request.';
          if (typeof r !== 'object' || Array.isArray(r) || !profile || r.by !== profile.name ||
              (r.reason !== undefined && r.reason !== null && (typeof r.reason !== 'string' || r.reason.length > 300))) {
            return 'Invalid deletion request.';
          }
        } else if (prev.deleteRequest && c.archived && dept !== 'Admin' && (!profile || prev.deleteRequest.by !== profile.name)) {
          return 'Only the terminal Admin or the person who asked can cancel a deletion request.';
        }
      }
      if (k === 'progressNotes') {
        const err = checkNoteChanges(prev, c, authUser, profile);
        if (err) return err;
        continue;
      }
      if (k === 'financial' && !canSeeFinanceData(authUser, profile)) continue; // never shown to them; the server keeps the stored breakdown
      if (k === 'eta' && c[k] !== null && c[k] !== undefined && c[k] !== '' && !validDate(c[k])) return 'The ETA must be a valid date.';
      if (k === 'arrivedDate' && c[k]) {
        if (!validDate(c[k])) return 'The arrival date must be a valid date.';
        if (String(c[k]) > new Date(Date.now() + 36 * 3600 * 1000).toISOString().slice(0, 10)) return 'The arrival date cannot be in the future.';
      }
      if (k === 'arrivedBy' && c[k] && (!profile || c[k] !== profile.name)) return 'The vessel arrival must be recorded under your own name.';
      const cap = FIELD_CAPS[k];
      if (cap && !hasCap(authUser, profile, cap)) {
        return 'You are not allowed to change the ' + labelOf(k) + ' on ' + c.containerNumber + '.';
      }
    }
  }
  return null;
}

module.exports = {
  isUntouchedJob, changedContainerKeys, jobVisibleTo, canSeeStaffNotes, noteAudience, noteVisibleTo, canSeeFinanceData, hasCap,
  checkInvoiceAppend, CLIENT_DOC_TYPES, checkClientJobWrite, checkContainersWrite
};