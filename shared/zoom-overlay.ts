import { Platform, Plugin, setIcon } from "obsidian";
import { captionPlainText, followCaptionLink, renderCaption } from "./caption";

/** How long a wheel or touch gesture rests before the drawing is drawn again at its size. */
const SETTLE_MS = 150;

/**
 * What a click can open in the overlay: a Mermaid diagram's `<svg>`, or an embedded
 * Excalidraw drawing, which is an `<svg>` or an `<img>` depending on that plugin's
 * preview-image setting. Both element kinds are handled throughout.
 */
export type ZoomTarget = SVGElement | HTMLImageElement;

/**
 * What a drawing in the zoom is drawn from: a note's lines (1-based, inclusive) for a Mermaid
 * diagram, a drawing's file for an Excalidraw one. Stamped on the zoom's container
 * (`data-zoom-path`, `-from`, `-to`), so another plugin can tell what is on show — Claudian
 * (Enhanced)'s ⌥K refers Claude to it.
 */
export interface ZoomSource {
	path: string;
	from?: number;
	to?: number;
}

/** A drawing the zoom can page to; see {@link ZoomOverlayOptions.gallery}. */
export interface GalleryItem {
	/** Its name under the thumbnail: a diagram's caption, say. */
	label: string;
	/** What it's drawn from, when that can be told. */
	source?: ZoomSource;
	/** The drawing, made when first needed (the one clicked is already on the page); null if it can't be. */
	element: () => Promise<ZoomTarget | null>;
}

/** The drawings a zoom pages through, and which of them was clicked. */
export interface Gallery {
	items: GalleryItem[];
	index: number;
}

export interface ZoomOverlayOptions {
	/**
	 * Selector for the elements a click zooms — `.mermaid svg`,
	 * `.excalidraw-embedded-img`, and so on. Matched with `closest`, so a click on
	 * anything inside one counts.
	 */
	target: string;
	/**
	 * Prefix for the overlay's own classes (`<prefix>-overlay`, `-container`,
	 * `-toolbar`), so each plugin styles its own copy and two enabled plugins can't
	 * fight over the same rules.
	 */
	cssPrefix: string;
	/**
	 * Selector for the text inside the drawing that can be selected, as on the page: a drag
	 * that starts on it selects instead of panning. A Mermaid diagram's labels are real text
	 * (`foreignObject, text`); left out, every drag pans.
	 */
	selectableText?: string;
	/**
	 * The other drawings to page through from the one clicked — every diagram in its note.
	 * With two or more, a strip of thumbnails runs under the zoom, the toolbar gets previous
	 * and next, and ←/→ step through them; left out, the zoom shows the one drawing.
	 */
	gallery?: (target: ZoomTarget) => Promise<Gallery | null>;
	/**
	 * What to show in place of the clicked element, when it can do better — an inline `<svg>`
	 * for a drawing the note shows as an `<img>`, so its text is text (see selectableText).
	 * Null, or a failure, shows the element itself.
	 */
	inline?: (target: ZoomTarget) => Promise<ZoomTarget | null>;
	/**
	 * While a zoom is under way, show the drawing as a picture of itself rather than as SVG
	 * (see zooming). For drawings whose SVG is costly to draw — an Excalidraw drawing's
	 * hand-drawn strokes — which stuttered at every step of a pinch.
	 */
	rasterWhileZooming?: boolean;
	/** What the clicked drawing is drawn from (see ZoomSource); a gallery's others say it themselves. */
	sourceOf?: (target: ZoomTarget) => ZoomSource | null;
	/**
	 * Selector for the views a target has to be in; a note's (Markdown leaves) by default.
	 * Another view's drawings are zoomed by a second overlay that names it.
	 */
	within?: string;
}

/** Zoom range, shared by every way of changing it. */
const MIN_SCALE = 0.1;
const MAX_SCALE = 50;
/**
 * Zoom per unit of trackpad pinch. macOS reports a pinch as a ctrl-wheel whose `deltaY`
 * carries how far the fingers travelled; applying a fixed step per event instead threw
 * that away, so a wide deliberate pinch zoomed no faster than a twitch and reaching a
 * useful magnification took a dozen gestures.
 *
 * Exponential, so the step is proportional: twice the finger travel is twice the zoom in
 * log space, and pinching back out by the same distance lands exactly where you started.
 */
const PINCH_SENSITIVITY = 0.015;

/** Rendered-note containers; anything outside one is not content in a note. */
const NOTE_CONTAINER = '.workspace-leaf-content[data-type="markdown"]';

/**
 * Click-to-zoom for a diagram or drawing in a note (originally the SVG half of the
 * retired image-zoom plugin). A click opens a full-screen overlay holding a clone that
 * can be zoomed (buttons / wheel-pinch / two-finger pinch) and panned (drag /
 * two-finger). Requires Cmd/Ctrl on desktop so it never swallows the plain click that
 * positions the cursor in Live Preview; on mobile a plain tap is enough.
 *
 * The click is claimed in the capture phase and stopped there (see register), so the
 * element never also reaches Obsidian's own handling or another plugin listening on the
 * bubble — one click can only ever produce this one overlay. Where the host plugin's
 * content has its own click behaviour (an Excalidraw embed opens the drawing), the
 * modifier-click is taken over and the plain click is left alone.
 *
 * Shared by Mermaid (Enhanced) and Excalidraw (Enhanced): the behaviour is meant to be
 * identical, and it used to be two copies that drifted the moment either was tuned.
 * Everything that legitimately differs is in {@link ZoomOverlayOptions}.
 */
