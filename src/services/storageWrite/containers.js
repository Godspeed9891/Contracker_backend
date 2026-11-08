// Saving the `containers` (jobs) collection: visibility, version checks, role rules, document rules, merging.
// Returns { response } to refuse the request, or { parsed, versions } to be saved.

const { kvGet } = require('../../models/kv.model');
const { checkContainersWrite } = require('../../policies/container.policy');
const { checkDocumentChanges } = require('../../policies/document.policy');
const { wantsReplace, restoreUndeleted, changedIdSet, applyChangedOnly, findStale, conflictMessage } = require('../merge.helpers');
const { containersViewFor } = require('../containerView.service');
const { mergeContainers } = require('../containerMerge.service');
const { refuse } = require('./refuse');

async function writeContainers({ user, body, parsed }) {
  const versions = {};
  if (!user) return refuse(401, 'Sign in required.');
  if (!Array.isArray(parsed) || parsed.some(c => !c || typeof c !== 'object' || typeof c.id !== 'string')) {
    return refuse(400, 'Malformed container list.');
  }
  const full = (await kvGet('containers')) || [];
  const { profile, view: oldView } = await containersViewFor(user, full);
  const visibleIds = new Set(oldView.map(c => c.id));
  const fullIds = new Set(full.map(c => c.id));
  if (parsed.some(c => fullIds.has(c.id) && !visibleIds.has(c.id))) {
    return refuse(403, 'One of those jobs belongs to a record you do not have access to.');
  }
  if (wantsReplace(body, user)) return refuse(403, 'SCTL can view jobs but cannot change them. Only the bonded terminal\'s own staff can.');
  const replaceAll = false;
  if (!replaceAll) {
    const changed = changedIdSet(body, parsed);
    parsed = applyChangedOnly(oldView, parsed, changed);
    const stale = findStale(oldView, parsed, changed);
    if (stale) return refuse(409, conflictMessage('Job ' + stale.containerNumber), { conflict: true });
    parsed = restoreUndeleted(oldView, parsed, body, user);
  }
  const mineIds = new Set(parsed.map(x => x.id));
  const err = replaceAll ? null : await checkContainersWrite(oldView, parsed, user, profile);
  if (err) return refuse(403, err);
  if (!replaceAll) {
    const derr = await checkDocumentChanges(oldView, parsed, user, profile);
    if (derr) return refuse(403, derr);
  }
  parsed = mergeContainers(full, oldView, parsed, user);
  for (const x of parsed) if (mineIds.has(x.id)) versions[x.id] = x._v;
  return { parsed, versions };
}

module.exports = { writeContainers };