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
      if (oldU && newU && deepEqual(oldU, newU)) continue; // unchanged
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
    if (!deepEqual(oldU, newU) && id !== authUser.id) return 'You can only update your own profile.';
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
const RESTRICTED_CONTAINER_FIELDS = {
  transferLetterNumber: ['Documentation', 'Operations', 'Admin'],
  invoiceNumber: ['Accountant', 'DTI', 'Operations', 'Admin'],
  transporter: ['Documentation', 'DTI', 'Transport', 'Admin'],
  transportHistory: ['Documentation', 'DTI', 'Transport', 'Admin'],
  exitNumber: ['Operations', 'Admin'],
  invoices: FINANCE_DEPTS,
  bolComplete: FEN_BOL_DEPTS,
  aNumber: FEN_BOL_DEPTS,
  cNumber: FEN_BOL_DEPTS
};

// Checks a proposed write to the `containers` collection. SCTL bypasses
// entirely; every other admin-role account is scoped to its OWN terminal (a
// container whose terminalId doesn't match theirs can't be touched at all),
// and within their terminal the same department/stage rules the UI hides
// buttons for are re-checked field-by-field.
async function checkContainersWrite(oldArr, newArr, authUser) {
  oldArr = Array.isArray(oldArr) ? oldArr : [];
  if (!Array.isArray(newArr)) return 'Malformed container list.';
  if (!authUser) return 'Sign in required.';
  if (isSctl(authUser)) return null;
  if (authUser.role !== 'admin') return 'Only bonded terminal staff accounts can modify job records.';

  const dept = authUser.department;
  const myTerminal = authUser.terminalId;
  const oldById = new Map(oldArr.map(c => [c.id, c]));
  const newById = new Map(newArr.map(c => [c.id, c]));

  for (const c of newArr) {
    if (!oldById.has(c.id)) {
      if (c.terminalId !== myTerminal) return 'You can only register jobs at your own terminal.';
      if (!FEN_BOL_DEPTS.includes(dept)) return 'Only Admin, Documentation, or DTI can register a new job (First Entry Note).';
    }
  }
  for (const c of oldArr) {
    if (!newById.has(c.id)) {
      if (c.terminalId !== myTerminal) return 'You can only manage jobs at your own terminal.';
      return 'Containers cannot be deleted.';
    }
  }

  let stageAccessCache = null;
  for (const c of newArr) {
    const prev = oldById.get(c.id);
    if (!prev || deepEqual(prev, c)) continue;
    if (prev.terminalId !== myTerminal || c.terminalId !== myTerminal) {
      return 'You can only manage jobs at your own terminal.';
    }
    const keys = new Set([...Object.keys(prev), ...Object.keys(c)]);
    for (const k of keys) {
      if (deepEqual(prev[k], c[k])) continue;
      if (k === 'stageIdx') {
        if (stageAccessCache === null) {
          const settings = await kvGet('platform-settings');
          stageAccessCache = (settings && settings.deptStageAccess) || {};
        }
        const access = (dept === 'Admin')
          ? null // terminal Admin may set any stage, matching the frontend's 'Advance container stages': dept==='Admin' rule
          : (stageAccessCache[dept] || DEFAULT_DEPT_STAGE_ACCESS[dept] || []);
        if (access && !access.includes(c[k]) && !access.includes(prev[k])) {
          return `Your department (${dept}) is not authorized to set that stage.`;
        }
        continue;
      }
      const allowedDepts = RESTRICTED_CONTAINER_FIELDS[k];
      if (allowedDepts && !allowedDepts.includes(dept)) {
        return `Your department (${dept}) is not authorized to change "${k}".`;
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
app.get('/api/health', (req, res) => res.json({ ok: true }));

app.post('/api/auth/register', async (req, res) => {
  const { id, email, password } = req.body || {};
  if (!id || !email || !password) return res.status(400).json({ error: 'id, email and password are required.' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  const existing = await pool.query('SELECT 1 FROM credentials WHERE email=$1', [email.toLowerCase()]);
  if (existing.rows.length) return res.status(409).json({ error: 'That email is already registered. Try signing in.' });
  const hash = await bcrypt.hash(password, 10);
  await pool.query('INSERT INTO credentials (email, password_hash, user_id) VALUES ($1,$2,$3)', [email.toLowerCase(), hash, id]);
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
  const value = await kvGet(req.params.key);
  res.json({ value: value === null ? null : JSON.stringify(value) });
});

app.put('/api/storage/:key', async (req, res) => {
  const key = req.params.key;
  const raw = req.body && req.body.value;
  if (typeof raw !== 'string') return res.status(400).json({ error: 'Body must be { value: "<json string>" }.' });
  let parsed;
  try { parsed = JSON.parse(raw); } catch (e) { return res.status(400).json({ error: 'value must be valid JSON.' }); }

  const user = authOptional(req); // 'users' and 'terminals' have legitimate unauthenticated self-registration cases, checked below

  if (key === 'users') {
    const old = (await kvGet('users')) || [];
    const err = checkUsersWrite(old, parsed, user);
    if (err) return res.status(user ? 403 : 401).json({ error: err });
  } else if (key === 'terminals') {
    const old = (await kvGet('terminals')) || [];
    const err = checkTerminalsWrite(old, parsed, user);
    if (err) return res.status(user ? 403 : 401).json({ error: err });
  } else if (key === 'platform-settings') {
    if (!user) return res.status(401).json({ error: 'Sign in required.' });
    if (!isSctl(user)) return res.status(403).json({ error: 'Only SCTL can change platform settings.' });
  } else if (key === 'containers') {
    const old = (await kvGet('containers')) || [];
    const err = await checkContainersWrite(old, parsed, user);
    if (err) return res.status(user ? 403 : 401).json({ error: err });
  } else {
    if (!user) return res.status(401).json({ error: 'Sign in required.' });
    // activity-log, referrals, messages: any signed-in account may write.
  }

  await kvSet(key, parsed);
  broadcastChanged(key);
  res.json({ ok: true });
});

initSchema()
  .then(() => {
    server.listen(PORT, () => console.log(`ConTracker backend listening on :${PORT}`));
  })
  .catch(err => {
    console.error('Failed to initialize database schema:', err);
    process.exit(1);
  });
