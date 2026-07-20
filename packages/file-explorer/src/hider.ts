import { App } from "obsidian";
import type MyPlugin from "./main";

/**
 * Hides specific files/folders from the file explorer by injecting a <style>
 * element with `display: none` rules keyed off the `data-path` attribute that
 * Obsidian puts on every nav node.
 *
 * Using CSS (rather than removing DOM nodes) means items stay hidden even
 * inside collapsed folders that haven't been rendered yet, and toggling
 * visibility is a single textContent swap.
 */
export class FileHiderManager {
	app: App;
	plugin: MyPlugin;
	private styleEl: HTMLStyleElement | null = null;

	constructor(app: App, plugin: MyPlugin) {
		this.app = app;
		this.plugin = plugin;
	}

	initialize() {
		this.styleEl = document.createElement("style");
		this.styleEl.id = "file-explorer-hider-styles";
		document.head.appendChild(this.styleEl);
		this.refreshStyles();
	}

	cleanup() {
		if (this.styleEl) {
			this.styleEl.remove();
			this.styleEl = null;
		}
	}

	/**
	 * Rebuild the CSS rules that hide file-explorer nodes.
	 *
	 * Exact paths use `[data-path="..."]`.
	 * Wildcard patterns use `[data-path$="/name"]` (ends-with) plus an exact
	 * match for top-level items — matching the name at any nesting depth.
	 *
	 * When `settings.hideFiles` is false (items revealed), we emit no rules.
	 */
	refreshStyles(): void {
		if (!this.styleEl) return;

		const { hideFiles, hiddenPaths, hiddenPatterns } = this.plugin.settings;

		if (!hideFiles || (hiddenPaths.length === 0 && hiddenPatterns.length === 0)) {
			this.styleEl.textContent = "";
			return;
		}

		const rules: string[] = [];

		// Exact path rules
		for (const p of hiddenPaths) {
			const escaped = CSS.escape(p);
			rules.push(
				`.nav-file:has(> .nav-file-title[data-path="${escaped}"]) { display: none !important; }`,
				`.nav-folder:has(> .nav-folder-title[data-path="${escaped}"]) { display: none !important; }`,
			);
		}

		// Wildcard pattern rules.
		// Pattern "attachments" or "**/attachments" both hide anything whose
		// path equals "attachments" OR ends with "/attachments" (any depth).
		for (const rawPattern of hiddenPatterns) {
			const name = rawPattern.startsWith("**/") ? rawPattern.slice(3) : rawPattern;
			const escaped = CSS.escape(name);
			const suffix = CSS.escape(`/${name}`);
			rules.push(
				// Top-level exact match
				`.nav-file:has(> .nav-file-title[data-path="${escaped}"]) { display: none !important; }`,
				`.nav-folder:has(> .nav-folder-title[data-path="${escaped}"]) { display: none !important; }`,
				// Nested match (ends with "/name")
				`.nav-file:has(> .nav-file-title[data-path$="${suffix}"]) { display: none !important; }`,
				`.nav-folder:has(> .nav-folder-title[data-path$="${suffix}"]) { display: none !important; }`,
			);
		}

		this.styleEl.textContent = rules.join("\n");
	}

	isHidden(path: string): boolean {
		return this.plugin.settings.hiddenPaths.includes(path);
	}

	/** Add a path to the hidden list */
	async hidePath(path: string): Promise<void> {
		if (this.plugin.settings.hiddenPaths.includes(path)) return;
		this.plugin.settings.hiddenPaths.push(path);
		await this.plugin.saveSettings();
		this.refreshStyles();
	}

	/** Remove a path from the hidden list */
	async unhidePath(path: string): Promise<void> {
		this.plugin.settings.hiddenPaths = this.plugin.settings.hiddenPaths.filter(
			(p) => p !== path,
		);
		await this.plugin.saveSettings();
		this.refreshStyles();
	}

	/** Add a wildcard pattern */
	async addPattern(pattern: string): Promise<void> {
		if (this.plugin.settings.hiddenPatterns.includes(pattern)) return;
		this.plugin.settings.hiddenPatterns.push(pattern);
		await this.plugin.saveSettings();
		this.refreshStyles();
	}

	/** Remove a wildcard pattern */
	async removePattern(pattern: string): Promise<void> {
		this.plugin.settings.hiddenPatterns = this.plugin.settings.hiddenPatterns.filter(
			(p) => p !== pattern,
		);
		await this.plugin.saveSettings();
		this.refreshStyles();
	}
}
