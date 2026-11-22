// The rules of the five /api/auth actions, moved out of the controller. Each function returns
// { status, body } (plus `changed`: the collections to announce over the WebSocket), and the controller
// only sends it. Database access goes through models/ (credentials, users, kv_store).

const { withTransaction } = require('../config/db');
const { kvLock, kvUpsert } = require('../models/kv.model');
const credentialModel = require('../models/credential.model');
const { findUserById } = require('../models/user.model');
const { hashPassword, checkPassword } = require('../utils/password');
const { signToken } = require('../utils/token');
const { isSctl, isTerminalAdmin } = require('../policies/role.policy');
const { emailIsVerified } = require('./otp.service');
const { storeIdPhoto, removeStoredFile } = require('./file.service');

const SELF_REGISTER_ROLES = ['importer', 'agent', 'admin', 'customs'];
const RESTORABLE_ROLES = ['importer', 'agent', 'admin', 'customs', 'sctl'];

const reply = (status, body, changed) => ({ status, body, changed });
const fail = (status, message) => reply(status, { error: message });

const crypto = require('crypto');

function generatePassword() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  let s = '';
  for (let i = 0; i < 10; i++) s += chars[crypto.randomInt(chars.length)];
  return s;
}
const ok = (extra, changed) => reply(200, Object.assign({ ok: true }, extra), changed);

const clip = (v, n) => (typeof v === 'string' ? v.replace(/[<>]/g, '').trim().slice(0, n) : '');

