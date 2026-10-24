import type { EditorView } from '@codemirror/view';
import type { App } from 'obsidian';
import { CaptionModal, createCaptionButton } from '../../../shared/caption';
import { captionOf, readImage, withCaption, type ImageSource } from './source';

/** Class on the button that edits an image's caption. */
const BUTTON_CLS = 'image-caption-btn';
/** How far past an image's start its markdown is looked for; a url or caption is never this long. */
const READ_CHARS = 4000;

/**
 * The caption button in an image's action group (Obsidian's own Zoom in and Edit this
 * block), editing its caption in the dialog every figure's caption has (shared/caption.ts).
 * Live Preview only: the image's markdown is what's edited, in place.
 *
 * An Excalidraw drawing embedded as an image has no action group of its own; it's given one,
 * which Obsidian's rules for an image's (`.cm-content .image-embed .embed-actions`) place and
 * reveal as for any image.
 */
export function injectCaptionButton(app: App, view: EditorView, embed: HTMLElement): void {
	let actions = embed.querySelector<HTMLElement>(':scope > .embed-actions');
	if (!actions && embed.matches('.internal-embed.image-embed')) {
		actions = embed.doc.createElement('div');
		actions.className = 'embed-actions';
		embed.appendChild(actions);
	}
	if (!actions || actions.querySelector(`.${BUTTON_CLS}`)) return;
	const button = createCaptionButton(embed.doc, BUTTON_CLS, () => {
		const image = imageAt(view, embed);
		if (!image) return;
		new CaptionModal(app, 'Image caption', captionOf(image), (caption) => {
			// Read again: the note may have changed while the dialog was open.
			const now = imageAt(view, embed);
			if (!now) return;
			const next = withCaption(now, caption);
			if (next === view.state.sliceDoc(now.from, now.to)) return;
			view.dispatch({ changes: { from: now.from, to: now.to, insert: next } });
		}).open();
	});
	actions.prepend(button);
}

/** The image an embed shows, read from the markdown at its place in the note. */
export function imageAt(view: EditorView, embed: HTMLElement): ImageSource | null {
	let pos: number;
	try {
		pos = view.posAtDOM(embed);
	} catch {
		return null;
	}
	const text = view.state.sliceDoc(pos, Math.min(view.state.doc.length, pos + READ_CHARS));
	const image = readImage(text, 0);
	return image ? { ...image, from: pos + image.from, to: pos + image.to } : null;
}
