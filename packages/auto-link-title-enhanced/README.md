# Auto Link Title (Enhanced)

Fork of [zolrath/obsidian-auto-link-title](https://github.com/zolrath/obsidian-auto-link-title) — automatically fetches the title of a link when you paste/drop a URL and turns it into a Markdown link.

## Enhancements over upstream

1. **Titles from an LLM (primary).** By default the plugin fetches the page, extracts its real signals (title, og tags, description, a text excerpt), and has an OpenAI-compatible chat model write a concise title **grounded in the actual page** (not just the URL slug). If it isn't configured or anything fails, it falls back to the rules below.
2. **`requestUrl` scraper only (fallback).** The legacy Electron `BrowserWindow` scraper is removed. The fallback path uses the `requestUrl`-based scraper (works on desktop *and* mobile).
3. **Custom request headers (fallback).** You can inject extra headers into scraper requests — mainly so intranet pages that require a manual `Cookie`/token can be scraped. Headers are scoped per rule so an internal cookie is never leaked to public sites.

## Title resolution order

1. **LLM** — fetches the page (via `requestUrl`, applying header rules), extracts title/og/description/excerpt, then `POST {baseUrl}/chat/completions` asking the model for a concise title grounded in that content. The API call goes through Node's `http(s)` module on desktop (OS sockets + system resolver, like `curl`/`openssl`, to sidestep Chromium's network stack — proxy/DNS interception, bad certs) and `fetch` on mobile; logged to console, and the desktop path is **not** shown in the DevTools Network tab. If the LLM returns nothing, the page's real `<title>` is used. Page fetch failed / not configured → fall through.
2. **LinkPreview** — if a `linkPreviewApiKey` is set.
3. **`requestUrl` scraper** — fetches the page and reads its `<title>`, applying any custom header rules.

The LLM step is skipped (straight to step 2) when *Use LLM* is off, no API key/model is set, or the request errors / times out (20s).

### LLM settings

Settings → **Title generation with an LLM**. Any OpenAI-compatible endpoint works — set the base URL, key, and model:

- **Use LLM** — toggle the primary path on/off.
- **API base URL** — e.g. `https://api.openai.com/v1`, `https://api.groq.com/openai/v1`, `https://generativelanguage.googleapis.com/v1beta/openai`. Default: OpenAI.
- **API key** — sent as `Authorization: Bearer <key>`; stored in this plugin's `data.json`.
- **Model** — e.g. `gpt-5.4-nano`. Default: `gpt-5.4-nano`.

The request body is intentionally minimal (`model` + `messages` only) — no `max_tokens`/`temperature` — so it works across providers that differ on those fields; the prompt keeps the output to one short line.

## Custom request headers

Settings → **Custom request headers** is a list of rules. Each rule has:

- **left** — a domain/URL match. `*` is a wildcard for any run of characters; every other character is literal. Matched unanchored, so a bare `corp.com` behaves like "contains". Leave it empty to apply to every request.
- **right** — that rule's headers, one per line as `Name: value`.

`Add rule` appends a new row; the trash icon deletes one.

Example — one rule matching `*.corp.com` with headers:

```
Cookie: SESSION=abc; token=xyz
X-Requested-With: XMLHttpRequest
```

Notes:

- A rule's headers are sent **only** to URLs it matches, so an intranet cookie never leaks to public sites.
- The value is everything after the first `:`, so cookie values containing `;` or `:` are preserved verbatim.
- Rules apply in order; a later rule overrides an earlier one for the same header name.
- Within a rule's headers box, lines starting with `#` are comments.

## Development

```bash
pnpm dev:auto-link-title-enhanced      # watch + symlink into the local vault
pnpm build:auto-link-title-enhanced    # type-check + production build
```

Licensed MIT (see `LICENSE`), original © Matt Furden.
