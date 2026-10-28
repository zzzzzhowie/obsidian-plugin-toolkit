/**
 * What a selection in a note is, as Claude is told and as the note shows it back: its lines
 * and, a line being a whole paragraph or a table row, which part of them — the table columns,
 * by their headers, and the text, when it's less than the whole line. One shape for both
 * ways a selection goes with a prompt: ⌥K's reference (`@path#12-14 (column "x") "text"`)
 * and Claudian's own 划词, which goes as its lines and their text (selectionReference). Both
 * are labelled (referenceLabel) and lit in the note (main.ts, revealReference) from it.
 */

/**
 * A reference as insertReference writes it: `@path`, its lines (`#12` or `#12-14`), then
 * which columns and what text, if it says.
 */
export const REFERENCE = /@([^\s@][^@\n]*?\.(?:md|canvas|excalidraw))(?:#(\d+)(?:-(\d+))?)?(?: \((?:column|columns) ([^)\n]*)\))?(?: "([^"\n]*)")?/g;

/** Lines of a note, 1-based and inclusive. */
export interface NoteLines {
	path: string;
	start: number;
	end: number;
}

/**
 * What's selected, as the composer refers to it: its lines and, a line being a whole
 * paragraph or a table row, which part of them — the table columns, by their headers, and
 * the text, when it's less than the whole line.
 */
export interface NoteReference extends NoteLines {
	columns?: string[];
	quote?: string;
}

/** `@path#first-last` (no lines: the whole file), then the columns and the text it's about, if any. */
export function referenceText(reference: NoteReference): string {
	const { path, start, end, columns, quote } = reference;
	let text = `@${path}${!start ? "" : start === end ? `#${start}` : `#${start}-${end}`}`;
	if (columns?.length) text += ` (${columns.length === 1 ? "column" : "columns"} ${columns.map((name) => `"${curlyQuotes(name)}"`).join(", ")})`;
	if (quote) {
		const flat = curlyQuotes(quote.replace(/\s+/g, " ").trim());
		// Long, its two ends: enough to tell where it starts and stops.
		text += ` "${flat.length > 100 ? `${flat.slice(0, 45)} … ${flat.slice(-45)}` : flat}"`;
	}
	return text;
}

/**
 * Say which part of `lines` is selected: the columns `columns` spans when the lines are rows
 * of a table, and `selected` when it's less than one whole line. Nothing more for whole lines,
 * or when `selected` is null (cells picked by class: their columns say it all).
 */
export function describe(lines: NoteLines, lineText: (n: number) => string, selected: string | null, columns: [number, number] | null): NoteReference {
	const whole = selected !== null && lines.start === lines.end ? flatten(selected) === flatten(lineText(lines.start)) : lines.start !== lines.end;
	if (selected !== null && whole) return lines;
	const reference: NoteReference = { ...lines };
	const header = columns ? tableHeader(lineText, lines.start) : null;
	if (header && columns) {
		const names: string[] = [];
		for (let i = columns[0]; i <= columns[1]; i++) names.push(header[i]?.replace(/[*_`]/g, "") || `#${i + 1}`);
		reference.columns = names;
	}
	if (selected !== null && lines.start === lines.end) reference.quote = selected;
	return reference;
}

/** The header cells of the table that line `row` is a row of; null when it isn't one. */
function tableHeader(lineText: (n: number) => string, row: number): string[] | null {
	const isRow = (n: number): boolean => /^\s*\|/.test(lineText(n));
	if (!isRow(row)) return null;
	let first = row;
	while (first > 1 && isRow(first - 1)) first--;
	return tableRowCells(lineText(first));
}

/** The column (0-based) of a table row that `offset` in its line falls in. */
export function columnAt(text: string, offset: number): number {
	let column = 0;
	let started = false;
	for (let i = 0; i < offset && i < text.length; i++) {
		const ch = text.charAt(i);
		if (ch === "\\") {
			i++;
			started = true;
		} else if (ch === "|") {
			// The pipe a row opens with bounds it; the others part cells.
			if (started) column++;
			started = true;
		} else if (!/\s/.test(ch)) started = true;
	}
	return column;
}

/** The columns of a rendered table a page selection runs across; null outside a table. */
export function columnsOf(selection: Selection | null): [number, number] | null {
	const cellOf = (node: Node | null | undefined): HTMLTableCellElement | null =>
		(node instanceof Element ? node : node?.parentElement)?.closest<HTMLTableCellElement>("td, th") ?? null;
	const [anchor, focus] = [cellOf(selection?.anchorNode), cellOf(selection?.focusNode)];
	if (!anchor || !focus) return null;
	return [Math.min(anchor.cellIndex, focus.cellIndex), Math.max(anchor.cellIndex, focus.cellIndex)];
}

/**
 * What a rendering leaves out of the source: spacing, table pipes, emphasis, list and quote
 * marks — and double quotes, which a reference's text has curled (curlyQuotes).
 */
export const MARKUP = /[\s|*_`~=>\\"“”-]/;

/** `text` with its straight double quotes curled: a reference ends its quoted text at a straight one. */
function curlyQuotes(text: string): string {
	return text.replace(/"([^"]*)"/g, "“$1”").replace(/"/g, "”");
}

/** Text with what a rendering leaves out of the source (MARKUP, `<br>`) left out. */
export function flatten(text: string): string {
	let flat = "";
	for (const ch of text.replace(/<br\s*\/?>/gi, "")) if (!MARKUP.test(ch)) flat += ch;
	return flat;
}

/**
 * Where text selected as rendered (a table, a callout, reading view) sits in `source`: found
 * with what the rendering leaves out flattened out of both. Null when it isn't there.
 */
export function locateText(source: string, text: string): { from: number; to: number } | null {
	let flat = "";
	const at: number[] = [];
	for (let i = 0; i < source.length; ) {
		const br = /^<br\s*\/?>/i.exec(source.slice(i, i + 6));
		if (br) {
			i += br[0].length;
			continue;
		}
		if (!MARKUP.test(source.charAt(i))) {
			flat += source.charAt(i);
			at.push(i);
		}
		i++;
	}
	const wanted = flatten(text);
	const found = wanted ? flat.indexOf(wanted) : -1;
	if (found < 0) return null;
	return { from: at[found] ?? 0, to: (at[found + wanted.length - 1] ?? 0) + 1 };
}

/**
 * A Markdown table row's cells, trimmed. A `|` splits cells unless it's escaped — as it is
 * in a link's alias inside a table — and the pipes at either end bound the row rather than
 * add an empty cell.
 */
export function tableRowCells(row: string): string[] {
	const cells: string[] = [];
	let cell = "";
	for (let i = 0; i < row.length; i++) {
		const ch = row.charAt(i);
		if (ch === "\\" && i + 1 < row.length) {
			cell += ch + row.charAt(++i);
		} else if (ch === "|") {
			cells.push(cell);
			cell = "";
		} else {
			cell += ch;
		}
	}
	cells.push(cell);
	if (cells.length > 1 && cells[0]?.trim() === "") cells.shift();
	if (cells.length > 1 && cells[cells.length - 1]?.trim() === "") cells.pop();
	return cells.map((c) => c.trim());
}

/** A reference as REFERENCE matched it. */
export function readReference(match: RegExpMatchArray): NoteReference {
	const [, path = "", start, end, columns, quote] = match;
	const names = Array.from(columns?.matchAll(/"([^"]*)"/g) ?? [], (name) => name[1] ?? "");
	const reference: NoteReference = { path, start: Number(start ?? 0), end: Number(end ?? start ?? 0) };
	if (names.length) reference.columns = names;
	if (quote) reference.quote = quote;
	return reference;
}

/** "L12", "L12–14"; nothing for no lines (the whole file). */
export function linesLabel(start: number, end: number): string {
	return !start ? "" : start === end ? `L${start}` : `L${start}–${end}`;
}

/** A reference as a prompt shows it: its lines and what's selected in them — `L729 · 时间片显示 · 「局」`. */
export function referenceLabel(reference: NoteReference): string {
	const flat = reference.quote?.replace(/\s+/g, " ").trim() ?? "";
	const short = flat.length > 20 ? `${flat.slice(0, 18)}…` : flat;
	return [linesLabel(reference.start, reference.end), reference.columns?.join(" / "), short && `「${short}」`].filter(Boolean).join(" · ");
}

/**
 * A selection as Claudian carries and sends it — its lines and their text — as ⌥K would refer
 * to it (describe): table rows' columns, when the text is those rows with only those cells, as
 * a selection of cells goes (main.ts, tableCellSelection); else the text, when it's less than
 * the line, and the columns of the row it's in.
 */
export function selectionReference(lines: NoteLines, lineText: (n: number) => string, text: string): NoteReference {
	const picked = pickedColumns(lines, lineText, text);
	if (picked) return describe(lines, lineText, null, picked);
	return describe(lines, lineText, text, lines.start === lines.end ? columnsIn(lineText(lines.start), text) : null);
}

/**
 * The columns `text` is of table rows `lines`: each of its lines that row with only those
 * cells. Null for any other text, and for all of the columns (whole rows need none named).
 * Told by the rows that still read as they did: one edited since — a prompt's selection is
 * read against the note as it is now — says nothing, as a row of dashes or blanks doesn't.
 */
function pickedColumns(lines: NoteLines, lineText: (n: number) => string, text: string): [number, number] | null {
	const rows = text.split("\n");
	if (rows.length !== lines.end - lines.start + 1) return null;
	const width = tableRowCells(rows[0] ?? "").length;
	let at: number[] | null = null;
	for (let i = 0; i < rows.length; i++) {
		const source = lineText(lines.start + i);
		const row = rows[i] ?? "";
		if (!/^\s*\|/.test(source) || !/^\s*\|/.test(row)) return null;
		const all = tableRowCells(source).map(flatten);
		const some = tableRowCells(row).map(flatten);
		if (some.length !== width || some.length >= all.length) return null;
		if (some.every((cell) => cell === "")) continue;
		// Where they sit among the row's cells: the places the rows that tell have them at.
		const here: number[] = [];
		for (let o = 0; o + some.length <= all.length; o++) {
			if (some.every((cell, k) => cell === all[o + k])) here.push(o);
		}
		const both: number[] = at ? at.filter((o) => here.includes(o)) : here;
		if (both.length > 0) at = both;
	}
	const first = at?.[0];
	return first === undefined ? null : [first, first + width - 1];
}

/** The columns of table row `row` that `text`, taken from it, runs across; null when it isn't a row or doesn't hold it. */
function columnsIn(row: string, text: string): [number, number] | null {
	if (!/^\s*\|/.test(row)) return null;
	const wanted = flatten(text);
	if (!wanted) return null;
	const cells = tableRowCells(row).map(flatten);
	// One cell holding it all, first: the same text can also run across from the cell before.
	const one = cells.findIndex((cell) => cell.includes(wanted));
	if (one >= 0) return [one, one];
	const ends: number[] = [];
	let joined = "";
	for (const cell of cells) {
		joined += cell;
		ends.push(joined.length);
	}
	const from = joined.indexOf(wanted);
	if (from < 0) return null;
	const cellAt = (offset: number): number => ends.findIndex((end) => offset < end);
	return [cellAt(from), cellAt(from + wanted.length - 1)];
}
