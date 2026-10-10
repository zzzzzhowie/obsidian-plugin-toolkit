import { EditorState, type Text, type Transaction, type TransactionSpec } from "@codemirror/state";
import { EditorView, type ViewUpdate } from "@codemirror/view";
import {
	App,
	editorLivePreviewField,
	loadMermaid,
	MarkdownView,
	Modal,
	Notice,
	Plugin,
	setIcon,
	setTooltip,
	Platform,
} from "obsidian";
import {
	DEFAULT_SETTINGS,
	MermaidEnhancedSettings,
	MermaidEnhancedSettingTab,
} from "./settings";
import { type Gallery, ZoomOverlay, type ZoomTarget } from "../../../shared/zoom-overlay";

/** Attribute stamped on a reading-view block naming the note line its diagram starts on. */
const LINE_ATTR = "data-mermaid-line";
/** Attribute stamped on a block container carrying its `%% fit: ... %%` value. */
const FIT_ATTR = "data-mermaid-fit-override";

/** Attribute stamped on a block container carrying its `%% caption: ... %%` text. */
const CAPTION_ATTR = "data-mermaid-caption";

/** Class on the caption injected below a diagram. */
const CAPTION_CLS = "mermaid-caption";

/** Class on the button that edits a diagram's caption. */
const CAPTION_BTN_CLS = "mermaid-caption-btn";

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

export default class MermaidEnhancedPlugin extends Plugin {
	settings: MermaidEnhancedSettings;

	/** Watches the workspace for newly rendered Mermaid SVGs. */
	private observer: MutationObserver | null = null;
	/** Coalesces bursts of mutations into a single processing pass. */
	private rafHandle: number | null = null;
	/** The note text the last section came from, split into lines once for all its sections. */
	private sectionText = "";
	private sectionLines: string[] = [];
	/** Debounce timer for window resize. */
	private resizeTimer: number | null = null;
	/** When the edit button of a diagram was last pressed; see keepCursorOutOfDiagrams. */
	private editPressedAt = 0;
	/** Where the diagram being edited (opened with its edit button) starts. */
	private editingDiagramAt: number | null = null;
	/** The diagram currently being dragged via its slider (skip re-fitting it). */
	private draggingSvg: SVGSVGElement | null = null;

