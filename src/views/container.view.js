const { canSeeStaffNotes, canSeeFinanceData } = require('../policies/container.policy');

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

// What this person is allowed to see of a stored job.
//  - staff-only comments go only to terminal staff and SCTL;
//  - the money: everyone except finance staff gets just the processing charge written at first entry.
function redactJobFor(user, c, profile) {
  let out = c;
  if (!canSeeStaffNotes(user) && Array.isArray(c.progressNotes) && c.progressNotes.some(n => n && n.staffOnly)) {
    out = Object.assign({}, out, { progressNotes: c.progressNotes.filter(n => !(n && n.staffOnly)) });
  }
  if (!canSeeFinanceData(user, profile)) {
    const f = c.financial || {};
    out = Object.assign({}, out, {
      financial: { processingCharge: Number(f.processingCharge) || 0, summaryOnly: true },
      invoices: invoicesFor(user, profile, c)
    });
  }
  return out;
}

module.exports = { redactJobFor, invoicesFor };