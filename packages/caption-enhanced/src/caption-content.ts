import type { App, Component } from 'obsidian';
import { followCaptionLink as follow, renderCaption } from '../../../shared/caption';

/** Class on an image's caption. */
export const CAPTION_CLS = 'image-caption';

/** What caption text needs to be rendered; set by the plugin on load. */
interface RenderContext {
	app: App;
	component: Component;
}

let context: RenderContext | null = null;

export function setRenderContext(next: RenderContext | null): void {
	context = next;
}

/** The app, for Live Preview's view plugin, which has none of its own. */
export function captionApp(): App | null {
	return context?.app ?? null;
}

/** An image's caption in its element, as every figure's is (shared/caption.ts). */
export function setCaptionContent(el: HTMLElement, caption: string, sourcePath: string): void {
	renderCaption(el, caption, context ? { ...context, sourcePath } : null);
}

/** Follow a link clicked in an image's caption. */
export function followCaptionLink(app: App, evt: MouseEvent, sourcePath: string): boolean {
	return follow(app, evt, sourcePath, `.${CAPTION_CLS}`);
}
