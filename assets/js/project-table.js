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
    btn.addEventListener("click", function () {
      document.querySelectorAll(".project-table").forEach(function (t) {
        t.classList.toggle("ci-view");
      });
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

  document.querySelectorAll(".project-table tfoot tr.summary-row").forEach(function (row) {
    var table = row.closest("table");
    var dlCell = row.querySelector(".summary-downloads");
    if (dlCell) {
      var dlSum = 0;
      table.querySelectorAll("tbody td.dl-cell").forEach(function (cell) {
        dlSum += parseInt(cell.dataset.monthly, 10) || 0;
      });
      dlCell.innerHTML = '<span class="badge badge-green">' + formatCount(dlSum) + "/mo</span>";
    }
    var starCell = row.querySelector(".summary-stars");
    if (starCell) {
      var starSum = 0;
      table.querySelectorAll("tbody td.star-cell").forEach(function (cell) {
        starSum += parseInt(cell.dataset.value, 10) || 0;
      });
      starCell.innerHTML = '<span class="badge badge-yellow">' + formatCount(starSum) + "</span>";
    }
  });

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
});
