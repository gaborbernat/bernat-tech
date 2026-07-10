// Render webmentions for this post from webmention.io's public read API. Escapes all remote strings and
// never injects remote HTML or images, so the page's strict CSP and privacy hold.
(function () {
  const root = document.querySelector(".webmentions");
  if (!root) return;
  const target = root.dataset.target;
  const facepile = root.querySelector(".webmentions-facepile");
  const list = root.querySelector(".webmentions-list");

  const esc = (value) => {
    const node = document.createElement("div");
    node.textContent = value == null ? "" : String(value);
    return node.innerHTML;
  };
  const nameOf = (author) => (author && (author.name || author.url)) || "Someone";
  const initials = (name) =>
    name
      .split(/\s+/)
      .map((part) => part.charAt(0))
      .join("")
      .slice(0, 2)
      .toUpperCase() || "•";

  fetch("https://webmention.io/api/mentions.jf2?per-page=200&target=" + encodeURIComponent(target))
    .then((response) => (response.ok ? response.json() : Promise.reject(response.status)))
    .then((data) => {
      const items = data.children || [];
      if (!items.length) return;

      const likes = [];
      const reposts = [];
      const replies = [];
      for (const item of items) {
        const kind = item["wm-property"];
        if (kind === "like-of") likes.push(item);
        else if (kind === "repost-of") reposts.push(item);
        else if (kind === "in-reply-to" || kind === "mention-of") replies.push(item);
      }

      const faces = [];
      const addFaces = (arr, label) => {
        for (const item of arr) {
          const author = item.author || {};
          const name = nameOf(author);
          const href = author.url || item.url || "#";
          faces.push(
            '<a class="webmention-face" href="' +
              esc(href) +
              '" rel="nofollow noopener" title="' +
              esc(name + " " + label) +
              '">' +
              esc(initials(name)) +
              "</a>",
          );
        }
      };
      addFaces(reposts, "reposted");
      addFaces(likes, "liked");
      if (faces.length) {
        facepile.innerHTML = faces.join("");
        facepile.hidden = false;
      }

      const rows = replies.map((item) => {
        const author = item.author || {};
        const name = nameOf(author);
        const href = author.url || "#";
        const when = String(item.published || item["wm-received"] || "").slice(0, 10);
        const body = (item.content && item.content.text) || "";
        return (
          '<li class="webmention"><a class="webmention-author" href="' +
          esc(href) +
          '" rel="nofollow noopener">' +
          esc(name) +
          "</a>" +
          (when ? ' <time class="webmention-date">' + esc(when) + "</time>" : "") +
          '<p class="webmention-body">' +
          esc(body) +
          "</p></li>"
        );
      });
      if (rows.length) {
        list.innerHTML = rows.join("");
        list.hidden = false;
      }
    })
    .catch(() => {});
})();
