import { type EditorSelection, type EditorState, type Extension, Prec, StateEffect, StateField } from '@codemirror/state';
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate, WidgetType } from '@codemirror/view';
import { editorInfoField, editorLivePreviewField, Platform, setIcon, setTooltip } from 'obsidian';
import { captionApp } from './caption-content';
import { hasNestedBrackets, readImage, sizeOf, type ImageSource } from './source';

/** Class on the image this plugin draws in place of Obsidian's, and on a line it's being edited in. */
const IMAGE_CLS = 'caption-nested-image';
const EDITING_CLS = 'caption-nested-editing';
const EDITING_VIEW_CLS = 'caption-nested-editing-view';
const NO_ATTRS: Record<string, string> = {};

/** An image's markdown opened for editing by its Edit button; see revealed. */
const reveal = StateEffect.define<{ from: number; to: number }>();
/** How long after it opens a reveal outlasts the selection moves the press itself brings. */
const REVEAL_SETTLE_MS = 400;

interface Revealed {
	from: number;
	to: number;
	since: number;
}

/**
 * The markdown of an image being edited, shown as written until the selection leaves it —
 * as Obsidian shows an image's markdown only once its Edit button is pressed, never for a
 * cursor merely passing through.
 */
const revealed = StateField.define<Revealed | null>({
	create: () => null,
	update(range, tr) {
		for (const effect of tr.effects) if (effect.is(reveal)) return { ...effect.value, since: Date.now() };
		if (!range) return null;
		const next = { from: tr.changes.mapPos(range.from, -1), to: tr.changes.mapPos(range.to, 1), since: range.since };
		// The press on Edit also puts the cursor at the image's start, and Obsidian's own Edit
		// moves it again; those aren't the cursor leaving.
		if (Date.now() - range.since < REVEAL_SETTLE_MS) return next;
		// Strictly inside: a cursor at either end — after the closing `)` most often, the end of
		// a line, where it rests in a note of one line — has left it.
		const inside = tr.state.selection.ranges.some((sel) => sel.from < next.to && sel.to > next.from);
		return inside ? next : null;
	},
});

/**
 * A markdown image with a link in its alt, drawn right in Live Preview.
 *
 * `![see [V](https://…)](img)` is CommonMark — an image whose alt holds a link — and reading
 * view parses it so. Live Preview doesn't: it takes the inner link for the image, shows
 * https://… as a broken picture and leaves `](img)` as text. Its caption's dialog writes such a
 * link in the title instead (see withCaption), where Obsidian draws and handles the image as
 * its own; one written so by hand is replaced here, whole, by the image it names, with
 * Obsidian's look (`.image-embed`, its action group), until its caption is next edited. The
 * caption under it is drawn as for any image. Its Edit button shows the markdown as written
 * (see revealed), as does the cursor inside it.
 */
export const nestedImageExtension: Extension = [
	revealed,
	// While one is edited, Obsidian's preview of the image under the line — a tooltip, out of
	// the line — shows its misreading of it; this editor-wide class hides it (styles.css).
	EditorView.editorAttributes.compute(['doc', 'selection', revealed], (state) =>
		state.field(editorLivePreviewField, false) && nestedImages(state).some((image) => editing(state, image))
			? { class: EDITING_VIEW_CLS }
			: NO_ATTRS,
	),
	Prec.highest(
		ViewPlugin.fromClass(
			class {
				decorations: DecorationSet;
				/** The image last turned to markdown for being written in, so that's done once. */
				private shown: string | null = null;

				constructor(view: EditorView) {
					this.decorations = decorate(view.state);
					takeIntoLightbox(view.state);
				}

				update(update: ViewUpdate): void {
					// Written in — typed or pasted into (a link landing in an alt makes the image one
					// of these), or the cursor put inside by a find: Live Preview draws its misread
					// image over the markdown being written. Turned to markdown once per image.
					if (update.docChanged || update.selectionSet) {
						const view = update.view;
						requestAnimationFrame(() => {
							const image = nestedImages(view.state).find((candidate) => writing(view.state, candidate));
							const key = image ? `${image.from}:${image.to}` : null;
							if (image && (update.docChanged || key !== this.shown)) {
								showMarkdown(view, image, view.state.selection);
							}
							this.shown = key;
						});
					}
					const preview = (u: EditorState): boolean => !!u.field(editorLivePreviewField, false);
					if (
						update.docChanged ||
						update.selectionSet ||
						update.startState.field(revealed) !== update.state.field(revealed) ||
						preview(update.startState) !== preview(update.state)
					) {
						this.decorations = decorate(update.state);
					}
				}
			},
			{ decorations: (plugin) => plugin.decorations },
		),
	),
];

