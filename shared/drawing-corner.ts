/*
 * A drawing's buttons on its own top-right corner, as an image's are (Obsidian 1.15): a Mermaid
 * diagram's (Mermaid (Enhanced)) and an Excalidraw drawing's (Excalidraw (Enhanced)), whose
 * blocks are as wide as the note while the drawing may be narrower. And the size slider left of
 * those buttons, dragged while the drawing — and its corner — change size under it.
 */

/** How far in from the drawing's corner its buttons sit, as an image's. */
const INSET = 8;
/** The room between the slider and the buttons. */
const GAP = 6;
/** The slider's width: as much as the drawing leaves beside its buttons, within these. */
const SLIDER_MAX_WIDTH = 100;
const SLIDER_MIN_WIDTH = 48;

/**
 * The slider's width by a drawing `width` wide with buttons `actionsWidth` wide: across what
 * the drawing leaves left of them. At its full width beside a narrow drawing — a tall one, or
 * one sized down — it ran out past the drawing's left edge.
 */
function sliderWidthBy(width: number, actionsWidth: number): number {
	return Math.round(Math.min(SLIDER_MAX_WIDTH, Math.max(SLIDER_MIN_WIDTH, width - 2 * INSET - actionsWidth - GAP)));
}

/**
 * Class on a drawing's host while its slider is dragged: the plugin's stylesheet hides the
 * buttons then (see dragFitSlider).
 */
export const DRAGGING_CLS = "drawing-fit-dragging";

/** Custom properties a plugin's stylesheet places the buttons (`.embed-actions`) by. */
export const CORNER_RIGHT_VAR = "--drawing-corner-right";
export const CORNER_TOP_VAR = "--drawing-corner-top";

/**
 * Keeps `host` (the block, positioned, holding `.embed-actions`) told where its drawing's
 * corner is — CORNER_RIGHT_VAR and CORNER_TOP_VAR, from the host's own right and top edges —
 * as the drawing's size, or the note's width, changes; `moved` is called after, to place what
 * goes by the buttons.
 */
export class DrawingCorner {
	private readonly observer: ResizeObserver;
	private drawing: Element | null = null;
	/** The buttons, watched too: they're filled in by more than one plugin, after the slider is placed. */
	private actions: Element | null = null;
	/** The geometry last placed for; see update. */
	private last = "";
	/** Whether the buttons are left where they are; see hold. */
	private held = false;
	private frame: number | null = null;

	constructor(
		private readonly host: HTMLElement,
		private readonly moved: () => void,
	) {
		// The next frame, not in the observer's own callback: moving the buttons and the slider
		// there set it off again, over and over while a drawing was dragged to size
		// ("ResizeObserver loop completed with undelivered notifications").
		this.observer = new ResizeObserver(() => {
			if (this.frame !== null) return;
			this.frame = window.requestAnimationFrame(() => {
				this.frame = null;
				this.update();
			});
		});
		this.observer.observe(host);
	}

	/** Follow `drawing`: a drawing drawn again in place is a new element. */
	follow(drawing: Element): void {
		if (drawing === this.drawing) return;
		this.last = "";
		if (this.drawing) this.observer.unobserve(this.drawing);
		this.drawing = drawing;
		this.observer.observe(drawing);
		this.update();
	}

	/**
	 * While the drawing's slider is dragged: the buttons out of sight (DRAGGING_CLS) and the
	 * slider left where it is, under the pointer. Let go, both go to the corner the drawing has
	 * come to.
	 */
	hold(held: boolean): void {
		this.held = held;
		this.host.toggleClass(DRAGGING_CLS, held);
		if (held) return;
		this.last = "";
		this.update();
	}

