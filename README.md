# VFVIC Event Map

Interactive map displaying veteran support events across the UK. Designed for embedding on WordPress sites via iframe.

## Features

- **Interactive map** with clustered event markers
- **Event filtering** by category, date, and location
- **Responsive design** for mobile and desktop
- **Client-side caching** for fast repeat visits
- **Flexible data sources** – WordPress REST API, JSON endpoint, or static data

## Quick Start

1. Install dependencies:
   ```bash
   npm install
   ```

2. Build for production:
   ```bash
   npm run build
   ```

3. Upload `dist/` contents to your web server (e.g. `/wp-content/uploads/vfvic-map/`)

4. Embed via iframe:
   ```html
   <iframe src="/wp-content/uploads/vfvic-map/index.html" width="100%" height="600" frameborder="0"></iframe>
   ```

## Configuration

The map reads its events endpoint from (in priority order):

1. **Query param**: `index.html?dataSource=https://example.com/wp-json/vfvic/v1/events`
2. **Global variable**: `window.VFVIC_MAP_DATA_URL = '...'` before script loads
3. **Data attribute**: `data-data-source="..."` on `#vfvic-event-map-container`
4. **Config file**: `CALENDAR_CONFIG.DATA_SOURCE_URL` in `config.js`

Copy `config.example.js` to `config.js` and edit as needed.

## Project Structure

```
index.html          Main entry point
script.js           EventMap class and application logic
styles.css          Main stylesheet
css/
  loading-states.css  Loading spinner and skeleton styles
js/
  utils.js          Helper functions
build.js            Build script (minifies to dist/)
dist/               Production build output
```

## Development

For local testing, run a simple HTTP server:
```bash
python -m http.server 8080
```

Then open `http://localhost:8080` in your browser.