function decorate(state: EditorState): DecorationSet {
	if (!state.field(editorLivePreviewField, false)) return Decoration.none;
	const sourcePath = state.field(editorInfoField, false)?.file?.path ?? '';
	const ranges = [];
	for (const image of nestedImages(state)) {
		const widget = new NestedImageWidget(image, sourcePath);
		if (editing(state, image)) {
			// Being edited: the markdown as written, the image under it as Obsidian shows its own
			// while editing — this one, not the one Live Preview misreads it as (hidden, styles.css).
			ranges.push(Decoration.line({ class: EDITING_CLS }).range(state.doc.lineAt(image.from).from));
			ranges.push(Decoration.widget({ widget, side: 1 }).range(image.to));
			continue;
		}
		ranges.push(Decoration.replace({ widget }).range(image.from, image.to));
	}
	return Decoration.set(ranges, true);
}

/**
 * Whether an image's markdown is being written: the cursor in it, or a selection within it —
 * typed, or a link pasted into its caption, which is what makes it one of these. It's left as
 * written until the cursor leaves. A selection taking in the whole image, as select-all or a
 * few lines selected do, is the image selected, not edited: it stays drawn.
 */
function writing(state: EditorState, image: { from: number; to: number }): boolean {
	return state.selection.ranges.some((sel) => sel.from > image.from && sel.to < image.to);
}

/** Whether an image is shown as written: opened by its Edit button, or being written in. */
function editing(state: EditorState, image: { from: number; to: number }): boolean {
	const open = state.field(revealed, false);
	return (!!open && open.from <= image.to && open.to >= image.from) || writing(state, image);
}

/** Markdown images with brackets in their alt, outside code and frontmatter. */
function nestedImages(state: EditorState): ImageSource[] {
	const found: ImageSource[] = [];
	const { doc } = state;
	let fence: string | null = null;
	let frontmatter = doc.lines > 0 && doc.line(1).text === '---';
	for (let n = 1; n <= doc.lines; n++) {
		const line = doc.line(n);
		if (frontmatter) {
			if (n > 1 && /^(---|\.\.\.)\s*$/.test(line.text)) frontmatter = false;
			continue;
		}
		const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line.text)?.[1];
		if (fence) {
			if (marker && marker[0] === fence[0] && marker.length >= fence.length) fence = null;
			continue;
		}
		if (marker) {
			fence = marker;
			continue;
		}
		if (!line.text.includes('![')) continue;
		const code = Array.from(line.text.matchAll(/(`+)[^`]*?\1/g), (m) => [m.index, m.index + m[0].length]);
		let at = line.text.indexOf('![');
		while (at >= 0) {
			const image = line.text[at - 1] === '\\' || code.some(([from = 0, to = 0]) => at >= from && at < to)
				? null
				: readImage(line.text, at);
			if (image?.kind === 'markdown' && hasNestedBrackets(image.alt)) {
				found.push({ ...image, from: line.from + image.from, to: line.from + image.to });
			}
			at = line.text.indexOf('![', image ? image.to : at + 2);
		}
	}
	return found;
}

class NestedImageWidget extends WidgetType {
	private readonly src: string;

	constructor(
		private readonly image: ImageSource,
		sourcePath: string,
	) {
		super();
		this.src = resolveSrc(image.target, sourcePath);
	}

	eq(other: NestedImageWidget): boolean {
		return other.src === this.src && other.image.alt === this.image.alt;
	}

