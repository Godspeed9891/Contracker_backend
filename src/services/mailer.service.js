// Sends email. Which service does the sending is chosen by settings, so changing provider later means changing this
// one file and .env, nothing else.
//
// Render's free plan blocks the normal mail ports (SMTP), so on Render use one of the two web-based senders:
//   MAIL_PROVIDER=gmail-api   sends through the Gmail API over HTTPS. Needs GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET,
//                             GMAIL_REFRESH_TOKEN and GMAIL_USER (the sending Gmail address)
//   MAIL_PROVIDER=resend      sends through Resend over HTTPS. Needs RESEND_API_KEY and MAIL_FROM
//                             (until you verify a domain, Resend only delivers to the address on your Resend account)
// For your own computer:
//   MAIL_PROVIDER=gmail       Gmail over SMTP. Needs GMAIL_USER and GMAIL_APP_PASSWORD (does NOT work on Render free)
//   MAIL_PROVIDER=console     prints the email in the server window instead of sending it (local testing only)
//   MAIL_PROVIDER=json        like console, for automated tests
//   MAIL_FROM                 optional sender, e.g.  ConTracker <you@gmail.com>
// With no MAIL_PROVIDER the first complete set of settings wins (gmail-api, then resend, then gmail); with none the
// console is used on a developer machine and a clear error in production.

const nodemailer = require('nodemailer');

const TOKEN_URL = process.env.GMAIL_TOKEN_URL || 'https://oauth2.googleapis.com/token';
const GMAIL_SEND_URL = process.env.GMAIL_SEND_URL || 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send';
const RESEND_URL = process.env.RESEND_URL || 'https://api.resend.com/emails';
const TIMEOUT_MS = 20000;

function chosenProvider() {
  const e = process.env;
  if (e.MAIL_PROVIDER) return e.MAIL_PROVIDER.toLowerCase();
  if (e.GMAIL_CLIENT_ID && e.GMAIL_CLIENT_SECRET && e.GMAIL_REFRESH_TOKEN && e.GMAIL_USER) return 'gmail-api';
  if (e.RESEND_API_KEY) return 'resend';
  if (e.GMAIL_USER && e.GMAIL_APP_PASSWORD) return 'gmail';
  return e.NODE_ENV === 'production' ? 'none' : 'console';
}

// Reads a setting and removes stray spaces, new lines and quote marks that often sneak in when it is pasted.
function setting(name) { return String(process.env[name] || '').trim().replace(/^["']+|["']+$/g, '').trim(); }

// Describes the Google settings WITHOUT revealing them, to help find a copy-and-paste mistake.
function googleSettingsHint() {
  const id = setting('GMAIL_CLIENT_ID'), secret = setting('GMAIL_CLIENT_SECRET'), rt = setting('GMAIL_REFRESH_TOKEN');
  const notes = [];
  if (!id.endsWith('.apps.googleusercontent.com')) notes.push('GMAIL_CLIENT_ID does not end with .apps.googleusercontent.com');
  if (!secret.startsWith('GOCSPX-')) notes.push('GMAIL_CLIENT_SECRET does not start with GOCSPX-');
  if (rt.startsWith('ya29.')) notes.push('GMAIL_REFRESH_TOKEN looks like an ACCESS token (starts with ya29.), use the refresh token');
  else if (!rt.startsWith('1//')) notes.push('GMAIL_REFRESH_TOKEN does not start with 1//');
  if (/\s/.test(rt) || /\s/.test(id) || /\s/.test(secret)) notes.push('a value contains a space or new line inside it');
  return 'lengths: id=' + id.length + ' secret=' + secret.length + ' refresh=' + rt.length + (notes.length ? ' | check: ' + notes.join('; ') : ' | formats look normal, so the token and client probably do not belong together');
}

function notConfigured(what) { const err = new Error(what + ' is not configured.'); err.code = 'MAIL_NOT_CONFIGURED'; return err; }

// ---- Gmail over SMTP (local use) ----
let smtp = null;
function gmailSmtp() {
  if (!smtp) {
    smtp = nodemailer.createTransport({
      host: 'smtp.gmail.com', port: 465, secure: true,
      auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD },
      connectionTimeout: 15000, socketTimeout: 20000
    });
  }
  return smtp;
}

// ---- Gmail API over HTTPS ----
let cachedToken = null; // { value, expiresAt }
async function gmailAccessToken() {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60000) return cachedToken.value;
  const e = process.env;
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: setting('GMAIL_CLIENT_ID'), client_secret: setting('GMAIL_CLIENT_SECRET'), refresh_token: setting('GMAIL_REFRESH_TOKEN'), grant_type: 'refresh_token' }),
    signal: AbortSignal.timeout(TIMEOUT_MS)
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) throw new Error('Google refused the sign-in token (' + res.status + ' ' + (body.error || '') + ' ' + (body.error_description || '') + ') [' + googleSettingsHint() + ']');
  cachedToken = { value: body.access_token, expiresAt: Date.now() + (Number(body.expires_in) || 3000) * 1000 };
  return cachedToken.value;
}
async function sendGmailApi({ from, to, subject, text, html }) {
  const e = process.env;
  if (!(setting('GMAIL_CLIENT_ID') && setting('GMAIL_CLIENT_SECRET') && setting('GMAIL_REFRESH_TOKEN'))) throw notConfigured('The Gmail API');
  // nodemailer only builds the message here (no network); the Gmail API delivers it.
  const built = await nodemailer.createTransport({ streamTransport: true, buffer: true, newline: 'unix' }).sendMail({ from, to, subject, text, html });
  const raw = built.message.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const res = await fetch(GMAIL_SEND_URL, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + await gmailAccessToken(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ raw }),
    signal: AbortSignal.timeout(TIMEOUT_MS)
  });
  if (!res.ok) { if (res.status === 401) cachedToken = null; throw new Error('Gmail API refused the message (' + res.status + '): ' + (await res.text()).slice(0, 300)); }
}

// ---- Resend over HTTPS ----
async function sendResend({ from, to, subject, text, html }) {
  if (!process.env.RESEND_API_KEY) throw notConfigured('Resend');
  const res = await fetch(RESEND_URL, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + process.env.RESEND_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from, to: [to], subject, text, html }),
    signal: AbortSignal.timeout(TIMEOUT_MS)
  });
  if (!res.ok) throw new Error('Resend refused the message (' + res.status + '): ' + (await res.text()).slice(0, 300));
}

// Throws on failure (.code = 'MAIL_NOT_CONFIGURED' when nothing is set up).
async function sendMail({ to, subject, text, html }) {
  const provider = chosenProvider();
  const from = process.env.MAIL_FROM || ('ConTracker <' + (process.env.GMAIL_USER || 'no-reply@localhost') + '>');
  const msg = { from, to, subject, text, html };
  if (provider === 'console' || provider === 'json') { console.log('[email not sent: ' + provider + ' mode] to=' + to + ' subject=' + subject + '\n' + text); return; }
  if (provider === 'gmail-api') return sendGmailApi(msg);
  if (provider === 'resend') return sendResend(msg);
  if (provider === 'gmail') {
    if (!process.env.GMAIL_USER || !process.env.GMAIL_APP_PASSWORD) throw notConfigured('Gmail');
    await gmailSmtp().sendMail(msg);
    return;
  }
  throw notConfigured('Email sending');
}

module.exports = { sendMail };