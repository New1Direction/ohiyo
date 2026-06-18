// Ohiyo landing — progressive enhancement only. The page reads fine with JS off.
(() => {
  "use strict";

  // Sticky-nav border appears once you've scrolled past the hero lip.
  const nav = document.getElementById("nav");
  const onScroll = () => nav.classList.toggle("scrolled", window.scrollY > 12);
  onScroll();
  window.addEventListener("scroll", onScroll, { passive: true });

  // Download buttons should feel like a normal app site, not a GitHub scavenger hunt.
  // Defaults in HTML work without JS; this upgrades them to the latest release assets
  // and points the hero button at the best installer for this device.
  const latestReleaseApi = "https://api.github.com/repos/New1Direction/ohiyo/releases/latest";
  const downloadCards = [...document.querySelectorAll("[data-download-os]")];
  const primaryDownloads = [...document.querySelectorAll(".download-primary")];
  const platform = navigator.platform.toLowerCase();
  const ua = navigator.userAgent.toLowerCase();
  const preferredOs = platform.includes("linux") ? "linux" : platform.includes("mac") ? "mac-arm" : "web";

  const applyPrimaryDownload = () => {
    const card = document.querySelector(`[data-download-os="${preferredOs}"]`) || document.querySelector(".download-card.web");
    if (!card) return;
    primaryDownloads.forEach((btn) => {
      // Mac browsers do not reliably expose Intel vs Apple Silicon, so send Mac
      // visitors to the simple chooser instead of risking the wrong installer.
      if (platform.includes("mac")) {
        btn.href = "#download";
        btn.textContent = "Choose Mac download";
        btn.removeAttribute("download");
      } else if (card.matches(".web")) {
        btn.href = card.href;
        btn.textContent = "Open in your browser →";
        btn.removeAttribute("download");
      } else {
        btn.href = card.href;
        btn.textContent = card.querySelector("b")?.textContent?.replace(" — ", " ") || "Download the app";
        btn.setAttribute("download", "");
      }
    });
    card.classList.add("recommended");
  };
  applyPrimaryDownload();

  fetch(latestReleaseApi, { headers: { Accept: "application/vnd.github+json" } })
    .then((res) => (res.ok ? res.json() : null))
    .then((release) => {
      if (!release?.assets) return;
      const assets = release.assets;
      const pick = (test) => assets.find((asset) => test(asset.name))?.browser_download_url;
      const urls = {
        "mac-arm": pick((name) => /aarch64\.dmg$/i.test(name)),
        "mac-intel": pick((name) => /x64\.dmg$/i.test(name)),
        linux: pick((name) => /amd64\.AppImage$/i.test(name)),
      };
      downloadCards.forEach((card) => {
        const url = urls[card.dataset.downloadOs];
        if (url) card.href = url;
      });
      applyPrimaryDownload();
    })
    .catch(() => {});

  // Scroll-reveal. Honor reduced-motion by revealing everything immediately.
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const items = document.querySelectorAll(".reveal");

  if (reduce || !("IntersectionObserver" in window)) {
    items.forEach((el) => el.classList.add("in"));
    return;
  }

  const io = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add("in");
          io.unobserve(entry.target);
        }
      });
    },
    { rootMargin: "0px 0px -8% 0px", threshold: 0.12 }
  );
  items.forEach((el) => io.observe(el));
})();
