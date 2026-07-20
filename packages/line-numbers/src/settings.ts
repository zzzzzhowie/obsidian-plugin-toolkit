import { App, PluginSettingTab, Setting } from "obsidian";
import LineNumbersPlugin from "./main";

export interface LineNumbersSettings {
	/** Master on/off switch. When off, the gutter is removed entirely. */
	enabled: boolean;
	/** Highlight the caret's line in the gutter. */
	highlightActiveLine: boolean;
	/**
	 * Float the gutter in the editor's left margin instead of reserving layout
	 * width for it, so the text column isn't pushed inward.
	 */
	overlay: boolean;
}

export const DEFAULT_SETTINGS: LineNumbersSettings = {
	enabled: true,
	highlightActiveLine: true,
	overlay: false,
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
			.setName("Float in left margin")
			.setDesc(
				"Overlay the numbers in the editor's left margin instead of " +
					"reserving a column for them, so the text isn't pushed inward. " +
					"Works best with “Readable line length” on."
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.overlay)
					.onChange(async (value) => {
						this.plugin.settings.overlay = value;
						await this.plugin.saveSettings();
						this.plugin.refreshExtensions();
					})
			);
	}
}
