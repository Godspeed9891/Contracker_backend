// Merges a person's limited view of the jobs back into the full stored list, so a limited view can never wipe out jobs,
// staff-only comments, or the money figures and invoices they were not allowed to see.

const { DERIVED_CONTAINER_KEYS } = require('../constants/stages');
const { changedContainerKeys, canSeeStaffNotes, canSeeFinanceData } = require('../policies/container.policy');

function stripDerived(c) {
  const o = Object.assign({}, c);
  for (const k of DERIVED_CONTAINER_KEYS) delete o[k];
  return o;
}

// Someone who cannot see the money leaves the stored breakdown and invoices exactly as they were.
// (An importer or agent may still add their own new invoice, which has been checked already.)
function keepMoney(stored, next, user) {
  if (stored.financial === undefined) delete next.financial; else next.financial = stored.financial;
  const have = Array.isArray(stored.invoices) ? stored.invoices : [];
  if (user.role === 'importer' || user.role === 'agent') {
    const ids = new Set(have.map(i => i && i.id));
    const added = (Array.isArray(next.invoices) ? next.invoices : []).filter(i => i && !ids.has(i.id));
    next.invoices = have.concat(added);
  } else {
    next.invoices = have;
  }
}
// Finance staff never store the "summary only" view of the money.
function cleanMoney(next) {
  if (next.financial && typeof next.financial === 'object' && !Array.isArray(next.financial)) {
    const f = Object.assign({}, next.financial);
    delete f.summaryOnly; delete f.expenses;
    next.financial = f;
  }
}
// A brand-new job from someone without finance access keeps only its first-entry processing charge.
function firstEntryMoney(n) {
  const pc = Number(n.financial && n.financial.processingCharge);
  n.financial = { processingCharge: Number.isFinite(pc) && pc >= 0 ? pc : 0 };
  n.invoices = [];
}

function mergeContainers(full, oldView, parsed, user, profile) {
  const visibleIds = new Set(oldView.map(c => c.id));
  const fullIds = new Set(full.map(c => c.id));
  const incoming = new Map(parsed.map(c => [c.id, c]));
  const sees = canSeeFinanceData(user, profile);
  const out = [];
  for (const c of full) {
    if (!visibleIds.has(c.id)) { out.push(c); continue; }   // not theirs: untouched
    const n = incoming.get(c.id);
    if (!n) continue;                                          // deleted (already permission-checked)
    const next = stripDerived(n);
    if (sees) cleanMoney(next); else keepMoney(c, next, user);
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
  for (const n of parsed) {
    if (fullIds.has(n.id)) continue;
    const x = stripDerived(n);
    if (sees) cleanMoney(x); else firstEntryMoney(x);
    out.push(Object.assign(x, { _v: 1 }));
  }
  return out;
}

module.exports = { stripDerived, mergeContainers };