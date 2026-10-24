// ConTracker backend — real auth, real shared database, real-time multi-device
// sync, with multi-tenant (multi-bonded-terminal) authorization.
//
// Same design as the Belburge backend (see its server.js for the longer
// explanation): the frontend's handful of named JSON blobs (containers,
// users, terminals, activity-log, referrals, messages, settings) are kept as
// one row per collection in `kv_store`, backed by real Postgres instead of a
// browser's localStorage. Real authentication (bcrypt + JWT) sits in front of
// everything, and the two most sensitive collections — `users` and
// `terminals` — get real, structural authorization checks:
//   - SCTL (the platform super-admin) can do anything, anywhere.
//   - A terminal's own Admin-department account can manage accounts AT THEIR
//     OWN terminal (add, edit, suspend, remove), but the check is enforced
//     here by diffing old vs. new and rejecting any change that touches a
//     different terminal's account.
//   - Everyone else (importer, agent, customs, ordinary staff) can only ever
//     change their own profile record.
//   - Only SCTL may add, edit, or remove bonded terminals, except for the one
//     unauthenticated case every new terminal starts from: a terminal
//     self-registering (pending SCTL approval).
//   - `containers` is both terminal-scoped (an account can only ever touch a
//     job at its own terminal) and department/stage-checked field-by-field
//     (who may register a new job, advance which stage, set the transfer
//     letter / invoice / exit numbers, record a transporter, or touch
//     invoices) — the same rules the UI uses to hide buttons, re-checked here
//     so a modified client or a direct API call can't bypass them.

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');
const http = require('http');
const { WebSocketServer } = require('ws');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 4000;
const JWT_SECRET = process.env.JWT_SECRET;
const DATABASE_URL = process.env.DATABASE_URL;

if (!JWT_SECRET) {
  console.error('JWT_SECRET is not set. Set it to a long random string before starting the server.');
  process.exit(1);
}
if (!DATABASE_URL) {
  console.error('DATABASE_URL is not set. Point it at your Postgres database before starting the server.');
  process.exit(1);
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: process.env.PGSSLMODE === 'disable' ? false : { rejectUnauthorized: false }
});

async function initSchema() {
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await pool.query(sql);
  console.log('Schema ready.');
}

const app = express();
app.use(helmet());
app.use(cors({ origin: true })); // the frontend is a static file that can be opened from anywhere; restrict this later if you host it at a fixed domain
app.use(express.json({ limit: '25mb' })); // user ID photos / profile pictures are embedded as base64 data URLs

// ---------- auth helpers ----------
function signToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '12h' });
}
function authOptional(req) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return null;
  try { return jwt.verify(token, JWT_SECRET); } catch (e) { return null; }
}
function authRequired(req, res, next) {
  const user = authOptional(req);
  if (!user) return res.status(401).json({ error: 'Sign in required.' });
  req.user = user;
  next();
}
function isSctl(user) { return !!user && user.role === 'sctl'; }
function isTerminalAdmin(user) { return !!user && user.role === 'admin' && user.department === 'Admin' && !!user.terminalId; }

// ---------- kv_store helpers ----------
async function kvGet(key) {
  const r = await pool.query('SELECT value FROM kv_store WHERE key=$1', [key]);
  return r.rows.length ? r.rows[0].value : null;
}
async function kvSet(key, value) {
  await pool.query(
    `INSERT INTO kv_store (key, value, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (key) DO UPDATE SET value=$2, updated_at=now()`,
    [key, JSON.stringify(value)]
  );
}

// Order-independent deep-equal for plain JSON values — see Belburge's server.js
// for why a naive JSON.stringify comparison is not safe here.
function deepEqual(a, b) {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i])) return false;
    return true;
  }
  const aKeys = Object.keys(a), bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  for (const k of aKeys) {
    if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
    if (!deepEqual(a[k], b[k])) return false;
  }
  return true;
}


// ---- policy: ConTracker ----
function isStaffUser(u) { return !!u && (u.role === 'admin' || u.role === 'sctl'); }
function isTopUser(u) { return isSctl(u); }
function logVisibleTo(user, e) {
  if (isSctl(user)) return true;
  return user.role === 'admin' && e.terminalId === user.terminalId;
}
function userVisibleTo(user, u) {
  if (isSctl(user) || u.id === user.id) return true;
  return user.role === 'admin' && u.terminalId === user.terminalId;
}
function canSeeIdImage(user, u) {
  return isSctl(user) || u.id === user.id || (user.role === 'admin' && user.department === 'Admin' && u.terminalId === user.terminalId);
}
function referralVisibleTo(user, profile, r) { return isSctl(user) || (!!profile && r.referrerName === profile.name); }
function canEditReferralStatus(user) { return isSctl(user); }
function channelAllowed(user, profile, channel, m) {
  if (typeof channel !== 'string') return false;
  if (isSctl(user)) return true;
  if (channel.startsWith('internal:')) return user.role === 'admin' && channel.slice(9) === user.terminalId;
  if (channel.startsWith('customs:')) return user.role === 'customs' || (user.role === 'admin' && channel.slice(8) === user.terminalId);
  if (channel.startsWith('client:')) {
    if (user.role === 'admin') return !m || !m.terminalId || m.terminalId === user.terminalId;
    return !!profile && (user.role === 'importer' || user.role === 'agent') && profile.name === channel.slice(7);
  }
  return false;
}
function stampTerminal(e, user) { return isSctl(user) ? e : Object.assign({}, e, { terminalId: user.terminalId || null }); }

/* ================= Scoped reads and merged writes: users, activity log, referrals, messages =================
   Same idea as the jobs: nobody is sent records they have no business seeing, and every save is merged
   back into the full stored list, so a limited view can never delete or overwrite what it could not see. */
