import { App, PluginSettingTab, Setting } from "obsidian";
import ExcalidrawEnhancedPlugin from "./main";
import type { FenceOpenIn } from "./fence-drawing";

export interface ExcalidrawEnhancedSettings {
	/**
	 * How wide a drawing renders, in px. An explicit length on purpose — the embedded
	 * SVG has no intrinsic size, so this is what decides how big it lands; see styles.css.
	 * A narrower note still shrinks it.
	 */
	widthPx: number;
	/** Typing ```excalidraw replaces the empty block with a new drawing, embedded there. */
	fenceCreatesDrawing: boolean;
	/** Where that drawing opens to be drawn in. */
	fenceOpenIn: FenceOpenIn;
}

export const DEFAULT_SETTINGS: ExcalidrawEnhancedSettings = {
	widthPx: 900,
	fenceCreatesDrawing: true,
	fenceOpenIn: "adjacent",
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

		new Setting(containerEl)
			.setName("Typing ```excalidraw makes a drawing")
			.setDesc(
				"An empty ```excalidraw block is replaced by a new drawing embedded where it stood " +
					"(named and foldered as Excalidraw's settings say) and opened to draw in.",
			)
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.fenceCreatesDrawing).onChange(async (value) => {
					this.plugin.settings.fenceCreatesDrawing = value;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName("Open the new drawing")
			.addDropdown((dropdown) =>
				dropdown
					.addOptions({ adjacent: "Beside the note", tab: "In a new tab", popout: "In a new window" })
					.setValue(this.plugin.settings.fenceOpenIn)
					.onChange(async (value) => {
						this.plugin.settings.fenceOpenIn = value as FenceOpenIn;
						await this.plugin.saveSettings();
					}),
			);
	}
}
