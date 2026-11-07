const { deepEqual } = require('../utils/compare');
const { isSctl } = require('./role.policy');

function checkTerminalsWrite(oldArr, newArr, authUser) {
  oldArr = Array.isArray(oldArr) ? oldArr : [];
  if (!Array.isArray(newArr)) return 'Malformed terminal list.';
  if (!authUser) {
    // Only unauthenticated path: a brand-new bonded terminal self-registering
    // (pending SCTL approval), appending exactly one new pending terminal.
    if (newArr.length !== oldArr.length + 1) return 'Sign in required.';
    const oldById = new Map(oldArr.map(t => [t.id, t]));
    for (const t of newArr) {
      if (oldById.has(t.id) && !deepEqual(oldById.get(t.id), t)) return 'Sign in required.';
    }
    const added = newArr.find(t => !oldById.has(t.id));
    if (!added || added.status !== 'pending') return 'Sign in required.';
    return null;
  }
  if (isSctl(authUser)) return null;
  return 'Only SCTL can manage bonded terminals.';
}

module.exports = { checkTerminalsWrite };