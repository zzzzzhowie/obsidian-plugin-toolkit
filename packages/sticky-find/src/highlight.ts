/**
 * Painting matches without touching the document.
 *
 * The whole point of this plugin is to never move the editor selection, because Live
 * Preview un-renders any block whose range the selection lands in. That rules out the
 * two obvious approaches:
 *
 *  - CodeMirror `Decoration.mark` cannot paint inside a `Decoration.replace` widget
 *    (a rendered table is one), so mark decorations are invisible exactly where we
 *    need them.
 *  - Wrapping matches in `<span>`s would mutate DOM that Obsidian's renderer owns.
 *
 * So we work on the rendered DOM with the CSS Custom Highlight API: `Range` objects
 * handed to `CSS.highlights`, styled via `::highlight()`. No DOM mutation, no
 * selection, and it reaches inside widget-rendered content.
 */

export const MATCH_HIGHLIGHT = "sticky-find-match";
export const CURRENT_HIGHLIGHT = "sticky-find-current";

interface TextPiece {
	node: Text;
	start: number;
	end: number;
}

export interface DomText {
	text: string;
	pieces: TextPiece[];
}

type HighlightCtor = new (...ranges: Range[]) => object;

interface HighlightRegistryLike {
	set(name: string, highlight: object): void;
	delete(name: string): void;
}

function highlightCtor(): HighlightCtor | undefined {
	return (window as unknown as { Highlight?: HighlightCtor }).Highlight;
}

function registry(): HighlightRegistryLike | undefined {
	return (CSS as unknown as { highlights?: HighlightRegistryLike }).highlights;
}

export function highlightApiAvailable(): boolean {
	return Boolean(highlightCtor() && registry());
}

/**
 * Flatten every rendered text node under `root` into one string, remembering where
 * each node landed so offsets can be turned back into `Range`s.
 *
 * A newline is inserted whenever consecutive text nodes have different parents. Without
 * it, adjacent table cells concatenate ("Traffic" + "Layer") and produce matches that
 * span a cell boundary — text the user never sees as one run.
 */
export function collectDomText(root: HTMLElement): DomText {
	const pieces: TextPiece[] = [];
	const parts: string[] = [];
	let length = 0;
	let lastParent: HTMLElement | null = null;

	const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT);
	for (let node = walker.nextNode(); node; node = walker.nextNode()) {
		const text = node as Text;
		if (text.data.length === 0) continue;

		const parent = text.parentElement;
		if (lastParent !== null && parent !== lastParent) {
			parts.push("\n");
			length += 1;
		}
		lastParent = parent;

		pieces.push({ node: text, start: length, end: length + text.data.length });
		parts.push(text.data);
		length += text.data.length;
	}

	return { text: parts.join(""), pieces };
}

/** Turn a `[from, to)` span of the flattened text back into a live DOM Range. */
export function rangeFor(dom: DomText, from: number, to: number): Range | null {
	let start: TextPiece | undefined;
	let end: TextPiece | undefined;

	for (const piece of dom.pieces) {
		if (!start && from >= piece.start && from < piece.end) start = piece;
		if (start && to > piece.start && to <= piece.end) {
			end = piece;
			break;
		}
	}
	if (!start || !end) return null;

	const range = start.node.ownerDocument.createRange();
	range.setStart(start.node, from - start.start);
	range.setEnd(end.node, to - end.start);
	return range;
}

export function paint(name: string, ranges: Range[]): void {
	const Ctor = highlightCtor();
	const reg = registry();
	if (!Ctor || !reg) return;

	if (ranges.length === 0) {
		reg.delete(name);
		return;
	}
	reg.set(name, new Ctor(...ranges));
}

export function clearAll(): void {
	const reg = registry();
	if (!reg) return;
	reg.delete(MATCH_HIGHLIGHT);
	reg.delete(CURRENT_HIGHLIGHT);
}
