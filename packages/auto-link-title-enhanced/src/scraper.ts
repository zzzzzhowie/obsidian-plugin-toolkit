import { requestUrl } from "obsidian";

// Cap the scraper request so an unreachable host can't hang the paste forever.
const SCRAPE_TIMEOUT_MS = 15000;

function blank(text: string | null | undefined): boolean {
  return text === undefined || text === null || text === "";
}

async function scrape(
  url: string,
  headers?: Record<string, string>
): Promise<string> {
  try {
    const hasHeaders = headers != null && Object.keys(headers).length > 0;
    // Bound the request — requestUrl has no timeout of its own, so an
    // unreachable host would otherwise hang the paste forever. Losing the race
    // resolves null (via .catch on the request) rather than throwing.
    const request = (
      hasHeaders ? requestUrl({ url, headers }) : requestUrl(url)
    ).then(
      (r) => r,
      () => null
    );
    const response = await Promise.race([
      request,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), SCRAPE_TIMEOUT_MS)),
    ]);
    if (response === null) return "";

    const contentType = response.headers["content-type"] ?? "";
    if (!contentType.includes("text/html")) return getUrlFinalSegment(url);
    const html = response.text;

    const larkTitle = larkDocTitle(url, html);
    if (larkTitle) return larkTitle;

    const doc = new DOMParser().parseFromString(html, "text/html");
    const title = doc.querySelector("title");

    if (title === null || blank(title.innerText)) {
      // If site is javascript based and has a no-title attribute when unloaded, use it.
      const noTitle = title?.getAttr("no-title");
      if (noTitle) return noTitle;

      // Otherwise if the site has no title / requires javascript, return the url.
      return url;
    }

    return title.innerText;
  } catch (ex) {
    console.error(ex);
    return "";
  }
}

/** Lark / Feishu hosts: docs, wiki, sheets, base… on any tenant subdomain. */
const LARK_HOST = /(^|\.)(larkoffice\.com|feishu\.cn|larksuite\.com|feishu-pre\.cn)$/i;
/**
 * `meta: {"title": "…"` inside the page's inline data — `window.SERVER_DATA = Object({"meta":
 * {"title":…` and `window.DATA = { …, meta: Object({"title":…`. Captures the raw JSON string.
 */
const LARK_META_TITLE = /\bmeta"?\s*:\s*(?:Object\()?\{\s*"title"\s*:\s*"((?:[^"\\]|\\.)*)"/;

/**
 * The document's own title for a Lark / Feishu page. Their HTML always says
 * `<title>Docs</title>` (or Wiki, Sheets…) — the real title is only filled in by
 * JavaScript, from the data the server inlines into the page. Read it from there.
 * Empty for any other site, or when the page carries no such data (e.g. the login
 * page a request without a session ends up on).
 */
export function larkDocTitle(url: string, html: string): string {
  try {
    if (!LARK_HOST.test(new URL(url).hostname)) return "";
  } catch {
    return "";
  }
  const match = LARK_META_TITLE.exec(html);
  if (!match) return "";
  try {
    return (JSON.parse(`"${match[1]}"`) as string).trim();
  } catch {
    return "";
  }
}

function getUrlFinalSegment(url: string): string {
  try {
    const segments = new URL(url).pathname.split("/");
    const last = segments.pop() || segments.pop(); // Handle potential trailing slash
    return last || "File";
  } catch (_) {
    return "File";
  }
}

export interface PageContext {
  /** The page's own <title> (or og:title). */
  title: string;
  /** meta description / og:description, trimmed. */
  description: string;
  /** A trimmed excerpt of the page's visible text. */
  text: string;
}

/**
 * Fetch a page and pull out the signals an LLM needs to write a relevant title:
 * its real title, description, and a text excerpt. Returns null on fetch
 * failure, timeout, or non-HTML content. Uses the same headers (Chrome's cookies)
 * and timeout as the scraper.
 */
export async function fetchPageContext(
  url: string,
  headers?: Record<string, string>
): Promise<PageContext | null> {
  if (!(url.startsWith("http") || url.startsWith("https"))) {
    url = "https://" + url;
  }
  try {
    const hasHeaders = headers != null && Object.keys(headers).length > 0;
    const request = (
      hasHeaders ? requestUrl({ url, headers }) : requestUrl(url)
    ).then(
      (r) => r,
      () => null
    );
    const response = await Promise.race([
      request,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), SCRAPE_TIMEOUT_MS)),
    ]);
    if (response === null) return null;

    const contentType = response.headers["content-type"] ?? "";
    if (!contentType.includes("text/html")) return null;

    const larkTitle = larkDocTitle(url, response.text);
    const doc = new DOMParser().parseFromString(response.text, "text/html");
    doc.querySelectorAll("script, style, noscript").forEach((el) => el.remove());

    const meta = (selector: string): string =>
      doc.querySelector(selector)?.getAttribute("content")?.trim() || "";

    const title =
      larkTitle ||
      meta('meta[property="og:title"]') ||
      doc.querySelector("title")?.textContent?.trim() ||
      "";
    const description = (
      meta('meta[property="og:description"]') || meta('meta[name="description"]')
    ).slice(0, 500);
    const text = (doc.body?.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 1500);

    return { title, description, text };
  } catch (ex) {
    console.error(ex);
    return null;
  }
}

export default async function getPageTitle(
  url: string,
  headers?: Record<string, string>
): Promise<string> {
  if (!(url.startsWith("http") || url.startsWith("https"))) {
    url = "https://" + url;
  }

  return scrape(url, headers);
}
