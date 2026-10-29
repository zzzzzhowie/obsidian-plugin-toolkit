import { Prec, type Extension } from "@codemirror/state";
import {
	type BlockInfo,
	type EditorView,
	GutterMarker,
	lineNumberWidgetMarker,
	ViewPlugin,
	type ViewUpdate,
	type WidgetType,
} from "@codemirror/view";

/**
 * A line number on every line of a block Live Preview draws in place of its lines. The block is
 * one widget, so the gutter has one element for it, numbered with its first line only. This puts
 * a marker on that element numbering the block's lines, each level with where it's drawn:
 * - a table: the header with its line, then, past the delimiter row (not drawn), each row with
 *   its own, at the row's first line of text;
 * - a callout: each line at its text as the callout shows it, found by that text; a line with no
 *   text to show (a blank `>`, a fence) in the gap where it falls, if a number fits there;
 * - anything else — a diagram, math, HTML — is a picture: its first line at its top, its last at
 *   its bottom. The lines between have no place in a picture.
 *
 * Which numbers come from the document; where they go, from the block as drawn, so that's left
 * to a pass after each redraw (`RowPlacer`): blocks grow, change, or are drawn only after the
 * gutter has asked for its markers.
 *
 * Obsidian's CodeMirror also numbers a widget's block as a line, in an element of its own under
 * the marker's: that first-line number is hidden wherever a marker's covers it.
 */

const ROWS_CLS = "line-numbers-block-rows";
const ROW_CLS = "line-numbers-block-row";
/** On the gutter element a block's marker covers. */
const COVERED_CLS = "line-numbers-block-covered";

/** How a block's lines are numbered: see the top of this file. */
type Kind = "table" | "callout" | "picture";

interface RowPlace {
	/** From the top of the block, in CSS pixels. */
	top: number;
	height: number;
}

/** Where each block's lines were last found, by the block's position: a new marker starts there. */
const placesByView = new WeakMap<EditorView, Map<number, Array<RowPlace | undefined>>>();

class BlockRowsMarker extends GutterMarker {
	elementClass = "line-numbers-block";

	constructor(
		readonly from: number,
		readonly lines: number[],
		readonly active: number,
		private readonly format: (line: number) => string,
	) {
		super();
	}

	eq(other: GutterMarker): boolean {
		return (
			other instanceof BlockRowsMarker &&
			other.from === this.from &&
			other.active === this.active &&
			other.lines.length === this.lines.length &&
			other.lines.every((line, i) => line === this.lines[i])
		);
	}

	toDOM(view: EditorView): Node {
		const doc = view.dom.ownerDocument;
		// One node, as a marker must be; the numbers in it are placed against the gutter element.
		const rows = doc.createElement("span");
		rows.className = ROWS_CLS;
		rows.dataset.from = String(this.from);
		const places = placesByView.get(view)?.get(this.from);
		this.lines.forEach((line, i) => {
			const number = rows.appendChild(doc.createElement("span"));
			number.className = line === this.active ? `${ROW_CLS} is-active` : ROW_CLS;
			number.textContent = this.format(line);
			place(number, places?.[i]);
		});
		return rows;
	}
}

/** Put a number at its line, or keep it out of sight until its line is found. */
function place(number: HTMLElement, at: RowPlace | undefined): void {
	number.style.visibility = at ? "" : "hidden";
	if (!at) return;
	number.style.top = `${at.top}px`;
	number.style.height = number.style.lineHeight = `${at.height}px`;
}

/** `format` writes a line's number as the gutter's own numbers are written. */
export function blockRowNumbers(highlightActiveLine: boolean, format: (line: number) => string): Extension {
	return [
		// Ahead of any other widget marker for the line-number gutter.
		Prec.highest(lineNumberWidgetMarker.of((view, widget, block) => blockMarker(view, widget, block, highlightActiveLine, format))),
		RowPlacer,
	];
}

