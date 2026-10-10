import { Plugin } from "obsidian";
import {
	DEFAULT_SETTINGS,
	ExcalidrawEnhancedSettings,
	ExcalidrawEnhancedSettingTab,
} from "./settings";
import { type ZoomTarget, ZoomOverlay } from "../../../shared/zoom-overlay";
import { createDrawingFromFence } from "./fence-drawing";
import { DrawingGallery } from "./gallery";

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
		// mobile. The overlay itself is shared with Mermaid (Enhanced); only the two
		// lines below are ours. `excalidraw-embedded-img` is the class Excalidraw
		// stamps on whatever it rendered, so it covers all three preview types.
		const gallery = new DrawingGallery(this.app);
		this.register(() => gallery.destroy());
		new ZoomOverlay(this, {
			target: ".excalidraw-embedded-img",
			cssPrefix: "excalidraw-zoom",
			// Text in the zoom is text, to select and copy, as Mermaid (Enhanced)'s labels are:
			// a drawing the note shows as an <img> (the SVG-image preview type) is shown as the
			// SVG behind it, whose labels are <text>.
			selectableText: "text",
			inline: inlineSvgOf,
			// Every drawing in the note, to page through from the one clicked.
			gallery: gallery.around,
		}).register();

		// Typing ```excalidraw embeds a new drawing (fence-drawing.ts). After the change, not
		// inside it: the edit that finished the fence is still being applied.
		this.registerEvent(
			this.app.workspace.on("editor-change", (editor) => {
				if (!this.settings.fenceCreatesDrawing) return;
				// A cheap look first: this runs on every keystroke.
				const line = editor.getCursor().line;
				const near = editor.getLine(line) + (line > 0 ? editor.getLine(line - 1) : "");
				if (!/excalidraw/i.test(near)) return;
				window.setTimeout(() => createDrawingFromFence(this.app, editor, this.settings.fenceOpenIn));
			}),
		);

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
		document.body.addClass(SIZING_CLASS);
		document.body.style.setProperty(WIDTH_VAR, `${this.settings.widthPx}px`);
	}

	private clearSizing() {
		document.body.removeClass(SIZING_CLASS);
		document.body.style.removeProperty(WIDTH_VAR);
	}
}

/**
 * The SVG behind a drawing shown as an `<img>` (Excalidraw's "SVG image" preview type), as an
 * inline `<svg>` whose text can be selected; null for anything else, or an image whose source
 * isn't an SVG. Read from the image's own source — a blob or data URL Excalidraw made — so
 * nothing is exported again.
 */
async function inlineSvgOf(target: ZoomTarget): Promise<ZoomTarget | null> {
	if (!(target instanceof HTMLImageElement)) return null;
	const src = target.currentSrc || target.src;
	if (!src) return null;
	// A blob: or data: URL the page made, not the network: requestUrl can't read those.
	// eslint-disable-next-line no-restricted-globals
	const text = await (await fetch(src)).text();
	const doc = new DOMParser().parseFromString(text, "image/svg+xml");
	const svg = doc.documentElement;
	if (svg.nodeName.toLowerCase() !== "svg" || doc.querySelector("parsererror")) return null;
	return target.doc.importNode(svg, true) as unknown as SVGSVGElement;
}
