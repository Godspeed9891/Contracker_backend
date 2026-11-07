const { pool } = require('../config/db');

async function fileMeta(id) {
  if (typeof id !== 'string' || id.length > 80) return null;
  const r = await pool.query('SELECT id, name, mime, size, uploaded_by FROM files WHERE id=$1', [id]);
  return r.rows[0] || null;
}

module.exports = { fileMeta };