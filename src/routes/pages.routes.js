// Serves the front-end pages from the same server as the API, so one link opens everything.
//   /          the landing page
//   /app       the right app for the device: phones get the mobile app, everything else the web app
//   /login     the app, on the sign-in screen      /signup   the app, on Create Account
//   /web       the web app      /m   the mobile app      /privacy   the privacy policy
// Each page is a single self-contained HTML file in /public.

const path = require('path');
const express = require('express');

const router = express.Router();
const PUBLIC = path.join(__dirname, '..', '..', 'public');
const page = file => (req, res) => {
  res.set('Cache-Control', 'no-cache'); // always fetch the latest version after an update
  res.sendFile(path.join(PUBLIC, file));
};
const isPhone = req => /Android|iPhone|iPod|Mobile/i.test(req.headers['user-agent'] || '');

router.get('/', page('index.html'));
router.get('/app', (req, res, next) => page(isPhone(req) ? 'mobile.html' : 'web.html')(req, res, next));
router.get('/login', (req, res) => res.redirect('/app#login'));
router.get('/signup', (req, res) => res.redirect('/app#signup'));
router.get('/web', page('web.html'));
router.get('/m', page('mobile.html'));
router.get('/privacy', page('privacy.html'));

module.exports = router;