import { EditorView } from "@codemirror/view";
import { MarkdownView, Notice, setIcon } from "obsidian";

import {
	clearAll,
	collectDomText,
	CURRENT_HIGHLIGHT,
	highlightApiAvailable,
	MATCH_HIGHLIGHT,
	paint,
	rangeFor,
} from "./highlight";
import { findInText, type Match, matchIndexNear } from "./search";

const REPAINT_DELAY = 40;
/** Held off while the user is still typing, so the view does not lurch per keystroke. */
const REFRESH_DELAY = 120;
/**
 * Frames allowed to converge on centring a match. One or two once the match is rendered;
 * a target far outside the viewport needs several, since each pass jumps on a height-map
 * estimate, waits for CodeMirror to build that region, then corrects.
 */
const MAX_SCROLL_PASSES = 12;
/** Close enough to centred, in pixels. */
const SCROLL_TOLERANCE = 8;

export class FindBar {
	readonly view: MarkdownView;

	private readonly barEl: HTMLElement;
	private readonly inputEl: HTMLInputElement;
	private readonly counterEl: HTMLElement;
	private readonly caseButtonEl: HTMLElement;

	private matches: Match[] = [];
	private current = 0;
	private caseSensitive: boolean;
	private repaintTimer: number | null = null;
	private refreshTimer: number | null = null;
	private closed = false;
	private composing = false;
	private pendingCenter = false;
	private centerPasses = 0;
	private observer: MutationObserver | null = null;
	private readonly onClose: (bar: FindBar) => void;
	private readonly onScroll = () => this.schedulePaint();

	constructor(view: MarkdownView, caseSensitive: boolean, onClose: (bar: FindBar) => void) {
		this.view = view;
		this.caseSensitive = caseSensitive;
		this.onClose = onClose;

		this.barEl = view.containerEl.createDiv({ cls: "sticky-find-bar" });

		this.inputEl = this.barEl.createEl("input", {
			cls: "sticky-find-input",
			attr: { type: "text", placeholder: "Find in file", "aria-label": "Find in file" },
		});

		this.counterEl = this.barEl.createSpan({ cls: "sticky-find-counter", text: "0/0" });

		this.caseButtonEl = this.barEl.createEl("button", {
			cls: "sticky-find-button sticky-find-case",
			text: "Aa",
			attr: { "aria-label": "Match case" },
		});
		this.caseButtonEl.toggleClass("is-active", this.caseSensitive);

		this.iconButton("chevron-up", "Previous match", () => this.step(-1));
		this.iconButton("chevron-down", "Next match", () => this.step(1));
		this.iconButton("x", "Close", () => this.close());

		// An IME fires `input` for every intermediate state of the composition buffer, so
		// typing 高亮流量 in pinyin would otherwise run a full search and a scroll for
		// "gao", "gao'liang", "高亮l" and a dozen other strings that were never the query.
		this.inputEl.addEventListener("compositionstart", () => {
			this.composing = true;
		});
		this.inputEl.addEventListener("compositionend", () => {
			this.composing = false;
			this.refresh();
		});
		this.inputEl.addEventListener("input", (evt) => {
			if (this.composing || (evt as InputEvent).isComposing) return;
			// Debounced: searching per keystroke means a scroll per keystroke, and mid-word
			// prefixes match somewhere else entirely, so the view lurches around while typing.
			this.scheduleRefresh();
		});

		this.inputEl.addEventListener("keydown", (evt) => this.onKeyDown(evt));
		this.caseButtonEl.addEventListener("click", () => this.toggleCase());

		const cm = this.cm();
		cm?.scrollDOM.addEventListener("scroll", this.onScroll, { passive: true });

		// Ranges point at live text nodes. CodeMirror recycles those whenever it rebuilds
		// its viewport — which keeps happening after we scroll, as embedded images settle
		// and blocks render — and a range whose node was replaced simply stops painting.
		// Repainting on any content mutation is what makes the highlight stick.
		if (cm) {
			this.observer = new MutationObserver(() => this.schedulePaint());
			this.observer.observe(cm.contentDOM, { childList: true, subtree: true, characterData: true });
		}

		if (!highlightApiAvailable()) {
			new Notice("Matches cannot be painted: this version of Obsidian has no CSS custom highlight API.");
		}
	}

	/**
	 * Obsidian's own icon button. `clickable-icon` is what supplies `--icon-size` and the
	 * hover treatment; a bare <button> leaves the injected SVG unsized and invisible.
	 */
	private iconButton(icon: string, label: string, onClick: () => void): HTMLElement {
		const el = this.barEl.createEl("button", {
			cls: "sticky-find-button clickable-icon",
			attr: { "aria-label": label },
		});
		setIcon(el, icon);
		el.addEventListener("click", onClick);
		return el;
	}

	/** The CodeMirror view behind this Markdown view, when it has one (not Reading view). */
	private cm(): EditorView | null {
		const editor = this.view.editor as unknown as { cm?: EditorView } | undefined;
		return editor?.cm ?? null;
	}