	update(): void {
		if (this.held) return;
		const drawing = this.drawing;
		if (!drawing?.isConnected) return;
		const actions = this.host.querySelector(":scope > .embed-actions");
		if (actions !== this.actions) {
			if (this.actions) this.observer.unobserve(this.actions);
			this.actions = actions;
			if (actions) this.observer.observe(actions);
		}
		const box = this.host.getBoundingClientRect();
		const at = drawing.getBoundingClientRect();
		if (at.width <= 0) return;
		// Nothing moved, nothing to do.
		const buttons = actions instanceof HTMLElement ? actions.offsetWidth : 0;
		const key = [box.right, box.top, at.right, at.top, at.width, buttons].map(Math.round).join();
		if (key === this.last) return;
		this.last = key;
		const right = `${Math.round(box.right - at.right + INSET)}px`;
		const top = `${Math.round(at.top - box.top + INSET)}px`;
		// Only when it changes: setting it is a change the observer of a plugin's passes sees.
		if (this.host.style.getPropertyValue(CORNER_RIGHT_VAR) !== right) this.host.style.setProperty(CORNER_RIGHT_VAR, right);
		if (this.host.style.getPropertyValue(CORNER_TOP_VAR) !== top) this.host.style.setProperty(CORNER_TOP_VAR, top);
		this.moved();
	}

	disconnect(): void {
		this.observer.disconnect();
		if (this.frame !== null) window.cancelAnimationFrame(this.frame);
		this.host.removeClass(DRAGGING_CLS);
		this.host.style.removeProperty(CORNER_RIGHT_VAR);
		this.host.style.removeProperty(CORNER_TOP_VAR);
	}
}

/**
 * Place `slider` left of the buttons `actions`, centred on them, in their positioned host, as
 * wide as `drawing` leaves room for. Where the buttons are going, not where they are: they ease
 * to a corner that moved, and read mid-way, the slider was left somewhere along the way.
 */
export function placeSlider(slider: HTMLElement, actions: HTMLElement | null, drawing: Element | null): void {
	const host = slider.offsetParent;
	if (!(host instanceof HTMLElement) || !actions) return;
	const width = actions.offsetWidth;
	if (width <= 0) return;
	const right = parseFloat(host.style.getPropertyValue(CORNER_RIGHT_VAR));
	const top = parseFloat(host.style.getPropertyValue(CORNER_TOP_VAR));
	const box = host.getBoundingClientRect();
	const at = actions.getBoundingClientRect();
	const actionsRight = Number.isFinite(right) ? right : box.right - at.right;
	const actionsTop = Number.isFinite(top) ? top : at.top - box.top;
	const room = drawing ? drawing.getBoundingClientRect().width : 0;
	slider.setCssProps({
		width: `${room > 0 ? sliderWidthBy(room, width) : SLIDER_MAX_WIDTH}px`,
		right: `${Math.round(actionsRight + width + GAP)}px`,
		top: `${Math.round(actionsTop + (actions.offsetHeight - slider.offsetHeight) / 2)}px`,
	});
}

export interface FitDrag {
	/** The drawing's corner, its buttons held where they are while the slider is dragged. */
	corner: DrawingCorner | null;
	/** Size the drawing to `value` while it's dragged. */
	apply: (value: number) => void;
	/** Let go at `value`. */
	done: (value: number) => void;
}

/**
 * Drag a size slider that sits by a drawing's buttons, on the drawing's corner. The drawing is
 * sized about its middle, so the corner moves as it's dragged; a slider that went with it left
 * the pointer behind (its value ran to an end under the browser's own drag, and a drag of our
 * own left the thumb elsewhere). So the slider stays where it is while it's dragged — the
 * browser's own drag, the thumb under the pointer — and the buttons, which go with the corner,
 * are out of sight meanwhile rather than pulling away from it; let go, they come back on the
 * corner, the slider easing to them.
 */
export function dragFitSlider(slider: HTMLInputElement, event: PointerEvent, fit: FitDrag): void {
	if (event.button !== 0) return;
	fit.corner?.hold(true);
	let value = Number(slider.value);
	const input = (): void => {
		const next = Number(slider.value);
		if (next === value) return;
		value = next;
		fit.apply(value);
	};
	const win = slider.ownerDocument.defaultView ?? window;
	let ended = false;
	const end = (): void => {
		if (ended) return;
		ended = true;
		slider.removeEventListener("input", input);
		win.removeEventListener("pointerup", end, true);
		win.removeEventListener("pointercancel", end, true);
		win.removeEventListener("blur", end);
		fit.done(value);
		fit.corner?.hold(false);
	};
	slider.addEventListener("input", input);
	win.addEventListener("pointerup", end, true);
	win.addEventListener("pointercancel", end, true);
	win.addEventListener("blur", end);
}
