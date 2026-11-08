// Reading and saving the shared collections behind /api/storage/:key. Each function returns
// { status, body } (plus `changed`: the collection to announce over the WebSocket) for the controller to send.
// The per-collection save rules are in services/storageWrite/.

const { kvGet, kvSet } = require('../models/kv.model');
const { isSctl } = require('../policies/role.policy');
const { checkTerminalsWrite } = require('../policies/terminal.policy');
const { scopedView } = require('./scope.service');
const { containersViewFor } = require('./containerView.service');
const { writeUsers } = require('./storageWrite/users');
const { writeContainers } = require('./storageWrite/containers');
const { writeLogLike } = require('./storageWrite/logs');
const { refuse } = require('./storageWrite/refuse');

// 'platform-settings' and 'terminals' are readable without signing in: the login screen needs branding, and the
// registration form needs the list of bonded terminals before anyone has a session.
const PUBLIC_READ_KEYS = new Set(['platform-settings', 'terminals']);
const SCOPED_KEYS = ['users', 'activity-log', 'referrals', 'messages'];

const signInRequired = () => ({ status: 401, body: { error: 'Sign in required.' } });
const value = v => ({ status: 200, body: { value: v } });

// `user` is the signed-in person from the token, or null.
async function readKey(key, user) {
  if (!PUBLIC_READ_KEYS.has(key) && !user) return signInRequired();
  if (SCOPED_KEYS.includes(key)) {
    if (!user) return signInRequired();
    const full = (await kvGet(key)) || [];
    return value(JSON.stringify(await scopedView(key, user, full)));
  }
  if (key === 'containers') {
    const full = (await kvGet('containers')) || [];
    const { view } = await containersViewFor(user, full);
    return value(JSON.stringify(view));
  }
  const stored = await kvGet(key);
  return value(stored === null ? null : JSON.stringify(stored));
}

async function writeTerminals({ user, parsed }) {
  const old = (await kvGet('terminals')) || [];
  const err = checkTerminalsWrite(old, parsed, user);
  if (err) return refuse(user ? 403 : 401, err);
  return { parsed };
}
async function writeSettings({ user, parsed }) {
  if (!user) return refuse(401, 'Sign in required.');
  if (!isSctl(user)) return refuse(403, 'Only SCTL can change platform settings.');
  return { parsed };
}
async function writeOther({ user, parsed }) {
  if (!user) return refuse(401, 'Sign in required.');
  return { parsed };
}

const WRITERS = {
  users: writeUsers,
  containers: writeContainers,
  'activity-log': writeLogLike,
  referrals: writeLogLike,
  messages: writeLogLike,
  terminals: writeTerminals,
  'platform-settings': writeSettings
};

// `body` is the request body ({ value: "<json string>", changed?, deleted?, replace? }).
async function writeKey(key, user, body) {
  const raw = body && body.value;
  if (typeof raw !== 'string') return { status: 400, body: { error: 'Body must be { value: "<json string>" }.' } };
  let parsed;
  try { parsed = JSON.parse(raw); } catch (e) { return { status: 400, body: { error: 'value must be valid JSON.' } }; }

  // 'users' and 'terminals' have legitimate unauthenticated self-registration cases, so each writer checks for itself.
  const write = WRITERS[key] || writeOther;
  const out = await write({ key, user, body, parsed });
  if (out.response) return out.response;

  await kvSet(key, out.parsed);
  return { status: 200, body: { ok: true, versions: out.versions || {} }, changed: [key] };
}

module.exports = { readKey, writeKey };