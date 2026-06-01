// amplitude-init.js — consent-gated Amplitude initialisation for SMM course.
// Reads consent from window.FLConsent (set by fl-consent.js).
// Amplitude is imported dynamically ONLY after analytics consent is confirmed.
// Exposes window._amplitude after init so analytics.js can use amplitude.Identify.

let amp = null;
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

async function initAmplitude() {
  if (initialized) return;
  initialized = true;
  amp = await import("https://cdn.jsdelivr.net/npm/@amplitude/unified/+esm");
  amp.initAll("bb520ce286dcd9762c8e4360e9a3d51e", {
    serverZone: "EU",
    analytics: { autocapture: true },
    sessionReplay: { sampleRate: 0.1 },
  });
  window._amplitude = amp;
  window.dispatchEvent(new CustomEvent("FLAmplitudeReady"));
}

async function syncConsent() {
  if (window.FLConsent?.hasAnalytics()) {
    await initAmplitude();
    if (amp) amp.setOptOut(false);
  } else {
    if (initialized && amp) amp.setOptOut(true);
    clearAmplitudeStorage();
    window._amplitude = null;
  }
}

window.addEventListener("FLConsentChanged", syncConsent);
syncConsent();