const LOG_DEPTS = ['Admin', 'Documentation', 'DTI', 'Operations', 'Transport', 'Field Staff', 'Accountant'];
const USER_DEFAULTS = { stationedAt: 'BILBT Main Yard', status: 'active' };
const SERVER_OWNED_USER_KEYS = new Set(['lastLoginDate', 'lastLoginDevice']); // written by the server at sign-in; a screen's copy may be a little stale
function sameUserRecord(a, b) {
  if (deepEqual(a, b)) return true;
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (SERVER_OWNED_USER_KEYS.has(k)) continue;
    if (looseEqual(a[k], b[k], k)) continue;
    if ((a[k] === undefined || a[k] === null) && (k === 'uniqueId' || USER_DEFAULTS[k] === b[k])) continue; // the app fills these in when it loads an old record
    return false;
  }
  return true;
}
function redactUserFor(user, u) {
  if (canSeeIdImage(user, u) || !u.idImage) return u;
  return Object.assign({}, u, { idImage: null });
}
// A save only removes something when the app says so explicitly ({deleted:[ids]}) — or a top-level admin
// replaces everything on purpose ({replace:true}, used by "reset demo data"). A list that is merely missing
// an item (because the person's screen was a second out of date) never deletes it.
function wantsReplace(body, user) { return !!body && body.replace === true && isTopUser(user); }
function restoreUndeleted(view, parsed, body, user) {
  if (wantsReplace(body, user)) return parsed;
  const del = new Set(Array.isArray(body && body.deleted) ? body.deleted.filter(x => typeof x === 'string') : []);
  const present = new Set(parsed.map(x => x.id));
  return parsed.concat(view.filter(v => !present.has(v.id) && !del.has(v.id)));
}
// Concurrent edits: every job / account carries a version number (_v) that only the server changes. The app tells
// the server which records it really edited ({changed:[ids]}). Records it did not edit are left exactly as stored
// (so a stale screen can never overwrite them), and an edited record whose version is out of date is refused
// with a clear message instead of silently overwriting someone else's change.
function changedIdSet(body, parsed) {
  return Array.isArray(body && body.changed) ? new Set(body.changed.filter(x => typeof x === 'string')) : new Set(parsed.map(x => x.id));
}
function applyChangedOnly(view, parsed, changed) {
  const viewMap = new Map(view.map(x => [x.id, x]));
  return parsed.map(n => (viewMap.has(n.id) && !changed.has(n.id)) ? viewMap.get(n.id) : n);
}
function findStale(view, parsed, changed) {
  const viewMap = new Map(view.map(x => [x.id, x]));
  return parsed.find(n => changed.has(n.id) && viewMap.has(n.id) && (n._v || 0) !== (viewMap.get(n.id)._v || 0));
}
function conflictMessage(what) {
  return what + ' was changed by someone else a moment ago, so your change was NOT saved. Your screen now shows the latest version — please make your change again.';
}
function messageVisibleTo(user, profile, m) { return channelAllowed(user, profile, m.channel, m); }
function validList(parsed) { return Array.isArray(parsed) && parsed.every(x => x && typeof x === 'object' && typeof x.id === 'string'); }
async function scopedView(key, user, full) {
  const profile = await profileOf(user);
  if (key === 'users') return full.filter(u => userVisibleTo(user, u)).map(u => redactUserFor(user, u));
  if (key === 'activity-log') return full.filter(e => logVisibleTo(user, e));
  if (key === 'referrals') return full.filter(r => referralVisibleTo(user, profile, r));
  return full.filter(m => messageVisibleTo(user, profile, m)); // messages
}
function mergeUsers(full, view, parsed, user) {
  const visible = new Set(view.map(u => u.id)), fullIds = new Set(full.map(u => u.id));
  const incoming = new Map(parsed.map(u => [u.id, u]));
  const out = [];
  for (const c of full) {
    if (!visible.has(c.id)) { out.push(c); continue; }
    const n = incoming.get(c.id);
    if (!n) continue;
    const keep = {};
    for (const k of SERVER_OWNED_USER_KEYS) if (c[k] !== undefined) keep[k] = c[k];
    const merged = Object.assign({}, n, keep);
    merged._v = sameUserRecord(c, merged) ? (c._v || 0) : (c._v || 0) + 1;
    out.push(canSeeIdImage(user, c) ? merged : Object.assign({}, merged, { idImage: c.idImage === undefined ? null : c.idImage }));
  }
  for (const n of parsed) if (!fullIds.has(n.id)) out.push(Object.assign({}, n, { _v: 1 }));
  return out;
}
function mergeAck(stored, inc) {
  const ack = Array.isArray(stored.ack) ? stored.ack.slice() : [];
  if (Array.isArray(inc.ack)) for (const a of inc.ack) if (typeof a === 'string' && !ack.includes(a)) ack.push(a);
  return Object.assign({}, stored, { ack });
}
function mergeLog(full, parsed, user, replace, profile) {
  const stored = new Map(full.map(e => [e.id, e]));
  const incoming = new Map(parsed.map(e => [e.id, e]));
  const fresh = parsed.filter(e => !stored.has(e.id)).map(e => stampTerminal({
    id: e.id, msg: String(e.msg == null ? '' : e.msg).slice(0, 2000),
    t: isNaN(new Date(e.t)) ? new Date().toISOString() : e.t,
    dept: typeof e.dept === 'string' ? e.dept : null, ack: [], security: !!e.security,
    terminalId: e.terminalId === undefined ? null : e.terminalId
  }, user));
  if (!isStaffUser(user)) {   // importers / agents / customs: limited, and always labelled with their real name
    const label = (user.role || 'user') + ' ' + ((profile && profile.name) || 'unknown');
    fresh.splice(5);
    for (let i = 0; i < fresh.length; i++) {
      fresh[i] = Object.assign({}, fresh[i], { msg: '[' + label + '] ' + String(fresh[i].msg).slice(0, 300), security: false,
        dept: LOG_DEPTS.includes(fresh[i].dept) ? fresh[i].dept : null });
    }
  }
  let kept;
  if (replace) kept = full.filter(e => incoming.has(e.id)).map(e => mergeAck(e, incoming.get(e.id)));
  else kept = full.map(e => (logVisibleTo(user, e) && incoming.has(e.id)) ? mergeAck(e, incoming.get(e.id)) : e); // nobody else can delete history
  return fresh.concat(kept).slice(0, 1000);
}
function checkAndMergeReferrals(full, parsed, user, profile, body) {
  const view = full.filter(r => referralVisibleTo(user, profile, r));
  parsed = restoreUndeleted(view, parsed, body, user);
  const visible = new Set(view.map(r => r.id)), fullIds = new Set(full.map(r => r.id));
  if (parsed.some(r => fullIds.has(r.id) && !visible.has(r.id))) return { error: 'One of those referrals belongs to someone else.' };
  const incoming = new Map(parsed.map(r => [r.id, r]));
  for (const r of view) {
    const n = incoming.get(r.id);
    if (!n) { if (!isTopUser(user)) return { error: 'Referrals cannot be deleted.' }; continue; }
    if (deepEqual(r, n)) continue;
    const keys = new Set([...Object.keys(r), ...Object.keys(n)]);
    for (const k of keys) {
      if (deepEqual(r[k], n[k])) continue;
      if (k === 'status' && canEditReferralStatus(user)) continue;
      return { error: 'You are not allowed to change that referral.' };
    }
  }
  for (const n of parsed) {
    if (fullIds.has(n.id)) continue;
    if (!profile || n.referrerName !== profile.name) return { error: 'A referral must be submitted under your own name.' };
    if (n.status !== 'pending') return { error: 'A new referral must start as pending.' };
  }
  const out = [];
  for (const c of full) {
    if (!visible.has(c.id)) { out.push(c); continue; }
    const n = incoming.get(c.id);
    if (!n) continue;
    out.push(canEditReferralStatus(user) ? Object.assign({}, c, { status: n.status }) : c);
  }
  for (const n of parsed) if (!fullIds.has(n.id)) out.push(n);
  return { merged: out };
}
function checkAndMergeMessages(full, parsed, user, profile, body) {
  const view = full.filter(m => messageVisibleTo(user, profile, m));
  parsed = restoreUndeleted(view, parsed, body, user);
  const visible = new Set(view.map(m => m.id)), fullIds = new Set(full.map(m => m.id));
  if (parsed.some(m => fullIds.has(m.id) && !visible.has(m.id))) return { error: 'One of those messages belongs to a conversation you are not in.' };
  const incoming = new Map(parsed.map(m => [m.id, m]));
  for (const m of view) {
    const n = incoming.get(m.id);
    if (!n) { if (!isTopUser(user)) return { error: 'Messages cannot be deleted.' }; continue; }
    if (!deepEqual(m, n) && !isTopUser(user)) return { error: 'Messages cannot be edited.' };
  }
  const added = [];
  for (const n of parsed) {
    if (fullIds.has(n.id)) continue;
    if (!profile || n.from !== profile.name) return { error: 'A message must be sent under your own name.' };
    if (!channelAllowed(user, profile, n.channel, null)) return { error: 'You are not part of that conversation.' };
    added.push(stampTerminal(n, user));
  }
  const out = [];
  for (const c of full) {
    if (!visible.has(c.id)) { out.push(c); continue; }
    const n = incoming.get(c.id);
    if (!n) continue;
    out.push(isTopUser(user) ? n : c);
  }
  return { merged: out.concat(added) };
}

