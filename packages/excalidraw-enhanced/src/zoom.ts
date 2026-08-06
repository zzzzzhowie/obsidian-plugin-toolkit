import { Platform, Plugin, setIcon } from "obsidian";

/**
 * What a click can open in the overlay. The Excalidraw plugin renders an embedded
 * drawing as an `<img>` (its "PNG Image" / "SVG Image" preview types) or as an inline
 * `<svg>` ("Native SVG"), so both have to be handled.
 */
type ZoomTarget = SVGElement | HTMLImageElement;

/**
 * The embedded drawing itself. Excalidraw stamps this class on whatever element it
 * rendered — its `setStyle` does it for every preview type — so the one selector covers
 * all three.
 */
const ZOOM_TARGET = ".excalidraw-embedded-img";

/** Rendered-note containers; anything outside one is not a drawing in a note. */
const NOTE_CONTAINER = ".workspace-leaf-content[data-type=\"markdown\"]";

/**
 * Click-to-zoom for embedded Excalidraw drawings (ported from Mermaid Enhanced, which
 * got it from the retired image-zoom plugin). A click opens a full-screen overlay
 * holding a clone of the drawing that can be zoomed (buttons / wheel-pinch / two-finger
 * pinch) and panned (drag / two-finger). Requires Cmd/Ctrl on desktop so it never
 * swallows the plain click that positions the cursor in Live Preview; on mobile a plain
 * tap is enough.
 *
 * The click is claimed in the capture phase and stopped there (see register), so a
 * drawing never also reaches Obsidian's own handling or another plugin listening on the
 * bubble — one click can only ever produce this one overlay. For Excalidraw that also
 * means a modifier-click no longer opens the drawing in a new pane; a plain click still
 * does, since we ignore clicks without the modifier.
 */
export class ExcalidrawZoom {
	private overlay: HTMLElement | null = null;
	private current: ZoomTarget | null = null;
	private toolbar: HTMLElement | null = null;
	private scale = 1;
	/** The fit-to-screen scale the overlay opened at; what "reset" returns to. */
	private initialScale = 1;
	private translateX = 0;
	private translateY = 0;
	private isDragging = false;

	private get isMobile(): boolean {
		return Platform.isMobile;
	}

	constructor(private readonly plugin: Plugin) {}

	/** Build the overlay and wire the trigger + dismissal listeners. */
	register(): void {
		this.createOverlay();

		// Capture phase so a drawing click is ours alone; other clicks fall through
		// untouched.
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
				this.showZoomed(target);
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
				// Cleared (not left set) as soon as the modifier comes back up. Excalidraw
				// rewrites the whole style attribute when it re-renders an embed, which
				// only means the hint is re-applied on the next move.
				target.style.cursor = event.metaKey || event.ctrlKey ? "zoom-in" : "";
			});
		}
	}

	/** The drawing a click over `target` should zoom, or null. */
	private zoomTargetFor(target: HTMLElement): ZoomTarget | null {
		const el = target.closest<ZoomTarget>(ZOOM_TARGET);
		if (!el) return null;
		// Only within a Markdown leaf (reading view or live preview) — which also keeps
		// the overlay's own clone, mounted on body, from re-triggering.
		if (!el.closest(NOTE_CONTAINER)) return null;
		return el;
	}

	private createOverlay(): void {
		const overlay = document.body.createDiv("excalidraw-zoom-overlay");
		overlay.style.display = "none";
		this.overlay = overlay;
		this.plugin.register(() => overlay.remove());

		// Desktop: click the backdrop to close.
		overlay.addEventListener("click", (e) => {
			if (e.target === overlay) this.close();
		});

		// Mobile: the container fills most of the screen, so a tap in the black area
		// around the drawing lands on the container, not the overlay. Treat a tap
		// (negligible movement) on either as a backdrop tap; movement is a pan/pinch, not
		// a dismiss. Taps on the drawing / toolbar keep their own handlers.
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
					target.classList.contains("excalidraw-zoom-container")
				) {
					this.close();
				}
			},
			{ capture: true },
		);

		// Prevent click-through.
		overlay.addEventListener("mousedown", (e) => e.stopPropagation());

		// ESC closes (desktop).
		this.plugin.registerDomEvent(document, "keydown", (e: KeyboardEvent) => {
			if (e.key === "Escape" && this.overlay?.style.display === "flex") {
				this.close();
			}
		});
	}

	private showZoomed(target: ZoomTarget): void {
		if (!this.overlay) return;
		this.translateX = 0;
		this.translateY = 0;
		this.overlay.empty();

		const container = this.overlay.createDiv("excalidraw-zoom-container");

		// Clone so we never mutate the drawing in the note, and drop the sizing that came
		// with it (Excalidraw's own max-width, and this plugin's note-sizing rule).
		const clone = target.cloneNode(true) as ZoomTarget;
		const { width, height } = this.naturalSizeOf(target);
		// Size the clone in px. `width/height: auto` collapses an SVG that ships
		// `width="100%"` plus a viewBox and no intrinsic size, which with the white
		// backing renders as a small white square instead of the drawing. Explicit px
		// also gives `transform: scale()` a real reference point, so maxWidth/maxHeight
		// must be none or they would fight the transform.
		clone.style.width = `${width}px`;
		clone.style.height = `${height}px`;
		clone.style.maxWidth = "none";
		clone.style.maxHeight = "none";
		container.appendChild(clone);
		this.current = clone;

		this.initialScale = this.initialScaleFor(width, height);
		this.scale = this.initialScale;
		this.setupZoomAndDrag(container);
		this.createToolbar();

		this.overlay.style.display = "flex";
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
			if (e.ctrlKey) {
				const delta = e.deltaY > 0 ? 0.98 : 1.02;
				this.scale = Math.max(0.1, Math.min(this.scale * delta, 50));
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
						this.scale = Math.max(0.1, Math.min(this.scale * (d / lastDist), 50));
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
		this.toolbar = this.overlay.createDiv("excalidraw-zoom-toolbar");

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
		this.scale = Math.max(0.1, Math.min(this.scale * factor, 50));
		this.updateTransform();
		this.updateToolbar();
	}

	private resetZoom(): void {
		this.scale = this.initialScale;
		this.translateX = 0;
		this.translateY = 0;
		this.updateTransform();
		this.updateToolbar();
	}

	private updateTransform(disableTransition = false): void {
		if (!this.current) return;
		this.current.style.transition = disableTransition ? "none" : "";
		this.current.style.transform = `translate(${this.translateX}px, ${this.translateY}px) scale(${this.scale})`;
	}

	private close(): void {
		if (!this.overlay) return;
		this.overlay.style.display = "none";
		this.overlay.empty();
		this.current = null;
		this.toolbar = null;
		this.isDragging = false;
	}
}
