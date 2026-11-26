// Merges a person's limited view of the jobs back into the full stored list, so a limited view can never wipe out jobs,
// staff-only comments, or the money figures and invoices they were not allowed to see.

const { DERIVED_CONTAINER_KEYS } = require('../constants/stages');
const { changedContainerKeys, noteVisibleTo, canSeeFinanceData } = require('../policies/container.policy');
const { isTransport, hideParties, alertVisible, docVisible } = require('../views/container.view');

// Put back the items of a list that this person was never shown. Everything they could see takes the version they sent
// (or is removed if they dropped it); stored order is kept and brand-new items go on the end.
function mergeList(stored, sent, hidden) {
  stored = Array.isArray(stored) ? stored : [];
  sent = Array.isArray(sent) ? sent : [];
  if (!stored.some(hidden)) return sent;
  const sentById = new Map(sent.filter(x => x && x.id).map(x => [x.id, x]));
  const storedIds = new Set(stored.filter(x => x && x.id).map(x => x.id));
  const out = [];
  for (const s of stored) {
    if (hidden(s) || !s || !s.id) out.push(s);
    else if (sentById.has(s.id)) out.push(sentById.get(s.id));
  }
  for (const x of sent) if (!(x && x.id && storedIds.has(x.id))) out.push(x);
  return out;
}

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
    next.progressNotes = mergeList(c.progressNotes, next.progressNotes, x => !noteVisibleTo(user, c, x));   // sections they never saw
    if (Array.isArray(c.alerts) || Array.isArray(next.alerts)) next.alerts = mergeList(c.alerts, next.alerts, a => !alertVisible(user, a));
    if (isTransport(user)) next.documents = mergeList(c.documents, next.documents, d => !docVisible(user, profile, d));
    if (hideParties(user)) { next.owner = c.owner; next.agent = c.agent; }
    next._v = changedContainerKeys(c, next).filter(k => k !== '_v').length ? (c._v || 0) + 1 : (c._v || 0);   // after everything is put back
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