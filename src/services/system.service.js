// The one-time demo-data bootstrap. Returns { status, body } for the controller to send.

const { kvGet, kvSet } = require('../models/kv.model');
const credentialModel = require('../models/credential.model');
const { hashPassword } = require('../utils/password');

const fail = (status, message) => ({ status, body: { error: message } });

async function bootstrapDemoData(body) {
  const existingUsers = await kvGet('users');
  if (existingUsers !== null) return fail(409, 'Already initialized.');
  const { collections, accounts } = body;
  if (!collections || typeof collections !== 'object') return fail(400, 'collections is required.');
  if (!Array.isArray(accounts)) return fail(400, 'accounts[] is required.');
  for (const [key, value] of Object.entries(collections)) {
    await kvSet(key, value);
  }
  for (const a of accounts) {
    const hash = await hashPassword(a.password);
    await credentialModel.insertIfMissing(a.email.toLowerCase(), hash, a.id);
  }
  return { status: 200, body: { ok: true } };
}

module.exports = { bootstrapDemoData };