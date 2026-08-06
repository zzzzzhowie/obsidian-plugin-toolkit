import { Plugin } from "obsidian";
import {
	DEFAULT_SETTINGS,
	ExcalidrawEnhancedSettings,
	ExcalidrawEnhancedSettingTab,
} from "./settings";
import { ExcalidrawZoom } from "./zoom";

/** Body class the note-sizing rule in styles.css hangs off. */
const SIZING_CLASS = "excalidraw-enhanced-sizing";
/** Custom property that rule reads the drawing width from. */
const WIDTH_VAR = "--excalidraw-enhanced-width";

export default class ExcalidrawEnhancedPlugin extends Plugin {
	settings: ExcalidrawEnhancedSettings;

	async onload() {
		await this.loadSettings();
		this.addSettingTab(new ExcalidrawEnhancedSettingTab(this.app, this));

		// Cmd/Ctrl-click a drawing to open a zoomable/pannable overlay; plain tap on
		// mobile.
		new ExcalidrawZoom(this).register();

		this.applySizing();
		// Leave the DOM as we found it.
		this.register(() => this.clearSizing());
	}

	async loadSettings() {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			(await this.loadData()) as Partial<ExcalidrawEnhancedSettings>,
		);
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	/**
	 * Publish the size limits as custom properties and let the stylesheet apply them.
	 *
	 * Deliberately not inline styles on each drawing: Excalidraw writes its own sizing
	 * straight onto the embedded element's style attribute and rewrites that whole
	 * attribute on every re-render — a theme switch, a file change, its own
	 * RERENDER_EVENT — so anything we set there would be dropped minutes later. A
	 * stylesheet rule marked `!important` outranks an inline style and needs no observer
	 * to defend it, and re-publishing one custom property is all a settings change costs.
	 */
	applySizing() {
		document.body.toggleClass(SIZING_CLASS, this.settings.enabled);
		document.body.style.setProperty(WIDTH_VAR, `${this.settings.widthPx}px`);
	}

	private clearSizing() {
		document.body.removeClass(SIZING_CLASS);
		document.body.style.removeProperty(WIDTH_VAR);
	}
}
