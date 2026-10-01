# Auto Link Title (Enhanced)

Fork of [zolrath/obsidian-auto-link-title](https://github.com/zolrath/obsidian-auto-link-title) — automatically fetches the title of a link when you paste/drop a URL and turns it into a Markdown link.

## Enhancements over upstream

1. **Titles from an LLM (primary).** By default the plugin fetches the page, extracts its real signals (title, og tags, description, a text excerpt), and has an OpenAI-compatible chat model write a concise title **grounded in the actual page** (not just the URL slug). If it isn't configured or anything fails, it falls back to the rules below.
2. **`requestUrl` scraper only (fallback).** The legacy Electron `BrowserWindow` scraper is removed. The fallback path uses the `requestUrl`-based scraper (works on desktop *and* mobile).
3. **Cookies from Chrome (macOS).** Every link is fetched with the cookies Chrome would send to it, so intranet pages behind SSO return their real title — no cookie to paste, nothing stale, nothing saved.

## Title resolution order

1. **LLM** — fetches the page (via `requestUrl`, with Chrome's cookies), extracts title/og/description/excerpt, then `POST {baseUrl}/chat/completions` asking the model for a concise title grounded in that content. The API call goes through Node's `http(s)` module on desktop (OS sockets + system resolver, like `curl`/`openssl`, to sidestep Chromium's network stack — proxy/DNS interception, bad certs) and `fetch` on mobile; logged to console, and the desktop path is **not** shown in the DevTools Network tab. If the LLM returns nothing, the page's real `<title>` is used. Page fetch failed / not configured → fall through.
2. **`requestUrl` scraper** — fetches the page (same cookies) and reads its `<title>`.

The LLM step is skipped (straight to step 2) when *Use LLM* is off, no API key/model is set, or the request errors / times out (15s).

### LLM settings

Settings → **Title generation with an LLM**. Any OpenAI-compatible endpoint works — set the base URL, key, and model:

- **Use LLM** — toggle the primary path on/off.
- **API base URL** — e.g. `https://api.openai.com/v1`, `https://api.groq.com/openai/v1`, `https://generativelanguage.googleapis.com/v1beta/openai`. Default: OpenAI.
- **API key** — sent as `Authorization: Bearer <key>`; stored in this plugin's `data.json`.
- **Model** — e.g. `gpt-5.4-nano`. Default: `gpt-5.4-nano`.

The request body is intentionally minimal (`model` + `messages` only) — no `max_tokens`/`temperature` — so it works across providers that differ on those fields; the prompt keeps the output to one short line.

## Cookies from Chrome

macOS desktop only, nothing to configure. Every title fetch reads the cookies Chrome would send to that URL — matched by host, path, `Secure` and expiry, the way Chrome picks them — from the Default profile's cookie database (`/usr/bin/sqlite3`, read-only, without locking Chrome's file), decrypts them with the "Chrome Safe Storage" keychain password, and sends them as the `Cookie` header. A site only ever receives its own cookies, as when you open the link in Chrome; because Chrome keeps the session fresh as you browse, they're as current as Chrome's.

- The cookies live in memory for that one request; they are never written to `data.json`, so they don't sync or end up in a vault backup. Logs show only the cookie count.
- macOS asks for keychain access the first time after Obsidian starts. **Allow** keeps asking once per launch; **Always Allow** stops asking, but grants `/usr/bin/security` itself — so any program could then read the key the same way. If you cancel, links are fetched without cookies until the next launch (or until **Test a link** asks again), with a single notice saying so.
- **Test a link** shows how many cookies Chrome has for a URL and the title it resolves to.
- It's a plain request, not a rendered page: a single-page app that only sets its title from JavaScript still comes back with its static `<title>`. Lark / Feishu pages are the exception handled specially — their HTML always says `Docs` (or `Wiki`, …), so the title is read from the document data the server inlines (`window.SERVER_DATA.meta.title`) instead.

## Development

```bash
pnpm dev:auto-link-title-enhanced      # watch + symlink into the local vault
pnpm build:auto-link-title-enhanced    # type-check + production build
```

Licensed MIT (see `LICENSE`), original © Matt Furden.