// Two modes:
//  - With `profile`: public self-registration. The server itself appends the
//    new PENDING profile (and, for a brand-new bonded terminal, the pending
//    terminal) to the shared collections — the browser can't do this safely
//    because before sign-in it has no copy of the user roster to add to. The
//    password hash, profile and terminal are saved together or not at all.
//  - Without `profile`: credentials only, used when a signed-in terminal
//    Admin creates a staff account and then saves it with their own session.
async function register(body) {
  const { id, email, password, profile, newTerminal } = body;
  if (!id || !email || !password) return fail(400, 'id, email and password are required.');
  if (password.length < 6) return fail(400, 'Password must be at least 6 characters.');
  const mail = String(email).toLowerCase();

  if (!profile) {
    if (await findUserById(id)) return fail(409, 'That account id is already in use.');
    if (await credentialModel.exists(mail)) return fail(409, 'That email is already registered. Try signing in.');
    const hash = await hashPassword(password);
    await credentialModel.insert(mail, hash, id);
    return ok();
  }

  if (typeof profile !== 'object' || Array.isArray(profile)) return fail(400, 'Malformed profile.');
  if (!emailIsVerified(body.verifyToken, mail)) return fail(403, 'Please verify your email address first.');
  if (!SELF_REGISTER_ROLES.includes(profile.role)) return fail(400, 'Invalid account type.');
    if (typeof profile.idType === 'string') profile.idType = profile.idType.replace(/[<>]/g, '').trim().slice(0, 70);
  const hash = await hashPassword(password);
  let idFileId = null;
  if (typeof profile.idImage === 'string' && profile.idImage) {
    const stored = await storeIdPhoto(id, profile.idImage, profile.idFileName);
    if (stored.error) return fail(400, stored.error);
    idFileId = stored.id;
  }
  if (!idFileId && process.env.REQUIRE_ID_PHOTO !== 'off') return fail(400, 'Please upload a photo of your ID.');
  let terminalsChanged = false;
  try {
    const outcome = await withTransaction(async client => {
      const usersRow = await kvLock(client, 'users');
      if (!usersRow.exists) return { rollback: true, response: fail(503, 'The server has not been set up yet. Reload the app once and try again.') };
      const users = usersRow.value || [];
      if (users.some(u => String(u.login || '').toLowerCase() === mail)) {
        return { rollback: true, response: fail(409, 'That email is already registered. Try signing in.') };
      }
      const termRow = await kvLock(client, 'terminals');
      const terminals = termRow.value || [];

      let terminalId = profile.role === 'customs' ? null : (profile.terminalId || null);
      if (newTerminal) {
        if (profile.role === 'customs' || !newTerminal.name || !newTerminal.address) {
          return { rollback: true, response: fail(400, 'A new terminal needs a name and an address.') };
        }
        const tid = newTerminal.id || ('t' + Date.now());
        terminals.push({ id: tid, name: String(newTerminal.name).trim(), address: String(newTerminal.address).trim(), status: 'pending', registeredDate: new Date().toISOString() });
        terminalId = tid;
        terminalsChanged = true;
      } else if (profile.role !== 'customs' && !terminals.some(t => t.id === terminalId && t.status === 'active')) {
        return { rollback: true, response: fail(400, 'Choose an active bonded terminal.') };
      }

      // A password row with no matching profile is left over from an earlier
      // sign-up attempt that failed half-way; replace it instead of blocking.
      await credentialModel.removeByEmail(mail, client);
      await credentialModel.insert(mail, hash, id, client);
          // Only the fields the sign-up form sends; everything else the browser adds is dropped.
      let department = null;
      if (profile.role === 'admin') {
        department = newTerminal ? 'Admin' : clip(profile.department, 40);
        if (!department || department.toLowerCase() === 'admin') {
          return { rollback: true, response: fail(400, 'Choose your department.') };
        }
      }
      const name = clip(profile.name, 100);
      if (!name) return { rollback: true, response: fail(400, 'Please enter your name.') };
      const clean = {
        id, login: String(email).trim(), name,
        phone: clip(profile.phone, 30), org: clip(profile.org, 120),
        role: profile.role, department, terminalId, status: 'pending_verification',
        uniqueId: clip(profile.uniqueId, 40), stationedAt: clip(profile.stationedAt, 80),
        profilePic: null, corporateRegNumber: null,
        idType: clip(profile.idType, 70), idFileName: clip(profile.idFileName, 120),
        isNewTerminalAdmin: !!newTerminal, verifiedBy: null, verifiedDate: null
      };
      delete clean.idImage;
      if (idFileId) clean.idFileId = idFileId;
      users.push(clean);
      await kvUpsert(client, 'users', users);
      if (terminalsChanged) await kvUpsert(client, 'terminals', terminals);
      return {};
    });
    if (outcome.response) { if (idFileId) await removeStoredFile(idFileId); return outcome.response; }
  } catch (e) {
    if (idFileId) await removeStoredFile(idFileId);
    console.error('register failed:', e);
    return fail(500, 'Could not save your registration. Please try again.');
  }
  return ok(null, terminalsChanged ? ['users', 'terminals'] : ['users']);
}

async function login(body) {
  const { email, password } = body;
  if (!email || !password) return fail(400, 'Email and password are required.');
  const row = await credentialModel.findByEmail(email.toLowerCase());
  if (!row) return fail(401, 'No matching account. Check the email and password.');
  const matches = await checkPassword(password, row.password_hash);
  if (!matches) return fail(401, 'No matching account. Check the email and password.');
  const profile = await findUserById(row.user_id);
  if (!profile) return fail(401, 'Account record not found.');
  if (profile.status && profile.status !== 'active') return fail(403, 'This account is not active. It may be waiting for approval or it has been suspended.');
  const token = signToken({
    id: profile.id, email: email.toLowerCase(), role: profile.role,
    department: profile.department || null, terminalId: profile.terminalId || null
  });
  return reply(200, { token, userId: profile.id });
}

async function setPassword(user, body) {
  const { email, newPassword } = body;
  if (!email || !newPassword) return fail(400, 'email and newPassword are required.');
  if (newPassword.length < 6) return fail(400, 'Password must be at least 6 characters.');
  const existing = await credentialModel.findByEmail(email.toLowerCase());
  if (!existing) return fail(404, 'No account with that email.');

  let allowed = user.email === email.toLowerCase() || isSctl(user);
  if (!allowed && isTerminalAdmin(user)) {
    const target = await findUserById(existing.user_id);
    allowed = !!target && target.terminalId === user.terminalId;
  }
  if (!allowed) return fail(403, 'You do not have permission to reset this account’s password.');

  const hash = await hashPassword(newPassword);
  await credentialModel.updatePassword(email.toLowerCase(), hash);
  return ok();
}

