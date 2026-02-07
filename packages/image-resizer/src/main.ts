import { Plugin, MarkdownView } from "obsidian";
import { ImageResizer } from "./ImageResizer";
import {
	ImageResizerSettings,
	DEFAULT_SETTINGS,
	ImageResizerSettingTab,
} from "./ImageResizerSettings";

export default class ImageResizerPlugin extends Plugin {
	settings: ImageResizerSettings;
	imageResizer: ImageResizer | null = null;

	async onload() {
		await this.loadSettings();
		this.addSettingTab(new ImageResizerSettingTab(this.app, this));

		// Wait for layout to be ready before initializing view-dependent components
		this.app.workspace.onLayoutReady(() => {
			this.initializeComponents();

			// Apply resizing when switching Live to Reading mode etc.
			if (this.settings.isImageResizeEnbaled) {
				this.registerEvent(
					this.app.workspace.on("layout-change", () => {
						if (this.settings.isImageResizeEnbaled) {
							const activeView =
								this.app.workspace.getActiveViewOfType(
									MarkdownView,
								);
							if (activeView) {
								this.imageResizer?.onLayoutChange(activeView);
							}
						}
					}),
				);
			}
		});
	}

	initializeComponents() {
		if (this.settings.isImageResizeEnbaled) {
			this.imageResizer = new ImageResizer(this);
			this.addChild(this.imageResizer);
			const activeView =
				this.app.workspace.getActiveViewOfType(MarkdownView);
			if (activeView) {
				this.imageResizer.attachView(activeView);
			}
		}
	}

	async loadSettings() {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			await this.loadData(),
		);
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	onunload() {
		// Clean up resizer reference
		if (this.imageResizer) {
			this.imageResizer = null;
		}
	}
}
