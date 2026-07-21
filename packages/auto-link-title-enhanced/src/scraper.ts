import { requestUrl } from "obsidian";

// Cap the scraper request so an unreachable host can't hang the paste forever.
const SCRAPE_TIMEOUT_MS = 15000;

function blank(text: string | null | undefined): boolean {
  return text === undefined || text === null || text === "";
}

function notBlank(text: string | null | undefined): boolean {
  return !blank(text);
}

export interface HeaderRule {
  /**
   * Domain / URL matcher. `*` is a wildcard for any run of characters; every
   * other character is literal. Matched unanchored, so a bare `corp.com` behaves
   * like "contains". Empty matches every URL.
   */
  pattern: string;
  /** This rule's headers, one per line: `Name: value`. */
  headers: string;
}

/** Parse a rule's headers text into name/value pairs (value = everything after the first ":"). */
function parseHeaderLines(raw: string): { name: string; value: string }[] {
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"))
    .flatMap((line) => {
      const sep = line.indexOf(":");
      if (sep === -1) return [];
      const name = line.slice(0, sep).trim();
      const value = line.slice(sep + 1).trim();
      if (blank(name)) return [];
      return [{ name, value }];
    });
}

/** Compile a wildcard pattern (`*` = any run of chars, everything else literal) to a RegExp. */
function wildcardToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const withWildcard = escaped.replace(/\\\*/g, ".*");
  return new RegExp(withWildcard);
}

/** Whether a rule applies to `url`. Empty pattern matches all; matched unanchored. */
function ruleMatches(rule: HeaderRule, url: string): boolean {
  const pattern = rule.pattern.trim();
  if (pattern === "") return true;
  return wildcardToRegExp(pattern).test(url);
}

/**
 * Resolve the headers that apply to `url`. Rules are applied in order, so a
 * later rule overrides an earlier one for the same header name.
 */
export function resolveHeaders(
  url: string,
  rules: HeaderRule[]
): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const rule of rules ?? []) {
    if (!ruleMatches(rule, url)) continue;
    for (const { name, value } of parseHeaderLines(rule.headers)) {
      headers[name] = value;
    }
  }
  return headers;
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
 * failure, timeout, or non-HTML content. Uses the same header rules + timeout as
 * the scraper.
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

    const doc = new DOMParser().parseFromString(response.text, "text/html");
    doc.querySelectorAll("script, style, noscript").forEach((el) => el.remove());

    const meta = (selector: string): string =>
      doc.querySelector(selector)?.getAttribute("content")?.trim() || "";

    const title =
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
