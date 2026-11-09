// Times a few small database checks and shows how big each stored collection is. Changes nothing.
// Run from the project folder:  node --env-file=.env scripts/check-db.js

const { pool } = require('../src/config/db');

async function timed(label, fn) {
  const t = Date.now();
  const timer = setTimeout(() => console.log('  ...' + label + ' is still running after 15 seconds'), 15000);
  try { const r = await fn(); console.log(label + ': ok in ' + (Date.now() - t) + ' ms'); return r; }
  catch (e) { console.log(label + ': FAILED - ' + e.message); }
  finally { clearTimeout(timer); }
}

(async () => {
  await timed('1. simple query (SELECT 1)', () => pool.query('SELECT 1'));
  const sizes = await timed('2. collection sizes', () => pool.query('SELECT key, pg_column_size(value) AS bytes FROM kv_store ORDER BY bytes DESC'));
  if (sizes) for (const r of sizes.rows) console.log('     ' + r.key.padEnd(20) + (Number(r.bytes) / 1048576).toFixed(2) + ' MB');
  await timed('3. query with a parameter (small)', () => pool.query('SELECT key FROM kv_store WHERE key = $1', ['terminals']));
  await timed('4. read the users collection (this is what start-up does)', () => pool.query('SELECT value FROM kv_store WHERE key = $1', ['users']));
  await pool.end();
})();