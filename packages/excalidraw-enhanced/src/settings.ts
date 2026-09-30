import { App, PluginSettingTab, Setting } from "obsidian";
import ExcalidrawEnhancedPlugin from "./main";

export interface ExcalidrawEnhancedSettings {
	/**
	 * How wide a drawing renders, in px. An explicit length on purpose — the embedded
	 * SVG has no intrinsic size, so this is what decides how big it lands; see styles.css.
	 * A narrower note still shrinks it.
	 */
	widthPx: number;
}

export const DEFAULT_SETTINGS: ExcalidrawEnhancedSettings = {
	widthPx: 900,
};

export class ExcalidrawEnhancedSettingTab extends PluginSettingTab {
	plugin: ExcalidrawEnhancedPlugin;

	constructor(app: App, plugin: ExcalidrawEnhancedPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName("Drawing width")
			.setDesc(
				"How wide a drawing renders, in pixels. Without this the browser falls " +
					"back to 305px whatever the drawing's real size. A narrower note still " +
					"shrinks it, and the height follows the drawing's aspect ratio.",
			)
			.addSlider((slider) =>
				slider
					.setLimits(300, 1600, 50)
					.setValue(this.plugin.settings.widthPx)
					.setDynamicTooltip()
					.onChange(async (value) => {
						this.plugin.settings.widthPx = value;
						await this.plugin.saveSettings();
						this.plugin.applySizing();
					}),
			);
	}
}
