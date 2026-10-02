import { type App, FileSystemAdapter, Notice, Platform, type TFile } from "obsidian";

/**
 * "Open in default browser" for a file in the file explorer. Obsidian's own "Open in default
 * app" hands the file to whatever app its type is associated with — an editor for HTML, Obsidian
 * itself for Markdown — so this is the one way to see a file the way a browser renders it.
 *
 * macOS only: the default browser is read from LaunchServices and the file is opened with
 * `open -b`, neither of which exists elsewhere.
 */

/** What macOS falls back to when no browser has been chosen. */
const SAFARI = "com.apple.Safari";

function nodeRequire<T>(id: string): T {
	return (window as unknown as { require: (id: string) => T }).require(id);
}

export function openInBrowserSupported(): boolean {
	return Platform.isDesktopApp && Platform.isMacOS;
}

export async function openInDefaultBrowser(app: App, file: TFile): Promise<void> {
	const adapter = app.vault.adapter;
	if (!(adapter instanceof FileSystemAdapter)) return;
	try {
		await run("open", ["-b", await defaultBrowser(), adapter.getFullPath(file.path)]);
	} catch (error) {
		console.error("File Explorer (Enhanced): could not open in the default browser", error);
		new Notice(`Couldn't open ${file.name} in the default browser.`);
	}
}

/**
 * The default browser's bundle id: the app LaunchServices hands https links to (then http).
 * Read on every use rather than cached, so changing the default takes effect at once — it's
 * one short-lived `plutil`. Converted to XML rather than JSON: JSON can't hold some of the
 * plist's value types, and `plutil` refuses the whole file over them.
 */
async function defaultBrowser(): Promise<string> {
	const { homedir } = nodeRequire<typeof import("os")>("os");
	const plist = `${homedir()}/Library/Preferences/com.apple.LaunchServices/com.apple.launchservices.secure.plist`;
	try {
		const xml = await run("plutil", ["-convert", "xml1", "-o", "-", plist]);
		const doc = new DOMParser().parseFromString(xml, "application/xml");
		const handlers = Array.from(doc.querySelectorAll("dict")).map(stringsOf);
		for (const scheme of ["https", "http"]) {
			const handler = handlers.find((h) => h.LSHandlerURLScheme?.toLowerCase() === scheme);
			const bundleId = handler?.LSHandlerRoleAll;
			if (bundleId && bundleId !== "-") return bundleId;
		}
	} catch (error) {
		console.warn("File Explorer (Enhanced): couldn't read the default browser, using Safari", error);
	}
	return SAFARI;
}

/** A plist `<dict>`'s string entries. Its children alternate `<key>` and value. */
function stringsOf(dict: Element): Record<string, string | undefined> {
	const entries: Record<string, string | undefined> = {};
	const children = Array.from(dict.children);
	for (let i = 0; i + 1 < children.length; i += 2) {
		const key = children[i];
		const value = children[i + 1];
		if (key?.tagName === "key" && value?.tagName === "string") {
			entries[key.textContent ?? ""] = value.textContent ?? "";
		}
	}
	return entries;
}

function run(cmd: string, args: string[]): Promise<string> {
	const { execFile } = nodeRequire<typeof import("child_process")>("child_process");
	return new Promise((resolve, reject) => {
		execFile(cmd, args, { timeout: 10_000 }, (error, stdout) => {
			if (error) reject(error);
			else resolve(stdout);
		});
	});
}
