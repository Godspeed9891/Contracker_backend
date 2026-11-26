const { isSctl } = require('./role.policy');

// Finance activity belongs to the terminal's Accounts department; SCTL does not see it.
const FINANCE_LOG_RE = /^(Financial breakdown updated|Duty payment recorded|Invoice uploaded|Invoice on .* (approved|rejected)|Invoice payment status)/;
function isFinanceLog(e) { return !!e && (e.dept === 'Accountant' || FINANCE_LOG_RE.test(String(e.msg || ''))); }
const isAccountsUser = u => !!u && u.role === 'admin' && u.department === 'Accountant';

function isStaffUser(u) { return !!u && (u.role === 'admin' || u.role === 'sctl'); }
function isTopUser(u) { return isSctl(u); }
const COMMENT_LOG_RE = /^(Progress note on|Comment on .* edited|A comment on .* deleted)/;
function logVisibleTo(user, e) {
  if (isSctl(user)) return !isFinanceLog(e) && !COMMENT_LOG_RE.test(String(e.msg || ''));
  if (user.role === 'admin' && user.department === 'Transport') return false;   // Transport staff do not see the Activity Log
  return user.role === 'admin' && e.terminalId === user.terminalId;
}
function userVisibleTo(user, u) {
  if (u.id === user.id) return true;
  if (isSctl(user)) return !isAccountsUser(u);
  return user.role === 'admin' && u.terminalId === user.terminalId;
}
function canSeeIdImage(user, u) {
  return isSctl(user) || u.id === user.id || (user.role === 'admin' && user.department === 'Admin' && u.terminalId === user.terminalId);
}
const isTerminalAdminUser = u => !!u && u.role === 'admin' && u.department === 'Admin' && !!u.terminalId;
function referralVisibleTo(user, profile, r) {
  return (!!profile && r.referrerName === profile.name) || (isTerminalAdminUser(user) && !!r.terminalId && r.terminalId === user.terminalId);
}
function canEditReferralStatus(user, r) { return isTerminalAdminUser(user) && (!r || r.terminalId === user.terminalId); }
function channelAllowed(user, profile, channel, m) {
  if (typeof channel !== 'string') return false;
  if (isSctl(user)) return true;
  if (channel.startsWith('internal:')) return user.role === 'admin' && channel.slice(9) === user.terminalId;
  if (channel.startsWith('customs:')) {
    const rest = channel.slice(8), i = rest.indexOf(':');
    const tid = i < 0 ? rest : rest.slice(0, i), who = i < 0 ? null : rest.slice(i + 1);
    if (user.role === 'customs') return !!who && !!profile && who === profile.name;
    return user.role === 'admin' && tid === user.terminalId;
  }
  if (channel.startsWith('client:')) {
    if (user.role === 'admin') return !m || !m.terminalId || m.terminalId === user.terminalId;
    return !!profile && (user.role === 'importer' || user.role === 'agent') && profile.name === channel.slice(7);
  }
  return false;
}
function stampTerminal(e, user) { return isSctl(user) ? e : Object.assign({}, e, { terminalId: user.terminalId || null }); }
function messageVisibleTo(user, profile, m) { return channelAllowed(user, profile, m.channel, m); }

module.exports = {
  isStaffUser, isTopUser, logVisibleTo, userVisibleTo, canSeeIdImage, isFinanceLog,
  referralVisibleTo, canEditReferralStatus, channelAllowed, stampTerminal, messageVisibleTo
};