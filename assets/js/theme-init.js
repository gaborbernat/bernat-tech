(() => {
  const stored = localStorage.getItem("colorscheme");
  if (stored) {
    document.body.classList.remove("colorscheme-auto", "colorscheme-light", "colorscheme-dark");
    document.body.classList.add("colorscheme-" + stored);
    document.documentElement.style.colorScheme = stored;
  }
})();
