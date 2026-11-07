// Moved verbatim from the original server.js (lines 461-464): looks a signed-in user up in the
// stored `users` collection. More user queries will join it here as the users slice is migrated.

const { kvGet } = require('./kv.model');

async function profileOf(user) {
  const users = (await kvGet('users')) || [];
  return users.find(u => u.id === user.id) || null;
}

module.exports = { profileOf };