export class ZoomOverlay {
	private overlay: HTMLElement | null = null;
	private current: ZoomTarget | null = null;
	/** The clone's wrapper: what zoom and pan transform, and what carries the backing. */
	private frame: HTMLElement | null = null;
	private toolbar: HTMLElement | null = null;
	private scale = 1;
	/** The fit-to-screen scale the overlay opened at; what "reset" returns to. */
	private initialScale = 1;
	private translateX = 0;
	private translateY = 0;
	private isDragging = false;
	/** The last press on the drawing moved it: the click that ends it doesn't close. */
	private panned = false;
	/** A transform waiting for the next frame; see scheduleTransform. */
	private transformFrame: number | null = null;
	/** When the drawing's own layer is let go of after a wheel or touch gesture; see moving. */
	private settleTimer: number | null = null;
	/** The drawing as a picture, shown in its place while zooming; see zooming. */
	private standIn: StandIn | null = null;
	/** A detail for the stand-in waiting to be made; see scheduleDetail. */
	private detailTimer: number | null = null;
	/** The stand-in fading out as the SVG comes back; see showVector. */
	private fadeTimer: number | null = null;
	/** The drawing on show, at its own size; what fitting it to the screen measures. */
	private drawingSize = { width: 800, height: 600 };
	/** The filter the clicked drawing had in its note, given to every drawing paged to. */
	private drawingFilter = "";
	private gallery: Gallery | null = null;
	/** Each gallery drawing once made, by index. */
	private galleryDrawings = new Map<number, Promise<ZoomTarget | null>>();
	/** Bumped on every open and close, so a gallery still loading for an earlier one bows out. */
	private galleryToken = 0;
	private strip: HTMLElement | null = null;
	/** The name of the drawing on show, over it, while paging through a gallery. */
	private title: HTMLElement | null = null;

	private get isMobile(): boolean {
		return Platform.isMobile;
	}

	constructor(
		private readonly plugin: Plugin,
		private readonly options: ZoomOverlayOptions,
	) {}

	/** Build the overlay and wire the trigger + dismissal listeners. */
	register(): void {
		this.createOverlay();

		// Capture phase so a click on our content is ours alone; other clicks fall
		// through untouched.
		this.plugin.registerDomEvent(
			document,
			"click",
			(event: MouseEvent) => {
				// Desktop requires Cmd/Ctrl; mobile is a plain tap.
				if (!this.isMobile && !event.metaKey && !event.ctrlKey) return;
				const target = this.zoomTargetFor(event.target as HTMLElement);
				if (!target) return;
				event.preventDefault();
				event.stopPropagation();
				event.stopImmediatePropagation();
				const inline = this.options.inline;
				if (!inline) {
					this.showZoomed(target);
					return;
				}
				inline(target).then(
					(shown) => this.showZoomed(target, shown ?? target),
					() => this.showZoomed(target),
				);
			},
			{ capture: true },
		);
		// The press before that click is the editor's: in Live Preview, Cmd/Ctrl + mousedown
		// adds a cursor where it lands — inside the diagram's block, which Live Preview then
		// shows as source, so closing the zoom found the diagram turned to code. The press
		// that will zoom is kept from the editor too.
		this.plugin.registerDomEvent(
			document,
			"mousedown",
			(event: MouseEvent) => {
				if (event.button !== 0) return;
				if (!this.isMobile && !event.metaKey && !event.ctrlKey) return;
				if (!this.zoomTargetFor(event.target as HTMLElement)) return;
				event.preventDefault();
				event.stopPropagation();
				event.stopImmediatePropagation();
			},
			{ capture: true },
		);

		// Desktop needs Cmd/Ctrl to zoom, which is undiscoverable on its own — so hint
		// it: while the modifier is held, a zoomable drawing gets the zoom-in cursor.
		// Pointless on mobile, where there's no hover and a plain tap works.
		if (!this.isMobile) {
			this.plugin.registerDomEvent(document, "mousemove", (event: MouseEvent) => {
				const target = this.zoomTargetFor(event.target as HTMLElement);
				if (!target) return;
				// Cleared (not left set) as soon as the modifier comes back up. A host that
				// rewrites the whole style attribute when it re-renders (Excalidraw does)
				// only means the hint is re-applied on the next move.
				const cursor = event.metaKey || event.ctrlKey ? "zoom-in" : "";
				// Only when it changes: this runs on every pointer move over a drawing.
				if (target.style.cursor !== cursor) target.style.cursor = cursor;
			});
		}
	}

	/** The element a click over `target` should zoom, or null. */
	private zoomTargetFor(target: HTMLElement): ZoomTarget | null {
		const el = target.closest<ZoomTarget>(this.options.target);
		if (!el) return null;
		// Only within a Markdown leaf (reading view or live preview), or the views `within`
		// names — which also keeps the overlay's own clone, mounted on body, from re-triggering.
		if (!el.closest(this.options.within ?? NOTE_CONTAINER)) return null;
		return el;
	}

	private createOverlay(): void {
		const overlay = document.body.createDiv(`${this.options.cssPrefix}-overlay`);
		overlay.style.display = "none";
		this.overlay = overlay;
		this.plugin.register(() => overlay.remove());

		// Desktop: a click anywhere off the drawing closes — the dimmed backdrop, and the empty
		// part of the container around the drawing, which covers most of the screen. Not the
		// click that ends a pan or a drag selecting text and lets go past the drawing, which
		// lands there as well.
		overlay.addEventListener("click", (e) => {
			const onBackdrop =
				e.target === overlay ||
				(e.target instanceof HTMLElement && e.target.classList.contains(`${this.options.cssPrefix}-container`));
			if (!onBackdrop) return;
			if (this.panned) {
				this.panned = false;
				return;
			}
			const selection = overlay.win.getSelection();
			if (selection && !selection.isCollapsed && overlay.contains(selection.anchorNode)) return;
			this.close();
		});

		// Mobile: the container fills most of the screen, so a tap in the black area
		// around the content lands on the container, not the overlay. Treat a tap
		// (negligible movement) on either as a backdrop tap; movement is a pan/pinch, not
		// a dismiss. Taps on the content / toolbar keep their own handlers.
		let tapX = 0;
		let tapY = 0;
		let tapMoved = false;
		overlay.addEventListener(
			"touchstart",
			(e) => {
				const t = e.touches[0];
				if (t) {
					tapX = t.clientX;
					tapY = t.clientY;
					tapMoved = false;
				}
			},
			{ passive: true, capture: true },
		);
		overlay.addEventListener(
			"touchmove",
			(e) => {
				const t = e.touches[0];
				if (
					t &&
					(Math.abs(t.clientX - tapX) > 10 || Math.abs(t.clientY - tapY) > 10)
				) {
					tapMoved = true;
				}
			},
			{ passive: true, capture: true },
		);
		overlay.addEventListener(
			"touchend",
			(e) => {
				if (tapMoved) return;
				const target = e.target as HTMLElement;
				if (
					target === overlay ||
					target.classList.contains(`${this.options.cssPrefix}-container`)
				) {
					this.close();
				}
			},
			{ capture: true },
		);

		// Prevent click-through.
		overlay.addEventListener("mousedown", (e) => e.stopPropagation());

		// ESC closes (desktop), and ←/→ page through a gallery. On the window in the capture
		// phase, ahead of everything else:
		// on the document, listening as the key bubbled up, it never came when focus was in an
		// editor that stops its own Escape — Claudian's composer, typed in just before — and
		// that editor acted on it instead (Escape there interrupts a reply). While the zoom is
		// open the key is the zoom's alone.
		this.plugin.registerDomEvent(
			window,
			"keydown",
			(e: KeyboardEvent) => {
				if (e.isComposing || this.overlay?.style.display !== "flex") return;
				const step = e.key === "ArrowLeft" ? -1 : e.key === "ArrowRight" ? 1 : 0;
				if (e.key !== "Escape" && !(step && this.gallery)) return;
				e.preventDefault();
				e.stopPropagation();
				e.stopImmediatePropagation();
				if (step) void this.step(step);
				else this.close();
			},
			{ capture: true },
		);
	}

