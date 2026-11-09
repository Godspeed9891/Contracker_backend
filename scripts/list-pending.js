// Lists accounts waiting for approval and any pending terminals. Changes nothing.
// Run from the project folder:  node --env-file=.env scripts/list-pending.js

const { pool } = require('../src/config/db');

(async () => {
  const get = async key => { const r = await pool.query('SELECT value FROM kv_store WHERE key = $1', [key]); return r.rows.length && Array.isArray(r.rows[0].value) ? r.rows[0].value : []; };
  const users = await get('users'), terminals = await get('terminals');
  const pending = users.filter(u => u && u.status === 'pending_verification');
  console.log(users.length + ' accounts, ' + pending.length + ' waiting for approval');
  for (const u of pending) {
    const t = terminals.find(x => x.id === u.terminalId);
    console.log('  - ' + u.name + ' <' + u.login + '> role=' + u.role + (u.department ? '/' + u.department : '') +
      ' | new-terminal request: ' + (u.isNewTerminalAdmin ? 'yes' : 'no') +
      ' | terminal: ' + (t ? t.name + ' (' + t.status + ')' : '(none)') +
      ' | ID photo: ' + (u.idImage ? 'yes' : 'no'));
  }
  const pt = terminals.filter(t => t.status === 'pending');
  console.log(pt.length + ' terminal(s) with status pending' + pt.map(t => '\n  - ' + t.name).join(''));
  await pool.end();
})().catch(e => { console.error('Failed:', e.message); process.exit(1); });