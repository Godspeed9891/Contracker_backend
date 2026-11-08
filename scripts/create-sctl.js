// Creates the first SCTL (super admin) account on a fresh database, since the web/mobile pages no longer seed demo data.
// Run from the project folder:
//   node --env-file=.env scripts/create-sctl.js "Full Name" email@example.com "a-password"
// Refuses to run if that email already exists. It does not change any other account.

const { pool } = require('../src/config/db');
const { kvGet, kvSet } = require('../src/models/kv.model');
const credentialModel = require('../src/models/credential.model');
const { hashPassword } = require('../src/utils/password');

(async () => {
  const [name, email, password] = process.argv.slice(2);
  if (!name || !email || !password) {
    console.error('Usage: node --env-file=.env scripts/create-sctl.js "Full Name" email@example.com "password"');
    process.exit(1);
  }
  if (!/^\S+@\S+\.\S+$/.test(email)) { console.error('That does not look like an email address.'); process.exit(1); }
  if (password.length < 6) { console.error('Password must be at least 6 characters.'); process.exit(1); }

  const mail = email.trim().toLowerCase();
  if (await credentialModel.exists(mail)) { console.error('An account with that email already exists.'); process.exit(1); }

  const users = (await kvGet('users')) || [];
  const id = 'u' + Date.now();
  users.push({ id, name: name.trim(), login: email.trim(), phone: '', org: 'SCTL', role: 'sctl', department: null, terminalId: null, status: 'active', stationedAt: '', verifiedBy: null, verifiedDate: null });
  await credentialModel.insert(mail, await hashPassword(password), id);
  await kvSet('users', users);
  console.log('SCTL account created: ' + mail + ' (restart the server so it picks the new account up)');
  await pool.end();
})().catch(e => { console.error('Failed:', e.message); process.exit(1); });