	/** Open the zoom for `target`, showing `shown` — the target itself, or what `inline` gave for it. */
	private showZoomed(target: ZoomTarget, shown: ZoomTarget = target): void {
		if (!this.overlay) return;
		this.overlay.empty();
		this.resetGallery();
		// Whatever filter the note gives the element, the clone gets too: it is part of how
		// the drawing looks, and it comes from rules the clone no longer matches once it
		// leaves the note. In dark mode Obsidian renders Mermaid in its light theme and
		// flips it with `.theme-dark .mermaid > svg { filter: invert… }`, so without this
		// the overlay showed the raw light-theme colours, nothing like the note. Kept for the
		// drawings paged to from here, which never were in the note to pick it up.
		const filter = getComputedStyle(target).filter;
		this.drawingFilter = filter && filter !== "none" ? filter : "";
		this.mountDrawing(shown, this.options.sourceOf?.(target) ?? null);
		// The drawing as a picture is the <img> it was in the note, when it was one.
		if (shown !== target && target instanceof HTMLImageElement) this.prepareStandIn(target.currentSrc || target.src);
		else this.prepareStandIn();
		this.createToolbar();
		this.overlay.style.display = "flex";
		this.fitToRoom();
		// Once the zoom is on screen: listing and drawing the others for the strip went in the
		// click's own task, and the zoom showed only after them — a second or two the first time
		// after Obsidian starts, every other diagram of a note parsed and drawn cold.
		const gallery = this.options.gallery;
		if (gallery) {
			const token = this.galleryToken;
			afterPaint(() => {
				if (token === this.galleryToken) void this.loadGallery(target, shown, gallery);
			});
		}
	}

	/** Put a clone of `target` on show, replacing the one there, at the fit-to-screen scale. */
	private mountDrawing(target: ZoomTarget, source: ZoomSource | null): void {
		if (!this.overlay) return;
		this.dropStandIn();
		this.translateX = 0;
		this.translateY = 0;
		this.overlay.querySelector(`:scope > .${this.options.cssPrefix}-container`)?.remove();
		const container = createDiv(`${this.options.cssPrefix}-container`);
		if (source) {
			container.dataset.zoomPath = source.path;
			if (source.from) container.dataset.zoomFrom = String(source.from);
			if (source.to) container.dataset.zoomTo = String(source.to);
		}
		if (this.title) this.title.after(container);
		else this.overlay.prepend(container);

		// Clone so we never mutate what is in the note, and drop the sizing that came
		// with it (the host's own max-width, and any note-sizing rule over it).
		const clone = target.cloneNode(true) as ZoomTarget;
		const { width, height } = this.naturalSizeOf(target);
		this.drawingSize = { width, height };
		// Size the clone in px. `width/height: auto` collapses an SVG that ships
		// `width="100%"` plus a viewBox and no intrinsic size, which with the white
		// backing renders as a small white square instead of the drawing. Explicit px
		// also gives `transform: scale()` a real reference point, so maxWidth/maxHeight
		// must be none or they would fight the transform.
		clone.style.width = `${width}px`;
		clone.style.height = `${height}px`;
		clone.style.maxWidth = "none";
		clone.style.maxHeight = "none";
		// Block, so an inline element's baseline gap doesn't add a strip under it.
		clone.style.display = "block";
		if (this.drawingFilter) clone.style.filter = this.drawingFilter;

		// The frame is what's transformed, and where a plugin puts its backing. Kept apart
		// from the clone so a filter on the clone recolours the drawing only, not the
		// backing behind it — the same as in the note, where the filtered drawing sits on
		// the note's own background.
		const frame = container.createDiv(`${this.options.cssPrefix}-frame`);
		// The container is a flex row capped at 90vw, and a flex item shrinks to fit by
		// default — but only along the row. Wider than that (every diagram, on a phone), the
		// width was squeezed to the container while the height kept its full px value: a
		// tall card with the drawing shrunk to a sliver in the middle of it. The transform
		// does the fitting; the box has to keep the drawing's own proportions.
		frame.style.flexShrink = "0";
		frame.appendChild(clone);
		this.frame = frame;
		this.current = clone;

		// A first estimate, so nothing renders at scale 1 before it's measured below.
		this.initialScale = this.initialScaleFor(width, height);
		this.scale = this.initialScale;
		this.setupZoomAndDrag(container);
	}

	/**
	 * Fit against the room actually left, now that the overlay is laid out. The estimate
	 * guesses the toolbar at 60px and the screen at the window's size; on a phone the
	 * toolbar wraps taller and the overlay keeps clear of the notch and home bar, so the
	 * estimate promised more room than there was and the drawing opened too large,
	 * running off the screen.
	 */
	private fitToRoom(): void {
		const measured = this.measuredScaleFor(this.drawingSize.width, this.drawingSize.height);
		if (measured !== null) {
			this.initialScale = measured;
			this.scale = measured;
		}
		this.updateTransform(true);
		this.updateToolbar();
	}

