import { Menu, type PaneType, Platform, Plugin, setIcon, setTooltip, type TFile } from "obsidian";
import {
	DEFAULT_SETTINGS,
	ExcalidrawEnhancedSettings,
	ExcalidrawEnhancedSettingTab,
} from "./settings";
import { type Gallery, type ZoomTarget, ZoomOverlay } from "../../../shared/zoom-overlay";
import { createDrawingFromFence } from "./fence-drawing";
import { DrawingGallery } from "./gallery";

/** Class on the button that opens a drawing in Live Preview to be edited. */
const EDIT_BTN_CLS = "excalidraw-edit-btn";

/** An image in a Claudian reply — a drawing's PNG, a pasted screenshot — and the view it's in. */
const CLAUDIAN_IMAGE = ".claudian-embedded-image > img";
const CLAUDIAN_VIEW = '.workspace-leaf-content[data-type="claudian-view"]';

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
			// Its hand-drawn strokes are costly to draw again at every step of a pinch.
			rasterWhileZooming: true,
			// Every drawing in the note, to page through from the one clicked.
			gallery: gallery.around,
			sourceOf: gallery.sourceOf,
		}).register();
		// Images in Claudian's replies get the same zoom, as Mermaid (Enhanced) gives its
		// diagrams there, paging through every image of the conversation.
		new ZoomOverlay(this, {
			target: CLAUDIAN_IMAGE,
			within: CLAUDIAN_VIEW,
			cssPrefix: "excalidraw-zoom",
			gallery: (target) => Promise.resolve(claudianImagesAround(target)),
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

		// A press on a drawing in Live Preview opened its `![[…]]` as source. A drawing is a note
		// embedded, and Obsidian selects a note embed's markdown on a click it wasn't told to
		// leave be (its embeds' click handler, when the click's default isn't prevented) —
		// Live Preview then shows it as source; a right-click's default puts the caret there
		// too. Neither press is the editor's here: their defaults are kept from it, while the
		// events go on as before — Excalidraw's own double-click, Cmd/Ctrl-click to zoom, and
		// the menu (the `contextmenu` event) still work.
		const onDrawing = (event: MouseEvent): boolean => {
			if (!(event.target instanceof Element)) return false;
			const embed = event.target.closest(".markdown-source-view .cm-content .internal-embed");
			return !!embed?.querySelector(".excalidraw-embedded-img");
		};
		this.registerDomEvent(
			document,
			"mousedown",
			(event: MouseEvent) => {
				if (event.button === 2 && onDrawing(event)) event.preventDefault();
			},
			{ capture: true },
		);
		// A right-click opened the drawing. Excalidraw opens one on a long press: a timer from
		// the press, stopped by the release — and the menu a right-click opens takes the
		// release, so the timer ran out and the drawing opened behind the menu. A press that
		// brings a menu (the right button, or Ctrl-click on a Mac) is kept from Excalidraw's
		// image; the menu comes from the `contextmenu` event, which still goes.
		this.registerDomEvent(
			document,
			"pointerdown",
			(event: PointerEvent) => {
				const menuPress = event.button === 2 || (Platform.isMacOS && event.button === 0 && event.ctrlKey);
				if (menuPress && event.target instanceof Element && event.target.closest(".excalidraw-embedded-img")) {
					event.stopPropagation();
				}
			},
			{ capture: true },
		);
		this.registerDomEvent(
			document,
			"click",
			(event: MouseEvent) => {
				if (onDrawing(event)) event.preventDefault();
			},
			{ capture: true },
		);
		// A double-click on a drawing in a note doesn't open it — Excalidraw's own does; its edit
		// button and menu are the way in. Kept from the drawing before it gets there.
		this.registerDomEvent(
			document,
			"dblclick",
			(event: MouseEvent) => {
				if (!(event.target instanceof Element)) return;
				const img = event.target.closest(".excalidraw-embedded-img");
				if (img?.closest(".markdown-source-view, .markdown-preview-view")) event.stopPropagation();
			},
			{ capture: true },
		);
		// A right-click on a drawing in a note opened the editor's menu — cut, copy, paste — as
		// for any text: a drawing is a note embedded, not an image, to the editor. It gets a menu
		// of its own, as a link to the drawing does (and what other plugins add to one).
		this.registerDomEvent(
			document,
			"contextmenu",
			(event: MouseEvent) => {
				const img = event.target instanceof Element ? event.target.closest<HTMLElement>(".excalidraw-embedded-img") : null;
				if (!img || !img.closest(".markdown-source-view, .markdown-preview-view")) return;
				const file = this.drawingFileOf(img);
				if (!file) return;
				event.preventDefault();
				event.stopPropagation();
				this.drawingMenu(file, img).showAtMouseEvent(event);
			},
			{ capture: true },
		);

		// Each drawing in Live Preview gets an edit button in its action group, as a Mermaid
		// diagram has — the pencil beside the caption button. Drawings come and go with Live
		// Preview's rendering, so they're looked for whenever the page changes (once a frame).
		let frame: number | null = null;
		const observer = new MutationObserver(() => {
			if (frame !== null) return;
			frame = window.requestAnimationFrame(() => {
				frame = null;
				this.addEditButtons();
			});
		});
		observer.observe(document.body, { childList: true, subtree: true });
		this.register(() => {
			observer.disconnect();
			if (frame !== null) window.cancelAnimationFrame(frame);
			document.querySelectorAll(`.${EDIT_BTN_CLS}`).forEach((button) => button.remove());
		});
		this.app.workspace.onLayoutReady(() => this.addEditButtons());

		this.applySizing();
		// Leave the DOM as we found it.
		this.register(() => this.clearSizing());
	}

	/**
	 * The edit button on each drawing in Live Preview that hasn't one: the drawing opens in a
	 * new tab to be drawn in, the note left where it was. A drawing can't be edited in the note as a diagram's
	 * code is, so its pencil opens it. In the action group Caption (Enhanced) gives a drawing
	 * (made here if this comes first), after the caption button, as on a diagram.
	 */
	private addEditButtons(): void {
		for (const img of Array.from(document.querySelectorAll<HTMLElement>(".markdown-source-view .cm-content .excalidraw-embedded-img"))) {
			const embed = img.closest<HTMLElement>(".internal-embed");
			if (!embed || embed.querySelector(`.${EDIT_BTN_CLS}`)) continue;
			let actions = embed.querySelector<HTMLElement>(":scope > .embed-actions");
			if (!actions) {
				actions = embed.doc.createElement("div");
				actions.className = "embed-actions";
				embed.appendChild(actions);
			}
			const button = embed.doc.createElement("div");
			button.className = `embed-action ${EDIT_BTN_CLS}`;
			setIcon(button, "pen-line");
			setTooltip(button, "Edit drawing");
			// Kept from the editor (which would select the embed's markdown) and from Excalidraw's
			// own long press on the drawing.
			for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup"]) {
				button.addEventListener(type, (event) => event.stopPropagation());
			}
			button.addEventListener("click", (event) => {
				event.preventDefault();
				event.stopPropagation();
				const file = this.drawingFileOf(img);
				if (!file) return;
				const from = this.app.workspace.getActiveFile()?.path ?? "";
				void this.app.workspace.openLinkText(file.path, from, "tab");
			});
			actions.appendChild(button);
		}
	}

	/** The drawing a drawing's image shows: Excalidraw stamps its path on it. */
	private drawingFileOf(img: HTMLElement): TFile | null {
		const source = img.getAttribute("fileSource")?.replace(/#.*$/, "");
		if (!source) return null;
		return this.app.vault.getFileByPath(source) ?? this.app.vault.getFileByPath(`${source}.md`);
	}

	/** A drawing's menu: open it, zoom it, its caption, and what plugins add for a link to it. */
	private drawingMenu(file: TFile, img: HTMLElement): Menu {
		const menu = new Menu();
		const from = this.app.workspace.getActiveFile()?.path ?? "";
		const open = (where: PaneType | false): void => void this.app.workspace.openLinkText(file.path, from, where);
		// Sections, as Obsidian's own menus have them: plugins' items carry one, and an item without
		// came after all of theirs — the drawing's own items sank to the middle of a long menu.
		menu.addItem((item) => item.setSection("open").setTitle("Open drawing").setIcon("pencil").onClick(() => open(false)));
		menu.addItem((item) => item.setSection("open").setTitle("Open in new tab").setIcon("file-plus").onClick(() => open("tab")));
		menu.addItem((item) =>
			item.setSection("open").setTitle("Open to the right").setIcon("separator-vertical").onClick(() => open("split")),
		);
		// The zoom opens on Cmd/Ctrl-click (ZoomOverlay); the same click, made here.
		menu.addItem((item) =>
			item.setSection("action-primary").setTitle("Zoom").setIcon("zoom-in").onClick(() => {
				img.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, metaKey: true, ctrlKey: true }));
			}),
		);
		// Caption (Enhanced)'s button, on the drawing's action group, when it's there.
		const caption = img.closest(".internal-embed")?.querySelector<HTMLElement>(".image-caption-btn");
		if (caption) {
			menu.addItem((item) =>
				item.setSection("action-primary").setTitle("Edit caption").setIcon("captions").onClick(() => caption.click()),
			);
		}
		this.app.workspace.trigger("file-menu", menu, file, "link-context-menu");
		return menu;
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
 * The drawing as an inline `<svg>` for the zoom, whose text can be selected: the SVG behind a
 * drawing shown as an `<img>` (the "SVG image" preview type), read from the image's own source
 * — a blob or data URL Excalidraw made — so nothing is exported again; or the <svg> already in
 * the drawing's element (the "native SVG" preview type). Null for anything else, or an image
 * whose source isn't an SVG.
 */
async function inlineSvgOf(target: ZoomTarget): Promise<ZoomTarget | null> {
	// Shown as SVG (Excalidraw's "native SVG" preview), the drawing is the <svg> in the
	// `div.excalidraw-embedded-img` a click lands in: that <svg> is what the zoom shows — sized
	// by its viewBox, and a picture of it stands in while zooming (rasterWhileZooming).
	if (!(target instanceof HTMLImageElement)) {
		const svg = target instanceof SVGSVGElement ? null : (target as Element).querySelector("svg");
		return Promise.resolve(svg);
	}
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

/** Every image of the Claudian conversation the clicked one is in, for the zoom to page through. */
function claudianImagesAround(target: ZoomTarget): Gallery | null {
	const list = target.closest(".claudian-messages");
	if (!list) return null;
	const images = Array.from(list.querySelectorAll<HTMLImageElement>(CLAUDIAN_IMAGE));
	const index = images.indexOf(target as HTMLImageElement);
	if (images.length < 2 || index < 0) return null;
	return {
		index,
		items: images.map((image, i) => ({
			label: image.alt || `Image ${i + 1}`,
			element: () => Promise.resolve(image),
		})),
	};
}