function checkUsersWrite(oldArr, newArr, authUser) {
  oldArr = Array.isArray(oldArr) ? oldArr : [];
  if (!Array.isArray(newArr)) return 'Malformed user list.';

  if (!authUser) {
    // Only unauthenticated path allowed: self-registration appending exactly
    // one new pending account (importer, agent, staff, or customs officer),
    // with every existing account left untouched.
    if (newArr.length !== oldArr.length + 1) return 'Sign in required.';
    const oldById = new Map(oldArr.map(u => [u.id, u]));
    for (const u of newArr) {
      if (oldById.has(u.id) && !deepEqual(oldById.get(u.id), u)) return 'Sign in required.';
    }
    const added = newArr.find(u => !oldById.has(u.id));
    if (!added || added.status !== 'pending_verification') return 'Sign in required.';
    return null;
  }

  if (isSctl(authUser)) return null; // SCTL can do anything

  const oldById = new Map(oldArr.map(u => [u.id, u]));
  const newById = new Map(newArr.map(u => [u.id, u]));

  if (isTerminalAdmin(authUser)) {
    // May add, edit, suspend, or remove accounts at their OWN terminal only.
    // Any touched record (added, removed, or changed) must belong to it.
    const allIds = new Set([...oldById.keys(), ...newById.keys()]);
    for (const id of allIds) {
      const oldU = oldById.get(id), newU = newById.get(id);
      if (oldU && newU && sameUserRecord(oldU, newU)) continue; // unchanged
      const belongsToMyTerminal = (oldU && oldU.terminalId === authUser.terminalId) || (newU && newU.terminalId === authUser.terminalId);
      if (!belongsToMyTerminal) return 'You can only manage accounts at your own terminal.';
    }
    return null;
  }

  // Everyone else: may only ever change their own record, no add/remove.
  if (newArr.length !== oldArr.length) return 'You do not have permission to add or remove accounts.';
  for (const [id, newU] of newById) {
    const oldU = oldById.get(id);
    if (!oldU) return 'You do not have permission to add or remove accounts.';
    if (!sameUserRecord(oldU, newU) && id !== authUser.id) return 'You can only update your own profile.';
  }
  return null;
}