	focus(seed?: string): void {
		if (seed !== undefined && seed.length > 0) {
			this.inputEl.value = seed;
			this.refresh();
		}
		this.inputEl.focus();
		this.inputEl.select();
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		if (this.repaintTimer !== null) window.clearTimeout(this.repaintTimer);
		if (this.refreshTimer !== null) window.clearTimeout(this.refreshTimer);
		this.observer?.disconnect();
		this.observer = null;
		this.cm()?.scrollDOM.removeEventListener("scroll", this.onScroll);
		clearAll();
		this.barEl.remove();
		this.onClose(this);
	}

	get matchCase(): boolean {
		return this.caseSensitive;
	}

	private onKeyDown(evt: KeyboardEvent): void {
		if (evt.isComposing) return;

		if (evt.key === "Escape") {
			evt.preventDefault();
			this.close();
			return;
		}
		if (evt.key === "Enter") {
			evt.preventDefault();
			this.step(evt.shiftKey ? -1 : 1);
		}
	}

	private toggleCase(): void {
		this.caseSensitive = !this.caseSensitive;
		this.caseButtonEl.toggleClass("is-active", this.caseSensitive);
		this.inputEl.focus();
		this.refresh();
	}

	/** Recompute the match list from the document text and jump to the nearest one. */
	private refresh(): void {
		const cm = this.cm();
		if (!cm) return;

		const term = this.inputEl.value;
		this.matches = findInText(cm.state.doc.toString(), term, this.caseSensitive);

		if (this.matches.length === 0) {
			this.current = 0;
			this.updateCounter();
			this.barEl.toggleClass("is-empty", term.length > 0);
			clearAll();
			return;
		}

		this.barEl.toggleClass("is-empty", false);
		this.goTo(matchIndexNear(this.matches, cm.state.selection.main.head));
	}

	private step(delta: number): void {
		if (this.matches.length === 0) return;
		this.goTo(this.current + delta);
	}

	private goTo(index: number): void {
		const cm = this.cm();
		if (!cm || this.matches.length === 0) return;

		const count = this.matches.length;
		this.current = ((index % count) + count) % count;
		const target = this.matches[this.current];
		if (!target) return;

		if (target.to > cm.state.doc.length) {
			// Document changed under us; positions are stale.
			this.refresh();
			return;
		}

		this.updateCounter();
		this.freeCursorFromTable(cm);
		this.pendingCenter = true;
		this.centerPasses = 0;

		// Paint synchronously first. When the match is already rendered — stepping between
		// nearby matches, which is most of the time — its range exists right now and a single
		// scroll assignment finishes the job. Nothing jumps to an estimated position and then
		// corrects itself, which is what made the view flicker.
		this.centerOnRange(cm, this.computeAndPaint(cm));
	}

	/**
	 * Park the cursor just above the table it is sitting in, if any.
	 *
	 * Without this there is a hole in the premise: a table whose range already contains the
	 * selection is showing Markdown source before the bar ever opens, and never touching the
	 * selection afterwards cannot bring it back.
	 *
	 * Two details matter. It runs on navigation rather than on open, so that opening the bar
	 * and typing nothing leaves the document exactly where it was. And it moves the cursor
	 * through CodeMirror rather than `Editor.setCursor`, which scrolls its new position into
	 * view — that scroll was the jump.
	 */
	private freeCursorFromTable(cm: EditorView): void {
		const file = this.view.file;
		if (!file) return;

		const sections = this.view.app.metadataCache.getFileCache(file)?.sections;
		if (!sections) return;

		const line = cm.state.doc.lineAt(cm.state.selection.main.head).number - 1;
		const table = sections.find(
			(section) =>
				section.type === "table" &&
				line >= section.position.start.line &&
				line <= section.position.end.line,
		);
		if (!table) return;

		const above = Math.max(0, table.position.start.line - 1);
		cm.dispatch({ selection: { anchor: cm.state.doc.line(above + 1).from } });
	}

	/**
	 * Centre the viewport on the painted range for the current match.
	 *
	 * Everything that works off the source offset gets this wrong. `coordsAtPos` cannot see
	 * into a `Decoration.replace` widget, so for a match inside a rendered table it reports
	 * the widget's boundary and the centring converges instantly on the wrong row.
	 * `lineBlockAt` reads the height map, which is an estimate until embedded images lay
	 * out. The DOM range we just painted has none of those problems: its client rect is
	 * where the match actually is on screen.
	 */
	private centerOnRange(cm: EditorView, range: Range | undefined): void {
		if (this.closed || !this.pendingCenter) return;

		const scroller = cm.scrollDOM;
		const target = this.matches[this.current];
		if (this.centerPasses++ > MAX_SCROLL_PASSES || !target) {
			this.pendingCenter = false;
			return;
		}

		const rect = range?.getBoundingClientRect();
		if (!rect || (rect.height === 0 && rect.top === 0)) {
			// Not rendered yet. The height map is a poor estimate but it is the only lever
			// that reaches a region CodeMirror has never built.
			const block = cm.lineBlockAt(target.from);
			scroller.scrollTop = Math.max(0, block.top + cm.documentPadding.top - scroller.clientHeight / 2);
			this.nextCenterPass(cm);
			return;
		}

		const wanted = scroller.getBoundingClientRect().top + scroller.clientHeight / 2;
		const delta = rect.top - wanted;
		if (Math.abs(delta) <= SCROLL_TOLERANCE) {
			this.pendingCenter = false;
			return;
		}

		scroller.scrollTop += delta;
		this.nextCenterPass(cm);
	}

