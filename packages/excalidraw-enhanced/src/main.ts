import { Menu, type PaneType, Platform, Plugin, setIcon, setTooltip, type TFile, type View, type WorkspaceLeaf } from "obsidian";
import {
	DEFAULT_SETTINGS,
	ExcalidrawEnhancedSettings,
	ExcalidrawEnhancedSettingTab,
} from "./settings";
import { type Gallery, type ZoomTarget, ZoomOverlay } from "../../../shared/zoom-overlay";
import { LabelSelection } from "../../../shared/label-selection";
import { createDrawingFromFence } from "./fence-drawing";
import { DrawingFit } from "./fit-slider";
import { DrawingGallery } from "./gallery";

/** Class on the button that opens a drawing in Live Preview to be edited. */
const EDIT_BTN_CLS = "excalidraw-edit-btn";
/** Class on the zoom-in button beside it. */
const ZOOM_BTN_CLS = "excalidraw-zoom-btn";

/** An image in a Claudian reply — a drawing's PNG, a pasted screenshot — and the view it's in. */
const CLAUDIAN_IMAGE = ".claudian-embedded-image > img";
const CLAUDIAN_VIEW = '.workspace-leaf-content[data-type="claudian-view"]';

/** Body class the note-sizing rule in styles.css hangs off. */
const SIZING_CLASS = "excalidraw-enhanced-sizing";
/** Custom property that rule reads the drawing width from. */
const WIDTH_VAR = "--excalidraw-enhanced-width";

export default class ExcalidrawEnhancedPlugin extends Plugin {
	settings: ExcalidrawEnhancedSettings;
	/** The zoom a drawing in a note opens in. */
	private zoom: ZoomOverlay | null = null;

