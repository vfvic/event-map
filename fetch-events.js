// fetch-events.js
// Fetches events from Google Calendar API, geocodes each location via Nominatim,
// and saves the result (with lat/lng) to google-calendar-events.
// Used by GitHub Actions during deployment — no client-side geocoding required.

const https = require('https');
const fs = require('fs');

// Get config from environment variables or command line args
const API_KEY = process.env.GOOGLE_CALENDAR_API_KEY || process.argv[2];
const CALENDAR_ID = process.env.GOOGLE_CALENDAR_ID || process.argv[3];
const MAX_EVENTS = 50;
// Nominatim requires a descriptive User-Agent identifying the application.
const NOMINATIM_USER_AGENT = 'vfvic-event-map/1.0 (https://vfvic.github.io/event-map/)';
// Minimum delay between Nominatim requests (ms). Their policy requires <= 1 req/sec.
const NOMINATIM_DELAY_MS = 1100;

if (!API_KEY || !CALENDAR_ID) {
    console.error('Error: GOOGLE_CALENDAR_API_KEY environment variable is required');
    console.error('Error: GOOGLE_CALENDAR_ID environment variable is required');
    console.error('Usage: node fetch-events.js [API_KEY] [CALENDAR_ID]');
    process.exit(1);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Derive a primary category and tag array from event title + description.
 * Mirrors the categorizeEvent() logic in script.js — keep both in sync.
 */
function categorizeEvent(title, description) {
    const titleLower = (title || '').toLowerCase();
    const descLower = (description || '').toLowerCase();
    const combined = titleLower + ' ' + descLower;
    const tags = [];

    if (combined.includes('drop in') || combined.includes('drop-in')) tags.push('drop-in');

    if (combined.includes('support') || combined.includes('counselling') ||
        combined.includes('therapy') || combined.includes('help') ||
        combined.includes('advice') || combined.includes('welfare')) tags.push('support');

    if (combined.includes('breakfast club') ||
        (combined.includes('breakfast') && !combined.includes('clay pigeon')) ||
        (combined.includes('naafi break') && !descLower.includes('drop in'))) tags.push('breakfast-club');

    if (combined.includes('meeting') || combined.includes('branch meeting') ||
        combined.includes('association') || combined.includes('rbl') ||
        combined.includes('royal british legion') || combined.includes('dli')) tags.push('meeting');

    if (combined.includes('workshop') || combined.includes('training') ||
        combined.includes('course') || combined.includes('seminar')) tags.push('workshop');

    if (combined.includes('social') || combined.includes('mixer') ||
        combined.includes('party') || combined.includes('celebration')) tags.push('social');

    if (combined.includes('clay pigeon') || combined.includes('shooting') ||
        titleLower.includes('sport') || combined.includes('football') ||
        combined.includes('rugby') || combined.includes('sailing') ||
        combined.includes('fishing') || combined.includes('golf') ||
        combined.includes('cycling') || combined.includes('walking') ||
        combined.includes('hiking') || combined.includes('swimming') ||
        combined.includes('offshore sailing')) tags.push('sport');

    return { primary: tags.length > 0 ? tags[0] : 'other', tags };
}

/**
 * Extract the first UK postcode found in a string, e.g. "NE32 4AQ" from a
 * full Google Calendar location string.
 */
function extractUKPostcode(text) {
    const match = (text || '').match(/[A-Z]{1,2}\d{1,2}[A-Z]?\s*\d[A-Z]{2}/i);
    return match ? match[0].trim().toUpperCase() : null;
}

/**
 * Perform a single HTTPS GET and return the parsed JSON body.
 */
function httpsGetJson(url, headers) {
    return new Promise((resolve, reject) => {
        const options = { headers };
        https.get(url, options, (res) => {
            let body = '';
            res.on('data', chunk => { body += chunk; });
            res.on('end', () => {
                if (res.statusCode !== 200) {
                    return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
                }
                try {
                    resolve(JSON.parse(body));
                } catch (e) {
                    reject(new Error(`JSON parse error: ${e.message}`));
                }
            });
        }).on('error', reject);
    });
}

/**
 * Geocode a location string using Nominatim (OpenStreetMap).
 * Strategy: try the extracted UK postcode first (most precise), then fall back
 * to the full location string. Results are restricted to GB.
 * Returns { lat, lng } or null if nothing was found.
 */
async function geocodeWithNominatim(location) {
    const headers = {
        'User-Agent': NOMINATIM_USER_AGENT,
        'Accept': 'application/json',
    };

    const queries = [];
    const postcode = extractUKPostcode(location);
    if (postcode) {
        queries.push(postcode);
    }
    // Always include the full string as a fallback
    queries.push(location);

    for (const query of queries) {
        const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&countrycodes=gb&format=json&limit=1`;
        try {
            const results = await httpsGetJson(url, headers);
            if (Array.isArray(results) && results.length > 0) {
                const { lat, lon } = results[0];
                console.log(`  [Geocode] "${query}" -> [${lat}, ${lon}]`);
                return { lat: parseFloat(lat), lng: parseFloat(lon) };
            }
            console.warn(`  [Geocode] No results for "${query}"`);
        } catch (err) {
            console.warn(`  [Geocode] Error for "${query}": ${err.message}`);
        }
        // Respect rate limit between retries too
        await sleep(NOMINATIM_DELAY_MS);
    }

    return null;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
    // 1. Fetch events from Google Calendar
    const timeMin = encodeURIComponent(new Date().toISOString());
    const calendarUrl = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(CALENDAR_ID)}/events?key=${API_KEY}&timeMin=${timeMin}&singleEvents=true&orderBy=startTime&maxResults=${MAX_EVENTS}`;

    console.log('Fetching events from Google Calendar...');
    console.log(`Calendar ID: ${CALENDAR_ID}`);

    let calendarData;
    try {
        calendarData = await httpsGetJson(calendarUrl, { 'Accept': 'application/json' });
    } catch (err) {
        console.error('Error fetching calendar:', err.message);
        process.exit(1);
    }

    if (!calendarData.items || calendarData.items.length === 0) {
        console.warn('Warning: No events found in calendar');
        fs.writeFileSync('google-calendar-events', ' "items": []\n');
        console.log('Saved empty events file');
        return;
    }

    console.log(`Found ${calendarData.items.length} events`);

    // 2. Geocode each event's location via Nominatim
    const items = calendarData.items;
    let geocoded = 0;
    let skipped = 0;

    for (let i = 0; i < items.length; i++) {
        const item = items[i];
        const location = (item.location || '').trim();

        if (!location) {
            console.warn(`  [${i + 1}/${items.length}] "${item.summary}" — no location, skipping geocode`);
            // Still bake in category for announcement items
            const cat = categorizeEvent(item.summary, item.description);
            item.category = cat.primary;
            item.categories = cat.tags.length > 0 ? cat.tags : [cat.primary];
            skipped++;
            continue;
        }

        console.log(`  [${i + 1}/${items.length}] Geocoding: "${location}"`);
        const coords = await geocodeWithNominatim(location);

        if (coords) {
            item.lat = coords.lat;
            item.lng = coords.lng;
            geocoded++;
        } else {
            console.warn(`  [${i + 1}/${items.length}] Could not geocode "${location}" — event will be excluded from map`);
            skipped++;
        }

        // Bake in category so the client can filter without re-deriving
        const cat = categorizeEvent(item.summary, item.description);
        item.category = cat.primary;
        item.categories = cat.tags.length > 0 ? cat.tags : [cat.primary];

        // Rate-limit: wait before the next Nominatim request (skip delay after last item)
        if (i < items.length - 1) {
            await sleep(NOMINATIM_DELAY_MS);
        }
    }

    console.log(`Geocoding complete: ${geocoded} resolved, ${skipped} skipped`);

    // 3. Write output — keep the existing file format the client expects
    const output = ' "items": ' + JSON.stringify(items, null, 1) + '\n';
    fs.writeFileSync('google-calendar-events', output);

    console.log(`Successfully saved ${items.length} events to google-calendar-events`);
    console.log('Event date range:',
        items[0]?.start?.dateTime || items[0]?.start?.date,
        'to',
        items[items.length - 1]?.start?.dateTime || items[items.length - 1]?.start?.date
    );
}

main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});
