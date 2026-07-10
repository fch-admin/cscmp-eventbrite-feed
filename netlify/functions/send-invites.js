/**
 * Send PERSONALIZED calendar invites to opted-in Brevo contacts.
 * Each recipient gets their own .ics (them as ATTENDEE, METHOD:REQUEST) via
 * Brevo's transactional API, so it auto-lands on their calendar with RSVP —
 * no manual import.
 *
 * Batched: the admin page (send-invites.html) calls this repeatedly with an
 * increasing offset and shows progress. Works within function time limits.
 *
 *   GET /.netlify/functions/send-invites?key=<ADMIN_SECRET>&url=<eventbrite>&offset=0&limit=50
 *   GET /.netlify/functions/send-invites?key=<ADMIN_SECRET>&url=<eventbrite>&test=you@email.com
 *        ^ sends a single test invite to that address only.
 *
 * Env vars: BREVO_API_KEY, EVENTBRITE_TOKEN, ADMIN_SECRET
 */

const SENDER = { name: 'CSCMP South Florida Roundtable', email: 'cscmp@sofloroundtable.org' };
const OPTOUT_BASE = 'https://eventbrite-feed-cscmp.netlify.app/.netlify/functions/calendar-optout';

exports.handler = async function (event) {
  const q = event.queryStringParameters || {};
  const secret   = process.env.ADMIN_SECRET;
  const brevoKey = process.env.BREVO_API_KEY;
  const ebToken  = process.env.EVENTBRITE_TOKEN;

  if (!secret || q.key !== secret) return json(401, { error: 'Unauthorized (wrong passcode)' });
  if (!brevoKey || !ebToken)       return json(500, { error: 'Server not configured' });

  const id = extractId(q.url || '');
  if (!id) return json(400, { error: 'Missing or invalid Eventbrite link' });

  try {
    // Event details (fetched each batch — cheap single-event call)
    const evResp = await fetch(`https://www.eventbriteapi.com/v3/events/${id}/?expand=venue`,
      { headers: { Authorization: `Bearer ${ebToken}` } });
    if (!evResp.ok) return json(evResp.status, { error: 'Eventbrite error ' + evResp.status });
    const ev = await evResp.json();

    // TEST MODE: send one invite to the given address and stop.
    if (q.test) {
      const ok = await sendInvite(brevoKey, ev, { email: q.test.trim().toLowerCase(), attributes: {} }, { cancel: !!q.cancel });
      return json(200, { test: true, sent: ok ? 1 : 0, failed: ok ? 0 : 1 });
    }

    const offset = parseInt(q.offset || '0', 10);
    const limit  = Math.min(parseInt(q.limit || '50', 10), 50);

    // One page of contacts
    const cResp = await fetch(`https://api.brevo.com/v3/contacts?limit=${limit}&offset=${offset}&sort=asc`,
      { headers: { 'api-key': brevoKey, accept: 'application/json' } });
    if (!cResp.ok) return json(cResp.status, { error: 'Brevo contacts error ' + cResp.status });
    const cData = await cResp.json();
    const contacts = cData.contacts || [];

    // Send to opted-in, non-unsubscribed contacts on this page
    let sent = 0, failed = 0;
    for (const c of contacts) {
      const attrs = c.attributes || {};
      const optedIn = String(attrs.EVENT_PREF || '').toUpperCase() === 'OPTED_IN';
      if (!optedIn || c.emailBlacklisted) continue;
      const ok = await sendInvite(brevoKey, ev, c, { cancel: !!q.cancel });
      ok ? sent++ : failed++;
    }

    return json(200, {
      scanned: contacts.length,
      sent, failed,
      nextOffset: offset + limit,
      done: contacts.length < limit,
      total: cData.count
    });
  } catch (err) {
    return json(500, { error: String((err && err.message) || err) });
  }
};

