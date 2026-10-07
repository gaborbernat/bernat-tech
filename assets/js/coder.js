const body = document.body;
const darkModeToggle = document.getElementById("dark-mode-toggle");
const darkModeMediaQuery = window.matchMedia("(prefers-color-scheme: dark)");

// localStorage throws when storage is blocked (cookies off, sandboxed frame); the toggle still works per page
function storedTheme() {
  try {
    return localStorage.getItem("colorscheme");
  } catch (error) {
    if (!(error instanceof DOMException)) throw error;
    return null;
  }
}

function storeTheme(theme) {
  try {
    localStorage.setItem("colorscheme", theme);
  } catch (error) {
    if (!(error instanceof DOMException)) throw error;
  }
}

if (storedTheme()) {
  setTheme(storedTheme());
} else if (body.classList.contains("colorscheme-light") || body.classList.contains("colorscheme-dark")) {
  setTheme(body.classList.contains("colorscheme-dark") ? "dark" : "light");
} else {
  setTheme(darkModeMediaQuery.matches ? "dark" : "light");
}

if (darkModeToggle) {
  darkModeToggle.addEventListener("click", () => {
    const theme = body.classList.contains("colorscheme-dark") ? "light" : "dark";
    setTheme(theme);
    storeTheme(theme);
  });
}

darkModeMediaQuery.addEventListener("change", (event) => {
  if (!storedTheme()) setTheme(event.matches ? "dark" : "light");
});

document.addEventListener("DOMContentLoaded", () => {
  document.querySelector(".preload-transitions")?.classList.remove("preload-transitions");
});

function setTheme(theme) {
  const inverse = theme === "dark" ? "light" : "dark";
  body.classList.remove("colorscheme-auto", "colorscheme-" + inverse);
  body.classList.add("colorscheme-" + theme);
  document.documentElement.style["color-scheme"] = theme;

  // show the icon of the mode a click switches to: moon while light, sun while dark
  const icon = document.querySelector("#dark-mode-toggle i");
  if (icon) {
    icon.className = "fa-solid fa-fw " + (theme === "dark" ? "fa-sun" : "fa-moon");
  }

  document.dispatchEvent(new Event("themeChanged"));
}
