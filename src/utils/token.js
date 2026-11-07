// Moved verbatim from the original server.js (lines 70-72): signs the 12-hour login token.

const jwt = require('jsonwebtoken');
const { JWT_SECRET } = require('../config/env');

function signToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '12h' });
}

module.exports = { signToken };
