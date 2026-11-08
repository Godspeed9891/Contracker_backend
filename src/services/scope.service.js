// Moved verbatim from legacy.routes.js (original server.js 466-472): what each signed-in person is
// allowed to see of users, activity-log, referrals and messages.

const { profileOf } = require('../models/user.model');
const { userVisibleTo, logVisibleTo, referralVisibleTo, messageVisibleTo } = require('../policies/visibility.policy');
const { redactUserFor } = require('../views/user.view');

async function scopedView(key, user, full) {
  const profile = await profileOf(user);
  if (key === 'users') return full.filter(u => userVisibleTo(user, u)).map(u => redactUserFor(user, u));
  if (key === 'activity-log') return full.filter(e => logVisibleTo(user, e));
  if (key === 'referrals') return full.filter(r => referralVisibleTo(user, profile, r));
  return full.filter(m => messageVisibleTo(user, profile, m)); // messages
}

module.exports = { scopedView };