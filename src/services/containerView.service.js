const { kvGet } = require('../models/kv.model');
const { profileOf } = require('../models/user.model');
const { jobVisibleTo } = require('../policies/container.policy');
const { redactJobFor } = require('../views/container.view');

// Duplicate registrations across terminals are worked out here, where every terminal's jobs are visible,
// and sent to each terminal as a flag (terminal names only — never the other terminal's job).
async function withDuplicateFlags(full, view) {
  const terminals = (await kvGet('terminals')) || [];
  const nameOf = id => (terminals.find(t => t.id === id) || {}).name || 'another terminal';
  const groups = {};
  for (const c of full) {
    if (c.archived) continue;
    for (const [kind, val] of [['cnum', c.containerNumber], ['bol', c.billOfLading]]) {
      if (!val) continue;
      const key = kind + ':' + String(val).toUpperCase();
      (groups[key] = groups[key] || []).push(c);
    }
  }
  const flags = new Map();
  for (const group of Object.values(groups)) {
    if (new Set(group.map(c => c.terminalId)).size < 2) continue;
    for (const c of group) {
      const others = group.filter(x => x.terminalId !== c.terminalId);
      const prev = flags.get(c.id);
      const names = [...new Set(others.map(o => nameOf(o.terminalId)))];
      flags.set(c.id, { terminalNames: prev ? [...new Set(prev.terminalNames.concat(names))] : names, otherIds: [] });
    }
  }
  return view.map(c => flags.has(c.id) ? Object.assign({}, c, { duplicateFlag: flags.get(c.id) }) : Object.assign({}, c, { duplicateFlag: null }));
}

async function containersViewFor(user, full) {
  const profile = await profileOf(user);
  const view = full.filter(c => jobVisibleTo(user, profile, c)).map(c => redactJobFor(user, c));
  return { profile, view: await withDuplicateFlags(full, view) };
}

module.exports = { withDuplicateFlags, containersViewFor };