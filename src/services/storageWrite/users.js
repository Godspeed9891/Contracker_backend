// Saving the `users` collection: who may add, edit or remove which accounts, with version checks and merging.
// Returns { response } to refuse the request, or { parsed, versions } to be saved.

const { kvGet } = require('../../models/kv.model');
const { checkUsersWrite } = require('../../policies/user.policy');
const { userVisibleTo } = require('../../policies/visibility.policy');
const { redactUserFor } = require('../../views/user.view');
const { wantsReplace, restoreUndeleted, changedIdSet, applyChangedOnly, findStale, conflictMessage, validList } = require('../merge.helpers');
const { mergeUsers } = require('../userMerge.service');
const { refuse } = require('./refuse');

async function writeUsers({ user, body, parsed }) {
  const versions = {};
  const old = (await kvGet('users')) || [];
  if (!user) {
    const err = checkUsersWrite(old, parsed, user);
    if (err) return refuse(401, err);
  } else {
    if (!validList(parsed)) return refuse(400, 'Malformed user list.');
    const view = old.filter(u => userVisibleTo(user, u)).map(u => redactUserFor(user, u));
    const visible = new Set(view.map(u => u.id)), oldIds = new Set(old.map(u => u.id));
    if (parsed.some(u => oldIds.has(u.id) && !visible.has(u.id))) return refuse(403, 'One of those accounts belongs to a record you do not have access to.');
    if (!wantsReplace(body, user)) {
      const changed = changedIdSet(body, parsed);
      parsed = applyChangedOnly(view, parsed, changed);
      const stale = findStale(view, parsed, changed);
      if (stale) return refuse(409, conflictMessage('The account for ' + (stale.name || 'that person')), { conflict: true });
    }
    parsed = restoreUndeleted(view, parsed, body, user);
    const mineIds = new Set(parsed.map(x => x.id));
    const err = checkUsersWrite(view, parsed, user);
    if (err) return refuse(403, err);
    parsed = mergeUsers(old, view, parsed, user);
    for (const x of parsed) if (mineIds.has(x.id)) versions[x.id] = x._v;
  }
  return { parsed, versions };
}

module.exports = { writeUsers };