const { deepEqual } = require('../utils/compare');
const { isSctl, isTerminalAdmin } = require('./role.policy');

const TERMINAL_EDITABLE = ['name', 'address', 'freeDays', 'dailyPenaltyRate', 'deptStageAccess'];
const STAGE_COUNT = 15;
const STAGE_DEPTS = ['Documentation', 'DTI', 'Field Staff', 'Operations', 'Transport', 'Accountant'];
const okNumber = v => v === undefined || (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1e9);

// A terminal's own Admin may edit its details and which stages each department may move jobs to. Nothing else.
function checkOwnTerminalEdit(oldArr, newArr, user) {
  if (newArr.length !== oldArr.length) return 'Only SCTL can add or remove bonded terminals.';
  const oldById = new Map(oldArr.map(t => [t.id, t]));
  for (const t of newArr) {
    const prev = oldById.get(t.id);
    if (!prev) return 'Only SCTL can add or remove bonded terminals.';
    if (deepEqual(prev, t)) continue;
    if (t.id !== user.terminalId) return 'You can only change your own terminal.';
    for (const k of new Set([...Object.keys(prev), ...Object.keys(t)])) {
      if (TERMINAL_EDITABLE.includes(k)) continue;
      if (!deepEqual(prev[k], t[k])) return 'Only SCTL can change the ' + k + ' of a terminal.';
    }
    if (typeof t.name !== 'string' || !t.name.trim() || t.name.length > 200) return 'The terminal needs a name.';
    if (typeof t.address !== 'string' || !t.address.trim() || t.address.length > 300) return 'The terminal needs an address.';
    if (!okNumber(t.freeDays) || !okNumber(t.dailyPenaltyRate)) return 'Free days and the penalty rate must be numbers, zero or more.';
    if (t.deptStageAccess !== undefined) {
      const a = t.deptStageAccess;
      if (!a || typeof a !== 'object' || Array.isArray(a)) return 'Invalid stage access.';
      for (const [dept, list] of Object.entries(a)) {
        if (!STAGE_DEPTS.includes(dept)) return 'Unknown department in stage access.';
        if (!Array.isArray(list) || list.some(n => !Number.isInteger(n) || n < 0 || n >= STAGE_COUNT)) return 'Invalid stage list for ' + dept + '.';
      }
    }
  }
  return null;
}

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
  if (isTerminalAdmin(authUser)) return checkOwnTerminalEdit(oldArr, newArr, authUser);
  return 'Only SCTL can manage bonded terminals.';
}

module.exports = { checkTerminalsWrite };