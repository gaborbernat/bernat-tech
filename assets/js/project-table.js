document.addEventListener("DOMContentLoaded", function () {
  // the page is a static build refreshed out of band, so ages would freeze at build time in an open tab;
  // each badge reschedules itself for the moment its own label would next change
  var formatAge = function (timestamp, now) {
    var seconds = Math.max(0, now - timestamp);
    var unitSeconds;
    var unitEnd;
    var unit;
    if (seconds < 60) {
      return { label: "just now", color: "green", refreshIn: 60 - seconds };
    }
    if (seconds < 3600) {
      unitSeconds = 60;
      unitEnd = 3600;
      unit = "minute";
    } else if (seconds < 86400) {
      unitSeconds = 3600;
      unitEnd = 86400;
      unit = "hour";
    } else if (seconds < 2592000) {
      unitSeconds = 86400;
      unitEnd = 2592000;
      unit = "day";
    } else if (seconds < 31536000) {
      unitSeconds = 2592000;
      unitEnd = 31536000;
      unit = "month";
    } else {
      unitSeconds = 31536000;
      unitEnd = Infinity;
      unit = "year";
    }
    var hundredths = Math.floor((seconds * 100) / unitSeconds);
    var value = hundredths / 100;
    var refreshIn = Math.min(((hundredths + 1) * unitSeconds) / 100 - seconds, unitEnd - seconds);
    var color;
    // thresholds mirror layouts/_partials/time-ago.html so the first paint and the refresh agree
    if (seconds < 2592000) {
      color = "green";
      refreshIn = Math.min(refreshIn, 2592000 - seconds);
    } else if (seconds < 15638400) {
      color = "yellow";
      refreshIn = Math.min(refreshIn, 15638400 - seconds);
    } else {
      color = "red";
    }
    return {
      label: value + " " + unit + (value === 1 ? "" : "s") + " ago",
      color: color,
      refreshIn: refreshIn,
    };
  };

  var updateRelativeTime = function (badge) {
    var age = formatAge(Number(badge.dataset.timestamp), Date.now() / 1000);
    badge.querySelector(".relative-time-label").textContent = age.label;
    badge.classList.remove("badge-gray", "badge-green", "badge-yellow", "badge-red");
    badge.classList.add("badge-" + age.color);
    setTimeout(function () {
      updateRelativeTime(badge);
    }, Math.max(1, Math.ceil(age.refreshIn * 1000)));
  };
  document.querySelectorAll(".relative-time[data-timestamp]").forEach(updateRelativeTime);

  var btn = document.getElementById("ci-toggle-btn");
  if (btn) {
    // reflect the CI view in the URL (?ci=1) so it survives reload and is shareable
    var setCiView = function (on) {
      document.querySelectorAll(".project-table").forEach(function (t) {
        t.classList.toggle("ci-view", on);
      });
      btn.setAttribute("aria-pressed", on ? "true" : "false");
    };
    if (new URLSearchParams(location.search).get("ci") === "1") {
      setCiView(true);
    }
    btn.addEventListener("click", function () {
      var on = !document.querySelector(".project-table").classList.contains("ci-view");
      setCiView(on);
      var params = new URLSearchParams(location.search);
      if (on) {
        params.set("ci", "1");
      } else {
        params.delete("ci");
      }
      var qs = params.toString();
      history.replaceState(null, "", location.pathname + (qs ? "?" + qs : "") + location.hash);
    });
  }

  document.querySelectorAll(".project-table th[data-sort]").forEach(function (th) {
    th.addEventListener("click", function () {
      var table = this.closest("table");
      var tbody = table.querySelector("tbody");
      var rows = Array.from(tbody.querySelectorAll("tr"));
      var colIndex = Array.from(this.parentNode.children).indexOf(this);
      var asc = this.dataset.dir === "asc";
      this.dataset.dir = asc ? "desc" : "asc";

      table.querySelectorAll("th[data-sort]").forEach(function (h) {
        h.classList.remove("sort-asc", "sort-desc");
      });
      this.classList.add(asc ? "sort-desc" : "sort-asc");

      var sortType = this.dataset.sort;
      rows.sort(function (a, b) {
        if (sortType === "name") {
          var linkA = a.children[colIndex]?.querySelector("a");
          var linkB = b.children[colIndex]?.querySelector("a");
          var va = (linkA?.textContent || "").trim().toLowerCase();
          var vb = (linkB?.textContent || "").trim().toLowerCase();
          return asc ? va.localeCompare(vb) : vb.localeCompare(va);
        }
        var rawA = a.children[colIndex]?.dataset.value;
        var rawB = b.children[colIndex]?.dataset.value;
        var hasA = rawA != null && rawA !== "";
        var hasB = rawB != null && rawB !== "";
        if (!hasA && !hasB) return 0;
        if (!hasA) return 1;
        if (!hasB) return -1;
        var va = parseFloat(rawA);
        var vb = parseFloat(rawB);
        return asc ? va - vb : vb - va;
      });
      rows.forEach(function (row) {
        tbody.appendChild(row);
      });
    });
  });

  function formatCount(n) {
    return n.toLocaleString("en-US").replace(/,/g, "_");
  }

  // totals cover the rows currently on screen, so they stay honest once a filter narrows the table
  var updateTotals = function (table) {
    var row = table.querySelector("tfoot tr.summary-row");
    if (!row) return;
    var sum = function (selector, attr) {
      var total = 0;
      table.querySelectorAll("tbody tr:not([hidden]) " + selector).forEach(function (cell) {
        total += parseInt(cell.dataset[attr], 10) || 0;
      });
      return formatCount(total);
    };
    var dlCell = row.querySelector(".summary-downloads");
    if (dlCell) {
      dlCell.innerHTML = '<span class="badge badge-green">' + sum("td.dl-cell", "monthly") + "/mo</span>";
    }
    var starCell = row.querySelector(".summary-stars");
    if (starCell) {
      starCell.innerHTML = '<span class="badge badge-yellow">' + sum("td.star-cell", "value") + "</span>";
    }
  };

  document.querySelectorAll(".project-table").forEach(function (table) {
    var dlHeader = table.querySelector('th[data-sort="downloads"]');
    if (dlHeader) {
      dlHeader.click();
    } else {
      var dateHeader = table.querySelector('th[data-sort="date"]');
      if (dateHeader) {
        dateHeader.click();
      }
    }
  });

  // multi-select filters over three independent axes, each reflected in the URL
  // (?langs=rust&kinds=pre-commit&orgs=tox-dev) so they survive reload and are shareable. Within a bar the
  // selections OR together; the bars AND, so Rust + Pre-commit hook asks for Rust pre-commit hooks. Labels
  // come off the rendered rows, so the toolbars never drift from what data/projects.yaml produces.
  document.querySelectorAll(".project-table").forEach(function (table) {
    var rows = Array.from(table.querySelectorAll("tbody tr"));
    var params = new URLSearchParams(location.search);

    // every lang and kind slug is rendered as a .pkg-type badge, so the pill borrows that badge's icon
    // and label rather than keeping a second copy of the mapping here
    var fromBadges = function (attr) {
      return function () {
        var by = {};
        rows.forEach(function (row) {
          (row.dataset[attr] || "")
            .split(",")
            .filter(Boolean)
            .forEach(function (slug) {
              if (by[slug]) return;
              var badge = row.querySelector('.pkg-type[data-slug="' + slug + '"]');
              if (!badge) return;
              by[slug] = { slug: slug, icon: badge.querySelector("i").cloneNode(true), label: badge.dataset.label || slug };
            });
        });
        return Object.keys(by)
          .map(function (slug) {
            return by[slug];
          })
          .sort(function (a, b) {
            return a.label.localeCompare(b.label);
          });
      };
    };

    var dimensions = [
      { key: "langs", attr: "filterLangs", label: "Filter by language", entries: fromBadges("filterLangs") },
      { key: "kinds", attr: "filterKinds", label: "Filter by kind", entries: fromBadges("filterKinds") },
      {
        key: "orgs",
        attr: "filterOrgs",
        label: "Filter by org",
        // orgs have no per-org logo, so they share one building glyph; it still separates them from the
        // other pills at a glance and keeps the bars visually consistent
        entries: function () {
          var seen = [];
          rows.forEach(function (row) {
            (row.dataset.filterOrgs || "")
              .split(",")
              .filter(Boolean)
              .forEach(function (org) {
                if (seen.indexOf(org) === -1) seen.push(org);
              });
          });
          return seen.sort().map(function (org) {
            var icon = document.createElement("i");
            icon.className = "fas fa-building";
            icon.setAttribute("aria-hidden", "true");
            return { slug: org, icon: icon, label: org };
          });
        },
      },
    ];

    // a page can hold several tables sharing one query string, so each honours only the values it can
    // offer; otherwise a param meant for the projects table would blank the maintenance one with no pill
    // to undo it
    dimensions.forEach(function (dim) {
      dim.items = dim.entries();
      var offered = new Set(
        dim.items.map(function (item) {
          return item.slug;
        }),
      );
      dim.selected = new Set(
        (params.get(dim.key) || "")
          .split(",")
          .filter(function (v) {
            return offered.has(v);
          }),
      );
      dim.offered = offered;
    });

    // hide a data column entirely once every currently-visible row has nothing in it (e.g. filtering down to
    // the monorepo leaves Downloads, Version and Release empty); recomputed on every filter change. The CI
    // column is skipped — its display is driven by the ci-view toggle, which would override [hidden] anyway.
    var headerCells = Array.from(table.querySelectorAll("thead tr th"));
    var footerRow = table.querySelector("tfoot tr.summary-row");
    var updateColumnVisibility = function (visibleRows) {
      headerCells.forEach(function (th, idx) {
        if (idx < 2 || th.classList.contains("col-ci")) return;
        var hasContent = visibleRows.some(function (row) {
          var cell = row.children[idx];
          return !!cell && (cell.querySelector("a, img") || cell.textContent.trim() !== "");
        });
        th.hidden = !hasContent;
        visibleRows.forEach(function (row) {
          var cell = row.children[idx];
          if (cell) cell.hidden = !hasContent;
        });
        var footCell = footerRow && footerRow.children[idx];
        if (footCell) footCell.hidden = !hasContent;
      });
    };

    var applyFilter = function () {
      rows.forEach(function (row) {
        row.hidden = dimensions.some(function (dim) {
          if (!dim.selected.size) return false;
          return !(row.dataset[dim.attr] || "").split(",").some(function (v) {
            return dim.selected.has(v);
          });
        });
      });
      updateColumnVisibility(
        rows.filter(function (row) {
          return !row.hidden;
        }),
      );
      updateTotals(table);
    };

    var syncUrl = function () {
      var next = new URLSearchParams(location.search);
      dimensions.forEach(function (dim) {
        // replace only the values this table owns, leaving another table's selection in place
        var merged = (next.get(dim.key) || "")
          .split(",")
          .filter(function (v) {
            return v && !dim.offered.has(v);
          })
          .concat(Array.from(dim.selected))
          .sort();
        if (merged.length) {
          next.set(dim.key, merged.join(","));
        } else {
          next.delete(dim.key);
        }
      });
      var qs = next.toString();
      history.replaceState(null, "", location.pathname + (qs ? "?" + qs : "") + location.hash);
    };

    // three stacked bars read as a lot of chrome above the table, so they live inside a native <details>
    // disclosure instead of always-visible divs. Open by default only when a URL-supplied filter is
    // already active, so a shared filtered link still shows what's applied instead of hiding it.
    var accordion = document.createElement("details");
    accordion.className = "type-filters";
    var summary = document.createElement("summary");
    accordion.appendChild(summary);
    var updateSummary = function () {
      var activeCount = dimensions.reduce(function (n, dim) {
        return n + dim.selected.size;
      }, 0);
      summary.textContent = "Filters" + (activeCount ? " (" + activeCount + ")" : "");
    };

    var hasBar = false;
    dimensions.forEach(function (dim) {
      // a lone option filters nothing, so the smaller tables get no bar for that dimension
      if (dim.items.length < 2) return;
      hasBar = true;
      var bar = document.createElement("div");
      bar.className = "type-filter";
      bar.setAttribute("role", "group");
      bar.setAttribute("aria-label", dim.label);
      dim.items.forEach(function (item) {
        var pill = document.createElement("button");
        pill.type = "button";
        pill.className = "type-filter-pill";
        var on = dim.selected.has(item.slug);
        pill.classList.toggle("active", on);
        pill.setAttribute("aria-pressed", on ? "true" : "false");
        pill.appendChild(item.icon);
        var text = document.createElement("span");
        text.textContent = item.label;
        pill.appendChild(text);
        pill.addEventListener("click", function () {
          if (dim.selected.has(item.slug)) {
            dim.selected.delete(item.slug);
          } else {
            dim.selected.add(item.slug);
          }
          var active = dim.selected.has(item.slug);
          pill.classList.toggle("active", active);
          pill.setAttribute("aria-pressed", active ? "true" : "false");
          applyFilter();
          syncUrl();
          updateSummary();
        });
        bar.appendChild(pill);
      });
      accordion.appendChild(bar);
    });
    if (hasBar) {
      accordion.open = dimensions.some(function (dim) {
        return dim.selected.size > 0;
      });
      updateSummary();
      table.parentNode.insertBefore(accordion, table);
    }
    applyFilter();
  });
});
