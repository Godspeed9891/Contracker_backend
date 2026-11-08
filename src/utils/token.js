// Signs the 12-hour login token, and reads one back (originally server.js lines 70-72).

const jwt = require('jsonwebtoken');
const { JWT_SECRET } = require('../config/env');
const accounts = require('../models/account.index');

function signToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '12h' });
}

// Reads a token and returns the signed-in person, or null. The signature and expiry must be good AND the account
// must still exist and be active. Role, department and terminal come from the account as it is now, not from the
// moment the token was made, so changes take effect on the very next request.
function userFromToken(token) {
  let payload;
  try { payload = jwt.verify(token, JWT_SECRET); } catch (e) { return null; }
  const account = accounts.lookup(payload.id);
  if (!account) return null;
  if (account.status && account.status !== 'active') return null;
  return Object.assign({}, payload, { role: account.role, department: account.department || null, terminalId: account.terminalId || null });
}

module.exports = { signToken, userFromToken };