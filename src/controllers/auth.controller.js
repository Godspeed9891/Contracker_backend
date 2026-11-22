// The five /api/auth handlers. They only read the request, call the auth service and send what it
// returns; the rules live in services/auth.service.js and the SQL in models/. The URLs and the
// authRequired guards are in routes/auth.routes.js.

const { catchAll } = require('../utils/catchAll');
const authService = require('../services/auth.service');
const otpService = require('../services/otp.service');
const { send } = require('../utils/respond');
const { setSessionCookie, clearSessionCookie } = require('../utils/token');


const register = async (req, res) => send(res, await authService.register(req.body || {}));
const sendCode = async (req, res) => send(res, await otpService.sendCode(req.body || {}));
const verifyCode = async (req, res) => send(res, await otpService.verifyCode(req.body || {}));
const forgotPassword = async (req, res) => send(res, await otpService.sendResetCode(req.body || {}));
const resetPassword = async (req, res) => send(res, await otpService.resetPassword(req.body || {}));
const login = async (req, res) => {
  const result = await authService.login(req.body || {});
  if (result.status === 200 && result.body.token) setSessionCookie(req, res, result.body.token);
  return send(res, result);
};
const setPassword = async (req, res) => send(res, await authService.setPassword(req.user, req.body || {}));
const resetSeedCredentials = async (req, res) => send(res, await authService.resetSeedCredentials(req.user, req.body || {}));
const restoreDemoAccounts = async (req, res) => send(res, await authService.restoreDemoAccounts(req.user, req.body || {}));
const changeEmail = async (req, res) => {
  const result = await authService.changeEmail(req.user, req.body || {});
  if (result.status === 200 && result.body.token) setSessionCookie(req, res, result.body.token);
  return send(res, result);
};
const createClientAccount = async (req, res) => send(res, await authService.createClientAccount(req.user, req.body || {}));
const logout = async (req, res) => { clearSessionCookie(req, res); res.json({ ok: true }); };

module.exports = catchAll({ register, sendCode, verifyCode, forgotPassword, resetPassword, login, setPassword, resetSeedCredentials, restoreDemoAccounts, changeEmail, createClientAccount, logout });