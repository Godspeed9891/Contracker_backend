// Reads the Bearer token (originally server.js lines 73-84).
// authOptional returns the signed-in person (checked against their current account, see utils/token.js) or null;
// authRequired answers 401 if there is none.

const { userFromToken } = require('../utils/token');

function authOptional(req) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return null;
  return userFromToken(token);
}
function authRequired(req, res, next) {
  const user = authOptional(req);
  if (!user) return res.status(401).json({ error: 'Sign in required.' });
  req.user = user;
  next();
}

module.exports = { authOptional, authRequired };