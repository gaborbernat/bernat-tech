// Additive topic filter for the posts table. Toggle topic pills to show posts matching ANY selected
// topic (union); no selection shows everything. The active set is mirrored in the URL (?topics=a,b) so a
// filtered view is shareable and the home page can deep-link into it. Hidden rows use [hidden] so the CSS
// row counter skips them.
(function () {
  const pills = Array.from(document.querySelectorAll(".topic-pill"));
  const rows = Array.from(document.querySelectorAll(".post-list tbody tr"));
  const clear = document.querySelector(".topic-clear");
  if (!pills.length || !rows.length) return;

  const active = new Set();

  const apply = () => {
    rows.forEach((row) => {
      const topics = (row.dataset.topics || "").split(/\s+/).filter(Boolean);
      row.hidden = active.size > 0 && !topics.some((topic) => active.has(topic));
    });
    pills.forEach((pill) => pill.setAttribute("aria-pressed", String(active.has(pill.dataset.topic))));
    if (clear) clear.hidden = active.size === 0;
  };

  const syncUrl = () => {
    const url = new URL(window.location.href);
    if (active.size) url.searchParams.set("topics", [...active].join(","));
    else url.searchParams.delete("topics");
    window.history.replaceState(null, "", url.pathname + url.search);
  };

  const toggle = (topic) => {
    if (active.has(topic)) active.delete(topic);
    else active.add(topic);
    apply();
    syncUrl();
  };

  pills.forEach((pill) => pill.addEventListener("click", () => toggle(pill.dataset.topic)));
  if (clear) {
    clear.addEventListener("click", () => {
      active.clear();
      apply();
      syncUrl();
    });
  }

  // seed the filter from the URL so /posts/?topics=packaging,python opens pre-filtered
  const known = new Set(pills.map((pill) => pill.dataset.topic));
  const initial = new URLSearchParams(window.location.search).get("topics");
  if (initial) initial.split(",").forEach((topic) => known.has(topic) && active.add(topic));
  apply();
})();
