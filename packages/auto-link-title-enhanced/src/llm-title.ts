import { Platform } from "obsidian";
import type { PageContext } from "./scraper";

export interface LlmTitleOptions {
  /** OpenAI-compatible base URL, e.g. https://api.openai.com/v1 */
  baseUrl: string;
  apiKey: string;
  model: string;
}

// Kill + fall back if the request takes too long. These small models answer in
// well under a second; this is only a safety net against a hung request.
const TIMEOUT_MS = 15000;

export function isLlmConfigured(opts: LlmTitleOptions): boolean {
  return Boolean(opts.baseUrl && opts.apiKey && opts.model);
}

interface LlmResult {
  title: string;
  /** Present on failure — a human-readable reason for the Test button / logs. */
  error?: string;
}

function errMessage(ex: unknown): string {
  return ex instanceof Error ? ex.message : String(ex);
}

interface HttpResult {
  status: number;
  text: string;
}

/**
 * POST via Node's http(s) module (desktop only). This uses OS sockets + the
 * system resolver — exactly like `curl`/`openssl` — so it bypasses Chromium's
 * network stack, which is where proxy/DNS interception (bad certs, hung
 * connections) tends to happen inside Electron apps. Not visible in the
 * DevTools Network tab (it isn't a Chromium request); logged to console instead.
 */
function postViaNode(
  endpoint: string,
  headers: Record<string, string>,
  body: string,
  timeoutMs: number
): Promise<HttpResult> {
  const u = new URL(endpoint);
  const lib = u.protocol === "http:" ? require("http") : require("https");
  return new Promise<HttpResult>((resolve, reject) => {
    const req = lib.request(
      {
        hostname: u.hostname,
        port: u.port || (u.protocol === "http:" ? 80 : 443),
        path: `${u.pathname}${u.search}`,
        method: "POST",
        headers: { ...headers, "Content-Length": Buffer.byteLength(body) },
        timeout: timeoutMs,
      },
      (res: any) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => (data += chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, text: data }));
      }
    );
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", (err: Error) => reject(err));
    req.write(body);
    req.end();
  });
}

/** POST via the renderer's fetch (mobile / fallback). Subject to CORS + Chromium routing. */
async function postViaFetch(
  endpoint: string,
  headers: Record<string, string>,
  body: string,
  timeoutMs: number
): Promise<HttpResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(endpoint, { method: "POST", headers, body, signal: controller.signal });
    const text = await res.text().catch(() => "");
    return { status: res.status, text };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * One request to an OpenAI-compatible chat-completions endpoint. Always resolves
 * (never throws) with either a title or an `error` string, so the Test button
 * and the paste-fallback can both react. Body is minimal (`model` + `messages`)
 * for cross-provider compatibility — `max_tokens` vs `max_completion_tokens` and
 * `temperature` support vary, and the prompt already limits output to one line.
 */
async function callLlm(
  url: string,
  page: PageContext,
  opts: LlmTitleOptions
): Promise<LlmResult> {
  const endpoint = `${opts.baseUrl.replace(/\/+$/, "")}/chat/completions`;
  const transport = Platform.isDesktopApp ? "node-https" : "fetch";
  console.log(`auto-link-title: LLM POST ${endpoint} (model=${opts.model}, via=${transport})`);
  const prompt =
    "You are titling a saved web link for someone's notes. Using the page's own " +
    "metadata and content excerpt below, write ONE concise, human-readable title " +
    "that reflects what the page is actually about. Prefer the page's real title " +
    "but clean it up — drop site-name suffixes, separators, and marketing " +
    "boilerplate. Reply with ONLY the title on a single line — no quotes, no " +
    "markdown, no commentary.\n\n" +
    `URL: ${url}\n` +
    `Page title: ${page.title || "(none)"}\n` +
    `Description: ${page.description || "(none)"}\n` +
    `Excerpt: ${page.text || "(none)"}`;

  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${opts.apiKey}`,
  };
  const body = JSON.stringify({
    model: opts.model,
    messages: [{ role: "user", content: prompt }],
  });

  try {
    const { status, text } = Platform.isDesktopApp
      ? await postViaNode(endpoint, headers, body, TIMEOUT_MS)
      : await postViaFetch(endpoint, headers, body, TIMEOUT_MS);

    if (status < 200 || status >= 300) {
      return { title: "", error: `HTTP ${status}${text ? `: ${text.slice(0, 300)}` : ""}` };
    }

    let data: any;
    try {
      data = JSON.parse(text);
    } catch {
      return { title: "", error: "Response body was not JSON" };
    }

    const content = data?.choices?.[0]?.message?.content;
    if (typeof content !== "string" || content.trim() === "") {
      return { title: "", error: "No title in response (empty choices/content)" };
    }
    return { title: cleanTitle(content) };
  } catch (ex) {
    const name = (ex as { name?: string })?.name;
    const message = errMessage(ex);
    const timedOut = name === "AbortError" || message === "timeout";
    return {
      title: "",
      error: timedOut ? `Timed out after ${TIMEOUT_MS / 1000}s` : `Request failed: ${message}`,
    };
  }
}

/** Main path: returns the title, or "" (logging the reason) so the caller falls back. */
export async function getTitleViaLlm(
  url: string,
  page: PageContext,
  opts: LlmTitleOptions
): Promise<string> {
  if (!isLlmConfigured(opts)) return "";
  const { title, error } = await callLlm(url, page, opts);
  if (error) console.warn(`auto-link-title: LLM — ${error}`);
  return title;
}

/** Settings "Test" button: run against a sample URL and report success/failure. */
export async function testLlm(
  opts: LlmTitleOptions
): Promise<{ ok: boolean; message: string }> {
  if (!isLlmConfigured(opts)) {
    const missing = [
      !opts.baseUrl && "base URL",
      !opts.apiKey && "API key",
      !opts.model && "model",
    ]
      .filter(Boolean)
      .join(", ");
    return { ok: false, message: `Not configured — missing: ${missing}` };
  }
  // Synthetic page context so the Test checks the API/key/model path only,
  // independent of whether the sample page can be fetched.
  const sampleContext: PageContext = {
    title: "GitHub - anthropics/claude-code: Claude Code",
    description: "Claude Code is an agentic coding tool that lives in your terminal.",
    text: "",
  };
  const result = await callLlm(
    "https://github.com/anthropics/claude-code",
    sampleContext,
    opts
  );
  console.log("auto-link-title: LLM test result", result);
  return result.error
    ? { ok: false, message: result.error }
    : { ok: true, message: `→ "${result.title}"` };
}

// Take the first non-empty line and strip any wrapping quotes/backticks.
function cleanTitle(raw: string): string {
  const line = raw
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!line) return "";
  return line.replace(/^["'`]+|["'`]+$/g, "").trim();
}