	toDOM(view: EditorView): HTMLElement {
		const doc = view.dom.ownerDocument;
		const embed = doc.createElement('div');
		embed.className = `image-embed ${IMAGE_CLS}`;
		embed.contentEditable = 'false';
		const wrapper = embed.appendChild(doc.createElement('div'));
		wrapper.className = 'image-wrapper';
		const img = wrapper.appendChild(doc.createElement('img'));
		img.src = this.src;
		// The caption is read from this, as from any image's (its size is stripped there).
		img.alt = this.image.alt;
		const [width, height] = (sizeOf(this.image.alt) ?? '').split('x');
		if (width) img.width = Number(width);
		if (height) img.height = Number(height);

		// Obsidian's action group, for the caption button, Zoom in and a way into the markdown.
		const actions = embed.appendChild(doc.createElement('div'));
		actions.className = 'embed-actions';
		// As Obsidian gives its own images Zoom in on desktop only; a phone opens one on a tap.
		if (!Platform.isMobile && imageKeeper(view.state)) {
			const zoom = actions.appendChild(doc.createElement('div'));
			zoom.className = 'embed-action';
			setIcon(zoom, 'lucide-zoom-in');
			setTooltip(zoom, 'Zoom in');
			zoom.addEventListener('mousedown', (evt) => evt.preventDefault());
			zoom.addEventListener('click', (evt) => {
				evt.preventDefault();
				evt.stopPropagation();
				let from: number;
				try {
					from = view.posAtDOM(embed);
				} catch {
					return;
				}
				takeIntoLightbox(view.state);
				imageKeeper(view.state)?.showImage(shownImage(from, this.src, this.image.alt, () => img));
			});
		}
		const edit = actions.appendChild(doc.createElement('div'));
		edit.className = 'embed-action edit-block-button';
		setIcon(edit, 'code-2');
		setTooltip(edit, 'Edit this block');
		edit.addEventListener('mousedown', (evt) => evt.preventDefault());
		edit.addEventListener('click', (evt) => {
			evt.preventDefault();
			evt.stopPropagation();
			const from = view.posAtDOM(embed);
			const image = readImage(view.state.sliceDoc(from, Math.min(view.state.doc.length, from + 4000)), 0);
			if (!image) return;
			const range = { from, to: from + image.to };
			// Select the caption, as Obsidian's own Edit does for an image's alt.
			view.dispatch({ effects: reveal.of(range), selection: { anchor: from + 2, head: from + 2 + image.alt.length } });
			view.focus();
			// Shown as written, the markdown is still Live Preview's to draw, which puts its own
			// misread image over the start of it; its Edit button turns that to markdown too.
			requestAnimationFrame(() => showMarkdown(view, range, view.state.selection));
		});
		return embed;
	}
}

/**
 * Obsidian's keeper of a Live Preview editor's images, a value of its editor state: its Zoom
 * in asks this to show an image in the lightbox, paging through every image in the note,
 * which it reads from its own drawing of them.
 */
interface ImageKeeper {
	view: EditorView;
	decorations: StateField<DecorationSet>;
	showImage(image: ShownImage): void;
}

/** An image as the lightbox takes it: Obsidian's own image widgets, or one of these. */
interface ShownImage {
	url: string;
	/** The alt as written, size and all; the lightbox reads its caption from it. */
	title: string;
	/** What the lightbox grows out of, and shrinks back into. */
	getImageEl(): HTMLImageElement | null;
}

/** Ours: where each stands in the note, so the one zoomed is found among the rest. */
const ours = new WeakMap<ShownImage, number>();

function shownImage(from: number, url: string, title: string, image: () => HTMLImageElement | null): ShownImage {
	const shown = { url, title, getImageEl: image };
	ours.set(shown, from);
	return shown;
}

function imageKeeper(state: EditorState): ImageKeeper | null {
	const values = (state as unknown as { values?: unknown[] }).values ?? [];
	for (const value of values) {
		const keeper = value as Partial<ImageKeeper> | null;
		if (typeof keeper?.showImage === 'function' && keeper.decorations && keeper.view) return keeper as ImageKeeper;
	}
	return null;
}

let restoreLightbox: (() => void) | null = null;

/**
 * Have the lightbox page through these images too, in their places among the note's others.
 * It reads Live Preview's drawing of the note's images, which has none of these — only its
 * misreading of each, the link in the caption as a broken picture — so they're swapped in for
 * those. Taken over on the keepers' shared prototype, the first time an editor turns up, so
 * paging from one of Obsidian's own images gets them right as well.
 */
