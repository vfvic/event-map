// Google Calendar Configuration for VFVIC Veterans Diary
// Copy this file to config.js and fill in your actual values

const CALENDAR_CONFIG = {
    // Get this from Google Cloud Console after enabling Calendar API
    API_KEY: 'your-google-calendar-api-key-here',

    // Get this from your VFVIC Google Calendar settings
    CALENDAR_ID: 'your-calendar-id@group.calendar.google.com',

    // Google Geocoding API key (https://console.cloud.google.com)
    // Enable "Geocoding API" in Google Cloud Console
    GEOCODING_API_KEY: 'your-google-geocoding-api-key-here',

    // Default region for events (Northeast England)
    DEFAULT_REGION: {
        lat: 54.9783,
        lng: -1.6178,
        zoom: 8
    },

    // Maximum number of events to load
    MAX_EVENTS: 50,

    // Enable/disable geocoding (set to false to use predefined coordinates)
    ENABLE_GEOCODING: true,

    // WordPress / external embed: URL to fetch events JSON (server-side cached, no client API keys).
    // When set, the map loads events only from this URL (no Google Calendar or local file).
    DATA_SOURCE_URL: ''
};

// Export for use in script.js
if (typeof module !== 'undefined' && module.exports) {
    module.exports = CALENDAR_CONFIG;
} else {
    window.CALENDAR_CONFIG = CALENDAR_CONFIG;
}
