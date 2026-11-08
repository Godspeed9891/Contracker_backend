// GET and PUT /api/storage/:key. The controller only reads the request; reading rules and the save rules for
// each collection are in services/storage.service.js and services/storageWrite/.

const storageService = require('../services/storage.service');
const { authOptional } = require('../middleware/auth');
const { send } = require('../utils/respond');
const { catchAll } = require('../utils/catchAll');

const readKey = async (req, res) => send(res, await storageService.readKey(req.params.key, authOptional(req)));
const writeKey = async (req, res) => send(res, await storageService.writeKey(req.params.key, authOptional(req), req.body));

module.exports = catchAll({ readKey, writeKey });