	/** Ask for the drawings around the one clicked, and give them a strip if there are others. */
	// Promise chains rather than `async`: compiled for ES6 that needs tslib's helpers, and
	// this folder sits outside every package's node_modules.
	private loadGallery(target: ZoomTarget, shown: ZoomTarget, gallery: NonNullable<ZoomOverlayOptions["gallery"]>): Promise<void> {
		const token = this.galleryToken;
		return gallery(target).then(
			(found) => {
				if (token !== this.galleryToken || !found || found.items.length < 2) return;
				this.gallery = found;
				// Paging back to the one clicked shows it as it was first shown — inline, when it was.
				this.galleryDrawings.set(found.index, Promise.resolve(shown));
				this.buildStrip();
				this.fitToRoom();
			},
			(error: unknown) => console.error("zoom-overlay: couldn't list the drawings to page through", error),
		);
	}

	/** The gallery's drawing at `index`, made once. */
	private galleryDrawing(index: number): Promise<ZoomTarget | null> {
		let made = this.galleryDrawings.get(index);
		if (!made) {
			const item = this.gallery?.items[index];
			made = item ? item.element().catch(() => null) : Promise.resolve(null);
			this.galleryDrawings.set(index, made);
		}
		return made;
	}

	/**
	 * Thumbnails of the gallery under the toolbar, previous / next on the toolbar, and the
	 * name of the drawing on show at the top — the thumbnails' own labels are cut short.
	 */
	private buildStrip(): void {
		const gallery = this.gallery;
		if (!this.overlay || !this.toolbar || !gallery) return;
		const prefix = this.options.cssPrefix;
		this.overlay.addClass(`${prefix}-has-strip`);
		const prev = createEl("button", { cls: `${prefix}-prev`, attr: { "aria-label": "Previous" } });
		setIcon(prev, "chevron-left");
		prev.addEventListener("click", () => void this.step(-1));
		this.toolbar.prepend(prev);
		const next = this.toolbar.createEl("button", { cls: `${prefix}-next`, attr: { "aria-label": "Next" } });
		setIcon(next, "chevron-right");
		next.addEventListener("click", () => void this.step(1));
		this.title = createDiv(`${prefix}-title`);
		this.overlay.prepend(this.title);
		// Its links work as a caption's do. A note's opens behind the zoom, so the zoom goes; a
		// website's opens in the browser, and the zoom is still here to come back to.
		this.title.addEventListener("click", (event) => {
			const internal = event.target instanceof Element && !!event.target.closest("a.internal-link");
			if (followCaptionLink(this.plugin.app, event, this.sourcePath(), `.${prefix}-title`) && internal) this.close();
		});

		const strip = this.overlay.createDiv(`${prefix}-strip`);
		this.strip = strip;
		gallery.items.forEach((item, index) => {
			// A label is a caption, markdown and all; here it's a name (see captionPlainText).
			const label = captionPlainText(item.label);
			const thumb = strip.createEl("button", { cls: `${prefix}-thumb`, attr: { "aria-label": label } });
			const picture = thumb.createDiv(`${prefix}-thumb-picture`);
			thumb.createDiv({ cls: `${prefix}-thumb-label`, text: label });
			thumb.addEventListener("click", () => void this.goTo(index));
			void this.galleryDrawing(index).then((drawing) => {
				if (!drawing || !picture.isConnected) return;
				const copy = drawing.cloneNode(true) as ZoomTarget;
				copy.removeAttribute("style");
				if (this.drawingFilter) copy.style.filter = this.drawingFilter;
				picture.appendChild(copy);
			});
		});
		this.markCurrent();
	}

	/** The note a figure's links are relative to: the one open. */
	private sourcePath(): string {
		return this.plugin.app.workspace.getActiveFile()?.path ?? "";
	}

	private markCurrent(): void {
		const index = this.gallery?.index ?? -1;
		const label = this.gallery?.items[index]?.label ?? "";
		if (this.title) {
			// Rendered as the figure's caption is under it, links and all (shared/caption.ts).
			renderCaption(this.title, label, { app: this.plugin.app, component: this.plugin, sourcePath: this.sourcePath() });
			this.title.setAttribute("title", captionPlainText(label));
		}
		this.strip?.querySelectorAll(`.${this.options.cssPrefix}-thumb`).forEach((thumb, i) => {
			thumb.toggleClass("is-current", i === index);
			if (i === index) thumb.scrollIntoView({ block: "nearest", inline: "nearest" });
		});
	}

	private step(by: number): Promise<void> {
		const count = this.gallery?.items.length ?? 0;
		if (count < 2 || !this.gallery) return Promise.resolve();
		return this.goTo((((this.gallery.index + by) % count) + count) % count);
	}

	/** Show the gallery's drawing at `index`, keeping the toolbar and the strip. */
	private goTo(index: number): Promise<void> {
		const gallery = this.gallery;
		if (!gallery || index === gallery.index) return Promise.resolve();
		const token = this.galleryToken;
		return this.galleryDrawing(index).then((drawing) => {
			if (token !== this.galleryToken || !drawing || this.gallery !== gallery) return;
			gallery.index = index;
			this.mountDrawing(drawing, gallery.items[index]?.source ?? null);
			this.prepareStandIn();
			this.fitToRoom();
			this.markCurrent();
		});
	}

	private resetGallery(): void {
		this.galleryToken++;
		this.gallery = null;
		this.galleryDrawings.clear();
		this.strip = null;
		this.title?.remove();
		this.title = null;
		this.overlay?.removeClass(`${this.options.cssPrefix}-has-strip`);
	}

