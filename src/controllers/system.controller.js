// GET /api/health and POST /api/bootstrap-demo-data. The bootstrap rules are in services/system.service.js.

const systemService = require('../services/system.service');
const { send } = require('../utils/respond');
const { catchAll } = require('../utils/catchAll');

const health = (req, res) => res.json({ ok: true });
const bootstrapDemoData = async (req, res) => send(res, await systemService.bootstrapDemoData(req.body || {}));

module.exports = catchAll({ health, bootstrapDemoData });