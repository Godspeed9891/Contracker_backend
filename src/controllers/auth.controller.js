// Moved verbatim from the original server.js (lines 868-1043): the five /api/auth handlers.
// Each body is unchanged; only the `app.post(path, [authRequired,] async (req, res) => {...})` wrapper
// became a named function. The URL and the authRequired guard now live in routes/auth.routes.js.
// These handlers still hold their own SQL and rules; a later step splits them into services and models.

const bcrypt = require('bcryptjs');
const { pool } = require('../config/db');
const { kvGet } = require('../models/kv.model');
const { signToken } = require('../utils/token');
const { isSctl, isTerminalAdmin } = require('../policies/role.policy');
const { broadcastChanged } = require('../realtime/hub');

// Two modes:
//  - With `profile`: public self-registration. The server itself appends the
//    new PENDING profile (and, for a brand-new bonded terminal, the pending
//    terminal) to the shared collections — the browser can't do this safely
//    because before sign-in it has no copy of the user roster to add to. The
//    password hash, profile and terminal are saved together or not at all.
//  - Without `profile`: credentials only, used when a signed-in terminal
//    Admin creates a staff account and then saves it with their own session.
const register = async (req, res) => {
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
};

const login = async (req, res) => {
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
};

const setPassword = async (req, res) => {
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
};

const resetSeedCredentials = async (req, res) => {
  if (!isSctl(req.user)) return res.status(403).json({ error: 'Only SCTL can reset demo data.' });
  const { accounts } = req.body || {};
  if (!Array.isArray(accounts)) return res.status(400).json({ error: 'accounts[] is required.' });
  await pool.query('DELETE FROM credentials');
  for (const a of accounts) {
    const hash = await bcrypt.hash(a.password, 10);
    await pool.query('INSERT INTO credentials (email, password_hash, user_id) VALUES ($1,$2,$3)', [a.email.toLowerCase(), hash, a.id]);
  }
  res.json({ ok: true });
};

// Admin only: put back any starter (demo) accounts that are missing on this server, without touching accounts that exist.
// A missing profile is added; a missing password is set to the starter password. Existing passwords are never changed.
const restoreDemoAccounts = async (req, res) => {
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
};

module.exports = { register, login, setPassword, resetSeedCredentials, restoreDemoAccounts };
