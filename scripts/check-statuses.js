// Counts the account statuses stored in the database named by DATABASE_URL, without changing anything.
// Run it from the project folder:  node --env-file=.env scripts/check-statuses.js

const { pool } = require('../src/config/db');

(async () => {
  const r = await pool.query("SELECT value FROM kv_store WHERE key = 'users'");
  const users = r.rows.length && Array.isArray(r.rows[0].value) ? r.rows[0].value : [];
  const counts = {};
  for (const u of users) {
    const s = u && u.status !== undefined && u.status !== null ? String(u.status) : '(no status)';
    counts[s] = (counts[s] || 0) + 1;
  }
  console.log(users.length + ' accounts in total');
  for (const [status, n] of Object.entries(counts)) console.log('  ' + String(n).padStart(4) + '  ' + status);
  await pool.end();
})().catch(e => { console.error('Could not read the database:', e.message); process.exit(1); });