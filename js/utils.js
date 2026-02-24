// =============================================================================
// UTILITY FUNCTIONS
// =============================================================================

/**
 * Debounce function to limit how often a function can fire
 * @param {Function} func - Function to debounce
 * @param {number} wait - Wait time in milliseconds
 * @returns {Function} Debounced function
 */
function debounce(func, wait) {
  let timeout;
  return function executedFunction(...args) {
    const later = () => {
      clearTimeout(timeout);
      func(...args);
    };
    clearTimeout(timeout);
    timeout = setTimeout(later, wait);
  };
}

/**
 * Show a toast notification to the user
 * @param {string} message - Message to display
 * @param {string} type - Type of notification: 'success', 'error', 'info', 'warning'
 * @param {number} duration - How long to show (ms)
 */
function showToast(message, type = "info", duration = 3000) {
  // Remove existing toasts
  const existingToast = document.getElementById("toast-notification");
  if (existingToast) {
    existingToast.remove();
  }

  const colors = {
    success: "bg-green-500",
    error: "bg-red-500",
    info: "bg-blue-500",
    warning: "bg-yellow-500",
  };

  const toast = document.createElement("div");
  toast.id = "toast-notification";
  toast.className = `fixed top-4 right-4 ${colors[type]} text-white px-6 py-3 rounded-lg shadow-lg z-[10001] transition-opacity duration-300`;
  toast.textContent = message;

  document.body.appendChild(toast);

  // Fade out and remove
  setTimeout(() => {
    toast.style.opacity = "0";
    setTimeout(() => toast.remove(), 300);
  }, duration);
}

/**
 * Show loading spinner overlay
 */
function showLoadingSpinner(message = "Loading...") {
  let spinner = document.getElementById("loading-spinner");
  if (!spinner) {
    spinner = document.createElement("div");
    spinner.id = "loading-spinner";
    spinner.className =
      "fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-[10002]";
    spinner.innerHTML = `
            <div class="bg-white rounded-lg p-6 flex flex-col items-center shadow-xl">
                <div class="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-500 mb-4"></div>
                <p class="text-gray-700 font-medium">${message}</p>
            </div>
        `;
    document.body.appendChild(spinner);
  }
}

/**
 * Hide loading spinner
 */
function hideLoadingSpinner() {
  const spinner = document.getElementById("loading-spinner");
  if (spinner) {
    spinner.remove();
  }
}

/**
 * Enhanced text sanitisation to prevent XSS
 * @param {string} text - Text to sanitise
 * @returns {string} Sanitised text
 */
function sanitiseText(text) {
  if (!text) return "";

  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

/**
 * Enhanced HTML sanitisation
 * @param {string} html - HTML to sanitise
 * @returns {string} Sanitised HTML
 */
function sanitiseHtml(html) {
  if (!html) return "";

  return html
    .replace(/<script[^>]*>.*?<\/script>/gi, "") // Remove scripts
    .replace(/<iframe[^>]*>.*?<\/iframe>/gi, "") // Remove iframes
    .replace(/<object[^>]*>.*?<\/object>/gi, "") // Remove objects
    .replace(/<embed[^>]*>/gi, "") // Remove embeds
    .replace(/on\w+\s*=\s*["'][^"']*["']/gi, "") // Remove event handlers
    .replace(/<p[^>]*>/g, "")
    .replace(/<\/p>/g, "\n")
    .replace(/<br[^>]*>/g, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\u003c/g, "<")
    .replace(/\u003e/g, ">")
    .replace(/\u0080\u008b/g, "")
    .replace(/\n+/g, " ")
    .trim();
}

/**
 * Validate and sanitise search input
 * @param {string} input - User input
 * @returns {string} Validated input
 */
function validateSearchInput(input) {
  if (!input || typeof input !== "string") return "";

  // Limit length to prevent abuse
  const maxLength = 100;
  let sanitised = input.trim().substring(0, maxLength);

  // Remove potentially dangerous characters
  sanitised = sanitised.replace(/[<>\"']/g, "");

  return sanitised;
}

// =============================================================================
// CONSTANTS
// =============================================================================

const CONFIG = {
  EVENTS_PER_PAGE: 20,
  MAX_MARKERS_ON_MAP: 100,
  DEBOUNCE_DELAY: 300,
  TOAST_DURATION: 3000,
  API_RETRY_ATTEMPTS: 2,
  API_RETRY_DELAY: 1000,
};

// Export utilities for use in main script
window.EventMapUtils = {
  debounce,
  showToast,
  showLoadingSpinner,
  hideLoadingSpinner,
  sanitiseText,
  sanitiseHtml,
  validateSearchInput,
  CONFIG,
};
