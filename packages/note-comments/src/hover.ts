import { EditorView } from "@codemirror/view";
import { type App, Component, MarkdownRenderer } from "obsidian";

import type { EditorHost } from "./editor";
import type { CommentStore } from "./store";
import { formatWhen } from "./ui";

/** Rest the pointer this long on highlighted text before its comment shows. */
const SHOW_DELAY_MS = 400;
/** Grace for crossing the gap from the text to the card. */
const HIDE_DELAY_MS = 200;
const GAP_PX = 6;
const EDGE_PX = 8;

/**
 * A comment shown in a small read-only card while the pointer rests on its highlighted text
 * — to read it without opening the panel. Clicking the text still opens the comment in the
 * panel, which is where it's edited.
 *
 * The card sits under the line the pointer is on (above it when there's no room), and stays
 * up while the pointer moves into it, so a long comment can be scrolled and its links
 * followed. It goes when the pointer leaves the text and the card — typing doesn't put it
 * away — and on a press (a click on the text opens the panel), a scroll of the note (the text
 * moves out from under it), or a switch of tab. Its text can be selected and copied: a drag
 * that starts in the card keeps it up until the button is let go, wherever the pointer has
 * wandered. Desktop only: a touch screen has no hover.
 */
export class CommentHover {
	private card: HTMLElement | null = null;
	private renderer: Component | null = null;
	private shownId: string | null = null;
	private showTimer: number | null = null;
	private hideTimer: number | null = null;
	/** A press that began in the card is still held — selecting its text, usually. */
	private selecting = false;

	constructor(
		private readonly app: App,
		private readonly store: CommentStore,
		private readonly host: EditorHost,
	) {}

	onMouseOver(evt: MouseEvent): void {
		// A drag selecting the card's text may stray past its edge, over the note or another
		// comment; neither puts the card away or swaps it until the button is let go.
		if (this.selecting) return;
		const target = evt.target instanceof HTMLElement ? evt.target : null;
		if (target && this.card?.contains(target)) {
			this.cancelHide();
			return;
		}
		const mark = target?.closest<HTMLElement>(".nc-highlight[data-nc-id]") ?? null;
		const id = mark?.dataset.ncId;
		const path = mark ? this.fileOf(mark) : null;
		if (!mark || !id || !path) {
			this.cancelShow();
			if (this.card) this.scheduleHide();
			return;
		}
		this.cancelHide();
		if (this.shownId === id) return;
		this.cancelShow();
		// Moving from one comment straight to another swaps the card at once.
		const delay = this.card ? 0 : SHOW_DELAY_MS;
		const { clientX, clientY } = evt;
		this.showTimer = window.setTimeout(() => {
			this.showTimer = null;
			if (mark.isConnected) void this.show(path, id, mark, clientX, clientY);
		}, delay);
	}

	/** A press anywhere but in the card puts it away — a click on the text opens the panel. */
	onPress(evt: MouseEvent): void {
		if (evt.target instanceof Node && this.card?.contains(evt.target)) {
			this.selecting = evt.button === 0;
			return;
		}
		this.hide();
	}

	/** The end of a press in the card: let go outside it and it goes, as if the pointer had just left. */
	onRelease(evt: MouseEvent): void {
		if (!this.selecting) return;
		this.selecting = false;
		if (!(evt.target instanceof Node && this.card?.contains(evt.target))) this.scheduleHide();
	}

	/** Scrolling the note moves the text out from under the card; scrolling the card doesn't. */
	onWheel(evt: WheelEvent): void {
		if (evt.target instanceof Node && this.card?.contains(evt.target)) return;
		this.hide();
	}

	hide(): void {
		this.cancelShow();
		this.cancelHide();
		this.renderer?.unload();
		this.renderer = null;
		this.card?.remove();
		this.card = null;
		this.shownId = null;
		this.selecting = false;
	}

	private async show(path: string, id: string, mark: HTMLElement, x: number, y: number): Promise<void> {
		const comment = this.store.get(path, id);
		if (!comment) return;
		this.hide();

		const card = mark.doc.body.createDiv({ cls: "nc-hover" });
		const body = card.createDiv({ cls: "nc-hover-body nc-panel-body markdown-rendered" });
		card.createDiv({ cls: "nc-hover-meta", text: formatWhen(comment.updatedAt) });
		this.card = card;
		this.shownId = id;
		this.renderer = new Component();
		this.renderer.load();

		this.place(card, mark, x, y);
		// Rendered like the panel renders it — images, mermaid, links — relative to the note.
		await MarkdownRenderer.render(this.app, comment.body, body, path, this.renderer);
		// Rendering can change its size; images and diagrams especially.
		if (this.card === card) this.place(card, mark, x, y);
	}

	/** Under the line the pointer is on, else above it; kept inside the window. */
	private place(card: HTMLElement, mark: HTMLElement, x: number, y: number): void {
		const rects = Array.from(mark.getClientRects());
		const line = rects.find((rect) => y >= rect.top && y <= rect.bottom) ?? mark.getBoundingClientRect();
		const win = mark.win;
		const { offsetWidth: width, offsetHeight: height } = card;
		const left = Math.min(Math.max(x - 24, EDGE_PX), win.innerWidth - width - EDGE_PX);
		const below = line.bottom + GAP_PX;
		const top =
			below + height <= win.innerHeight - EDGE_PX ? below : Math.max(EDGE_PX, line.top - GAP_PX - height);
		card.style.left = `${Math.max(left, EDGE_PX)}px`;
		card.style.top = `${top}px`;
	}

	/** The note whose editor this highlight is in. */
	private fileOf(mark: HTMLElement): string | null {
		const editorEl = mark.closest<HTMLElement>(".cm-editor");
		const view = editorEl ? EditorView.findFromDOM(editorEl) : null;
		return view ? (this.host.valueOf(view.state)?.file?.path ?? null) : null;
	}

	private scheduleHide(): void {
		if (this.hideTimer !== null) return;
		this.hideTimer = window.setTimeout(() => {
			this.hideTimer = null;
			this.hide();
		}, HIDE_DELAY_MS);
	}

	private cancelHide(): void {
		if (this.hideTimer === null) return;
		window.clearTimeout(this.hideTimer);
		this.hideTimer = null;
	}

	private cancelShow(): void {
		if (this.showTimer === null) return;
		window.clearTimeout(this.showTimer);
		this.showTimer = null;
	}
}
