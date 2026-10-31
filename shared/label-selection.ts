import { MarkdownView, type Plugin } from "obsidian";

/*
 * Selecting a drawing's text by dragging, line by line: a Mermaid diagram's labels (Mermaid
 * (Enhanced)), an Excalidraw drawing's text (Excalidraw (Enhanced)) — SVG <text>, in a note and
 * in the zoom.
 *
 * Chromium places the end of a drag in SVG text by where the pointer is across, not by the line
 * it's on: dragging down a label put the end on some other line, the selection jumping about
 * under the pointer; and over the blank of a box — no text under the pointer — its drag
 * collapsed the selection, which came back over a letter. A drag that starts in a label is this
 * one's instead: the browser's own is cancelled at the press, and the selection runs from where
 * it was pressed to the character nearest the pointer — on the line under it; above the first
 * line, to the label's start; past the last, to its end. Double and triple clicks are still the
 * browser's.
 */

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

export interface LabelSelectionOptions {
	/**
	 * The label a press on `target` starts selecting in — its lines are the <tspan y> or <text>
	 * in it (a Mermaid label is one <text>, an Excalidraw text a <g> of them) — or null when the
	 * press isn't on one.
	 */
	label: (target: Element) => Element | null;
}

export class LabelSelection {
	private drag: { off: () => void } | null = null;

	constructor(private readonly options: LabelSelectionOptions) {}

	register(plugin: Plugin): void {
		plugin.registerDomEvent(document, "mousedown", (event) => this.start(plugin, event), { capture: true });
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

	private start(plugin: Plugin, event: MouseEvent): void {
		if (event.button !== 0 || event.detail > 1 || event.shiftKey || event.metaKey || event.ctrlKey || event.altKey) return;
		const target = event.target instanceof Element ? event.target : null;
		const label = target ? this.options.label(target) : null;
		if (!label) return;
		const lines = linesOf(label);
		const anchor = caretAt(lines, event.clientX, event.clientY);
		const selection = label.ownerDocument.getSelection();
		if (!anchor || !selection) return;
		this.drag?.off();
		// No drag of the browser's own at all: cancelling its start (selectstart) still left it
		// running, collapsing the selection every few milliseconds while the pointer was over the
		// blank of a box. Without the press, though, the editor isn't focused by it: that's done
		// here, once the plugins' other press handlers have moved the cursor out of the drawing.
		event.preventDefault();
		const editor = editorOf(plugin, label);
		const win = label.ownerDocument.defaultView ?? window;
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
			label.ownerDocument.removeEventListener("selectionchange", keep);
			this.drag = null;
		};
		label.ownerDocument.addEventListener("selectionchange", keep);
		win.setTimeout(() => {
			if (editor && !editor.hasFocus()) editor.focus();
			put();
		});
		put();
		win.addEventListener("mousemove", move, true);
		win.addEventListener("mouseup", off, true);
		win.addEventListener("blur", off);
		this.drag = { off };
	}
}

/** The editor of the note `el` is drawn in, in Live Preview; null in the zoom, or reading view. */
function editorOf(plugin: Plugin, el: Element): MarkdownView["editor"] | null {
	if (!el.closest(".markdown-source-view")) return null;
	for (const leaf of plugin.app.workspace.getLeavesOfType("markdown")) {
		const view = leaf.view;
		if (view instanceof MarkdownView && view.contentEl.contains(el)) return view.editor;
	}
	return null;
}

/** The lines of a label, each character measured once for the whole drag. */
function linesOf(label: Element): Line[] {
	const doc = label.ownerDocument;
	const range = doc.createRange();
	const lines: Line[] = [];
	const walker = doc.createTreeWalker(label, NodeFilter.SHOW_TEXT);
	for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
		const owner = node.parentElement?.closest("tspan[y]") ?? node.parentElement?.closest("text") ?? label;
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
