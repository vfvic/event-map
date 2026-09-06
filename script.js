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
    this.viewMode = "map";

    // WordPress / external data source URL (set by embedder or config)
    this.dataSourceUrl =
      window.VFVIC_MAP_DATA_URL ||
      (typeof window !== "undefined" && window.location &&
        new URLSearchParams(window.location.search).get("dataSource")) ||
      (typeof document !== "undefined" &&
        document.getElementById("vfvic-event-map-container")?.dataset
          ?.dataSource) ||
      (window.CALENDAR_CONFIG && window.CALENDAR_CONFIG.DATA_SOURCE_URL) ||
      "";

    // Client-side cache TTL for WordPress endpoint (milliseconds). 10 minutes.
    this._clientCacheTtlMs = 10 * 60 * 1000;
    this._clientCacheKeyPrefix = "vfvic_map_events_";

    // Utility functions
    this.utils = window.EventMapUtils;

    this.init();
  }

  setViewMode(viewMode) {
    this.viewMode = viewMode === "list" ? "list" : "map";

    const eventListPanel = document.getElementById("eventListPanel");
    const map = document.getElementById("map");
    const mapButton = document.getElementById("showMapView");
    const listButton = document.getElementById("showListView");
    const isLargeViewport = window.matchMedia("(min-width: 1024px)").matches;

    if (eventListPanel) {
      eventListPanel.classList.toggle(
        "hidden",
        !isLargeViewport && this.viewMode !== "list",
      );
    }
    if (map) {
      map.classList.toggle(
        "hidden",
        !isLargeViewport && this.viewMode !== "map",
      );
    }

    if (mapButton) {
      mapButton.setAttribute("aria-pressed", String(this.viewMode === "map"));
      mapButton.classList.toggle("bg-blue-500", this.viewMode === "map");
      mapButton.classList.toggle("text-white", this.viewMode === "map");
      mapButton.classList.toggle("bg-white", this.viewMode !== "map");
      mapButton.classList.toggle("text-gray-700", this.viewMode !== "map");
      mapButton.classList.toggle("hover:bg-blue-600", this.viewMode === "map");
      mapButton.classList.toggle("hover:bg-gray-100", this.viewMode !== "map");
    }
    if (listButton) {
      listButton.setAttribute("aria-pressed", String(this.viewMode === "list"));
      listButton.classList.toggle("bg-blue-500", this.viewMode === "list");
      listButton.classList.toggle("text-white", this.viewMode === "list");
      listButton.classList.toggle("bg-white", this.viewMode !== "list");
      listButton.classList.toggle("text-gray-700", this.viewMode !== "list");
      listButton.classList.toggle("hover:bg-blue-600", this.viewMode === "list");
      listButton.classList.toggle("hover:bg-gray-100", this.viewMode !== "list");
    }

    if (this.map && (isLargeViewport || this.viewMode === "map")) {
      setTimeout(() => {
        this.map.invalidateSize();

        const openMarker = this.markers.find((marker) => marker.isPopupOpen());
        const openPopup = openMarker?.getPopup();
        if (openPopup) {
          Object.assign(openPopup.options, this.getPopupOptions());
          openPopup.update();
        }
      }, 0);
    }
  }

  async init() {
    if (this.utils) {
      this.utils.showLoadingSpinner("Loading...");
    }

    this.setMapState("loading", "Loading map…", "Preparing events and markers");

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

    if (this.dataSourceUrl) {
      // WordPress mode: load from the configured REST endpoint
      try {
        await this.loadFromWordPressEndpoint();
      } catch (error) {
        console.warn("Could not load events from WordPress endpoint:", error);
        if (this.utils) {
          this.utils.showToast(
            "Could not load events from the server. Please try again later.",
            "error",
            6000,
          );
        }
      }
    } else {
      // Standalone mode: local Google Calendar testing or pre-geocoded local file
      try {
        if (this._isLocalGoogleTestingEnabled()) {
          await this.loadFromGoogleCalendarLocally();
        } else {
          await this.loadLocalCalendarEvents();
        }
      } catch (error) {
        console.warn("Could not load local calendar events:", error);
        if (this.utils) {
          this.utils.showToast(
            "Could not load events. Please check back later.",
            "error",
            6000,
          );
        }
      }
    }

    this.filteredEvents = [...this.events];
    this.initMap();
    this.populateCategoryFilter();
    this.displayEvents();
    this.setupEventListeners();

    if (this.utils) {
      this.utils.hideLoadingSpinner();
    }
  }

  setMapState(type = "loading", title = "Loading map…", message = "Preparing events and markers") {
    const overlay = document.getElementById("mapStateOverlay");
    const spinnerEl = document.getElementById("mapStateSpinner");
    const iconEl = document.getElementById("mapStateIcon");
    const titleEl = document.getElementById("mapStateTitle");
    const messageEl = document.getElementById("mapStateMessage");

    if (!overlay || !spinnerEl || !iconEl || !titleEl || !messageEl) {
      return;
    }

    overlay.classList.remove("hidden");
    spinnerEl.classList.toggle("hidden", type !== "loading");
    iconEl.classList.toggle("hidden", type === "loading");
    titleEl.textContent = title;
    messageEl.textContent = message;
  }

  hideMapState() {
    const overlay = document.getElementById("mapStateOverlay");
    if (overlay) {
      overlay.classList.add("hidden");
    }
  }

  /**
   * Load events from WordPress (or any external) endpoint.
   * Uses client-side TTL cache to avoid repeated requests.
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
      console.log(`[WordPress] Loaded ${this.events.length} events from client cache`);
      if (this.utils) {
        this.utils.showToast(`Loaded ${this.events.length} events (cached)`, "success");
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
      throw new Error(`Events endpoint error: ${response.status} ${response.statusText}`);
    }

    const raw = await response.json();
    const items = Array.isArray(raw) ? raw : raw.events || raw.items || [];
    if (!Array.isArray(items)) {
      throw new Error("Invalid events response: expected array or { events }");
    }

    this.events = this._normaliseWordPressEvents(items);

    // Cache raw items so loadAnnouncements can reuse them without an extra network request
    try {
      sessionStorage.setItem(
        this._clientCacheKey(url) + "_raw",
        JSON.stringify({ data: items, fetchedAt: Date.now() }),
      );
    } catch (e) {
      // Ignore storage errors
    }

    this._setClientCachedEvents(url, this.events);

    if (this.utils) {
      this.utils.showToast(`Loaded ${this.events.length} events from server`, "success");
    }
  }

  /**
   * Normalise payload from WordPress endpoint to internal event shape.
   */
  _normaliseWordPressEvents(items) {
    return items
      .map((item, index) => {
        if (this.isAnnouncementItem(item)) {
          return null;
        }
        const lat = parseFloat(item.lat);
        const lng = parseFloat(item.lng);
        if (Number.isNaN(lat) || Number.isNaN(lng)) {
          console.warn(`[WordPress] Skipping event "${item.title || "?"}" - invalid lat/lng`);
          return null;
        }
        const titleText = this.sanitiseText(item.title || "Unnamed Event");
        const descText = this.sanitiseHtml(item.description || "No description available");
        const hasCategory = item.category && String(item.category).trim().toLowerCase() !== "other";
        const catData = hasCategory
          ? { primary: String(item.category).trim(), tags: Array.isArray(item.categories) ? item.categories.map((c) => String(c).trim()) : [String(item.category).trim()] }
          : this.categorizeEvent(titleText, descText);
        const date =
          item.date || (item.start && (item.start.date || item.start.dateTime))
            ? this._normaliseDate(item.date || item.start?.date || item.start?.dateTime)
            : "";
        const time =
          item.time || (item.start && item.start.dateTime)
            ? this._normaliseTime(item.start.dateTime)
            : "";
        return {
          id: item.id != null ? item.id : index + 1,
          title: titleText,
          description: descText,
          category: catData.primary,
          categories: catData.tags.length > 0 ? catData.tags : [catData.primary],
          date,
          time,
          timeDisplay: item.timeDisplay || item.time || time,
          startTime: item.startTime || (item.start && item.start.dateTime) || "",
          endTime: item.endTime || (item.end && item.end.dateTime) || "",
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
    return d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false });
  }

  _clientCacheKey(url) {
    let hash = 0;
    for (let i = 0; i < url.length; i++) {
      const c = url.charCodeAt(i);
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
      if (!Array.isArray(data) || typeof fetchedAt !== "number" || Date.now() - fetchedAt > this._clientCacheTtlMs) {
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
      sessionStorage.setItem(key, JSON.stringify({ data: events, fetchedAt: Date.now() }));
    } catch (e) {
      // Ignore storage errors
    }
  }

  // ---------------------------------------------------------------------------
  // Local Google Calendar testing helpers
  // These are ONLY active on localhost when CALENDAR_CONFIG.USE_GOOGLE_LOCALLY = true.
  // They are never called in production. The API key stays in the gitignored config.js.
  // ---------------------------------------------------------------------------

  /**
   * Returns true only when running on localhost/127.0.0.1 with the local
   * Google testing flag enabled in config.js.
   */
  _isLocalGoogleTestingEnabled() {
    const cfg = window.CALENDAR_CONFIG;
    if (!cfg || !cfg.USE_GOOGLE_LOCALLY) return false;
    if (!cfg.GOOGLE_API_KEY || !cfg.CALENDAR_ID) return false;
    const host = window.location?.hostname;
    return host === "localhost" || host === "127.0.0.1";
  }

  /**
   * Builds the Google Calendar API v3 URL for fetching upcoming events.
   * Only called from local testing code paths.
   */
  _localGoogleCalendarUrl() {
    const cfg = window.CALENDAR_CONFIG;
    const calId = encodeURIComponent(cfg.CALENDAR_ID);
    const now = encodeURIComponent(new Date().toISOString());
    return (
      `https://www.googleapis.com/calendar/v3/calendars/${calId}/events` +
      `?key=${cfg.GOOGLE_API_KEY}&timeMin=${now}&maxResults=250&singleEvents=true&orderBy=startTime`
    );
  }

  /**
   * Fetches raw items from Google Calendar, caching the result in sessionStorage
   * so both loadAnnouncements() and loadFromGoogleCalendarLocally() share one request.
   */
  async _fetchLocalGoogleCalendarItems() {
    const cacheKey = "vfvic_local_google_raw";
    try {
      const c = sessionStorage.getItem(cacheKey);
      if (c) {
        const { data, fetchedAt } = JSON.parse(c);
        if (Array.isArray(data) && Date.now() - fetchedAt <= this._clientCacheTtlMs) {
          console.log("[Local Google] Using cached Google Calendar items");
          return data;
        }
      }
    } catch (e) { /* storage unavailable */ }

    const url = this._localGoogleCalendarUrl();
    console.log("[Local Google] Fetching from Google Calendar API…");
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Google Calendar API error: ${response.status} ${response.statusText}`);
    }
    const data = await response.json();
    const items = data.items || [];
    try {
      sessionStorage.setItem(cacheKey, JSON.stringify({ data: items, fetchedAt: Date.now() }));
    } catch (e) { /* ignore */ }
    return items;
  }

  /**
   * Local-testing entry point: loads events from Google Calendar directly.
   * Events without pre-geocoded lat/lng will appear in the event list but not on the map.
   * Use INCLUDE_EVENTS_LOCALLY: false in config.js to show announcements only.
   */
  async loadFromGoogleCalendarLocally() {
    const items = await this._fetchLocalGoogleCalendarItems();
    const cfg = window.CALENDAR_CONFIG;
    if (cfg && cfg.INCLUDE_EVENTS_LOCALLY === false) {
      console.log("[Local Google] INCLUDE_EVENTS_LOCALLY=false — skipping event markers");
      this.events = [];
      return;
    }
    this.events = await this.processCalendarItems(items);
    const totalNonAnnouncements = items.filter((i) => !this.isAnnouncementItem(i)).length;
    const skipped = totalNonAnnouncements - this.events.length;
    if (skipped > 0) {
      console.log(
        `[Local Google] ${skipped} event(s) skipped — no pre-geocoded lat/lng. ` +
        `Run fetch-events.js to generate a google-calendar-events file with coordinates.`,
      );
    }
    if (this.utils) {
      this.utils.showToast(`[Local] Loaded ${this.events.length} events from Google Calendar`, "info");
    }
  }

  /**
   * Load events from the pre-geocoded local calendar file (standalone/GitHub Pages mode).
   */
  async loadLocalCalendarEvents() {
    const response = await fetch("./google-calendar-events");
    if (!response.ok) {
      throw new Error(`HTTP error fetching calendar file: ${response.status}`);
    }
    const text = await response.text();
    const jsonText = text.trim().startsWith('"items"') ? `{${text}}` : text;
    const data = JSON.parse(jsonText);
    if (!data.items || data.items.length === 0) {
      throw new Error("No events found in calendar file");
    }
    this.events = await this.processCalendarItems(data.items);
    if (this.utils) {
      this.utils.showToast(`Loaded ${this.events.length} events`, "success");
    }
  }

  /**
   * Process raw calendar items into the internal event shape.
   * Reads pre-baked lat/lng — no geocoding.
   */
  async processCalendarItems(items) {
    const processedEvents = [];
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      try {
        if (this.isAnnouncementItem(item)) continue;
        const eventDate = new Date(item.start?.dateTime || item.start?.date);
        const eventDateOnly = new Date(eventDate);
        eventDateOnly.setHours(0, 0, 0, 0);
        if (eventDateOnly < today) continue;
        const event = this.transformCalendarItem(item, processedEvents.length + 1);
        if (!event.lat || !event.lng) {
          console.warn(`Skipping "${event.title}" - no coordinates`);
          continue;
        }
        processedEvents.push(event);
      } catch (error) {
        console.warn(`Error processing event "${item.summary}":`, error);
      }
    }
    processedEvents.sort((a, b) => new Date(a.date) - new Date(b.date));
    return processedEvents;
  }

  /**
   * Transform a single raw calendar item to the internal event shape.
   * Reads lat/lng directly from the pre-geocoded field — synchronous.
   */
  transformCalendarItem(item, id) {
    const title = this.sanitiseText(item.summary || "Unnamed Event");
    const description = this.sanitiseHtml(item.description || "No description available");
    const location = this.sanitiseText(item.location || "Location TBD");
    // Use pre-baked category if present, otherwise derive from title + description
    const hasCategory = item.category && item.category !== "other";
    const catData = hasCategory
      ? { primary: item.category, tags: Array.isArray(item.categories) ? item.categories : [item.category] }
      : this.categorizeEvent(title, description);
    return {
      id,
      title,
      description,
      category: catData.primary,
      categories: catData.tags.length > 0 ? catData.tags : [catData.primary],
      date: this._normaliseDate(item.start?.dateTime || item.start?.date || ""),
      time: item.time || (item.start?.dateTime ? this._normaliseTime(item.start.dateTime) : ""),
      timeDisplay: item.timeDisplay || item.time || "",
      startTime: item.startTime || (item.start?.dateTime ? this._normaliseTime(item.start.dateTime) : ""),
      endTime: item.endTime || (item.end?.dateTime ? this._normaliseTime(item.end.dateTime) : ""),
      location,
      lat: parseFloat(item.lat) || 0,
      lng: parseFloat(item.lng) || 0,
      organizer: this.sanitiseText(item.organizer || "VFVIC"),
    };
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
        // Standalone mode: local Google Calendar testing or pre-geocoded local file
        if (this._isLocalGoogleTestingEnabled()) {
          try {
            items = await this._fetchLocalGoogleCalendarItems();
          } catch (e) {
            console.warn("[Announcements] Could not fetch from Google Calendar locally:", e);
          }
        } else {
          try {
            const response = await fetch("./google-calendar-events");
            if (response.ok) {
              const text = await response.text();
              const jsonText = text.trim().startsWith('"items"') ? `{${text}}` : text;
              const data = JSON.parse(jsonText);
              items = Array.isArray(data) ? data : data.items || data.events || [];
            }
          } catch (e) {
            // Local file not available, will fall back to sample announcements
          }
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
   * Starts collapsed on every page load; users can expand via toggle.
   */
  displayAnnouncements() {
    if (this.announcements.length === 0) return;

    // Check if already rendered
    if (document.getElementById("vfvic-announcements-banner")) return;

    // Always start collapsed on page load.
    const isCollapsed = true;

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
      <div id="vfvic-announcements-content" class="${isCollapsed ? "hidden " : ""}mt-4 grid gap-3 md:grid-cols-2 max-h-[55vh] overflow-y-auto md:max-h-none md:overflow-visible"></div>
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
        if (!isNowCollapsed) {
          // Defensive reset in case another UI path left body scrolling locked.
          document.body.style.overflow = "";
        }
        // Intentionally do not persist expanded/collapsed preference.
        // Announcements should be collapsed by default on every page load.
      });
    }
  }

  categorizeEvent(title, description) {
    const titleLower = (title || "").toLowerCase();
    const descLower = (description || "").toLowerCase();
    const combined = titleLower + " " + descLower;
    const tags = [];

    if (
      descLower.includes("drop in") ||
      descLower.includes("drop-in") ||
      combined.includes("drop in") ||
      combined.includes("drop-in")
    ) { tags.push("drop-in"); }

    if (
      combined.includes("support") || combined.includes("counselling") ||
      combined.includes("therapy") || combined.includes("help") ||
      combined.includes("advice") || combined.includes("welfare")
    ) { tags.push("support"); }

    if (
      combined.includes("breakfast club") ||
      (combined.includes("breakfast") && !combined.includes("clay pigeon")) ||
      (combined.includes("naafi break") && !descLower.includes("drop in"))
    ) { tags.push("breakfast-club"); }

    if (
      combined.includes("meeting") || combined.includes("branch meeting") ||
      combined.includes("association") || combined.includes("rbl") ||
      combined.includes("royal british legion") || combined.includes("dli")
    ) { tags.push("meeting"); }

    if (
      combined.includes("workshop") || combined.includes("training") ||
      combined.includes("course") || combined.includes("seminar")
    ) { tags.push("workshop"); }

    if (
      combined.includes("social") || combined.includes("mixer") ||
      combined.includes("party") || combined.includes("celebration")
    ) { tags.push("social"); }

    if (
      combined.includes("clay pigeon") || combined.includes("shooting") ||
      titleLower.includes("sport") || combined.includes("football") ||
      combined.includes("rugby") || combined.includes("sailing") ||
      combined.includes("fishing") || combined.includes("golf") ||
      combined.includes("cycling") || combined.includes("walking") ||
      combined.includes("hiking") || combined.includes("swimming") ||
      combined.includes("offshore sailing")
    ) { tags.push("sport"); }

    return { tags, primary: tags.length > 0 ? tags[0] : "other" };
  }

  sanitiseText(text) {
    if (this.utils && this.utils.sanitiseText) {
      return this.utils.sanitiseText(text);
    }
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
    if (this.utils && this.utils.sanitiseHtml) {
      return this.utils.sanitiseHtml(html);
    }
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

  initMap() {
    this.setMapState("loading", "Loading map…", "Preparing events and markers");

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
      this.setViewMode(this.viewMode);
      this.map.invalidateSize();
    });

    this.map.on("popupopen", () => {
      this.enhancePopupAccessibility();
    });

    this.addMarkers();
  }

  enhancePopupAccessibility() {
    requestAnimationFrame(() => {
      document.querySelectorAll(".leaflet-popup-close-button").forEach((button) => {
        button.classList.add("touch-target");
      });
    });
  }

  createGroupedMarkerIcon(eventCount) {
    return L.divIcon({
      html: `
        <div class="vfvic-grouped-marker" aria-label="${eventCount} events at this location">
          <span class="vfvic-grouped-marker__count">${eventCount}</span>
        </div>
      `,
      className: "vfvic-grouped-marker-wrapper",
      iconSize: [32, 32],
      iconAnchor: [16, 16],
      popupAnchor: [0, -16],
    });
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
          .bindPopup(this.createPopupContent(event), this.getPopupOptions());

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

        const marker = L.marker([lat, lng], {
          icon: this.createGroupedMarkerIcon(sortedEvents.length),
        })
          .addTo(this.map)
          .bindPopup(
            this.createMultiEventPopupContent(sortedEvents, date),
            this.getPopupOptions(),
          );

        // Store marker reference on every event in the group so mobile list items can focus the shared marker
        sortedEvents.forEach((event) => {
          event._marker = marker;
          event._originalIcon = marker.getIcon();
        });

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

    this.hideMapState();
  }

  getPopupOptions() {
    const mapContainer = this.map?.getContainer?.();
    const containerWidth = mapContainer?.clientWidth || window.innerWidth || 360;
    const popupWidth = Math.max(200, containerWidth - 40);
    const isMobileViewport = window.matchMedia("(max-width: 768px)").matches;
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 600;
    const popupHeight = Math.min(Math.max(220, Math.floor(viewportHeight * 0.72)), 480);
    const viewportPadding = isMobileViewport ? 20 : 16;

    return {
      maxWidth: Math.min(340, popupWidth),
      minWidth: 0,
      maxHeight: isMobileViewport ? popupHeight : undefined,
      autoPan: isMobileViewport,
      keepInView: isMobileViewport,
      autoPanPaddingTopLeft: L.point(viewportPadding, viewportPadding),
      autoPanPaddingBottomRight: L.point(viewportPadding, viewportPadding + 12),
    };
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
            <div class="vfvic-event-popup" style="max-width: 360px; line-height: 1.5; padding: 6px;">
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
                     onclick="eventMap.highlightEvent('${event.id}'); eventMap.map.closePopup();">
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
      this.setMapState(
        "empty",
        "No events found",
        "Try adjusting your search or filters to see more events on the map.",
      );

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

    this.hideMapState();

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
                         data-event-id="${event.id}" onclick="eventMap.focusEvent('${event.id}')">
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
    // eslint-disable-next-line eqeqeq
    const event = this.filteredEvents.find((e) => e.id == eventId);
    if (!event) return;

    // Close mobile modal if open
    const mobileEventModal = document.getElementById("mobileEventModal");
    if (mobileEventModal) {
      mobileEventModal.classList.add("hidden");
      document.body.style.overflow = "";
    }

    this.map.setView([event.lat, event.lng], 15);

    if (event._marker) {
      event._marker.openPopup();
    }

    this.highlightEvent(eventId);
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

    const showMapView = document.getElementById("showMapView");
    const showListView = document.getElementById("showListView");

    if (showMapView) {
      showMapView.addEventListener("click", () => this.setViewMode("map"));
    }
    if (showListView) {
      showListView.addEventListener("click", () => this.setViewMode("list"));
    }

    this.setViewMode(this.viewMode);
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
    // Each button gets its full class list reassigned deterministically
    // (rather than patched via regex) so toggling filters back and forth
    // never leaves stray classes (e.g. a lingering "text-white") behind.
    const baseClasses =
      "touch-target px-3 py-2 rounded-md text-sm transition-colors";

    const buttonStyles = {
      today: {
        el: document.getElementById("filterToday"),
        inactive: "bg-green-100 text-gray-800 hover:bg-green-200",
        active: "bg-green-600 text-white hover:bg-green-700",
      },
      week: {
        el: document.getElementById("filterWeek"),
        inactive: "bg-blue-100 text-gray-800 hover:bg-blue-200",
        active: "bg-blue-600 text-white hover:bg-blue-700",
      },
      month: {
        el: document.getElementById("filterMonth"),
        inactive: "bg-purple-100 text-purple-800 hover:bg-purple-200",
        active: "bg-purple-600 text-white hover:bg-purple-700",
      },
      all: {
        el: document.getElementById("filterAll"),
        inactive: "bg-gray-100 text-gray-800 hover:bg-gray-200",
        active: "bg-gray-600 text-white hover:bg-gray-700",
      },
    };

    Object.entries(buttonStyles).forEach(([key, { el, inactive, active }]) => {
      if (!el) return;
      const isActive = key === this.currentDateFilter;
      el.className = `${baseClasses} ${isActive ? active : inactive}`;
    });
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

    // Keep the category dropdown counts in sync with the active filters
    this.populateCategoryFilter();

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
    if (!queryLower) return false;

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
      const cleanPlace = placeName.trim() + ", Northeast England, UK";

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

  // Events matching the currently active search/date filters, ignoring the
  // category filter itself - used to keep the category dropdown counts in
  // sync with "Today"/"This Week"/"This Month"/specific-date selections.
  getEventsForCategoryCounts() {
    const searchQuery = (document.getElementById("searchInput")?.value || "")
      .toLowerCase()
      .trim();
    const dateFilterValue = document.getElementById("dateFilter")?.value || "";

    const searchAndDateFiltered = this.events.filter((event) => {
      const matchesSearch =
        !searchQuery ||
        event.title.toLowerCase().includes(searchQuery) ||
        event.description.toLowerCase().includes(searchQuery) ||
        event.location.toLowerCase().includes(searchQuery) ||
        event.organizer.toLowerCase().includes(searchQuery);

      const matchesDate = !dateFilterValue || event.date === dateFilterValue;

      return matchesSearch && matchesDate;
    });

    return this.filterEventsByDate(searchAndDateFiltered);
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

    // Count against events matching the active search/date filters so the
    // counts stay accurate when a quick date filter (Today/This Week/etc.)
    // or the date picker is combined with a category selection.
    const eventsForCounts = this.getEventsForCategoryCounts();

    // Add options for categories that actually have events
    availableCategories.forEach((category) => {
      const option = document.createElement("option");
      option.value = category;

      // Count events in this category for display
      const eventCount = eventsForCounts.filter(
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