async function sendInvite(brevoKey, ev, contact, opts) {
  const cancel = !!(opts && opts.cancel);
  const email  = contact.email;
  const attrs  = contact.attributes || {};
  const name   = [attrs.FIRSTNAME, attrs.LASTNAME].filter(Boolean).join(' ') || email;
  const title  = (ev.name && ev.name.text) || 'CSCMP SoFlo Event';

  const ics = buildIcs(ev, email, name, { cancel });
  const b64 = Buffer.from(ics, 'utf-8').toString('base64');
  const optOutUrl = OPTOUT_BASE + '?email=' + encodeURIComponent(email);

  const subject = cancel ? ('Cancelled: ' + title) : title;
  const html = cancel
    ? `<p>Hi ${escapeHtml(attrs.FIRSTNAME || 'there')},</p>
<p><strong>${escapeHtml(title)}</strong> has been <strong>cancelled</strong>. This update should remove it from your calendar automatically. We're sorry for any inconvenience.</p>`
    : `<p>Hi ${escapeHtml(attrs.FIRSTNAME || 'there')},</p>
<p>You're invited to <strong>${escapeHtml(title)}</strong>. This invitation should appear on your calendar automatically — just tap <strong>Accept</strong>, <strong>Tentative</strong>, or <strong>Decline</strong>.</p>
<p><a href="${escapeHtml(ev.url || '#')}">Event details &amp; registration</a></p>
<hr>
<p style="font-size:12px;color:#888">Don't want events on your calendar? <a href="${escapeHtml(optOutUrl)}">Stop calendar invites</a> — you'll still get our regular emails.</p>`;

  const body = {
    sender: SENDER,
    to: [{ email, name }],
    subject,
    htmlContent: html,
    attachment: [{ content: b64, name: cancel ? 'cancel.ics' : 'invite.ics' }]
  };

  const resp = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { 'api-key': brevoKey, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body)
  });
  return resp.ok;
}

function buildIcs(ev, attendeeEmail, attendeeName, opts) {
  const cancel = !!(opts && opts.cancel);
  const name = (ev.name && ev.name.text) || 'Event';
  const url  = ev.url || '';
  const summary = (ev.summary || (ev.description && ev.description.text) || '').trim();
  const venue = ev.venue || {};
  const addr  = venue.address && venue.address.localized_address_display;
  const location = venue.name ? (addr ? venue.name + ', ' + addr : venue.name) : (addr || 'Online');

  const description = cancel
    ? 'This event has been cancelled.'
    : (summary ? summary + '\n\n' : '') +
      (url ? 'Register / details: ' + url + '\n\n' : '') +
      'To stop these calendar invites: ' + OPTOUT_BASE;

  // Cancellations use METHOD:CANCEL + STATUS:CANCELLED and a SEQUENCE guaranteed
  // higher than any prior invite (now-time) so clients pull the event off calendars.
  const method = cancel ? 'CANCEL' : 'REQUEST';
  const status = cancel ? 'CANCELLED' : 'CONFIRMED';
  const seq    = cancel ? Math.floor(Date.now() / 1000) : icsSeq(ev);

  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//CSCMP SoFlo//Invite//EN', 'CALSCALE:GREGORIAN', 'METHOD:' + method,
    'BEGIN:VEVENT',
    'UID:eventbrite-' + (ev.id || 'x') + '@cscmpsoflo',
    'DTSTAMP:' + toIcsUtc(new Date().toISOString()),
    'DTSTART:' + toIcsUtc(ev.start && ev.start.utc),
    'DTEND:'   + toIcsUtc(ev.end && ev.end.utc),
    'SUMMARY:'     + esc((cancel ? 'CANCELLED: ' : '') + name),
    'DESCRIPTION:' + esc(description),
    'LOCATION:'    + esc(location),
    'URL:'         + esc(url),
    'ORGANIZER;CN=' + esc(SENDER.name) + ':mailto:' + SENDER.email,
    'ATTENDEE;CN=' + esc(attendeeName) + ';ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:' + attendeeEmail,
    'STATUS:' + status, 'SEQUENCE:' + seq, 'TRANSP:OPAQUE',
    'END:VEVENT', 'END:VCALENDAR'
  ];
  return lines.map(fold).join('\r\n');
}

// SEQUENCE from Eventbrite's last-changed time so edits supersede the old invite.
function icsSeq(ev) {
  const t = Date.parse((ev && (ev.changed || ev.created)) || '');
  return Number.isFinite(t) ? Math.floor(t / 1000) : 0;
}
function extractId(url) { const m = String(url).match(/(\d{6,})\D*$/); return m ? m[1] : ''; }
function toIcsUtc(iso) { return String(iso || '').replace(/[-:]/g, '').replace(/\.\d{3}/, ''); }
function esc(s) {
  return String(s || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}
function fold(line) {
  if (line.length <= 73) return line;
  let out = '', s = line;
  while (s.length > 73) { out += s.slice(0, 73) + '\r\n '; s = s.slice(73); }
  return out + s;
}
function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function json(statusCode, obj) {
  return { statusCode, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify(obj) };
}
