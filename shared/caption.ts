import { type App, type Component, Keymap, MarkdownRenderer, Modal, setIcon, setTooltip } from "obsidian";

/*
 * A figure's caption, the same wherever it's under: an image or an Excalidraw drawing
 * (Caption (Enhanced)), a Mermaid diagram (Mermaid (Enhanced)). One look for the button that
 * edits it and the dialog it opens — Auto Link Title's titles for a pasted url included —
 * one way of rendering it: links, a bare url after its words, emphasis, code; and its links
 * followed where an editor's widget would swallow the click. Where a caption is written stays
 * each plugin's own: an image's alt, a drawing's alias, a diagram's `%% caption %%`.
 */

/** Markdown's own — a link, a wikilink, emphasis, code — or a bare url. A caption without any is plain text. */
const RICH_RE = /\[[^\]]*\]\([^)]*\)|\[\[[^\]]+\]\]|\*[^*]+\*|_[^_]+_|`[^`]+`|~~[^~]+~~|==[^=]+==|\bhttps?:\/\/\S/;
/** A caption's words followed by a url: `HSA Portal https://…`. */
const TEXT_THEN_URL_RE = /^(.*?\S)\s+(https?:\/\/\S+)$/;
/** What a caption element shows was made from: compared against this, not its textContent. */
const SOURCE_ATTR = "captionSource";

/** Whether a caption has markdown in it, and so is rendered rather than set as text. */
export function isRichCaption(caption: string): boolean {
	return RICH_RE.test(caption);
}

/**
 * A caption as markdown, for rendering. Words with a url after them link there — `HSA
 * Portal https://…` shows as "HSA Portal", the url left out; a url anywhere else shows as
 * itself, linked. Markdown already in it is kept.
 */
export function captionMarkdown(caption: string): string {
	const pair = TEXT_THEN_URL_RE.exec(caption);
	if (pair?.[1] && pair[2] && !/https?:\/\//.test(pair[1]) && !pair[1].includes("]")) {
		return `[${pair[1]}](${pair[2]})`;
	}
	return caption;
}

export interface CaptionContext {
	app: App;
	/** What the rendered markdown's children live under: the plugin. */
	component: Component;
	/** The note the caption is in, which its links are relative to. */
	sourcePath: string;
}

/**
 * Put a caption's text in its element: as text, or — with a link, a url, emphasis or code in
 * it — rendered as markdown (see captionMarkdown). Done only when the text changed; a render
 * is asynchronous, and the scans that call this run on every DOM change.
 */
export function renderCaption(el: HTMLElement, caption: string, context: CaptionContext | null): void {
	if (el.dataset[SOURCE_ATTR] === caption) return;
	el.dataset[SOURCE_ATTR] = caption;
	if (!context || !isRichCaption(caption)) {
		el.setText(caption);
		return;
	}
	const scratch = el.doc.createElement("div");
	void MarkdownRenderer.render(context.app, captionMarkdown(caption), scratch, context.sourcePath, context.component).then(() => {
		// Changed again while this one rendered.
		if (el.dataset[SOURCE_ATTR] !== caption) return;
		const only = scratch.children.length === 1 ? scratch.firstElementChild : null;
		// One paragraph, its contents inline in the caption. Anything else — a heading, a
		// list, from a caption that happens to start like one — is shown as written.
		if (only?.tagName !== "P") {
			el.setText(caption);
			return;
		}
		el.replaceChildren(...Array.from(only.childNodes));
	});
}

/**
 * Follow a link clicked in a caption matching `selector`. In Live Preview a caption sits in
 * an editor widget, where nothing follows its links and a click would open the markdown;
 * Cmd/Ctrl opens a note in a new tab.
 */
export function followCaptionLink(app: App, evt: MouseEvent, sourcePath: string, selector: string): boolean {
	const link = evt.target instanceof Element ? evt.target.closest<HTMLAnchorElement>(`${selector} a`) : null;
	if (!link) return false;
	evt.preventDefault();
	evt.stopPropagation();
	const internal = link.dataset.href ?? (link.hasClass("internal-link") ? link.getAttribute("href") : null);
	if (internal) {
		void app.workspace.openLinkText(internal, sourcePath, Keymap.isModEvent(evt));
	} else if (link.href) {
		window.open(link.href, "_blank");
	}
	return true;
}

/**
 * The button that edits a caption, for an embed's action group (Obsidian's own Zoom in and
 * Edit this block). Obsidian binds each action's click on the element itself, so borrowing
 * `embed-action` borrows only the look and the reveal on hover. Its presses are kept from the
 * editor, which would put the cursor in the markdown, and from the embed's own handlers.
 */
export function createCaptionButton(doc: Document, cls: string, onClick: () => void): HTMLElement {
	const button = doc.createElement("div");
	button.className = `embed-action ${cls}`;
	setIcon(button, "captions");
	setTooltip(button, "Edit caption");
	for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup"]) {
		button.addEventListener(type, (evt) => evt.stopPropagation());
	}
	button.addEventListener("click", (evt) => {
		evt.preventDefault();
		evt.stopPropagation();
		onClick();
	});
	return button;
}

