// Sends the { status, body, changed } answer a service returns: first announces any collections that changed
// (WebSocket), then writes the HTTP response. Used by the controllers that have been thinned.

const { broadcastChanged } = require('../realtime/hub');

function send(res, result) {
  if (result.changed) result.changed.forEach(broadcastChanged);
  res.status(result.status).json(result.body);
}

module.exports = { send };