// ---------- container department/stage permission rules ----------
// Mirrors the frontend's own constants and canEditTransferLetter /
// canEditInvoiceNumber / canEditTransporter / canEditExitNumber / myScopeMatches
// functions in contracker.html, so a modified client or direct API call can't
// bypass either the per-terminal scoping or the department/stage rules the UI
// only enforced by hiding buttons.
const FEN_BOL_DEPTS = ['Admin', 'Documentation', 'DTI'];
const FINANCE_DEPTS = ['Admin', 'Accountant'];
const DEFAULT_DEPT_STAGE_ACCESS = {
  Documentation: [], DTI: [], 'Field Staff': [0, 1, 2, 3, 4, 5, 6, 7, 8],
  Operations: [9, 10, 11, 12], Transport: [13, 14], Accountant: []
};
const DERIVED_CONTAINER_KEYS = new Set(['duplicateFlag']); // computed by the app on load, not real edits
function isBlankVal(v) {
  return v === undefined || v === null || v === 0 || v === false || v === '' ||
    (Array.isArray(v) && v.length === 0) ||
    (typeof v === 'object' && !Array.isArray(v) && Object.values(v).every(isBlankVal));
}
// Equal once the app's own empty defaults are ignored. The app fills in empty
// values (null / 0 / false / [] and a 'pending' duty status) when it loads a
// job, so "missing" and "empty" must not count as someone editing the job.
function looseEqual(a, b, key) {
  if (deepEqual(a, b)) return true;
  if (isBlankVal(a) && isBlankVal(b)) return true;
  if (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)) {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) if (!looseEqual(a[k], b[k], k)) return false;
    return true;
  }
  if ((a === undefined || a === null) && key === 'dutyStatus' && b === 'pending') return true;
  return false;
}

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
const FIELD_LABELS = {
  transferLetterNumber: 'transfer letter number', invoiceNumber: 'invoice / charge number', transporter: 'transporter details',
  transportHistory: 'transporter history', exitNumber: 'exit number', invoices: 'invoices', bolComplete: 'Book of Life status',
  archived: 'archived status', aNumber: 'A-Number', cNumber: 'C-Number', containerNumber: 'container number', billOfLading: 'Bill of Lading',
  size: 'container size', item: 'cargo description', destination: 'destination'
};
const labelOf = k => FIELD_LABELS[k] || k;
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
// Duplicate registrations across terminals are worked out here, where every terminal's jobs are visible,
// and sent to each terminal as a flag (terminal names only — never the other terminal's job).
async function withDuplicateFlags(full, view) {
  const terminals = (await kvGet('terminals')) || [];
  const nameOf = id => (terminals.find(t => t.id === id) || {}).name || 'another terminal';
  const groups = {};
  for (const c of full) {
    if (c.archived) continue;
    for (const [kind, val] of [['cnum', c.containerNumber], ['bol', c.billOfLading]]) {
      if (!val) continue;
      const key = kind + ':' + String(val).toUpperCase();
      (groups[key] = groups[key] || []).push(c);
    }
  }
  const flags = new Map();
  for (const group of Object.values(groups)) {
    if (new Set(group.map(c => c.terminalId)).size < 2) continue;
    for (const c of group) {
      const others = group.filter(x => x.terminalId !== c.terminalId);
      const prev = flags.get(c.id);
      const names = [...new Set(others.map(o => nameOf(o.terminalId)))];
      flags.set(c.id, { terminalNames: prev ? [...new Set(prev.terminalNames.concat(names))] : names, otherIds: [] });
    }
  }
  return view.map(c => flags.has(c.id) ? Object.assign({}, c, { duplicateFlag: flags.get(c.id) }) : Object.assign({}, c, { duplicateFlag: null }));
}

/* ================= Who may see which jobs (enforced on every read and write) =================
   The server never sends a person a job they have no business seeing, and strips staff-only
   comments from anyone who is not staff. Writes are merged back into the full stored list, so
   a limited view can never wipe out jobs or comments that person could not see. */
async function profileOf(user) {
  const users = (await kvGet('users')) || [];
  return users.find(u => u.id === user.id) || null;
}
function canSeeStaffNotes(user) { return !!user && (user.role === 'admin' || user.role === 'sctl'); }
function redactJobFor(user, c) {
  if (canSeeStaffNotes(user) || !Array.isArray(c.progressNotes) || !c.progressNotes.some(n => n && n.staffOnly)) return c;
  return Object.assign({}, c, { progressNotes: c.progressNotes.filter(n => !(n && n.staffOnly)) });
}
async function containersViewFor(user, full) {
  const profile = await profileOf(user);
  const view = full.filter(c => jobVisibleTo(user, profile, c)).map(c => redactJobFor(user, c));
  return { profile, view: await withDuplicateFlags(full, view) };
}
function stripDerived(c) {
  const o = Object.assign({}, c);
  for (const k of DERIVED_CONTAINER_KEYS) delete o[k];
  return o;
}
function mergeContainers(full, oldView, parsed, user) {
  const visibleIds = new Set(oldView.map(c => c.id));
  const fullIds = new Set(full.map(c => c.id));
  const incoming = new Map(parsed.map(c => [c.id, c]));
  const out = [];
  for (const c of full) {
    if (!visibleIds.has(c.id)) { out.push(c); continue; }   // not theirs: untouched
    const n = incoming.get(c.id);
    if (!n) continue;                                          // deleted (already permission-checked)
    const next = stripDerived(n);
    next._v = changedContainerKeys(c, next).filter(k => k !== '_v').length ? (c._v || 0) + 1 : (c._v || 0);
    if (!canSeeStaffNotes(user)) {                             // put back staff-only comments they never saw
      const hidden = (c.progressNotes || []).filter(x => x && x.staffOnly);
      if (hidden.length) {
        const keep = next.progressNotes || [];
        next.progressNotes = keep.concat(hidden.filter(h => !keep.some(k => k && k.id && k.id === h.id)))
          .sort((a, b) => new Date(a.date || 0) - new Date(b.date || 0));
      }
    }
    out.push(next);
  }
  for (const n of parsed) if (!fullIds.has(n.id)) out.push(Object.assign(stripDerived(n), { _v: 1 }));
  return out;
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

const RESTRICTED_CONTAINER_FIELDS = {
  transferLetterNumber: ['Documentation', 'Operations', 'Admin'],
  invoiceNumber: ['Accountant', 'DTI', 'Operations', 'Admin'],
  transporter: ['Documentation', 'DTI', 'Transport', 'Admin'],
  transportHistory: ['Documentation', 'DTI', 'Transport', 'Admin'],
  exitNumber: ['Operations', 'Admin'],
  invoices: FINANCE_DEPTS,
  archived: ['Admin'],
  bolComplete: FEN_BOL_DEPTS,
  aNumber: FEN_BOL_DEPTS,
  cNumber: FEN_BOL_DEPTS,
  // Job identity details (fixing a mistyped container number etc.)
  containerNumber: FEN_BOL_DEPTS,
  billOfLading: FEN_BOL_DEPTS,
  size: FEN_BOL_DEPTS,
  item: FEN_BOL_DEPTS,
  destination: FEN_BOL_DEPTS
};

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
  if (isSctl(authUser)) return null;
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

function checkTerminalsWrite(oldArr, newArr, authUser) {
  oldArr = Array.isArray(oldArr) ? oldArr : [];
  if (!Array.isArray(newArr)) return 'Malformed terminal list.';
  if (!authUser) {
    // Only unauthenticated path: a brand-new bonded terminal self-registering
    // (pending SCTL approval), appending exactly one new pending terminal.
    if (newArr.length !== oldArr.length + 1) return 'Sign in required.';
    const oldById = new Map(oldArr.map(t => [t.id, t]));
    for (const t of newArr) {
      if (oldById.has(t.id) && !deepEqual(oldById.get(t.id), t)) return 'Sign in required.';
    }
    const added = newArr.find(t => !oldById.has(t.id));
    if (!added || added.status !== 'pending') return 'Sign in required.';
    return null;
  }
  if (isSctl(authUser)) return null;
  return 'Only SCTL can manage bonded terminals.';
}

// ---------- WebSocket: live push so every open screen updates within ~1s ----------
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });
const sockets = new Set();