function blockMarker(
	view: EditorView,
	widget: WidgetType,
	block: BlockInfo,
	highlightActiveLine: boolean,
	format: (line: number) => string,
): GutterMarker | null {
	const doc = view.state.doc;
	const first = doc.lineAt(block.from).number;
	const last = doc.lineAt(block.to).number;
	if (first === last) return null;
	const lines = numberedLines(widgetKind(widget), first, last);
	const head = doc.lineAt(view.state.selection.main.head).number;
	return new BlockRowsMarker(block.from, lines, highlightActiveLine && lines.includes(head) ? head : -1, format);
}

/** What a widget is, from the widget, as the gutter asks for its marker. */
function widgetKind(widget: WidgetType): Kind {
	// Obsidian's table widget, as Sticky Table Header knows it: it finds the cell under a point.
	if (typeof (widget as { getClosestCell?: unknown }).getClosestCell === "function") return "table";
	if ((widget as { clazz?: unknown }).clazz === "cm-callout") return "callout";
	return "picture";
}

/** What a widget is, from what it drew, as RowPlacer finds it. */
function drawnKind(el: HTMLElement): Kind {
	if (el.classList.contains("cm-table-widget")) return "table";
	if (el.classList.contains("cm-callout")) return "callout";
	return "picture";
}

/** The lines of a block, `first` to `last`, that get a number. */
function numberedLines(kind: Kind, first: number, last: number): number[] {
	if (kind === "picture") return [first, last];
	const lines: number[] = [];
	for (let line = first; line <= last; line++) if (kind !== "table" || line !== first + 1) lines.push(line);
	return lines;
}

interface Found {
	numbers: HTMLElement[];
	places: Array<RowPlace | undefined>;
}

/** After each redraw, sets every block's numbers level with its lines. */
const RowPlacer = ViewPlugin.fromClass(
	class {
		constructor(readonly view: EditorView) {
			this.schedule();
		}

		update(update: ViewUpdate): void {
			if (update.docChanged || update.viewportChanged || update.geometryChanged || update.selectionSet) this.schedule();
		}

		private schedule(): void {
			this.view.requestMeasure({ key: this, read: (view) => this.read(view), write: (found, view) => this.write(found, view) });
		}

		private read(view: EditorView): Found[] {
			const found: Found[] = [];
			const places = new Map<number, Array<RowPlace | undefined>>();
			const doc = view.state.doc;
			// A widget's DOM, CodeMirror's mark on it.
			for (const block of Array.from(view.contentDOM.querySelectorAll<HTMLElement>(':scope > [contenteditable="false"]'))) {
				const from = view.posAtDOM(block);
				const first = doc.lineAt(from).number;
				const last = doc.lineAt(view.lineBlockAt(from).to).number;
				if (first === last) continue;
				const kind = drawnKind(block);
				const lines = numberedLines(kind, first, last);
				const rows =
					kind === "table"
						? rowPlaces(block, view.scaleY)
						: kind === "callout"
							? textPlaces(block, lines.map((line) => doc.line(line).text), view.scaleY, view.defaultLineHeight)
							: picturePlaces(block, view.scaleY, view.defaultLineHeight);
				places.set(from, rows);
				const marker = view.dom.querySelector<HTMLElement>(`.${ROWS_CLS}[data-from="${from}"]`);
				if (marker) found.push({ numbers: Array.from(marker.children) as HTMLElement[], places: rows });
			}
			placesByView.set(view, places);
			return found;
		}

		private write(found: Found[], view: EditorView): void {
			for (const { numbers, places } of found) numbers.forEach((number, i) => place(number, places[i]));
			// The first-line number drawn for the same block, if this CodeMirror draws one: the
			// element right before the marker's, as tall as it, which the marker's sits back over.
			// Covered only once the marker's own first number is up.
			for (const el of Array.from(view.dom.querySelectorAll(`.${COVERED_CLS}`))) el.classList.remove(COVERED_CLS);
			for (const el of Array.from(view.dom.querySelectorAll<HTMLElement>(".cm-lineNumbers .line-numbers-block"))) {
				const before = el.previousElementSibling as HTMLElement | null;
				const own = el.querySelector<HTMLElement>(`.${ROW_CLS}`);
				if (before && own?.style.visibility !== "hidden" && before.style.height === el.style.height && el.style.marginTop === `-${el.style.height}`) {
					before.classList.add(COVERED_CLS);
				}
			}
		}
	},
);

