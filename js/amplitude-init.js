import * as amplitude from "https://cdn.jsdelivr.net/npm/@amplitude/unified/+esm";

let initialized = false;

function clearAmplitudeStorage() {
  try {
    const pat = /^(AMP_|amplitude_)/i;
    Object.keys(localStorage)
      .filter((k) => pat.test(k))
      .forEach((k) => localStorage.removeItem(k));
    Object.keys(sessionStorage)
      .filter((k) => pat.test(k))
      .forEach((k) => sessionStorage.removeItem(k));
  } catch {
    // storage access denied — ignore
  }
}

function initAmplitude() {
  if (initialized) return;
  initialized = true;
  amplitude.initAll("bb520ce286dcd9762c8e4360e9a3d51e", {
    serverZone: "EU",
    analytics: { autocapture: true },
    sessionReplay: { sampleRate: 0.1 },
  });
  // Expose for analytics.js (loaded as a separate non-module script)
  window._amplitude = amplitude;
}

function syncConsent() {
  if (window.FLConsent?.hasAnalytics()) {
    initAmplitude();
    amplitude.setOptOut(false);
  } else {
    if (initialized) amplitude.setOptOut(true);
    clearAmplitudeStorage();
    window._amplitude = null;
  }
}

window.addEventListener("FLConsentChanged", syncConsent);

// Return visit: fl-consent.js already ran, check current state.
syncConsent();
