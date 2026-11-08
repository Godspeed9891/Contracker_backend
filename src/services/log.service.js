// Moved verbatim from legacy.routes.js: how the activity log is merged on save (new entries are cleaned and
// stamped with the writer's terminal, people can only acknowledge entries, and nobody can delete history).

const { isStaffUser, logVisibleTo, stampTerminal } = require('../policies/visibility.policy');

const LOG_DEPTS = ['Admin', 'Documentation', 'DTI', 'Operations', 'Transport', 'Field Staff', 'Accountant'];

function mergeAck(stored, inc) {
  const ack = Array.isArray(stored.ack) ? stored.ack.slice() : [];
  if (Array.isArray(inc.ack)) for (const a of inc.ack) if (typeof a === 'string' && !ack.includes(a)) ack.push(a);
  return Object.assign({}, stored, { ack });
}
function mergeLog(full, parsed, user, replace, profile) {
  const stored = new Map(full.map(e => [e.id, e]));
  const incoming = new Map(parsed.map(e => [e.id, e]));
  const fresh = parsed.filter(e => !stored.has(e.id)).map(e => stampTerminal({
    id: e.id, msg: String(e.msg == null ? '' : e.msg).slice(0, 2000),
    t: isNaN(new Date(e.t)) ? new Date().toISOString() : e.t,
    dept: typeof e.dept === 'string' ? e.dept : null, ack: [], security: !!e.security,
    terminalId: e.terminalId === undefined ? null : e.terminalId
  }, user));
  if (!isStaffUser(user)) {   // importers / agents / customs: limited, and always labelled with their real name
    const label = (user.role || 'user') + ' ' + ((profile && profile.name) || 'unknown');
    fresh.splice(5);
    for (let i = 0; i < fresh.length; i++) {
      fresh[i] = Object.assign({}, fresh[i], { msg: '[' + label + '] ' + String(fresh[i].msg).slice(0, 300), security: false,
        dept: LOG_DEPTS.includes(fresh[i].dept) ? fresh[i].dept : null });
    }
  }
  let kept;
  if (replace) kept = full.filter(e => incoming.has(e.id)).map(e => mergeAck(e, incoming.get(e.id)));
  else kept = full.map(e => (logVisibleTo(user, e) && incoming.has(e.id)) ? mergeAck(e, incoming.get(e.id)) : e); // nobody else can delete history
  return fresh.concat(kept).slice(0, 1000);
}

module.exports = { LOG_DEPTS, mergeAck, mergeLog };