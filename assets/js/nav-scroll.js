// The nav (and with it the colour-scheme toggle) is sticky, but hides while you scroll down so it
// costs no vertical space while reading, and slides back as soon as you scroll up -- the gesture you
// already make when you want navigation. A timer-based reveal would instead vanish mid-reach.
const nav = document.querySelector(".navigation");
const menuToggle = document.getElementById("menu-toggle");

if (nav) {
  let last = window.scrollY;
  let ticking = false;

  const update = () => {
    const y = Math.max(0, window.scrollY);
    const delta = y - last;

    if (menuToggle?.checked || y <= nav.offsetHeight * 2) {
      // never hide the open mobile menu, nor while still in the header area
      nav.classList.remove("nav-hidden");
    } else if (Math.abs(delta) > 6) {
      // the threshold swallows scroll jitter, which would otherwise flicker the bar
      nav.classList.toggle("nav-hidden", delta > 0);
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