async function resetSeedCredentials(user, body) {
  if (process.env.ALLOW_DEMO_TOOLS !== 'on') return fail(404, 'Not found.');
  if (!isSctl(user)) return fail(403, 'Only SCTL can reset demo data.');
  const { accounts } = body;
  if (!Array.isArray(accounts)) return fail(400, 'accounts[] is required.');
  await credentialModel.removeAll();
  for (const a of accounts) {
    const hash = await hashPassword(a.password);
    await credentialModel.insert(a.email.toLowerCase(), hash, a.id);
  }
  return ok();
}

// Admin only: put back any starter (demo) accounts that are missing on this server, without touching accounts that exist.
// A missing profile is added; a missing password is set to the starter password. Existing passwords are never changed.
async function restoreDemoAccounts(user, body) {
  if (process.env.ALLOW_DEMO_TOOLS !== 'on') return fail(404, 'Not found.');
  const myTerminal = user.terminalId;
  if (!isSctl(user) && !isTerminalAdmin(user)) return fail(403, 'Only SCTL or a terminal Admin can restore demo accounts.');
  const { accounts, users: profiles } = body;
  if (!Array.isArray(accounts) || !Array.isArray(profiles)) return fail(400, 'accounts[] and users[] are required.');
  const addedProfiles = [], fixedPasswords = [];
  try {
    const outcome = await withTransaction(async client => {
      const row = await kvLock(client, 'users');
      if (!row.exists) return { rollback: true, response: fail(503, 'The server has not been set up yet.') };
      const users = row.value || [];
      for (const a of accounts) {
        if (!a || !a.id || !a.email || typeof a.password !== 'string' || a.password.length < 6) continue;
        const mail = String(a.email).toLowerCase();
        const p = profiles.find(x => x && x.id === a.id);
        if (!isSctl(user) && (!p || p.terminalId !== myTerminal || p.role === 'sctl' || p.role === 'customs')) continue;
        let u = users.find(x => x.id === a.id || String(x.login || '').toLowerCase() === mail);
        if (!u) {
          if (!p || !RESTORABLE_ROLES.includes(p.role)) continue;
          u = Object.assign({}, p, { id: a.id, login: String(a.email), status: 'active' });
          delete u.password;
          users.push(u); addedProfiles.push(u.name || mail);
        }
        if (!(await credentialModel.exists(mail, client))) {
          const hash = await hashPassword(a.password);
          await credentialModel.insert(mail, hash, u.id, client);
          fixedPasswords.push(mail);
        }
      }
      if (addedProfiles.length) await kvUpsert(client, 'users', users);
      return {};
    });
    if (outcome.response) return outcome.response;
  } catch (e) {
    console.error('restore demo accounts failed:', e);
    return fail(500, 'Could not restore the accounts. Please try again.');
  }
  return ok({ addedProfiles, fixedPasswords }, addedProfiles.length ? ['users'] : undefined);
}

