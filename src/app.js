// Moved from the original server.js (lines 64-67 and 1180): builds the Express app.
// Order is the same as before: security headers, CORS, JSON body parsing, routes, error handler.

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const authRoutes = require('./routes/auth.routes');
const legacy = require('./legacy/legacy.routes');
const errorHandler = require('./middleware/errorHandler');

const app = express();
app.use(helmet());
app.use(cors({ origin: true })); // the frontend is a static file that can be opened from anywhere; restrict this later if you host it at a fixed domain
app.use(express.json({ limit: '25mb' })); // user ID photos / profile pictures are embedded as base64 data URLs

app.use('/api/auth', authRoutes);

app.use(legacy.router); // temporary: every route that has not been moved into routes/ yet

app.use(errorHandler);

module.exports = app;
