/**
 * Enter in a fenced code block indents as a code editor does.
 *
 * Obsidian's markdown has no indentation of its own for a code block's lines: Enter starts
 * the next line at the margin, and between the braces auto-pair closed (`{|}`) it leaves the
 * `}` against the cursor. Here, on a code line:
 * - the new line keeps this one's indent;
 * - after an opening bracket, it's one level deeper — and between a pair, the closer goes
 *   on a line of its own under the opener's indent, the cursor on the line between;
 * - after a `:` ending a line of Python (or YAML), one level deeper too.
 * A level is what the block's own lines use — a tab, or the fewest spaces any line starts
 * with — as a code editor detects it; the editor's setting only for a block with no indent yet.
 */

import { type Extension, Prec } from "@codemirror/state";
import { type EditorView, keymap } from "@codemirror/view";

/** A fence line: its quote/indent prefix, its marks and its info string. */
const FENCE = /^([ \t]*(?:>[ \t]*)*)(`{3,}|~{3,})(.*)$/;
const PAIRS: Record<string, string> = { "{": "}", "[": "]", "(": ")" };
/** Languages where a line ending in `:` opens a block. */
const COLON_BLOCKS = new Set(["python", "py", "python3", "yaml", "yml"]);

export interface CodeIndentOptions {
	/** Whether Enter is taken here now: the setting on, and no suggestion list open to take it. */
	enabled: () => boolean;
	/** One level of indent: a tab, or the editor's tab size in spaces. */
	indentUnit: () => string;
}

export function codeIndentExtension(opts: CodeIndentOptions): Extension {
	return Prec.highest(keymap.of([{ key: "Enter", run: (view) => enter(view, opts) }]));
}

function enter(view: EditorView, opts: CodeIndentOptions): boolean {
	if (!opts.enabled()) return false;
	const { state } = view;
	const sel = state.selection;
	if (sel.ranges.length !== 1 || !sel.main.empty) return false;
	const pos = sel.main.head;
	const line = state.doc.lineAt(pos);
	const block = codeBlockAt(view, line.number);
	if (!block) return false;

	// A block in a quote or callout: its `> ` stays at the start of every line.
	const lead = line.text.slice(0, block.prefix.length) === block.prefix ? block.prefix : "";
	const indent = /^[ \t]*/.exec(line.text.slice(lead.length))?.[0] ?? "";
	const before = line.text.slice(0, pos - line.from).trimEnd();
	const after = line.text.slice(pos - line.from);
	const base = lead + indent;
	const opener = before.slice(-1);
	const unit = blockIndentUnit(view, block.from, lead) ?? opts.indentUnit();

	let insert = "\n" + base;
	let cursor = insert.length;
	if (PAIRS[opener] !== undefined) {
		insert += unit;
		cursor = insert.length;
		// `{|}`: the closer on a line of its own, back at the opener's indent.
		if (after.trimStart().startsWith(PAIRS[opener])) insert += "\n" + base;
	} else if (opener === ":" && COLON_BLOCKS.has(block.lang)) {
		insert += unit;
		cursor = insert.length;
	}
	// Spaces left before the cursor (as after `{ |}`) go, as a code editor drops them.
	const from = line.from + before.length;
	const to = pos + (after.length - after.trimStart().length);
	view.dispatch({
		changes: { from, to, insert },
		selection: { anchor: from + cursor },
		scrollIntoView: true,
		userEvent: "input",
	});
	return true;
}

/**
 * The fenced code block whose content line `lineNo` is, read from the text — the same
 * CommonMark rules as everywhere in this plugin: closed by a fence of the same mark, at
 * least as long, with nothing after it. Null on a fence line or outside a block.
 */
function codeBlockAt(view: EditorView, lineNo: number): { prefix: string; lang: string; from: number } | null {
	const { doc } = view.state;
	let open: { prefix: string; mark: string; lang: string; from: number } | null = null;
	for (let n = 1; n <= lineNo; n++) {
		const fence = FENCE.exec(doc.line(n).text);
		if (!open) {
			if (fence && !(fence[2].startsWith("`") && fence[3].includes("`"))) {
				open = { prefix: fence[1], mark: fence[2], lang: fence[3].trim().split(/\s/)[0].toLowerCase(), from: n };
				if (n === lineNo) return null;
			}
			continue;
		}
		if (fence && fence[2][0] === open.mark[0] && fence[2].length >= open.mark.length && !fence[3].trim()) {
			open = null;
			if (n === lineNo) return null;
		}
	}
	return open ? { prefix: open.prefix, lang: open.lang, from: open.from } : null;
}

/** How many of a block's lines are read for its indent. */
const DETECT_LINES = 400;

/** The indent unit a block's lines use, from its fence on line `from`; null if none is indented. */
function blockIndentUnit(view: EditorView, from: number, lead: string): string | null {
	const { doc } = view.state;
	let spaces = 0;
	for (let n = from + 1; n <= Math.min(doc.lines, from + DETECT_LINES); n++) {
		const text = doc.line(n).text;
		const body = text.startsWith(lead) ? text.slice(lead.length) : text;
		if (FENCE.test(text) && !body.trim().replace(/^(`{3,}|~{3,})$/, "")) break;
		if (body.startsWith("\t")) return "\t";
		const count = /^ */.exec(body)?.[0].length ?? 0;
		// A single space is alignment more often than a level.
		if (count >= 2 && body.trim() && (spaces === 0 || count < spaces)) spaces = count;
	}
	return spaces > 0 ? " ".repeat(spaces) : null;
}
