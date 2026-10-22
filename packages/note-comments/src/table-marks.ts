import type { EditorView } from "@codemirror/view";

import { isNoise } from "./anchor";

/**
 * Comments on text inside a table, drawn in the table as Live Preview shows it.
 *
 * A comment is a mark on the note's own text (editor.ts), and Live Preview puts a table on
 * screen as one widget that replaces its rows: marks inside it are never drawn. So a comment
 * on a table cell had no highlight, nothing to hover, nothing to click. Here each such
 * comment is found again in the widget — its row and column read off the source line, its
 * text matched in the cell with formatting set aside — and painted with the CSS Custom
 * Highlight API, which colours a Range without touching the widget's DOM (Obsidian owns it,
 * and edits cells in it). A Range has no element to hover, so the hover card and the click
 * ask `at` which comment is under the pointer.
 */

const HIGHLIGHT = "nc-table-highlight";

/** The Highlight API's maplike members, which this TypeScript's DOM types leave out. */
interface HighlightSet {
	add(range: Range): void;
	clear(): void;
}

interface HighlightRegistry {
	set(name: string, highlight: object): void;
	get(name: string): object | undefined;
	delete(name: string): void;
}

function highlightRegistry(): HighlightRegistry | null {
	return (CSS as unknown as { highlights?: HighlightRegistry }).highlights ?? null;
}

interface Painted {
	id: string;
	range: Range;
}

/** What the hover card and the click need of a commented passage: where it is drawn. */
export interface MarkedPassage {
	readonly doc: Document;
	readonly win: Window;
	readonly isConnected: boolean;
	getClientRects(): ArrayLike<DOMRect>;
	getBoundingClientRect(): DOMRect;
}

export class TableMarks {
	private readonly painted = new Map<EditorView, Painted[]>();
	private readonly frames = new Map<EditorView, number>();
	private readonly highlight: HighlightSet | null;

	constructor() {
		const registry = highlightRegistry();
		this.highlight = registry && typeof Highlight === "function" ? (new Highlight() as unknown as HighlightSet) : null;
		if (registry && this.highlight) registry.set(HIGHLIGHT, this.highlight);
	}

	/** Paint `view`'s table comments on the next frame; asked again before then, once. */
	schedule(view: EditorView, spans: () => Array<{ id: string; from: number; to: number }>): void {
		if (!this.highlight || this.frames.has(view)) return;
		this.frames.set(
			view,
			view.dom.win.requestAnimationFrame(() => {
				this.frames.delete(view);
				this.paint(view, spans());
			}),
		);
	}

	forget(view: EditorView): void {
		const frame = this.frames.get(view);
		if (frame !== undefined) view.dom.win.cancelAnimationFrame(frame);
		this.frames.delete(view);
		if (this.painted.delete(view)) this.rebuild();
	}

	/** The comment drawn in a table under the point, and where it is; null for none. */
	at(x: number, y: number): { id: string; view: EditorView; passage: MarkedPassage } | null {
		for (const [view, painted] of this.painted) {
			for (const { id, range } of painted) {
				const over = Array.from(range.getClientRects()).some(
					(rect) => x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom,
				);
				if (over) return { id, view, passage: passageOf(range) };
			}
		}
		return null;
	}

	destroy(): void {
		for (const view of [...this.frames.keys()]) this.forget(view);
		this.painted.clear();
		const registry = highlightRegistry();
		if (this.highlight && registry?.get(HIGHLIGHT) === this.highlight) registry.delete(HIGHLIGHT);
	}

	private paint(view: EditorView, spans: Array<{ id: string; from: number; to: number }>): void {
		const painted: Painted[] = [];
		for (const span of spans) {
			const range = rangeInTable(view, span.from, span.to);
			if (range) painted.push({ id: span.id, range });
		}
		const before = this.painted.get(view);
		if (painted.length === 0 && !before) return;
		if (painted.length === 0) this.painted.delete(view);
		else this.painted.set(view, painted);
		this.rebuild();
	}

	private rebuild(): void {
		const highlight = this.highlight;
		if (!highlight) return;
		highlight.clear();
		for (const painted of this.painted.values()) for (const { range } of painted) highlight.add(range);
	}
}

