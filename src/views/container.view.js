const { noteVisibleTo, canSeeFinanceData } = require('../policies/container.policy');

// Which invoices a person gets with a job. Finance staff (Admin / Accountant) see them all, in the job itself.
// An importer or agent sees only the invoices that were sent to them (approved) and the ones they uploaded themselves.
// Everyone else (other staff, SCTL, customs) sees none.
function invoicesFor(user, profile, c) {
  const all = Array.isArray(c.invoices) ? c.invoices : [];
  if (user && (user.role === 'importer' || user.role === 'agent')) {
    const me = profile && profile.name;
    return all.filter(i => i && (i.status === 'approved' || (me && i.uploadedBy === me)));
  }
  return [];
}

const CUSTOMS_ALERT_TYPES = ['DC Revenue', 'DC Valuation', 'T&T'];   // the only alerts a customs officer sees
const TRANSPORT_DOC_TYPES = ['Interchange', 'Other'];                // the only documents transport staff see (plus their own uploads)
const isTransport = user => !!user && user.role === 'admin' && user.department === 'Transport';
const hideParties = user => !!user && (user.role === 'customs' || user.role === 'sctl');   // they do not see who owns a job or clears it
function alertVisible(user, a) {
  if (isTransport(user)) return false;                                 // transport staff do not see alerts
  if (user && user.role === 'customs') return !!a && CUSTOMS_ALERT_TYPES.includes(a.type);
  return true;
}
function docVisible(user, profile, d) {
  if (!isTransport(user)) return true;
  return !!d && (TRANSPORT_DOC_TYPES.includes(d.type) || (!!profile && d.uploadedBy === profile.name));
}

// What this person is allowed to see of a stored job.
//  - comments: terminal staff see every section, importers/agents/customs only their own, SCTL none;
//  - the money: everyone except finance staff gets just the processing charge written at first entry.
function redactJobFor(user, c, profile) {
  let out = c;
  if (Array.isArray(c.progressNotes) && c.progressNotes.some(n => n && !noteVisibleTo(user, c, n))) {
    out = Object.assign({}, out, { progressNotes: c.progressNotes.filter(n => n && noteVisibleTo(user, c, n)) });
  }
  if (Array.isArray(c.alerts) && c.alerts.some(a => !alertVisible(user, a))) {
    out = Object.assign({}, out, { alerts: c.alerts.filter(a => alertVisible(user, a)) });
  }
  if (isTransport(user) && Array.isArray(c.documents) && c.documents.some(d => !docVisible(user, profile, d))) {
    out = Object.assign({}, out, { documents: c.documents.filter(d => docVisible(user, profile, d)) });
  }
  if (hideParties(user) && (c.owner || c.agent)) out = Object.assign({}, out, { owner: '', agent: '' });
  if (!canSeeFinanceData(user, profile)) {
    const f = c.financial || {};
    out = Object.assign({}, out, {
      financial: { processingCharge: Number(f.processingCharge) || 0, summaryOnly: true },
      invoices: invoicesFor(user, profile, c)
    });
  }
  return out;
}

module.exports = { redactJobFor, invoicesFor, isTransport, hideParties, alertVisible, docVisible };