// Moved from the original server.js (lines 64-67 and 1180): builds the Express app.
// Order is the same as before: security headers, CORS, JSON body parsing, routes, error handler.

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const authRoutes = require('./routes/auth.routes');
const storageRoutes = require('./routes/storage.routes');
const filesRoutes = require('./routes/files.routes');
const systemRoutes = require('./routes/system.routes');
const errorHandler = require('./middleware/errorHandler');
const pagesRoutes = require('./routes/pages.routes');

const app = express();
// Behind a host's proxy (Render, Railway) set TRUST_PROXY=1 so the real visitor address is used for rate limiting;
// with no proxy leave it unset, otherwise anyone could fake their address with a header.
app.set('trust proxy', Number(process.env.TRUST_PROXY || 0));
// The front-end pages are single HTML files with their own inline <script>, <style> and onclick="..." handlers, so
// those must be allowed; they also load Google Fonts and use data: icons. Everything else stays locked to this site.
const csp = helmet.contentSecurityPolicy.getDefaultDirectives();
app.use(helmet({
  contentSecurityPolicy: {
    directives: Object.assign(csp, {
      'script-src': ["'self'", "'unsafe-inline'"],
      'script-src-attr': ["'unsafe-inline'"],
      'style-src': ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      'font-src': ["'self'", 'https://fonts.gstatic.com', 'data:'],
      'img-src': ["'self'", 'data:', 'blob:'],
      'connect-src': ["'self'", 'ws:', 'wss:'],
      'manifest-src': ["'self'", 'data:'],
      'upgrade-insecure-requests': null
    })
  }
}));
// Which other websites may talk to this server. The app and the API are on the same address, so this normally stays
// empty; add a comma-separated list on Render (ALLOWED_ORIGINS) only if you ever host a page somewhere else.
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim().replace(/\/+$/, '')).filter(Boolean);
app.use(cors({ origin: (origin, cb) => cb(null, !origin || allowedOrigins.includes(origin)), credentials: true }));

// Cookies are sent automatically, so a request that changes data must come from this site (or an allowed one).
// Browsers always say where a POST/PUT/DELETE came from; tools like curl send nothing and are not affected.
app.use('/api', (req, res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const origin = req.headers.origin;
  if (!origin) return next();
  let host = '';
  try { host = new URL(origin).host; } catch (e) { return res.status(403).json({ error: 'Request blocked.' }); }
  if (host === req.headers.host || allowedOrigins.includes(origin)) return next();
  return res.status(403).json({ error: 'Request blocked.' });
});
app.use(pagesRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/storage', storageRoutes);
app.use('/api/files', filesRoutes);
app.use('/api', systemRoutes);

app.use(errorHandler);

module.exports = app;