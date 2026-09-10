import { App, PluginSettingTab, Setting } from "obsidian";
import NavHistoryPlugin from "./main";

export interface NavHistorySettings {
	/**
	 * How far the cursor has to move inside one file before that counts as a
	 * "jump" worth remembering. VS Code uses 10 lines; anything smaller is
	 * treated as ordinary editing and only updates the current location in
	 * place, so arrow keys never flood the stack.
	 */
	jumpThreshold: number;
	/** Hard cap on the back stack, oldest entries dropped first. */
	maxEntries: number;
	/**
	 * Go back into the tab the location was recorded in (VS Code returns to the
	 * original editor group). When off, everything is replayed in the tab that
	 * is active right now.
	 */
	reuseOriginalTab: boolean;
}

export const DEFAULT_SETTINGS: NavHistorySettings = {
	jumpThreshold: 10,
	maxEntries: 50,
	reuseOriginalTab: true,
};

export class NavHistorySettingTab extends PluginSettingTab {
	plugin: NavHistoryPlugin;

	constructor(app: App, plugin: NavHistoryPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName("Same-file jump threshold")
			.setDesc(
				"Lines the cursor must move within one file for it to count as a " +
					"jump and get its own history entry. Smaller moves (typing, " +
					"arrow keys) just update the current entry."
			)
			.addSlider((slider) =>
				slider
					.setLimits(1, 50, 1)
					.setValue(this.plugin.settings.jumpThreshold)
					.onChange(async (value) => {
						this.plugin.settings.jumpThreshold = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("History size")
			.setDesc("Maximum number of locations kept. Oldest are dropped first.")
			.addSlider((slider) =>
				slider
					.setLimits(10, 200, 10)
					.setValue(this.plugin.settings.maxEntries)
					.onChange(async (value) => {
						this.plugin.settings.maxEntries = value;
						this.plugin.trimHistory();
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Return to the original tab")
			.setDesc(
				"Replay each location in the tab it was recorded in, like VS Code " +
					"returning to the original editor group. Turn off to always " +
					"navigate inside the currently active tab."
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.reuseOriginalTab)
					.onChange(async (value) => {
						this.plugin.settings.reuseOriginalTab = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Clear history")
			.setDesc("Drop every recorded location and start over from the current file.")
			.addButton((button) =>
				button.setButtonText("Clear").onClick(() => {
					this.plugin.clearHistory();
				})
			);
	}
}
