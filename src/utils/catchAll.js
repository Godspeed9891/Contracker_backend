// Express 4 does not catch errors thrown (or rejected promises) inside async route handlers: the request hangs
// and, on current Node, the unhandled rejection can stop the whole server. catchAll wraps every handler of a
// controller so that any error goes to the error handler (middleware/errorHandler.js) and the person gets a
// proper 500 answer instead.

const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function catchAll(handlers) {
  const wrapped = {};
  for (const [name, fn] of Object.entries(handlers)) wrapped[name] = typeof fn === 'function' ? wrap(fn) : fn;
  return wrapped;
}

module.exports = { catchAll };