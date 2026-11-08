// Boot only. Moved from the original server.js (line 646 and lines 1186-1195):
// create the HTTP server, attach WebSocket, prepare the schema, start listening.

const http = require('http');
const { PORT } = require('./src/config/env');
const { initSchema } = require('./src/config/db');
const { kvGet } = require('./src/models/kv.model');
const accounts = require('./src/models/account.index');
const app = require('./src/app');
const hub = require('./src/realtime/hub');
const { cleanupOrphanFiles } = require('./src/services/file.service');

// Last safety net: a stray error outside a request (a timer, a WebSocket handler) is logged instead of
// taking the whole server down.
process.on('unhandledRejection', err => console.error('Unhandled rejection:', err));

const server = http.createServer(app);
hub.attach(server);

initSchema()
  .then(async () => {
    accounts.rebuild(await kvGet('users')); // who is allowed to do what, kept in memory (see models/account.index.js)
    setTimeout(cleanupOrphanFiles, 60 * 1000).unref();
    setInterval(cleanupOrphanFiles, 6 * 3600 * 1000).unref();
    server.listen(PORT, () => console.log(`ConTracker backend listening on :${PORT}`));
  })
  .catch(err => {
    console.error('Failed to initialize database schema:', err);
    process.exit(1);
  });