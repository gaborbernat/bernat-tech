document.addEventListener("DOMContentLoaded", function () {
  var el = document.getElementById("footer-ts");
  if (!el) return;
  var d = new Date(el.dateTime);
  if (isNaN(d)) return;
  var p = function (n) {
    return n < 10 ? "0" + n : n;
  };
  var ms = d.getMilliseconds();
  var s =
    d.getFullYear() +
    "-" +
    p(d.getMonth() + 1) +
    "-" +
    p(d.getDate()) +
    "T" +
    p(d.getHours()) +
    ":" +
    p(d.getMinutes()) +
    ":" +
    p(d.getSeconds()) +
    "." +
    (ms < 100 ? (ms < 10 ? "00" : "0") : "") +
    ms;
  var tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  el.textContent = s + "\u00a0" + tz;
});
