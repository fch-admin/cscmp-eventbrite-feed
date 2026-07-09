/**
 * Eventbrite event  →  downloadable .ics calendar invite
 * --------------------------------------------------------------------------
 * Usage (no code, just a URL):
 *   /.netlify/functions/event-ics?url=<paste the full Eventbrite event link>
 *   /.netlify/functions/event-ics?id=<numeric event id>
 *
 * It fetches the event from Eventbrite (reusing the existing EVENTBRITE_TOKEN),
 * builds a calendar invite, and downloads it as a .ics file. Attach that file
 * to a Brevo campaign sent to your opted-in segment — recipients get the event
 * on their calendar (auto-adds as tentative in most clients; RSVP in Outlook/Apple).
 *
 * One-time: set ORGANIZER_EMAIL below to your Zoho address (RSVPs return there).
 */

const ORGANIZER_NAME  = 'CSCMP South Florida Roundtable';
const ORGANIZER_EMAIL = 'cscmp@sofloroundtable.org';  // Zoho address — RSVPs return here
const METHOD = 'REQUEST';  // REQUEST = auto-add as tentative + RSVP; PUBLISH = plain add-to-calendar

exports.handler = async function (event) {
  const token = process.env.EVENTBRITE_TOKEN;
  if (!token) return { statusCode: 500, body: 'Missing EVENTBRITE_TOKEN' };

  const q  = event.queryStringParameters || {};
  const id = String(q.id || extractId(q.url || '')).trim();
  if (!id) return { statusCode: 400, body: 'Provide ?id=<eventId> or ?url=<Eventbrite event URL>' };

  try {
    const resp = await fetch(
      `https://www.eventbriteapi.com/v3/events/${id}/?expand=venue`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!resp.ok) return { statusCode: resp.status, body: `Eventbrite API error (${resp.status})` };
    const ev = await resp.json();

    return {
      statusCode: 200,
      headers: {
        'Content-Type': `text/calendar; charset=utf-8; method=${METHOD}`,
        'Content-Disposition': `attachment; filename="${slug(ev.name && ev.name.text)}.ics"`,
        'Access-Control-Allow-Origin': '*',
      },
      body: buildIcs(ev),
    };
  } catch (err) {
    return { statusCode: 500, body: 'Failed to build .ics' };
  }
};

// SEQUENCE from Eventbrite's last-changed time so edits supersede the old invite.
function icsSeq(ev) {
  const t = Date.parse((ev && (ev.changed || ev.created)) || '');
  return Number.isFinite(t) ? Math.floor(t / 1000) : 0;
}

// Eventbrite URLs end in "...-tickets-1234567890" — grab the trailing id.
function extractId(url) {
  const m = String(url).match(/(\d{6,})\D*$/);
  return m ? m[1] : '';
}

function buildIcs(ev) {
  const name = (ev.name && ev.name.text) || 'Event';
  const url  = ev.url || '';
  const summary = (ev.summary || (ev.description && ev.description.text) || '').trim();

  const venue = ev.venue || {};
  const addr  = venue.address && venue.address.localized_address_display;
  const location = venue.name
    ? (addr ? `${venue.name}, ${addr}` : venue.name)
    : (addr || 'Online');

  const optOutUrl = 'https://eventbrite-feed-cscmp.netlify.app/.netlify/functions/calendar-optout';
  const description =
    (summary ? summary + '\n\n' : '') +
    (url ? 'Register / details: ' + url + '\n\n' : '') +
    'To stop receiving these calendar invites: ' + optOutUrl;

  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//CSCMP SoFlo//Eventbrite Invite//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:' + METHOD,
    'BEGIN:VEVENT',
    'UID:eventbrite-' + (ev.id || 'x') + '@cscmpsoflo',
    'DTSTAMP:' + toIcsUtc(new Date().toISOString()),
    'DTSTART:' + toIcsUtc(ev.start && ev.start.utc),
    'DTEND:'   + toIcsUtc(ev.end && ev.end.utc),
    'SUMMARY:'     + esc(name),
    'DESCRIPTION:' + esc(description),
    'LOCATION:'    + esc(location),
    'URL:'         + esc(url),
    'ORGANIZER;CN=' + esc(ORGANIZER_NAME) + ':mailto:' + ORGANIZER_EMAIL,
    'STATUS:CONFIRMED',
    'SEQUENCE:' + icsSeq(ev),
    'TRANSP:OPAQUE',
    'BEGIN:VALARM',
    'TRIGGER:-PT1H',
    'ACTION:DISPLAY',
    'DESCRIPTION:Reminder',
    'END:VALARM',
    'END:VEVENT',
    'END:VCALENDAR',
  ];
  return lines.map(fold).join('\r\n');
}

// "2026-07-22T22:00:00Z" -> "20260722T220000Z"
function toIcsUtc(iso) {
  return String(iso || '').replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

function esc(s) {
  return String(s || '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

function fold(line) {
  if (line.length <= 73) return line;
  let out = '', s = line;
  while (s.length > 73) { out += s.slice(0, 73) + '\r\n '; s = s.slice(73); }
  return out + s;
}

function slug(s) {
  return String(s || 'event').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50) || 'event';
}