	/**
	 * The fit-to-screen scale from the overlay as laid out: its own box minus its padding
	 * (the safe-area insets on mobile), the toolbar's real height, and the padding of the
	 * frame and the clone — read from the styles rather than assumed, since each plugin
	 * using this overlay styles it differently. Null when nothing could be measured.
	 */
	private measuredScaleFor(width: number, height: number): number | null {
		const overlay = this.overlay;
		const clone = this.current;
		const frame = this.frame;
		if (!overlay || !clone || !frame) return null;
		const px = (value: string): number => parseFloat(value) || 0;
		const box = getComputedStyle(overlay);
		const innerWidth = overlay.clientWidth - px(box.paddingLeft) - px(box.paddingRight);
		const innerHeight = overlay.clientHeight - px(box.paddingTop) - px(box.paddingBottom);
		let toolbarHeight = 0;
		if (this.toolbar) {
			const bar = getComputedStyle(this.toolbar);
			toolbarHeight = this.toolbar.getBoundingClientRect().height + px(bar.marginTop) + px(bar.marginBottom);
		}
		for (const bar of [this.strip, this.title]) {
			if (!bar) continue;
			const own = getComputedStyle(bar);
			toolbarHeight += bar.getBoundingClientRect().height + px(own.marginTop) + px(own.marginBottom);
		}
		let padX = 0;
		let padY = 0;
		for (const el of [frame, clone]) {
			const own = getComputedStyle(el);
			padX += px(own.paddingLeft) + px(own.paddingRight);
			padY += px(own.paddingTop) + px(own.paddingBottom);
		}
		// A margin around the drawing: 90% across, and down what the toolbar (and a strip and
		// title) leave, less a little — taking 10% of the whole height on top of the bars had left
		// the drawing small once a strip was under it.
		const availWidth = innerWidth * 0.9 - padX;
		const availHeight = (innerHeight - toolbarHeight) * 0.94 - padY;
		if (availWidth <= 0 || availHeight <= 0) return null;
		return Math.min(availWidth / width, availHeight / height);
	}

	/**
	 * The size to build the clone at.
	 *
	 * For an `<img>` this is the box it occupies in the note, *not* `naturalWidth`: the
	 * embedded SVG has no intrinsic size, so the browser reports the CSS default object
	 * size there (247×150 for a 1400×850 drawing — measured). Sizing the clone from that
	 * would work, but every zoom figure would then be quoted against a box that exists
	 * nowhere. An inline `<svg>` still uses its viewBox, which is a real size.
	 *
	 * Both fall back to the other source and then to a sane default, so we can never end
	 * up with a zero-sized clone.
	 */
	private naturalSizeOf(target: ZoomTarget): { width: number; height: number } {
		const rect = target.getBoundingClientRect();
		if (target instanceof HTMLImageElement) {
			if (rect.width > 0 && rect.height > 0) {
				return { width: rect.width, height: rect.height };
			}
			if (target.naturalWidth > 0 && target.naturalHeight > 0) {
				return { width: target.naturalWidth, height: target.naturalHeight };
			}
		} else {
			const vb = (target as SVGSVGElement).viewBox?.baseVal;
			if (vb && vb.width > 0 && vb.height > 0) {
				return { width: vb.width, height: vb.height };
			}
			if (rect.width > 0 && rect.height > 0) {
				return { width: rect.width, height: rect.height };
			}
		}
		return { width: 800, height: 600 };
	}

	/**
	 * Open at the scale that fits the drawing inside the overlay, matching the
	 * container's 90vw / 90vh-minus-toolbar box and the element's own padding. This both
	 * shrinks a large drawing to fit and grows a small one to fill the screen — the point
	 * of zooming.
	 */
	private initialScaleFor(width: number, height: number): number {
		const padding = 40; // the element's 20px padding, both sides
		const availWidth = window.innerWidth * 0.9 - padding;
		const availHeight = window.innerHeight * 0.9 - 60 - padding; // 60 = toolbar
		if (availWidth <= 0 || availHeight <= 0) return 1;
		return Math.min(availWidth / width, availHeight / height);
	}

	private setupZoomAndDrag(container: HTMLElement): void {
		this.updateTransform();

		// Trackpad: pinch (ctrlKey) zooms, two-finger scroll pans.
		container.addEventListener("wheel", (e: WheelEvent) => {
			e.preventDefault();
			this.moving();
			// A pinch arrives as ctrlKey; Cmd/Ctrl with a mouse wheel zooms the same way.
			if (e.ctrlKey || e.metaKey) {
				this.zooming();
				this.scale = this.clampScale(
					this.scale * Math.exp(-e.deltaY * PINCH_SENSITIVITY),
				);
				this.scheduleTransform();
				this.updateToolbar();
			} else {
				this.translateX -= e.deltaX * 1.5;
				this.translateY -= e.deltaY * 1.5;
				this.scheduleTransform();
			}
		});

		// Mouse drag to pan.
		let moveHandler: ((e: MouseEvent) => void) | null = null;
		let upHandler: (() => void) | null = null;
		container.addEventListener("mousedown", (e: MouseEvent) => {
			this.panned = false;
			// Only a press on the drawing pans; one beside it is a click that closes the zoom.
			if (!(e.target instanceof Element) || !this.frame?.contains(e.target)) return;
			// On text that can be selected, the press is the browser's: it starts a selection.
			const selectable = this.options.selectableText;
			if (selectable && e.target.closest(selectable)) return;
			e.preventDefault();
			this.isDragging = true;
			const startX = e.clientX - this.translateX;
			const startY = e.clientY - this.translateY;
			const downX = e.clientX;
			const downY = e.clientY;
			const frame = this.frame;
			frame.style.cursor = "grabbing";
			// Its own layer while it's carried, so a move is a composite, not a repaint of the
			// whole drawing. Dropped on release: kept, a zoomed-in drawing would stay blurry.
			frame.style.willChange = "transform";
			moveHandler = (ev: MouseEvent) => {
				if (!this.isDragging) return;
				this.translateX = ev.clientX - startX;
				this.translateY = ev.clientY - startY;
				// A real move, so the click that ends it isn't taken for a click off the drawing.
				if (Math.abs(ev.clientX - downX) > 3 || Math.abs(ev.clientY - downY) > 3) this.panned = true;
				// No easing while it follows the pointer: the 0.1s transition the plugins give the
				// frame made every move chase the pointer, a step behind.
				this.scheduleTransform();
			};
			upHandler = () => {
				this.isDragging = false;
				frame.style.cursor = "grab";
				frame.style.willChange = "";
				this.scheduleDetail();
				if (moveHandler) document.removeEventListener("mousemove", moveHandler);
				if (upHandler) document.removeEventListener("mouseup", upHandler);
				moveHandler = null;
				upHandler = null;
			};
			document.addEventListener("mousemove", moveHandler);
			document.addEventListener("mouseup", upHandler);
		});
		// The hand over the drawing only: beside it a click closes.
		container.style.cursor = "default";
		if (this.frame) this.frame.style.cursor = "grab";

		// Touch: two-finger pinch to zoom, one-finger drag to pan.
		let lastDist = 0;
		let lastX = 0;
		let lastY = 0;
		const dist = (touches: TouchList): number => {
			const a = touches[0];
			const b = touches[1];
			if (!a || !b) return 0;
			return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
		};
		container.addEventListener(
			"touchstart",
			(e: TouchEvent) => {
				e.preventDefault();
				if (e.touches.length === 2) {
					lastDist = dist(e.touches);
				} else if (e.touches.length === 1) {
					const t = e.touches[0];
					if (t) {
						lastX = t.clientX;
						lastY = t.clientY;
					}
				}
			},
			{ passive: false },
		);
		container.addEventListener(
			"touchmove",
			(e: TouchEvent) => {
				e.preventDefault();
				this.moving();
				if (e.touches.length === 2) {
					this.zooming();
					const d = dist(e.touches);
					if (lastDist > 0) {
						// Already proportional: the ratio is how much the fingers spread.
						this.scale = this.clampScale(this.scale * (d / lastDist));
						this.scheduleTransform();
						this.updateToolbar();
					}
					lastDist = d;
				} else if (e.touches.length === 1) {
					const t = e.touches[0];
					if (t) {
						this.translateX += t.clientX - lastX;
						this.translateY += t.clientY - lastY;
						lastX = t.clientX;
						lastY = t.clientY;
						this.scheduleTransform();
					}
				}
			},
			{ passive: false },
		);
		container.addEventListener("touchend", (e: TouchEvent) => {
			if (e.touches.length < 2) lastDist = 0;
			// One finger left after a pinch: re-anchor the pan origin so the next
			// single-finger move doesn't jump from a stale position.
			if (e.touches.length === 1) {
				const t = e.touches[0];
				if (t) {
					lastX = t.clientX;
					lastY = t.clientY;
				}
			}
		});
	}

