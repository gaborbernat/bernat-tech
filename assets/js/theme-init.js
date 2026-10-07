(() => {
  let stored = null;
  try {
    stored = localStorage.getItem("colorscheme");
  } catch (error) {
    // SecurityError when storage is blocked (cookies off, sandboxed frame): keep the server-rendered class
    if (!(error instanceof DOMException)) throw error;
  }
  if (stored) {
    document.body.classList.remove("colorscheme-auto", "colorscheme-light", "colorscheme-dark");
    document.body.classList.add("colorscheme-" + stored);
    document.documentElement.style.colorScheme = stored;
  }
})();
