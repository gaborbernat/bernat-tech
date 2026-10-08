// Render webmentions for this post from webmention.io's public read API. Every remote value reaches the DOM
// through textContent or a URL-checked href, never as markup, because anyone can send a mention.
(function () {
  const root = document.querySelector(".webmentions");
  if (!root) return;
  const target = root.dataset.target;
  const facepile = root.querySelector(".webmentions-facepile");
  const list = root.querySelector(".webmentions-list");

  const nameOf = (author) => (author && (author.name || author.url)) || "Someone";
  const initials = (name) =>
    name
      .split(/\s+/)
      .map((part) => part.charAt(0))
      .join("")
      .slice(0, 2)
      .toUpperCase() || "•";
  // a javascript: or data: URL from a hostile h-card would run on click, so only http(s) links survive
  const safeHref = (value) => {
    try {
      const url = new URL(String(value));
      return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
    } catch (error) {
      if (!(error instanceof TypeError)) throw error; // new URL() throws TypeError for anything unparseable
      return null;
    }
  };
  // the author's site first, else the mention's own permalink; with neither, plain text rather than a dead link
  const link = (className, item, text) => {
    const href = safeHref((item.author || {}).url) || safeHref(item.url);
    const node = document.createElement(href ? "a" : "span");
    node.className = className;
    if (href) {
      node.href = href;
      node.rel = "nofollow ugc noopener";
    }
    node.textContent = text;
    return node;
  };

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

      const addFaces = (arr, label) => {
        for (const item of arr) {
          const author = item.author || {};
          const name = nameOf(author);
          const face = link("webmention-face", item, initials(name));
          face.title = name + " " + label;
          facepile.append(face);
        }
      };
      addFaces(reposts, "reposted");
      addFaces(likes, "liked");
      if (facepile.childElementCount) facepile.hidden = false;

      for (const item of replies) {
        const author = item.author || {};
        const row = document.createElement("li");
        row.className = "webmention";
        row.append(link("webmention-author", item, nameOf(author)));
        const when = String(item.published || item["wm-received"] || "").slice(0, 10);
        if (when) {
          const time = document.createElement("time");
          time.className = "webmention-date";
          time.textContent = when;
          row.append(" ", time);
        }
        const body = document.createElement("p");
        body.className = "webmention-body";
        body.textContent = (item.content && item.content.text) || "";
        row.append(body);
        list.append(row);
      }
      if (list.childElementCount) list.hidden = false;
    })
    .catch(() => {});
})();
