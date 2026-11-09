// Sends email. Which service does the sending is chosen by settings, so changing from Gmail to Resend (or anything
// else) later means changing this one file and .env, nothing else.
//
//   MAIL_PROVIDER=gmail    needs GMAIL_USER and GMAIL_APP_PASSWORD (a Google "app password", not your normal one)
//   MAIL_PROVIDER=console  prints the email in the server window instead of sending it (local testing only)
//   MAIL_PROVIDER=json     like console, for automated tests
//   MAIL_FROM              optional, e.g.  ConTracker <you@gmail.com>
// With no MAIL_PROVIDER, Gmail is used when GMAIL_USER and GMAIL_APP_PASSWORD are set; otherwise the console on a
// developer machine, and a clear error in production.

const nodemailer = require('nodemailer');

function chosenProvider() {
  if (process.env.MAIL_PROVIDER) return process.env.MAIL_PROVIDER.toLowerCase();
  if (process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD) return 'gmail';
  return process.env.NODE_ENV === 'production' ? 'none' : 'console';
}

let gmailTransport = null;
function gmail() {
  if (!gmailTransport) {
    gmailTransport = nodemailer.createTransport({
      host: 'smtp.gmail.com', port: 465, secure: true,
      auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD },
      connectionTimeout: 15000, socketTimeout: 20000
    });
  }
  return gmailTransport;
}

// Throws an Error with .code = 'MAIL_NOT_CONFIGURED' or the sending error. Returns nothing useful on success.
async function sendMail({ to, subject, text, html }) {
  const provider = chosenProvider();
  const from = process.env.MAIL_FROM || ('ConTracker <' + (process.env.GMAIL_USER || 'no-reply@localhost') + '>');
  if (provider === 'console' || provider === 'json') {
    console.log('[email not sent: ' + provider + ' mode] to=' + to + ' subject=' + subject + '\n' + text);
    return;
  }
  if (provider === 'gmail') {
    if (!process.env.GMAIL_USER || !process.env.GMAIL_APP_PASSWORD) { const e = new Error('Gmail is not configured.'); e.code = 'MAIL_NOT_CONFIGURED'; throw e; }
    await gmail().sendMail({ from, to, subject, text, html });
    return;
  }
  const e = new Error('Email sending is not configured on the server.'); e.code = 'MAIL_NOT_CONFIGURED'; throw e;
}

module.exports = { sendMail };