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
app.use(cors({ origin: true })); // the frontend is a static file that can be opened from anywhere; restrict this later if you host it at a fixed domain
app.use(express.json({ limit: '25mb' })); // user ID photos / profile pictures are embedded as base64 data URLs

app.use(pagesRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/storage', storageRoutes);
app.use('/api/files', filesRoutes);
app.use('/api', systemRoutes);

app.use(errorHandler);

module.exports = app;