import { App, PluginSettingTab, Setting } from "obsidian";
import LineNumbersPlugin from "./main";

export interface LineNumbersSettings {
	/**
	 * Master on/off switch, flipped by the "Toggle line numbers" command — there is no
	 * settings row for it, since disabling the plugin does the same. When off, the
	 * gutter is removed entirely.
	 */
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
