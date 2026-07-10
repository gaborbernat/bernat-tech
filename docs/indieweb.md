# Webmentions and POSSE setup

The site emits everything the IndieWeb stack needs — `rel=webmention` endpoint links, `h-entry`/`h-card` microformats on
posts, `u-syndication` links, and a client-side webmention display. Three account steps remain that only the site owner
can do; none touch the build.

## 1. Register the domain at webmention.io

Sign in at <https://webmention.io> with `https://bernat.tech` (IndieAuth authenticates via the `rel=me` links already in
the page head — the GitHub and Mastodon ones). Registration activates the endpoint the pages already point at:
`https://webmention.io/bernat.tech/webmention`. The `params.webmention.domain` value in `hugo.toml` must match the
registered domain.

Until this step is done the read API simply returns nothing and the Webmentions section shows only its intro line.

## 2. Backfeed social replies with Bridgy

At <https://brid.gy> connect the Mastodon (`@gaborbernat@fosstodon.org`) and Bluesky accounts. Bridgy then polls them
and, when someone replies to / likes / reposts a syndicated copy, sends that interaction to the webmention.io endpoint
as a webmention — so it renders on the post. Bridgy discontinued Twitter/X backfeed, so that network is out.

## 3. POSSE workflow when publishing

Publish on the site first (canonical URL), then syndicate to Mastodon/Bluesky/HN. Paste the URLs of those copies back
into the post's front matter so Bridgy can find them and route replies home:

```toml
syndication = [
  "https://fosstodon.org/@gaborbernat/…",
  "https://bsky.app/profile/gjbernat.bsky.social/post/…",
]
```

Those render as `u-syndication` "Also on" links under the post.

## What the site already does

- `rel=webmention` / `rel=pingback` links in `<head>` (`layouts/partials/head/extensions.html`).
- `h-entry` article with `p-name`, `u-url`, `dt-published`, `e-content`, and a hidden `p-author h-card`
  (`layouts/posts/single.html`).
- Client-side display of received mentions (`layouts/partials/posts/webmentions.html`, `assets/js/webmentions.js`) —
  names and text only, no remote images, so the strict CSP holds (`webmention.io` is allowlisted in `connect-src`).
- `u-syndication` links from front matter (`layouts/partials/posts/syndication.html`).
