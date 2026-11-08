const express = require('express');
const system = require('../controllers/system.controller');

const router = express.Router();

router.get('/health', system.health);
router.post('/bootstrap-demo-data', system.bootstrapDemoData);

module.exports = router;