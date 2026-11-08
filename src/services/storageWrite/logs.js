// Saving the activity log, referrals and messages. Returns { response } to refuse, or { parsed, versions }.

const { kvGet } = require('../../models/kv.model');
const { profileOf } = require('../../models/user.model');
const { checkMessageFiles } = require('../../policies/document.policy');
const { wantsReplace, validList } = require('../merge.helpers');
const { mergeLog } = require('../log.service');
const { checkAndMergeReferrals } = require('../referral.service');
const { checkAndMergeMessages } = require('../message.service');
const { refuse } = require('./refuse');

async function writeLogLike({ key, user, body, parsed }) {
  if (!user) return refuse(401, 'Sign in required.');
  if (!validList(parsed)) return refuse(400, 'Malformed data.');
  const full = (await kvGet(key)) || [];
  if (key === 'activity-log') {
    parsed = mergeLog(full, parsed, user, wantsReplace(body, user), await profileOf(user));
  } else {
    const profile = await profileOf(user);
    if (key === 'messages') { const fe = await checkMessageFiles(full, parsed, user); if (fe) return refuse(403, fe); }
    const r = key === 'referrals' ? checkAndMergeReferrals(full, parsed, user, profile, body) : checkAndMergeMessages(full, parsed, user, profile, body);
    if (r.error) return refuse(403, r.error);
    parsed = r.merged;
  }
  return { parsed, versions: {} };
}

module.exports = { writeLogLike };