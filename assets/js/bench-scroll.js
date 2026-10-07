for (const w of document.querySelectorAll('.bench-wrap')) {
  const update = () => {
    w.classList.toggle('more-left', w.scrollLeft > 2);
    w.classList.toggle('more-right', w.scrollLeft + w.clientWidth < w.scrollWidth - 2);
  };
  update();
  w.addEventListener('scroll', update, { passive: true });
  window.addEventListener('resize', update, { passive: true });
}
