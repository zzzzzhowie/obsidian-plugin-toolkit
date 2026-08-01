import { type App, PluginSettingTab, Setting } from "obsidian";

import type StickyFindPlugin from "./main";

export interface StickyFindSettings {
	/** Intercept the platform find shortcut before the built-in editor search sees it. */
	takeOverFind: boolean;
	/** Remembered state of the Aa toggle. */
	matchCase: boolean;
}

export const DEFAULT_SETTINGS: StickyFindSettings = {
	takeOverFind: true,
	matchCase: false,
};

export class StickyFindSettingTab extends PluginSettingTab {
	private readonly plugin: StickyFindPlugin;

	constructor(app: App, plugin: StickyFindPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName("Take over the find shortcut")
			.setDesc(
				"Handle Cmd/Ctrl+F in Markdown editors instead of the built-in find. Turn this off to keep the built-in behaviour and use the command palette entry instead.",
			)
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.takeOverFind).onChange(async (value) => {
					this.plugin.settings.takeOverFind = value;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName("Match case")
			.setDesc("Whether the find bar opens with case matching already switched on.")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.matchCase).onChange(async (value) => {
					this.plugin.settings.matchCase = value;
					await this.plugin.saveSettings();
				}),
			);
	}
}
