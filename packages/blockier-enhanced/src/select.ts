/**
 * Cmd/Ctrl-A behaviour.
 *
 * - Cursor inside a fenced code block -> select only that code block's contents.
 * - Contents already fully selected    -> select the whole document (escape hatch,
 *                                          so you're never trapped inside a block).
 * - Anywhere else                       -> select the whole document.
 */

import { Editor, EditorPosition } from "obsidian";

/**
 * Matches a fenced code-block delimiter line: three or more backticks or tildes,
 * with optional leading indentation and an optional trailing info string.
 * Group 1 is the fence marker, group 2 is the info string (empty for a close fence).
 */
const FENCE = /^\s*(`{3,}|~{3,})(.*)$/;

type CodeBlock = { openLine: number; closeLine: number };
type Selection = { anchor: EditorPosition; head: EditorPosition };

/**
 * Entry point for both the "Select block" command and the Cmd/Ctrl-A keybinding.
 */
export function runSelectBlock(editor: Editor | undefined): void {
	if (!editor) return;

	const block = enclosingCodeBlock(editor);
	const contents = block && codeBlockContents(editor, block);

	if (contents && !isSelectionEqual(editor, contents)) {
		editor.setSelection(contents.anchor, contents.head);
	} else {
		selectAll(editor);
	}
}

/** Selects the entire document. */
function selectAll(editor: Editor): void {
	const lastLine = editor.lastLine();
	editor.setSelection(
		{ line: 0, ch: 0 },
		{ line: lastLine, ch: editor.getLine(lastLine).length }
	);
}

/**
 * Determines whether the cursor sits inside a fenced code block.
 *
 * Scans the whole document tracking fences with CommonMark semantics: a block
 * opens on a fence line and closes on a later fence line of the same type (` ``` `
 * vs `~~~`), at least as long, with no info string. A fence-looking line *with* an
 * info string while a block is open is treated as content, so ` ```lang ` inside a
 * block doesn't accidentally close it.
 *
 * The cursor is considered inside only when it's on a content line, not on a fence
 * line itself. Scanning the text (rather than reading DOM/CM state) keeps this
 * deterministic and immune to editor virtualisation — off-screen lines still count.
 */
function enclosingCodeBlock(editor: Editor): CodeBlock | undefined {
	const cursorLine = editor.getCursor().line;
	const lastLine = editor.lastLine();

	let open: { line: number; marker: string } | null = null;
	for (let line = 0; line <= lastLine; line++) {
		const match = editor.getLine(line).match(FENCE);
		if (!match) continue;

		const marker = match[1];
		const info = match[2].trim();

		if (!open) {
			open = { line, marker };
		} else if (
			marker[0] === open.marker[0] &&
			marker.length >= open.marker.length &&
			info === ""
		) {
			// valid closing fence
			if (cursorLine > open.line && cursorLine < line) {
				return { openLine: open.line, closeLine: line };
			}
			open = null;
		}
		// otherwise: a fence-looking line inside an open block, treated as content.
	}

	// an unclosed block runs to the end of the document
	if (open && cursorLine > open.line) {
		return { openLine: open.line, closeLine: lastLine + 1 };
	}
	return undefined;
}

/**
 * The inner-content selection of a code block (fence lines excluded), or undefined
 * if the block has no content lines.
 */
function codeBlockContents(editor: Editor, block: CodeBlock): Selection | undefined {
	const firstLine = block.openLine + 1;
	const lastLine = Math.min(block.closeLine - 1, editor.lastLine());
	if (firstLine > lastLine) return undefined; // empty block

	return {
		anchor: { line: firstLine, ch: 0 },
		head: { line: lastLine, ch: editor.getLine(lastLine).length },
	};
}

/** Whether the editor's single selection already matches `sel` (order-independent). */
function isSelectionEqual(editor: Editor, sel: Selection): boolean {
	const current = editor.listSelections();
	if (current.length !== 1) return false;

	const only = current[0];
	const same = (a: EditorPosition, b: EditorPosition) => a.line === b.line && a.ch === b.ch;
	return (
		(same(only.anchor, sel.anchor) && same(only.head, sel.head)) ||
		(same(only.anchor, sel.head) && same(only.head, sel.anchor))
	);
}
