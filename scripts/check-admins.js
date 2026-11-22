// Read-only: lists every terminal staff account (role admin) with its department and terminal, so you can
// confirm each terminal Admin really has the "Admin" department.
//
//   node --env-file=.env scripts/check-admins.js

const { pool } = require('../src/config/db');

const SQL = `
SELECT u->>'name' AS name, u->>'login' AS login, u->>'department' AS department,
       u->>'terminalId' AS terminal, u->>'status' AS status
  FROM kv_store k, jsonb_array_elements(k.value) u
 WHERE k.key = 'users' AND jsonb_typeof(k.value) = 'array' AND u->>'role' = 'sctl'
 ORDER BY terminal, department, name`;

(async () => {
  try {
    const { rows } = await pool.query(SQL);
    console.table(rows);
    console.log(rows.length + ' staff account(s).');
  } catch (e) {
    console.error('Failed:', e.message);
  } finally {
    await pool.end();
  }
})();