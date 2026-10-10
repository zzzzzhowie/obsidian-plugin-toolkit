import type { App, Editor } from "obsidian";

/** Where the drawing a fence creates opens: Excalidraw's own create-and-embed commands. */
export type FenceOpenIn = "adjacent" | "tab" | "popout";

const CREATE_AND_EMBED: Record<FenceOpenIn, string> = {
	adjacent: "obsidian-excalidraw-plugin:excalidraw-autocreate-and-embed",
	tab: "obsidian-excalidraw-plugin:excalidraw-autocreate-and-embed-new-tab",
	popout: "obsidian-excalidraw-plugin:excalidraw-autocreate-and-embed-popout",
};

/** An opening fence naming excalidraw: its quote/indent prefix and its marks. */
const EXCALIDRAW_FENCE = /^([ \t]*(?:>[ \t]*)*)(`{3,}|~{3,})excalidraw[ \t]*$/i;
/** Any fence line: its marks and info string. */
const FENCE = /^[ \t]*(?:>[ \t]*)*(`{3,}|~{3,})[ \t]*([^\s`]*)/;

interface AppWithCommands {
	commands: { executeCommandById(id: string): boolean };
}

/**
 * Typing ```excalidraw makes a drawing: the empty block is replaced by a new drawing embedded
 * where it stood, opened to draw in. Excalidraw keeps a drawing in a file of its own, so a
 * code block can't hold one; its "Create new drawing … and embed into active document" does
 * the rest — named, foldered and embedded the way its settings say.
 *
 * Only an empty block being opened: the fence just written (the cursor at its end, or on the
 * blank line Obsidian's auto-pair or a completion left inside), with nothing in the block yet
 * and not inside another code block. A block that already has content is left alone.
 */
export function createDrawingFromFence(app: App, editor: Editor, openIn: FenceOpenIn): boolean {
	const cursor = editor.getCursor();
	if (cursor.line !== editor.getCursor("anchor").line) return false;
	const opening = openingLine(editor, cursor.line, cursor.ch);
	if (opening === null || insideCodeBlock(editor, opening.line)) return false;
	const end = emptyBlockEnd(editor, opening.line, opening.marks);
	if (end === null) return false;

	// The block goes, leaving the line it opened on, where the embed lands.
	const lastLine = editor.getLine(end);
	editor.transaction({
		changes: [{ from: { line: opening.line, ch: 0 }, to: { line: end, ch: lastLine.length }, text: opening.prefix }],
		selection: { from: { line: opening.line, ch: opening.prefix.length } },
	});
	return (app as unknown as AppWithCommands).commands.executeCommandById(CREATE_AND_EMBED[openIn]);
}

/** The ```excalidraw line the cursor just finished or sits right below, with its prefix and marks. */
function openingLine(editor: Editor, line: number, ch: number): { line: number; prefix: string; marks: string } | null {
	const here = EXCALIDRAW_FENCE.exec(editor.getLine(line));
	if (here && ch === editor.getLine(line).length) return { line, prefix: here[1] ?? "", marks: here[2] ?? "" };
	if (line === 0 || editor.getLine(line).trim() !== "") return null;
	const above = EXCALIDRAW_FENCE.exec(editor.getLine(line - 1));
	return above ? { line: line - 1, prefix: above[1] ?? "", marks: above[2] ?? "" } : null;
}

/**
 * The last line of the empty block opened on `line`: its closing fence when only blank lines
 * come before it, or the opening line itself when the block isn't closed at all. Null when the
 * block has something in it — text before a fence that closes it.
 */
function emptyBlockEnd(editor: Editor, line: number, marks: string): number | null {
	const closes = (text: string): boolean => {
		const fence = FENCE.exec(text);
		return !!fence && !fence[2] && fence[1]?.[0] === marks[0] && (fence[1]?.length ?? 0) >= marks.length;
	};
	let content = false;
	for (let n = line + 1; n < editor.lineCount(); n++) {
		const text = editor.getLine(n);
		if (closes(text)) return content ? null : n;
		// Another fence opening first: this block was never closed.
		if (FENCE.test(text)) return line;
		if (text.trim() !== "" && !/^[ \t]*(?:>[ \t]*)+$/.test(text)) content = true;
	}
	return line;
}

/** Whether line `lineNo` sits inside a code block opened above it. */
function insideCodeBlock(editor: Editor, lineNo: number): boolean {
	let open: string | null = null;
	for (let n = 0; n < lineNo; n++) {
		const fence = FENCE.exec(editor.getLine(n));
		if (!fence) continue;
		const marks = fence[1] ?? "";
		if (open === null) open = marks;
		else if (!fence[2] && marks[0] === open[0] && marks.length >= open.length) open = null;
	}
	return open !== null;
}
