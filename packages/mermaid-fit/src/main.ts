import { MarkdownView, Notice, Plugin } from "obsidian";
import {
	DEFAULT_SETTINGS,
	MermaidFitSettings,
	MermaidFitSettingTab,
} from "./settings";

/** Attribute stamped on a block container carrying its `%% fit: ... %%` value. */
const FIT_ATTR = "data-mermaid-fit-override";

/** Class on the injected fit-size slider. */
const SLIDER_CLS = "mermaid-fit-slider";

/** Slider range (as viewport-height percentages). */
const SLIDER_MIN = 20;
const SLIDER_MAX = 100;
const SLIDER_STEP = 5;

/** Minimal shape of the CM6 EditorView we rely on (via `editor.cm`). */
interface EditorViewLike {
	posAtDOM(node: Node): number;
}

export default class MermaidFitPlugin extends Plugin {
	settings: MermaidFitSettings;

	/** Watches the workspace for newly rendered Mermaid SVGs. */
	private observer: MutationObserver | null = null;
	/** Coalesces bursts of mutations into a single processing pass. */
	private rafHandle: number | null = null;
	/** Debounce timer for window resize. */
	private resizeTimer: number | null = null;
	/** The diagram currently being dragged via its slider (skip re-fitting it). */
	private draggingSvg: SVGSVGElement | null = null;

