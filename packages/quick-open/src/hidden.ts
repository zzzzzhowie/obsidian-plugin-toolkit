import type { App } from "obsidian";

/**
 * Files hidden with File Explorer (Enhanced) — by path or pattern, from the file list. Go to
 * File leaves them out while that plugin's switch does (the eye by the vault's name), and its
 * own eye by the input is that same switch. Without that plugin, nothing is hidden.
 */
export interface HiddenFiles {
	/** Whether a file is a hidden item or inside one. */
	isPathHidden(path: string): boolean;
	/** Whether the hidden items are kept out of sight. */
	hidesFiles(): boolean;
	/** Show them, or hide them again. */
	toggleHiddenFiles(): void;
}

const FILE_EXPLORER = "file-explorer-enhancements";

/** The plugin's matcher and switch, when it's on and has them. */
export function hiddenFiles(app: App): HiddenFiles | null {
	const plugins = (app as unknown as { plugins?: { getPlugin(id: string): unknown } }).plugins;
	const plugin = plugins?.getPlugin(FILE_EXPLORER) as Partial<HiddenFiles> | null | undefined;
	const usable = plugin && typeof plugin.isPathHidden === "function" && typeof plugin.hidesFiles === "function" && typeof plugin.toggleHiddenFiles === "function";
	return usable ? (plugin as HiddenFiles) : null;
}

/** Whether Go to File leaves hidden files out: as the file list does. */
export function leavesHiddenOut(app: App): boolean {
	return hiddenFiles(app)?.hidesFiles() ?? false;
}
