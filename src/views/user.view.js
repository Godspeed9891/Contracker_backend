const { canSeeIdImage } = require('../policies/visibility.policy');

function redactUserFor(user, u) {
  if (canSeeIdImage(user, u) || (!u.idImage && !u.idFileId)) return u;
  return Object.assign({}, u, { idImage: null, idFileId: null });
}

module.exports = { redactUserFor };