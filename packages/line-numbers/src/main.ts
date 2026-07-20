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
		document.body.classList.remove("line-numbers-overlay");
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

		// The overlay layout is pure CSS, gated by a body class so it only
		// applies when both the plugin and the option are on.
		document.body.classList.toggle(
			"line-numbers-overlay",
			this.settings.enabled && this.settings.overlay
		);
	}

	async loadSettings() {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			await this.loadData()
		);
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}