	private createToolbar(): void {
		if (!this.overlay) return;
		this.toolbar = this.overlay.createDiv(`${this.options.cssPrefix}-toolbar`);

		const out = this.toolbar.createEl("button");
		out.textContent = "−";
		out.setAttribute("aria-label", "Zoom out");
		out.addEventListener("click", () => this.zoomBy(0.9));

		const reset = this.toolbar.createEl("button", { cls: "zoom-reset-btn" });
		reset.setAttribute("aria-label", "Fit to screen");
		setIcon(reset, "rotate-ccw");
		reset.addEventListener("click", () => this.resetZoom());

		const info = this.toolbar.createEl("span", { cls: "zoom-info" });
		info.textContent = "100%";

		const inBtn = this.toolbar.createEl("button");
		inBtn.textContent = "+";
		inBtn.setAttribute("aria-label", "Zoom in");
		inBtn.addEventListener("click", () => this.zoomBy(1.1));

		this.updateToolbar();
	}

	/**
	 * Quote the zoom against the fit-to-screen scale the overlay opened at, so that
	 * reads 100%. The raw transform scale is meaningless to a reader: the overlay is
	 * ~5× the size a drawing takes in a note, so opening it would announce "563%" while
	 * showing the drawing at exactly the size it was authored.
	 */
	private updateToolbar(): void {
		const info = this.toolbar?.querySelector(".zoom-info");
		if (info) {
			info.textContent = `${Math.round((this.scale / this.initialScale) * 100)}%`;
		}
	}

	private zoomBy(factor: number): void {
		this.scale = this.clampScale(this.scale * factor);
		this.updateTransform();
		this.updateToolbar();
		this.scheduleDetail();
	}

	private clampScale(next: number): number {
		return Math.max(MIN_SCALE, Math.min(next, MAX_SCALE));
	}

	private resetZoom(): void {
		this.scale = this.initialScale;
		this.translateX = 0;
		this.translateY = 0;
		this.updateTransform();
		this.updateToolbar();
		this.scheduleDetail();
	}

	/**
	 * Apply the transform on the next frame, without easing — for the pointer, wheel and touch
	 * moves that arrive several to a frame. Each wrote the style straight away, so a 120Hz
	 * trackpad or a fast mouse restyled the drawing more often than it could be drawn.
	 */
	private scheduleTransform(): void {
		if (this.transformFrame !== null) return;
		this.transformFrame = window.requestAnimationFrame(() => {
			this.transformFrame = null;
			this.updateTransform(true);
		});
	}

	/**
	 * The drawing on its own layer while a wheel or touch gesture moves it, let go of once
	 * the gesture has rested for SETTLE_MS. Without it every frame of a two-finger scroll or a
	 * pinch repainted the whole drawing — slight for a Mermaid diagram, but an Excalidraw
	 * drawing's hand-drawn strokes are thousands of path points, and it stuttered. On its
	 * layer a move is a composite; a zoom scales the picture already drawn, a little soft until
	 * it rests and is drawn again at its new size. (A mouse drag does the same, see mousedown.)
	 */
	private moving(): void {
		const frame = this.frame;
		if (!frame) return;
		frame.style.willChange = "transform";
		if (this.settleTimer !== null) window.clearTimeout(this.settleTimer);
		this.settleTimer = window.setTimeout(() => {
			this.settleTimer = null;
			this.showVector();
			this.scheduleDetail();
			if (!this.isDragging && this.frame === frame) frame.style.willChange = "";
		}, SETTLE_MS);
	}

	/**
	 * Show the drawing as a picture of itself while it's zoomed, the SVG back once the zoom
	 * rests (moving's settle). Even on its own layer, a scale that changes has the browser
	 * draw an SVG again, and an Excalidraw drawing's thousands of hand-drawn path points made
	 * every step of a pinch stutter; an image it scales from the picture it has. Nothing is
	 * made here, in the gesture — making the picture (serializing an SVG with its fonts) is
	 * what made the first pinch after opening stutter; see prepareStandIn. Not ready yet,
	 * the SVG zooms as before.
	 */
	private zooming(): void {
		if (this.standIn?.svg === this.current) this.showStandIn();
	}

