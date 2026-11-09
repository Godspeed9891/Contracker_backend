// Moved verbatim from the original server.js (lines 53-62): the Postgres pool and initSchema().
// Only change: schema.sql is now looked up at the project root (two folders up from here).

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const { DATABASE_URL } = require('./env');

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: process.env.PGSSLMODE === 'disable' ? false : { rejectUnauthorized: false },
  keepAlive: true,                 // keep the TCP connection warm so a hosted database (Neon) does not silently drop it
  idleTimeoutMillis: 10000,        // throw idle connections away before the host does, so a dead one is never reused
  connectionTimeoutMillis: 30000   // fail with a clear error instead of waiting forever for a connection
});

// If Postgres drops a connection that is sitting idle in the pool (a restart, a network blip), the pool emits an
// 'error' event. With no listener Node treats that as fatal and stops the whole server. Log it and carry on:
// the pool throws the dead connection away and opens a new one for the next request.
pool.on('error', err => console.error('Idle database connection lost:', err.message));

// A read that hits a connection the host has just dropped (ECONNRESET and friends) is simply tried once more on a
// fresh connection. Writes are never retried automatically, because they may already have been saved.
const TRANSIENT = new Set(['ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'ECONNREFUSED']);
const rawQuery = pool.query.bind(pool);
pool.query = async function (...args) {
  try {
    return await rawQuery(...args);
  } catch (e) {
    const text = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].text) || '';
    const isRead = /^\s*select\b/i.test(text);
    if (isRead && (TRANSIENT.has(e.code) || /Connection terminated/i.test(e.message || ''))) return rawQuery(...args);
    throw e;
  }
};

async function initSchema() {
  const sql = fs.readFileSync(path.join(__dirname, '..', '..', 'schema.sql'), 'utf8');
  await pool.query(sql);
  console.log('Schema ready.');
}

// Runs fn(client) between BEGIN and COMMIT on one connection. If fn returns an object with rollback: true the
// work is rolled back instead (a refused request); if fn throws it is rolled back and the error is re-thrown.
async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query(result && result.rollback ? 'ROLLBACK' : 'COMMIT');
    return result;
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw e;
  } finally {
    client.release();
  }
}

module.exports = { pool, initSchema, withTransaction };