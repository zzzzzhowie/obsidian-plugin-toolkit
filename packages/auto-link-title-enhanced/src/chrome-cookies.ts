import { Platform } from "obsidian";

/**
 * Login cookies for a link, read straight from the local Chrome profile.
 *
 * An intranet page only returns its real title to a logged-in request. A Cookie
 * header pasted into settings works until the session rotates, and meanwhile sits in
 * plain text in data.json, which syncs and gets backed up with the vault. Instead,
 * send whatever Chrome currently holds for the link — exactly the
 * cookies Chrome itself would send if you opened it, so nothing goes to a host it
 * wouldn't — and keep them in memory for that one request. Chrome keeps the session
 * fresh as you browse; nothing here is ever written to disk.
 *
 * macOS desktop only. Chrome there encrypts each value with AES-128-CBC under a key
 * derived from the "Chrome Safe Storage" keychain password; macOS asks before handing
 * that password over, so the first lookup after Obsidian starts shows a keychain
 * dialog. The derived key is then kept for the rest of the session.
 */

const CHROME_DIR = "Library/Application Support/Google/Chrome/Default";
// Chrome moved the database into Network/ a while ago; older profiles keep the old spot.
const COOKIE_DB_CANDIDATES = ["Network/Cookies", "Cookies"];
/** Microseconds between 1601-01-01 (Chrome's epoch) and 1970-01-01. */
const CHROME_EPOCH_OFFSET_US = 11644473600000000;
/** From this schema version on, a value's plaintext starts with SHA-256(host_key). */
const HOST_HASH_PREFIX_VERSION = 24;
/** The keychain dialog waits for the user; give them time to answer it. */
const KEYCHAIN_TIMEOUT_MS = 60000;
const SQLITE_TIMEOUT_MS = 10000;

/** Obsidian's desktop renderer has Node's `require`; each use below names the module's type. */
function nodeRequire<T>(id: string): T {
  return (window as unknown as { require: (id: string) => T }).require(id);
}

export function chromeCookiesSupported(): boolean {
  return Platform.isDesktopApp && Platform.isMacOS;
}

/**
 * Every `host_key` a cookie sent to `host` can carry: the host itself (a host-only
 * cookie) and `.suffix` for each parent domain down to two labels (domain cookies).
 */
function hostKeysFor(host: string): string[] {
  const labels = host.split(".");
  const keys = [host, `.${host}`];
  for (let i = 1; i < labels.length - 1; i++) keys.push(`.${labels.slice(i).join(".")}`);
  return keys;
}

/** RFC 6265 path-match. */
function pathMatches(requestPath: string, cookiePath: string): boolean {
  if (!cookiePath || cookiePath === "/") return true;
  if (requestPath === cookiePath) return true;
  if (!requestPath.startsWith(cookiePath)) return false;
  return cookiePath.endsWith("/") || requestPath[cookiePath.length] === "/";
}

function run(cmd: string, args: string[], timeoutMs: number): Promise<string> {
  const { execFile } = nodeRequire<typeof import("child_process")>("child_process");
  return new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout) =>
        error ? reject(new Error(error.message)) : resolve(String(stdout))
    );
  });
}

/** PBKDF2-SHA1 over the keychain password, Chrome's parameters. */
async function deriveKey(password: string): Promise<CryptoKey> {
  const encoder = new TextEncoder();
  const base = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, [
    "deriveKey",
  ]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: encoder.encode("saltysalt"), iterations: 1003, hash: "SHA-1" },
    base,
    { name: "AES-CBC", length: 128 },
    false,
    ["decrypt"]
  );
}

/**
 * The AES key, derived once per session from the keychain password. A refusal — the
 * dialog cancelled, or Chrome's entry missing — is kept too, so every paste doesn't
 * bring the dialog back; `retryChromeKey` asks again.
 */
let keyPromise: Promise<CryptoKey> | null = null;

function chromeKey(): Promise<CryptoKey> {
  keyPromise ??= run(
    "/usr/bin/security",
    ["find-generic-password", "-w", "-s", "Chrome Safe Storage"],
    KEYCHAIN_TIMEOUT_MS
  ).then((password) => deriveKey(password.trim()));
  return keyPromise;
}

/** Forget an earlier keychain refusal, so the next lookup asks macOS again. */
export function retryChromeKey(): void {
  keyPromise = null;
}

