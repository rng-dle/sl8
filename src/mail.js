// Account email (password reset). Uses Resend when RESEND_API_KEY is set, or Cloudflare Email Sending
// when an EMAIL send binding is configured. With neither, reset reports that it isn't set up.
const FROM = 'no-reply@thinksl8.com';

export const canSendMail = (env) => !!(env.EMAIL || env.RESEND_API_KEY);

export async function sendMail(env, { to, subject, text, html }) {
  const from = env.MAIL_FROM || FROM;
  if (env.EMAIL) {
    await env.EMAIL.send({ from: { email: from, name: 'ThinkSL8' }, to, subject, text, html });
    return;
  }
  const base = env.TEST_BASE ? `${env.TEST_BASE}/resend` : 'https://api.resend.com';
  const res = await fetch(base + '/emails', {
    method: 'POST',
    headers: { authorization: 'Bearer ' + env.RESEND_API_KEY, 'content-type': 'application/json' },
    body: JSON.stringify({ from: `ThinkSL8 <${from}>`, to: [to], subject, text, html }),
  });
  if (!res.ok) throw new Error(`Resend ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

export function resetEmail(link) {
  const text = `Someone asked to reset the password for your ThinkSL8 account.\n\nChoose a new password here (the link works once and expires in 1 hour):\n${link}\n\nIf this wasn't you, ignore this email. Your password stays the same.`;
  const html = `<div style="font:16px/1.5 system-ui,sans-serif;color:#191c29;max-width:480px">
<p style="font:24px Georgia,serif;margin:0 0 16px">Think<span style="color:#2a44c4">SL8</span></p>
<p>Someone asked to reset the password for your ThinkSL8 account.</p>
<p><a href="${link}" style="display:inline-block;padding:12px 18px;background:#2a44c4;color:#fff;border-radius:10px;text-decoration:none;font-weight:600">Choose a new password</a></p>
<p style="color:#60667d;font-size:14px">The link works once and expires in 1 hour. If this wasn't you, ignore this email. Your password stays the same.</p>
</div>`;
  return { subject: 'Reset your ThinkSL8 password', text, html };
}