/** The part of Auto Link Title (Enhanced) a caption borrows: its titles for a pasted url. */
interface AutoLinkTitle {
	fetchUrlTitle?: (url: string) => Promise<string>;
	escapeMarkdown?: (text: string) => string;
	shortTitle?: (title: string) => string;
	isBlacklisted?: (url: string) => boolean;
	settings?: { shouldPreserveSelectionAsTitle?: boolean };
}

const AUTO_LINK_TITLE = "auto-link-title-enhanced";
/** A url as pasted; an image's has no title worth fetching, as Auto Link Title has it. */
const PASTED_URL_RE = /^https?:\/\/\S+$/;
const IMAGE_URL_RE = /\.(gif|jpe?g|tiff?|png|webp|bmp|svg)$/i;

function autoLinkTitle(app: App): AutoLinkTitle | null {
	const plugins = (app as unknown as { plugins?: { plugins?: Record<string, unknown> } }).plugins?.plugins;
	const plugin = plugins?.[AUTO_LINK_TITLE] as AutoLinkTitle | undefined;
	return typeof plugin?.fetchUrlTitle === "function" ? plugin : null;
}

/** A url's link title the way Auto Link Title writes one in a note: escaped, shortened. */
function titleFor(titler: AutoLinkTitle, url: string): Promise<string> {
	if (titler.isBlacklisted?.(url)) return Promise.resolve(new URL(url).hostname);
	// No async/await here: shared code has no tslib of its own to compile them with.
	return (titler.fetchUrlTitle?.(url) ?? Promise.resolve("")).then((title) => {
		const escaped = titler.escapeMarkdown?.(title) ?? title;
		return titler.shortTitle?.(escaped) ?? escaped;
	});
}

/**
 * A one-field dialog for an image's caption. Enter saves; an empty field removes the
 * caption. Enter is ignored mid-composition, or confirming a pinyin candidate would save
 * half-typed text.
 *
 * A url pasted in becomes a titled link, as Auto Link Title (Enhanced) makes one in a note —
 * a field of a dialog is no editor, so it never sees the paste: `[Fetching title…](url)` at
 * once, its title when it comes; over selected words, they're the link's text. Saving waits
 * for titles still coming.
 */
export class CaptionModal extends Modal {
	private readonly pending = new Set<Promise<void>>();
	private fetches = 0;

	constructor(
		app: App,
		private readonly heading: string,
		private readonly initial: string,
		private readonly onSubmit: (caption: string) => void,
	) {
		super(app);
	}

	onOpen(): void {
		this.titleEl.setText(this.heading);
		const input = this.contentEl.createEl("input", {
			type: "text",
			cls: "image-caption-input",
			attr: { placeholder: "Leave empty to remove the caption" },
		});
		input.value = this.initial;
		this.contentEl.createDiv({
			cls: "setting-item-description image-caption-hint",
			text: "Links work as in a note: [text](https://…), or paste a url for its title. [[note]], **bold**, *italic* and `code` work too.",
		});
		const save = this.contentEl
			.createDiv({ cls: "modal-button-container" })
			.createEl("button", { text: "Save", cls: "mod-cta" });
		const submit = (): Promise<void> => {
			if (this.pending.size > 0) {
				save.setText("Fetching title…");
				save.disabled = true;
			}
			return Promise.all(Array.from(this.pending)).then(() => {
				this.onSubmit(input.value);
				this.close();
			});
		};
		input.addEventListener("keydown", (evt) => {
			if (evt.key === "Enter" && !evt.isComposing) {
				evt.preventDefault();
				void submit();
			}
		});
		input.addEventListener("paste", (evt) => this.onPaste(evt, input));
		save.addEventListener("click", () => void submit());
		input.focus();
		input.select();
	}

	private onPaste(evt: ClipboardEvent, input: HTMLInputElement): void {
		const url = evt.clipboardData?.getData("text/plain").trim() ?? "";
		const titler = autoLinkTitle(this.app);
		if (!titler || !PASTED_URL_RE.test(url) || IMAGE_URL_RE.test(url)) return;
		evt.preventDefault();
		const start = input.selectionStart ?? input.value.length;
		const end = input.selectionEnd ?? start;
		const selected = input.value.slice(start, end).trim();
		if (selected && titler.settings?.shouldPreserveSelectionAsTitle !== false) {
			input.setRangeText(`[${selected}](${url})`, start, end, "end");
			return;
		}
		// Numbered, so two pasted at once each find their own again.
		const placeholder = `[Fetching title${++this.fetches > 1 ? ` ${this.fetches}` : ""}…](${url})`;
		input.setRangeText(placeholder, start, end, "end");
		const fetch = titleFor(titler, url)
			.catch(() => new URL(url).hostname)
			.then((title) => {
				const at = input.value.indexOf(placeholder);
				if (at >= 0) input.setRangeText(`[${title || new URL(url).hostname}](${url})`, at, at + placeholder.length, "preserve");
			})
			.finally(() => this.pending.delete(fetch));
		this.pending.add(fetch);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