wss.on('connection', (ws, req) => {
  try {
    const url = new URL(req.url, 'http://x');
    const token = url.searchParams.get('token');
    jwt.verify(token, JWT_SECRET);
  } catch (e) {
    ws.close(4001, 'Unauthorized');
    return;
  }
  sockets.add(ws);
  ws.on('close', () => sockets.delete(ws));
});

function broadcastChanged(key) {
  const msg = JSON.stringify({ type: 'changed', key });
  for (const ws of sockets) {
    if (ws.readyState === 1) ws.send(msg);
  }
}

// ---------- routes ----------
/* ================= Stored files + document rules =================
   Uploaded documents and invoices are kept as real files in the database (table `files`), not just
   as a filename. A job's document only points at the file (fileId); who may download it is decided
   from the job, the same way the job itself is shown. Staff can reject a document the importer or
   agent sent (with a reason), upload the right one on their behalf, and the importer or agent can
   upload a corrected one against the rejected document. All of it is enforced here. */
const FILE_MAX_BYTES = 10 * 1024 * 1024;
const FILE_TYPES = {
  pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp',
  doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  csv: 'text/csv', txt: 'text/plain'
};
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
async function fileMeta(id) {
  if (typeof id !== 'string' || id.length > 80) return null;
  const r = await pool.query('SELECT id, name, mime, size, uploaded_by FROM files WHERE id=$1', [id]);
  return r.rows[0] || null;
}

app.post('/api/files', authRequired, express.raw({ type: () => true, limit: FILE_MAX_BYTES + 1024 }), async (req, res) => {
  const name = String(req.query.name || '').replace(/[\\/\0]/g, '_').trim().slice(0, 200);
  const ext = fileExtOf(name);
  const body = req.body;
  if (!name) return res.status(400).json({ error: 'The file needs a name.' });
  if (!FILE_TYPES[ext]) return res.status(400).json({ error: 'That file type is not allowed. Use PDF, an image (PNG, JPG, WEBP), Word, Excel, CSV or text.' });
  if (!Buffer.isBuffer(body) || body.length === 0) return res.status(400).json({ error: 'That file is empty.' });
  if (body.length > FILE_MAX_BYTES) return res.status(413).json({ error: 'That file is larger than 10 MB.' });
  if (!looksLikeType(ext, body)) return res.status(400).json({ error: 'That file does not look like a real .' + ext + ' file.' });
  const id = crypto.randomUUID();
  await pool.query(
    'INSERT INTO files (id, name, mime, size, data, uploaded_by) VALUES ($1,$2,$3,$4,$5,$6)',
    [id, name, FILE_TYPES[ext], body.length, body, req.user.id]
  );
  res.json({ id, name, mime: FILE_TYPES[ext], size: body.length });
});

app.get('/api/files/:id', authRequired, async (req, res) => {
  const r = await pool.query('SELECT id, name, mime, size, data, uploaded_by FROM files WHERE id=$1', [String(req.params.id).slice(0, 80)]);
  if (!r.rows.length) return res.status(404).json({ error: 'That file was not found.' });
  const f = r.rows[0];
  let ok = f.uploaded_by === req.user.id;
  if (!ok) {
    const profile = await profileOf(req.user);
    const full = (await kvGet('containers')) || [];
    const msgs = (await kvGet('messages')) || [];
    ok = msgs.some(m => m && m.fileId === f.id && channelAllowed(req.user, profile, m.channel, m));
    if (!ok) ok = full.some(c => jobVisibleTo(req.user, profile, c) &&
      ((c.documents || []).some(d => d && d.fileId === f.id) || (c.invoices || []).some(i => i && i.fileId === f.id)));
  }
  if (!ok) return res.status(403).json({ error: 'You do not have access to that file.' });
  const ascii = f.name.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '');
  res.set({
    'Content-Type': f.mime,
    'Content-Length': String(f.data.length),
    'Content-Disposition': `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(f.name)}`,
    'Cache-Control': 'private, no-store'
  });
  res.end(f.data);
});

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