	async onload() {
		await this.loadSettings();
		this.addSettingTab(new MermaidEnhancedSettingTab(this.app, this));

		// Click a diagram to open a zoomable/pannable overlay: Cmd/Ctrl-click on
		// desktop, plain tap on mobile. The overlay itself is shared with Excalidraw
		// Enhanced; only the options below are ours.
		new ZoomOverlay(this, {
			target: ".mermaid svg",
			cssPrefix: "mermaid-zoom",
			// Node and edge labels stay text in the zoom, to select and copy.
			selectableText: "foreignObject, text",
			// Every diagram in the note, to page through from the one clicked.
			gallery: (target) => this.diagramsAround(target),
		}).register();

		// A diagram shows as code only once its edit button is pressed.
		this.registerEditorExtension([
			EditorState.transactionFilter.of((tr) => this.keepCursorOutOfDiagrams(tr)),
			EditorView.updateListener.of((update) => this.stepOutOfDiagram(update)),
		]);
		this.registerDomEvent(
			document,
			"click",
			(event: MouseEvent) => {
				const target = event.target instanceof Element ? event.target : null;
				const button = target?.closest(".edit-block-button");
				if (isDiagramBlock(button?.closest(".cm-embed-block"))) this.editPressedAt = Date.now();
			},
			{ capture: true },
		);
		// A press on a diagram focuses the editor, and a focused editor shows as code the
		// block its cursor is in. The cursor is moved out first, so focus finds it outside.
		this.registerDomEvent(
			document,
			"mousedown",
			(event: MouseEvent) => {
				const target = event.target instanceof Element ? event.target : null;
				const block = target?.closest(".cm-embed-block");
				if (!isDiagramBlock(block) || target?.closest(".edit-block-button")) return;
				const editorEl = block.closest<HTMLElement>(".cm-editor");
				const view = editorEl ? EditorView.findFromDOM(editorEl) : null;
				const pos = view ? this.outsideDiagram(view.state) : null;
				if (view && pos !== null) view.dispatch({ selection: { anchor: pos } });
			},
			{ capture: true },
		);

		// Read per-diagram directives (`%% fit: ... %%`) from the block source and
		// stamp them onto the rendered container so fitSvg can honor them.
		this.registerMarkdownPostProcessor((el, ctx) => {
			const info = ctx.getSectionInfo(el);
			if (!info) return;
			// Every section of a render gets the same whole-note text; split it once, not per section.
			if (info.text !== this.sectionText) {
				this.sectionText = info.text;
				this.sectionLines = info.text.split("\n");
			}
			const lines = this.sectionLines;
			const src = lines.slice(info.lineStart, info.lineEnd + 1).join("\n");
			// Only mermaid blocks; cheap guard before the regex.
			if (!/```+\s*mermaid/i.test(src)) return;
			// The directive lives inside the block; also accept one just above it, which
			// an earlier build wrote there.
			const above =
				info.lineStart > 0 ? (lines[info.lineStart - 1] ?? "") : "";
			const value = this.parseFitLine(src) ?? this.parseFitLine(above);
			if (value) el.setAttribute(FIT_ATTR, value);
			// Which block of the note this is, for paging through its diagrams (diagramsAround).
			el.setAttribute(LINE_ATTR, String(info.lineStart));
			const caption = this.parseCaption(src);
			if (caption) el.setAttribute(CAPTION_ATTR, caption);
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
				// Only a diagram arriving matters. The workspace changes on every keystroke, and
				// a pass reads the layout of every diagram open.
				if (!this.bringsDiagram(m)) continue;
				// Now, not on the next frame: this callback runs before the browser paints, and
				// a frame later Mermaid's own size (as wide as its viewBox, up to the full
				// width) had already been drawn and then shrunk to the fit — a jump every time
				// Live Preview redraws a diagram, as it does scrolling back to one or when the
				// blocks around it change height.
				this.processAll();
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
		document
			.querySelectorAll(`.${CAPTION_CLS}, .${CAPTION_BTN_CLS}`)
			.forEach((el) => el.remove());
	}

	async loadSettings() {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			(await this.loadData()) as Partial<MermaidEnhancedSettings>
		);
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	/**
	 * Keep the cursor out of a Mermaid block in Live Preview unless its edit button put it
	 * there. Live Preview shows a block as source whenever the cursor is inside it, and the
	 * cursor got there in ways that had nothing to do with editing — the press that opens the
	 * zoom, a click on the diagram, closing the zoom — so the diagram kept turning into code.
	 * The edit button is the one way in: the cursor it places is let through, and stays free
	 * in that block until it leaves. Any other move into a diagram is turned away — the cursor
	 * stays where it was, or, moving with the keys, steps over the diagram to the other side.
	 */
	private keepCursorOutOfDiagrams(tr: Transaction): Transaction | TransactionSpec[] {
		if (!tr.selection || !tr.state.field(editorLivePreviewField, false)) return tr;
		const head = tr.selection.main.head;
		const block = mermaidBlockAt(tr.state.doc, head);
		if (!block) {
			this.editingDiagramAt = null;
			return tr;
		}
		if (Date.now() - this.editPressedAt < 1500) {
			this.editPressedAt = 0;
			this.editingDiagramAt = block.from;
			return tr;
		}
		if (this.editingDiagramAt === block.from) return tr;
		const before = tr.startState.selection.main.head;
		// Where it was — unless that is inside the diagram too (a note opens with its cursor at
		// the top, which is inside a diagram the note starts with): then past the diagram.
		const kept = tr.startState.selection.map(tr.changes);
		const keptBlock = mermaidBlockAt(tr.state.doc, kept.main.head);
		const stay: TransactionSpec = {
			selection: keptBlock ? { anchor: afterBlock(tr.state.doc, keptBlock) ?? kept.main.head } : kept,
			sequential: true,
		};
		// A click or a programmatic move: the cursor stays where it was.
		if (!tr.isUserEvent("select") || tr.isUserEvent("select.pointer")) return [tr, stay];
		// Moving with the keys: over the diagram, to the line past it on the side it was heading.
		const doc = tr.state.doc;
		const past = before <= block.from ? block.to + 1 : block.from - 1;
		if (past < 0 || past > doc.length) return [tr, stay];
		const { anchor, empty } = tr.selection.main;
		return [tr, { selection: { anchor: empty ? past : anchor, head: past }, sequential: true }];
	}

	/**
	 * Every Mermaid diagram in the note the clicked one is in, for the zoom to page through,
	 * or null when the clicked one can't be placed among them. Read from the note's source
	 * rather than the page: Live Preview and reading view only keep the blocks near the
	 * screen in the page, so a long note's far diagrams aren't there to clone. The clicked one
	 * is taken as it is; the others are drawn by Obsidian's own Mermaid when first shown.
	 */
	private async diagramsAround(target: ZoomTarget): Promise<Gallery | null> {
		let view: MarkdownView | null = null;
		this.app.workspace.iterateAllLeaves((leaf) => {
			if (!view && leaf.view instanceof MarkdownView && leaf.view.containerEl.contains(target)) view = leaf.view;
		});
		const found = view as MarkdownView | null;
		if (!found) return null;
		const blocks = mermaidSources(found.getViewData());
		if (blocks.length < 2) return null;
		const line = this.lineOf(target);
		const clicked = line === null ? undefined : blocks.find((block) => block.start <= line && line <= block.end);
		if (!clicked) return null;
		// A diagram with a syntax error has nothing to show but its error, so it isn't paged to.
		const parsed = await Promise.all(blocks.map((block) => (block === clicked ? true : parses(block.code))));
		const pages = blocks.filter((_, i) => parsed[i]);
		if (pages.length < 2) return null;
		return {
			index: pages.indexOf(clicked),
			items: pages.map((block, i) => ({
				label: block.caption ?? `Diagram ${i + 1}`,
				element: () => (block === clicked ? Promise.resolve(target) : renderDiagram(block.code)),
			})),
		};
	}

	/** The note line (0-based) a diagram on the page starts on: from the editor in Live Preview, the post-processor's stamp in reading view. */
	private lineOf(target: ZoomTarget): number | null {
		const stamped = target.closest(`[${LINE_ATTR}]`)?.getAttribute(LINE_ATTR);
		if (stamped) return Number(stamped);
		const editorEl = target.closest<HTMLElement>(".cm-editor");
		const view = editorEl ? EditorView.findFromDOM(editorEl) : null;
		if (!view) return null;
		try {
			return view.state.doc.lineAt(view.posAtDOM(target)).number - 1;
		} catch {
			return null;
		}
	}

	/**
	 * Where to put a cursor that sits inside a diagram it wasn't let into, or null when it
	 * doesn't. Its cursor can be inside one without ever moving there: a note opens with the
	 * cursor at its start, which is inside a diagram the note begins with, and the editor
	 * shows that block as code the moment it is focused.
	 */
	private outsideDiagram(state: EditorState): number | null {
		if (!state.field(editorLivePreviewField, false)) return null;
		const block = mermaidBlockAt(state.doc, state.selection.main.head);
		if (!block || this.editingDiagramAt === block.from) return null;
		return afterBlock(state.doc, block);
	}

	/**
	 * The net under the two above: whenever the editor gains focus or its cursor moves, a
	 * cursor left inside a diagram is moved past it. After the update, since an editor can't
	 * be changed from inside one.
	 */
	private stepOutOfDiagram(update: ViewUpdate): void {
		if (!update.focusChanged && !update.selectionSet) return;
		if (!update.view.hasFocus) return;
		const pos = this.outsideDiagram(update.state);
		if (pos === null) return;
		window.setTimeout(() => {
			if (this.outsideDiagram(update.view.state) === pos) update.view.dispatch({ selection: { anchor: pos } });
		});
	}

	/** Whether a mutation added a rendered diagram, or the SVG of one. */
	private bringsDiagram(m: MutationRecord): boolean {
		const inDiagram = (m.target as Element).closest?.(".mermaid") != null;
		for (const node of Array.from(m.addedNodes)) {
			if (!(node instanceof Element)) continue;
			if (inDiagram && node.matches("svg")) return true;
			if (node.matches(".mermaid") || node.querySelector(".mermaid svg, .mermaid")) return true;
		}
		return false;
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
		const svgs = document.querySelectorAll<SVGSVGElement>(".mermaid svg");
		// Captions don't depend on the fit toggle: turning off "fit tall diagrams"
		// shouldn't take away text the note itself asked for.
		svgs.forEach((svg) => {
			try {
				this.syncCaption(svg);
			} catch (e) {
				console.error("mermaid-enhanced: failed to caption a diagram", e);
			}
		});
		// Before the slider pass: the button joins Obsidian's action group, which
		// widens it, and the slider parks itself left of that group — measured after
		// the button is in, or the two would overlap.
		svgs.forEach((svg) => {
			try {
				this.injectCaptionButton(svg);
			} catch (e) {
				console.error("mermaid-enhanced: failed to add the caption button", e);
			}
		});
		if (this.settings.enabled) this.fitAll(svgs);
		else this.clearAll();
	}

	/** Fit every diagram and give each its size slider. */
	private fitAll(svgs: NodeListOf<SVGSVGElement>) {
		svgs.forEach((svg) => {
			// Don't stomp the diagram currently being dragged with its slider.
			if (svg === this.draggingSvg) return;
			// Both steps reach into Obsidian's rendered DOM, so an Obsidian change can
			// make one throw. Contain it per diagram: previously an exception here
			// aborted the entire pass, so one unexpected structure silently killed both
			// fitting and the slider everywhere.
			try {
				this.fitSvg(svg);
			} catch (e) {
				console.error("mermaid-enhanced: failed to fit a diagram", e);
			}
			// No slider on a phone: a thumb-sized range control over a diagram mostly gets
			// dragged by accident while scrolling, and there is no room for it beside the
			// block's own buttons. The size a desktop set still applies — only the control
			// to change it is left out.
			if (!Platform.isMobile) {
				try {
					this.injectSlider(svg);
				} catch (e) {
					console.error("mermaid-enhanced: failed to add the size slider", e);
				}
			}
		});
	}

	/**
	 * Fit the diagram inside its block using a "contain" rule: the rendered width
	 * is capped at `min(heightCappedWidth, 100%)`, preserving the aspect ratio
	 * derived from the viewBox.
	 *
	 * - `heightCappedWidth` (= targetH * aspect) is the width at which the
	 *   diagram would be exactly `targetH` tall. This keeps tall/thin diagrams
	 *   from scrolling several screens.
	 * - `100%` caps wide diagrams at the block's width so they never overflow
	 *   horizontally (no X-axis scroll), whatever width the block has later.
	 *
	 * A `max-width` clamps the SVG even when a theme forces
	 * `width: 100% !important`, since max-width and width are independent
	 * properties.
	 *
	 * Without a directive the constraint is a cap: it only shrinks oversized
	 * diagrams, never enlarges small ones (a `max-width` clamps the SVG even
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

		if (override === "full" || override === "100%") {
			// Explicitly fill the width (grows small diagrams), no height cap.
			svg.setCssStyles({ width: "100%", maxWidth: "100%", height: "auto" });
			svg.dataset.mermaidFit = "1";
			return;
		}

		// The width at which the diagram is exactly the target height, and never wider than
		// its block: `100%` in the CSS rather than a width measured here, so the browser keeps
		// to it as the block narrows (a sidebar opening, a split) and while it isn't laid out
		// yet. A measured width went stale — and Obsidian's Mermaid draws flowcharts, sequence
		// and ER diagrams at a fixed px width, which then ran past the block and scrolled.
		const fitW = `min(${Math.round(this.resolveTargetHeight(override) * aspect)}px, 100%)`;

		if (this.isExplicitHeight(override)) {
			// A per-diagram vh/px directive: size it exactly (grow or shrink).
			svg.style.width = fitW;
			svg.style.maxWidth = "100%";
		} else {
			// Global default: cap only, never upscale.
			svg.style.removeProperty("width");
			svg.style.maxWidth = fitW;
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
	 * Add a size slider next to Obsidian's edit-block button. Dragging previews
	 * the size live (SVG only) and shows a value tooltip that tracks the thumb;
	 * releasing persists it (`<n>vh`, or `full` at the max = fill the window).
	 * Live Preview only (needs an editable source). Idempotent.
	 */
	private injectSlider(svg: SVGSVGElement) {
		const block = svg.closest<HTMLElement>(".cm-preview-code-block");
		if (!block) return;
		if (block.querySelector(`:scope > .${SLIDER_CLS}`)) return;

		// Left of the whole action group, not just the edit button: the caption button
		// sits in that group too, and anchoring to the edit button would land the
		// slider on top of it.
		const editBtn =
			block.querySelector<HTMLElement>(".embed-actions") ??
			block.querySelector<HTMLElement>(".edit-block-button");

		const slider = document.createElement("input");
		slider.type = "range";
		slider.min = String(SLIDER_MIN);
		slider.max = String(SLIDER_MAX);
		slider.step = String(SLIDER_STEP);
		slider.value = String(this.initialSliderValue(svg));
		slider.classList.add(SLIDER_CLS);
		// Append rather than insert before the edit button. Obsidian 1.13 moved that
		// button into an `.embed-actions` wrapper, so it is no longer a direct child of
		// the block — `insertBefore` then threw NotFoundError, which aborted the whole
		// processAll pass and took the slider (and fitting) down with it. DOM order
		// doesn't matter here anyway: the slider is positioned absolutely by
		// positionControl, which measures the button wherever it now lives. Appending
		// also keeps it a direct child, which the `:hover >` reveal rule needs.
		block.appendChild(slider);
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
		// Mobile: Obsidian's edge-swipe gesture (open the left/right sidebar) and
		// the page scroll both listen on touch events higher up the tree. Without
		// this, dragging the thumb flings a sidebar out and the tap leaks through
		// to the note behind it. stopPropagation keeps the drag local; we do NOT
		// preventDefault, so the native range thumb still tracks the finger (the
		// browser's own pan is already suppressed by `touch-action: none` in CSS).
		const stopTouch = (e: TouchEvent) => e.stopPropagation();
		slider.addEventListener("touchstart", stopTouch, { passive: true });
		slider.addEventListener("touchmove", stopTouch, { passive: true });
		slider.addEventListener("touchend", stopTouch, { passive: true });
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
		// As fitSvg sizes it: never wider than the block, by CSS rather than a measured width.
		svg.style.width =
			value >= SLIDER_MAX
				? "100%"
				: `min(${Math.round(window.innerHeight * (value / 100) * aspect)}px, 100%)`;
		svg.style.maxWidth = "100%";
		svg.style.height = "auto";
		svg.dataset.mermaidFit = "1";
	}

	/** Write a `%% fit: <value> %%` directive to a block's first line. */
	private persistFit(block: HTMLElement, value: string) {
		const view = this.findMarkdownView(block);
		const fence = view ? this.locateFenceLine(view, block) : null;
		if (!view || fence === null) {
			new Notice("Mermaid (Enhanced): 滑块只在实时预览下可用");
			return;
		}
		const editor = view.editor;
		const text = `%% fit: ${value} %%`;
		// The directive belongs on the first line inside the block, where Mermaid treats
		// it as a comment and it travels with the diagram's own source.
		const insideLine = fence + 1;
		const inside = editor.getLine(insideLine) ?? "";
		// An earlier build briefly wrote it above the fence; clean that up when we see it
		// so a note doesn't end up carrying the value in two places.
		const aboveLine = fence - 1;
		const above = fence > 0 ? (editor.getLine(aboveLine) ?? "") : "";
		const stray = fence > 0 && this.parseFitLine(above) !== null;

		// Already at this value with nothing to tidy: skip the write entirely.
		if (this.parseFitLine(inside) === value && !stray) return;

		// Editing the block's source means Obsidian cannot reuse the rendered widget
		// (`eq: e.lang === this.lang && e.code === this.code`), so it tears the block down
		// and re-renders Mermaid asynchronously. That single re-render is visible and
		// can't be avoided while the directive lives in the block. Masking it was worse:
		// each cover-up (pinned height, floating snapshot, hidden source) is its own
		// appear/disappear, so they stacked into several jumps instead of the one.

		// The edit moves the (unseen) cursor and CodeMirror scrolls it into view,
		// jerking the page to the top. Capture the scroll and restore it — now and
		// again next frame, after the block re-renders.
		const scroll = editor.getScrollInfo();

		// Bottom-up, so the earlier edit doesn't shift the line the later one targets.
		if (this.parseFitLine(inside) !== null) {
			editor.replaceRange(
				text,
				{ line: insideLine, ch: 0 },
				{ line: insideLine, ch: inside.length }
			);
		} else {
			editor.replaceRange(text + "\n", { line: insideLine, ch: 0 });
		}
		if (stray) {
			editor.replaceRange(
				"",
				{ line: aboveLine, ch: 0 },
				{ line: aboveLine + 1, ch: 0 }
			);
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

	/**
	 * Keep a caption under the diagram in step with its `%% caption %%` line.
	 *
	 * Writes only when something actually differs. This runs on every pass of the
	 * workspace MutationObserver, and inserting or re-texting the caption is itself a
	 * mutation — an unconditional write would re-trigger the pass forever.
	 */
	private syncCaption(svg: SVGSVGElement) {
		const diagram = svg.closest<HTMLElement>(".mermaid");
		if (!diagram) return;
		const text = this.resolveCaption(svg);
		const next = diagram.nextElementSibling;
		const existing = next?.classList.contains(CAPTION_CLS) ? next : null;

		if (!text) {
			existing?.remove();
			return;
		}
		if (existing) {
			if (existing.textContent !== text) existing.setText(text);
			return;
		}
		diagram.after(createDiv({ cls: CAPTION_CLS, text }));
	}

	/**
	 * A button that edits the caption in a small dialog, placed as a sibling of
	 * Obsidian's own edit-block button.
	 *
	 * Obsidian 1.13 builds that button as `createDiv("embed-action")` inside a flex
	 * `.embed-actions` group, which owns the spacing and the reveal-on-hover. Joining
	 * the group rather than floating beside it means the two buttons sit together and
	 * look alike by construction — a theme's `<button>` styling was what made the first
	 * version stand out. Obsidian binds each action's click on the element itself, not
	 * by class, so borrowing `embed-action` borrows only the look.
	 *
	 * Live Preview only, like the slider: that's where the block's source can be edited
	 * in place. Without the group (older Obsidian) it falls back to being positioned
	 * beside the edit button.
	 */
	private injectCaptionButton(svg: SVGSVGElement) {
		const block = svg.closest<HTMLElement>(".cm-preview-code-block");
		if (!block || block.querySelector(`.${CAPTION_BTN_CLS}`)) return;

		const actions = block.querySelector<HTMLElement>(".embed-actions");
		const btn = createDiv({
			cls: actions
				? `embed-action ${CAPTION_BTN_CLS}`
				: `clickable-icon ${CAPTION_BTN_CLS}`,
		});
		setIcon(btn, "captions");
		setTooltip(btn, "Edit caption");
		if (actions) {
			actions.prepend(btn);
		} else {
			block.appendChild(btn);
			this.positionControl(
				btn,
				block,
				block.querySelector<HTMLElement>(".edit-block-button")
			);
		}

		// Keep the press out of the editor, which would otherwise put the cursor into
		// the block and swap the diagram for its source.
		btn.addEventListener("pointerdown", (e) => e.stopPropagation());
		btn.addEventListener("click", (e) => {
			e.preventDefault();
			e.stopPropagation();
			new CaptionModal(this.app, this.resolveCaption(svg) ?? "", (text) =>
				this.persistCaption(block, text)
			).open();
		});
	}

	/**
	 * Write a caption into the block as a `%% caption: ... %%` line — replacing the one
	 * already there, removing it when the text is empty, otherwise adding one.
	 *
	 * A new line goes below a `%% fit %%` directive on the first inner line rather than
	 * above it: the slider reads and writes fit on exactly that line, so pushing it down
	 * would quietly detach the diagram from its size.
	 */
	private persistCaption(block: HTMLElement, raw: string) {
		const view = this.findMarkdownView(block);
		const fence = view ? this.locateFenceLine(view, block) : null;
		if (!view || fence === null) {
			new Notice("Mermaid (Enhanced): 说明只能在实时预览下编辑");
			return;
		}
		const editor = view.editor;
		// A `%%` in the text would end the comment early, and a newline would put the
		// rest of it into the diagram source.
		const text = raw.replace(/%%/g, "").replace(/\s+/g, " ").trim();
		const indent = editor.getLine(fence).match(/^\s*/)?.[0] ?? "";
		const next = `${indent}%% caption: ${text} %%`;

		let existing: number | null = null;
		for (let i = fence + 1; i <= editor.lastLine(); i++) {
			const line = editor.getLine(i);
			if (/^\s*`{3,}\s*$/.test(line)) break;
			if (/^\s*%%\s*caption\s*[:=]/i.test(line)) {
				existing = i;
				break;
			}
		}

		// Same guard as persistFit: editing the source re-renders the block, and the
		// cursor move makes CodeMirror scroll it into view. Put the page back.
		const scroll = editor.getScrollInfo();
		if (existing !== null) {
			if (!text) {
				editor.replaceRange("", { line: existing, ch: 0 }, { line: existing + 1, ch: 0 });
			} else if (editor.getLine(existing) !== next) {
				const end = editor.getLine(existing).length;
				editor.replaceRange(next, { line: existing, ch: 0 }, { line: existing, ch: end });
			} else {
				return; // unchanged — skip the re-render entirely
			}
		} else if (text) {
			const fitOnFirst = this.parseFitLine(editor.getLine(fence + 1) ?? "") !== null;
			editor.replaceRange(`${next}\n`, { line: fence + (fitOnFirst ? 2 : 1), ch: 0 });
		} else {
			return;
		}
		const restore = () => editor.scrollTo(scroll.left, scroll.top);
		restore();
		requestAnimationFrame(restore);
	}

	/**
	 * The `%% caption: ... %%` text of a mermaid block, or null. Anywhere inside the
	 * block rather than on a fixed line, since the first line may already be taken by a
	 * `%% fit %%` directive. Case is kept (unlike fit): it's prose.
	 */
	private parseCaption(src: string): string | null {
		const m = src.match(/^\s*%%\s*caption\s*[:=]\s*(.*?)\s*(?:%%)?\s*$/im);
		const text = m?.[1]?.trim();
		return text ? text : null;
	}

	/**
	 * Resolve a diagram's caption the same two ways as its fit directive: straight from
	 * the editor source in Live Preview, from the stamped attribute in reading view.
	 */
	private resolveCaption(svg: SVGSVGElement): string | null {
		const lpBlock = svg.closest<HTMLElement>(".cm-preview-code-block");
		if (lpBlock) return this.readCaptionFromEditor(lpBlock);
		return (
			svg.closest<HTMLElement>(`[${CAPTION_ATTR}]`)?.getAttribute(CAPTION_ATTR) ??
			null
		);
	}

	/** Scan a Live Preview block's source, fence to closing fence, for its caption. */
	private readCaptionFromEditor(block: HTMLElement): string | null {
		const view = this.findMarkdownView(block);
		if (!view) return null;
		const fence = this.locateFenceLine(view, block);
		if (fence === null) return null;
		const editor = view.editor;
		const last = editor.lastLine();
		const lines: string[] = [];
		for (let i = fence + 1; i <= last; i++) {
			const line = editor.getLine(i);
			if (/^\s*`{3,}\s*$/.test(line)) break;
			lines.push(line);
		}
		return this.parseCaption(lines.join("\n"));
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

	/**
	 * Read the `%% fit %%` value for a Live Preview block: the first line inside the block,
	 * where persistFit writes it, falling back to the line above the fence in case a note
	 * still carries one there from an earlier build.
	 */
	private readDirectiveFromEditor(block: HTMLElement): string | null {
		const view = this.findMarkdownView(block);
		if (!view) return null;
		const fence = this.locateFenceLine(view, block);
		if (fence === null) return null;
		const editor = view.editor;
		const inside = this.parseFitLine(editor.getLine(fence + 1) ?? "");
		if (inside !== null) return inside;
		return fence > 0 ? this.parseFitLine(editor.getLine(fence - 1) ?? "") : null;
	}

	/**
	 * Find the document line index of the ```mermaid fence that opens the block rendered
	 * at `block`, using CM6's `posAtDOM` to map the rendered widget back to a source
	 * position. The directive lives on `fence + 1`, inside the block; older notes have it on `fence - 1`.
	 */
	private locateFenceLine(
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
				if (/^\s*`{3,}\s*mermaid\b/i.test(editor.getLine(i))) return i;
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

/**
 * A one-field dialog for a diagram's caption. Enter saves; an empty field removes the
 * caption. Enter is ignored mid-composition, or confirming a pinyin candidate would
 * save half-typed text.
 */
class CaptionModal extends Modal {
	constructor(
		app: App,
		private readonly initial: string,
		private readonly onSubmit: (text: string) => void
	) {
		super(app);
	}

	onOpen() {
		this.titleEl.setText("Diagram caption");
		const input = this.contentEl.createEl("input", {
			type: "text",
			cls: "mermaid-caption-input",
			attr: { placeholder: "Leave empty to remove the caption" },
		});
		input.value = this.initial;
		const submit = () => {
			this.onSubmit(input.value);
			this.close();
		};
		input.addEventListener("keydown", (e) => {
			if (e.key === "Enter" && !e.isComposing) {
				e.preventDefault();
				submit();
			}
		});
		const actions = this.contentEl.createDiv({ cls: "modal-button-container" });
		actions
			.createEl("button", { text: "Save", cls: "mod-cta" })
			.addEventListener("click", submit);
		input.focus();
		input.select();
	}

	onClose() {
		this.contentEl.empty();
	}
}

/**
 * Whether a Live Preview block is a Mermaid one. By the block's language, not by a drawn
 * diagram in it: one Mermaid couldn't parse holds only its error, and its edit button has to
 * get the cursor in all the same — the cursor is kept out by the source (mermaidBlockAt).
 */
function isDiagramBlock(block: Element | null | undefined): block is Element {
	return !!block && (block.classList.contains("cm-lang-mermaid") || block.querySelector(".mermaid") !== null);
}

/** The Mermaid code blocks of a document, by position; worked out once per document. */
const diagramBlocks = new WeakMap<Text, { from: number; to: number }[]>();

/** The fenced Mermaid block `pos` is in — from its opening fence to its closing one — or null. */
function mermaidBlockAt(doc: Text, pos: number): { from: number; to: number } | null {
	let blocks = diagramBlocks.get(doc);
	if (!blocks) {
		blocks = [];
		let open: { fence: string; from: number; mermaid: boolean } | null = null;
		for (let n = 1; n <= doc.lines; n++) {
			const line = doc.line(n);
			const fence = /^[\s>]*(`{3,}|~{3,})(.*)$/.exec(line.text);
			if (!fence) continue;
			const marks = fence[1] ?? "";
			const rest = (fence[2] ?? "").trim();
			if (!open) {
				open = { fence: marks, from: line.from, mermaid: /^mermaid\b/i.test(rest) };
			} else if (marks[0] === open.fence[0] && marks.length >= open.fence.length && !rest) {
				if (open.mermaid) blocks.push({ from: open.from, to: line.to });
				open = null;
			}
		}
		diagramBlocks.set(doc, blocks);
	}
	return blocks.find((block) => block.from <= pos && pos <= block.to) ?? null;
}

/**
 * The first position past a diagram: the start of the line after it, or the end of the line
 * before it when it ends the note; null when the diagram is the whole note.
 */
function afterBlock(doc: Text, block: { from: number; to: number }): number | null {
	if (block.to + 1 <= doc.length) return block.to + 1;
	if (block.from > 0) return block.from - 1;
	return null;
}

/** A Mermaid block of a note: its lines (0-based, fences included), code, and caption. */
interface MermaidSource {
	start: number;
	end: number;
	code: string;
	/** Its `%% caption %%`, else the heading it sits under; null for neither. */
	caption: string | null;
}

/** The note's Mermaid blocks, in order. Fences are matched as mermaidBlockAt matches them. */
function mermaidSources(text: string): MermaidSource[] {
	const lines = text.split("\n");
	const blocks: MermaidSource[] = [];
	let open: { fence: string; start: number; mermaid: boolean } | null = null;
	lines.forEach((line, n) => {
		const fence = /^[\s>]*(`{3,}|~{3,})(.*)$/.exec(line);
		if (!fence) return;
		const marks = fence[1] ?? "";
		const rest = (fence[2] ?? "").trim();
		if (!open) {
			open = { fence: marks, start: n, mermaid: /^mermaid\b/i.test(rest) };
		} else if (marks[0] === open.fence[0] && marks.length >= open.fence.length && !rest) {
			if (open.mermaid) {
				const code = lines.slice(open.start + 1, n).join("\n");
				const caption = /%%\s*caption\s*[:=]?\s*(.+?)\s*%%/i.exec(code)?.[1] ?? headingAbove(lines, open.start);
				blocks.push({ start: open.start, end: n, code, caption });
			}
			open = null;
		}
	});
	return blocks;
}

/** The text of the nearest heading above line `n`, or null. */
function headingAbove(lines: string[], n: number): string | null {
	for (let i = n - 1; i >= 0; i--) {
		const heading = /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(lines[i] ?? "");
		if (heading) return heading[1] ?? null;
	}
	return null;
}

/** Whether Mermaid can parse each diagram's code, asked once per code. */
const parsedDiagrams = new Map<string, Promise<boolean>>();

/** Whether Obsidian's Mermaid can parse a diagram: a check only, nothing is drawn. */
function parses(code: string): Promise<boolean> {
	let parsed = parsedDiagrams.get(code);
	if (!parsed) {
		parsed = (async () => {
			const mermaid = (await loadMermaid()) as {
				parse: (code: string, options: { suppressErrors: boolean }) => Promise<unknown>;
			};
			return (await mermaid.parse(code, { suppressErrors: true })) !== false;
		})().catch(() => false);
		parsedDiagrams.set(code, parsed);
	}
	return parsed;
}

/** Diagrams drawn for the zoom, by their code: each is drawn once. */
const drawnDiagrams = new Map<string, Promise<ZoomTarget | null>>();
let drawnCount = 0;

/** Draw a Mermaid diagram with Obsidian's own Mermaid (its theme and settings), off the page. */
function renderDiagram(code: string): Promise<ZoomTarget | null> {
	let drawn = drawnDiagrams.get(code);
	if (!drawn) {
		drawn = (async () => {
			const mermaid = (await loadMermaid()) as {
				render: (id: string, code: string) => Promise<{ svg: string }>;
			};
			const { svg } = await mermaid.render(`mermaid-enhanced-zoom-${++drawnCount}`, code);
			// Read as HTML, not XML: a label's line break comes out as `<br>`, which isn't XML,
			// and one in any label failed the whole diagram — an empty thumbnail.
			const parsed = new DOMParser().parseFromString(svg, "text/html").body.querySelector("svg");
			return parsed instanceof SVGSVGElement ? (document.importNode(parsed, true) as SVGSVGElement) : null;
		})().catch((error: unknown) => {
			console.error("mermaid-enhanced: couldn't draw a diagram for the zoom", error);
			drawnDiagrams.delete(code);
			return null;
		});
		drawnDiagrams.set(code, drawn);
	}
	return drawn;
}
