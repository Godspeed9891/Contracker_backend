// The only file that touches the `credentials` table (email, password_hash, user_id).
// Each function takes an optional `db`: leave it out for a normal query, or pass the client of a transaction.

const { pool } = require('../config/db');

async function exists(email, db = pool) {
  const r = await db.query('SELECT 1 FROM credentials WHERE email=$1', [email]);
  return r.rows.length > 0;
}
async function findByEmail(email) {
  const r = await pool.query('SELECT password_hash, user_id FROM credentials WHERE email=$1', [email]);
  return r.rows[0] || null;
}
async function insert(email, hash, userId, db = pool) {
  await db.query('INSERT INTO credentials (email, password_hash, user_id) VALUES ($1,$2,$3)', [email, hash, userId]);
}
// Used by the one-time bootstrap: keeps an existing password if the email is already there.
async function insertIfMissing(email, hash, userId) {
  await pool.query('INSERT INTO credentials (email, password_hash, user_id) VALUES ($1,$2,$3) ON CONFLICT (email) DO NOTHING', [email, hash, userId]);
}
async function removeByEmail(email, db = pool) {
  await db.query('DELETE FROM credentials WHERE email=$1', [email]);
}
async function removeAll() {
  await pool.query('DELETE FROM credentials');
}
async function updatePassword(email, hash) {
  await pool.query('UPDATE credentials SET password_hash=$1, updated_at=now() WHERE email=$2', [hash, email]);
}

module.exports = { exists, findByEmail, insert, insertIfMissing, removeByEmail, removeAll, updatePassword };