async function changeEmail(user, body) {
  const { userId } = body;
  const mail = String(body.newEmail || '').trim().toLowerCase();
  if (!userId || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail)) return fail(400, 'A valid new email is required.');
  const target = await findUserById(userId);
  if (!target) return fail(404, 'No such account.');
  const self = target.id === user.id;
  const allowed = self || isSctl(user) || (isTerminalAdmin(user) && target.terminalId === user.terminalId && target.role !== 'sctl');
  if (!allowed) return fail(403, 'You do not have permission to change this email.');
  if (self && !emailIsVerified(body.verifyToken, mail)) return fail(403, 'Please verify the new email address first.');

  try {
    const outcome = await withTransaction(async client => {
      const row = await kvLock(client, 'users');
      const users = (row && row.value) || [];
      const i = users.findIndex(u => u.id === userId);
      if (i < 0) return { rollback: true, response: fail(404, 'No such account.') };
      if (String(users[i].login || '').toLowerCase() === mail) return { rollback: true, response: ok({ email: mail }) };
      if (users.some(u => u.id !== userId && String(u.login || '').toLowerCase() === mail)) {
        return { rollback: true, response: fail(409, 'That email is already in use.') };
      }
      const taken = await client.query('SELECT 1 FROM credentials WHERE email = $1', [mail]);
      if (taken.rowCount) return { rollback: true, response: fail(409, 'That email is already in use.') };
      const moved = await client.query('UPDATE credentials SET email = $1 WHERE user_id = $2', [mail, userId]);
      if (!moved.rowCount) return { rollback: true, response: fail(404, 'This account has no sign-in record.') };
      users[i] = Object.assign({}, users[i], { login: String(body.newEmail).trim() });
      await kvUpsert(client, 'users', users);
      return {};
    });
    if (outcome.response) return outcome.response;
  } catch (e) {
    console.error('change email failed:', e);
    return fail(500, 'Could not change the email. Please try again.');
  }
  // The old token carries the old email, so a person changing their own email gets a fresh token.
  const extra = { email: mail };
  if (self) extra.token = signToken({ id: target.id, email: mail, role: target.role, department: target.department || null, terminalId: target.terminalId || null });
  return ok(extra, ['users']);
}

async function createClientAccount(user, body) {
  if (user.role !== 'admin' || user.department !== 'Admin') return fail(403, 'Only your terminal\'s Admin can create importer and agent accounts.');
  if (!['importer', 'agent'].includes(body.role)) return fail(400, 'Choose importer or agent.');
  const mail = String(body.email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail)) return fail(400, 'A valid email is required.');
  const name = clip(body.name, 100);
  if (!name) return fail(400, 'Please enter a name.');
  let password = typeof body.password === 'string' && body.password ? body.password : null;
  if (password && password.length < 6) return fail(400, 'Password must be at least 6 characters.');
  const generated = !password;
  if (generated) password = generatePassword();

  const admin = await findUserById(user.id);
  const id = 'u' + Date.now() + crypto.randomInt(1000);
  const hash = await hashPassword(password);
  try {
    const outcome = await withTransaction(async client => {
      const row = await kvLock(client, 'users');
      if (!row.exists) return { rollback: true, response: fail(503, 'The server has not been set up yet.') };
      const users = row.value || [];
      if (users.some(u => String(u.login || '').toLowerCase() === mail)) {
        return { rollback: true, response: fail(409, 'That email is already registered.') };
      }
      await credentialModel.removeByEmail(mail, client);   // leftover from a failed earlier attempt
      await credentialModel.insert(mail, hash, id, client);
      users.push({
        id, login: String(body.email).trim(), name,
        phone: clip(body.phone, 30), org: clip(body.org, 120),
        role: body.role, department: null, terminalId: user.terminalId,
        status: 'active', uniqueId: clip(body.uniqueId, 40) || ('CT-' + crypto.randomInt(100000, 999999)),
        stationedAt: '', profilePic: null, corporateRegNumber: clip(body.corporateRegNumber, 60) || null,
        idType: '', verifiedBy: admin ? admin.name : null, verifiedDate: new Date().toISOString()
      });
      await kvUpsert(client, 'users', users);
      return {};
    });
    if (outcome.response) return outcome.response;
  } catch (e) {
    console.error('create client account failed:', e);
    return fail(500, 'Could not create the account. Please try again.');
  }
  return ok({ userId: id, email: mail, password: generated ? password : undefined }, ['users']);
}

module.exports = { register, login, setPassword, resetSeedCredentials, restoreDemoAccounts, changeEmail, createClientAccount };