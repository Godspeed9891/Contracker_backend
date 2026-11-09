// Email verification codes for sign-up. The server makes the code, emails it, and later checks it; the browser never
// sees the code. A correct code earns a short-lived "email verified" token, which sign-up must then present.
//
// Rules: a code lives 10 minutes, allows 5 wrong guesses, and a new one can be requested once a minute.

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { JWT_SECRET } = require('../config/env');
const otpModel = require('../models/otp.model');
const { loginInUse } = require('../models/user.model');
const { sendMail } = require('./mailer.service');

const LIFE_MINUTES = 10;
const MAX_WRONG = 5;
const RESEND_SECONDS = 60;
const PURPOSE = 'register';
const EMAIL_OK = /^\S+@\S+\.\S+$/;

const fail = (status, message) => ({ status, body: { error: message } });
const hashOf = (email, code) => crypto.createHmac('sha256', JWT_SECRET).update(email + ':' + PURPOSE + ':' + code).digest('hex');
const same = (a, b) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && crypto.timingSafeEqual(x, y); };

async function sendCode(body) {
  const email = String(body.email || '').trim().toLowerCase();
  if (!EMAIL_OK.test(email)) return fail(400, 'Enter a valid email address.');
  if (await loginInUse(email)) return fail(409, 'That email is already registered. Try signing in.');

  const existing = await otpModel.find(email, PURPOSE);
  if (existing) {
    const waited = (Date.now() - new Date(existing.created_at).getTime()) / 1000;
    if (waited < RESEND_SECONDS) return fail(429, 'Please wait ' + Math.ceil(RESEND_SECONDS - waited) + ' seconds before asking for another code.');
  }

  const code = String(crypto.randomInt(100000, 1000000));
  await otpModel.save(email, PURPOSE, hashOf(email, code), LIFE_MINUTES);
  try {
    await sendMail({
      to: email,
      subject: 'Your ConTracker verification code',
      text: 'Your ConTracker verification code is ' + code + '.\nIt expires in ' + LIFE_MINUTES + ' minutes. If you did not ask for it, you can ignore this email.',
      html: '<div style="font-family:Arial,sans-serif;font-size:15px;color:#111">' +
            '<p>Your ConTracker verification code is:</p>' +
            '<p style="font-size:30px;letter-spacing:6px;font-weight:700;margin:12px 0">' + code + '</p>' +
            '<p>It expires in ' + LIFE_MINUTES + ' minutes. If you did not ask for it, you can ignore this email.</p></div>'
    });
  } catch (e) {
    await otpModel.remove(email, PURPOSE);
    console.error('Could not send the verification email:', e.code === 'MAIL_NOT_CONFIGURED' ? e.message : e);
    return fail(503, 'We could not send the email right now. Please try again in a moment.');
  }
  otpModel.removeExpired().catch(() => {});
  return { status: 200, body: { ok: true, expiresInMinutes: LIFE_MINUTES } };
}

async function verifyCode(body) {
  const email = String(body.email || '').trim().toLowerCase();
  const code = String(body.code || '').trim();
  if (!EMAIL_OK.test(email) || !/^\d{6}$/.test(code)) return fail(400, 'Enter the 6-digit code.');

  const row = await otpModel.find(email, PURPOSE);
  if (!row) return fail(400, 'No code is waiting for that email. Ask for a new one.');
  if (new Date(row.expires_at).getTime() < Date.now()) { await otpModel.remove(email, PURPOSE); return fail(400, 'That code has expired. Ask for a new one.'); }
  if (row.attempts >= MAX_WRONG) { await otpModel.remove(email, PURPOSE); return fail(429, 'Too many wrong codes. Ask for a new one.'); }

  if (!same(hashOf(email, code), row.code_hash)) {
    const used = await otpModel.addAttempt(email, PURPOSE);
    if (used >= MAX_WRONG) { await otpModel.remove(email, PURPOSE); return fail(429, 'Too many wrong codes. Ask for a new one.'); }
    return fail(400, 'Incorrect code. ' + (MAX_WRONG - used) + ' tries left.');
  }
  await otpModel.remove(email, PURPOSE);
  const verifyToken = jwt.sign({ typ: 'email-verified', email }, JWT_SECRET, { expiresIn: '30m' });
  return { status: 200, body: { ok: true, verifyToken } };
}

// True when `token` proves this email was verified in the last 30 minutes.
function emailIsVerified(token, email) {
  if (process.env.REQUIRE_EMAIL_VERIFICATION === 'off') return true;
  try {
    const p = jwt.verify(String(token || ''), JWT_SECRET);
    return p.typ === 'email-verified' && p.email === String(email).trim().toLowerCase();
  } catch (e) { return false; }
}

module.exports = { sendCode, verifyCode, emailIsVerified };