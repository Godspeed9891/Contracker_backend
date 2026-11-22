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

const COOKIE_NAME = 'ct_session';
const MAX_AGE_S = 12 * 60 * 60; // same 12 hours as the token

// Reads one cookie from the Cookie header (no extra package needed).
function readCookie(header, name) {
  if (!header) return null;
  for (const part of String(header).split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) {
      try { return decodeURIComponent(part.slice(i + 1).trim()); } catch (e) { return null; }
    }
  }
  return null;
}

// The signed-in token of a request: the cookie first, the old Authorization header as a fallback.
function tokenFromRequest(req) {
  const fromCookie = readCookie(req.headers.cookie, COOKIE_NAME);
  if (fromCookie) return fromCookie;
  const h = req.headers.authorization || '';
  return h.startsWith('Bearer ') ? h.slice(7) : null;
}

const isHttps = req => !!req.secure || req.headers['x-forwarded-proto'] === 'https';

function setSessionCookie(req, res, token) {
  res.cookie(COOKIE_NAME, token, { httpOnly: true, secure: isHttps(req), sameSite: 'lax', path: '/', maxAge: MAX_AGE_S * 1000 });
}
function clearSessionCookie(req, res) {
  res.clearCookie(COOKIE_NAME, { httpOnly: true, secure: isHttps(req), sameSite: 'lax', path: '/' });
}

module.exports = { signToken, userFromToken, tokenFromRequest, setSessionCookie, clearSessionCookie, readCookie };