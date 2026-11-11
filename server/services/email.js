'use strict';

// ── Test hook ─────────────────────────────────────────────────────────────────
// Tests inject a mock sender so they can verify outgoing email parameters
// without hitting the Resend API.  Production code never calls these.

let _testSender = null;

function _setEmailSenderForTest(fn) { _testSender = fn; }
function _clearEmailSenderForTest()  { _testSender = null; }

// ── Password reset email ──────────────────────────────────────────────────────

async function sendPasswordResetEmail(toEmail, resetUrl) {
  // Test hook takes precedence
  if (_testSender) {
    await _testSender(toEmail, resetUrl);
    return;
  }

  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.warn('[email] RESEND_API_KEY not set — password reset email skipped for:', toEmail);
    return;
  }

  const { Resend } = require('resend');
  const resend = new Resend(apiKey);

  const from = process.env.EMAIL_FROM ?? 'Elmer <noreply@notify.getelmer.com>';

  await resend.emails.send({
    from,
    to: toEmail,
    subject: 'Reset your Elmer password',
    text: [
      'You requested a password reset for your Elmer account.',
      '',
      'Reset your password here:',
      resetUrl,
      '',
      'This link expires in 1 hour and can only be used once.',
      '',
      "If you didn't request this, you can safely ignore this email.",
      'Your password will not change until you click the link above.',
    ].join('\n'),
    html: `
<!DOCTYPE html>
<html>
<body style="font-family:sans-serif;color:#1a1a1a;max-width:480px;margin:0 auto;padding:24px">
  <h2 style="margin-bottom:8px">Reset your Elmer password</h2>
  <p>You requested a password reset for your Elmer account.</p>
  <p style="margin:24px 0">
    <a href="${resetUrl}"
       style="background:#06b6d4;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600;display:inline-block">
      Reset my password
    </a>
  </p>
  <p style="color:#666;font-size:14px">
    This link expires in <strong>1 hour</strong> and can only be used once.
  </p>
  <p style="color:#666;font-size:14px">
    If you didn't request this, you can safely ignore this email.
    Your password will not change.
  </p>
</body>
</html>`,
  });
}

module.exports = {
  sendPasswordResetEmail,
  _setEmailSenderForTest,
  _clearEmailSenderForTest,
};
