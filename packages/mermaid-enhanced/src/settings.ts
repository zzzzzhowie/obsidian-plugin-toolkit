import { App, PluginSettingTab, Setting } from "obsidian";
import MermaidEnhancedPlugin from "./main";

export interface MermaidEnhancedSettings {
	/** Master on/off switch. When off, all applied constraints are removed. */
	enabled: boolean;
	/** Max diagram height as a percentage of the viewport height (e.g. 85 = 85vh). */
	maxHeightVh: number;
}

export const DEFAULT_SETTINGS: MermaidEnhancedSettings = {
	enabled: true,
	maxHeightVh: 85,
};

export class MermaidEnhancedSettingTab extends PluginSettingTab {
	plugin: MermaidEnhancedPlugin;

	constructor(app: App, plugin: MermaidEnhancedPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName("Fit tall diagrams to the screen")
			.setDesc(
				"Constrain tall Mermaid diagrams so they fit within one screen, with a " +
					"size slider on each diagram. Turning this off restores the theme's " +
					"sizing everywhere — `%% fit %%` lines are ignored and the sliders go " +
					"away; zoom and captions stay. To opt out a single diagram, use `%% fit: none %%`."
			)
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.enabled).onChange(async (value) => {
					this.plugin.settings.enabled = value;
					await this.plugin.saveSettings();
					this.plugin.processAll();
				})
			);

		new Setting(containerEl)
			.setName("Max height")
			.setDesc(
				"Maximum diagram height as a percentage of the window height. " +
					"Lower values make tall diagrams smaller."
			)
			.addSlider((slider) =>
				slider
					.setLimits(30, 100, 5)
					.setValue(this.plugin.settings.maxHeightVh)
					.setDynamicTooltip()
					.onChange(async (value) => {
						this.plugin.settings.maxHeightVh = value;
						await this.plugin.saveSettings();
						this.plugin.processAll();
					})
			);
	}
}
