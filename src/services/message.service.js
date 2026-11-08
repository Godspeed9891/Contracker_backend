const { deepEqual } = require('../utils/compare');
const { isTopUser, messageVisibleTo, channelAllowed, stampTerminal } = require('../policies/visibility.policy');
const { restoreUndeleted } = require('./merge.helpers');

function checkAndMergeMessages(full, parsed, user, profile, body) {
  const view = full.filter(m => messageVisibleTo(user, profile, m));
  parsed = restoreUndeleted(view, parsed, body, user);
  const visible = new Set(view.map(m => m.id)), fullIds = new Set(full.map(m => m.id));
  if (parsed.some(m => fullIds.has(m.id) && !visible.has(m.id))) return { error: 'One of those messages belongs to a conversation you are not in.' };
  const incoming = new Map(parsed.map(m => [m.id, m]));
  for (const m of view) {
    const n = incoming.get(m.id);
    if (!n) { if (!isTopUser(user)) return { error: 'Messages cannot be deleted.' }; continue; }
    if (!deepEqual(m, n) && !isTopUser(user)) return { error: 'Messages cannot be edited.' };
  }
  const added = [];
  for (const n of parsed) {
    if (fullIds.has(n.id)) continue;
    if (!profile || n.from !== profile.name) return { error: 'A message must be sent under your own name.' };
    if (!channelAllowed(user, profile, n.channel, null)) return { error: 'You are not part of that conversation.' };
    added.push(stampTerminal(n, user));
  }
  const out = [];
  for (const c of full) {
    if (!visible.has(c.id)) { out.push(c); continue; }
    const n = incoming.get(c.id);
    if (!n) continue;
    out.push(isTopUser(user) ? n : c);
  }
  return { merged: out.concat(added) };
}

module.exports = { checkAndMergeMessages };