if (typeof document !== 'undefined') {
    document.addEventListener('DOMContentLoaded', () => {
        // Paste the rest of your original JavaScript code here, 
        // which was intended to run inside the DOMContentLoaded listener.
    });
} else {
    // Optionally handle console output or logging if the script is accidentally run in a non-browser environment (like Node.js)
    console.warn("Execution context is not a browser environment. Document object is undefined.");
}