import { type App, Platform, type Plugin, type TFile } from "obsidian";
import { DrawingCorner, dragFitSlider, placeSlider } from "../../../shared/drawing-corner";

/** The drawing's property its size in notes is kept in: `<n>vh`, or `full`. */
const FIT_KEY = "excalidraw-enhanced-fit";
/** Class on a drawing's embed sized by its property; styles.css reads FIT_VAR off it. */
const FITTED_CLS = "excalidraw-enhanced-fitted";
const FIT_VAR = "--excalidraw-enhanced-fit";
/** Class on the slider, and its tooltip (`-tip`). */
const SLIDER_CLS = "excalidraw-fit-slider";

/** Slider range, as Mermaid (Enhanced)'s: the drawing's height in % of the window's; the max fills the note's width. */
const SLIDER_MIN = 20;
const SLIDER_MAX = 100;
const SLIDER_STEP = 5;

/**
 * A size slider on each drawing in a note, as a Mermaid diagram has: dragged, the drawing is
 * sized to that share of the window's height — never wider than the note — and at the far end
 * fills the note's width. Kept in the drawing's own properties (FIT_KEY), so it's that size in
 * every note it's in; a drawing without one keeps the width in the plugin's settings.
 */
export class DrawingFit {
	/** A size just chosen, until the drawing's properties say it; see the metadata listener. */
	private readonly pending = new Map<string, string>();
	/** Each drawing's corner, its buttons kept on it (shared/drawing-corner.ts); see follow. */
	private readonly corners = new Map<HTMLElement, DrawingCorner>();
	/** What goes by a drawing's buttons — its slider, the slider's tip — placed again as they move. */
	private readonly followers = new WeakMap<HTMLElement, () => void>();

	constructor(private readonly app: App) {}

	register(plugin: Plugin): void {
		plugin.registerEvent(
			this.app.metadataCache.on("changed", (file) => {
				if (this.pending.get(file.path) === fitOf(this.app, file)) this.pending.delete(file.path);
				this.pass();
			}),
		);
		plugin.register(() => {
			for (const corner of this.corners.values()) corner.disconnect();
			this.corners.clear();
			document.querySelectorAll(`.${SLIDER_CLS}, .${SLIDER_CLS}-tip`).forEach((el) => el.remove());
			document.querySelectorAll<HTMLElement>(`.${FITTED_CLS}`).forEach((embed) => {
				embed.removeClass(FITTED_CLS);
				embed.style.removeProperty(FIT_VAR);
			});
		});
	}

	/** Size every drawing in a note by its property, and give each a slider. */
	pass(): void {
		for (const img of Array.from(document.querySelectorAll<HTMLElement>(":is(.markdown-source-view .cm-content, .markdown-preview-view) .excalidraw-embedded-img"))) {
			const embed = img.closest<HTMLElement>(".internal-embed");
			const file = embed ? this.fileOf(img) : null;
			if (!embed || !file) continue;
			this.size(embed, img, this.pending.get(file.path) ?? fitOf(this.app, file));
			this.follow(embed, img);
			// No slider on a phone (as Mermaid (Enhanced) has none there): a range control over a
			// drawing gets dragged by accident while scrolling. The size set elsewhere still applies.
			if (!Platform.isMobile && file.extension === "md") this.addSlider(embed, file);
		}
		for (const [embed, corner] of this.corners) {
			if (embed.isConnected) continue;
			corner.disconnect();
			this.corners.delete(embed);
		}
	}

	/** Size one drawing: `fit` its property's value, or null for the settings' width. */
	private size(embed: HTMLElement, img: HTMLElement, fit: string | null): void {
		const width = widthFor(img, fit);
		if (width === null) {
			if (embed.hasClass(FITTED_CLS)) {
				embed.removeClass(FITTED_CLS);
				embed.style.removeProperty(FIT_VAR);
			}
			return;
		}
		// Only when it changes: this runs on every change to the page.
		if (embed.style.getPropertyValue(FIT_VAR) !== width) embed.style.setProperty(FIT_VAR, width);
		if (!embed.hasClass(FITTED_CLS)) embed.addClass(FITTED_CLS);
	}

	/** Keep the embed's buttons on its drawing's top-right corner, as an image's are. */
	private follow(embed: HTMLElement, img: HTMLElement): void {
		let corner = this.corners.get(embed);
		if (!corner) {
			corner = new DrawingCorner(embed, () => this.followers.get(embed)?.());
			this.corners.set(embed, corner);
		}
		corner.follow(img);
	}

