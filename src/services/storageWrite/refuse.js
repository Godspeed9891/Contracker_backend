// The answer for a refused save: { response: { status, body } }. `extra` adds fields to the body (e.g. conflict: true).

const refuse = (status, message, extra) => ({ response: { status, body: Object.assign({ error: message }, extra) } });

module.exports = { refuse };