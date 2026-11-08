// POST /api/files (upload) and GET /api/files/:id (download). The rules are in services/file.service.js.

const fileService = require('../services/file.service');
const { send } = require('../utils/respond');
const { catchAll } = require('../utils/catchAll');

const upload = async (req, res) => send(res, await fileService.uploadFile(req.user, req.query.name, req.body));

const download = async (req, res) => {
  const result = await fileService.downloadFile(req.user, req.params.id);
  if (!result.file) return send(res, result);
  const f = result.file;
  const ascii = f.name.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '');
  res.set({
    'Content-Type': f.mime,
    'Content-Length': String(f.data.length),
    'Content-Disposition': `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(f.name)}`,
    'Cache-Control': 'private, no-store'
  });
  res.end(f.data);
};

module.exports = catchAll({ upload, download });