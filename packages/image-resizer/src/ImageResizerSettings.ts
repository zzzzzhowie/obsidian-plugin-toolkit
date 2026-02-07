import { App, PluginSettingTab, Setting, Notice } from "obsidian";
import ImageResizerPlugin from "./main";
import { NonDestructiveResizeSettings } from "./NonDestructiveResizeSettings";

export interface ImageResizerSettings {
	isImageResizeEnbaled: boolean;
	resizeSensitivity: number;
	scrollwheelModifier: "None" | "Shift" | "Control" | "Alt" | "Meta";
	nonDestructiveResizeSettings: NonDestructiveResizeSettings;
}

export const DEFAULT_SETTINGS: ImageResizerSettings = {
	isImageResizeEnbaled: true,
	resizeSensitivity: 0.1,
	scrollwheelModifier: "Shift",
	nonDestructiveResizeSettings: new NonDestructiveResizeSettings(),
};

export class ImageResizerSettingTab extends PluginSettingTab {
	plugin: ImageResizerPlugin;

	constructor(app: App, plugin: ImageResizerPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;

		containerEl.empty();
		containerEl.createEl("h2", { text: "Image Resizer Settings" });

		// Enable/Disable Image Resizing
		new Setting(containerEl)
			.setName("Enable image drag resize")
			.setDesc(
				"Allow resizing images by dragging edges or using scroll wheel.",
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.isImageResizeEnbaled)
					.onChange(async (value) => {
						this.plugin.settings.isImageResizeEnbaled = value;
						await this.plugin.saveSettings();
						if (!value) {
							new Notice(
								"Image resizing disabled. Reload Obsidian to see changes.",
								5000,
							);
						} else {
							new Notice(
								"Image resizing enabled. Reload Obsidian to see changes.",
								5000,
							);
						}
					}),
			);

		if (this.plugin.settings.isImageResizeEnbaled) {
			// Scroll-wheel resize modifier
			new Setting(containerEl)
				.setName("Scroll-wheel resize modifier")
				.setDesc("Hold this key while scrolling to resize images.")
				.addDropdown((dropdown) =>
					dropdown
						.addOption("None", "None")
						.addOption("Shift", "Shift")
						.addOption("Control", "Control")
						.addOption("Alt", "Alt")
						.addOption("Meta", "Meta (Cmd on Mac)")
						.setValue(this.plugin.settings.scrollwheelModifier)
						.onChange(
							async (
								value:
									| "None"
									| "Shift"
									| "Control"
									| "Alt"
									| "Meta",
							) => {
								this.plugin.settings.scrollwheelModifier =
									value;
								await this.plugin.saveSettings();
							},
						),
				);

			// Scroll-wheel resize sensitivity
			new Setting(containerEl)
				.setName("Scroll-wheel resize sensitivity")
				.setDesc("How sensitive the scroll-wheel resize is.")
				.addSlider((slider) =>
					slider
						.setLimits(0.01, 1, 0.01)
						.setValue(this.plugin.settings.resizeSensitivity)
						.setDynamicTooltip()
						.onChange(async (value) => {
							this.plugin.settings.resizeSensitivity = value;
							await this.plugin.saveSettings();
						}),
				);
		}
	}
}
