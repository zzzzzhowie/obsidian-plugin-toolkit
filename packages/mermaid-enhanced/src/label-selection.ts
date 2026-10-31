import { EditorView } from "@codemirror/view";
import type { Plugin } from "obsidian";

/** A spot between two characters of a label. */
interface Caret {
	node: Text;
	offset: number;
}

/** A line of a label as drawn: its characters left to right, on screen. */
interface Line {
	owner: Element;
	top: number;
	bottom: number;
	chars: { node: Text; offset: number; end: number; left: number; right: number }[];
}

/**
 * Selecting a label's text by dragging, line by line.
 *
 * Obsidian 1.15 draws a diagram's labels as SVG <text>, a <tspan> to a line, and Chromium
 * places the end of a drag in such text by where the pointer is across, not by the line it's
 * on: dragging down a box's label put the end on some other line, the selection jumping about
 * under the pointer. A drag that starts in a label is this plugin's instead: the browser's own
 * is cancelled at the press, and the selection runs from where it was pressed to the
 * character nearest the pointer — on the line under it; above the first line, to the label's
 * start; past the last, to its end. Double and triple clicks are still the browser's.
 */
export class LabelSelection {
	private drag: { anchor: Caret; lines: Line[]; off: () => void } | null = null;

	register(plugin: Plugin): void {
		plugin.registerDomEvent(document, "mousedown", (event) => this.start(event), { capture: true });
		plugin.registerDomEvent(
			document,
			"selectstart",
			(event) => {
				if (this.drag) event.preventDefault();
			},
			{ capture: true },
		);
		plugin.register(() => this.drag?.off());
	}

	private start(event: MouseEvent): void {
		if (event.button !== 0 || event.detail > 1 || event.shiftKey || event.metaKey || event.ctrlKey || event.altKey) return;
		const target = event.target instanceof Element ? event.target : null;
		const text = target?.closest("svg.pele text");
		if (!text) return;
		const lines = linesOf(text);
		const anchor = caretAt(lines, event.clientX, event.clientY);
		const selection = text.ownerDocument.getSelection();
		if (!anchor || !selection) return;
		this.drag?.off();
		// No drag of the browser's own at all: cancelling its start (selectstart) still left it
		// running, collapsing the selection every few milliseconds while the pointer was over the
		// blank of a box. Without the press, though, the editor isn't focused by it: that's done
		// here, once the plugin's other press handlers have moved the cursor out of the diagram.
		event.preventDefault();
		const editorEl = text.closest<HTMLElement>(".cm-editor");
		const editor = editorEl ? EditorView.findFromDOM(editorEl) : null;
		const win = text.ownerDocument.defaultView ?? window;
		let focus: Caret = anchor;
		const put = (): void => {
			if (selection.anchorNode === anchor.node && selection.anchorOffset === anchor.offset && selection.focusNode === focus.node && selection.focusOffset === focus.offset) return;
			selection.setBaseAndExtent(anchor.node, anchor.offset, focus.node, focus.offset);
		};
		const move = (e: MouseEvent): void => {
			// The browser's own drag goes on under this one: over the blank of a box — no text
			// under the pointer — it collapsed the selection, which came back over a letter.
			e.preventDefault();
			focus = caretAt(lines, e.clientX, e.clientY) ?? focus;
			put();
		};
		// Whatever else moves it while the button is down, it's put back.
		const keep = (): void => put();
		const off = (): void => {
			win.removeEventListener("mousemove", move, true);
			win.removeEventListener("mouseup", off, true);
			win.removeEventListener("blur", off);
			text.ownerDocument.removeEventListener("selectionchange", keep);
			this.drag = null;
		};
		text.ownerDocument.addEventListener("selectionchange", keep);
		win.setTimeout(() => {
			if (editor && !editor.hasFocus) editor.focus();
			put();
		});
		put();
		win.addEventListener("mousemove", move, true);
		win.addEventListener("mouseup", off, true);
		win.addEventListener("blur", off);
		this.drag = { anchor, lines, off };
	}
}

/** The lines of a label, each character measured once for the whole drag. */
function linesOf(text: Element): Line[] {
	const doc = text.ownerDocument;
	const range = doc.createRange();
	const lines: Line[] = [];
	const walker = doc.createTreeWalker(text, NodeFilter.SHOW_TEXT);
	for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
		const owner = node.parentElement?.closest("tspan[y]") ?? text;
		let line = lines[lines.length - 1];
		if (!line || line.owner !== owner) {
			line = { owner, top: Infinity, bottom: -Infinity, chars: [] };
			lines.push(line);
		}
		for (let i = 0; i < node.length; ) {
			// A character past the BMP is two code units and one glyph.
			const end = /[\uD800-\uDBFF]/.test(node.data.charAt(i)) ? i + 2 : i + 1;
			range.setStart(node, i);
			range.setEnd(node, Math.min(end, node.length));
			const rect = range.getBoundingClientRect();
			if (rect.width > 0 || rect.height > 0) {
				line.chars.push({ node, offset: i, end, left: rect.left, right: rect.right });
				line.top = Math.min(line.top, rect.top);
				line.bottom = Math.max(line.bottom, rect.bottom);
			}
			i = end;
		}
	}
	return lines.filter((line) => line.chars.length > 0);
}

/** The spot in `lines` nearest the point. */
function caretAt(lines: Line[], x: number, y: number): Caret | null {
	const first = lines[0];
	const last = lines[lines.length - 1];
	if (!first || !last) return null;
	const start = first.chars[0];
	const end = last.chars[last.chars.length - 1];
	if (start && y < first.top) return { node: start.node, offset: start.offset };
	if (end && y > last.bottom) return { node: end.node, offset: end.end };
	const gap = (line: Line): number => (y < line.top ? line.top - y : y > line.bottom ? y - line.bottom : 0);
	const line = lines.reduce((best, one) => (gap(one) < gap(best) ? one : best));
	for (const char of line.chars) if (x < (char.left + char.right) / 2) return { node: char.node, offset: char.offset };
	const tail = line.chars[line.chars.length - 1];
	return tail ? { node: tail.node, offset: tail.end } : null;
}
