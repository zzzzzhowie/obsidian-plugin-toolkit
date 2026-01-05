import {App, PluginSettingTab, Setting} from "obsidian";
import PasteEnhancedPlugin from "./main";

export interface PasteEnhancedSettings {
	enabled: boolean;
}

export const DEFAULT_SETTINGS: PasteEnhancedSettings = {
	enabled: true
}

export class PasteEnhancedSettingTab extends PluginSettingTab {
	plugin: PasteEnhancedPlugin;

	constructor(app: App, plugin: PasteEnhancedPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const {containerEl} = this;

		containerEl.empty();

		containerEl.createEl('h2', {text: 'Paste Enhanced Settings'});

		new Setting(containerEl)
			.setName('Enable enhanced paste')
			.setDesc('Enable or disable the enhanced paste functionality')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.enabled)
				.onChange(async (value) => {
					this.plugin.settings.enabled = value;
					await this.plugin.saveSettings();
				}));
	}
}