	async onload() {
		await this.loadSettings();
		this.addSettingTab(new ExcalidrawEnhancedSettingTab(this.app, this));

		// Double-click a drawing — or its zoom-in button — to open a zoomable/pannable overlay, as
		// an image's own zoom opens; plain tap on mobile. The overlay itself is shared with
		// Mermaid (Enhanced); only the options below are ours. `excalidraw-embedded-img` is the
		// class Excalidraw stamps on whatever it rendered, so it covers all three preview types.
		const gallery = new DrawingGallery(this.app);
		this.register(() => gallery.destroy());
		this.zoom = new ZoomOverlay(this, {
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
			// Read from the note's embeds: nothing drawn to list them.
			listGalleryAtOnce: true,
			sourceOf: gallery.sourceOf,
		});
		this.zoom.register();
		// Images in Claudian's replies get the same zoom, as Mermaid (Enhanced) gives its
		// diagrams there, paging through every image of the conversation.
		new ZoomOverlay(this, {
			target: CLAUDIAN_IMAGE,
			within: CLAUDIAN_VIEW,
			cssPrefix: "excalidraw-zoom",
			gallery: (target) => Promise.resolve(claudianImagesAround(target)),
		}).register();

		// A drag in a drawing's text selects line by line, as in a Mermaid diagram's labels
		// (shared/label-selection.ts): the browser's own drag lost the selection over the blank
		// between letters and lines. In a note shown as SVG and in the zoom.
		new LabelSelection({ label: drawingTextOf }).register(this);
		// Excalidraw opens a drawing on a long press: a timer from the press, stopped only by a
		// move of 10px — a drag selecting a word or two, held a moment, opened the drawing and
		// the selection was gone. A press on its text is kept from it; the edit button, the menu
		// and a long press anywhere else still open it.
		this.registerDomEvent(
			document,
			"pointerdown",
			(event: PointerEvent) => {
				if (event.button !== 0 || !(event.target instanceof Element)) return;
				const text = event.target.closest(".excalidraw-embedded-img svg text");
				if (text?.closest(".markdown-source-view, .markdown-preview-view")) event.stopPropagation();
			},
			{ capture: true },
		);

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
		// events go on as before — a double-click to zoom, and the menu (the `contextmenu`
		// event) still work.
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
		// A double-click on a drawing in a note doesn't open it — Excalidraw's own does; it zooms
		// it (ZoomOverlay), and its edit button and menu are the way in. Kept from the drawing
		// before it gets there.
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
		// The same goes for each drawing's size slider (fit-slider.ts) and the size it keeps — that
		// one as soon as a drawing arrives, before it's painted: a frame later the drawing had been
		// drawn at the settings' width and then jumped to its own.
		const fit = new DrawingFit(this.app);
		fit.register(this);
		let frame: number | null = null;
		const observer = new MutationObserver((mutations) => {
			if (mutations.some(bringsDrawing)) fit.pass();
			if (frame !== null) return;
			frame = window.requestAnimationFrame(() => {
				frame = null;
				this.addEditButtons();
				fit.pass();
			});
		});
		observer.observe(document.body, { childList: true, subtree: true });
		this.register(() => {
			observer.disconnect();
			if (frame !== null) window.cancelAnimationFrame(frame);
			document.querySelectorAll(`.${EDIT_BTN_CLS}, .${ZOOM_BTN_CLS}`).forEach((button) => button.remove());
		});
		this.app.workspace.onLayoutReady(() => {
			this.addEditButtons();
			fit.pass();
		});

		// A drawing opened in the main area gets the window's width: the right sidebar folds away
		// as it opens (fitSidebar).
		// Looked at a moment after the tabs change, once a tab just opened is what it'll be: as
		// the event comes, a drawing opening in a new tab is still an empty one.
		let sidebarTimer: number | null = null;
		const fitSidebarSoon = (): void => {
			if (sidebarTimer !== null) window.clearTimeout(sidebarTimer);
			sidebarTimer = window.setTimeout(() => {
				sidebarTimer = null;
				this.fitSidebar();
			}, 50);
		};
		this.registerEvent(this.app.workspace.on("active-leaf-change", fitSidebarSoon));
		this.registerEvent(this.app.workspace.on("file-open", fitSidebarSoon));
		this.registerEvent(this.app.workspace.on("layout-change", fitSidebarSoon));
		this.register(() => {
			if (sidebarTimer !== null) window.clearTimeout(sidebarTimer);
		});
		this.app.workspace.onLayoutReady(() => this.fitSidebar(true));

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
				// Gone to, not opened behind: the button is pressed to draw.
				void this.app.workspace.openLinkText(file.path, from, "tab", { active: true });
			});
			// The zoom-in button before it, as an image has between its caption and edit buttons.
			// The drawing is looked for at the click: Excalidraw draws it again in place now and then.
			const zoom = this.zoom?.zoomButton(() => embed.querySelector<HTMLElement>(".excalidraw-embedded-img") as ZoomTarget | null, ZOOM_BTN_CLS);
			if (zoom) actions.appendChild(zoom);
			actions.appendChild(button);
		}
	}

	/** The drawing each tab last showed; see fitSidebar. */
	private readonly drawingShown = new WeakMap<WorkspaceLeaf, string>();

	/**
	 * The right sidebar folded as a drawing is opened in the main area — at that moment only:
	 * coming back to a drawing's tab, opening the sidebar over it, going back to a note, all
	 * leave it as it is. A tab still opening (empty) is waited for. Tabs a drawing is restored
	 * in as Obsidian starts are noted, not folded for. Only the main window's: a drawing in a
	 * popout has the sidebar of no window.
	 */
	private fitSidebar(starting = false): void {
		if (Platform.isMobile) return;
		const { workspace } = this.app;
		for (const leaf of workspace.getLeavesOfType("excalidraw")) {
			const path = (leaf.view as View & { file?: TFile | null }).file?.path;
			if (!path || this.drawingShown.get(leaf) === path) continue;
			this.drawingShown.set(leaf, path);
			if (starting || !this.settings.foldSidebarForDrawing || leaf.getRoot() !== workspace.rootSplit) continue;
			if (!workspace.rightSplit.collapsed) workspace.rightSplit.collapse();
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
		// The zoom a double-click or its zoom-in button opens.
		menu.addItem((item) =>
			item.setSection("action-primary").setTitle("Zoom").setIcon("zoom-in").onClick(() => {
				this.zoom?.open(img as unknown as ZoomTarget);
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

/**
 * The text a press on `target` selects in: an Excalidraw text element is a <g> holding a <text>
 * to a line, so a drag runs across its lines. Null off a drawing's text.
 */
function drawingTextOf(target: Element): Element | null {
	const text = target.closest(".excalidraw-embedded-img svg text, .excalidraw-zoom-container svg text");
	const group = text?.parentElement;
	if (!text || !group) return text;
	return group.localName === "g" && Array.from(group.children).every((child) => child.localName === "text") ? group : text;
}

/** Whether a change to the page put a drawing on it. */
function bringsDrawing(mutation: MutationRecord): boolean {
	for (const node of Array.from(mutation.addedNodes)) {
		if (node instanceof Element && (node.matches(".excalidraw-embedded-img") || node.querySelector(".excalidraw-embedded-img"))) return true;
	}
	return false;
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
