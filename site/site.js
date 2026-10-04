// ohiyo.gg. Progressive enhancement only: every page reads and works with JavaScript off.
(() => {
  "use strict";
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // The nav gets its bottom line once the page has scrolled.
  const nav = document.getElementById("nav");
  if (nav) {
    const onScroll = () => nav.classList.toggle("is-stuck", window.scrollY > 8);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
  }

  // Reveal sections as they come into view.
  const reveals = document.querySelectorAll(".reveal");
  if (reduceMotion || !("IntersectionObserver" in window)) {
    reveals.forEach((el) => el.classList.add("is-in"));
  } else {
    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          entry.target.classList.add("is-in");
          io.unobserve(entry.target);
        }
      },
      { rootMargin: "0px 0px -8% 0px", threshold: 0.1 }
    );
    reveals.forEach((el) => io.observe(el));
  }

  // The lock demo works with CSS alone. This only adds the scramble when the lock turns on.
  const toggle = document.getElementById("lock-toggle");
  const cipher = document.getElementById("cipher");
  if (toggle && cipher && !reduceMotion) {
    const settled = cipher.dataset.cipher;
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let timer;
    toggle.addEventListener("change", () => {
      window.clearInterval(timer);
      cipher.textContent = settled;
      if (!toggle.checked) return;
      let ticks = 0;
      timer = window.setInterval(() => {
        ticks += 1;
        // Characters settle from left to right.
        const fixed = Math.floor((ticks / 14) * settled.length);
        cipher.textContent = [...settled].map((ch, i) => (i < fixed ? ch : alphabet[Math.floor(Math.random() * alphabet.length)])).join("");
        if (ticks >= 14) {
          window.clearInterval(timer);
          cipher.textContent = settled;
        }
      }, 45);
    });
  }

  // Copy buttons.
  document.querySelectorAll("[data-copy]").forEach((button) => {
    if (!navigator.clipboard) {
      button.hidden = true;
      return;
    }
    const label = button.textContent;
    button.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(button.dataset.copy);
        button.textContent = "Copied";
      } catch {
        button.textContent = "Press Ctrl+C";
      }
      window.setTimeout(() => { button.textContent = label; }, 1600);
    });
  });
})();
