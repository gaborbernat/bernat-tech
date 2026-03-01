document.addEventListener("DOMContentLoaded", function () {
  var el = document.getElementById("footer-ts");
  if (!el) return;
  var d = new Date(el.dateTime);
  if (isNaN(d)) return;
  var p = function (n) {
    return n < 10 ? "0" + n : n;
  };
  el.textContent =
    d.getFullYear() +
    "-" +
    p(d.getMonth() + 1) +
    "-" +
    p(d.getDate()) +
    " " +
    p(d.getHours()) +
    ":" +
    p(d.getMinutes()) +
    ":" +
    p(d.getSeconds());
});