	private addSlider(embed: HTMLElement, file: TFile): void {
		if (embed.querySelector(`:scope > .${SLIDER_CLS}`)) return;
		const slider = embed.doc.createElement("input");
		slider.type = "range";
		slider.min = String(SLIDER_MIN);
		slider.max = String(SLIDER_MAX);
		slider.step = String(SLIDER_STEP);
		slider.className = SLIDER_CLS;
		embed.appendChild(slider);
		const tip = embed.createDiv(`${SLIDER_CLS}-tip`);
		// Excalidraw draws a drawing again in place now and then: looked for each time.
		const drawing = (): HTMLElement | null => embed.querySelector<HTMLElement>(".excalidraw-embedded-img");
		const actions = (): HTMLElement | null => embed.querySelector<HTMLElement>(":scope > .embed-actions");
		const read = (): void => {
			const img = drawing();
			if (img) slider.value = String(sliderValueOf(img, this.pending.get(file.path) ?? fitOf(this.app, file)));
		};
		let dragging = false;
		// Over the thumb, in the box the slider is placed in, which the tip is placed in too.
		const showTip = (): void => {
			const value = Number(slider.value);
			tip.setText(value >= SLIDER_MAX ? "100%" : `${value}%`);
			tip.setCssProps({
				left: `${Math.round(slider.offsetLeft + ((value - SLIDER_MIN) / (SLIDER_MAX - SLIDER_MIN)) * slider.offsetWidth)}px`,
				top: `${Math.round(slider.offsetTop - 24)}px`,
			});
			tip.addClass("is-visible");
		};
		// Left of the buttons, wherever the drawing's corner puts them; the tip with it.
		const place = (): void => {
			placeSlider(slider, actions(), drawing());
			if (dragging) showTip();
		};
		this.followers.set(embed, place);
		place();
		read();
		embed.addEventListener("pointerenter", () => {
			if (dragging) return;
			place();
			read();
		});

		// Kept from the editor (which would select the embed's markdown), Obsidian's embed click,
		// and Excalidraw's own long press, which opens the drawing.
		for (const type of ["pointerdown", "mousedown", "click", "dblclick", "touchstart", "touchmove", "touchend"]) {
			slider.addEventListener(type, (event) => event.stopPropagation(), { passive: type.startsWith("touch") });
		}
		// The drawing follows the drag, sized about its middle, the slider staying under the
		// pointer and the buttons out of sight (dragFitSlider). Let go, they come back on its
		// corner, and the size is kept in its properties. The size dragged to is the pending one
		// from the start: the pass runs on every change to the page, the slider's own tip
		// included, and put the kept size back.
		slider.addEventListener("pointerdown", (event) => {
			if (!drawing()) return;
			dragging = true;
			showTip();
			dragFitSlider(slider, event, {
				corner: this.corners.get(embed) ?? null,
				apply: (value) => {
					const fit = fitFor(value);
					this.pending.set(file.path, fit);
					const img = drawing();
					if (img) this.size(embed, img, fit);
					showTip();
				},
				done: (value) => {
					dragging = false;
					tip.removeClass("is-visible");
					this.keep(file, fitFor(value));
				},
			});
		});
	}

	/** Keep `fit` in the drawing's properties, the drawing at that size meanwhile. */
	private keep(file: TFile, fit: string): void {
		if (fitOf(this.app, file) === fit) {
			this.pending.delete(file.path);
			return;
		}
		this.pending.set(file.path, fit);
		this.pass();
		void this.app.fileManager
			.processFrontMatter(file, (frontmatter: Record<string, unknown>) => {
				frontmatter[FIT_KEY] = fit;
			})
			.catch((error: unknown) => {
				console.error("excalidraw-enhanced: couldn't keep the drawing's size", error);
				this.pending.delete(file.path);
				this.pass();
			});
	}

	/** The drawing a drawing's image shows: Excalidraw stamps its path on it. */
	private fileOf(img: HTMLElement): TFile | null {
		const source = img.getAttribute("fileSource")?.replace(/#.*$/, "");
		if (!source) return null;
		return this.app.vault.getFileByPath(source) ?? this.app.vault.getFileByPath(`${source}.md`);
	}
}

/** A drawing's size from its properties, when it's one this reads. */
function fitOf(app: App, file: TFile): string | null {
	const value: unknown = app.metadataCache.getFileCache(file)?.frontmatter?.[FIT_KEY];
	return typeof value === "string" && /^(full|\d+(\.\d+)?vh)$/.test(value.trim()) ? value.trim() : null;
}

/** A slider value as the property keeps it. */
function fitFor(value: number): string {
	return value >= SLIDER_MAX ? "full" : `${value}vh`;
}

/**
 * The width a drawing is given for `fit`, or null for none. A length either way: the drawing
 * has no size of its own to fall back on (see styles.css), so `100%` of a box sized by it came
 * to nothing. `max-width: 100%` keeps it in the note, so the full width is the window's, held to
 * the note's; a height is a width at the drawing's proportions, worked out by the browser as
 * the window is resized.
 */
function widthFor(img: HTMLElement, fit: string | null): string | null {
	if (fit === "full") return "100vw";
	const vh = fit ? /^(\d+(?:\.\d+)?)vh$/.exec(fit) : null;
	const aspect = aspectOf(img);
	if (!vh || aspect === null) return null;
	return `calc(${vh[1]}vh * ${aspect.toFixed(4)})`;
}

/** Where the slider starts: the drawing's size, or the height it's drawn at now. */
function sliderValueOf(img: HTMLElement, fit: string | null): number {
	const clamp = (n: number): number => Math.min(SLIDER_MAX, Math.max(SLIDER_MIN, Math.round(n / SLIDER_STEP) * SLIDER_STEP));
	if (fit === "full") return SLIDER_MAX;
	const vh = fit ? /^(\d+(?:\.\d+)?)vh$/.exec(fit) : null;
	if (vh) return clamp(parseFloat(vh[1] ?? ""));
	return clamp((img.getBoundingClientRect().height / window.innerHeight) * 100);
}

/** A drawing's width over its height: its SVG's viewBox, or the box it's drawn in. */
function aspectOf(img: HTMLElement): number | null {
	const box = img instanceof HTMLImageElement ? null : img.querySelector("svg")?.viewBox.baseVal;
	if (box && box.width > 0 && box.height > 0) return box.width / box.height;
	const rect = img.getBoundingClientRect();
	return rect.width > 0 && rect.height > 0 ? rect.width / rect.height : null;
}
