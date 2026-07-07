// Client-side sort for the posts index: click (or Enter/Space on) a column header to sort asc/desc.
// Defaults to newest published first. Numeric columns compare data-value; the Post column compares text.
document.addEventListener("DOMContentLoaded", function () {
  const table = document.querySelector("table.post-list");
  if (!table) {
    return;
  }
  const tbody = table.querySelector("tbody");
  const headers = Array.from(table.querySelectorAll("th[data-sort]"));

  function sort(header, direction) {
    const column = Array.from(header.parentNode.children).indexOf(header);
    const ascending = direction === "asc";
    for (const other of headers) {
      other.classList.remove("sort-asc", "sort-desc");
      other.setAttribute("aria-sort", "none");
    }
    header.classList.add(ascending ? "sort-asc" : "sort-desc");
    header.setAttribute("aria-sort", ascending ? "ascending" : "descending");
    header.dataset.dir = direction;

    const byText = header.dataset.sort === "text";
    Array.from(tbody.rows)
      .sort(function (rowA, rowB) {
        const cellA = rowA.cells[column];
        const cellB = rowB.cells[column];
        if (byText) {
          const textA = cellA.textContent.trim().toLowerCase();
          const textB = cellB.textContent.trim().toLowerCase();
          return ascending ? textA.localeCompare(textB) : textB.localeCompare(textA);
        }
        // blank values (e.g. a never-updated post) always sink to the bottom, whichever direction
        const valueA = cellA.dataset.value;
        const valueB = cellB.dataset.value;
        if (!valueA && !valueB) {
          return 0;
        }
        if (!valueA) {
          return 1;
        }
        if (!valueB) {
          return -1;
        }
        return ascending ? valueA - valueB : valueB - valueA;
      })
      .forEach(function (row) {
        tbody.appendChild(row);
      });
  }

  for (const header of headers) {
    header.tabIndex = 0;
    const toggle = function () {
      sort(header, header.dataset.dir === "asc" ? "desc" : "asc");
    };
    header.addEventListener("click", toggle);
    header.addEventListener("keydown", function (event) {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        toggle();
      }
    });
  }

  sort(headers[0], "desc");
});