/** A Range as a MarkedPassage, for the hover card to place itself against. */
function passageOf(range: Range): MarkedPassage {
	const doc = range.startContainer.ownerDocument ?? document;
	return {
		doc,
		win: doc.defaultView ?? window,
		get isConnected() {
			return range.startContainer.isConnected;
		},
		getClientRects: () => range.getClientRects(),
		getBoundingClientRect: () => range.getBoundingClientRect(),
	};
}

/** A table row in Markdown source: it starts with a pipe. */
function isRow(text: string): boolean {
	return /^\s*\|/.test(text);
}

/**
 * Where `[from, to)` of the note is drawn in its table's widget, or null when it isn't in a
 * table row, the table isn't on screen, or the cell doesn't hold the text.
 */
function rangeInTable(view: EditorView, from: number, to: number): Range | null {
	const doc = view.state.doc;
	const line = doc.lineAt(from);
	if (!isRow(line.text)) return null;
	let start = line.number;
	while (start > 1 && isRow(doc.line(start - 1).text)) start--;
	const row = line.number - start;
	// The second line is the alignment row, drawn as nothing.
	if (row === 1) return null;
	const column = columnAt(line.text, from - line.from);
	const table = tableWidgetAt(view, doc.line(start).from)?.querySelector("table");
	const tr = row === 0 ? table?.tHead?.rows[0] : table?.tBodies[0]?.rows[row - 2];
	const cell = tr?.cells[column];
	if (!cell) return null;
	return rangeOfText(cell, doc.sliceString(from, Math.min(to, line.to)));
}

/** The cell `offset` falls in: unescaped pipes before it, less the leading one. */
function columnAt(text: string, offset: number): number {
	let pipes = 0;
	for (let i = 0; i < offset && i < text.length; i++) {
		if (text.charAt(i) === "\\") i++;
		else if (text.charAt(i) === "|") pipes++;
	}
	return Math.max(0, pipes - 1);
}

/** The table widget Live Preview draws for the table starting at `pos`. */
function tableWidgetAt(view: EditorView, pos: number): HTMLElement | null {
	for (const widget of Array.from(view.contentDOM.querySelectorAll<HTMLElement>(".cm-table-widget"))) {
		try {
			if (view.posAtDOM(widget) === pos) return widget;
		} catch {
			// Not part of this view's document any more.
		}
	}
	return null;
}

/**
 * Where `source` — a cell's Markdown — is drawn in `cell`. Compared without formatting, as
 * the anchoring does (isNoise): a `<br>` is a line break on screen, a link shows only its text,
 * `**` and backticks show nothing.
 *
 * With the pointer over it, Obsidian swaps a cell to a small editor of its own and hides what
 * it had rendered — the passage painted there went with it. The cell's editor is searched
 * then, where some markup may still be text (a `<br>` the editor shows as written), so the
 * source is tried as written too.
 */
function rangeOfText(cell: HTMLElement, source: string): Range | null {
	const editor = cell.querySelector<HTMLElement>(".cm-editor .cm-content");
	const root = editor && editor.getClientRects().length > 0 ? editor : cell;
	const shown = source
		.replace(/<br\s*\/?>/gi, " ")
		.replace(/\[\[(?:[^\]|]*\|)?([^\]]*)\]\]/g, "$1")
		.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");
	const text = textOf(root);
	for (const candidate of root === editor ? [shown, source] : [shown]) {
		const wanted = withoutNoise(candidate);
		const index = wanted ? text.chars.indexOf(wanted) : -1;
		if (index < 0) continue;
		const first = text.at[index];
		const last = text.at[index + wanted.length - 1];
		if (!first || !last) return null;
		const range = cell.ownerDocument.createRange();
		range.setStart(first.node, first.offset);
		range.setEnd(last.node, last.offset + 1);
		return range;
	}
	return null;
}

function withoutNoise(text: string): string {
	let out = "";
	for (const ch of text) if (!isNoise(ch)) out += ch;
	return out;
}

/** `root`'s text without noise, and the text node and offset each kept character is at. */
function textOf(root: HTMLElement): { chars: string; at: Array<{ node: Text; offset: number }> } {
	let chars = "";
	const at: Array<{ node: Text; offset: number }> = [];
	const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT);
	for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
		const data = node.data;
		for (let i = 0; i < data.length; i++) {
			const ch = data.charAt(i);
			if (isNoise(ch)) continue;
			chars += ch;
			at.push({ node, offset: i });
		}
	}
	return { chars, at };
}
