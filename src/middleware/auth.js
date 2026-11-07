// Moved verbatim from the original server.js (lines 73-84): reads the Bearer token.
// authOptional returns the token's payload or null; authRequired answers 401 if there is none.

const jwt = require('jsonwebtoken');
const { JWT_SECRET } = require('../config/env');

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

module.exports = { authOptional, authRequired };
