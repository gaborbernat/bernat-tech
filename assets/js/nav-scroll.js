// Scroll-driven chrome: the sticky nav (which carries the colour-scheme toggle) and the back-to-top
// button. Both hide while you scroll down, so reading costs no vertical space, and both return the
// moment you scroll up -- the gesture you already make when you want to navigate. A timed reveal was
// rejected for either: it hides mid-reach. One throttled listener drives both.
const nav = document.querySelector(".navigation");
const menuToggle = document.getElementById("menu-toggle");
const toTop = document.getElementById("back-to-top");

if (nav || toTop) {
  const reveal = nav ? nav.offsetHeight * 2 : 0;
  let last = window.scrollY;
  let ticking = false;

  const update = () => {
    const y = Math.max(0, window.scrollY);
    const delta = y - last;
    const nearTop = y <= reveal;

    if (menuToggle?.checked || nearTop) {
      nav?.classList.remove("nav-hidden");
      toTop?.classList.remove("is-visible");
    } else if (Math.abs(delta) > 6) {
      // the threshold swallows scroll jitter, which would otherwise flicker the chrome
      const goingDown = delta > 0;
      nav?.classList.toggle("nav-hidden", goingDown);
      toTop?.classList.toggle("is-visible", !goingDown);
    }

    last = y;
    ticking = false;
  };

  window.addEventListener(
    "scroll",
    () => {
      if (!ticking) {
        window.requestAnimationFrame(update);
        ticking = true;
      }
    },
    { passive: true },
  );
}

toTop?.addEventListener("click", () => {
  const smooth = !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  window.scrollTo({ top: 0, behavior: smooth ? "smooth" : "auto" });
});
