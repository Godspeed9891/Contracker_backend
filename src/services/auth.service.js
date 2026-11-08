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

const SELF_REGISTER_ROLES = ['importer', 'agent', 'admin', 'customs'];
const RESTORABLE_ROLES = ['importer', 'agent', 'admin', 'customs', 'sctl'];

const reply = (status, body, changed) => ({ status, body, changed });
const fail = (status, message) => reply(status, { error: message });
const ok = (extra, changed) => reply(200, Object.assign({ ok: true }, extra), changed);

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
    if (await credentialModel.exists(mail)) return fail(409, 'That email is already registered. Try signing in.');
    const hash = await hashPassword(password);
    await credentialModel.insert(mail, hash, id);
    return ok();
  }

  if (typeof profile !== 'object' || Array.isArray(profile)) return fail(400, 'Malformed profile.');
  if (!SELF_REGISTER_ROLES.includes(profile.role)) return fail(400, 'Invalid account type.');
  const hash = await hashPassword(password);
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
      const clean = Object.assign({}, profile, { id, login: String(email).trim(), terminalId, status: 'pending_verification', verifiedBy: null, verifiedDate: null });
      delete clean.password;
      users.push(clean);
      await kvUpsert(client, 'users', users);
      if (terminalsChanged) await kvUpsert(client, 'terminals', terminals);
      return {};
    });
    if (outcome.response) return outcome.response;
  } catch (e) {
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

module.exports = { register, login, setPassword, resetSeedCredentials, restoreDemoAccounts };