// Moved from the original server.js (lines 645-668): live push over WebSocket.
// Only change: the WebSocket server is created inside attach(server), because the HTTP server
// now lives in server.js. The connection handler and broadcastChanged are unchanged.

const { WebSocketServer } = require("ws");
const { userFromToken } = require("../utils/token");
const { JWT_SECRET } = require("../config/env");

const sockets = new Set();

function attach(server) {
  const wss = new WebSocketServer({ server, path: "/ws" });

  wss.on("connection", (ws, req) => {
    try {
      const url = new URL(req.url, "http://x");
      const token = url.searchParams.get("token");
      if (!userFromToken(token)) throw new Error("not signed in");
    } catch (e) {
      ws.close(4001, "Unauthorized");
      return;
    }
    sockets.add(ws);
    ws.on("close", () => sockets.delete(ws));
  });
}

function broadcastChanged(key) {
  const msg = JSON.stringify({ type: "changed", key });
  for (const ws of sockets) {
    if (ws.readyState === 1) ws.send(msg);
  }
}

module.exports = { attach, broadcastChanged };
