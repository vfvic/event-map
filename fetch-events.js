// fetch-events.js
// Fetches events from Google Calendar API and saves to google-calendar-events file
// Used by GitHub Actions during deployment

const https = require('https');
const fs = require('fs');

// Get config from environment variables or command line args
const API_KEY = process.env.GOOGLE_CALENDAR_API_KEY || process.argv[2];
const CALENDAR_ID = process.env.GOOGLE_CALENDAR_ID || process.argv[3];
const MAX_EVENTS = 50;

if (!API_KEY || !CALENDAR_ID) {
    console.error('Error: GOOGLE_CALENDAR_API_KEY environment variable is required');
    console.error('Error: GOOGLE_CALENDAR_ID environment variable is required');
  console.error('Usage: node fetch-events.js [API_KEY] [CALENDAR_ID]');
  process.exit(1);
}

// Build API URL
const timeMin = new Date().toISOString();
const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(CALENDAR_ID)}/events?key=${API_KEY}&timeMin=${timeMin}&singleEvents=true&orderBy=startTime&maxResults=${MAX_EVENTS}`;

console.log('Fetching events from Google Calendar...');
console.log(`Calendar ID: ${CALENDAR_ID}`);

https.get(url, (res) => {
  let data = '';

  res.on('data', (chunk) => {
    data += chunk;
  });

  res.on('end', () => {
    if (res.statusCode !== 200) {
      console.error(`Error: API returned status ${res.statusCode}`);
      console.error(data);
      process.exit(1);
    }

    try {
      const jsonData = JSON.parse(data);

      if (!jsonData.items || jsonData.items.length === 0) {
        console.warn('Warning: No events found in calendar');
        // Still write empty items array
        const output = ' "items": []\n';
        fs.writeFileSync('google-calendar-events', output);
        console.log('Saved empty events file');
        process.exit(0);
      }

      console.log(`Found ${jsonData.items.length} events`);

      // Format the output to match the existing file format
      // (starts with "items": instead of being a complete JSON object)
      const output = ' "items": ' + JSON.stringify(jsonData.items, null, 1) + '\n';

      // Write to google-calendar-events file
      fs.writeFileSync('google-calendar-events', output);

      console.log(`Successfully saved ${jsonData.items.length} events to google-calendar-events`);
      console.log('Event date range:',
        jsonData.items[0]?.start?.dateTime || jsonData.items[0]?.start?.date,
        'to',
        jsonData.items[jsonData.items.length - 1]?.start?.dateTime || jsonData.items[jsonData.items.length - 1]?.start?.date
      );

    } catch (error) {
      console.error('Error parsing API response:', error.message);
      process.exit(1);
    }
  });

}).on('error', (error) => {
  console.error('Error fetching events:', error.message);
  process.exit(1);
});
