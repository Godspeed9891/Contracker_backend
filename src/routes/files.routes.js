const express = require('express');
const { authRequired } = require('../middleware/auth');
const { FILE_MAX_BYTES } = require('../constants/files');
const files = require('../controllers/file.controller');

const router = express.Router();

router.post('/', authRequired, express.raw({ type: () => true, limit: FILE_MAX_BYTES + 1024 }), files.upload);
router.get('/:id', authRequired, files.download);

module.exports = router;