const { deepEqual } = require('../utils/compare');
const { isTopUser, referralVisibleTo, canEditReferralStatus } = require('../policies/visibility.policy');
const { restoreUndeleted } = require('./merge.helpers');

function checkAndMergeReferrals(full, parsed, user, profile, body) {
  const view = full.filter(r => referralVisibleTo(user, profile, r));
  parsed = restoreUndeleted(view, parsed, body, user);
  const visible = new Set(view.map(r => r.id)), fullIds = new Set(full.map(r => r.id));
  if (parsed.some(r => fullIds.has(r.id) && !visible.has(r.id))) return { error: 'One of those referrals belongs to someone else.' };
  const incoming = new Map(parsed.map(r => [r.id, r]));
  for (const r of view) {
    const n = incoming.get(r.id);
    if (!n) { if (!isTopUser(user)) return { error: 'Referrals cannot be deleted.' }; continue; }
    if (deepEqual(r, n)) continue;
    const keys = new Set([...Object.keys(r), ...Object.keys(n)]);
    for (const k of keys) {
      if (deepEqual(r[k], n[k])) continue;
      if (k === 'status' && canEditReferralStatus(user)) continue;
      return { error: 'You are not allowed to change that referral.' };
    }
  }
  for (const n of parsed) {
    if (fullIds.has(n.id)) continue;
    if (!profile || n.referrerName !== profile.name) return { error: 'A referral must be submitted under your own name.' };
    if (n.status !== 'pending') return { error: 'A new referral must start as pending.' };
  }
  const out = [];
  for (const c of full) {
    if (!visible.has(c.id)) { out.push(c); continue; }
    const n = incoming.get(c.id);
    if (!n) continue;
    out.push(canEditReferralStatus(user) ? Object.assign({}, c, { status: n.status }) : c);
  }
  for (const n of parsed) if (!fullIds.has(n.id)) out.push(n);
  return { merged: out };
}

module.exports = { checkAndMergeReferrals };