function cookieDbPath(): string | null {
  const fs = nodeRequire<typeof import("fs")>("fs");
  const path = nodeRequire<typeof import("path")>("path");
  const os = nodeRequire<typeof import("os")>("os");
  for (const candidate of COOKIE_DB_CANDIDATES) {
    const dbPath = path.join(os.homedir(), CHROME_DIR, candidate);
    if (fs.existsSync(dbPath)) return dbPath;
  }
  return null;
}

interface CookieRow {
  v: string;
  host_key: string;
  name: string;
  path: string;
  is_secure: number;
  expires_utc: number;
  ev: string;
  value: string;
}

/**
 * Read the rows for `host` with the sqlite3 that ships with macOS. `immutable=1` reads
 * the file as it is, without taking a lock — Chrome holds the database open while it
 * runs, and a read-only snapshot is all a title fetch needs.
 */
async function readRows(dbPath: string, host: string): Promise<CookieRow[]> {
  // Host keys are built from a parsed URL hostname, so they're [a-z0-9.-] only — safe to inline.
  const keys = hostKeysFor(host)
    .filter((key) => /^[a-z0-9.-]+$/.test(key))
    .map((key) => `'${key}'`)
    .join(",");
  const sql =
    "select (select value from meta where key='version') as v, host_key, name, path, " +
    "is_secure, expires_utc, hex(encrypted_value) as ev, value from cookies " +
    `where host_key in (${keys})`;
  const uri = `file:${encodeURI(dbPath)}?immutable=1`;
  const out = await run("/usr/bin/sqlite3", ["-json", uri, sql], SQLITE_TIMEOUT_MS);
  return out.trim() ? (JSON.parse(out) as CookieRow[]) : [];
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

/** "v10": the macOS scheme. Anything else (app-bound "v20", …) isn't ours to read. */
const V10 = [0x76, 0x31, 0x30];
/** Chrome's fixed IV: sixteen spaces. */
const IV = new Uint8Array(16).fill(0x20);

async function decrypt(row: CookieRow, key: CryptoKey): Promise<string | null> {
  if (!row.ev) return row.value;
  const bytes = hexToBytes(row.ev);
  if (!V10.every((byte, i) => bytes[i] === byte)) return null;
  const plain = new Uint8Array(
    await crypto.subtle.decrypt({ name: "AES-CBC", iv: IV }, key, bytes.slice(3))
  );
  const body = Number(row.v) >= HOST_HASH_PREFIX_VERSION ? plain.slice(32) : plain;
  return new TextDecoder().decode(body);
}

export interface ChromeCookies {
  /** Value for a `Cookie` request header. */
  header: string;
  /** How many cookies went into it. */
  count: number;
}

/**
 * The Cookie header Chrome would send to `url`, or null when it has nothing for it.
 * Throws when Chrome or the keychain can't be read, so the caller can say why.
 */
export async function chromeCookiesFor(url: string): Promise<ChromeCookies | null> {
  if (!chromeCookiesSupported()) return null;

  let parsed: URL;
  try {
    // Same default as the page fetch: a bare host means https.
    parsed = new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`);
  } catch {
    return null;
  }
  const host = parsed.hostname.toLowerCase();

  const dbPath = cookieDbPath();
  if (!dbPath) throw new Error("Chrome's cookie database wasn't found (Default profile).");

  const rows = await readRows(dbPath, host);
  if (rows.length === 0) return null;
  const key = await chromeKey();

  const nowUs = Date.now() * 1000 + CHROME_EPOCH_OFFSET_US;
  const secure = parsed.protocol === "https:";
  const sendable = rows
    .filter((row) => row.expires_utc === 0 || row.expires_utc > nowUs)
    .filter((row) => secure || !row.is_secure)
    .filter((row) => pathMatches(parsed.pathname, row.path))
    // Browsers list longer paths first; servers that read the first match expect it.
    .sort((a, b) => b.path.length - a.path.length);
  const values = await Promise.all(sendable.map((row) => decrypt(row, key)));
  const pairs = sendable.flatMap((row, i) => {
    const value = values[i];
    return value === null || value === undefined ? [] : [`${row.name}=${value}`];
  });

  if (pairs.length === 0) return null;
  return { header: pairs.join("; "), count: pairs.length };
}