/** Each row's first line of text, from the table's top: the header, then the body rows. */
function rowPlaces(table: HTMLElement, scaleY: number): RowPlace[] {
	const header = table.querySelector<HTMLTableRowElement>("thead tr");
	const body = Array.from(table.querySelectorAll<HTMLTableRowElement>("tbody tr"));
	if (!header) return [];
	const top = table.getBoundingClientRect().top;
	const bodyTop = body[0]?.cells[0]?.getBoundingClientRect().top;
	return [header, ...body].map((tr, i) => {
		const cellRect = (tr.cells[0] ?? tr).getBoundingClientRect();
		// A header stuck to the top (Sticky Table Header) is drawn where the scroll took it, not
		// at its place in the table, which is right above the first row.
		const rowTop = i === 0 && bodyTop !== undefined ? bodyTop - cellRect.height : cellRect.top;
		const text = firstTextLine(tr);
		return {
			top: Math.round((rowTop + text.top - cellRect.top - top) / scaleY),
			height: Math.round(text.height / scaleY),
		};
	});
}

/** Where a row's first line of text is: in its first cell, or the cell's first line box when it's empty. */
function firstTextLine(tr: HTMLTableRowElement): { top: number; height: number } {
	const cell = tr.cells[0];
	if (!cell) return tr.getBoundingClientRect();
	const doc = cell.ownerDocument;
	const walker = doc.createTreeWalker(cell, NodeFilter.SHOW_TEXT);
	const range = doc.createRange();
	for (let node = walker.nextNode(); node; node = walker.nextNode()) {
		if (!node.textContent?.trim()) continue;
		range.selectNodeContents(node);
		// None while hidden: the cell being edited hides its text behind an editor.
		const rect = range.getClientRects()[0];
		if (rect) return rect;
	}
	const style = getComputedStyle(cell);
	const rect = cell.getBoundingClientRect();
	const lineHeight = parseFloat(style.lineHeight);
	return {
		top: rect.top + parseFloat(style.borderTopWidth) + parseFloat(style.paddingTop),
		height: Number.isNaN(lineHeight) ? rect.height : lineHeight,
	};
}

/** A picture's first line at its top and its last at its bottom, when it's tall enough for both. */
function picturePlaces(block: HTMLElement, scaleY: number, lineHeight: number): RowPlace[] {
	const height = block.getBoundingClientRect().height / scaleY;
	const first = { top: 0, height: lineHeight };
	return height < 2 * lineHeight ? [first] : [first, { top: Math.round(height - lineHeight), height: lineHeight }];
}

