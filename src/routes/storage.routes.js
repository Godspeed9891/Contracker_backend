const express = require('express');
const storage = require('../controllers/storage.controller');

const router = express.Router();

router.get('/:key', storage.readKey);
router.put('/:key', storage.writeKey);

module.exports = router;