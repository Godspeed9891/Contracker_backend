const { canSeeStaffNotes } = require('../policies/container.policy');

function redactJobFor(user, c) {
  if (canSeeStaffNotes(user) || !Array.isArray(c.progressNotes) || !c.progressNotes.some(n => n && n.staffOnly)) return c;
  return Object.assign({}, c, { progressNotes: c.progressNotes.filter(n => !(n && n.staffOnly)) });
}

module.exports = { redactJobFor };