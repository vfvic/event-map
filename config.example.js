// Front-end configuration for VFVIC Veterans Diary
// Copy this file to config.js and fill in your values.
// config.js is gitignored and must never be committed.

const CALENDAR_CONFIG = {
    // WordPress / external embed: URL to fetch events JSON (server-side cached, no client API keys).
    // When set, the map loads events only from this URL (no Google Calendar or local file).
    DATA_SOURCE_URL: '',

    // -------------------------------------------------------------------------
    // LOCAL TESTING ONLY — never set these in production / deployment
    // -------------------------------------------------------------------------
    // Set USE_GOOGLE_LOCALLY to true to fetch live events + announcements directly
    // from the Google Calendar API when running on localhost / 127.0.0.1.
    // Events without pre-geocoded lat/lng will appear in the list but not on the map.
    USE_GOOGLE_LOCALLY: false,
    GOOGLE_API_KEY: '',
    CALENDAR_ID: 'your_calendar_id@group.calendar.google.com'
};

// Export for use in script.js
if (typeof module !== 'undefined' && module.exports) {
    module.exports = CALENDAR_CONFIG;
} else {
    window.CALENDAR_CONFIG = CALENDAR_CONFIG;
}
