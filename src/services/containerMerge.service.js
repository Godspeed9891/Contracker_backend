// Moved verbatim from legacy.routes.js: merges a person's limited view of the jobs back into the full
// stored list, so a limited view can never wipe out jobs or staff-only comments they could not see.

const { DERIVED_CONTAINER_KEYS } = require('../constants/stages');
const { changedContainerKeys, canSeeStaffNotes } = require('../policies/container.policy');

function stripDerived(c) {
  const o = Object.assign({}, c);
  for (const k of DERIVED_CONTAINER_KEYS) delete o[k];
  return o;
}
function mergeContainers(full, oldView, parsed, user) {
  const visibleIds = new Set(oldView.map(c => c.id));
  const fullIds = new Set(full.map(c => c.id));
  const incoming = new Map(parsed.map(c => [c.id, c]));
  const out = [];
  for (const c of full) {
    if (!visibleIds.has(c.id)) { out.push(c); continue; }   // not theirs: untouched
    const n = incoming.get(c.id);
    if (!n) continue;                                          // deleted (already permission-checked)
    const next = stripDerived(n);
    next._v = changedContainerKeys(c, next).filter(k => k !== '_v').length ? (c._v || 0) + 1 : (c._v || 0);
    if (!canSeeStaffNotes(user)) {                             // put back staff-only comments they never saw
      const hidden = (c.progressNotes || []).filter(x => x && x.staffOnly);
      if (hidden.length) {
        const keep = next.progressNotes || [];
        next.progressNotes = keep.concat(hidden.filter(h => !keep.some(k => k && k.id && k.id === h.id)))
          .sort((a, b) => new Date(a.date || 0) - new Date(b.date || 0));
      }
    }
    out.push(next);
  }
  for (const n of parsed) if (!fullIds.has(n.id)) out.push(Object.assign(stripDerived(n), { _v: 1 }));
  return out;
}

module.exports = { stripDerived, mergeContainers };