/** What's left out of a line's text and what's drawn of it when finding the one in the other. */
const MARKUP = /[\s|*_`~=>\\"“”-]/;

/** How long a start of a line is looked for, then a shorter one: the rest may be drawn otherwise. */
const KEY_LENGTHS = [16, 6];

/** How much of a line's height a gap needs to hold the number of a line with no text of its own. */
const MIN_GAP = 0.6;

interface TextPlace extends RowPlace {
	/** Where the line's text ends, from the block's top. */
	bottom: number;
}

/**
 * Each of a callout's `sources` (its lines) level with its text where the callout draws it: the
 * text found in what's drawn, line after line, by the line's start, both read without markup or
 * spacing (`MARKUP`). The first line, whatever its text, is at the top.
 */
function textPlaces(block: HTMLElement, sources: string[], scaleY: number, lineHeight: number): Array<RowPlace | undefined> {
	const drawn = drawnText(block);
	const blockRect = block.getBoundingClientRect();
	const range = block.ownerDocument.createRange();
	const rectAt = (at: number): DOMRect => {
		const char = drawn.chars[at];
		if (!char) return blockRect;
		range.setStart(char.node, char.offset);
		range.setEnd(char.node, char.offset + 1);
		return range.getClientRects()[0] ?? range.getBoundingClientRect();
	};
	let from = 0;
	const found: Array<TextPlace | undefined> = sources.map((source) => {
		const want = flatten(shownText(source));
		if (!want) return undefined;
		for (const length of KEY_LENGTHS) {
			const at = drawn.text.indexOf(want.slice(0, length), from);
			if (at < 0) continue;
			let end = at + Math.min(length, want.length);
			while (end < drawn.text.length && end - at < want.length && drawn.text[end] === want[end - at]) end++;
			from = end;
			const start = rectAt(at);
			return {
				top: (start.top - blockRect.top) / scaleY,
				height: start.height / scaleY,
				bottom: (rectAt(end - 1).bottom - blockRect.top) / scaleY,
			};
		}
		return undefined;
	});
	found[0] ??= { top: 0, height: lineHeight, bottom: lineHeight };
	// A line with no text of its own — a blank `>`, a fence, a table's delimiter row — goes in
	// the gap between the lines around it, shared out with the others there, if a number fits.
	const height = blockRect.height / scaleY;
	for (let i = 1; i < found.length; ) {
		if (found[i]) {
			i++;
			continue;
		}
		let j = i;
		while (j < found.length && !found[j]) j++;
		const above = found[i - 1]?.bottom ?? 0;
		const slot = ((found[j]?.top ?? height) - above) / (j - i);
		if (slot >= MIN_GAP * lineHeight) {
			const each = Math.min(slot, lineHeight);
			for (let k = i; k < j; k++) {
				const top = above + (k - i) * slot + (slot - each) / 2;
				found[k] = { top, height: each, bottom: top + each };
			}
		}
		i = j;
	}
	// Lines of one paragraph run on in it: a line drawn on the line before's row keeps its number
	// out of the way, where that one's is.
	let free = -Infinity;
	return found.map((at) => {
		if (!at || at.top < free - 1) return undefined;
		free = at.top + at.height;
		return { top: Math.round(at.top), height: Math.round(at.height) };
	});
}

interface DrawnText {
	/** What's drawn, read as `flatten` reads it. */
	text: string;
	/** Where each of its characters is. */
	chars: Array<{ node: Text; offset: number }>;
}

function drawnText(block: HTMLElement): DrawnText {
	const drawn: DrawnText = { text: "", chars: [] };
	const walker = block.ownerDocument.createTreeWalker(block, NodeFilter.SHOW_TEXT);
	for (let node = walker.nextNode(); node; node = walker.nextNode()) {
		const parent = node.parentElement;
		// Only what's drawn: a folded callout keeps its content, hidden. A button's label is no line's.
		if (!parent || parent.closest("button") || !parent.checkVisibility()) continue;
		const text = node as Text;
		for (let i = 0; i < text.data.length; i++) {
			const ch = flatChar(text.data.charAt(i));
			if (!ch) continue;
			drawn.text += ch;
			drawn.chars.push({ node: text, offset: i });
		}
	}
	return drawn;
}

/** A character as a line is found by it: none for markup and spacing, a letter in either case alike. */
function flatChar(ch: string): string {
	if (MARKUP.test(ch)) return "";
	return ch < "\x80" ? ch.toLowerCase() : ch;
}

function flatten(text: string): string {
	let flat = "";
	for (let i = 0; i < text.length; i++) flat += flatChar(text.charAt(i));
	return flat;
}

/** What of a callout's source line the callout shows as text, near enough to find it by. */
function shownText(source: string): string {
	const text = source.replace(/^(\s*>)+/, "");
	// A callout's own first line, nested ones too: its title, else its type, as Obsidian titles it.
	const callout = /^\s*\[!([^\]]*)\][+-]?\s*(.*)$/.exec(text);
	if (callout) return callout[2] || (callout[1] ?? "");
	// A fence, a rule, a table's delimiter row: nothing drawn as text.
	if (/^\s*(```|~~~|\$\$)|^[\s|:-]*$/.test(text)) return "";
	return text
		.replace(/^\s*(?:[-*+]|\d+[.)])\s+(?:\[.\]\s+)?/, "")
		.replace(/^\s*#{1,6}\s+/, "")
		.replace(/!\[\[[^\]]*\]\]|!\[[^\]]*\]\([^)]*\)/g, "")
		.replace(/\[\[[^\]|]*\|([^\]]*)\]\]/g, "$1")
		.replace(/\[\[([^\]]*)\]\]/g, (_, target: string) => target.replace(/[#^]/g, ""))
		.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
		.replace(/\[\^[^\]]*\]|<[^>]+>/g, "");
}
