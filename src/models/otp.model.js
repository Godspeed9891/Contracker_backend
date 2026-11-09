// The otp_codes table: at most one live code per email and purpose. Only a hash of the code is kept.

const { pool } = require('../config/db');

async function find(email, purpose) {
  const r = await pool.query('SELECT email, purpose, code_hash, expires_at, attempts, created_at FROM otp_codes WHERE email = $1 AND purpose = $2', [email, purpose]);
  return r.rows[0] || null;
}

// Saves a fresh code (replacing any earlier one) with `minutes` of life and zero wrong guesses.
async function save(email, purpose, codeHash, minutes) {
  await pool.query(
    `INSERT INTO otp_codes (email, purpose, code_hash, expires_at, attempts, created_at)
     VALUES ($1, $2, $3, now() + ($4 || ' minutes')::interval, 0, now())
     ON CONFLICT (email, purpose) DO UPDATE
       SET code_hash = EXCLUDED.code_hash, expires_at = EXCLUDED.expires_at, attempts = 0, created_at = now()`,
    [email, purpose, codeHash, String(minutes)]
  );
}

async function addAttempt(email, purpose) {
  const r = await pool.query('UPDATE otp_codes SET attempts = attempts + 1 WHERE email = $1 AND purpose = $2 RETURNING attempts', [email, purpose]);
  return r.rows[0] ? r.rows[0].attempts : 0;
}

async function remove(email, purpose) {
  await pool.query('DELETE FROM otp_codes WHERE email = $1 AND purpose = $2', [email, purpose]);
}

async function removeExpired() {
  await pool.query("DELETE FROM otp_codes WHERE expires_at < now() - interval '1 day'");
}

module.exports = { find, save, addAttempt, remove, removeExpired };