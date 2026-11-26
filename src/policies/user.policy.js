const { deepEqual, looseEqual } = require("../utils/compare");
const { isSctl, isTerminalAdmin } = require("./role.policy");

const USER_DEFAULTS = { stationedAt: "BILBT Main Yard", status: "active" };
const SERVER_OWNED_USER_KEYS = new Set(["lastLoginDate", "lastLoginDevice"]); // written by the server at sign-in; a screen's copy may be a little stale
function sameUserRecord(a, b) {
  if (deepEqual(a, b)) return true;
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (SERVER_OWNED_USER_KEYS.has(k)) continue;
    if (looseEqual(a[k], b[k], k)) continue;
    if (
      (a[k] === undefined || a[k] === null) &&
      (k === "uniqueId" || USER_DEFAULTS[k] === b[k])
    )
      continue; // the app fills these in when it loads an old record
    return false;
  }
  return true;
}

// Fields that decide what a person is allowed to do. Nobody may change these on their OWN record (only SCTL can),
// a terminal Admin may change them on other accounts at their own terminal, and only SCTL may ever hand out the
// 'sctl' role or move an account to another terminal.
const PROTECTED_USER_KEYS = ["role", "department", "terminalId", "status", "grants"];
function protectedFieldChanged(oldU, newU) {
  return PROTECTED_USER_KEYS.some((k) => {
    if (
      (oldU[k] === undefined || oldU[k] === null) &&
      USER_DEFAULTS[k] === newU[k]
    )
      return false; // the app fills in the default status when it loads an old record
    return !looseEqual(oldU[k], newU[k], k);
  });
}

const OWN_PROTECTED = "You cannot change your own account type, department, terminal, status or permissions.";

const OWN_IDENTITY_KEYS = ['name', 'phone', 'login', 'email', 'org', 'stationedAt', 'uniqueId', 'idType', 'idFileName'];
function identityChanged(oldU, newU) {
  return OWN_IDENTITY_KEYS.some(k => {
    if (looseEqual(oldU[k], newU[k], k)) return false;
    if ((oldU[k] === undefined || oldU[k] === null) && (k === 'uniqueId' || USER_DEFAULTS[k] === newU[k])) return false;
    return true;
  });
}

function checkUsersWrite(oldArr, newArr, authUser) {
  oldArr = Array.isArray(oldArr) ? oldArr : [];
  if (!Array.isArray(newArr)) return "Malformed user list.";

  if (!authUser) {
    // Only unauthenticated path allowed: self-registration appending exactly
    // one new pending account (importer, agent, staff, or customs officer),
    // with every existing account left untouched.
    if (newArr.length !== oldArr.length + 1) return "Sign in required.";
    const oldById = new Map(oldArr.map((u) => [u.id, u]));
    for (const u of newArr) {
      if (oldById.has(u.id) && !deepEqual(oldById.get(u.id), u))
        return "Sign in required.";
    }
    const added = newArr.find((u) => !oldById.has(u.id));
    if (!added || added.status !== "pending_verification")
      return "Sign in required.";
    if (added.role === "sctl" || added.grants) return "Sign in required.";
    return null;
  }

  if (isSctl(authUser)) return null; // SCTL can do anything

  const oldById = new Map(oldArr.map((u) => [u.id, u]));
  const newById = new Map(newArr.map((u) => [u.id, u]));

  if (isTerminalAdmin(authUser)) {
    // May add, edit, suspend, or remove accounts at their OWN terminal only.
    // Any touched record (added, removed, or changed) must belong to it.
    const allIds = new Set([...oldById.keys(), ...newById.keys()]);
    for (const id of allIds) {
      const oldU = oldById.get(id),
        newU = newById.get(id);
      if (oldU && newU && sameUserRecord(oldU, newU)) continue; // unchanged
      const belongsToMyTerminal =
        (oldU && oldU.terminalId === authUser.terminalId) ||
        (newU && newU.terminalId === authUser.terminalId);
      if (!belongsToMyTerminal)
        return "You can only manage accounts at your own terminal.";
      if (newU) {
        // an added or changed account must stay at this terminal and can never become SCTL
        if (newU.terminalId !== authUser.terminalId)
          return "You can only manage accounts at your own terminal.";
        if (newU.role === "sctl") return "Only SCTL can create or change an SCTL account.";
      }
      if (id === authUser.id && oldU && newU && protectedFieldChanged(oldU, newU))
        return OWN_PROTECTED;
    }
    return null;
  }


  // Everyone else: may only ever change their own record, no add/remove, and never the fields that grant power.
  if (newArr.length !== oldArr.length)
    return "You do not have permission to add or remove accounts.";
  for (const [id, newU] of newById) {
    const oldU = oldById.get(id);
    if (!oldU) return "You do not have permission to add or remove accounts.";
    if (sameUserRecord(oldU, newU)) continue;
    if (id !== authUser.id) return "You can only update your own profile.";
    if (protectedFieldChanged(oldU, newU)) return OWN_PROTECTED;
    if (identityChanged(oldU, newU)) return 'Your name, sign-in email, phone and other details are changed by your terminal Admin (or SCTL). You can change your profile picture and ID card.';
  }
  return null;
}

module.exports = {
  USER_DEFAULTS,
  SERVER_OWNED_USER_KEYS,
  PROTECTED_USER_KEYS,
  sameUserRecord,
  protectedFieldChanged,
  checkUsersWrite,
};