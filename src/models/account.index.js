// An in-memory list of every account's current role, department, terminal and status, kept up to date whenever
// the `users` collection is saved (see kv.model.js) and loaded once at start-up (see server.js).
// The sign-in token only proves who someone is; this list says what they are allowed to do RIGHT NOW,
// so a suspended, deleted or demoted account loses access on its next request instead of when its token expires.
// It lives in this server's memory: if you ever run several copies of the server they would need a shared store.

let index = new Map();

function rebuild(users) {
  const next = new Map();
  for (const u of Array.isArray(users) ? users : []) {
    if (u && u.id) next.set(u.id, { role: u.role, department: u.department, terminalId: u.terminalId, status: u.status });
  }
  index = next;
}

function lookup(id) {
  return index.get(id);
}

module.exports = { rebuild, lookup };