// New file (no original lines): the URLs of the five auth handlers, with the same guards as the
// original app.post(...) lines 876, 949, 967, 987 and 1001. app.js mounts this router at /api/auth.

const express = require('express');
const { authRequired, authOptional } = require('../middleware/auth');
const auth = require('../controllers/auth.controller');
const { loginPerAccount, loginPerAddress, registerLimiter, sendCodeLimiter, verifyCodeLimiter } = require('../middleware/rateLimit');

const router = express.Router();

const { userFromToken } = require('../utils/token');
const { isSctl, isTerminalAdmin } = require('../policies/role.policy');

// Registering with no profile (credentials only) is for an Admin creating a staff account. Public sign-up always sends a profile.
function credentialsOnlyNeedsAdmin(req, res, next) {
  if (req.body && req.body.profile) return next();
const user = authOptional(req);
  if (!user) return res.status(401).json({ error: 'Sign in first.' });
  if (!isSctl(user) && !isTerminalAdmin(user)) return res.status(403).json({ error: 'Only an Admin can create accounts.' });
  next();
}

router.post('/register', registerLimiter, credentialsOnlyNeedsAdmin, auth.register);
router.post('/send-code', sendCodeLimiter, auth.sendCode);
router.post('/verify-code', verifyCodeLimiter, auth.verifyCode);
router.post('/forgot-password', sendCodeLimiter, auth.forgotPassword);
router.post('/reset-password', verifyCodeLimiter, auth.resetPassword);
router.post('/login', loginPerAddress, loginPerAccount, auth.login);
router.post('/set-password', authRequired, auth.setPassword);
router.post('/change-email', authRequired, auth.changeEmail);
router.post('/create-client-account', authRequired, auth.createClientAccount);
router.post('/reset-seed-credentials', authRequired, auth.resetSeedCredentials);
router.post('/restore-demo-accounts', authRequired, auth.restoreDemoAccounts);
router.post('/logout', auth.logout);

module.exports = router;