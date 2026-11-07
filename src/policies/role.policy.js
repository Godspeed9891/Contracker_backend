// Moved verbatim from the original server.js (lines 85-86): the two role checks used all over.

function isSctl(user) { return !!user && user.role === 'sctl'; }
function isTerminalAdmin(user) { return !!user && user.role === 'admin' && user.department === 'Admin' && !!user.terminalId; }

module.exports = { isSctl, isTerminalAdmin };