	/**
	 * Make the picture zooming shows, while nothing else is going on, as a drawing is put on
	 * show: from `src` when there is one (the <img> the drawing was in the note — nothing to
	 * make), else from the SVG, serialized with its fonts. Decoded ahead, so the first zoom
	 * finds it ready.
	 */
	private prepareStandIn(src?: string): void {
		if (!this.options.rasterWhileZooming) return;
		const svg = this.current;
		const frame = this.frame;
		if (!frame || !(svg instanceof SVGElement)) return;
		whenIdle(() => {
			if (this.current !== svg || this.frame !== frame || this.standIn?.svg === svg) return;
			this.dropStandIn();
			let url = src ?? "";
			let owned = false;
			if (!url) {
				const markup = new XMLSerializer().serializeToString(svg);
				url = URL.createObjectURL(new Blob([markup], { type: "image/svg+xml" }));
				owned = true;
			}
			const el = frame.doc.createElement("div");
			el.className = `${this.options.cssPrefix}-stand-in`;
			el.style.cssText = `position:absolute;left:0;top:0;width:${svg.style.width};height:${svg.style.height};display:none;pointer-events:none;`;
			if (svg.style.filter) el.style.filter = svg.style.filter;
			const base = el.createEl("img");
			base.style.cssText = "position:absolute;left:0;top:0;width:100%;height:100%;";
			base.decoding = "async";
			const standIn: StandIn = { svg, el, base, urls: owned ? [url] : [], ready: false, source: null, detail: null };
			// A bitmap, not the SVG as an image: an SVG image is still drawn again at each scale,
			// and zoomed in, its layer is the drawing's size times the zoom times the screen's
			// density — tens of thousands of pixels across, drawn again tile by tile as zooming
			// out brought more of it into view. A bitmap at a capped size is scaled, not drawn.
			const source = new Image();
			source.decoding = "async";
			source.src = url;
			void source
				.decode()
				.then(() => toBitmapUrl(source, parseFloat(svg.style.width), parseFloat(svg.style.height), this.initialScale))
				.then((png) => {
					if (this.standIn !== standIn) {
						URL.revokeObjectURL(png);
						return;
					}
					standIn.urls.push(png);
					// Kept for the detail, which is drawn from it.
					standIn.source = source;
					base.src = png;
					return base.decode().then(() => {
						if (this.standIn !== standIn) return;
						standIn.ready = true;
						// Zooming already: take over now.
						if (this.settleTimer !== null) this.showStandIn();
						else this.scheduleDetail();
					});
				})
				.catch(() => {
					if (this.standIn === standIn) this.dropStandIn();
				});
			frame.style.position = "relative";
			frame.appendChild(el);
			this.standIn = standIn;
		});
	}

	/** Make the stand-in's detail once the view has rested a moment; see refreshDetail. */
	private scheduleDetail(): void {
		if (!this.standIn) return;
		if (this.detailTimer !== null) window.clearTimeout(this.detailTimer);
		// Past the 0.1s easing the toolbar's buttons give a zoom, so the view measured is the one it ends at.
		this.detailTimer = window.setTimeout(() => {
			this.detailTimer = null;
			whenIdle(() => this.refreshDetail());
		}, DETAIL_DELAY_MS);
	}

	/**
	 * Draw the part of the drawing around the screen, as sharp as it's shown now, over the
	 * stand-in. The whole-drawing bitmap is only as sharp as the drawing was when the zoom
	 * opened; zoomed in past that, the step from the SVG to it at the start of a zoom, and back
	 * at its end, was a step from sharp to soft and back — a jolt each time. With this over it,
	 * a zoom starts from a picture of just what was on screen; only the drawing newly brought
	 * into view while zooming out, past the margin, is the softer whole.
	 */
	private refreshDetail(): void {
		const standIn = this.standIn;
		const source = standIn?.source;
		const overlay = this.overlay;
		if (!standIn || !source || !overlay || standIn.svg !== this.current || this.settleTimer !== null) return;
		const svg = standIn.svg as SVGElement;
		const width = parseFloat(svg.style.width);
		const height = parseFloat(svg.style.height);
		const rect = svg.getBoundingClientRect();
		const view = overlay.getBoundingClientRect();
		if (!(width > 0) || !(height > 0) || rect.width <= 0) return;
		// Screen px per px of the drawing, and the part of the drawing on screen.
		const per = rect.width / width;
		const left = (Math.max(view.left, rect.left) - rect.left) / per;
		const right = (Math.min(view.right, rect.right) - rect.left) / per;
		const top = (Math.max(view.top, rect.top) - rect.top) / per;
		const bottom = (Math.min(view.bottom, rect.bottom) - rect.top) / per;
		if (right <= left || bottom <= top) return;
		const marginX = (right - left) * DETAIL_MARGIN;
		const marginY = (bottom - top) * DETAIL_MARGIN;
		const x0 = Math.max(0, Math.floor(left - marginX));
		const y0 = Math.max(0, Math.floor(top - marginY));
		const x1 = Math.min(width, Math.ceil(right + marginX));
		const y1 = Math.min(height, Math.ceil(bottom + marginY));
		const k = Math.min(Math.max(window.devicePixelRatio, 1) * per, STAND_IN_MAX_PX / Math.max(x1 - x0, y1 - y0));
		// The whole is as sharp already: nothing to add.
		if (k <= (standIn.base.naturalWidth / width) * 1.05) {
			this.setDetail(standIn, null);
			return;
		}
		const key = `${x0},${y0},${x1},${y1},${k.toFixed(3)}`;
		if (standIn.detail?.key === key) return;
		const canvas = svg.doc.createElement("canvas");
		canvas.width = Math.max(1, Math.round((x1 - x0) * k));
		canvas.height = Math.max(1, Math.round((y1 - y0) * k));
		const ctx = canvas.getContext("2d");
		if (!ctx) return;
		// An SVG image draws as vectors at the size it's drawn at: the part, sharp.
		const sx = source.naturalWidth / width;
		const sy = source.naturalHeight / height;
		ctx.drawImage(source, x0 * sx, y0 * sy, (x1 - x0) * sx, (y1 - y0) * sy, 0, 0, canvas.width, canvas.height);
		canvas.toBlob((blob) => {
			if (!blob || this.standIn !== standIn) return;
			const url = URL.createObjectURL(blob);
			const img = svg.doc.createElement("img");
			img.decoding = "async";
			img.style.cssText = `position:absolute;left:${x0}px;top:${y0}px;width:${x1 - x0}px;height:${y1 - y0}px;`;
			img.src = url;
			img.decode()
				.then(() => {
					// Zooming meanwhile: swapped in now, the picture would sharpen mid-zoom. The next
					// rest makes it again.
					if (this.standIn !== standIn || this.settleTimer !== null) URL.revokeObjectURL(url);
					else this.setDetail(standIn, { img, url, key });
				})
				.catch(() => URL.revokeObjectURL(url));
		}, "image/png");
	}