async function cleanupOrphanFiles() {
  try {
    const full = await kvGet('containers');
    if (!Array.isArray(full)) return;
    const used = new Set();
    for (const m of ((await kvGet('messages')) || [])) if (m && m.fileId) used.add(m.fileId);
    for (const c of full) {
      for (const d of (c.documents || [])) if (d && d.fileId) used.add(d.fileId);
      for (const i of (c.invoices || [])) if (i && i.fileId) used.add(i.fileId);
    }
    const r = await pool.query("SELECT id FROM files WHERE created_at < now() - interval '1 day'");
    const gone = r.rows.map(x => x.id).filter(id => !used.has(id));
    if (gone.length) await pool.query('DELETE FROM files WHERE id = ANY($1)', [gone]);
  } catch (e) { console.error('file cleanup failed:', e.message); }
}

app.get('/api/health', (req, res) => res.json({ ok: true }));

// Two modes:
//  - With `profile`: public self-registration. The server itself appends the
//    new PENDING profile (and, for a brand-new bonded terminal, the pending
//    terminal) to the shared collections — the browser can't do this safely
//    because before sign-in it has no copy of the user roster to add to. The
//    password hash, profile and terminal are saved together or not at all.
//  - Without `profile`: credentials only, used when a signed-in terminal
//    Admin creates a staff account and then saves it with their own session.
app.post('/api/auth/register', async (req, res) => {
  const { id, email, password, profile, newTerminal } = req.body || {};
  if (!id || !email || !password) return res.status(400).json({ error: 'id, email and password are required.' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  const mail = String(email).toLowerCase();

  if (!profile) {
    const existing = await pool.query('SELECT 1 FROM credentials WHERE email=$1', [mail]);
    if (existing.rows.length) return res.status(409).json({ error: 'That email is already registered. Try signing in.' });
    const hash = await bcrypt.hash(password, 10);
    await pool.query('INSERT INTO credentials (email, password_hash, user_id) VALUES ($1,$2,$3)', [mail, hash, id]);
    return res.json({ ok: true });
  }

  if (typeof profile !== 'object' || Array.isArray(profile)) return res.status(400).json({ error: 'Malformed profile.' });
  if (!['importer', 'agent', 'admin', 'customs'].includes(profile.role)) return res.status(400).json({ error: 'Invalid account type.' });
  const hash = await bcrypt.hash(password, 10);
  const client = await pool.connect();
  let terminalsChanged = false;
  try {
    await client.query('BEGIN');
    const usersRow = await client.query('SELECT value FROM kv_store WHERE key=$1 FOR UPDATE', ['users']);
    if (!usersRow.rows.length) {
      await client.query('ROLLBACK');
      return res.status(503).json({ error: 'The server has not been set up yet. Reload the app once and try again.' });
    }
    const users = usersRow.rows[0].value || [];
    if (users.some(u => String(u.login || '').toLowerCase() === mail)) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'That email is already registered. Try signing in.' });
    }
    const termRow = await client.query('SELECT value FROM kv_store WHERE key=$1 FOR UPDATE', ['terminals']);
    const terminals = termRow.rows.length ? (termRow.rows[0].value || []) : [];

    let terminalId = profile.role === 'customs' ? null : (profile.terminalId || null);
    if (newTerminal) {
      if (profile.role === 'customs' || !newTerminal.name || !newTerminal.address) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'A new terminal needs a name and an address.' });
      }
      const tid = newTerminal.id || ('t' + Date.now());
      terminals.push({ id: tid, name: String(newTerminal.name).trim(), address: String(newTerminal.address).trim(), status: 'pending', registeredDate: new Date().toISOString() });
      terminalId = tid;
      terminalsChanged = true;
    } else if (profile.role !== 'customs' && !terminals.some(t => t.id === terminalId && t.status === 'active')) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Choose an active bonded terminal.' });
    }

    // A password row with no matching profile is left over from an earlier
    // sign-up attempt that failed half-way; replace it instead of blocking.
    await client.query('DELETE FROM credentials WHERE email=$1', [mail]);
    await client.query('INSERT INTO credentials (email, password_hash, user_id) VALUES ($1,$2,$3)', [mail, hash, id]);
    const clean = Object.assign({}, profile, { id, login: String(email).trim(), terminalId, status: 'pending_verification', verifiedBy: null, verifiedDate: null });
    delete clean.password;
    users.push(clean);
    const upsert = `INSERT INTO kv_store (key, value, updated_at) VALUES ($1, $2, now())
                    ON CONFLICT (key) DO UPDATE SET value=$2, updated_at=now()`;
    await client.query(upsert, ['users', JSON.stringify(users)]);
    if (terminalsChanged) await client.query(upsert, ['terminals', JSON.stringify(terminals)]);
    await client.query('COMMIT');
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    console.error('register failed:', e);
    return res.status(500).json({ error: 'Could not save your registration. Please try again.' });
  } finally {
    client.release();
  }
  broadcastChanged('users');
  if (terminalsChanged) broadcastChanged('terminals');
  res.json({ ok: true });
});

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Email and password are required.' });
  const r = await pool.query('SELECT password_hash, user_id FROM credentials WHERE email=$1', [email.toLowerCase()]);
  if (!r.rows.length) return res.status(401).json({ error: 'No matching account. Check the email and password.' });
  const ok = await bcrypt.compare(password, r.rows[0].password_hash);
  if (!ok) return res.status(401).json({ error: 'No matching account. Check the email and password.' });
  const userId = r.rows[0].user_id;
  const users = (await kvGet('users')) || [];
  const profile = users.find(u => u.id === userId);
  if (!profile) return res.status(401).json({ error: 'Account record not found.' });
  const token = signToken({
    id: profile.id, email: email.toLowerCase(), role: profile.role,
    department: profile.department || null, terminalId: profile.terminalId || null
  });
  res.json({ token, userId: profile.id });
});

