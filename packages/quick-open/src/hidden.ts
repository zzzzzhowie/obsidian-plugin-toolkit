import type { App } from "obsidian";

/**
 * Files hidden with File Explorer (Enhanced) — by path or pattern, from the file list. Go to
 * File finds them like any other file, and leaves them out at a switch of its own (the eye by
 * its input), kept on this device; the file list's own switch is left alone. Without that
 * plugin, nothing is hidden.
 */
export interface HiddenFiles {
	/** Whether a file is a hidden item or inside one. */
	isPathHidden(path: string): boolean;
}

const FILE_EXPLORER = "file-explorer-enhancements";
/** This device's switch: true once hidden files are to be left out. */
const LEAVE_OUT_KEY = "quick-open-leave-hidden-out";

/** The plugin's matcher, when it's on and has one. */
export function hiddenFiles(app: App): HiddenFiles | null {
	const plugins = (app as unknown as { plugins?: { getPlugin(id: string): unknown } }).plugins;
	const plugin = plugins?.getPlugin(FILE_EXPLORER) as Partial<HiddenFiles> | null | undefined;
	return plugin && typeof plugin.isPathHidden === "function" ? (plugin as HiddenFiles) : null;
}

/** Whether Go to File leaves hidden files out; it doesn't until told to. */
export function leavesHiddenOut(app: App): boolean {
	return app.loadLocalStorage(LEAVE_OUT_KEY) === true;
}

export function setLeavesHiddenOut(app: App, leaveOut: boolean): void {
	app.saveLocalStorage(LEAVE_OUT_KEY, leaveOut ? true : null);
}
