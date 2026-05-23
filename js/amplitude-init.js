import * as amplitude from "https://cdn.jsdelivr.net/npm/@amplitude/unified/+esm";

amplitude.initAll("bb520ce286dcd9762c8e4360e9a3d51e", {
  serverZone: "EU",
  analytics: { autocapture: true },
  sessionReplay: { sampleRate: 1 },
});

// Expose amplitude for analytics.js (loaded as separate module)
window._amplitude = amplitude;
