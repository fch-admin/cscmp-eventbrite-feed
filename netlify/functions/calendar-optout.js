/**
 * Calendar invites opt-OUT  (keeps the contact subscribed in Brevo)
 * --------------------------------------------------------------------------
 * GET /.netlify/functions/calendar-optout?email=<address>
 *
 * Sets the Brevo contact attribute EVENT_PREF = NO. That removes them from the
 * "EVENT_PREF = OPTED_IN" segment (no more calendar invites) but leaves their
 * Brevo subscription fully intact (they still get regular emails).
 *
 * Put this link in your calendar-invite campaigns — Brevo fills in the email:
 *   https://eventbrite-feed-cscmp.netlify.app/.netlify/functions/calendar-optout?email={{contact.EMAIL}}
 *
 * Requires a Netlify env var: BREVO_API_KEY
 */

const BREVO_CONTACTS = 'https://api.brevo.com/v3/contacts/';

exports.handler = async function (event) {
  const apiKey = process.env.BREVO_API_KEY;
  const email  = ((event.queryStringParameters || {}).email || '').trim().toLowerCase();

  if (!apiKey) return page(500, 'Not configured', 'The opt-out service is missing its Brevo key. Please contact us.');
  if (!email)  return page(400, 'Missing email', 'This link is missing an email address.');

  try {
    const resp = await fetch(BREVO_CONTACTS + encodeURIComponent(email), {
      method: 'PUT',
      headers: { 'api-key': apiKey, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ attributes: { EVENT_PREF: 'NO' } }),
    });

    // 204 = updated; 404 = not a known contact (already not subscribed) — both are "done".
    if (resp.status === 204 || resp.status === 404) {
      return page(200, "You're all set",
        `<strong>${escapeHtml(email)}</strong> will no longer receive CSCMP SoFlo calendar invites.` +
        `<br><br>You'll still get our regular emails. Changed your mind? Just re-opt-in from our sign-up form anytime.`);
    }
    const text = await resp.text();
    return page(502, 'Something went wrong', 'Please try again shortly.<br><small>' + escapeHtml(text) + '</small>');
  } catch (err) {
    return page(500, 'Something went wrong', 'Please try again shortly.');
  }
};

function page(status, title, body) {
  const html = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f8f9fa;color:#333;margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center}
  .card{background:#fff;max-width:480px;margin:16px;padding:32px;border-radius:12px;border:1px solid #e2e8f0;text-align:center;line-height:1.6}
  h1{color:#1a365d;font-size:1.3rem;margin:0 0 12px}
  p{color:#4a5568;font-size:.95rem;margin:0}
  .mark{font-size:2.5rem;margin-bottom:8px}
</style></head><body><div class="card">
  <div class="mark">${status === 200 ? '✅' : '⚠️'}</div>
  <h1>${escapeHtml(title)}</h1><p>${body}</p>
</div></body></html>`;
  return { statusCode: status, headers: { 'Content-Type': 'text/html; charset=utf-8' }, body: html };
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
