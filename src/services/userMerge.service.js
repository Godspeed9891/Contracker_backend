// Moved verbatim from legacy.routes.js (original server.js 478-495): merges a person's limited view of the
// users list back into the full stored list, so nobody can wipe out accounts they cannot see.

const { SERVER_OWNED_USER_KEYS, sameUserRecord } = require('../policies/user.policy');
const { canSeeIdImage } = require('../policies/visibility.policy');

function mergeUsers(full, view, parsed, user) {
  const visible = new Set(view.map(u => u.id)), fullIds = new Set(full.map(u => u.id));
  const incoming = new Map(parsed.map(u => [u.id, u]));
  const out = [];
  for (const c of full) {
    if (!visible.has(c.id)) { out.push(c); continue; }
    const n = incoming.get(c.id);
    if (!n) continue;
    const keep = {};
    for (const k of SERVER_OWNED_USER_KEYS) if (c[k] !== undefined) keep[k] = c[k];
    const merged = Object.assign({}, n, keep);
    merged._v = sameUserRecord(c, merged) ? (c._v || 0) : (c._v || 0) + 1;
    out.push(canSeeIdImage(user, c) ? merged : Object.assign({}, merged, { idImage: c.idImage === undefined ? null : c.idImage, idFileId: c.idFileId === undefined ? null : c.idFileId }));
  }
  for (const n of parsed) if (!fullIds.has(n.id)) out.push(Object.assign({}, n, { _v: 1 }));
  return out;
}

module.exports = { mergeUsers };