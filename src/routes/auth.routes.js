// New file (no original lines): the URLs of the five auth handlers, with the same guards as the
// original app.post(...) lines 876, 949, 967, 987 and 1001. app.js mounts this router at /api/auth.

const express = require('express');
const { authRequired } = require('../middleware/auth');
const auth = require('../controllers/auth.controller');
const { loginPerAccount, loginPerAddress, registerLimiter, sendCodeLimiter, verifyCodeLimiter } = require('../middleware/rateLimit');

const router = express.Router();

router.post('/register', registerLimiter, auth.register);
router.post('/send-code', sendCodeLimiter, auth.sendCode);
router.post('/verify-code', verifyCodeLimiter, auth.verifyCode);
router.post('/login', loginPerAddress, loginPerAccount, auth.login);
router.post('/set-password', authRequired, auth.setPassword);
router.post('/reset-seed-credentials', authRequired, auth.resetSeedCredentials);
router.post('/restore-demo-accounts', authRequired, auth.restoreDemoAccounts);

module.exports = router;