	async onload() {
		await this.loadSettings();
		this.addSettingTab(new MermaidFitSettingTab(this.app, this));

		// Read per-diagram directives (`%% fit: ... %%`) from the block source and
		// stamp them onto the rendered container so fitSvg can honor them.
		this.registerMarkdownPostProcessor((el, ctx) => {
			const info = ctx.getSectionInfo(el);
			if (!info) return;
			const src = info.text
				.split("\n")
				.slice(info.lineStart, info.lineEnd + 1)
				.join("\n");
			// Only mermaid blocks; cheap guard before the regex.
			if (!/```+\s*mermaid/i.test(src)) return;
			// Closing `%%` is optional (mermaid single-line comments don't need
			// it); grab to end of line, then strip a trailing `%%` if present.
			const m = src.match(/%%\s*fit\s*[:=]?\s*(.+)/i);
			if (m) {
				const value = m[1]!
					.replace(/%%\s*$/, "")
					.trim()
					.toLowerCase();
				if (value) el.setAttribute(FIT_ATTR, value);
			}
		});

		// Process diagrams that already exist once the layout is ready.
		this.app.workspace.onLayoutReady(() => this.processAll());

		// Mermaid renders asynchronously, so watch the workspace for added SVGs.
		const root =
			document.querySelector(".workspace") ?? document.body;
		this.observer = new MutationObserver((mutations) => {
			for (const m of mutations) {
				if (m.addedNodes.length === 0) continue;
				// Ignore mutations from our own UI (e.g. the tooltip's live text),
				// otherwise re-fitting would stomp the drag preview mid-drag.
				const target = m.target as HTMLElement;
				if (target?.closest?.(`.${SLIDER_CLS}, .${SLIDER_CLS}-tip`)) continue;
				this.scheduleProcess();
				return;
			}
		});
		this.observer.observe(root, { childList: true, subtree: true });

		// Re-process when leaves are rearranged (split/close/switch).
		this.registerEvent(
			this.app.workspace.on("layout-change", () => this.scheduleProcess())
		);

		// Viewport height changes alter the target height, so recompute.
		this.registerDomEvent(window, "resize", () => {
			if (this.resizeTimer !== null) window.clearTimeout(this.resizeTimer);
			this.resizeTimer = window.setTimeout(() => this.processAll(), 150);
		});
	}

	onunload() {
		this.observer?.disconnect();
		this.observer = null;
		if (this.rafHandle !== null) cancelAnimationFrame(this.rafHandle);
		if (this.resizeTimer !== null) window.clearTimeout(this.resizeTimer);
		// Leave the DOM as we found it.
		this.clearAll();
	}

	async loadSettings() {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			(await this.loadData()) as Partial<MermaidFitSettings>
		);
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	/** Coalesce mutation bursts into one pass on the next frame. */
	private scheduleProcess() {
		if (this.rafHandle !== null) return;
		this.rafHandle = requestAnimationFrame(() => {
			this.rafHandle = null;
			this.processAll();
		});
	}

	/** (Re)apply the fit constraint to every rendered Mermaid diagram. */
	processAll() {
		if (!this.settings.enabled) {
			this.clearAll();
			return;
		}
		const svgs = document.querySelectorAll<SVGSVGElement>(".mermaid svg");
		svgs.forEach((svg) => {
			// Don't stomp the diagram currently being dragged with its slider.
			if (svg === this.draggingSvg) return;
			this.fitSvg(svg);
			this.injectSlider(svg);
		});
	}

	/**
	 * Fit the diagram inside the container's content box using a "contain" rule:
	 * the rendered width is capped at `min(heightCappedWidth, containerWidth)`,
	 * preserving the aspect ratio derived from the viewBox.
	 *
	 * - `heightCappedWidth` (= targetH * aspect) is the width at which the
	 *   diagram would be exactly `targetH` tall. This keeps tall/thin diagrams
	 *   from scrolling several screens.
	 * - `containerWidth` caps wide diagrams at 100% of the content width so they
	 *   never overflow horizontally (no X-axis scroll).
	 *
	 * A px `max-width` clamps the SVG even when a theme forces
	 * `width: 100% !important`, since max-width and width are independent
	 * properties.
	 *
	 * Without a directive the constraint is a cap: it only shrinks oversized
	 * diagrams, never enlarges small ones (a px `max-width` clamps the SVG even
	 * when a theme forces `width: 100% !important`).
	 *
	 * A per-diagram `%% fit: ... %%` directive (read by the post-processor and
	 * stamped as {@link FIT_ATTR}) instead sizes *that* diagram explicitly —
	 * growing or shrinking it to the requested size via `width`:
	 *   - `none` / `off` — leave the diagram alone (theme sizing)
	 *   - `full` / `100%` — fill the container width, no height cap
	 *   - `<n>vh` — render at n% of the viewport height
	 *   - `<n>px` — render at n pixels tall
	 */
	private fitSvg(svg: SVGSVGElement) {
		const vb = svg.viewBox.baseVal;
		if (!vb || vb.width === 0 || vb.height === 0) return;

		const override = this.resolveOverride(svg);
		if (override === "none" || override === "off") {
			this.clearOne(svg);
			return;
		}

		const aspect = vb.width / vb.height; // width / height
		const containerWidth = this.getContainerWidth(svg);

		if (override === "full" || override === "100%") {
			// Explicitly fill the width (grows small diagrams), no height cap.
			const w = containerWidth > 0 ? containerWidth : vb.width;
			svg.style.width = `${Math.round(w)}px`;
			svg.style.maxWidth = "100%";
			svg.style.height = "auto";
			svg.dataset.mermaidFit = "1";
			return;
		}

		const targetH = this.resolveTargetHeight(override);
		const heightCappedWidth = targetH * aspect;
		const fitW =
			containerWidth > 0
				? Math.min(heightCappedWidth, containerWidth)
				: heightCappedWidth;

		if (this.isExplicitHeight(override)) {
			// A per-diagram vh/px directive: size it exactly (grow or shrink).
			svg.style.width = `${Math.round(fitW)}px`;
			svg.style.maxWidth = "100%";
		} else {
			// Global default: cap only, never upscale.
			svg.style.removeProperty("width");
			svg.style.maxWidth = `${Math.round(fitW)}px`;
		}
		svg.style.height = "auto";
		svg.dataset.mermaidFit = "1";
	}

	/** True when the directive is an explicit `<n>vh` or `<n>px` size. */
	private isExplicitHeight(override: string | null | undefined): boolean {
		return !!override && /^\d+(?:\.\d+)?(?:px|vh)$/.test(override);
	}

	/**
	 * Resolve the target height (px) from a `%% fit: ... %%` value, falling back
	 * to the global `maxHeightVh` setting when there's no per-diagram override.
	 */
	private resolveTargetHeight(override: string | null | undefined): number {
		if (override) {
			const px = override.match(/^(\d+(?:\.\d+)?)px$/);
			if (px) return parseFloat(px[1]!);
			const vh = override.match(/^(\d+(?:\.\d+)?)vh$/);
			if (vh) return window.innerHeight * (parseFloat(vh[1]!) / 100);
		}
		return window.innerHeight * (this.settings.maxHeightVh / 100);
	}

	/**
	 * Available content width for the diagram's block, i.e. how wide it can grow
	 * before it overflows and triggers horizontal scrolling. Prefers Obsidian's
	 * content containers (reading view sizer / live-preview content) and
	 * subtracts their horizontal padding; falls back to the immediate parent.
	 */
	private getContainerWidth(svg: SVGSVGElement): number {
		const container =
			svg.closest<HTMLElement>(
				".markdown-preview-sizer, .cm-content, .markdown-rendered"
			) ?? svg.parentElement;
		if (!container) return 0;
		const style = getComputedStyle(container);
		const padX =
			(parseFloat(style.paddingLeft) || 0) +
			(parseFloat(style.paddingRight) || 0);
		return Math.max(0, container.clientWidth - padX);
	}

	/**
	 * Add a size slider next to Obsidian's edit-block button. Dragging previews
	 * the size live (SVG only) and shows a value tooltip that tracks the thumb;
	 * releasing persists it (`<n>vh`, or `full` at the max = fill the window).
	 * Live Preview only (needs an editable source). Idempotent.
	 */
	private injectSlider(svg: SVGSVGElement) {
		const block = svg.closest<HTMLElement>(".cm-preview-code-block");
		if (!block) return;
		if (block.querySelector(`:scope > .${SLIDER_CLS}`)) return;

		const editBtn = block.querySelector<HTMLElement>(".edit-block-button");

		const slider = document.createElement("input");
		slider.type = "range";
		slider.min = String(SLIDER_MIN);
		slider.max = String(SLIDER_MAX);
		slider.step = String(SLIDER_STEP);
		slider.value = String(this.initialSliderValue(svg));
		slider.classList.add(SLIDER_CLS);
		block.insertBefore(slider, editBtn ?? null);
		this.positionControl(slider, block, editBtn);

		// Value tooltip, shown only while actively dragging (no aria-label, so no
		// native hover tooltip). Follows the thumb.
		const tip = block.createDiv({ cls: `${SLIDER_CLS}-tip` });
		const showTip = () => {
			const v = Number(slider.value);
			tip.setText(this.sliderLabel(v));
			const bRect = block.getBoundingClientRect();
			const sRect = slider.getBoundingClientRect();
			const frac = (v - SLIDER_MIN) / (SLIDER_MAX - SLIDER_MIN);
			tip.style.left = `${Math.round(
				sRect.left - bRect.left + frac * sRect.width
			)}px`;
			tip.style.top = `${Math.round(sRect.top - bRect.top - 24)}px`;
			tip.classList.add("is-visible");
		};
		const hideTip = () => tip.classList.remove("is-visible");

		// Keep clicks/drags from bubbling into the editor / edit-block handler.
		slider.addEventListener("pointerdown", (e) => {
			e.stopPropagation();
			this.draggingSvg = svg;
			showTip();
		});
		slider.addEventListener("click", (e) => e.stopPropagation());
		// Live preview while dragging — style the SVG only, don't touch source.
		slider.addEventListener("input", () => {
			this.applyLiveSize(svg, Number(slider.value));
			if (this.draggingSvg === svg) showTip();
		});
		// Persist and hide the tooltip on release.
		slider.addEventListener("change", () => {
			this.draggingSvg = null;
			this.persistFit(block, this.valueToDirective(Number(slider.value)));
			hideTip();
		});
		slider.addEventListener("pointerup", () => {
			this.draggingSvg = null;
			hideTip();
		});
		slider.addEventListener("blur", () => {
			this.draggingSvg = null;
			hideTip();
		});
	}

	/** Directive string for a slider value (`full` at the max = fill the window). */
	private valueToDirective(value: number): string {
		return value >= SLIDER_MAX ? "full" : `${value}vh`;
	}

	/** Value label shown in the drag tooltip. */
	private sliderLabel(value: number): string {
		return value >= SLIDER_MAX ? "100%" : `${value}%`;
	}

	/** Initial slider position derived from the diagram's current fit. */
	private initialSliderValue(svg: SVGSVGElement): number {
		const clamp = (n: number) =>
			Math.min(SLIDER_MAX, Math.max(SLIDER_MIN, Math.round(n)));
		const override = this.resolveOverride(svg);
		if (override) {
			if (override === "full" || override === "100%") return SLIDER_MAX;
			const vh = override.match(/^(\d+(?:\.\d+)?)vh$/);
			if (vh) return clamp(parseFloat(vh[1]!));
			const px = override.match(/^(\d+(?:\.\d+)?)px$/);
			if (px)
				return clamp((parseFloat(px[1]!) / window.innerHeight) * 100);
		}
		return clamp(this.settings.maxHeightVh);
	}

	/**
	 * Size a single diagram live (SVG only). At the slider max, fill the
	 * container width (100% of the window); otherwise cap at `value`% of the
	 * viewport height, preserving aspect and never overflowing the width.
	 */
	private applyLiveSize(svg: SVGSVGElement, value: number) {
		const vb = svg.viewBox.baseVal;
		if (!vb || vb.width === 0 || vb.height === 0) return;
		const aspect = vb.width / vb.height;
		const containerWidth = this.getContainerWidth(svg);
		let fitW: number;
		if (value >= SLIDER_MAX) {
			fitW = containerWidth > 0 ? containerWidth : vb.width;
		} else {
			const targetH = window.innerHeight * (value / 100);
			fitW =
				containerWidth > 0
					? Math.min(targetH * aspect, containerWidth)
					: targetH * aspect;
		}
		svg.style.width = `${Math.round(fitW)}px`;
		svg.style.maxWidth = "100%";
		svg.style.height = "auto";
		svg.dataset.mermaidFit = "1";
	}

	/** Write a `%% fit: <value> %%` directive to a block's first line. */
	private persistFit(block: HTMLElement, value: string) {
		const view = this.findMarkdownView(block);
		const firstLine = view
			? this.locateFirstContentLine(view, block)
			: null;
		if (!view || firstLine === null) {
			new Notice("Mermaid Fit: 滑块只在实时预览下可用");
			return;
		}
		const editor = view.editor;
		const cur = editor.getLine(firstLine) ?? "";
		const text = `%% fit: ${value} %%`;
		// The edit moves the (unseen) cursor and CodeMirror scrolls it into view,
		// jerking the page to the top. Capture the scroll and restore it — now and
		// again next frame, after the block re-renders.
		const scroll = editor.getScrollInfo();
		if (this.parseFitLine(cur) !== null) {
			editor.replaceRange(
				text,
				{ line: firstLine, ch: 0 },
				{ line: firstLine, ch: cur.length }
			);
		} else {
			editor.replaceRange(text + "\n", { line: firstLine, ch: 0 });
		}
		const restore = () => editor.scrollTo(scroll.left, scroll.top);
		restore();
		requestAnimationFrame(restore);
	}

	/**
	 * Park a control just left of the real edit button by measuring it (its box
	 * is valid even while hidden at opacity 0). Inline styles beat any theme
	 * selector; falls back to a fixed offset when the edit button isn't found.
	 */
	private positionControl(
		el: HTMLElement,
		block: HTMLElement,
		editBtn: HTMLElement | null
	) {
		const gap = 6;
		const editRect = editBtn?.getBoundingClientRect();
		if (editRect && editRect.width > 0) {
			const blockRect = block.getBoundingClientRect();
			const elRect = el.getBoundingClientRect();
			el.style.right = `${Math.round(
				blockRect.right - editRect.left + gap
			)}px`;
			el.style.top = `${Math.round(
				editRect.top - blockRect.top + (editRect.height - elRect.height) / 2
			)}px`;
		} else {
			el.style.right = "40px";
			el.style.top = "6px";
		}
	}

	/** Extract the fit value from a `%% fit: ... %%` line, or null if absent. */
	private parseFitLine(line: string): string | null {
		const m = line.match(/%%\s*fit\s*[:=]?\s*(.+)/i);
		if (!m) return null;
		return m[1]!.replace(/%%\s*$/, "").trim().toLowerCase();
	}

	/**
	 * Resolve a diagram's fit directive. In Live Preview we read it straight from
	 * the editor source (getSectionInfo is unreliable there); in reading view we
	 * use the attribute the post-processor stamped on an ancestor.
	 */
	private resolveOverride(svg: SVGSVGElement): string | null {
		const lpBlock = svg.closest<HTMLElement>(".cm-preview-code-block");
		if (lpBlock) return this.readDirectiveFromEditor(lpBlock);
		return (
			svg.closest<HTMLElement>(`[${FIT_ATTR}]`)?.getAttribute(FIT_ATTR) ??
			null
		);
	}

	/** Read the `%% fit %%` value from the source of a Live Preview block. */
	private readDirectiveFromEditor(block: HTMLElement): string | null {
		const view = this.findMarkdownView(block);
		if (!view) return null;
		const line = this.locateFirstContentLine(view, block);
		if (line === null) return null;
		return this.parseFitLine(view.editor.getLine(line) ?? "");
	}

	/**
	 * Find the document line index of the first line *inside* the mermaid block
	 * rendered at `block` (the line right after the ```mermaid fence), using CM6's
	 * `posAtDOM` to map the rendered widget back to a source position.
	 */
	private locateFirstContentLine(
		view: MarkdownView,
		block: HTMLElement
	): number | null {
		const editor = view.editor;
		const cm = (editor as unknown as { cm?: EditorViewLike }).cm;
		if (!cm?.posAtDOM) return null;
		try {
			const start = editor.offsetToPos(cm.posAtDOM(block)).line;
			const last = editor.lastLine();
			for (let i = Math.max(0, start - 1); i <= last; i++) {
				if (/^\s*`{3,}\s*mermaid\b/i.test(editor.getLine(i))) return i + 1;
			}
		} catch {
			/* posAtDOM can throw if the node isn't in the editor; ignore. */
		}
		return null;
	}

	/** Find the MarkdownView whose DOM contains the given element. */
	private findMarkdownView(el: HTMLElement): MarkdownView | null {
		let found: MarkdownView | null = null;
		this.app.workspace.iterateAllLeaves((leaf) => {
			const view = leaf.view;
			if (
				!found &&
				view instanceof MarkdownView &&
				view.containerEl.contains(el)
			) {
				found = view;
			}
		});
		return found;
	}

	/** Remove the constraint this plugin applied to a single diagram. */
	private clearOne(svg: SVGSVGElement) {
		svg.style.removeProperty("max-width");
		svg.style.removeProperty("width");
		svg.style.removeProperty("height");
		delete svg.dataset.mermaidFit;
	}

	/** Remove every constraint this plugin applied, plus any injected buttons. */
	private clearAll() {
		document
			.querySelectorAll<SVGSVGElement>("svg[data-mermaid-fit]")
			.forEach((svg) => this.clearOne(svg));
		document
			.querySelectorAll(`.${SLIDER_CLS}, .${SLIDER_CLS}-tip`)
			.forEach((el) => el.remove());
	}
}
