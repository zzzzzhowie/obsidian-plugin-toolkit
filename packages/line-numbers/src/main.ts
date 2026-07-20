import { Plugin } from "obsidian";
import { Extension } from "@codemirror/state";
import { highlightActiveLineGutter, lineNumbers } from "@codemirror/view";
import {
	DEFAULT_SETTINGS,
	LineNumbersSettings,
	LineNumbersSettingTab,
} from "./settings";

export default class LineNumbersPlugin extends Plugin {
	settings: LineNumbersSettings;

	/**
	 * A stable array reference handed to Obsidian once via
	 * `registerEditorExtension`. We mutate its contents and call
	 * `workspace.updateOptions()` to reconfigure every open editor without
	 * re-registering — the standard Obsidian pattern for dynamic CM6 extensions.
	 */
	private editorExtensions: Extension[] = [];

	async onload() {
		await this.loadSettings();
		this.addSettingTab(new LineNumbersSettingTab(this.app, this));

		this.registerEditorExtension(this.editorExtensions);
		this.refreshExtensions();

		// Peek mode: reveal numbers only while ⌘ (macOS) / Ctrl is held. The
		// handlers just toggle a body class; the base `line-numbers-peek` class
		// (set in refreshExtensions) gates whether it has any effect, so these
		// stay cheap no-ops when peek mode is off.
		this.registerDomEvent(document, "keydown", (e) => {
			if (e.key === "Meta" || e.key === "Control") this.setPeekActive(true);
		});
		this.registerDomEvent(document, "keyup", (e) => {
			if (e.key === "Meta" || e.key === "Control") this.setPeekActive(false);
		});
		// Releasing the modifier while the window is unfocused (e.g. ⌘+Tab)
		// never fires keyup here — reset on blur so numbers don't get stuck on.
		this.registerDomEvent(window, "blur", () => this.setPeekActive(false));

		this.addCommand({
			id: "toggle-line-numbers",
			name: "Toggle line numbers",
			callback: async () => {
				this.settings.enabled = !this.settings.enabled;
				await this.saveSettings();
				this.refreshExtensions();
			},
		});
	}

	onunload() {
		// Clearing the array + updateOptions removes the gutter from open editors.
		this.editorExtensions.length = 0;
		this.app.workspace.updateOptions();
		document.body.classList.remove(
			"line-numbers-overlay",
			"line-numbers-peek",
			"line-numbers-peek-active"
		);
	}

	/** Toggle the "numbers currently revealed" state (only meaningful in peek mode). */
	private setPeekActive(active: boolean): void {
		const peek = this.settings.enabled && this.settings.revealOnModifier;
		document.body.classList.toggle("line-numbers-peek-active", peek && active);
	}

	/** Rebuilds the editor extension from current settings and applies it live. */
	refreshExtensions(): void {
		this.editorExtensions.length = 0;
		if (this.settings.enabled) {
			this.editorExtensions.push(lineNumbers());
			if (this.settings.highlightActiveLine) {
				this.editorExtensions.push(highlightActiveLineGutter());
			}
		}
		this.app.workspace.updateOptions();

		// The overlay layout (numbers float in the left margin, gutter reserves
		// no width) is now the default whenever the plugin is enabled. Pure CSS,
		// gated by a body class.
		document.body.classList.toggle(
			"line-numbers-overlay",
			this.settings.enabled
		);

		// Peek mode is also pure CSS: `line-numbers-peek` hides the numbers, and
		// the key handlers add `line-numbers-peek-active` to reveal them.
		const peek = this.settings.enabled && this.settings.revealOnModifier;
		document.body.classList.toggle("line-numbers-peek", peek);
		if (!peek) document.body.classList.remove("line-numbers-peek-active");
	}

	async loadSettings() {
		// Only carry over known keys, so stale fields from older versions
		// (e.g. a removed `mode` option) get dropped on the next save.
		const saved = (await this.loadData()) ?? {};
		this.settings = {
			enabled: saved.enabled ?? DEFAULT_SETTINGS.enabled,
			highlightActiveLine:
				saved.highlightActiveLine ?? DEFAULT_SETTINGS.highlightActiveLine,
			revealOnModifier:
				saved.revealOnModifier ?? DEFAULT_SETTINGS.revealOnModifier,
		};
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}