	private setDetail(standIn: StandIn, detail: StandIn["detail"]): void {
		const old = standIn.detail;
		if (old) {
			old.img.remove();
			URL.revokeObjectURL(old.url);
		}
		standIn.detail = detail;
		if (detail) standIn.el.appendChild(detail.img);
	}

	private showStandIn(): void {
		const standIn = this.standIn;
		if (!standIn?.ready) return;
		if (this.fadeTimer !== null) window.clearTimeout(this.fadeTimer);
		this.fadeTimer = null;
		standIn.el.style.transition = "none";
		standIn.el.style.opacity = "1";
		standIn.el.style.display = "block";
		(standIn.svg as SVGElement).style.visibility = "hidden";
		// No layer of its own while the bitmap stands in: a layer is kept at the scale it was
		// made at, which zoomed in is enormous; the bitmap is cheap to draw at any scale.
		if (this.frame && !this.isDragging) this.frame.style.willChange = "";
	}

	/**
	 * The SVG back once a zoom rests. Shown under the stand-in first and the stand-in faded out
	 * over it once the SVG has been drawn: swapped at once, the moment the browser took to draw
	 * the SVG and the step from the picture to the sharp drawing showed as a jolt.
	 */
	private showVector(immediately = false): void {
		const standIn = this.standIn;
		if (!standIn) return;
		(standIn.svg as SVGElement).style.visibility = "";
		const el = standIn.el;
		if (this.fadeTimer !== null) window.clearTimeout(this.fadeTimer);
		this.fadeTimer = null;
		if (immediately || el.style.display === "none") {
			el.style.display = "none";
			return;
		}
		// Two frames: the SVG is drawn in the first, under the picture still on top.
		window.requestAnimationFrame(() =>
			window.requestAnimationFrame(() => {
				if (this.standIn !== standIn || this.settleTimer !== null) return;
				el.style.transition = `opacity ${FADE_MS}ms ease-out`;
				el.style.opacity = "0";
				this.fadeTimer = window.setTimeout(() => {
					this.fadeTimer = null;
					el.style.display = "none";
					el.style.transition = "none";
					el.style.opacity = "1";
				}, FADE_MS + 20);
			}),
		);
	}

	private dropStandIn(): void {
		const standIn = this.standIn;
		if (!standIn) return;
		this.showVector(true);
		if (this.detailTimer !== null) window.clearTimeout(this.detailTimer);
		this.detailTimer = null;
		this.setDetail(standIn, null);
		standIn.el.remove();
		for (const url of standIn.urls) URL.revokeObjectURL(url);
		this.standIn = null;
	}

	private updateTransform(disableTransition = false): void {
		if (!this.frame) return;
		this.frame.style.transition = disableTransition ? "none" : "";
		this.frame.style.transform = `translate(${this.translateX}px, ${this.translateY}px) scale(${this.scale})`;
	}

	private close(): void {
		if (!this.overlay) return;
		if (this.transformFrame !== null) window.cancelAnimationFrame(this.transformFrame);
		this.transformFrame = null;
		if (this.settleTimer !== null) window.clearTimeout(this.settleTimer);
		this.settleTimer = null;
		this.dropStandIn();
		this.resetGallery();
		this.overlay.style.display = "none";
		this.overlay.empty();
		this.current = null;
		this.frame = null;
		this.toolbar = null;
		this.isDragging = false;
	}
}

/** The drawing as pictures of itself, shown in its place while zooming; see zooming. */
interface StandIn {
	svg: Element;
	/** What's shown and faded: the whole drawing, with the detail over it. */
	el: HTMLElement;
	base: HTMLImageElement;
	/** Object URLs it owns: the SVG's, when serialized here, and the bitmap's. */
	urls: string[];
	ready: boolean;
	/** The drawing as an image, decoded: what the detail is drawn from. */
	source: HTMLImageElement | null;
	/** The part around the screen at the scale it was last shown at; see refreshDetail. */
	detail: { img: HTMLImageElement; url: string; key: string } | null;
}

/** Longest side of the bitmap a drawing stands in as while zoomed; see zooming. */
const STAND_IN_MAX_PX = 4096;
/** How long the stand-in takes to fade out over the SVG once a zoom rests; see showVector. */
const FADE_MS = 150;
/** How long a view rests before the stand-in's detail is made for it; see scheduleDetail. */
const DETAIL_DELAY_MS = 200;
/** How much of the drawing around the screen the detail takes in, each side, as a share of what's on it. */
const DETAIL_MARGIN = 0.2;

/** Run when the page is idle, or soon. */
function whenIdle(run: () => void): void {
	if (typeof window.requestIdleCallback === "function") window.requestIdleCallback(run, { timeout: 1000 });
	else window.setTimeout(run, 200);
}

/** Run `run` once what's on screen now has been painted: the next frame, then a task past it. */
function afterPaint(run: () => void): void {
	window.requestAnimationFrame(() => window.setTimeout(run, 0));
}

/**
 * An image drawn to a PNG as sharp as the drawing is at the scale the zoom opened at, on this
 * screen (so the step back to the SVG, at about that scale, isn't one in sharpness), its
 * longest side capped at STAND_IN_MAX_PX; an object URL.
 */
function toBitmapUrl(image: HTMLImageElement, width: number, height: number, scale: number): Promise<string> {
	const w = width > 0 ? width : image.naturalWidth;
	const h = height > 0 ? height : image.naturalHeight;
	const sharp = Math.max(window.devicePixelRatio, 1) * Math.max(scale, 1);
	const k = Math.min(sharp, STAND_IN_MAX_PX / Math.max(w, h, 1));
	const canvas = image.doc.createElement("canvas");
	canvas.width = Math.max(1, Math.round(w * k));
	canvas.height = Math.max(1, Math.round(h * k));
	const ctx = canvas.getContext("2d");
	if (!ctx) return Promise.reject(new Error("no 2d context"));
	ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
	return new Promise((resolve, reject) =>
		canvas.toBlob((blob) => (blob ? resolve(URL.createObjectURL(blob)) : reject(new Error("no bitmap"))), "image/png"),
	);
}
