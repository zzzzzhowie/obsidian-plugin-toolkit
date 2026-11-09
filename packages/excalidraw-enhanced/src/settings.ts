import { App, PluginSettingTab, Setting } from "obsidian";
import ExcalidrawEnhancedPlugin from "./main";
import type { FenceOpenIn } from "./fence-drawing";

export interface ExcalidrawEnhancedSettings {
	/** Typing ```excalidraw replaces the empty block with a new drawing, embedded there. */
	fenceCreatesDrawing: boolean;
	/** Where that drawing opens to be drawn in. */
	fenceOpenIn: FenceOpenIn;
	/** The right sidebar folds away while a drawing's tab is in front, and comes back after. */
	foldSidebarForDrawing: boolean;
}

export const DEFAULT_SETTINGS: ExcalidrawEnhancedSettings = {
	fenceCreatesDrawing: true,
	fenceOpenIn: "adjacent",
	foldSidebarForDrawing: true,
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
			.setName("Fold the sidebars while on a drawing")
			.setDesc(
				"A drawing takes the window's width: both sidebars fold away as a drawing's tab " +
					"comes to the front, and are put back as they were when you go to another tab or close it.",
			)
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.foldSidebarForDrawing).onChange(async (value) => {
					this.plugin.settings.foldSidebarForDrawing = value;
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
