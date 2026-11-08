const { deepEqual, isBlankVal, looseEqual } = require('../utils/compare');
const { kvGet } = require('../models/kv.model');
const { isSctl } = require('./role.policy');
const { FEN_BOL_DEPTS, DEFAULT_DEPT_STAGE_ACCESS, DERIVED_CONTAINER_KEYS } = require('../constants/stages');
const { labelOf, RESTRICTED_CONTAINER_FIELDS } = require('../constants/containerFields');

// A job counts as "untouched" while nothing but its registration exists. Only
// such a job may be permanently deleted; anything with work on it can only be archived.
function isUntouchedJob(c) {
  if ((c.stageIdx || 0) !== 0) return false;
  for (const k of ['documents', 'alerts', 'invoices', 'transportHistory', 'progressNotes', 'transporter', 'transferLetterNumber',
                   'invoiceNumber', 'exitNumber', 'aNumber', 'cNumber']) if (!isBlankVal(c[k])) return false;
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

function jobVisibleTo(user, profile, c) {
  if (user.role === 'sctl') return true;
  if (c.archived) return user.role === 'admin' && user.department === 'Admin' && c.terminalId === user.terminalId;
  if (user.role === 'customs') return true;                // read-only, across terminals
  if (c.terminalId !== user.terminalId) return false;      // everyone else: their own terminal only
  if (user.role === 'admin') return true;
  if (!profile) return false;
  if (user.role === 'importer') return c.owner === profile.name;
  if (user.role === 'agent') return c.agent === profile.name;
  return false;
}

function canSeeStaffNotes(user) { return !!user && (user.role === 'admin' || user.role === 'sctl'); }

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
function checkClientJobWrite(oldArr, newArr, profile) {
  const oldById = new Map(oldArr.map(c => [c.id, c]));
  if (newArr.length !== oldArr.length || newArr.some(c => !oldById.has(c.id))) return 'Importers and agents cannot add or remove jobs.';
  for (const c of newArr) {
    const prev = oldById.get(c.id);
    for (const k of changedContainerKeys(prev, c)) {
      if (k === 'deliveryLocation') continue;
      if (k === 'documents') continue; // checked in full by checkDocumentChanges
      if (k === 'invoices') { const err = checkInvoiceAppend(prev.invoices || [], c.invoices || [], profile); if (err) return err; continue; }
      return 'Importers and agents can only update the delivery location, upload invoices, and add a Bill of Lading, PAAR or Other document (not the ' + labelOf(k) + ' on ' + c.containerNumber + ').';
    }
  }
  return null;
}

// Checks a proposed write to the `containers` collection. SCTL bypasses
// entirely (including deleting). Every other staff account is scoped to its
// OWN terminal — a job at another terminal can't be touched at all — and the
// department rules are re-checked field by field. A terminal's Admin
// department may also delete a job at its own terminal.
async function checkContainersWrite(oldArr, newArr, authUser, profile) {
  oldArr = Array.isArray(oldArr) ? oldArr : [];
  if (!Array.isArray(newArr)) return 'Malformed container list.';
  if (!authUser) return 'Sign in required.';
  {
    // Nobody — not even the top role — may permanently delete a job that has work recorded on it.
    const keepIds = new Set(newArr.map(c => c.id));
    for (const c of oldArr) {
      if (!keepIds.has(c.id) && !isUntouchedJob(c)) {
        return 'Job ' + c.containerNumber + ' has work recorded on it, so it cannot be deleted. Archive it instead.';
      }
    }
  }
  if (isSctl(authUser)) {
    // SCTL oversees every terminal: it may look at any job but never change one. Only the terminal's own staff do that.
    const oldIds = new Set(oldArr.map(c => c.id));
    const sameSet = newArr.length === oldArr.length && newArr.every(c => oldIds.has(c.id));
    const oldById = new Map(oldArr.map(c => [c.id, c]));
    if (!sameSet || newArr.some(c => changedContainerKeys(oldById.get(c.id), c).length)) {
      return 'SCTL can view jobs but cannot change them. Only the bonded terminal\'s own staff can.';
    }
    return null;
  }
  if (authUser.role === 'importer' || authUser.role === 'agent') return checkClientJobWrite(oldArr, newArr, profile);
  if (authUser.role !== 'admin') return 'Only bonded terminal staff accounts can change job records.';

  const dept = authUser.department;
  const myTerminal = authUser.terminalId;
  const oldById = new Map(oldArr.map(c => [c.id, c]));
  const newById = new Map(newArr.map(c => [c.id, c]));

  for (const c of newArr) {
    if (!oldById.has(c.id)) {
      if (c.terminalId !== myTerminal) return 'You can only register jobs at your own terminal.';
      if (!FEN_BOL_DEPTS.includes(dept)) return 'Only Admin, Documentation, or DTI staff can register a new job.';
    }
  }
  for (const c of oldArr) {
    if (!newById.has(c.id)) {
      if (c.terminalId !== myTerminal) return 'You can only manage jobs at your own terminal.';
      if (dept !== 'Admin') return "Only your terminal's Admin department can delete a job (" + c.containerNumber + ').';
    }
  }

  let stageAccessCache = null;
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
        if (stageAccessCache === null) {
          const settings = await kvGet('platform-settings');
          stageAccessCache = (settings && settings.deptStageAccess) || {};
        }
        const access = (dept === 'Admin')
          ? null // a terminal's Admin may set any stage, matching the app's own rule for that role
          : (stageAccessCache[dept] || DEFAULT_DEPT_STAGE_ACCESS[dept] || []);
        if (access && !access.includes(c[k]) && !access.includes(prev[k])) {
          return 'The ' + dept + ' department is not allowed to move ' + c.containerNumber + ' to that stage.';
        }
        continue;
      }
      const allowedDepts = RESTRICTED_CONTAINER_FIELDS[k];
      if (allowedDepts && !allowedDepts.includes(dept)) {
        return 'The ' + dept + ' department is not allowed to change the ' + labelOf(k) + ' on ' + c.containerNumber + '.';
      }
    }
  }
  return null;
}

module.exports = {
  isUntouchedJob, changedContainerKeys, jobVisibleTo, canSeeStaffNotes,
  checkInvoiceAppend, CLIENT_DOC_TYPES, checkClientJobWrite, checkContainersWrite
};