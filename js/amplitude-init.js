import * as amplitude from "https://cdn.jsdelivr.net/npm/@amplitude/unified/+esm";

let initialized = false;

function initAmplitude() {
  if (initialized) return;
  initialized = true;
  amplitude.initAll("bb520ce286dcd9762c8e4360e9a3d51e", {
    serverZone: "EU",
    analytics: { autocapture: true },
    sessionReplay: { sampleRate: 0.1 },
  });
}

window.addEventListener("CookiebotOnAccept", () => {
  if (!window.Cookiebot?.consent?.statistics) return;
  if (!initialized) {
    initAmplitude();
  } else {
    amplitude.setOptOut(false);
  }
});

window.addEventListener("CookiebotOnDecline", () => {
  if (initialized) amplitude.setOptOut(true);
});

// Return visit: consent already stored from a previous session
if (window.Cookiebot?.consent?.statistics) {
  initAmplitude();
}

// Expose for analytics.js (loaded as a separate non-module script)
window._amplitude = amplitude;
