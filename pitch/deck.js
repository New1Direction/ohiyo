/* Ohiyo pitch deck — navigation + interactions. No dependencies. */
(() => {
  "use strict";
  const $ = (s, r = document) => r.querySelector(s);
  const slides = [...document.querySelectorAll(".slide")];
  const deck = $("#deck");
  let i = 0;

  // ── Build dots + jump menu from slide titles ────────────────────────────
  const dotsEl = $("#dots");
  const menuList = $("#menuList");
  slides.forEach((s, n) => {
    const d = document.createElement("button");
    d.setAttribute("aria-label", s.dataset.title);
    d.addEventListener("click", () => go(n));
    dotsEl.appendChild(d);

    const li = document.createElement("li");
    const b = document.createElement("button");
    b.textContent = s.dataset.title;
    b.addEventListener("click", () => { go(n); closeMenu(); });
    li.appendChild(b);
    menuList.appendChild(li);
  });
  const dots = [...dotsEl.children];
  const menuItems = [...menuList.querySelectorAll("button")];

  // ── Navigation ──────────────────────────────────────────────────────────
  function go(n) {
    n = Math.max(0, Math.min(slides.length - 1, n));
    if (n === i) return;
    slides[i].classList.remove("is-active");
    slides[i].classList.toggle("is-prev", n > i);
    i = n;
    render();
  }
  const next = () => go(i + 1);
  const prev = () => go(i - 1);

  function render() {
    slides.forEach((s, n) => {
      s.classList.toggle("is-active", n === i);
      if (n !== i) s.classList.remove("is-prev");
    });
    dots.forEach((d, n) => d.classList.toggle("on", n === i));
    menuItems.forEach((m, n) => m.classList.toggle("on", n === i));
    $("#progress").style.width = ((i + 1) / slides.length) * 100 + "%";
    $("#counter").innerHTML = `<b>${String(i + 1).padStart(2, "0")}</b> / ${String(slides.length).padStart(2, "0")}`;
    $("#hint").style.opacity = i === 0 ? "1" : "0";
  }

  // ── Menu overlay ──────────────────────────────────────────────────────────
  const menu = $("#menu");
  const openMenu = () => menu.classList.add("open");
  const closeMenu = () => menu.classList.remove("open");
  $("#menuBtn").addEventListener("click", openMenu);
  $("#menuBtn2").addEventListener("click", openMenu);
  menu.addEventListener("click", (e) => { if (e.target === menu) closeMenu(); });

  // ── Buttons ───────────────────────────────────────────────────────────────
  $("#next").addEventListener("click", next);
  $("#prev").addEventListener("click", prev);
  $("#startBtn").addEventListener("click", next);
  $("#restartBtn").addEventListener("click", () => go(0));

  // ── Keyboard ──────────────────────────────────────────────────────────────
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape") return closeMenu();
    if (e.key === "m" || e.key === "M") return menu.classList.contains("open") ? closeMenu() : openMenu();
    if (e.key === "f" || e.key === "F") {
      document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen?.();
      return;
    }
    if (["ArrowRight", "ArrowDown", " ", "PageDown"].includes(e.key)) { e.preventDefault(); next(); }
    else if (["ArrowLeft", "ArrowUp", "PageUp"].includes(e.key)) { e.preventDefault(); prev(); }
    else if (e.key === "Home") go(0);
    else if (e.key === "End") go(slides.length - 1);
    else if (/^[1-9]$/.test(e.key)) go(parseInt(e.key, 10) - 1);
  });

  // Wheel / swipe to advance (debounced).
  let wheelLock = false;
  deck.addEventListener("wheel", (e) => {
    if (Math.abs(e.deltaY) < 24 || wheelLock || menu.classList.contains("open")) return;
    if (e.target.closest(".panel, .explorer, .cmp")) return; // let inner content scroll
    wheelLock = true;
    e.deltaY > 0 ? next() : prev();
    setTimeout(() => (wheelLock = false), 700);
  }, { passive: true });

  let touchY = null;
  deck.addEventListener("touchstart", (e) => (touchY = e.touches[0].clientY), { passive: true });
  deck.addEventListener("touchend", (e) => {
    if (touchY == null) return;
    const dy = touchY - e.changedTouches[0].clientY;
    if (Math.abs(dy) > 50) (dy > 0 ? next() : prev());
    touchY = null;
  }, { passive: true });

  // ── Verification toggle (slide 3) ─────────────────────────────────────────
  const sw = $("#verifSwitch");
  const cmp = $("#cmp");
  const flip = () => { sw.classList.toggle("on"); cmp.classList.toggle("show-verif"); };
  sw.addEventListener("click", flip);
  sw.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); flip(); } });

  // ── Product-line explorer (slide 4) ───────────────────────────────────────
  const PILLARS = [
    {
      ic: "🔒", name: "End-to-end encryption", key: "Privacy",
      desc: "Private chats are sealed on-device. The server routes ciphertext for E2E DMs and group DMs, not readable message bodies.",
      feats: [
        ["Signal Protocol DMs", "X3DH + Double Ratchet via libsignal"],
        ["Encrypted group DMs", "sender keys, epoch rekey on join/leave"],
        ["Safety numbers", "verify a contact across all their devices"],
        ["Encrypted attachments", "client-side AES-GCM before upload"],
        ["Backup & recovery", "self-custody code, PBKDF2 → AES-256-GCM"],
        ["Threat model", "public privacy boundaries, no anonymity overclaim"],
      ],
    },
    {
      ic: "💬", name: "Communities & messaging", key: "Platform",
      desc: "Everything a real community needs — and none of it locked behind a subscription.",
      feats: [
        ["Servers, channels, categories", "organize at any scale"],
        ["DMs & group DMs", "encrypted by default"],
        ["Roles & permissions", "granular, per-channel gates"],
        ["Polls, events, reactions", "@everyone / @here mentions"],
        ["Pins, saved, forward, drafts", "read receipts too"],
        ["Rich media embeds", "video previews, direct video links, YouTube iframes"],
      ],
    },
    {
      ic: "🎙️", name: "Voice, video & screen-share", key: "Realtime",
      desc: "Talk, watch, present, and share clips together — the realtime layer is built and still being hardened for launch.",
      feats: [
        ["Mesh + SFU", "WebRTC mesh or LiveKit, chosen at runtime"],
        ["Up to 4K screen-share", "crisp presenting & pair-work"],
        ["Media E2EE path", "FrameCryptor integration under live hardening"],
        ["TURN / STUN", "calls connect across NATs and firewalls"],
        ["Watch parties", "synced video for the whole room"],
        ["Video attachments", "inline previews with Range-backed playback"],
      ],
    },
    {
      ic: "🛡️", name: "Privacy & safety", key: "Trust",
      desc: "Designed to forget what it doesn't need, and to defend what it keeps.",
      feats: [
        ["Disappearing messages", "per-channel TTL, swept server-side"],
        ["Dead-man's switch", "auto-wipe after inactivity (1h–1y)"],
        ["E2E blind spots", "private chat bodies remain unreadable to the server"],
        ["Moderation", "hide, report, block, kick, ban, role-gated actions"],
        ["Rate limiting", "per-IP brute-force + spam throttles"],
        ["Hardened surface", "CSP, nosniff, signed file URLs, generic errors"],
      ],
    },
    {
      ic: "🎨", name: "Make it yours", key: "Design",
      desc: "Deep customization that's simply free — the things Discord charges Nitro for.",
      feats: [
        ["Themes + editor", "8 built-ins and a build-your-own studio"],
        ["One-click accents", "9 presets or any custom color"],
        ["Density & font scale", "tune the whole UI to taste"],
        ["Profiles", "banner, avatar, bio, pronouns, socials"],
        ["Welcoming onboarding", "a warm, guided first run"],
        ["Appearance sync", "your look follows you across devices"],
      ],
    },
    {
      ic: "🏠", name: "Self-host & platform", key: "Ops",
      desc: "A single binary you actually own — production-hardened, not a toy.",
      feats: [
        ["Rust + SQLite", "one axum binary, one database file"],
        ["React + Tauri desktop", "native mac / windows / linux apps"],
        ["Instant Servers", "create, sleep, wake, export, graduate, billing handoff"],
        ["Raw Server Pack", "SQLite snapshot + uploads + signed manifest"],
        ["Resilient by default", "fail-fast config, graceful shutdown, DB health"],
        ["Proven quality", "116 server tests · 76 client tests · 27 E2E suites"],
      ],
    },
  ];

  const rail = $("#rail");
  const panel = $("#panel");
  PILLARS.forEach((p, n) => {
    const b = document.createElement("button");
    b.innerHTML = `<span class="ic">${p.ic}</span> ${p.name}`;
    b.addEventListener("click", () => selectPillar(n));
    rail.appendChild(b);
  });
  const railBtns = [...rail.children];

  function selectPillar(n) {
    railBtns.forEach((b, k) => b.classList.toggle("active", k === n));
    const p = PILLARS[n];
    panel.innerHTML =
      `<h3>${p.name}</h3><p class="pdesc">${p.desc}</p><div class="feat">` +
      p.feats.map((f) => `<div><span class="c">›</span><div>${f[0]}<small>${f[1]}</small></div></div>`).join("") +
      `</div>`;
    panel.classList.remove("swap");
    void panel.offsetWidth; // restart the swap animation
    panel.classList.add("swap");
  }
  selectPillar(0);

  // ── Boot ────────────────────────────────────────────────────────────────
  slides[0].classList.add("is-active");
  render();
})();