	/**
	 * Next correction on the following frame.
	 *
	 * On a frame rather than the repaint timer: a correction that waits out the debounce is
	 * a second visible scroll position, which reads as a flicker. Back to back frames land
	 * close enough together to look like one movement.
	 */
	private nextCenterPass(cm: EditorView): void {
		requestAnimationFrame(() => {
			if (this.closed || !this.pendingCenter) return;
			this.centerOnRange(cm, this.computeAndPaint(cm));
		});
	}

	private updateCounter(): void {
		const total = this.matches.length;
		this.counterEl.setText(`${total === 0 ? 0 : this.current + 1}/${total}`);
	}

	private scheduleRefresh(): void {
		if (this.refreshTimer !== null) window.clearTimeout(this.refreshTimer);
		this.refreshTimer = window.setTimeout(() => {
			this.refreshTimer = null;
			this.refresh();
		}, REFRESH_DELAY);
	}

	private schedulePaint(): void {
		if (this.repaintTimer !== null) window.clearTimeout(this.repaintTimer);
		this.repaintTimer = window.setTimeout(() => {
			this.repaintTimer = null;
			this.repaint();
		}, REPAINT_DELAY);
	}

	/**
	 * Paint the matches that are currently rendered.
	 *
	 * CodeMirror only builds DOM for its viewport, so this covers what is on screen
	 * rather than the whole file. The authoritative count in the counter comes from the
	 * document scan instead.
	 */
	private repaint(): void {
		const cm = this.cm();
		if (!cm) {
			clearAll();
			return;
		}
		// Centring, when in progress, drives its own frame loop — this path only refreshes
		// the paint after the DOM moved underneath it.
		this.computeAndPaint(cm);
	}

	/** Rebuild and paint the ranges for the rendered region; returns the current one. */
	private computeAndPaint(cm: EditorView): Range | undefined {
		const term = this.inputEl.value;
		if (!term || this.matches.length === 0) {
			clearAll();
			return undefined;
		}

		const dom = collectDomText(cm.contentDOM);
		const ranges: Range[] = [];
		for (const hit of findInText(dom.text, term, this.caseSensitive)) {
			const range = rangeFor(dom, hit.from, hit.to);
			if (range) ranges.push(range);
		}

		const currentIndex = this.chooseCurrent(cm, ranges);
		const others: Range[] = [];
		let current: Range | undefined;
		ranges.forEach((range, index) => {
			if (index === currentIndex) current = range;
			else others.push(range);
		});

		paint(MATCH_HIGHLIGHT, others);
		paint(CURRENT_HIGHLIGHT, current ? [current] : []);

		return current;
	}

	/**
	 * Which painted range corresponds to the match we navigated to.
	 *
	 * Inside a rendered table the source offset cannot be mapped into the widget's DOM,
	 * so we align by ordinal: both scans walk the same rendered region in document
	 * order, so the Nth source match in the viewport is the Nth painted range. When the
	 * two counts disagree — a match buried in link syntax that renders as different
	 * text, for instance — fall back to whichever range sits nearest the target on screen.
	 */
	private chooseCurrent(cm: EditorView, ranges: Range[]): number {
		const target = this.matches[this.current];
		if (!target || ranges.length === 0) return -1;

		const { from, to } = cm.viewport;

		// Outside the rendered range, none of the painted ranges can be this match. Saying
		// otherwise is not a harmless guess: centring would lock onto whichever match happens
		// to be on screen, find it already centred, and declare success without ever
		// scrolling — which is exactly why only the matches inside the first viewport worked.
		if (target.from < from || target.to > to) return -1;

		let ordinal = -1;
		let visible = 0;
		for (let i = 0; i < this.matches.length; i++) {
			const match = this.matches[i];
			if (!match || match.from < from || match.to > to) continue;
			if (i === this.current) ordinal = visible;
			visible++;
		}
		if (ordinal >= 0 && visible === ranges.length) return ordinal;

		// Counts disagree — a match that renders as different text, inside link syntax say.
		// The target is at least rendered, so its own coordinates are a usable reference.
		const coords = cm.coordsAtPos(target.from);
		if (!coords) return -1;

		const targetY = (coords.top + coords.bottom) / 2;
		let best = 0;
		let bestDistance = Number.POSITIVE_INFINITY;
		ranges.forEach((range, index) => {
			const rect = range.getBoundingClientRect();
			const distance = Math.abs((rect.top + rect.bottom) / 2 - targetY);
			if (distance < bestDistance) {
				bestDistance = distance;
				best = index;
			}
		});
		return best;
	}
}
