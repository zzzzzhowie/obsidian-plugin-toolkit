import { Platform, Plugin, setIcon } from "obsidian";

/**
 * What a click can open in the overlay: a Mermaid diagram's `<svg>`, or an embedded
 * Excalidraw drawing, which is an `<svg>` or an `<img>` depending on that plugin's
 * preview-image setting. Both element kinds are handled throughout.
 */
export type ZoomTarget = SVGElement | HTMLImageElement;

/** A drawing the zoom can page to; see {@link ZoomOverlayOptions.gallery}. */
export interface GalleryItem {
	/** Its name under the thumbnail: a diagram's caption, say. */
	label: string;
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
		// Only within a Markdown leaf (reading view or live preview) — which also keeps
		// the overlay's own clone, mounted on body, from re-triggering.
		if (!el.closest(NOTE_CONTAINER)) return null;
		return el;
	}

	private createOverlay(): void {
		const overlay = document.body.createDiv(`${this.options.cssPrefix}-overlay`);
		overlay.style.display = "none";
		this.overlay = overlay;
		this.plugin.register(() => overlay.remove());

		// Desktop: click the backdrop to close — but not the click that ends a drag selecting
		// text and lets go past the drawing, which lands on the backdrop as well.
		overlay.addEventListener("click", (e) => {
			if (e.target !== overlay) return;
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
		this.mountDrawing(shown);
		this.createToolbar();
		this.overlay.style.display = "flex";
		this.fitToRoom();
		if (this.options.gallery) void this.loadGallery(target, shown, this.options.gallery);
	}

	/** Put a clone of `target` on show, replacing the one there, at the fit-to-screen scale. */
	private mountDrawing(target: ZoomTarget): void {
		if (!this.overlay) return;
		this.translateX = 0;
		this.translateY = 0;
		this.overlay.querySelector(`:scope > .${this.options.cssPrefix}-container`)?.remove();
		const container = createDiv(`${this.options.cssPrefix}-container`);
		this.overlay.prepend(container);

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

	/** Thumbnails of the gallery under the toolbar, and previous / next on the toolbar. */
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

		const strip = this.overlay.createDiv(`${prefix}-strip`);
		this.strip = strip;
		gallery.items.forEach((item, index) => {
			const thumb = strip.createEl("button", { cls: `${prefix}-thumb`, attr: { "aria-label": item.label } });
			const picture = thumb.createDiv(`${prefix}-thumb-picture`);
			thumb.createDiv({ cls: `${prefix}-thumb-label`, text: item.label });
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

	private markCurrent(): void {
		const index = this.gallery?.index ?? -1;
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
			this.mountDrawing(drawing);
			this.fitToRoom();
			this.markCurrent();
		});
	}

	private resetGallery(): void {
		this.galleryToken++;
		this.gallery = null;
		this.galleryDrawings.clear();
		this.strip = null;
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
		if (this.strip) {
			const own = getComputedStyle(this.strip);
			toolbarHeight += this.strip.getBoundingClientRect().height + px(own.marginTop) + px(own.marginBottom);
		}
		let padX = 0;
		let padY = 0;
		for (const el of [frame, clone]) {
			const own = getComputedStyle(el);
			padX += px(own.paddingLeft) + px(own.paddingRight);
			padY += px(own.paddingTop) + px(own.paddingBottom);
		}
		// A margin around the drawing: 90% across, and down what the toolbar (and a strip)
		// leave, less a little — taking 10% of the whole height on top of the bars had left
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
			// A pinch arrives as ctrlKey; Cmd/Ctrl with a mouse wheel zooms the same way.
			if (e.ctrlKey || e.metaKey) {
				this.scale = this.clampScale(
					this.scale * Math.exp(-e.deltaY * PINCH_SENSITIVITY),
				);
				this.updateTransform(true);
				this.updateToolbar();
			} else {
				this.translateX -= e.deltaX * 1.5;
				this.translateY -= e.deltaY * 1.5;
				this.updateTransform(true);
			}
		});

		// Mouse drag to pan.
		let moveHandler: ((e: MouseEvent) => void) | null = null;
		let upHandler: (() => void) | null = null;
		container.addEventListener("mousedown", (e: MouseEvent) => {
			// On text that can be selected, the press is the browser's: it starts a selection.
			const selectable = this.options.selectableText;
			if (selectable && e.target instanceof Element && e.target.closest(selectable)) return;
			e.preventDefault();
			this.isDragging = true;
			const startX = e.clientX - this.translateX;
			const startY = e.clientY - this.translateY;
			container.style.cursor = "grabbing";
			moveHandler = (ev: MouseEvent) => {
				if (!this.isDragging) return;
				this.translateX = ev.clientX - startX;
				this.translateY = ev.clientY - startY;
				this.updateTransform();
			};
			upHandler = () => {
				this.isDragging = false;
				container.style.cursor = "grab";
				if (moveHandler) document.removeEventListener("mousemove", moveHandler);
				if (upHandler) document.removeEventListener("mouseup", upHandler);
				moveHandler = null;
				upHandler = null;
			};
			document.addEventListener("mousemove", moveHandler);
			document.addEventListener("mouseup", upHandler);
		});
		container.style.cursor = "grab";

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
				if (e.touches.length === 2) {
					const d = dist(e.touches);
					if (lastDist > 0) {
						// Already proportional: the ratio is how much the fingers spread.
						this.scale = this.clampScale(this.scale * (d / lastDist));
						this.updateTransform(true);
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
						this.updateTransform(true);
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
	}

	private updateTransform(disableTransition = false): void {
		if (!this.frame) return;
		this.frame.style.transition = disableTransition ? "none" : "";
		this.frame.style.transform = `translate(${this.translateX}px, ${this.translateY}px) scale(${this.scale})`;
	}

	private close(): void {
		if (!this.overlay) return;
		this.resetGallery();
		this.overlay.style.display = "none";
		this.overlay.empty();
		this.current = null;
		this.frame = null;
		this.toolbar = null;
		this.isDragging = false;
	}
}