app.post('/api/auth/set-password', authRequired, async (req, res) => {
  const { email, newPassword } = req.body || {};
  if (!email || !newPassword) return res.status(400).json({ error: 'email and newPassword are required.' });
  if (newPassword.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  const existing = await pool.query('SELECT user_id FROM credentials WHERE email=$1', [email.toLowerCase()]);
  if (!existing.rows.length) return res.status(404).json({ error: 'No account with that email.' });

  let allowed = req.user.email === email.toLowerCase() || isSctl(req.user);
  if (!allowed && isTerminalAdmin(req.user)) {
    const users = (await kvGet('users')) || [];
    const target = users.find(u => u.id === existing.rows[0].user_id);
    allowed = !!target && target.terminalId === req.user.terminalId;
  }
  if (!allowed) return res.status(403).json({ error: 'You do not have permission to reset this account’s password.' });

  const hash = await bcrypt.hash(newPassword, 10);
  await pool.query('UPDATE credentials SET password_hash=$1, updated_at=now() WHERE email=$2', [hash, email.toLowerCase()]);
  res.json({ ok: true });
});

app.post('/api/auth/reset-seed-credentials', authRequired, async (req, res) => {
  if (!isSctl(req.user)) return res.status(403).json({ error: 'Only SCTL can reset demo data.' });
  const { accounts } = req.body || {};
  if (!Array.isArray(accounts)) return res.status(400).json({ error: 'accounts[] is required.' });
  await pool.query('DELETE FROM credentials');
  for (const a of accounts) {
    const hash = await bcrypt.hash(a.password, 10);
    await pool.query('INSERT INTO credentials (email, password_hash, user_id) VALUES ($1,$2,$3)', [a.email.toLowerCase(), hash, a.id]);
  }
  res.json({ ok: true });
});

// Admin only: put back any starter (demo) accounts that are missing on this server, without touching accounts that exist.
// A missing profile is added; a missing password is set to the starter password. Existing passwords are never changed.
app.post('/api/auth/restore-demo-accounts', authRequired, async (req, res) => {
  const myTerminal = req.user.terminalId;
  if (!isSctl(req.user) && !isTerminalAdmin(req.user)) return res.status(403).json({ error: 'Only SCTL or a terminal Admin can restore demo accounts.' });
  const { accounts, users: profiles } = req.body || {};
  if (!Array.isArray(accounts) || !Array.isArray(profiles)) return res.status(400).json({ error: 'accounts[] and users[] are required.' });
  const addedProfiles = [], fixedPasswords = [];
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const row = await client.query('SELECT value FROM kv_store WHERE key=$1 FOR UPDATE', ['users']);
    if (!row.rows.length) { await client.query('ROLLBACK'); return res.status(503).json({ error: 'The server has not been set up yet.' }); }
    const users = row.rows[0].value || [];
    for (const a of accounts) {
      if (!a || !a.id || !a.email || typeof a.password !== 'string' || a.password.length < 6) continue;
      const mail = String(a.email).toLowerCase();
      const p = profiles.find(x => x && x.id === a.id);
      if (!isSctl(req.user) && (!p || p.terminalId !== myTerminal || p.role === 'sctl' || p.role === 'customs')) continue;
      let u = users.find(x => x.id === a.id || String(x.login || '').toLowerCase() === mail);
      if (!u) {
        if (!p || !['importer', 'agent', 'admin', 'customs', 'sctl'].includes(p.role)) continue;
        u = Object.assign({}, p, { id: a.id, login: String(a.email), status: 'active' });
        delete u.password;
        users.push(u); addedProfiles.push(u.name || mail);
      }
      const cred = await client.query('SELECT 1 FROM credentials WHERE email=$1', [mail]);
      if (!cred.rows.length) {
        const hash = await bcrypt.hash(a.password, 10);
        await client.query('INSERT INTO credentials (email, password_hash, user_id) VALUES ($1,$2,$3)', [mail, hash, u.id]);
        fixedPasswords.push(mail);
      }
    }
    if (addedProfiles.length) {
      await client.query("INSERT INTO kv_store (key, value, updated_at) VALUES ('users', $1, now()) ON CONFLICT (key) DO UPDATE SET value=$1, updated_at=now()", [JSON.stringify(users)]);
    }
    await client.query('COMMIT');
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    console.error('restore demo accounts failed:', e);
    return res.status(500).json({ error: 'Could not restore the accounts. Please try again.' });
  } finally { client.release(); }
  if (addedProfiles.length) broadcastChanged('users');
  res.json({ ok: true, addedProfiles, fixedPasswords });
});

app.post('/api/bootstrap-demo-data', async (req, res) => {
  const existingUsers = await kvGet('users');
  if (existingUsers !== null) return res.status(409).json({ error: 'Already initialized.' });
  const { collections, accounts } = req.body || {};
  if (!collections || typeof collections !== 'object') return res.status(400).json({ error: 'collections is required.' });
  if (!Array.isArray(accounts)) return res.status(400).json({ error: 'accounts[] is required.' });
  for (const [key, value] of Object.entries(collections)) {
    await kvSet(key, value);
  }
  for (const a of accounts) {
    const hash = await bcrypt.hash(a.password, 10);
    await pool.query(
      'INSERT INTO credentials (email, password_hash, user_id) VALUES ($1,$2,$3) ON CONFLICT (email) DO NOTHING',
      [a.email.toLowerCase(), hash, a.id]
    );
  }
  res.json({ ok: true });
});

// 'settings' and 'terminals' are readable without signing in — the login
// screen needs branding, and the registration form needs the list of bonded
// terminals to choose from before anyone has a session. Everything else
// requires auth.
const PUBLIC_READ_KEYS = new Set(['platform-settings', 'terminals']);
app.get('/api/storage/:key', async (req, res) => {
  if (!PUBLIC_READ_KEYS.has(req.params.key) && !authOptional(req)) {
    return res.status(401).json({ error: 'Sign in required.' });
  }
  if (['users', 'activity-log', 'referrals', 'messages'].includes(req.params.key)) {
    const user = authOptional(req);
    if (!user) return res.status(401).json({ error: 'Sign in required.' });
    const full = (await kvGet(req.params.key)) || [];
    return res.json({ value: JSON.stringify(await scopedView(req.params.key, user, full)) });
  }
  if (req.params.key === 'containers') {
    const user = authOptional(req);
    const full = (await kvGet('containers')) || [];
    const { view } = await containersViewFor(user, full);
    return res.json({ value: JSON.stringify(view) });
  }
  const value = await kvGet(req.params.key);
  res.json({ value: value === null ? null : JSON.stringify(value) });
});

