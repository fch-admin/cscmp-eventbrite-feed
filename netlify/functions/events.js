exports.handler = async function () {
  const token = process.env.EVENTBRITE_TOKEN;
  const orgId = '2843975666561';

  if (!token) {
    return { statusCode: 500, body: JSON.stringify({ error: 'Missing API token' }) };
  }

  try {
    const resp = await fetch(
      `https://www.eventbriteapi.com/v3/organizations/${orgId}/events/?order_by=start_desc&expand=venue,logo&page_size=50`,
      { headers: { Authorization: `Bearer ${token}` } }
    );

    if (!resp.ok) {
      return { statusCode: resp.status, body: JSON.stringify({ error: 'Eventbrite API error' }) };
    }

    const data = await resp.json();

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'public, max-age=300',
      },
      body: JSON.stringify(data),
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: 'Failed to fetch events' }) };
  }
};
