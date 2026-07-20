import { App, PluginSettingTab, Setting } from "obsidian";
import LineNumbersPlugin from "./main";

export interface LineNumbersSettings {
	/** Master on/off switch. When off, the gutter is removed entirely. */
	enabled: boolean;
	/** Highlight the caret's line in the gutter. */
	highlightActiveLine: boolean;
	/**
	 * "Peek" mode: keep the numbers hidden and reveal them only while the
	 * modifier key (⌘ on macOS, Ctrl elsewhere) is held down.
	 */
	revealOnModifier: boolean;
}

export const DEFAULT_SETTINGS: LineNumbersSettings = {
	enabled: true,
	highlightActiveLine: true,
	revealOnModifier: false,
};

export class LineNumbersSettingTab extends PluginSettingTab {
	plugin: LineNumbersPlugin;

	constructor(app: App, plugin: LineNumbersPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName("Enable line numbers")
			.setDesc(
				"Show a line-number gutter for the whole document in Source and " +
					"Live Preview. Tip: turn off the core “Show line number” " +
					"setting to avoid a duplicate gutter."
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.enabled)
					.onChange(async (value) => {
						this.plugin.settings.enabled = value;
						await this.plugin.saveSettings();
						this.plugin.refreshExtensions();
					})
			);

		new Setting(containerEl)
			.setName("Highlight active line")
			.setDesc("Emphasize the caret's line number in the gutter.")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.highlightActiveLine)
					.onChange(async (value) => {
						this.plugin.settings.highlightActiveLine = value;
						await this.plugin.saveSettings();
						this.plugin.refreshExtensions();
					})
			);

		new Setting(containerEl)
			.setName("Reveal only while holding ⌘ / Ctrl")
			.setDesc(
				"Peek mode: keep the numbers hidden and show them only while the " +
					"modifier key is held down."
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.revealOnModifier)
					.onChange(async (value) => {
						this.plugin.settings.revealOnModifier = value;
						await this.plugin.saveSettings();
						this.plugin.refreshExtensions();
					})
			);
	}
}
