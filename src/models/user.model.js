// Looks accounts up in the stored `users` collection. The collection can be large (it carries each person's ID
// photo), so these functions ask the database for just the one account, or just a few fields, instead of
// downloading the whole list: that matters a lot when the database is far away.

const { pool } = require('../config/db');

// The array of accounts, or an empty one if nothing is stored yet.
const USERS = "jsonb_array_elements(CASE WHEN jsonb_typeof(value) = 'array' THEN value ELSE '[]'::jsonb END)";

// Finds one account profile by id (undefined when there is none).
async function findUserById(id) {
  const r = await pool.query(`SELECT u AS profile FROM kv_store, ${USERS} AS u WHERE key = 'users' AND u->>'id' = $1 LIMIT 1`, [String(id)]);
  return r.rows.length ? r.rows[0].profile : undefined;
}

async function profileOf(user) {
  return (await findUserById(user.id)) || null;
}

// Just what the permission list needs (id, role, department, terminalId, status) for every account.
async function accountSummaries() {
  const r = await pool.query(
    `SELECT u->>'id' AS id, u->>'role' AS role, u->>'department' AS department, u->>'terminalId' AS "terminalId", u->>'status' AS status
       FROM kv_store, ${USERS} AS u WHERE key = 'users'`
  );
  return r.rows;
}

module.exports = { profileOf, findUserById, accountSummaries };