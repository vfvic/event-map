// Event Map Integration Prototype
// Enhanced with loading states, debouncing, and improved security

class EventMap {
  constructor() {
    this.map = null;
    this.markers = [];
    this.events = [];
    this.filteredEvents = [];
    this.displayedEvents = []; // Events currently shown in the list
    this.announcements = []; // Public announcements (excluded from map but displayed in banner)

    // Recurring event IDs to exclude (Public Announcements)
    this.excludedRecurringEventIds = [
      "2scpgqhjtjh5tc33cg3jm3ik5c",
      "30ed1sa1ev6k8kgp0ucg1mq24j",
    ];

    this.announcementKeywords = [
      "useful information",
      "veterans for veterans in care",
      "public announcement",
    ];

    // Helper to check if a recurring event should be excluded
    this.isExcludedRecurringEvent = (recurringEventId) =>
      this.excludedRecurringEventIds.includes(recurringEventId);

    this.isAnnouncementItem = (item = {}) => {
      const title = String(item.summary || item.title || "").toLowerCase();
      return (
        this.isExcludedRecurringEvent(item.recurringEventId) ||
        this.announcementKeywords.some((keyword) => title.includes(keyword))
      );
    };

    // Use config constants
    const config = window.EventMapUtils?.CONFIG || {};
    this.eventsPerPage = config.EVENTS_PER_PAGE || 20;
    this.maxMarkersOnMap = config.MAX_MARKERS_ON_MAP || 100;

    this.currentPage = 0;
    this.currentDateFilter = "all"; // 'today', 'week', 'month', 'all'

    // WordPress / external data source URL (set by embedder or config)
    this.dataSourceUrl =
      window.VFVIC_MAP_DATA_URL ||
      (typeof document !== "undefined" &&
        document.getElementById("vfvic-event-map-container")?.dataset
          ?.dataSource) ||
      (window.CALENDAR_CONFIG && window.CALENDAR_CONFIG.DATA_SOURCE_URL) ||
      "";

    // In-memory geocode cache to avoid duplicate API calls per session
    this._geocodeCache = Object.create(null);

    // Client-side cache TTL for WordPress endpoint (milliseconds). 10 minutes.
    this._clientCacheTtlMs = 10 * 60 * 1000;
    this._clientCacheKeyPrefix = "vfvic_map_events_";

    // Utility functions
    this.utils = window.EventMapUtils;

    this.init();
  }

  async init() {
    // Show loading state
    if (this.utils) {
      this.utils.showLoadingSpinner("Loading...");
    }

    // Load announcements independently without blocking event/map rendering
    (async () => {
      try {
        const timeoutMs =
          (this.utils && this.utils.CONFIG && this.utils.CONFIG.ANNOUNCEMENTS_TIMEOUT_MS) ||
          5000;
        await Promise.race([
          this.loadAnnouncements(),
          new Promise((_, reject) =>
            setTimeout(
              () => reject(new Error("Announcements loading timed out")),
              timeoutMs,
            ),
          ),
        ]);
        this.displayAnnouncements();
      } catch (error) {
        console.warn("Could not load announcements:", error);
      }
    })();

    // WordPress mode: if data source URL is set, fetch only from that endpoint (no Google Calendar or local file)
    if (this.dataSourceUrl) {
      try {
        await this.loadFromWordPressEndpoint();
      } catch (error) {
        console.warn("Could not load events from WordPress endpoint:", error);
        if (this.utils) {
          this.utils.showToast(
            "Could not load events. Showing sample data.",
            "info",
            5000,
          );
        }
        this.loadSampleEvents();
      }
    } else {
      // Standalone: try local file, then Google Calendar API, then sample data
      try {
        await this.loadLocalCalendarEvents();
      } catch (error) {
        console.warn(
          "Could not load local calendar events, trying Google Calendar API:",
          error,
        );
        try {
          await this.loadGoogleCalendarEvents();
        } catch (apiError) {
          console.warn(
            "Could not load Google Calendar events, using sample data:",
            apiError,
          );
          this.loadSampleEvents();

          if (this.utils) {
            this.utils.showToast(
              "Using sample data. Configure Google Calendar for live events.",
              "info",
              5000,
            );
          }
        }
      }
    }

    this.filteredEvents = [...this.events];
    this.initMap();
    this.populateCategoryFilter();
    this.displayEvents();
    this.setupEventListeners();

    // Hide loading state
    if (this.utils) {
      this.utils.hideLoadingSpinner();
    }
  }

  /**
   * Load events from WordPress (or any external) endpoint. Used when VFVIC_MAP_DATA_URL is set.
   * Uses client-side TTL cache to avoid repeated requests. No Google Calendar or Geocoding calls.
   */
  async loadFromWordPressEndpoint() {
    const url = this.dataSourceUrl.trim();
    if (!url) {
      throw new Error("VFVIC_MAP_DATA_URL is empty");
    }

    // Check client-side cache first (sessionStorage, TTL)
    const cached = this._getClientCachedEvents(url);
    if (cached) {
      this.events = cached;
      console.log(
        `[WordPress] Loaded ${this.events.length} events from client cache`,
      );
      if (this.utils) {
        this.utils.showToast(
          `Loaded ${this.events.length} events (cached)`,
          "success",
        );
      }
      return;
    }

    console.log("[WordPress] Fetching events from:", url);
    const response = await fetch(url, {
      method: "GET",
      credentials: "same-origin",
      headers: { Accept: "application/json" },
    });

    if (!response.ok) {
      throw new Error(
        `Events endpoint error: ${response.status} ${response.statusText}`,
      );
    }

    const raw = await response.json();

    // Accept array of events or { events: [...] }
    const items = Array.isArray(raw) ? raw : raw.events || raw.items || [];
    if (!Array.isArray(items)) {
      throw new Error("Invalid events response: expected array or { events }");
    }

    this.events = this._normaliseWordPressEvents(items);
    if (this.events.length === 0) {
      console.warn("[WordPress] No events after normalisation");
    }

    // Cache raw items so loadAnnouncements can reuse them without an extra network request
    try {
      sessionStorage.setItem(
        this._clientCacheKey(url) + "_raw",
        JSON.stringify({ data: items, fetchedAt: Date.now() }),
      );
    } catch (e) {
      // Ignore storage errors
    }

    // Persist to client cache
    this._setClientCachedEvents(url, this.events);

    if (this.utils) {
      this.utils.showToast(
        `Loaded ${this.events.length} events from server`,
        "success",
      );
    }
  }

  /**
   * Normalise payload from WordPress endpoint to internal event shape.
   * Expects objects with at least: title, location, lat, lng; optional: description, category, date, time, organizer, id.
   */
  _normaliseWordPressEvents(items) {
    return items
      .map((item, index) => {
        // Skip announcements (they are loaded separately via loadAnnouncements)
        if (this.isAnnouncementItem(item)) {
          return null;
        }

        const lat = parseFloat(item.lat);
        const lng = parseFloat(item.lng);
        if (Number.isNaN(lat) || Number.isNaN(lng)) {
          console.warn(
            `[WordPress] Skipping event "${item.title || "?"}" - invalid lat/lng`,
          );
          return null;
        }
        const category =
          item.category != null ? String(item.category).trim() : "Other";
        const categories = Array.isArray(item.categories)
          ? item.categories.map((c) => String(c).trim())
          : category
            ? [category]
            : ["Other"];
        const date =
          item.date || (item.start && (item.start.date || item.start.dateTime))
            ? this._normaliseDate(
                item.date || item.start?.date || item.start?.dateTime,
              )
            : "";
        const time =
          item.time || (item.start && item.start.dateTime)
            ? this._normaliseTime(item.start.dateTime)
            : "";
        const startTime =
          item.startTime || (item.start && item.start.dateTime) || "";
        const endTime = item.endTime || (item.end && item.end.dateTime) || "";

        return {
          id: item.id != null ? item.id : index + 1,
          title: this.sanitiseText(item.title || "Unnamed Event"),
          description: this.sanitiseHtml(
            item.description || "No description available",
          ),
          category,
          categories,
          date,
          time,
          timeDisplay: item.timeDisplay || time,
          startTime,
          endTime,
          location: this.sanitiseText(item.location || "Location TBD"),
          lat,
          lng,
          organizer: this.sanitiseText(item.organizer || "VFVIC"),
        };
      })
      .filter((e) => e !== null);
  }

  _normaliseDate(val) {
    if (!val) return "";
    const d = new Date(val);
    return Number.isNaN(d.getTime()) ? "" : d.toISOString().slice(0, 10);
  }

  _normaliseTime(val) {
    if (!val) return "";
    const d = new Date(val);
    if (Number.isNaN(d.getTime())) return "";
    return d.toLocaleTimeString("en-GB", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
  }

  _clientCacheKey(url) {
    let hash = 0;
    const str = url;
    for (let i = 0; i < str.length; i++) {
      const c = str.charCodeAt(i);
      hash = (hash << 5) - hash + c;
      hash = hash & 0x7fffffff;
    }
    return this._clientCacheKeyPrefix + String(hash);
  }

  _getClientCachedEvents(url) {
    try {
      const key = this._clientCacheKey(url);
      const raw = sessionStorage.getItem(key);
      if (!raw) return null;
      const { data, fetchedAt } = JSON.parse(raw);
      if (
        !Array.isArray(data) ||
        typeof fetchedAt !== "number" ||
        Date.now() - fetchedAt > this._clientCacheTtlMs
      ) {
        sessionStorage.removeItem(key);
        return null;
      }
      return data;
    } catch (e) {
      return null;
    }
  }

  _setClientCachedEvents(url, events) {
    try {
      const key = this._clientCacheKey(url);
      sessionStorage.setItem(
        key,
        JSON.stringify({ data: events, fetchedAt: Date.now() }),
      );
    } catch (e) {
      // Ignore storage errors
    }
  }

  async loadLocalCalendarEvents() {
    console.log("Loading events from local calendar file...");

    try {
      const response = await fetch("./google-calendar-events");
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const text = await response.text();
      // Parse the JSON data (it starts with "items": so we need to wrap it)
      const jsonText = text.trim().startsWith('"items"') ? `{${text}}` : text;
      const data = JSON.parse(jsonText);

      console.log(`Found ${data.items?.length || 0} calendar items`);

      if (!data.items || data.items.length === 0) {
        throw new Error("No events found in calendar file");
      }

      // Transform and filter events
      this.events = await this.processCalendarItems(data.items);
      console.log(`Processed ${this.events.length} events for display`);

      // If no events after filtering, throw error to trigger fallback to sample data
      if (this.events.length === 0) {
        console.warn(
          "No upcoming events found in calendar file (all events may be in the past)",
        );
        throw new Error(
          "No upcoming events found in calendar file (all events may be in the past)",
        );
      }

      if (this.utils) {
        this.utils.showToast(
          `Loaded ${this.events.length} events from calendar`,
          "success",
        );
      }
    } catch (error) {
      console.error("Failed to load local calendar events:", error);

      if (this.utils) {
        this.utils.showToast("Failed to load calendar events", "error");
      }

      throw error;
    }
  }

  async processCalendarItems(items) {
    const processedEvents = [];
    const now = new Date();

    for (let i = 0; i < items.length; i++) {
      const item = items[i];

      try {
        // Skip announcements (they are loaded separately via loadAnnouncements)
        if (this.isAnnouncementItem(item)) {
          continue;
        }

        // Check if event is in the past
        const eventDate = new Date(item.start?.dateTime || item.start?.date);
        const eventDateTime = new Date(
          item.start?.dateTime || `${item.start?.date}T23:59:59`,
        );
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const eventDateOnly = new Date(eventDate);
        eventDateOnly.setHours(0, 0, 0, 0);

        // Skip events from previous days, but keep today's events even if elapsed
        if (eventDateOnly < today) {
          continue;
        }

        // Transform to our event format
        const event = await this.transformCalendarItem(
          item,
          processedEvents.length + 1,
        );

        // Mark event as elapsed if it's today but the time has passed
        event.isElapsed =
          eventDateTime < now && eventDateOnly.getTime() === today.getTime();

        // Skip events without valid location coordinates
        if (event.lat === 0 && event.lng === 0) {
          console.warn(
            `Skipping event "${event.title}" - no valid coordinates`,
          );
          continue;
        }

        processedEvents.push(event);
      } catch (error) {
        console.warn(`Error processing event "${item.summary}":`, error);
        continue;
      }
    }

    // Sort events by date
    processedEvents.sort((a, b) => new Date(a.date) - new Date(b.date));

    return processedEvents;
  }

  async transformCalendarItem(item, id) {
    // Clean and sanitise the data
    const title = this.sanitiseText(item.summary || "Unnamed Event");
    const description = this.sanitiseHtml(
      item.description || "No description available",
    );
    const location = this.sanitiseText(item.location || "Location TBD");

    const categorization = this.categorizeEvent(title, description);

    const event = {
      id: id,
      title: title,
      description: description,
      category: categorization.primary,
      categories: categorization.tags,
      date: this.extractDate(item),
      time: this.extractTime(item),
      startTime: this.extractStartTime(item),
      endTime: this.extractEndTime(item),
      location: location,
      organizer: this.extractOrganizer(item),
      originalEvent: item, // Keep reference for debugging
    };

    // Get coordinates for the location (pass event title as venue name for better geocoding)
    const coordinates = await this.getCoordinatesForLocation(
      location,
      event.title,
    );
    event.lat = coordinates.lat;
    event.lng = coordinates.lng;

    return event;
  }

  sanitiseText(text) {
    // Use enhanced sanitisation from utils if available
    if (this.utils && this.utils.sanitiseText) {
      return this.utils.sanitiseText(text);
    }

    // Fallback to basic sanitisation
    if (!text) return "";
    return text
      .replace(/<[^>]*>/g, "")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&amp;/g, "&")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .trim();
  }