function takeIntoLightbox(state: EditorState): void {
	if (restoreLightbox) return;
	const keeper = imageKeeper(state);
	if (!keeper) return;
	const proto = Object.getPrototypeOf(keeper) as ImageKeeper;
	// eslint-disable-next-line @typescript-eslint/unbound-method -- called with the keeper below
	const original = proto.showImage;
	const showImage = function (this: ImageKeeper, target: ShownImage): void {
		const { view } = this;
		const nested = nestedImages(view.state);
		if (!nested.length) {
			original.call(this, target);
			return;
		}
		type Drawn = { spec: { isImageEmbed?: boolean; widget?: ShownImage } };
		const drawn: { from: number; value: Drawn }[] = [];
		const iter = view.state.field(this.decorations).iter() as unknown as { value: Drawn | null; from: number; next(): void };
		for (; iter.value; iter.next()) {
			const at = iter.from;
			if (nested.some((image) => at >= image.from && at < image.to)) continue;
			drawn.push({ from: at, value: iter.value });
		}
		const sourcePath = view.state.field(editorInfoField, false)?.file?.path ?? '';
		for (const image of nested) {
			const widget = ours.get(target) === image.from
				? target
				: shownImage(image.from, resolveSrc(image.target, sourcePath), image.alt, () => imageElAt(view, image.from));
			drawn.push({ from: image.from, value: { spec: { isImageEmbed: true, widget } } });
		}
		drawn.sort((a, b) => a.from - b.from);
		let at = 0;
		const decorations = {
			iter: () => ({
				get value() {
					return drawn[at]?.value ?? null;
				},
				next() {
					at++;
				},
			}),
		};
		// What the original reads of the keeper: its editor's drawing of the images, and the
		// editor itself, to blur while the lightbox is up and focus once it's gone.
		original.call(
			{
				...this,
				view: { state: { field: () => decorations }, focus: () => view.focus(), contentDOM: view.contentDOM },
			} as unknown as ImageKeeper,
			target,
		);
	};
	proto.showImage = showImage;
	restoreLightbox = () => {
		if (proto.showImage === showImage) proto.showImage = original;
		restoreLightbox = null;
	};
}

/** Give the lightbox back to Obsidian as it was; for the plugin's unload. */
export function releaseLightbox(): void {
	restoreLightbox?.();
}

/** The <img> of one of these drawn at a place in the note, if it's on screen. */
function imageElAt(view: EditorView, from: number): HTMLImageElement | null {
	for (const embed of Array.from(view.contentDOM.querySelectorAll<HTMLElement>(`.${IMAGE_CLS}`))) {
		try {
			if (view.posAtDOM(embed) === from) return embed.querySelector('img');
		} catch {
			// Not in the note any more.
		}
	}
	return null;
}

/**
 * Have Live Preview show an image's markdown as written. Its own drawing of one of these takes
 * the inner link for the image and covers the start of the markdown; its Edit button, pressed,
 * turns that to markdown, and the selection is put back where it was.
 */
function showMarkdown(view: EditorView, range: { from: number; to: number }, selection: EditorSelection): void {
	for (const other of Array.from(view.contentDOM.querySelectorAll<HTMLElement>(`.image-embed:not(.${IMAGE_CLS})`))) {
		let at: number;
		try {
			at = view.posAtDOM(other);
		} catch {
			continue;
		}
		if (at < range.from || at > range.to) continue;
		const edit = other.querySelector<HTMLElement>('.edit-block-button');
		if (!edit) continue;
		edit.click();
		view.dispatch({ selection });
	}
}

/** An image's url as written, or a vault file's resource url for a path or link to one. */
function resolveSrc(target: string, sourcePath: string): string {
	const bare = target.replace(/^<(.*)>$/, '$1');
	if (/^[a-z][a-z0-9+.-]*:/i.test(bare)) return bare;
	const app = captionApp();
	if (!app) return bare;
	let path = bare;
	try {
		path = decodeURIComponent(bare);
	} catch {
		// As written.
	}
	const file = app.metadataCache.getFirstLinkpathDest(path, sourcePath);
	return file ? app.vault.getResourcePath(file) : bare;
}
