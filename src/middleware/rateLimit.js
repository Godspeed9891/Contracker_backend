// Brakes on guessing passwords and mass-creating accounts. Counters live in the server's memory, so they reset
// when the server restarts (fine for one server; use a shared store if you ever run several copies).
//
//  - loginPerAccount: 8 wrong passwords per 15 minutes for one email from one address
//  - loginPerAddress: 30 wrong logins per 15 minutes from one address (a whole office can share an address)
//  - registerLimiter: 20 sign-ups per hour from one address
//
// Only FAILED logins count: a successful sign-in does not use up the allowance.
// Set RATE_LIMIT=off in .env to switch all of these off while you are testing.

const { rateLimit, ipKeyGenerator } = require('express-rate-limit');

const tooMany = (req, res) => res.status(429).json({ error: 'Too many attempts. Please wait a few minutes and try again.' });
const common = {
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler: tooMany,
  skip: () => process.env.RATE_LIMIT === 'off'
};

const loginPerAccount = rateLimit({
  ...common, windowMs: 15 * 60 * 1000, limit: 8, skipSuccessfulRequests: true,
  keyGenerator: req => ipKeyGenerator(req.ip) + '|' + String((req.body && req.body.email) || '').toLowerCase()
});
const loginPerAddress = rateLimit({
  ...common, windowMs: 15 * 60 * 1000, limit: 30, skipSuccessfulRequests: true,
  keyGenerator: req => ipKeyGenerator(req.ip)
});
const registerLimiter = rateLimit({
  ...common, windowMs: 60 * 60 * 1000, limit: 20,
  keyGenerator: req => ipKeyGenerator(req.ip)
});

module.exports = { loginPerAccount, loginPerAddress, registerLimiter };