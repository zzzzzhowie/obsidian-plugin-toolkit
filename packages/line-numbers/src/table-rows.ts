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
 * A line number on every row of a Live Preview table. The table is one widget in place of all
 * its lines, so the gutter has one block for it, numbered with its first line only. This puts
 * a marker on that block numbering each row — the header with its line, then, past the
 * delimiter row (not drawn), each row with its own — and sets each number level with its row's
 * first line of text.
 *
 * Which numbers come from the document; where they go, from the table as drawn, so that's left
 * to a pass after each redraw (`RowPlacer`): rows grow, get added, or are drawn only after the
 * gutter has asked for its markers.
 *
 * Obsidian's CodeMirror also numbers a widget's block as a line, in an element of its own
 * under the marker's: that first-line number is hidden wherever a table's marker covers it.
 */

const ROWS_CLS = "line-numbers-table-rows";
const ROW_CLS = "line-numbers-table-row";
/** On the gutter element a table's marker covers. */
const COVERED_CLS = "line-numbers-table-covered";

interface RowPlace {
	/** From the top of the table, in CSS pixels. */
	top: number;
	height: number;
}

/** Where each table's rows were last found, by the table's position: a new marker starts there. */
const placesByView = new WeakMap<EditorView, Map<number, RowPlace[]>>();

class TableRowsMarker extends GutterMarker {
	elementClass = "line-numbers-table";

	constructor(
		readonly from: number,
		readonly lines: number[],
		readonly active: number,
	) {
		super();
	}

	eq(other: GutterMarker): boolean {
		return (
			other instanceof TableRowsMarker &&
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
			number.textContent = String(line);
			place(number, places?.[i]);
		});
		return rows;
	}
}

/** Put a number at its row, or keep it out of sight until its row is found. */
function place(number: HTMLElement, at: RowPlace | undefined): void {
	number.style.visibility = at ? "" : "hidden";
	if (!at) return;
	number.style.top = `${at.top}px`;
	number.style.height = number.style.lineHeight = `${at.height}px`;
}

export function tableRowNumbers(highlightActiveLine: boolean): Extension {
	return [
		// Ahead of any other widget marker for the line-number gutter.
		Prec.highest(lineNumberWidgetMarker.of((view, widget, block) => tableMarker(view, widget, block, highlightActiveLine))),
		RowPlacer,
	];
}

function tableMarker(view: EditorView, widget: WidgetType, block: BlockInfo, highlightActiveLine: boolean): GutterMarker | null {
	// Obsidian's table widget, as Sticky Table Header knows it: it finds the cell under a point.
	if (typeof (widget as { getClosestCell?: unknown }).getClosestCell !== "function") return null;
	const doc = view.state.doc;
	const first = doc.lineAt(block.from).number;
	const last = doc.lineAt(block.to).number;
	const lines = [first];
	for (let line = first + 2; line <= last; line++) lines.push(line);
	const head = doc.lineAt(view.state.selection.main.head).number;
	return new TableRowsMarker(block.from, lines, highlightActiveLine && head >= first && head <= last ? head : -1);
}

interface Found {
	numbers: HTMLElement[];
	places: RowPlace[];
}

/** After each redraw, sets every table's numbers level with its rows. */
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
			const places = new Map<number, RowPlace[]>();
			for (const table of Array.from(view.contentDOM.querySelectorAll<HTMLElement>(":scope > .cm-table-widget"))) {
				const from = view.posAtDOM(table);
				const rows = rowPlaces(table, view.scaleY);
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
			for (const el of Array.from(view.dom.querySelectorAll(`.${COVERED_CLS}`))) el.classList.remove(COVERED_CLS);
			for (const el of Array.from(view.dom.querySelectorAll<HTMLElement>(".cm-lineNumbers .line-numbers-table"))) {
				const before = el.previousElementSibling as HTMLElement | null;
				if (before && before.style.height === el.style.height && el.style.marginTop === `-${el.style.height}`) {
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
