// SMM analytics — waits for amplitude-init.js to expose window._amplitude
// All calls are no-ops if amplitude hasn't loaded (graceful degradation).

(function () {
  "use strict";

  function track(event, props) {
    const amp = window._amplitude;
    if (!amp) return;
    amp.track(event, { domain: window.location.hostname, ...props });
  }

  function setOnce(key, value) {
    const amp = window._amplitude;
    if (!amp) return;
    const id = new amp.Identify();
    id.setOnce(key, value);
    amp.identify(id);
  }

  function setProp(key, value) {
    const amp = window._amplitude;
    if (!amp) return;
    const id = new amp.Identify();
    id.set(key, value);
    amp.identify(id);
  }

  const path = () => window.location.pathname;

  function contentArea() {
    const p = path();
    if (p.includes("bridge")) return "bridge";
    if (p.includes("theory")) return "theory";
    if (p.includes("method")) return "method";
    if (p.includes("fieldwork")) return "fieldwork";
    return "home";
  }

  // ── User properties on load ──────────────────────────────────────────────────

  function initUserProperties() {
    const amp = window._amplitude;
    if (!amp) return;

    const p = path();
    const ref = document.referrer;
    let refType = "direct";
    if (ref) {
      if (/google\.|bing\.|duckduckgo\./i.test(ref)) refType = "search";
      else if (/linkedin\.com/i.test(ref)) refType = "linkedin";
      else refType = "referral";
    }

    const area = p.includes("bridge")
      ? "bridge"
      : p.includes("theory")
        ? "theory"
        : p.includes("method")
          ? "method"
          : p.includes("fieldwork")
            ? "fieldwork"
            : "home";

    const id = new amp.Identify();
    id.setOnce("First Landing Section", area);
    id.setOnce("First Referrer Type", refType);
    id.setOnce("Cookie Consent Status", "Unknown");
    amp.identify(id);
  }

  // ── Content Engaged (time-based threshold) ───────────────────────────────────

  function attachContentEngagement() {
    const THRESHOLD = 45; // seconds
    const start = Date.now();
    let fired = false;

    const check = () => {
      if (fired) return;
      const elapsed = Math.round((Date.now() - start) / 1000);
      if (elapsed >= THRESHOLD) {
        fired = true;
        track("Content Engaged", {
          content_area: contentArea(),
          page_path: path(),
          engagement_seconds: String(elapsed),
          engagement_threshold_seconds: String(THRESHOLD),
        });
      }
    };

    const interval = setInterval(check, 5000);
    window.addEventListener("beforeunload", () => clearInterval(interval));
  }

  // ── Reference Opened (external citation links) ───────────────────────────────

  function attachReferenceTracking() {
    document.querySelectorAll("a[href]").forEach((link) => {
      const href = link.getAttribute("href") || "";
      if (!href.startsWith("http") && !href.startsWith("//")) return;
      // Skip internal SMM domain links
      if (/smm\.fredericlabadie\.com/i.test(href)) return;

      link.addEventListener("click", () => {
        let domain = "";
        try {
          domain = new URL(href).hostname;
        } catch {
          return;
        }
        track("Reference Opened", {
          content_area: contentArea(),
          page_path: path(),
          reference_url: href,
          reference_domain: domain,
          reference_label: link.textContent?.trim() || "",
        });
      });
    });
  }

  // ── Visitor Intent from page ──────────────────────────────────────────────────

  function inferIntent() {
    const amp = window._amplitude;
    if (!amp) return;
    const area = contentArea();
    let intent = "content";
    if (area === "home") intent = "exploration";
    const id = new amp.Identify();
    id.setOnce("Visitor Intent", intent);
    amp.identify(id);
  }

  // ── First Content Area ────────────────────────────────────────────────────────

  function recordFirstContentArea() {
    const area = contentArea();
    if (area !== "home") setOnce("First Content Area", area);
  }

  // ── Expose hooks for smm-rewriter.js ─────────────────────────────────────────
  // smm-rewriter.js calls window._smmTrack(event, props) at key moments.

  window._smmTrack = track;
  window._smmSetProp = setProp;
  window._smmSetOnce = setOnce;

  // ── Init ─────────────────────────────────────────────────────────────────────

  function init() {
    // Wait a tick for amplitude-init.js module to finish binding window._amplitude
    setTimeout(() => {
      initUserProperties();
      inferIntent();
      recordFirstContentArea();
      attachContentEngagement();
      attachReferenceTracking();
    }, 0);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
