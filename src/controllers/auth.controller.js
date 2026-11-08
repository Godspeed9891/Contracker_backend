// The five /api/auth handlers. They only read the request, call the auth service and send what it
// returns; the rules live in services/auth.service.js and the SQL in models/. The URLs and the
// authRequired guards are in routes/auth.routes.js.

const authService = require('../services/auth.service');
const { send } = require('../utils/respond');
const { catchAll } = require('../utils/catchAll');

const register = async (req, res) => send(res, await authService.register(req.body || {}));
const login = async (req, res) => send(res, await authService.login(req.body || {}));
const setPassword = async (req, res) => send(res, await authService.setPassword(req.user, req.body || {}));
const resetSeedCredentials = async (req, res) => send(res, await authService.resetSeedCredentials(req.user, req.body || {}));
const restoreDemoAccounts = async (req, res) => send(res, await authService.restoreDemoAccounts(req.user, req.body || {}));

module.exports = catchAll({ register, login, setPassword, resetSeedCredentials, restoreDemoAccounts });