  sanitiseHtml(html) {
    // Use enhanced sanitisation from utils if available
    if (this.utils && this.utils.sanitiseHtml) {
      return this.utils.sanitiseHtml(html);
    }

    // Fallback to basic sanitisation
    if (!html) return "";
    return html
      .replace(/<p[^>]*>/g, "")
      .replace(/<\/p>/g, "\n")
      .replace(/<br[^>]*>/g, "\n")
      .replace(/<[^>]*>/g, "")
      .replace(/\n+/g, " ")
      .trim();
  }

  sanitiseAnnouncementText(text) {
    if (!text) return "";

    return String(text)
      .replace(/\r\n/g, "\n")
      .replace(/<p[^>]*>/gi, "")
      .replace(/<\/p>/gi, "\n\n")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<li[^>]*>/gi, "• ")
      .replace(/<\/li>/gi, "\n")
      .replace(/<\/div>/gi, "\n")
      .replace(/<[^>]*>/g, "")
      .replace(/&nbsp;/gi, " ")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&amp;/g, "&")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  getAnnouncementType(title = "") {
    const normalisedTitle = String(title).toLowerCase();

    if (normalisedTitle.includes("veterans for veterans in care")) {
      return "Veterans for Veterans in Care";
    }

    if (normalisedTitle.includes("useful information")) {
      return "Useful Information";
    }

    return "Public Announcement";
  }

  extractOrganizer(item) {
    // Try to extract organizer from various fields
    if (item.organizer?.displayName) {
      return item.organizer.displayName;
    }
    if (item.creator?.displayName) {
      return item.creator.displayName;
    }

    // Default to VFVIC for events from this calendar
    return "VFVIC";
  }

  async loadGoogleCalendarEvents() {
    // Check if configuration is available
    const config = window.CALENDAR_CONFIG;
    if (!config || !config.API_KEY || !config.CALENDAR_ID) {
      throw new Error(
        "Google Calendar configuration not found. Copy config.example.js to config.js and fill in your details.",
      );
    }

    if (config.API_KEY === "your-google-calendar-api-key-here") {
      throw new Error(
        "Please configure your Google Calendar API key in config.js",
      );
    }

    try {
      const timeMin = new Date().toISOString();
      const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(
        config.CALENDAR_ID,
      )}/events?key=${
        config.API_KEY
      }&timeMin=${timeMin}&singleEvents=true&orderBy=startTime&maxResults=${
        config.MAX_EVENTS || 50
      }`;

      console.log("Loading events from Google Calendar...");
      const response = await fetch(url);

      if (!response.ok) {
        throw new Error(
          `Google Calendar API error: ${response.status} ${response.statusText}`,
        );
      }

      const data = await response.json();
      console.log(`Found ${data.items?.length || 0} events in calendar`);

      if (!data.items || data.items.length === 0) {
        console.warn("No events found in Google Calendar");
        this.events = [];
        return;
      }

      // Transform calendar events to our format
      const transformedEvents = [];
      for (let i = 0; i < data.items.length; i++) {
        const calendarEvent = data.items[i];

        // Skip public announcements (they are shown in the PA banner)
        if (this.isAnnouncementItem(calendarEvent)) {
          continue;
        }

        const transformedEvent = await this.transformGoogleCalendarEvent(
          calendarEvent,
          i + 1,
        );
        transformedEvents.push(transformedEvent);
      }

      this.events = transformedEvents;
      console.log(`Successfully loaded ${this.events.length} events`);
    } catch (error) {
      console.error("Failed to load Google Calendar events:", error);
      throw error;
    }
  }

  async transformGoogleCalendarEvent(calendarEvent, index) {
    // Transform Google Calendar event to our format
    const categorization = this.categorizeEvent(
      calendarEvent.summary,
      calendarEvent.description,
    );

    const event = {
      id: index,
      title: calendarEvent.summary || "Unnamed Event",
      description: calendarEvent.description || "No description available",
      category: categorization.primary || categorization,
      categories: categorization.tags || [categorization],
      date: this.extractDate(calendarEvent),
      time: this.extractTime(calendarEvent),
      startTime: this.extractStartTime(calendarEvent),
      endTime: this.extractEndTime(calendarEvent),
      location: calendarEvent.location || "Location TBD",
      organizer: calendarEvent.organizer?.displayName || "VFVIC",
      originalEvent: calendarEvent, // Keep reference for debugging
    };

    // Get coordinates for the location
    const coordinates = await this.getCoordinatesForLocation(event.location);
    event.lat = coordinates.lat;
    event.lng = coordinates.lng;

    return event;
  }

  extractDate(calendarEvent) {
    // Handle both all-day and timed events
    if (calendarEvent.start?.date) {
      return calendarEvent.start.date; // All-day event
    } else if (calendarEvent.start?.dateTime) {
      return calendarEvent.start.dateTime.split("T")[0]; // Timed event
    }
    return new Date().toISOString().split("T")[0]; // Fallback to today
  }

  extractTime(calendarEvent) {
    // Extract time range for display
    const startTime = this.extractStartTime(calendarEvent);
    const endTime = this.extractEndTime(calendarEvent);

    if (!startTime && !endTime) {
      return "All day";
    }

    if (startTime && endTime && startTime !== endTime) {
      return `${startTime} - ${endTime}`;
    }

    return startTime || "Time TBD";
  }

  extractStartTime(calendarEvent) {
    if (calendarEvent.start?.dateTime) {
      const dateTime = new Date(calendarEvent.start.dateTime);
      return this.formatTime(dateTime);
    }
    return null; // All-day events don't have times
  }

  extractEndTime(calendarEvent) {
    if (calendarEvent.end?.dateTime) {
      const dateTime = new Date(calendarEvent.end.dateTime);
      return this.formatTime(dateTime);
    }
    return null; // All-day events don't have times
  }

  formatTime(date) {
    // Format time in 12-hour format with AM/PM
    return date.toLocaleTimeString("en-GB", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false, // Use 24-hour format for UK
    });
  }

  async getCoordinatesForLocation(location, venueName = null) {
    const normalisedKey = (location || "")
      .trim()
      .toLowerCase()
      .replace(/\s+/g, " ");
    if (normalisedKey && this._geocodeCache[normalisedKey]) {
      return this._geocodeCache[normalisedKey];
    }

    const config = window.CALENDAR_CONFIG;

    // Debug: Log geocoding attempt
    console.log(
      `[Geocoding] Attempting to geocode: "${location}" (venue: ${venueName || "N/A"})`,
    );
    console.log(
      `[Geocoding] Config ENABLE_GEOCODING: ${config?.ENABLE_GEOCODING}`,
    );
    console.log(
      `[Geocoding] Config GEOCODING_API_KEY exists: ${!!config?.GEOCODING_API_KEY && config.GEOCODING_API_KEY !== "your-google-geocoding-api-key-here"}`,
    );

    let result = null;

    // Use Google Geocoding API directly (simplified for debugging)
    if (
      config?.ENABLE_GEOCODING &&
      config?.GEOCODING_API_KEY &&
      config.GEOCODING_API_KEY !== "your-google-geocoding-api-key-here"
    ) {
      try {
        const googleCoords = await this.geocodeWithGoogle(location, venueName);
        if (googleCoords) {
          console.log(
            `[Geocoding] SUCCESS: "${location}" -> [${googleCoords.lat}, ${googleCoords.lng}]`,
          );
          result = googleCoords;
        }
      } catch (error) {
        console.error(`[Geocoding] FAILED for "${location}":`, error);
      }
    } else {
      console.warn(
        `[Geocoding] Skipped - geocoding disabled or API key missing`,
      );
    }

    if (!result) {
      // Fallback: Try predefined locations for common Northeast England venues
      const knownCoords = this.getKnownLocationCoordinates(location);
      if (knownCoords) {
        console.log(`[Geocoding] Using known location for "${location}"`);
        result = knownCoords;
      }
    }

    if (!result) {
      // Last resort: Generate unique coordinates using hash-based offset
      console.warn(
        `[Geocoding] Using fallback hash coordinates for "${location}"`,
      );
      const fallbackCoords = config?.DEFAULT_REGION || {
        lat: 54.9783,
        lng: -1.6178,
      };
      result = this.generateUniqueCoordinates(location, fallbackCoords);
    }

    if (normalisedKey && result) {
      this._geocodeCache[normalisedKey] = result;
    }
    return result;
  }

  // Geocode address using Google Geocoding API
  async geocodeWithGoogle(address, venueName = null) {
    const config = window.CALENDAR_CONFIG;

    // Use the full address as-is (Google Calendar locations are usually complete)
    const searchQuery = address;
    console.log(`[Google Geocoding] Querying: "${searchQuery}"`);

    const response = await fetch(
      `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(
        searchQuery,
      )}&key=${config.GEOCODING_API_KEY}`,
    );

    if (!response.ok) {
      throw new Error(`Google Geocoding API HTTP error: ${response.status}`);
    }

    const data = await response.json();
    console.log(`[Google Geocoding] Response status: ${data.status}`);

    if (data.status === "OK" && data.results && data.results.length > 0) {
      const location = data.results[0].geometry.location;
      const formattedAddress = data.results[0].formatted_address;
      console.log(
        `[Google Geocoding] Resolved to: "${formattedAddress}" [${location.lat}, ${location.lng}]`,
      );
      return { lat: location.lat, lng: location.lng };
    } else if (data.status === "REQUEST_DENIED") {
      console.error(
        `[Google Geocoding] REQUEST_DENIED - Check API key permissions. Error: ${data.error_message}`,
      );
      throw new Error(`API key issue: ${data.error_message}`);
    } else if (data.status === "OVER_QUERY_LIMIT") {
      console.error(`[Google Geocoding] OVER_QUERY_LIMIT - Too many requests`);
      throw new Error("Over query limit");
    } else if (data.status === "ZERO_RESULTS") {
      console.warn(`[Google Geocoding] No results for: "${searchQuery}"`);
      throw new Error("No results found");
    } else {
      console.error(`[Google Geocoding] Unexpected status: ${data.status}`);
      throw new Error(`Google API error: ${data.status}`);
    }
  }

  generateUniqueCoordinates(location, baseCoords) {
    // Create a simple hash from the location string
    let hash = 0;
    for (let i = 0; i < location.length; i++) {
      const char = location.charCodeAt(i);
      hash = (hash << 5) - hash + char;
      hash = hash & hash; // Convert to 32-bit integer
    }

    // Use hash to create small offsets (within ~1km radius)
    const offsetRange = 0.008; // Roughly 1km at this latitude
    const latOffset = ((hash % 1000) / 1000 - 0.5) * offsetRange;
    const lngOffset = (((hash >> 10) % 1000) / 1000 - 0.5) * offsetRange;

    return {
      lat: baseCoords.lat + latOffset,
      lng: baseCoords.lng + lngOffset,
    };
  }

  getKnownLocationCoordinates(location) {
    const locationMap = {
      // Major cities in Northeast England (these are now fallbacks)
      newcastle: { lat: 54.9783, lng: -1.6178 },
      "newcastle upon tyne": { lat: 54.9783, lng: -1.6178 },
      sunderland: { lat: 54.9069, lng: -1.3838 },
      middlesbrough: { lat: 54.5742, lng: -1.2349 },
      durham: { lat: 54.7753, lng: -1.5849 },
      gateshead: { lat: 54.9537, lng: -1.6103 },
      hartlepool: { lat: 54.6896, lng: -1.2115 },
      "south shields": { lat: 54.9986, lng: -1.4323 },
      "north shields": { lat: 55.0176, lng: -1.4486 },
      tynemouth: { lat: 55.0179, lng: -1.4217 },
      "whitley bay": { lat: 55.039, lng: -1.4465 },
      cramlington: { lat: 55.0789, lng: -1.5906 },
      hexham: { lat: 54.9719, lng: -2.1019 },
      consett: { lat: 54.8521, lng: -1.8317 },
      stanley: { lat: 54.8697, lng: -1.6947 },
      "chester-le-street": { lat: 54.8556, lng: -1.5706 },
      washington: { lat: 54.9, lng: -1.5197 },
      jarrow: { lat: 54.9806, lng: -1.4847 },
      hebburn: { lat: 54.9733, lng: -1.5114 },
      seaham: { lat: 54.8387, lng: -1.3467 },
      ferryhill: { lat: 54.6998, lng: -1.5639 },
      spennymoor: { lat: 54.6998, lng: -1.5996 },
      "bishop auckland": { lat: 54.6612, lng: -1.6776 },
      peterlee: { lat: 54.761, lng: -1.3372 },
      blyth: { lat: 55.1278, lng: -1.5085 },
      ashington: { lat: 55.1883, lng: -1.5686 },

      // Specific venues with unique coordinates (more precise)
      "dawdon youth and community centre": { lat: 54.84, lng: -1.348 },
      "royal british legion hebburn": { lat: 54.974, lng: -1.512 },
      "royal british legion branch meeting": { lat: 54.974, lng: -1.512 },
      "royal british legion": { lat: 54.999, lng: -1.433 }, // South Shields default
      "spennymoor clay pigeon club": { lat: 54.701, lng: -1.565 },
      "west house farm": { lat: 54.702, lng: -1.566 },
      "iona social club": { lat: 54.975, lng: -1.513 },
      "hebburn iona social club": { lat: 54.975, lng: -1.513 },
      "hebburn iona social club, station rd": { lat: 54.975, lng: -1.513 },

      // Newcastle specific venues with unique coordinates
      "newcastle civic centre": { lat: 54.972, lng: -1.61 },
      "newcastle university": { lat: 54.98, lng: -1.613 },
      "st james park": { lat: 54.9755, lng: -1.622 },
      quayside: { lat: 54.969, lng: -1.604 },
      "central station": { lat: 54.968, lng: -1.617 },
      monument: { lat: 54.973, lng: -1.614 },
      "grainger market": { lat: 54.971, lng: -1.612 },
      "eldon square": { lat: 54.975, lng: -1.616 },

      // Additional specific venues to prevent clustering
      "walker activity dome": { lat: 54.985, lng: -1.58 },
      "byker community centre": { lat: 54.982, lng: -1.595 },
      "scotswood community centre": { lat: 54.965, lng: -1.66 },
      "benwell community centre": { lat: 54.97, lng: -1.64 },
      "arthurs hill community centre": { lat: 54.976, lng: -1.63 },
      "elswick community centre": { lat: 54.972, lng: -1.635 },
    };

    if (!location) return null;

    const locationLower = location.toLowerCase();

    // Direct match first (most specific)
    if (locationMap[locationLower]) {
      return locationMap[locationLower];
    }

    // Look for specific venue names (longer matches first)
    const venues = Object.keys(locationMap)
      .filter((venue) => venue.includes(" "))
      .sort((a, b) => b.length - a.length);
    for (const venue of venues) {
      if (locationLower.includes(venue)) {
        return locationMap[venue];
      }
    }

    // City-level matching with deterministic offset to avoid overlapping markers
    const cities = [
      "newcastle upon tyne",
      "newcastle",
      "sunderland",
      "middlesbrough",
      "durham",
      "gateshead",
      "hartlepool",
    ];
    for (const city of cities) {
      if (locationLower.includes(city)) {
        const baseCoords = locationMap[city];
        if (baseCoords) {
          // Create deterministic offset based on location string hash
          const offset = this.getLocationOffset(location);
          return {
            lat: baseCoords.lat + offset.lat,
            lng: baseCoords.lng + offset.lng,
          };
        }
      }
    }

    return null;
  }

  // Generate deterministic coordinate offset based on location string to avoid overlapping markers
  getLocationOffset(location) {
    // Simple hash function for location string
    let hash = 0;
    for (let i = 0; i < location.length; i++) {
      const char = location.charCodeAt(i);
      hash = (hash << 5) - hash + char;
      hash = hash & hash; // Convert to 32-bit integer
    }

    // Convert hash to offset values (±0.008 degrees ≈ ±800m max)
    const maxOffset = 0.008;
    const latOffset = ((hash % 1000) / 1000 - 0.5) * maxOffset;
    const lngOffset = (((hash >>> 16) % 1000) / 1000 - 0.5) * maxOffset;

    return { lat: latOffset, lng: lngOffset };
  }

  async geocodeLocation(address, venueName = null) {
    const config = window.CALENDAR_CONFIG;
    try {
      // Combine venue name and location for better accuracy
      let searchQuery = address;
      if (venueName) {
        searchQuery = `${venueName}, ${address}`;
      }

      const query = encodeURIComponent(searchQuery);

      // Use Google Maps Geocoding API
      const response = await fetch(
        `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(
          address + ", Northeast England, UK",
        )}&key=${config.GEOCODING_API_KEY}`,
      );

      if (!response.ok) {
        throw new Error(`Geocoding API error: ${response.status}`);
      }

      const data = await response.json();
      if (data.results && data.results.length > 0) {
        const location = data.results[0].geometry.location;
        return { lat: location.lat, lng: location.lng };
      } else {
        throw new Error("No geocoding results found");
      }
    } catch (error) {
      console.error("Geocoding failed:", error);
      throw error;
    }
  }

  categorizeEvent(title, description) {
    const titleLower = (title || "").toLowerCase();
    const descLower = (description || "").toLowerCase();
    const combined = titleLower + " " + descLower;

    const tags = [];

    // Drop-in patterns
    if (
      descLower.includes("drop in") ||
      descLower.includes("drop-in") ||
      combined.includes("drop in") ||
      combined.includes("drop-in")
    ) {
      tags.push("drop-in");
    }

    // Support patterns
    if (
      combined.includes("support") ||
      combined.includes("counselling") ||
      combined.includes("therapy") ||
      combined.includes("help") ||
      combined.includes("advice") ||
      combined.includes("welfare")
    ) {
      tags.push("support");
    }

    // Breakfast Club patterns (more specific to avoid false positives)
    if (
      combined.includes("breakfast club") ||
      (combined.includes("breakfast") && !combined.includes("clay pigeon")) ||
      (combined.includes("naafi break") && !descLower.includes("drop in"))
    ) {
      tags.push("breakfast-club");
    }

    // Meeting patterns
    if (
      combined.includes("meeting") ||
      combined.includes("branch meeting") ||
      combined.includes("association") ||
      combined.includes("rbl") ||
      combined.includes("royal british legion") ||
      combined.includes("dli")
    ) {
      tags.push("meeting");
    }

    // Workshop patterns
    if (
      combined.includes("workshop") ||
      combined.includes("training") ||
      combined.includes("course") ||
      combined.includes("seminar")
    ) {
      tags.push("workshop");
    }

    // Social patterns
    if (
      combined.includes("social") ||
      combined.includes("mixer") ||
      combined.includes("party") ||
      combined.includes("celebration")
    ) {
      tags.push("social");
    }

    // Sport & Recreation patterns (highest priority for sport activities)
    if (
      combined.includes("clay pigeon") ||
      combined.includes("shooting") ||
      titleLower.includes("sport") ||
      combined.includes("football") ||
      combined.includes("rugby") ||
      combined.includes("sailing") ||
      combined.includes("fishing") ||
      combined.includes("golf") ||
      combined.includes("cycling") ||
      combined.includes("walking") ||
      combined.includes("hiking") ||
      combined.includes("swimming") ||
      combined.includes("offshore sailing")
    ) {
      tags.push("sport");
    }

    // Return array of tags and primary category
    return {
      tags: tags,
      primary: tags.length > 0 ? tags[0] : "other",
    };
  }

  loadSampleEvents() {
    // Show notification that sample data is being used
    this.showSampleDataNotification();

    // Sample veteran events data for November & December 2025 - Northeast England
    this.events = [
      // NOVEMBER 2025 EVENTS
      {
        id: 1,
        title: "Veterans Breakfast Club - Newcastle",
        description:
          "Weekly breakfast meetup for veterans in Newcastle. Come and join fellow veterans for a friendly chat over breakfast. All veterans and serving personnel welcome.",
        category: "breakfast-club",
        categories: ["breakfast-club", "social"],
        date: "2025-11-06",
        time: "09:00 - 11:00",
        startTime: "09:00",
        endTime: "11:00",
        location: "Newcastle upon Tyne, UK",
        lat: 54.9783,
        lng: -1.6178,
        organizer: "VFVIC",
      },
      {
        id: 2,
        title: "Veterans Drop-In Centre",
        description:
          "Open drop-in centre for veterans needing support, advice, or just a chat. Free tea and coffee. Benefits advice available. No appointment necessary.",
        category: "drop-in",
        categories: ["drop-in", "support"],
        date: "2025-11-07",
        time: "10:00 - 15:00",
        startTime: "10:00",
        endTime: "15:00",
        location: "Sunderland, UK",
        lat: 54.9069,
        lng: -1.3838,
        organizer: "VFVIC",
      },
      {
        id: 3,
        title: "Remembrance Day Parade & Service",
        description:
          "Annual Remembrance Day parade and service. All veterans invited to march. Wreath laying ceremony at war memorial. Family and public welcome.",
        category: "remembrance",
        categories: ["remembrance", "social"],
        date: "2025-11-11",
        time: "10:00 - 12:00",
        startTime: "10:00",
        endTime: "12:00",
        location: "Alnwick, UK",
        lat: 55.4136,
        lng: -1.7062,
        organizer: "Northumberland Royal British Legion",
      },
      {
        id: 4,
        title: "PTSD Support Group",
        description:
          "Confidential peer support group for veterans dealing with PTSD and mental health challenges. Professional counsellor present. Safe, understanding environment.",
        category: "support",
        categories: ["support", "mental-health"],
        date: "2025-11-12",
        time: "18:00 - 20:00",
        startTime: "18:00",
        endTime: "20:00",
        location: "Darlington, UK",
        lat: 54.525,
        lng: -1.5531,
        organizer: "Combat Stress",
      },
      {
        id: 5,
        title: "Veterans Breakfast Club - Seaham",
        description:
          "Morning breakfast club for veterans. Relaxed atmosphere, good food, great company. All veterans welcome regardless of service or length.",
        category: "breakfast-club",
        categories: ["breakfast-club", "social"],
        date: "2025-11-13",
        time: "09:00 - 11:00",
        startTime: "09:00",
        endTime: "11:00",
        location: "Seaham, UK",
        lat: 54.8391,
        lng: -1.3425,
        organizer: "VFVIC",
      },
      {
        id: 6,
        title: "Employment Workshop for Veterans",
        description:
          "CV writing, interview skills, and job search strategies workshop. Connect with veteran-friendly employers. Free lunch provided.",
        category: "workshop",
        categories: ["workshop", "training"],
        date: "2025-11-14",
        time: "10:00 - 15:00",
        startTime: "10:00",
        endTime: "15:00",
        location: "Berwick-upon-Tweed, UK",
        lat: 55.7709,
        lng: -2.0072,
        organizer: "Veterans Gateway",
      },
      {
        id: 7,
        title: "Friday Social at Legion",
        description:
          "Weekly social evening at the Royal British Legion. Pool, darts, and good conversation. Partners and families welcome. Bar available.",
        category: "social",
        categories: ["social"],
        date: "2025-11-15",
        time: "19:00 - 23:00",
        startTime: "19:00",
        endTime: "23:00",
        location: "Ashington, UK",
        lat: 55.1833,
        lng: -1.5667,
        organizer: "Royal British Legion",
      },
      {
        id: 8,
        title: "Veterans Walking Group",
        description:
          "Moderate 5-mile countryside walk. All fitness levels welcome. Finish at local pub for optional lunch. Dogs welcome on leads.",
        category: "sport",
        categories: ["sport", "social", "health"],
        date: "2025-11-16",
        time: "10:00 - 13:00",
        startTime: "10:00",
        endTime: "13:00",
        location: "Kielder, UK",
        lat: 55.2384,
        lng: -2.5827,
        organizer: "Walking With The Wounded",
      },
      {
        id: 9,
        title: "Veterans Art Therapy Session",
        description:
          "Creative art therapy for wellbeing. No art experience needed. All materials provided. Express yourself in a supportive environment.",
        category: "workshop",
        categories: ["workshop", "mental-health", "wellbeing"],
        date: "2025-11-18",
        time: "13:00 - 15:00",
        startTime: "13:00",
        endTime: "15:00",
        location: "Bishop Auckland, UK",
        lat: 54.6603,
        lng: -1.6781,
        organizer: "Arts for Veterans",
      },
      {
        id: 10,
        title: "Armed Forces Covenant Meeting",
        description:
          "Quarterly meeting to discuss local support for armed forces community. Open to all interested veterans and service providers.",
        category: "meeting",
        categories: ["meeting"],
        date: "2025-11-19",
        time: "14:00 - 16:00",
        startTime: "14:00",
        endTime: "16:00",
        location: "Stockton-on-Tees, UK",
        lat: 54.5703,
        lng: -1.3188,
        organizer: "Stockton Council",
      },
      {
        id: 11,
        title: "Veterans Breakfast Club - Morpeth",
        description:
          "Weekly breakfast meetup for veterans. Informal gathering, no agenda, just good company and conversation.",
        category: "breakfast-club",
        categories: ["breakfast-club", "social"],
        date: "2025-11-20",
        time: "09:00 - 11:00",
        startTime: "09:00",
        endTime: "11:00",
        location: "Morpeth, UK",
        lat: 55.1658,
        lng: -1.6889,
        organizer: "VFVIC",
      },
      {
        id: 12,
        title: "Women Veterans Coffee Morning",
        description:
          "Coffee morning specifically for women veterans. Safe space to share experiences and build connections. Childcare available if needed.",
        category: "social",
        categories: ["social", "support"],
        date: "2025-11-21",
        time: "10:00 - 12:00",
        startTime: "10:00",
        endTime: "12:00",
        location: "Whitley Bay, UK",
        lat: 55.0425,
        lng: -1.4434,
        organizer: "VFVIC",
      },
      {
        id: 13,
        title: "Veterans Five-a-Side Football",
        description:
          "Weekly five-a-side football for veterans. All abilities welcome. Indoor pitch, changing facilities available. Just turn up and play.",
        category: "sport",
        categories: ["sport", "health"],
        date: "2025-11-22",
        time: "14:00 - 16:00",
        startTime: "14:00",
        endTime: "16:00",
        location: "Blyth, UK",
        lat: 55.1267,
        lng: -1.5083,
        organizer: "Help for Heroes",
      },
      {
        id: 14,
        title: "Veterans Drop-In Centre",
        description:
          "Weekly drop-in for advice, support, and companionship. Benefits experts and mental health support available. All welcome.",
        category: "drop-in",
        categories: ["drop-in", "support"],
        date: "2025-11-25",
        time: "10:00 - 15:00",
        startTime: "10:00",
        endTime: "15:00",
        location: "Hartlepool, UK",
        lat: 54.6896,
        lng: -1.2115,
        organizer: "VFVIC",
      },
      {
        id: 15,
        title: "Veterans Breakfast Club - Consett",
        description:
          "Weekly breakfast gathering. Great food, friendly faces, supportive atmosphere. Everyone has a story to share.",
        category: "breakfast-club",
        categories: ["breakfast-club", "social"],
        date: "2025-11-27",
        time: "09:00 - 11:00",
        startTime: "09:00",
        endTime: "11:00",
        location: "Consett, UK",
        lat: 54.85,
        lng: -1.8333,
        organizer: "VFVIC",
      },
      {
        id: 16,
        title: "Christmas Preparation Meeting",
        description:
          "Planning meeting for Christmas events and activities. All veterans invited to contribute ideas and help organize festive celebrations.",
        category: "meeting",
        categories: ["meeting", "social"],
        date: "2025-11-28",
        time: "18:00 - 20:00",
        startTime: "18:00",
        endTime: "20:00",
        location: "Chester-le-Street, UK",
        lat: 54.8587,
        lng: -1.5741,
        organizer: "VFVIC",
      },

      // DECEMBER 2025 EVENTS
      {
        id: 17,
        title: "Veterans Breakfast Club - Cramlington",
        description:
          "First breakfast club of December. Start the festive month with good company and a hearty breakfast.",
        category: "breakfast-club",
        categories: ["breakfast-club", "social"],
        date: "2025-12-04",
        time: "09:00 - 11:00",
        startTime: "09:00",
        endTime: "11:00",
        location: "Cramlington, UK",
        lat: 55.0866,
        lng: -1.5819,
        organizer: "VFVIC",
      },
      {
        id: 18,
        title: "Veterans Drop-In Centre - Christmas Edition",
        description:
          "Special Christmas-themed drop-in with festive treats. Advice services still available plus some holiday cheer.",
        category: "drop-in",
        categories: ["drop-in", "social"],
        date: "2025-12-05",
        time: "10:00 - 15:00",
        startTime: "10:00",
        endTime: "15:00",
        location: "Redcar, UK",
        lat: 54.6186,
        lng: -1.0686,
        organizer: "VFVIC",
      },
      {
        id: 19,
        title: "Winter Wellness Workshop",
        description:
          "Workshop on managing mental health during winter months. Coping strategies, support networks, and practical tips. Seasonal Affective Disorder information.",
        category: "workshop",
        categories: ["workshop", "mental-health", "wellbeing"],
        date: "2025-12-06",
        time: "13:00 - 16:00",
        startTime: "13:00",
        endTime: "16:00",
        location: "Hexham, UK",
        lat: 54.9708,
        lng: -2.1008,
        organizer: "Combat Stress",
      },
      {
        id: 20,
        title: "Veterans Family Christmas Party",
        description:
          "Christmas party for veterans and families. Santa visit for kids, festive food, entertainment, and games. Free event, all ages welcome.",
        category: "social",
        categories: ["social", "family"],
        date: "2025-12-07",
        time: "14:00 - 18:00",
        startTime: "14:00",
        endTime: "18:00",
        location: "Durham, UK",
        lat: 54.7753,
        lng: -1.5849,
        organizer: "VFVIC",
      },
      {
        id: 21,
        title: "PTSD Support Group - December",
        description:
          "Monthly PTSD support group. Extra session available given holiday season can be challenging. Professional support and peer understanding.",
        category: "support",
        categories: ["support", "mental-health"],
        date: "2025-12-10",
        time: "18:00 - 20:00",
        startTime: "18:00",
        endTime: "20:00",
        location: "Peterlee, UK",
        lat: 54.7599,
        lng: -1.3363,
        organizer: "Combat Stress",
      },
      {
        id: 22,
        title: "Veterans Breakfast Club - Washington",
        description:
          "Pre-Christmas breakfast gathering. Festive atmosphere, good food, great friends.",
        category: "breakfast-club",
        categories: ["breakfast-club", "social"],
        date: "2025-12-11",
        time: "09:00 - 11:00",
        startTime: "09:00",
        endTime: "11:00",
        location: "Washington, UK",
        lat: 54.9,
        lng: -1.5167,
        organizer: "VFVIC",
      },
      {
        id: 23,
        title: "Christmas Wreath Making Workshop",
        description:
          "Create your own Christmas wreath. All materials provided. Take home your creation. Refreshments included. Festive fun for all.",
        category: "workshop",
        categories: ["workshop", "social"],
        date: "2025-12-12",
        time: "14:00 - 17:00",
        startTime: "14:00",
        endTime: "17:00",
        location: "Ponteland, UK",
        lat: 55.0481,
        lng: -1.7475,
        organizer: "Royal British Legion",
      },
      {
        id: 24,
        title: "Friday Social - Christmas Special",
        description:
          "Christmas-themed social evening. Festive decorations, seasonal music, Christmas quiz. Partners and families welcome. Festive buffet provided.",
        category: "social",
        categories: ["social"],
        date: "2025-12-13",
        time: "19:00 - 23:00",
        startTime: "19:00",
        endTime: "23:00",
        location: "Newton Aycliffe, UK",
        lat: 54.6167,
        lng: -1.5667,
        organizer: "Royal British Legion",
      },
      {
        id: 25,
        title: "Veterans Christmas Market Visit",
        description:
          "Group trip to Newcastle Christmas Market. Meet at station, explore market together, optional lunch. Great way to get into festive spirit.",
        category: "social",
        categories: ["social"],
        date: "2025-12-14",
        time: "11:00 - 15:00",
        startTime: "11:00",
        endTime: "15:00",
        location: "Newcastle upon Tyne, UK",
        lat: 54.9783,
        lng: -1.6178,
        organizer: "VFVIC",
      },
      {
        id: 26,
        title: "Women Veterans Christmas Coffee",
        description:
          "Christmas coffee morning for women veterans. Secret Santa (£5 limit), festive treats, and good conversation.",
        category: "social",
        categories: ["social"],
        date: "2025-12-16",
        time: "10:00 - 12:00",
        startTime: "10:00",
        endTime: "12:00",
        location: "Spennymoor, UK",
        lat: 54.7,
        lng: -1.6,
        organizer: "VFVIC",
      },
      {
        id: 27,
        title: "Veterans Breakfast Club - Prudhoe",
        description:
          "Last breakfast club before Christmas. Extra special festive breakfast. Great way to connect before the holidays.",
        category: "breakfast-club",
        categories: ["breakfast-club", "social"],
        date: "2025-12-18",
        time: "09:00 - 11:00",
        startTime: "09:00",
        endTime: "11:00",
        location: "Prudhoe, UK",
        lat: 54.9628,
        lng: -1.8556,
        organizer: "VFVIC",
      },
      {
        id: 28,
        title: "Christmas Day Lunch for Veterans",
        description:
          "Full Christmas dinner for veterans who would otherwise be alone. Transport can be arranged. All veterans welcome, bring a plus one if needed.",
        category: "social",
        categories: ["social", "support"],
        date: "2025-12-25",
        time: "12:00 - 16:00",
        startTime: "12:00",
        endTime: "16:00",
        location: "Middlesbrough, UK",
        lat: 54.5742,
        lng: -1.2349,
        organizer: "VFVIC & Royal British Legion",
      },
      {
        id: 29,
        title: "Boxing Day Walk",
        description:
          "Traditional Boxing Day countryside walk. Walk off the Christmas dinner! 6-mile route, moderate difficulty. Finish at country pub.",
        category: "sport",
        categories: ["sport", "social", "health"],
        date: "2025-12-26",
        time: "10:30 - 14:00",
        startTime: "10:30",
        endTime: "14:00",
        location: "Rothbury, UK",
        lat: 55.3097,
        lng: -1.9056,
        organizer: "Walking With The Wounded",
      },
      {
        id: 30,
        title: "New Year Planning Meeting",
        description:
          "Planning meeting for 2026 events and activities. Share your ideas for next year. All veterans invited to help shape our program.",
        category: "meeting",
        categories: ["meeting"],
        date: "2025-12-30",
        time: "14:00 - 16:00",
        startTime: "14:00",
        endTime: "16:00",
        location: "Bedlington, UK",
        lat: 55.1333,
        lng: -1.5833,
        organizer: "VFVIC",
      },
    ];

    // Note: Don't call initMap(), displayEvents(), etc. here
    // These are called by the init() method which invokes loadSampleEvents()
  }

  /**
   * Load public announcements independently from events.
   * Announcements are informational content without map locations.
   */
  async loadAnnouncements() {
    try {
      let items = [];

      if (this.dataSourceUrl) {
        // WordPress mode: reuse raw payload cache populated by loadFromWordPressEndpoint
        // to avoid a second network request to the same endpoint
        const url = this.dataSourceUrl.trim();
        if (url) {
          const rawKey = this._clientCacheKey(url) + "_raw";
          let rawItems = null;
          try {
            const c = sessionStorage.getItem(rawKey);
            if (c) {
              const { data, fetchedAt } = JSON.parse(c);
              if (
                Array.isArray(data) &&
                typeof fetchedAt === "number" &&
                Date.now() - fetchedAt <= this._clientCacheTtlMs
              ) {
                rawItems = data;
              }
            }
          } catch (e) {
            // sessionStorage unavailable
          }
          if (!rawItems) {
            // Cache miss: fetch and populate the raw cache for future use
            const response = await fetch(url, {
              method: "GET",
              credentials: "same-origin",
              headers: { Accept: "application/json" },
            });
            if (response.ok) {
              const parsed = await response.json();
              rawItems = Array.isArray(parsed) ? parsed : parsed.events || parsed.items || [];
              try {
                sessionStorage.setItem(
                  rawKey,
                  JSON.stringify({ data: rawItems, fetchedAt: Date.now() }),
                );
              } catch (e) {
                // Ignore storage errors
              }
            }
          }
          items = rawItems || [];
        }
      } else {
        // Standalone mode: try same local calendar file/format as events loader
        try {
          const response = await fetch("./google-calendar-events");
          if (response.ok) {
            const text = await response.text();
            // Parse the JSON data (it starts with "items": so we need to wrap it)
            const jsonText = text.trim().startsWith('"items"') ? `{${text}}` : text;
            const data = JSON.parse(jsonText);
            items = Array.isArray(data) ? data : data.items || data.events || [];
          }
        } catch (e) {
          // Local file not available, will fall back to sample announcements
        }
      }

      // Extract announcements (by recurringEventId) from fetched items
      for (const item of items) {
        if (this.isAnnouncementItem(item)) {
          const title = this.sanitiseText(
            item.summary || item.title || "Announcement",
          );
          const description = this.sanitiseAnnouncementText(
            item.description || "",
          );
          const id =
            item.recurringEventId ||
            item.id ||
            `announcement-${this.announcements.length}`;
          const announcement = {
            id,
            title,
            type: this.getAnnouncementType(title),
            description,
            date: this._normaliseDate(
              item.start?.dateTime || item.start?.date || item.date,
            ),
          };
          const existingIndex = this.announcements.findIndex(
            (a) => a.id === id,
          );

          if (title && title !== "Announcement") {
            if (existingIndex === -1) {
              this.announcements.push(announcement);
            } else {
              const existing = this.announcements[existingIndex];
              const shouldReplace =
                (!existing.description && !!announcement.description) ||
                announcement.description.length >
                  (existing.description || "").length ||
                (announcement.date || "") > (existing.date || "");

              if (shouldReplace) {
                this.announcements[existingIndex] = {
                  ...existing,
                  ...announcement,
                  description: announcement.description || existing.description,
                };
              }
            }
          }
        }
      }

      this.announcements.sort(
        (a, b) =>
          (b.date || "").localeCompare(a.date || "") ||
          a.title.localeCompare(b.title),
      );

      // If no announcements loaded and no data source (sample data mode), use sample announcements
      if (this.announcements.length === 0 && !this.dataSourceUrl) {
        this.loadSampleAnnouncements();
      }

      if (this.announcements.length > 0) {
        console.log(`[Announcements] Loaded ${this.announcements.length} public announcement(s)`);
      }
    } catch (error) {
      console.warn("[Announcements] Could not load announcements:", error);
      // Non-fatal: try sample announcements as fallback
      if (this.announcements.length === 0) {
        this.loadSampleAnnouncements();
      }
    }
  }

  /**
   * Load sample announcements for demo/testing purposes.
   */
  loadSampleAnnouncements() {
    this.announcements = [
      {
        id: "2scpgqhjtjh5tc33cg3jm3ik5c",
        title: "Useful Information",
        type: "Useful Information",
        description:
          "Some organisations that could be of help\n\nCombat Stress: 0800 138 1619 - Text 07537 173 683 - helpline@combatstress.org.uk - Veterans Mental Health Organisation 24/7 contact\n\nOp Courage: 0300 373 3332 - opcouragenorth@cntw.nhs.uk - Veterans Mental Health and Wellbeing Service\n\nOp Restore: Veterans Physical Health & Wellbeing Service for veterans with significant physical injuries caused by time in the Armed Forces. GP referral via imperial.oprestore@nhs.net\n\nSSAFA: 0800 260 6767 - www.ssafa.org.uk - Help with adaptations to your living environment when needed\n\nVeterans Gateway: www.veteransgateway.org.uk - An online directory of support for veterans",
      },
      {
        id: "30ed1sa1ev6k8kgp0ucg1mq24j",
        title: "Veterans for Veterans in Care",
        type: "Veterans for Veterans in Care",
        description:
          "Support visits and wellbeing contact for veterans in care settings. This notice is used for ongoing public awareness and signposting within the diary.\n\nIf you need more details or wish to connect a care setting with the programme, please contact the VFVIC team through the usual diary channels.",
      },
    ];
  }

  /**
   * Display public announcements in a banner after the header.
   * Users can collapse/expand, with state persisted to localStorage.
   */
  displayAnnouncements() {
    if (this.announcements.length === 0) return;

    // Check if already rendered
    if (document.getElementById("vfvic-announcements-banner")) return;

    // Check collapsed state from localStorage; default to false if storage is unavailable
    let isCollapsed = false;
    try {
      isCollapsed =
        localStorage.getItem("vfvic_announcements_collapsed") === "true";
    } catch (e) {
      // localStorage unavailable (e.g., private browsing, blocked storage)
      isCollapsed = false;
    }

    const banner = document.createElement("section");
    banner.id = "vfvic-announcements-banner";
    banner.className =
      "mb-5 rounded-xl border border-blue-100 bg-gradient-to-r from-blue-50 to-indigo-50 p-4 shadow-sm";

    // Build static banner shell (no user data in innerHTML)
    banner.innerHTML = `
      <div class="flex items-start justify-between gap-3">
        <div class="flex items-start gap-3 flex-1">
          <div class="mt-0.5 flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full bg-blue-100 text-blue-600">
            <svg class="h-5 w-5" fill="currentColor" viewBox="0 0 20 20">
              <path fill-rule="evenodd" d="M18 3a1 1 0 00-1.447-.894L8.763 6H5a3 3 0 000 6h.28l1.771 5.316A1 1 0 008 18h1a1 1 0 001-1v-4.382l6.553 3.276A1 1 0 0018 15V3z" clip-rule="evenodd" />
            </svg>
          </div>
          <div class="flex-1">
            <div class="flex flex-wrap items-center gap-2">
              <span class="text-base font-semibold text-slate-900">Public Announcements</span>
              <span id="vfvic-announcements-count" class="rounded-full bg-blue-600/10 px-2.5 py-0.5 text-xs font-semibold text-blue-800"></span>
            </div>
            <p class="mt-1 text-sm text-slate-600">Useful information and ongoing notices are collected here for quick reference.</p>
          </div>
        </div>
        <button
          id="vfvic-announcements-toggle"
          class="ml-3 text-blue-600 hover:text-blue-800 focus:outline-none"
          title="${isCollapsed ? "Expand" : "Collapse"} announcements"
          aria-label="${isCollapsed ? "Expand" : "Collapse"} announcements"
          aria-controls="vfvic-announcements-content"
          aria-expanded="${isCollapsed ? "false" : "true"}">
          <svg class="h-5 w-5 transition-transform ${isCollapsed ? "rotate-180" : ""}" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 15l7-7 7 7" />
          </svg>
        </button>
      </div>
      <div id="vfvic-announcements-content" class="${isCollapsed ? "hidden " : ""}mt-4 grid gap-3 md:grid-cols-2"></div>
    `;

    // Set count badge using textContent (safe)
    const countBadge = banner.querySelector("#vfvic-announcements-count");
    if (countBadge) {
      countBadge.textContent = `${this.announcements.length} item${this.announcements.length === 1 ? "" : "s"}`;
    }

    // Build announcement cards using DOM nodes to avoid XSS via user-supplied content
    const contentEl = banner.querySelector("#vfvic-announcements-content");
    this.announcements.forEach((a) => {
      const card = document.createElement("article");
      card.className =
        "rounded-lg border border-slate-200 bg-white/90 p-4 shadow-sm";

      const cardHeader = document.createElement("div");
      cardHeader.className =
        "mb-3 flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between";

      const titleWrap = document.createElement("div");

      if (a.type) {
        const typeBadge = document.createElement("span");
        typeBadge.className =
          "mb-2 inline-flex rounded-full bg-slate-100 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide text-slate-700";
        typeBadge.textContent = a.type;
        titleWrap.appendChild(typeBadge);
      }

      const titleEl = document.createElement("h4");
      titleEl.className = "text-base font-semibold text-slate-900";
      titleEl.textContent = a.title;
      titleWrap.appendChild(titleEl);

    /*   if (a.date) {
        const metaEl = document.createElement("p");
        metaEl.className = "mt-1 text-xs text-slate-500";
        metaEl.textContent = `Updated ${this.formatDate(a.date)}`;
        titleWrap.appendChild(metaEl);
      } */

      cardHeader.appendChild(titleWrap);
      card.appendChild(cardHeader);

      const bodyEl = document.createElement("div");
      bodyEl.className = "space-y-2 text-sm leading-6 text-slate-700";
      this._renderAnnouncementRichText(bodyEl, a.description);
      card.appendChild(bodyEl);

      contentEl.appendChild(card);
    });

    // Insert after header
    const header = document.querySelector("header");
    if (header && header.parentNode) {
      header.parentNode.insertBefore(banner, header.nextSibling);
    }

    // Add toggle functionality
    const toggleBtn = document.getElementById("vfvic-announcements-toggle");
    const content = document.getElementById("vfvic-announcements-content");
    if (toggleBtn && content) {
      toggleBtn.addEventListener("click", () => {
        content.classList.toggle("hidden");
        toggleBtn.querySelector("svg").classList.toggle("rotate-180");
        const isNowCollapsed = content.classList.contains("hidden");
        const label = isNowCollapsed
          ? "Expand announcements"
          : "Collapse announcements";
        toggleBtn.title = label;
        toggleBtn.setAttribute("aria-label", label);
        toggleBtn.setAttribute(
          "aria-expanded",
          isNowCollapsed ? "false" : "true",
        );
        try {
          localStorage.setItem("vfvic_announcements_collapsed", isNowCollapsed);
        } catch (e) {
          // localStorage unavailable (private browsing)
        }
      });
    }
  }

  _renderAnnouncementRichText(container, text) {
    const normalisedText = String(text || "")
      .replace(/\r\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();

    if (!normalisedText) {
      const emptyState = document.createElement("p");
      emptyState.className = "text-sm text-slate-600";
      emptyState.textContent = "More information will be shared soon.";
      container.appendChild(emptyState);
      return;
    }

    const blocks = normalisedText
      .split(/\n{2,}/)
      .map((block) => block.trim())
      .filter(Boolean);

    blocks.forEach((block, blockIndex) => {
      const lines = block
        .split(/\n+/)
        .map((line) => line.trim())
        .filter(Boolean);

      lines.forEach((line, lineIndex) => {
        this._appendAnnouncementLine(
          container,
          line,
          blockIndex === 0 && lineIndex === 0,
        );
      });
    });
  }

  _appendAnnouncementLine(container, line, isIntro = false) {
    const paragraph = document.createElement("p");
    paragraph.className = isIntro && !line.includes(":")
      ? "text-sm font-medium text-slate-800"
      : "text-sm text-slate-700";

    const cleanedLine = line.replace(/^[•\-]\s*/, "");
    const labelMatch = /^(?:https?:\/\/|www\.)/i.test(cleanedLine)
      ? null
      : cleanedLine.match(/^([A-Za-z][^:]{1,50}:)\s*(.*)$/s);

    if (labelMatch) {
      const label = document.createElement("strong");
      label.className = "font-semibold text-slate-900";
      label.textContent = `${labelMatch[1]} `;
      paragraph.appendChild(label);
      this._appendLinkedText(paragraph, labelMatch[2] || "");
    } else {
      this._appendLinkedText(paragraph, cleanedLine);
    }

    container.appendChild(paragraph);
  }

  _appendLinkedText(container, text) {
    const value = String(text || "");
    if (!value) return;

    const pattern =
      /(https?:\/\/[^\s<]+|www\.[^\s<]+|[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}|(?:\+?44\s?|\(?0\d{2,4}\)?\s?)[\d\s\-()]{6,}\d)/gi;
    let lastIndex = 0;
    let match;

    while ((match = pattern.exec(value)) !== null) {
      const matchedText = match[0];

      if (match.index > lastIndex) {
        container.appendChild(
          document.createTextNode(value.slice(lastIndex, match.index)),
        );
      }

      const link = document.createElement("a");
      link.className =
        "break-all font-medium text-blue-700 underline decoration-blue-200 underline-offset-2 hover:text-blue-900";
      link.textContent = matchedText;

      if (matchedText.includes("@")) {
        link.href = `mailto:${matchedText}`;
      } else if (/^(?:\+?44|\(?0\d)/.test(matchedText.trim())) {
        link.href = `tel:${matchedText.replace(/[^\d+]/g, "")}`;
      } else {
        link.href = matchedText.startsWith("http")
          ? matchedText
          : `https://${matchedText}`;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
      }

      container.appendChild(link);
      lastIndex = pattern.lastIndex;
    }

    if (lastIndex < value.length) {
      container.appendChild(document.createTextNode(value.slice(lastIndex)));
    }
  }

  /**
   * Truncate text to a maximum length with ellipsis.
   */
  _truncateText(text, maxLength) {
    if (!text || text.length <= maxLength) return text;
    return text.slice(0, maxLength).trim() + "...";
  }

  showSampleDataNotification() {
    // Create a notification banner for sample/fallback data
    const notification = document.createElement("div");
    notification.className =
      "bg-yellow-100 border-l-4 border-yellow-500 text-yellow-700 p-4 mb-5 rounded";
    notification.innerHTML = `
            <div class="flex">
                <div class="flex-shrink-0">
                    <svg class="h-5 w-5 text-yellow-400" viewBox="0 0 20 20" fill="currentColor">
                        <path fill-rule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clip-rule="evenodd" />
                    </svg>
                </div>
                <div class="ml-3">
                    <p class="text-sm">
                        <strong>Sample Data:</strong> Showing example VFVIC events for demonstration purposes.
                        These are not real events. Connect to a live calendar to display actual events.
                    </p>
                </div>
            </div>
        `;

    // Insert after the header
    const header = document.querySelector("header");
    header.parentNode.insertBefore(notification, header.nextSibling);
  }

  initMap() {
    // Initialize Leaflet map centered on Northeast England
    this.map = L.map("map").setView([54.9783, -1.6178], 8);

    // Add OpenStreetMap tiles (free, no API key required)
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: "© OpenStreetMap contributors",
    }).addTo(this.map);

    // Force map to recalculate size after container is fully rendered
    setTimeout(() => {
      this.map.invalidateSize();
    }, 100);

    // Also recalculate on window resize
    window.addEventListener("resize", () => {
      this.map.invalidateSize();
    });

    this.addMarkers();
  }

  addMarkers() {
    // Clear existing markers
    this.markers.forEach((marker) => this.map.removeLayer(marker));
    this.markers = [];

    // Limit markers for performance (prioritize closer events if sorted by distance)
    const eventsToShow = this.filteredEvents.slice(0, this.maxMarkersOnMap);

    if (eventsToShow.length < this.filteredEvents.length) {
      console.log(
        `Showing ${eventsToShow.length} of ${this.filteredEvents.length} events on map for performance`,
      );
    }

    // Group events by exact location string AND date for more precise grouping
    const eventsByLocationAndDate = new Map();

    eventsToShow.forEach((event) => {
      // Use location string + date for grouping to ensure only same venue events are grouped
      const locationDateKey = `${event.location}|${event.date}`;
      if (!eventsByLocationAndDate.has(locationDateKey)) {
        eventsByLocationAndDate.set(locationDateKey, []);
      }
      eventsByLocationAndDate.get(locationDateKey).push(event);
    });

    // Create markers for each unique location-date combination
    eventsByLocationAndDate.forEach((eventsAtLocationDate, locationDateKey) => {
      const [location, date] = locationDateKey.split("|");
      // Use the coordinates from the first event in the group
      const firstEvent = eventsAtLocationDate[0];
      const lat = firstEvent.lat;
      const lng = firstEvent.lng;

      if (eventsAtLocationDate.length === 1) {
        // Single event at this location on this date
        const event = eventsAtLocationDate[0];
        const marker = L.marker([lat, lng])
          .addTo(this.map)
          .bindPopup(this.createPopupContent(event));

        // Store marker reference on the event for mobile focus functionality
        event._marker = marker;
        event._originalIcon = marker.getIcon();

        marker.on("click", () => {
          this.highlightEvent(event.id);
        });

        this.markers.push(marker);
      } else {
        // Multiple events at this exact location on the same date
        // Sort events by time (earliest first)
        const sortedEvents = eventsAtLocationDate.sort((a, b) => {
          const timeA = a.startTime || a.time || "00:00";
          const timeB = b.startTime || b.time || "00:00";
          return timeA.localeCompare(timeB);
        });

        const marker = L.marker([lat, lng])
          .addTo(this.map)
          .bindPopup(this.createMultiEventPopupContent(sortedEvents, date));

        // Store marker reference on the first event for mobile focus functionality
        sortedEvents[0]._marker = marker;
        sortedEvents[0]._originalIcon = marker.getIcon();

        // When marker is clicked, highlight the first (earliest) event
        marker.on("click", () => {
          this.highlightEvent(sortedEvents[0].id);
        });

        this.markers.push(marker);
      }
    });

    // Fit map to show all markers if there are any
    if (this.markers.length > 0) {
      const group = new L.featureGroup(this.markers);
      this.map.fitBounds(group.getBounds().pad(0.1));
    }
  }

  createPopupContent(event) {
    const elapsedLabel = event.isElapsed
      ? '<span style="background: #6b7280; color: white; padding: 3px 8px; border-radius: 10px; font-size: 12px; margin-left: 8px;">Ended</span>'
      : "";
    const titleStyle = event.isElapsed
      ? "color: #6b7280; opacity: 0.8;"
      : "color: #1f2937;";

    // Generate category badges
    const categories =
      Array.isArray(event.categories) && event.categories.length > 0
        ? event.categories
        : event.category
          ? [event.category]
          : [];
    const tagBadges = categories
      .map(
        (category) =>
          `<span style="display: inline-block; padding: 5px 12px; border-radius: 12px; font-size: 13px; font-weight: 500; color: white; margin-right: 5px;" class="${this.getCategoryColorClass(
            category,
          )}">${this.formatCategoryName(category)}</span>`,
      )
      .join("");

    // Parse description to separate main text from contact details
    let descriptionHtml = "";
    let contactHtml = "";

    if (event.description) {
      // Patterns for contact details
      const contactPatterns = [
        /(?:Mob|Mobile|Phone|Tel|Call):\s*[\d\s\-+()]+/gi,
        /Email:\s*[^\s]+@[^\s]+/gi,
        /Web:\s*[^\s]+/gi,
        /FB:\s*[^\s]+/gi,
        /Facebook:\s*[^\s]+/gi,
        /Website:\s*[^\s]+/gi,
      ];

      let description = event.description;
      const contactDetails = [];

      // Extract contact details
      contactPatterns.forEach((pattern) => {
        const matches = description.match(pattern);
        if (matches) {
          matches.forEach((match) => {
            contactDetails.push(match.trim());
            description = description.replace(match, "");
          });
        }
      });

      // Clean up the description (remove extra spaces, trailing punctuation)
      description = description.replace(/\s+/g, " ").trim();
      description = description.replace(/[.,\s]+$/, "").trim();

      if (description) {
        descriptionHtml = `
          <div style="margin-top: 12px; padding-top: 12px; border-top: 1px solid #e5e7eb;">
            <p style="margin: 0; font-size: 14px; color: #374151; line-height: 1.7;">${description}</p>
          </div>`;
      }

      if (contactDetails.length > 0) {
        const contactItems = contactDetails
          .map((detail) => {
            // Add appropriate icons
            let icon = "📞";
            if (detail.toLowerCase().includes("email")) icon = "✉️";
            else if (
              detail.toLowerCase().includes("web") ||
              detail.toLowerCase().includes("http")
            )
              icon = "🌐";
            else if (
              detail.toLowerCase().includes("fb") ||
              detail.toLowerCase().includes("facebook")
            )
              icon = "📘";

            return `<div style="margin: 6px 0; font-size: 13px; color: #4b5563;">${icon} ${detail}</div>`;
          })
          .join("");

        contactHtml = `
          <div style="margin-top: 12px; padding-top: 12px; border-top: 1px solid #e5e7eb;">
            ${contactItems}
          </div>`;
      }
    }

    return `
            <div style="max-width: 360px; line-height: 1.5; padding: 6px;">
                <h4 style="margin: 0 0 12px 0; font-size: 18px; font-weight: 600; line-height: 1.4; ${titleStyle}">${
                  event.title
                }${elapsedLabel}</h4>

                <table style="border-collapse: collapse; width: 100%; margin-bottom: 10px;">
                    <tr>
                        <td style="padding: 4px 10px 4px 0; font-size: 14px; color: #6b7280; vertical-align: top; width: 24px;">📅</td>
                        <td style="padding: 4px 0; font-size: 14px; color: #374151;">${this.formatDate(event.date)}</td>
                    </tr>
                    <tr>
                        <td style="padding: 4px 10px 4px 0; font-size: 14px; color: #6b7280; vertical-align: top;">⏰</td>
                        <td style="padding: 4px 0; font-size: 14px; color: #374151;">${event.time}</td>
                    </tr>
                    <tr>
                        <td style="padding: 4px 10px 4px 0; font-size: 14px; color: #6b7280; vertical-align: top;">📍</td>
                        <td style="padding: 4px 0; font-size: 14px; color: #374151;">${event.location}</td>
                    </tr>
                </table>

                <div style="margin-bottom: 6px;">
                    ${tagBadges}
                </div>
                ${descriptionHtml}
                ${contactHtml}
            </div>
        `;
  }

  createMultiEventPopupContent(events, date) {
    const location = events[0].location; // All events share the same location
    const eventCount = events.length;

    // Events are already sorted by time in addMarkers method
    const eventsHtml = events
      .map((event, index) => {
        const elapsedLabel = event.isElapsed
          ? '<span style="background: #6b7280; color: white; padding: 2px 6px; border-radius: 8px; font-size: 11px; margin-left: 6px;">Ended</span>'
          : "";
        const titleStyle = event.isElapsed
          ? "color: #6b7280; opacity: 0.8;"
          : "color: #1f2937;";

        // Generate category badges for multi-event popup
        const categories =
          Array.isArray(event.categories) && event.categories.length > 0
            ? event.categories
            : event.category
              ? [event.category]
              : [];
        const tagBadge =
          categories.length > 0
            ? `<span style="display: inline-block; padding: 3px 8px; border-radius: 8px; font-size: 12px; font-weight: 500; color: white;" class="${this.getCategoryColorClass(categories[0])}">${this.formatCategoryName(categories[0])}</span>${categories.length > 1 ? `<span style="font-size: 12px; color: #9ca3af; margin-left: 4px;">+${categories.length - 1}</span>` : ""}`
            : "";

        return `
                <div style="padding: 10px 0; cursor: pointer; ${index !== events.length - 1 ? "border-bottom: 1px solid #e5e7eb;" : ""}"
                     onclick="eventMap.highlightEvent(${event.id}); eventMap.map.closePopup();">
                    <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 6px;">
                        <h5 style="margin: 0; font-size: 15px; ${titleStyle} font-weight: 600; line-height: 1.4; flex: 1;">${event.title}${elapsedLabel}</h5>
                    </div>
                    <div style="display: flex; align-items: center; gap: 12px;">
                        <span style="font-size: 13px; color: #4b5563;">⏰ ${event.time || "Time TBD"}</span>
                        ${tagBadge}
                    </div>
                </div>
            `;
      })
      .join("");

    return `
            <div style="max-width: 380px; padding: 6px;">
                <h4 style="margin: 0 0 8px 0; font-size: 16px; font-weight: 600; color: #1f2937;">📍 ${location}</h4>
                <p style="margin: 0 0 10px 0; font-size: 14px; color: #4b5563;">
                    📅 ${this.formatDate(date)} · <span style="color: #059669; font-weight: 600;">${eventCount} event${eventCount > 1 ? "s" : ""}</span>
                </p>
                <div style="max-height: 280px; overflow-y: auto;">
                    ${eventsHtml}
                </div>
                <p style="margin: 10px 0 0 0; font-size: 12px; color: #9ca3af; text-align: center;">
                    Tap an event to see it in the list
                </p>
            </div>
        `;
  }

  displayEvents() {
    const eventItems = document.getElementById("eventItems");

    if (this.filteredEvents.length === 0) {
      const searchQuery = document.getElementById("searchInput").value.trim();
      const isPostcodeSearch = this.isPostcode(searchQuery);
      const isPlaceSearch = this.isKnownPlace(searchQuery);
      let noResultsMessage = "No events found matching your criteria.";

      if (isPostcodeSearch) {
        noResultsMessage =
          "No events found within search radius. Try a larger area or different postcode.";
      } else if (isPlaceSearch) {
        noResultsMessage =
          "No events found within 20km of this location. Try a different place name or broader search.";
      }

      if (eventItems) {
        eventItems.innerHTML = `<div class="text-center py-5 text-gray-500">${noResultsMessage}</div>`;
      }

      // Update mobile event count
      this.updateMobileEventCount();
      return;
    }

    // Check if any events have distance info (location-based search active)
    const hasDistanceInfo = this.filteredEvents.some(
      (event) => event._searchDistance !== undefined,
    );
    const isPartialPostcodeSearch = this.filteredEvents.some(
      (event) => event._isPartialPostcode,
    );
    const isPlaceSearch = this.filteredEvents.some(
      (event) => event._isPlaceSearch,
    );

    // Add header info for location-based searches
    let searchInfoHeader = "";
    if (hasDistanceInfo) {
      const searchQuery = document.getElementById("searchInput").value.trim();
      let searchType = "postcode";

      if (isPlaceSearch) {
        searchType = "place name";
      } else if (isPartialPostcodeSearch) {
        searchType = "partial postcode area";
      }

      const maxRadius = Math.max(
        ...this.filteredEvents.map((e) => e._searchRadius || 50),
      );
      searchInfoHeader = `
                <div class="mb-4 p-3 bg-blue-50 border border-blue-200 rounded-lg">
                    <p class="text-sm text-blue-800">
                        <strong>📍 ${
                          searchType.charAt(0).toUpperCase() +
                          searchType.slice(1)
                        } Search:</strong>
                        Showing events within ${maxRadius}km of "${searchQuery}", sorted by distance
                    </p>
                </div>
            `;
    }

    if (eventItems) {
      eventItems.innerHTML =
        searchInfoHeader + this.generateGroupedEventsList();
    }

    // Update mobile event count
    this.updateMobileEventCount();
  }

  updateMobileEventCount() {
    const count = this.filteredEvents.length;

    // Update mobile event count text
    const mobileEventCount = document.getElementById("mobileEventCount");
    if (mobileEventCount) {
      if (count === 0) {
        mobileEventCount.textContent =
          "No events found - try adjusting filters";
      } else {
        mobileEventCount.textContent = `${count} event${
          count !== 1 ? "s" : ""
        } found - click markers for details`;
      }
    }

    // Update all badge counters
    const eventCounter = document.getElementById("eventCounter");
    if (eventCounter) {
      eventCounter.textContent = `${count} event${count !== 1 ? "s" : ""}`;
    }

    const mobileCounter = document.getElementById("mobileCounter");
    if (mobileCounter) {
      mobileCounter.textContent = count.toString();
    }

    const mobileEventCounter = document.getElementById("mobileEventCounter");
    if (mobileEventCounter) {
      mobileEventCounter.textContent = count.toString();
    }
  }

  displayMobileEventList() {
    const mobileEventItems = document.getElementById("mobileEventItems");
    if (!mobileEventItems) return;

    if (this.filteredEvents.length === 0) {
      mobileEventItems.innerHTML = `
                <div class="text-center py-8 text-gray-500">
                    <p class="text-lg mb-2">No events found</p>
                    <p class="text-sm">Try adjusting your search criteria or filters</p>
                </div>
            `;
      return;
    }

    mobileEventItems.innerHTML = this.generateMobileEventsList();
  }

  generateMobileEventsList() {
    // Group events by date
    const eventsByDate = new Map();

    this.filteredEvents.forEach((event) => {
      const dateKey = event.date;
      if (!eventsByDate.has(dateKey)) {
        eventsByDate.set(dateKey, []);
      }
      eventsByDate.get(dateKey).push(event);
    });

    // Sort dates chronologically
    const sortedDates = Array.from(eventsByDate.keys()).sort(
      (a, b) => new Date(a) - new Date(b),
    );

    // Generate HTML for each date group - mobile optimized
    return sortedDates
      .map((date) => {
        const eventsOnDate = eventsByDate.get(date);

        // Sort events within the date by time
        const sortedEvents = eventsOnDate.sort((a, b) => {
          const timeA = a.startTime || a.time || "00:00";
          const timeB = b.startTime || b.time || "00:00";
          return timeA.localeCompare(timeB);
        });

        const dateHeader = `
                <div class="mb-3 mt-4 first:mt-0">
                    <h4 class="text-lg font-bold text-gray-800 mb-2 pb-1 border-b border-gray-200">
                        📅 ${this.formatDate(date)}
                        <span class="text-sm font-normal text-gray-600">(${
                          eventsOnDate.length
                        })</span>
                    </h4>
                </div>
            `;

        const eventsHtml = sortedEvents
          .map((event) => {
            // Generate tag badges for all categories - smaller for mobile
            const categories =
              Array.isArray(event.categories) && event.categories.length > 0
                ? event.categories
                : event.category
                  ? [event.category]
                  : [];
            const tagBadges = categories
              .map(
                (category) =>
                  `<span class="inline-block px-2 py-1 rounded-full text-xs font-medium text-white mr-1 mb-1 ${this.getCategoryColorClass(
                    category,
                  )}">${this.formatCategoryName(category)}</span>`,
              )
              .join("");

            // Add distance information if available
            const distanceInfo =
              event._searchDistance !== undefined
                ? `<p class="text-gray-600 text-xs">📏 ${event._searchDistance.toFixed(
                    1,
                  )} km away</p>`
                : "";

            // Apply elapsed styling for mobile
            const elapsedClass = event.isElapsed
              ? "opacity-60 bg-gray-100"
              : "bg-gray-50";
            const borderClass = event.isElapsed
              ? "border-gray-400"
              : "border-blue-500";
            const elapsedLabel = event.isElapsed
              ? '<span class="text-xs bg-gray-500 text-white px-1 py-0.5 rounded mr-1">Ended</span>'
              : "";

            return `
                    <div class="${elapsedClass} rounded-lg p-3 mb-3 border-l-4 ${borderClass}"
                         onclick="eventMap.focusOnEvent('${event.id}')">
                        <div class="flex justify-between items-start mb-2">
                            <h5 class="text-sm font-semibold text-gray-800 leading-tight flex-1">${
                              event.title
                            }</h5>
                            <div class="flex items-center ml-2">
                                ${elapsedLabel}
                                <span class="text-xs text-gray-600 whitespace-nowrap">${
                                  event.timeDisplay || event.time
                                }</span>
                            </div>
                        </div>

                        <div class="space-y-1.5 mb-2">
                            <p class="text-xs text-gray-600"><strong>📍</strong> ${
                              event.location
                            }</p>
                            ${distanceInfo}
                        </div>

                        <div>${tagBadges}</div>
                    </div>
                `;
          })
          .join("");

        return dateHeader + eventsHtml;
      })
      .join("");
  }

  focusOnEvent(eventId) {
    // Close mobile modal
    const mobileEventModal = document.getElementById("mobileEventModal");
    if (mobileEventModal) {
      mobileEventModal.classList.add("hidden");
      document.body.style.overflow = "";
    }

    // Find the event and its marker
    const event = this.filteredEvents.find((e) => e.id === eventId);
    if (!event || !event._marker) return;

    // Center map on the event marker
    this.map.setView([event.lat, event.lng], 15);

    // Open the popup
    event._marker.openPopup();

    // Add a brief highlight effect
    setTimeout(() => {
      event._marker.setIcon(event._originalIcon);
    }, 2000);
  }

  generateGroupedEventsList() {
    // Group events by date
    const eventsByDate = new Map();

    this.filteredEvents.forEach((event) => {
      const dateKey = event.date;
      if (!eventsByDate.has(dateKey)) {
        eventsByDate.set(dateKey, []);
      }
      eventsByDate.get(dateKey).push(event);
    });

    // Sort dates chronologically
    const sortedDates = Array.from(eventsByDate.keys()).sort(
      (a, b) => new Date(a) - new Date(b),
    );

    // Generate HTML for each date group
    return sortedDates
      .map((date) => {
        const eventsOnDate = eventsByDate.get(date);

        // Sort events within the date by time
        const sortedEvents = eventsOnDate.sort((a, b) => {
          const timeA = a.startTime || a.time || "00:00";
          const timeB = b.startTime || b.time || "00:00";
          return timeA.localeCompare(timeB);
        });

        const dateHeader = `
                <div class="mb-4 mt-6 first:mt-0">
                    <h3 class="text-xl font-bold text-gray-800 mb-3 pb-2 border-b-2 border-blue-200">
                        📅 ${this.formatDate(date)}
                        <span class="text-sm font-normal text-gray-600 ml-2">(${
                          eventsOnDate.length
                        } event${eventsOnDate.length > 1 ? "s" : ""})</span>
                    </h3>
                </div>
            `;

        const eventsHtml = sortedEvents
          .map((event) => {
            // Generate tag badges for all categories
            const categories =
              Array.isArray(event.categories) && event.categories.length > 0
                ? event.categories
                : event.category != null
                  ? [event.category]
                  : [];
            const tagBadges = categories
              .map(
                (category) =>
                  `<span class="inline-block px-2 py-1 rounded-full text-xs font-medium text-white mr-1 mb-1 ${this.getCategoryColorClass(
                    category,
                  )}">${this.formatCategoryName(category)}</span>`,
              )
              .join("");

            // Add distance information if available (from postcode search)
            const distanceInfo =
              event._searchDistance !== undefined
                ? `<p class="text-gray-600 text-sm mb-1"><strong>📏</strong> ${event._searchDistance.toFixed(
                    1,
                  )} km away</p>`
                : "";

            // Apply elapsed styling if event has passed
            const elapsedClass = event.isElapsed
              ? "opacity-60 bg-gray-100"
              : "bg-gray-50";
            const borderClass = event.isElapsed
              ? "border-gray-400"
              : "border-blue-500";
            const hoverClass = event.isElapsed
              ? "hover:bg-gray-200"
              : "hover:bg-blue-50";
            const elapsedLabel = event.isElapsed
              ? '<span class="text-xs bg-gray-500 text-white px-2 py-1 rounded-full mr-2">Ended</span>'
              : "";

            return `
                    <div class="${elapsedClass} rounded-lg p-4 cursor-pointer transition-all duration-300 border-l-4 ${borderClass} ${hoverClass} hover:shadow-md hover:-translate-y-1 mb-5"
                         data-event-id="${event.id}" onclick="eventMap.focusEvent(${event.id})">
                        <div class="flex items-start justify-between mb-3">
                            <h4 class="text-gray-800 text-lg font-semibold flex-1 leading-snug">${event.title}</h4>
                            ${elapsedLabel}
                        </div>

                        <div class="space-y-2 mb-3">
                            <p class="text-gray-600 text-sm"><strong>⏰</strong> ${event.time}</p>
                            <p class="text-gray-600 text-sm"><strong>📍</strong> ${event.location}</p>
                            ${distanceInfo}
                        </div>

                        <div class="flex flex-wrap">${tagBadges}</div>


                    </div>
                `;
          })
          .join("");

        return dateHeader + eventsHtml;
      })
      .join("");
  }

  focusEvent(eventId) {
    const event = this.events.find((e) => e.id === eventId);
    if (event) {
      // Center map on event location
      this.map.setView([event.lat, event.lng], 10);

      // Open popup for the marker
      const marker = this.markers.find(
        (m) =>
          m.getLatLng().lat === event.lat && m.getLatLng().lng === event.lng,
      );
      if (marker) {
        marker.openPopup();
      }

      this.highlightEvent(eventId);
    }
  }

  highlightEvent(eventId) {
    // Remove highlight from all items by resetting border color
    document.querySelectorAll("[data-event-id]").forEach((item) => {
      item.classList.remove("border-red-500", "bg-red-50");
      item.classList.add("border-blue-500", "bg-gray-50");
    });

    // Add highlight to selected item
    const selectedItem = document.querySelector(`[data-event-id="${eventId}"]`);
    if (selectedItem) {
      selectedItem.classList.remove("border-blue-500", "bg-gray-50");
      selectedItem.classList.add("border-red-500", "bg-red-50");
      selectedItem.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  }

  setupEventListeners() {
    // Search functionality with debouncing
    const searchInput = document.getElementById("searchInput");
    const searchBtn = document.getElementById("searchBtn");

    const performSearch = async () => {
      // Validate and sanitise search input
      const rawQuery = searchInput.value;
      const sanitisedQuery =
        this.utils?.validateSearchInput(rawQuery) || rawQuery.trim();
      searchInput.value = sanitisedQuery; // Update input with sanitised value
      await this.filterEvents();
    };

    // Create debounced version of filter for typing
    const debouncedFilter =
      this.utils?.debounce(
        () => this.filterEvents(),
        this.utils.CONFIG.DEBOUNCE_DELAY,
      ) || (() => this.filterEvents());

    // Real-time search as user types (debounced)
    searchInput.addEventListener("input", debouncedFilter);

    // Immediate search on button click
    searchBtn.addEventListener("click", performSearch);

    // Search on Enter key
    searchInput.addEventListener("keypress", async (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        await performSearch();
      }
    });

    // Filter functionality
    const categoryFilter = document.getElementById("categoryFilter");
    const dateFilter = document.getElementById("dateFilter");
    const clearFilters = document.getElementById("clearFilters");

    categoryFilter.addEventListener(
      "change",
      async () => await this.filterEvents(),
    );
    dateFilter.addEventListener(
      "change",
      async () => await this.filterEvents(),
    );

    clearFilters.addEventListener("click", async () => {
      searchInput.value = "";
      categoryFilter.value = "";
      dateFilter.value = "";
      this.currentDateFilter = "all";
      this.currentPage = 0;
      await this.filterEvents();
    });

    // Quick date filter buttons
    const filterToday = document.getElementById("filterToday");
    const filterWeek = document.getElementById("filterWeek");
    const filterMonth = document.getElementById("filterMonth");
    const filterAll = document.getElementById("filterAll");

    if (filterToday) {
      filterToday.addEventListener("click", () => this.setDateFilter("today"));
    }
    if (filterWeek) {
      filterWeek.addEventListener("click", () => this.setDateFilter("week"));
    }
    if (filterMonth) {
      filterMonth.addEventListener("click", () => this.setDateFilter("month"));
    }
    if (filterAll) {
      filterAll.addEventListener("click", () => this.setDateFilter("all"));
    }

    // Load more functionality
    const loadMoreBtn = document.getElementById("loadMoreBtn");
    const mobileLoadMoreBtn = document.getElementById("mobileLoadMoreBtn");

    if (loadMoreBtn) {
      loadMoreBtn.addEventListener("click", () => this.loadMoreEvents());
    }
    if (mobileLoadMoreBtn) {
      mobileLoadMoreBtn.addEventListener("click", () =>
        this.loadMoreEvents(true),
      );
    }

    // Mobile list modal functionality
    const showMobileList = document.getElementById("showMobileList");
    const closeMobileList = document.getElementById("closeMobileList");
    const mobileEventModal = document.getElementById("mobileEventModal");

    if (showMobileList) {
      showMobileList.addEventListener("click", () => {
        this.displayMobileEventList();
        mobileEventModal.classList.remove("hidden");
        document.body.style.overflow = "hidden"; // Prevent background scrolling
      });
    }

    if (closeMobileList) {
      closeMobileList.addEventListener("click", () => {
        mobileEventModal.classList.add("hidden");
        document.body.style.overflow = ""; // Restore scrolling
      });
    }

    // Close modal when clicking backdrop
    if (mobileEventModal) {
      mobileEventModal.addEventListener("click", (e) => {
        if (e.target === mobileEventModal) {
          mobileEventModal.classList.add("hidden");
          document.body.style.overflow = "";
        }
      });
    }
  }

  async setDateFilter(filterType) {
    console.log(`Setting date filter to: ${filterType}`);
    this.currentDateFilter = filterType;
    this.currentPage = 0;
    this.updateDateFilterButtons();
    await this.filterEvents();
    console.log(`After filtering: ${this.filteredEvents.length} events found`);
  }

  updateDateFilterButtons() {
    const buttons = {
      today: document.getElementById("filterToday"),
      week: document.getElementById("filterWeek"),
      month: document.getElementById("filterMonth"),
      all: document.getElementById("filterAll"),
    };

    // Reset all button styles
    Object.values(buttons).forEach((btn) => {
      if (btn) {
        btn.className = btn.className.replace(
          /bg-\w+-500|text-white/,
          "bg-gray-100 text-gray-800",
        );
      }
    });

    // Highlight active button
    const activeBtn = buttons[this.currentDateFilter];
    if (activeBtn) {
      const colorMap = {
        today: "bg-green-500 text-white",
        week: "bg-blue-500 text-white",
        month: "bg-purple-500 text-white",
        all: "bg-gray-500 text-white",
      };
      activeBtn.className = activeBtn.className.replace(
        /bg-\w+-\d+\s+text-\w+-\d+/,
        colorMap[this.currentDateFilter],
      );
    }
  }

  filterEventsByDate(events) {
    if (this.currentDateFilter === "all") {
      return events; // No filtering needed
    }

    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

    console.log(
      `Filtering ${events.length} events by date filter: ${this.currentDateFilter}`,
    );

    const filtered = events.filter((event) => {
      const eventDate = new Date(event.date);

      switch (this.currentDateFilter) {
        case "today":
          return eventDate.toDateString() === today.toDateString();
        case "week":
          const weekFromNow = new Date(
            today.getTime() + 7 * 24 * 60 * 60 * 1000,
          );
          return eventDate >= today && eventDate <= weekFromNow;
        case "month":
          const monthFromNow = new Date(
            today.getFullYear(),
            today.getMonth() + 1,
            today.getDate(),
          );
          return eventDate >= today && eventDate <= monthFromNow;
        case "all":
        default:
          return true;
      }
    });

    console.log(`Date filtering result: ${filtered.length} events remain`);
    return filtered;
  }

  loadMoreEvents(isMobile = false) {
    this.currentPage++;
    this.displayEvents(isMobile, true); // true = append mode
  }

  updateEventCounters() {
    const totalFiltered = this.filteredEvents.length;
    const displayed = this.displayedEvents.length;

    // Desktop counter
    const eventCounter = document.getElementById("eventCounter");
    if (eventCounter) {
      eventCounter.textContent = `${displayed} of ${totalFiltered} events`;
    }

    // Mobile counters
    const mobileCounter = document.getElementById("mobileCounter");
    const mobileEventCounter = document.getElementById("mobileEventCounter");

    if (mobileCounter) {
      mobileCounter.textContent = totalFiltered.toString();
    }
    if (mobileEventCounter) {
      mobileEventCounter.textContent = totalFiltered.toString();
    }

    // Update mobile count text
    const mobileEventCount = document.getElementById("mobileEventCount");
    if (mobileEventCount) {
      if (totalFiltered === 0) {
        mobileEventCount.textContent =
          "No events found - try adjusting filters";
      } else {
        mobileEventCount.textContent = `${totalFiltered} event${
          totalFiltered !== 1 ? "s" : ""
        } found - click markers for details`;
      }
    }

    // Show/hide load more buttons
    const hasMore = displayed < totalFiltered;
    this.toggleLoadMoreButtons(hasMore);
  }

  toggleLoadMoreButtons(show) {
    const loadMoreContainer = document.getElementById("loadMoreContainer");
    const mobileLoadMoreContainer = document.getElementById(
      "mobileLoadMoreContainer",
    );

    if (loadMoreContainer) {
      loadMoreContainer.classList.toggle("hidden", !show);
    }
    if (mobileLoadMoreContainer) {
      mobileLoadMoreContainer.classList.toggle("hidden", !show);
    }
  }

  async filterEvents() {
    const searchQuery = document
      .getElementById("searchInput")
      .value.toLowerCase()
      .trim();
    const categoryFilterValue = document.getElementById("categoryFilter").value;
    const dateFilterValue = document.getElementById("dateFilter").value;

    console.log("Filter Debug:", {
      searchQuery,
      categoryFilter: categoryFilterValue,
      dateFilter: dateFilterValue,
      totalEvents: this.events.length,
      eventCategories: [...new Set(this.events.map((e) => e.category))],
      allEventTags: [
        ...new Set(this.events.flatMap((e) => e.categories || [e.category])),
      ],
    });

    // Check if search query is a postcode for proximity search
    let searchCoords = null;
    const isPostcodeSearch = this.isPostcode(searchQuery);
    const isPlaceSearch = !isPostcodeSearch && this.isKnownPlace(searchQuery);

    if (isPostcodeSearch && searchQuery.length > 0) {
      console.log(
        "Postcode detected, getting coordinates for proximity search...",
      );
      searchCoords = await this.geocodePostcode(searchQuery);
      if (searchCoords) {
        console.log(`Postcode ${searchQuery} coordinates:`, searchCoords);
      }
    } else if (isPlaceSearch && searchQuery.length > 0) {
      console.log(
        "Place name detected, getting coordinates for proximity search...",
      );
      searchCoords = await this.geocodePlaceName(searchQuery);
      if (searchCoords) {
        console.log(`Place ${searchQuery} coordinates:`, searchCoords);
      }
    }

    this.filteredEvents = this.events.filter((event) => {
      // Search filter
      let matchesSearch = !searchQuery;

      if (searchQuery && !matchesSearch) {
        // Standard text search
        matchesSearch =
          event.title.toLowerCase().includes(searchQuery) ||
          event.description.toLowerCase().includes(searchQuery) ||
          event.location.toLowerCase().includes(searchQuery) ||
          event.organizer.toLowerCase().includes(searchQuery);

        // If postcode or place search and we have coordinates, include events within reasonable distance
        if (
          (isPostcodeSearch || isPlaceSearch) &&
          searchCoords &&
          !matchesSearch
        ) {
          const distance = this.calculateDistance(
            searchCoords.lat,
            searchCoords.lng,
            event.lat,
            event.lng,
          );

          // Use dynamic radius based on search type
          const searchRadius = searchCoords.radius || 50;
          matchesSearch = distance <= searchRadius;

          // Store distance and search info for display
          event._searchDistance = distance;
          event._searchRadius = searchRadius;
          event._isPartialPostcode = searchCoords.isPartial;
          event._isPlaceSearch = searchCoords.isPlace;
        }
      }

      // Category filter - check both primary category and all categories
      const matchesCategory =
        !categoryFilterValue ||
        event.category === categoryFilterValue ||
        (event.categories && event.categories.includes(categoryFilterValue));

      // Date filter
      const matchesDate = !dateFilterValue || event.date === dateFilterValue;

      return matchesSearch && matchesCategory && matchesDate;
    });

    // Apply date range filtering based on quick filters
    this.filteredEvents = this.filterEventsByDate(this.filteredEvents);

    // If it was a postcode or place search, sort by distance
    if ((isPostcodeSearch || isPlaceSearch) && searchCoords) {
      this.filteredEvents.sort((a, b) => {
        const distanceA = a._searchDistance || 0;
        const distanceB = b._searchDistance || 0;
        return distanceA - distanceB;
      });

      let searchType = "postcode";
      if (isPlaceSearch) searchType = "place name";
      else if (searchCoords.isPartial) searchType = "partial postcode";

      const radius = searchCoords.radius || 50;
      console.log(
        `${searchType} search: Found ${this.filteredEvents.length} events within ${radius}km, sorted by distance`,
      );
    }

    console.log(
      `Filtered ${this.filteredEvents.length} events from ${this.events.length} total`,
    );

    // Reset pagination
    this.currentPage = 0;
    this.displayedEvents = [];

    this.displayEvents();
    this.addMarkers();
  }

  formatDate(dateString) {
    const options = { year: "numeric", month: "long", day: "numeric" };
    return new Date(dateString).toLocaleDateString("en-AU", options);
  }

  getCategoryColorClass(category) {
    const colorMap = {
      "breakfast-club": "bg-orange-500",
      "drop-in": "bg-blue-500",
      meeting: "bg-gray-700",
      workshop: "bg-yellow-500",
      social: "bg-purple-500",
      support: "bg-green-500",
      sport: "bg-red-500",
      other: "bg-gray-400",
    };
    return colorMap[category] || "bg-gray-400";
  }

  formatCategoryName(category) {
    const nameMap = {
      "breakfast-club": "Breakfast Club",
      "drop-in": "Drop-In Centre",
      meeting: "Association Meeting",
      workshop: "Workshop",
      social: "Social Event",
      support: "Support Group",
      sport: "Sport & Recreation",
      other: "Other",
    };
    return nameMap[category] || category;
  }

  // Distance calculation using Haversine formula
  calculateDistance(lat1, lng1, lat2, lng2) {
    const R = 6371; // Earth's radius in kilometers
    const dLat = this.toRadians(lat2 - lat1);
    const dLng = this.toRadians(lng2 - lng1);
    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(this.toRadians(lat1)) *
        Math.cos(this.toRadians(lat2)) *
        Math.sin(dLng / 2) *
        Math.sin(dLng / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c; // Distance in kilometers
  }

  toRadians(degrees) {
    return degrees * (Math.PI / 180);
  }

  // Check if a string looks like a UK postcode (full or partial)
  isPostcode(searchQuery) {
    // Full UK postcode patterns: SW1A 1AA, M1 1AA, B33 8TH, etc.
    const fullPostcodeRegex = /^[A-Z]{1,2}[0-9][A-Z0-9]?\s?[0-9][A-Z]{2}$/i;

    // Partial UK postcode patterns: TS28, TS 28, SW1A, M1, etc.
    const partialPostcodeRegex = /^[A-Z]{1,2}[0-9][A-Z0-9]?$/i;

    const cleanQuery = searchQuery.replace(/\s+/g, "").trim();

    return (
      fullPostcodeRegex.test(searchQuery.replace(/\s+/g, " ").trim()) ||
      partialPostcodeRegex.test(cleanQuery)
    );
  }

  // Check if a search query is a known place name
  isKnownPlace(searchQuery) {
    const knownPlaces = [
      "newcastle",
      "newcastle upon tyne",
      "sunderland",
      "middlesbrough",
      "durham",
      "gateshead",
      "hartlepool",
      "south shields",
      "north shields",
      "tynemouth",
      "whitley bay",
      "cramlington",
      "hexham",
      "consett",
      "stanley",
      "chester-le-street",
      "washington",
      "jarrow",
      "hebburn",
      "seaham",
      "ferryhill",
      "spennymoor",
      "bishop auckland",
      "peterlee",
      "blyth",
      "ashington",
    ];

    const queryLower = searchQuery.toLowerCase().trim();
    return knownPlaces.some(
      (place) =>
        place === queryLower ||
        queryLower.includes(place) ||
        place.includes(queryLower),
    );
  }

  // Geocode a place name for proximity search
  async geocodePlaceName(placeName) {
    try {
      // First try our known location coordinates
      const knownCoords = this.getKnownLocationCoordinates(placeName);
      if (knownCoords) {
        return {
          lat: knownCoords.lat,
          lng: knownCoords.lng,
          radius: 20, // 20km radius for place searches
          isPlace: true,
        };
      }

      // Fallback to online geocoding
      const cleanPlace = placeName.trim() + ", Northeast England, UK";

      // Try Google Geocoding API if available
      if (
        typeof config !== "undefined" &&
        config?.ENABLE_GEOCODING &&
        config?.GEOCODING_API_KEY &&
        config.GEOCODING_API_KEY !== "your-geocoding-api-key-here"
      ) {
        const response = await fetch(
          `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(
            cleanPlace,
          )}&key=${config.GEOCODING_API_KEY}`,
        );

        if (response.ok) {
          const data = await response.json();
          if (data.results && data.results.length > 0) {
            const location = data.results[0].geometry.location;
            return {
              lat: location.lat,
              lng: location.lng,
              radius: 20,
              isPlace: true,
            };
          }
        }
      }

      // Fallback: Use free Nominatim API (OpenStreetMap)
      const response = await fetch(
        `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(
          cleanPlace,
        )}&limit=1&countrycodes=gb`,
      );

      if (response.ok) {
        const data = await response.json();
        if (data && data.length > 0) {
          return {
            lat: parseFloat(data[0].lat),
            lng: parseFloat(data[0].lon),
            radius: 20,
            isPlace: true,
          };
        }
      }

      throw new Error("Place not found");
    } catch (error) {
      console.warn("Place name geocoding failed:", error);
      return null;
    }
  }

  // Geocode a postcode (full or partial) and return coordinates
  async geocodePostcode(postcode) {
    try {
      const cleanPostcode = postcode.replace(/\s+/g, " ").trim().toUpperCase();

      // Determine if it's a partial postcode
      const isPartial =
        !/^[A-Z]{1,2}[0-9][A-Z0-9]?\s[0-9][A-Z]{2}$/.test(cleanPostcode) &&
        !/^[A-Z]{1,2}[0-9][A-Z0-9]?[0-9][A-Z]{2}$/.test(
          cleanPostcode.replace(/\s/g, ""),
        );

      let searchQuery = cleanPostcode;
      let searchRadius = 15; // Default search radius in km

      if (isPartial) {
        // For partial postcodes, search for the area center and use larger radius
        searchQuery = cleanPostcode + ", UK";
        searchRadius = 25; // Larger radius for partial postcodes
        console.log(
          `Partial postcode detected: ${cleanPostcode}, using larger search radius`,
        );
      } else {
        searchQuery = cleanPostcode + ", UK";
        console.log(`Full postcode detected: ${cleanPostcode}`);
      }

      // Try Google Geocoding API if available
      if (
        typeof config !== "undefined" &&
        config?.ENABLE_GEOCODING &&
        config?.GEOCODING_API_KEY &&
        config.GEOCODING_API_KEY !== "your-geocoding-api-key-here"
      ) {
        const response = await fetch(
          `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(
            searchQuery,
          )}&key=${config.GEOCODING_API_KEY}`,
        );

        if (response.ok) {
          const data = await response.json();
          if (data.results && data.results.length > 0) {
            const location = data.results[0].geometry.location;
            return {
              lat: location.lat,
              lng: location.lng,
              radius: searchRadius,
              isPartial: isPartial,
            };
          }
        }
      }

      // Fallback: Use free Nominatim API (OpenStreetMap)
      const response = await fetch(
        `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(
          searchQuery,
        )}&limit=1&countrycodes=gb`,
      );

      if (response.ok) {
        const data = await response.json();
        if (data && data.length > 0) {
          return {
            lat: parseFloat(data[0].lat),
            lng: parseFloat(data[0].lon),
            radius: searchRadius,
            isPartial: isPartial,
          };
        }
      }

      throw new Error("Postcode not found");
    } catch (error) {
      console.warn("Postcode geocoding failed:", error);
      return null;
    }
  }

  populateCategoryFilter() {
    // Get all unique categories from events
    const allCategories = new Set();

    this.events.forEach((event) => {
      // Add primary category
      allCategories.add(event.category);

      // Add all secondary categories
      if (event.categories && Array.isArray(event.categories)) {
        event.categories.forEach((cat) => allCategories.add(cat));
      }
    });

    // Remove 'other' if no events are actually categorized as 'other'
    const availableCategories = Array.from(allCategories).filter(
      (cat) => cat && cat !== "other",
    );

    // Add 'other' only if there are events with 'other' category
    if (allCategories.has("other")) {
      availableCategories.push("other");
    }

    // Sort categories for consistent display
    availableCategories.sort();

    // Get the select element
    const categoryFilter = document.getElementById("categoryFilter");
    const currentValue = categoryFilter.value; // Preserve current selection

    // Clear existing options except "All Categories"
    categoryFilter.innerHTML = '<option value="">All Categories</option>';

    // Add options for categories that actually have events
    availableCategories.forEach((category) => {
      const option = document.createElement("option");
      option.value = category;

      // Count events in this category for display
      const eventCount = this.events.filter(
        (event) =>
          event.category === category ||
          (event.categories && event.categories.includes(category)),
      ).length;

      option.textContent = `${this.formatCategoryName(
        category,
      )} (${eventCount})`;

      // Restore previous selection if it still exists
      if (category === currentValue) {
        option.selected = true;
      }

      categoryFilter.appendChild(option);
    });

    console.log("Populated category filter with:", availableCategories);
  }

  // Method to add new events (for future WordPress integration)
  addEvent(eventData) {
    const newEvent = {
      id: this.events.length + 1,
      ...eventData,
    };
    this.events.push(newEvent);
    this.filterEvents(); // Refresh display
  }

  // Method to get all events (for WordPress integration)
  getEvents() {
    return this.events;
  }
}

// Initialize the event map when page loads
let eventMap;

// Handle both cases: DOMContentLoaded already fired (dynamic script load) or not yet fired
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => {
    eventMap = new EventMap();
  });
} else {
  // DOM already loaded, initialize immediately
  eventMap = new EventMap();
}

// Expose methods for WordPress integration
window.EventMapAPI = {
  addEvent: (eventData) => eventMap?.addEvent(eventData),
  getEvents: () => eventMap?.getEvents() || [],
  filterByCategory: (category) => {
    document.getElementById("categoryFilter").value = category;
    eventMap?.filterEvents();
  },
  searchEvents: (query) => {
    document.getElementById("searchInput").value = query;
    eventMap?.filterEvents();
  },
};
