document.addEventListener("DOMContentLoaded", function () {
  document.querySelectorAll(".youtube-lazy").forEach(function (el) {
    el.addEventListener("click", function () {
      var iframe = document.createElement("iframe");
      iframe.setAttribute("src", el.dataset.src);
      iframe.setAttribute("frameborder", "0");
      iframe.setAttribute(
        "allow",
        "accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture",
      );
      iframe.setAttribute("allowfullscreen", "");
      el.textContent = "";
      el.appendChild(iframe);
    });
  });
});
