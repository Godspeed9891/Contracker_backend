const { isTopUser } = require('../policies/visibility.policy');

// A save only removes something when the app says so explicitly ({deleted:[ids]}) — or a top-level admin
// replaces everything on purpose ({replace:true}, used by "reset demo data"). A list that is merely missing
// an item (because the person's screen was a second out of date) never deletes it.
function wantsReplace(body, user) { return !!body && body.replace === true && isTopUser(user); }
function restoreUndeleted(view, parsed, body, user) {
  if (wantsReplace(body, user)) return parsed;
  const del = new Set(Array.isArray(body && body.deleted) ? body.deleted.filter(x => typeof x === 'string') : []);
  const present = new Set(parsed.map(x => x.id));
  return parsed.concat(view.filter(v => !present.has(v.id) && !del.has(v.id)));
}
// Concurrent edits: every job / account carries a version number (_v) that only the server changes. The app tells
// the server which records it really edited ({changed:[ids]}). Records it did not edit are left exactly as stored
// (so a stale screen can never overwrite them), and an edited record whose version is out of date is refused
// with a clear message instead of silently overwriting someone else's change.
function changedIdSet(body, parsed) {
  return Array.isArray(body && body.changed) ? new Set(body.changed.filter(x => typeof x === 'string')) : new Set(parsed.map(x => x.id));
}
function applyChangedOnly(view, parsed, changed) {
  const viewMap = new Map(view.map(x => [x.id, x]));
  return parsed.map(n => (viewMap.has(n.id) && !changed.has(n.id)) ? viewMap.get(n.id) : n);
}
function findStale(view, parsed, changed) {
  const viewMap = new Map(view.map(x => [x.id, x]));
  return parsed.find(n => changed.has(n.id) && viewMap.has(n.id) && (n._v || 0) !== (viewMap.get(n.id)._v || 0));
}
function conflictMessage(what) {
  return what + ' was changed by someone else a moment ago, so your change was NOT saved. Your screen now shows the latest version — please make your change again.';
}
function validList(parsed) { return Array.isArray(parsed) && parsed.every(x => x && typeof x === 'object' && typeof x.id === 'string'); }

module.exports = { wantsReplace, restoreUndeleted, changedIdSet, applyChangedOnly, findStale, conflictMessage, validList };