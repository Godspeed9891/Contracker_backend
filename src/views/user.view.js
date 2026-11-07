const { canSeeIdImage } = require('../policies/visibility.policy');

function redactUserFor(user, u) {
  if (canSeeIdImage(user, u) || !u.idImage) return u;
  return Object.assign({}, u, { idImage: null });
}

module.exports = { redactUserFor };