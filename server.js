// Boot only: create the HTTP server, attach WebSocket, prepare the schema, start listening.
// This version prints each boot step so a stalled start-up shows exactly where it stopped.

const http = require('http');
const { PORT, DATABASE_URL } = require('./src/config/env');
const { initSchema } = require('./src/config/db');
const { accountSummaries } = require('./src/models/user.model');
const accounts = require('./src/models/account.index');
const app = require('./src/app');
const hub = require('./src/realtime/hub');
const { cleanupOrphanFiles } = require('./src/services/file.service');

// Last safety net: a stray error outside a request (a timer, a WebSocket handler) is logged instead of
// taking the whole server down.
process.on('unhandledRejection', err => console.error('Unhandled rejection:', err));
process.on('uncaughtException', err => { console.error('Uncaught exception:', err); process.exit(1); });

let dbHost = '(unreadable DATABASE_URL)';
try { dbHost = new URL(DATABASE_URL).host; } catch (_) {}
console.log('Starting. Port ' + PORT + ', database host ' + dbHost);

let step = 'creating the server';
const watchdog = setTimeout(() => console.error('Still stuck at: ' + step + ' (more than 20 seconds).'), 20000);

const server = http.createServer(app);
hub.attach(server);
server.on('error', err => { console.error('The server could not listen on port ' + PORT + ':', err.message); process.exit(1); });

(async () => {
  step = 'preparing the database schema';
  await initSchema();

  step = 'loading the accounts list';
  accounts.rebuild(await accountSummaries()); // who is allowed to do what, kept in memory (see models/account.index.js)
  console.log('Accounts loaded.');

  setTimeout(cleanupOrphanFiles, 60 * 1000).unref();
  setInterval(cleanupOrphanFiles, 6 * 3600 * 1000).unref();

  step = 'opening port ' + PORT;
  server.listen(PORT, () => {
    clearTimeout(watchdog);
    console.log(`ConTracker backend listening on :${PORT}`);
  });
})().catch(err => {
  console.error('Failed while ' + step + ':', err);
  process.exit(1);
});