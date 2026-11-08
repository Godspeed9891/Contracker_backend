const { pool } = require('../config/db');

async function fileMeta(id) {
  if (typeof id !== 'string' || id.length > 80) return null;
  const r = await pool.query('SELECT id, name, mime, size, uploaded_by FROM files WHERE id=$1', [id]);
  return r.rows[0] || null;
}

async function insertFile({ id, name, mime, size, data, uploadedBy }) {
  await pool.query(
    'INSERT INTO files (id, name, mime, size, data, uploaded_by) VALUES ($1,$2,$3,$4,$5,$6)',
    [id, name, mime, size, data, uploadedBy]
  );
}
// The whole row including the bytes, for a download.
async function findFileWithData(id) {
  const r = await pool.query('SELECT id, name, mime, size, data, uploaded_by FROM files WHERE id=$1', [id]);
  return r.rows[0] || null;
}
// Used by the clean-up: ids of files that are more than a day old.
async function idsOlderThanOneDay() {
  const r = await pool.query("SELECT id FROM files WHERE created_at < now() - interval '1 day'");
  return r.rows.map(x => x.id);
}
async function removeFiles(ids) {
  await pool.query('DELETE FROM files WHERE id = ANY($1)', [ids]);
}

module.exports = { fileMeta, insertFile, findFileWithData, idsOlderThanOneDay, removeFiles };