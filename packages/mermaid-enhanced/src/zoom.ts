import { Platform, Plugin } from "obsidian";

/**
 * Click-to-zoom for Mermaid diagrams (originally the SVG half of the retired
 * image-zoom plugin). A click opens a full-screen overlay holding a clone of the
 * diagram that can be zoomed (buttons / wheel-pinch / two-finger pinch) and panned
 * (drag / two-finger). Requires Cmd/Ctrl on desktop so it never swallows the plain
 * click that positions the cursor in Live Preview; on mobile a plain tap is enough.
 *
 * The click is claimed in the capture phase and stopped there (see register), so a
 * diagram never also reaches Obsidian's own handling or another plugin listening on
 * the bubble — one click can only ever produce this one overlay.
 */
export class MermaidZoom {
	private overlay: HTMLElement | null = null;
	private current: SVGElement | null = null;
	private toolbar: HTMLElement | null = null;
	private scale = 1;
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

		// Capture phase so a diagram click is ours alone; non-diagram clicks fall
		// through untouched.
		this.plugin.registerDomEvent(
			document,
			"click",
			(event: MouseEvent) => {
				// Desktop requires Cmd/Ctrl; mobile is a plain tap.
				if (!this.isMobile && !event.metaKey && !event.ctrlKey) return;
				const svg = this.mermaidTargetFor(event.target as HTMLElement);
				if (!svg) return;
				event.preventDefault();
				event.stopPropagation();
				event.stopImmediatePropagation();
				this.showZoomed(svg);
			},
			{ capture: true },
		);
	}

	/** The Mermaid SVG a click over `target` should zoom, or null. */
	private mermaidTargetFor(target: HTMLElement): SVGElement | null {
		const svg = target.closest("svg");
		if (!svg) return null;
		const mermaid = svg.closest(".mermaid");
		if (!mermaid) return null;
		// Only within a Markdown leaf (reading view or live preview).
		if (!mermaid.closest('.workspace-leaf-content[data-type="markdown"]')) {
			return null;
		}
		return svg as SVGElement;
	}

	private createOverlay(): void {
		const overlay = document.body.createDiv("mermaid-zoom-overlay");
		overlay.style.display = "none";
		this.overlay = overlay;
		this.plugin.register(() => overlay.remove());

		// Desktop: click the backdrop to close.
		overlay.addEventListener("click", (e) => {
			if (e.target === overlay) this.close();
		});

		// Mobile: the container fills most of the screen, so a tap in the black
		// area around the diagram lands on the container, not the overlay. Treat a
		// tap (negligible movement) on either as a backdrop tap; movement is a
		// pan/pinch, not a dismiss. Taps on the diagram / toolbar keep their own
		// handlers.
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
					target.classList.contains("mermaid-zoom-container")
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

	private showZoomed(svg: SVGElement): void {
		if (!this.overlay) return;
		this.scale = 1;
		this.translateX = 0;
		this.translateY = 0;
		this.overlay.empty();

		const container = this.overlay.createDiv("mermaid-zoom-container");

		// Clone so we never mutate the diagram in the note. Drop the fit plugin's
		// inline sizing so the overlay copy renders at its natural size.
		const clone = svg.cloneNode(true) as SVGElement;
		clone.style.maxWidth = "100%";
		clone.style.maxHeight = "100%";
		clone.style.width = "auto";
		clone.style.height = "auto";
		container.appendChild(clone);
		this.current = clone;

		this.setupZoomAndDrag(container);
		this.createToolbar();

		this.overlay.style.display = "flex";
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
		this.toolbar = this.overlay.createDiv("mermaid-zoom-toolbar");

		const out = this.toolbar.createEl("button");
		out.textContent = "−";
		out.setAttribute("aria-label", "Zoom out");
		out.addEventListener("click", () => this.zoomBy(0.9));

		const reset = this.toolbar.createEl("button", { cls: "zoom-reset-btn" });
		reset.setAttribute("aria-label", "Reset to 100%");
		reset.textContent = "⟲";
		reset.addEventListener("click", () => this.resetZoom());

		const info = this.toolbar.createEl("span", { cls: "zoom-info" });
		info.textContent = "100%";

		const inBtn = this.toolbar.createEl("button");
		inBtn.textContent = "+";
		inBtn.setAttribute("aria-label", "Zoom in");
		inBtn.addEventListener("click", () => this.zoomBy(1.1));

		this.updateToolbar();
	}

	private updateToolbar(): void {
		const info = this.toolbar?.querySelector(".zoom-info");
		if (info) info.textContent = `${Math.round(this.scale * 100)}%`;
	}

	private zoomBy(factor: number): void {
		this.scale = Math.max(0.1, Math.min(this.scale * factor, 50));
		this.updateTransform();
		this.updateToolbar();
	}

	private resetZoom(): void {
		this.scale = 1;
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