app.put('/api/storage/:key', async (req, res) => {
  const key = req.params.key;
  const raw = req.body && req.body.value;
  if (typeof raw !== 'string') return res.status(400).json({ error: 'Body must be { value: "<json string>" }.' });
  let parsed;
  const versions = {};
  try { parsed = JSON.parse(raw); } catch (e) { return res.status(400).json({ error: 'value must be valid JSON.' }); }

  const user = authOptional(req); // 'users' and 'terminals' have legitimate unauthenticated self-registration cases, checked below

  if (key === 'users') {
    const old = (await kvGet('users')) || [];
    if (!user) {
      const err = checkUsersWrite(old, parsed, user);
      if (err) return res.status(401).json({ error: err });
    } else {
      if (!validList(parsed)) return res.status(400).json({ error: 'Malformed user list.' });
      const view = old.filter(u => userVisibleTo(user, u)).map(u => redactUserFor(user, u));
      const visible = new Set(view.map(u => u.id)), oldIds = new Set(old.map(u => u.id));
      if (parsed.some(u => oldIds.has(u.id) && !visible.has(u.id))) return res.status(403).json({ error: 'One of those accounts belongs to a record you do not have access to.' });
      if (!wantsReplace(req.body, user)) {
        const changed = changedIdSet(req.body, parsed);
        parsed = applyChangedOnly(view, parsed, changed);
        const stale = findStale(view, parsed, changed);
        if (stale) return res.status(409).json({ error: conflictMessage('The account for ' + (stale.name || 'that person')), conflict: true });
      }
      parsed = restoreUndeleted(view, parsed, req.body, user);
      const mineIds = new Set(parsed.map(x => x.id));
      const err = checkUsersWrite(view, parsed, user);
      if (err) return res.status(403).json({ error: err });
      parsed = mergeUsers(old, view, parsed, user);
      for (const x of parsed) if (mineIds.has(x.id)) versions[x.id] = x._v;
    }
  } else if (key === 'terminals') {
    const old = (await kvGet('terminals')) || [];
    const err = checkTerminalsWrite(old, parsed, user);
    if (err) return res.status(user ? 403 : 401).json({ error: err });
  } else if (key === 'platform-settings') {
    if (!user) return res.status(401).json({ error: 'Sign in required.' });
    if (!isSctl(user)) return res.status(403).json({ error: 'Only SCTL can change platform settings.' });
  } else if (key === 'containers') {
    if (!user) return res.status(401).json({ error: 'Sign in required.' });
    if (!Array.isArray(parsed) || parsed.some(c => !c || typeof c !== 'object' || typeof c.id !== 'string')) {
      return res.status(400).json({ error: 'Malformed container list.' });
    }
    const full = (await kvGet('containers')) || [];
    const { profile, view: oldView } = await containersViewFor(user, full);
    const visibleIds = new Set(oldView.map(c => c.id));
    const fullIds = new Set(full.map(c => c.id));
    if (parsed.some(c => fullIds.has(c.id) && !visibleIds.has(c.id))) {
      return res.status(403).json({ error: 'One of those jobs belongs to a record you do not have access to.' });
    }
    const replaceAll = wantsReplace(req.body, user);
    if (!replaceAll) {
      const changed = changedIdSet(req.body, parsed);
      parsed = applyChangedOnly(oldView, parsed, changed);
      const stale = findStale(oldView, parsed, changed);
      if (stale) return res.status(409).json({ error: conflictMessage('Job ' + stale.containerNumber), conflict: true });
      parsed = restoreUndeleted(oldView, parsed, req.body, user);
    }
    const mineIds = new Set(parsed.map(x => x.id));
    const err = replaceAll ? null : await checkContainersWrite(oldView, parsed, user, profile);
    if (err) return res.status(403).json({ error: err });
    if (!replaceAll) {
      const derr = await checkDocumentChanges(oldView, parsed, user, profile);
      if (derr) return res.status(403).json({ error: derr });
    }
    parsed = mergeContainers(full, oldView, parsed, user);
    for (const x of parsed) if (mineIds.has(x.id)) versions[x.id] = x._v;
  } else if (['activity-log', 'referrals', 'messages'].includes(key)) {
    if (!user) return res.status(401).json({ error: 'Sign in required.' });
    if (!validList(parsed)) return res.status(400).json({ error: 'Malformed data.' });
    const full = (await kvGet(key)) || [];
    if (key === 'activity-log') {
      parsed = mergeLog(full, parsed, user, wantsReplace(req.body, user), await profileOf(user));
    } else {
      const profile = await profileOf(user);
      if (key === 'messages') { const fe = await checkMessageFiles(full, parsed, user); if (fe) return res.status(403).json({ error: fe }); }
      const r = key === 'referrals' ? checkAndMergeReferrals(full, parsed, user, profile, req.body) : checkAndMergeMessages(full, parsed, user, profile, req.body);
      if (r.error) return res.status(403).json({ error: r.error });
      parsed = r.merged;
    }
  } else {
    if (!user) return res.status(401).json({ error: 'Sign in required.' });
  }

  await kvSet(key, parsed);
  broadcastChanged(key);
  res.json({ ok: true, versions });
});

app.use((err, req, res, next) => {
  if (err && err.type === 'entity.too.large') return res.status(413).json({ error: 'That is too large to upload (files can be up to 10 MB).' });
  console.error(err);
  res.status(err && err.status ? err.status : 500).json({ error: 'Something went wrong on the server. Please try again.' });
});

initSchema()
  .then(() => {
    setTimeout(cleanupOrphanFiles, 60 * 1000).unref();
    setInterval(cleanupOrphanFiles, 6 * 3600 * 1000).unref();
    server.listen(PORT, () => console.log(`ConTracker backend listening on :${PORT}`));
  })
  .catch(err => {
    console.error('Failed to initialize database schema:', err);
    process.exit(1);
  });
