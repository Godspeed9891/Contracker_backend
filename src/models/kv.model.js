// Moved verbatim from the original server.js (lines 88-99): the only place that talks to kv_store.
// Every other file reads and writes collections through kvGet / kvSet.

const { pool } = require('../config/db');
const accounts = require('./account.index');

// ---------- kv_store helpers ----------
async function kvGet(key) {
  const r = await pool.query('SELECT value FROM kv_store WHERE key=$1', [key]);
  return r.rows.length ? r.rows[0].value : null;
}
async function kvSet(key, value) {
  await pool.query(
    `INSERT INTO kv_store (key, value, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (key) DO UPDATE SET value=$2, updated_at=now()`,
    [key, JSON.stringify(value)]
  );
    if (key === 'users') accounts.rebuild(value);
}

// The same two operations on a connection that is inside a transaction (see withTransaction in config/db.js).
// kvLock reads a collection and holds its row until the transaction ends, so two requests cannot edit it at once.
async function kvLock(client, key) {
  const r = await client.query('SELECT value FROM kv_store WHERE key=$1 FOR UPDATE', [key]);
  return r.rows.length ? { exists: true, value: r.rows[0].value } : { exists: false, value: undefined };
}
async function kvUpsert(client, key, value) {
  await client.query(
    `INSERT INTO kv_store (key, value, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (key) DO UPDATE SET value=$2, updated_at=now()`,
    [key, JSON.stringify(value)]
  );
    if (key === 'users') accounts.rebuild(value);
}

module.exports = { kvGet, kvSet, kvLock, kvUpsert };