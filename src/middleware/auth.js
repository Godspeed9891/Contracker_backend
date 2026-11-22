const { userFromToken, tokenFromRequest } = require('../utils/token');

function authOptional(req) {
  const token = tokenFromRequest(req);
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