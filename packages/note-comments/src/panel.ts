import { Component, ItemView, Keymap, MarkdownRenderer, type TFile, type WorkspaceLeaf } from "obsidian";

import type { Span } from "./anchor";
import { type CommentInput, isEmbeddedOwner, mountInput } from "./embedded-editor";
import type { CommentStore, NoteComment } from "./store";
import { deleteWithUndo, formatWhen, iconButton, truncate } from "./ui";

export const COMMENTS_VIEW = "note-comments-panel";

/** What the panel needs from the plugin. */
export interface PanelHost {
	store: CommentStore;
	/**
	 * Where `id` is drawn in an open editor for `file`: a span when found, null when the note
	 * is open but the text can't be found (the comment is orphaned), undefined when the note
	 * isn't open anywhere, so nothing can be said either way.
	 */
	spanIn(file: TFile, id: string): Span | null | undefined;
	jumpTo(file: TFile, id: string): void;
	/** The passage a new comment is being written for on `file`, if a draft is open. */
	draftFor(file: TFile): { quote: string } | null;
	saveDraft(body: string): void;
	cancelDraft(): void;
}

/**
 * Every comment on the note being worked in, and the place new ones are written. It follows
 * the active note, but deliberately not the panel itself or any other non-note leaf taking
 * focus — clicking into the panel to type must not switch it to "no note".
 *
 * Laid out as a header, a draft slot and a list, rebuilt separately. The draft and the edit
 * box are live editors: rebuilding them would throw away the editor being typed into, so the
 * list is only rebuilt around them.
 */
export class CommentsPanel extends ItemView {
	private file: TFile | null = null;
	/** The comment last clicked in the editor, shown selected and scrolled to. */
	private focusedId: string | null = null;
	private editingId: string | null = null;

	private headerEl!: HTMLElement;
	private draftEl!: HTMLElement;
	private listEl!: HTMLElement;
	private draftInput: CommentInput | null = null;
	/** The quote the open draft box was built for, to tell a new draft from the same one. */
	private draftQuote: string | null = null;
	private editInput: CommentInput | null = null;
	/** Owns what MarkdownRenderer mounted into the list (mermaid, embeds), unloaded per rebuild. */
	private listScope: Component | null = null;

	private unsubscribe: (() => void) | null = null;
	private refreshTimer: number | null = null;
	/**
	 * A press is in progress inside the panel. Rebuilding the list then would replace the
	 * element under the pointer, and a browser only fires `click` when the press and the
	 * release land on the same element — so the click would simply never happen, and the
	 * button would need pressing twice. Rebuilds asked for meanwhile wait for the release.
	 */
	private pressing = false;
	private renderPending = false;

	constructor(
		leaf: WorkspaceLeaf,
		private readonly host: PanelHost,
	) {
		super(leaf);
	}

	getViewType(): string {
		return COMMENTS_VIEW;
	}

	getDisplayText(): string {
		return "Comments";
	}

	getIcon(): string {
		return "message-square-text";
	}

	async onOpen(): Promise<void> {
		const root = this.contentEl;
		root.addClass("nc-panel");
		this.headerEl = root.createDiv({ cls: "nc-panel-header" });
		this.draftEl = root.createDiv({ cls: "nc-panel-draft-slot" });
		this.listEl = root.createDiv({ cls: "nc-panel-list" });

		this.registerDomEvent(root, "pointerdown", () => {
			this.pressing = true;
		});
		const release = (): void => {
			if (!this.pressing) return;
			this.pressing = false;
			if (!this.renderPending) return;
			this.renderPending = false;
			// After the click this release is part of, not before it.
			window.setTimeout(() => this.render(), 0);
		};
		// On the document: the release can land outside the panel.
		this.registerDomEvent(document, "pointerup", release);
		this.registerDomEvent(document, "pointercancel", release);

		// Links in a rendered comment. A custom view gets rendered markdown but not Obsidian's
		// link handling with it, so internal links would otherwise do nothing when clicked.
		this.registerDomEvent(this.listEl, "click", (evt) => {
			const link = (evt.target as HTMLElement | null)?.closest<HTMLAnchorElement>("a.internal-link");
			if (!link || !this.file) return;
			evt.preventDefault();
			const target = link.dataset.href ?? link.getAttribute("href") ?? "";
			void this.app.workspace.openLinkText(target, this.file.path, Keymap.isModEvent(evt));
		});

		this.unsubscribe = this.host.store.onChange((path) => {
			if (path === "*" || path === this.file?.path) this.render();
		});
		this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.followActiveNote()));
		this.registerEvent(this.app.workspace.on("file-open", () => this.followActiveNote()));
		this.registerEvent(
			this.app.workspace.on("editor-change", (_editor, info) => {
				// Typing into a comment box here is not a change to the note — and re-rendering
				// on it would tear down the very box being typed into.
				if (isEmbeddedOwner(info)) return;
				// Typing in the note can leave a comment found or not found, and moves the order.
				this.scheduleRender();
			}),
		);
		this.followActiveNote();
	}

	async onClose(): Promise<void> {
		this.unsubscribe?.();
		this.unsubscribe = null;
		if (this.refreshTimer !== null) window.clearTimeout(this.refreshTimer);
		this.closeDraftBox();
		this.closeEditBox();
	}

	/** Show one comment — called when its text is clicked in the editor, or once it's saved. */
	reveal(file: TFile, id: string): void {
		this.setFile(file);
		this.focusedId = id;
		this.render();
		this.listEl
			.querySelector<HTMLElement>(`.nc-panel-item[data-nc-id="${CSS.escape(id)}"]`)
			?.scrollIntoView({ block: "nearest" });
	}

	/** Open the draft for a new comment on `file`, and put the cursor in it. */
	startDraft(file: TFile): void {
		this.setFile(file);
		this.focusedId = null;
		// A fresh draft starts empty, even when a box is already open for another passage.
		this.closeDraftBox();
		this.render();
		this.draftInput?.focus();
	}

	private setFile(file: TFile): void {
		if (file === this.file) return;
		this.file = file;
		this.focusedId = null;
		this.closeEditBox();
		this.closeDraftBox();
	}

	private followActiveNote(): void {
		const file = this.app.workspace.getActiveFile();
		// A non-note leaf (this panel, a canvas, a PDF) keeps the last note on screen.
		if (!file || file.extension !== "md") return;
		// Nothing to do unless the note actually changed. Clicking into the panel makes it the
		// active leaf, and this fires on that very press — re-rendering here is what swallowed
		// the first click on every button.
		if (file === this.file) return;
		this.setFile(file);
		this.render();
	}

	private scheduleRender(): void {
		if (this.refreshTimer !== null) window.clearTimeout(this.refreshTimer);
		this.refreshTimer = window.setTimeout(() => {
			this.refreshTimer = null;
			this.render();
		}, 400);
	}

	private render(): void {
		if (this.pressing) {
			this.renderPending = true;
			return;
		}
		const file = this.file;
		this.renderHeader(file);
		this.syncDraftBox(file);
		// An edit box lives in the list; rebuilding the list would destroy it mid-edit. The
		// list catches up as soon as the edit is saved or cancelled.
		if (this.editingId) return;
		this.renderList(file);
	}

	private renderHeader(file: TFile | null): void {
		this.headerEl.empty();
		if (!file) return;
		this.headerEl.createDiv({ cls: "nc-panel-title", text: file.basename });
		this.headerEl.createDiv({ cls: "nc-panel-count", text: String(this.host.store.commentsFor(file.path).length) });
	}

	/** Keep the draft box in step with the plugin's draft, without rebuilding a live one. */
	private syncDraftBox(file: TFile | null): void {
		const draft = file ? this.host.draftFor(file) : null;
		if (!draft || !file) {
			this.closeDraftBox();
			return;
		}
		if (this.draftInput && this.draftQuote === draft.quote) return;
		this.closeDraftBox();
		this.draftQuote = draft.quote;
		const box = this.draftEl.createDiv({ cls: "nc-panel-draft" });
		box.createDiv({ cls: "nc-panel-quote", text: truncate(draft.quote, 200) });
		// Declared ahead of the box: the editor reports its first change while it's being
		// mounted, before the button exists.
		let save: HTMLButtonElement | null = null;
		const syncSave = (): void => {
			if (save) save.disabled = !hasText(input);
		};
		const input = mountInput(this.app, this, box, {
			value: "",
			placeholder: "Explain this passage…",
			file,
			onSubmit: () => {
				if (hasText(input)) this.host.saveDraft(input.value);
			},
			onCancel: () => this.host.cancelDraft(),
			onChange: () => syncSave(),
		});
		this.draftInput = input;
		const actions = box.createDiv({ cls: "nc-panel-edit-actions" });
		actions.createEl("button", { text: "Cancel" }).addEventListener("click", () => this.host.cancelDraft());
		save = actions.createEl("button", { text: "Save", cls: "mod-cta" });
		save.addEventListener("click", () => this.host.saveDraft(input.value));
		syncSave();
	}

	private closeDraftBox(): void {
		this.draftInput?.destroy();
		this.draftInput = null;
		this.draftQuote = null;
		this.draftEl?.empty();
	}

	private renderList(file: TFile | null): void {
		this.closeEditBox();
		if (this.listScope) this.removeChild(this.listScope);
		this.listScope = this.addChild(new Component());
		this.listEl.empty();

		if (!file) {
			this.listEl.createDiv({ cls: "nc-panel-empty", text: "Open a note to see its comments." });
			return;
		}
		const comments = this.host.store.commentsFor(file.path);
		if (comments.length === 0) {
			if (!this.draftInput) {
				this.listEl.createDiv({
					cls: "nc-panel-empty",
					text: "No comments on this note yet. Select some text and choose Add comment.",
				});
			}
			return;
		}

		const entries = comments.map((comment) => ({ comment, span: this.host.spanIn(file, comment.id) }));
		// Reading order. With the note open, found comments go by position and the orphans
		// last; with it closed, the recorded position is the best guess there is.
		const key = (entry: { comment: NoteComment; span: Span | null | undefined }): number =>
			entry.span === null ? Infinity : (entry.span?.from ?? entry.comment.start);
		entries.sort((a, b) => key(a) - key(b));
		for (const entry of entries) this.renderItem(file, entry.comment, entry.span, this.listScope);
	}

	private renderItem(file: TFile, comment: NoteComment, span: Span | null | undefined, scope: Component): void {
		const item = this.listEl.createDiv({ cls: "nc-panel-item", attr: { "data-nc-id": comment.id } });
		if (comment.id === this.focusedId) item.addClass("is-focused");
		if (span === null) item.addClass("is-orphan");

		// The quote is what jumps to the text. The body is left to itself: it can hold links,
		// images and diagrams, each with a click of its own.
		const quote = item.createDiv({ cls: "nc-panel-quote is-clickable", text: truncate(comment.exact, 140) });
		quote.addEventListener("click", () => {
			this.focusedId = comment.id;
			this.host.jumpTo(file, comment.id);
			this.render();
		});

		if (comment.id === this.editingId) {
			const box = item.createDiv({ cls: "nc-panel-edit" });
			let save: HTMLButtonElement | null = null;
			const syncSave = (): void => {
				if (save) save.disabled = !hasText(input);
			};
			const input = mountInput(this.app, this, box, {
				value: comment.body,
				placeholder: "Explain this passage…",
				file,
				onSubmit: () => {
					if (hasText(input)) this.saveEdit();
				},
				onCancel: () => this.cancelEdit(),
				onChange: () => syncSave(),
			});
			this.editInput = input;
			const actions = box.createDiv({ cls: "nc-panel-edit-actions" });
			actions.createEl("button", { text: "Cancel" }).addEventListener("click", () => this.cancelEdit());
			save = actions.createEl("button", { text: "Save", cls: "mod-cta" });
			save.addEventListener("click", () => this.saveEdit());
			syncSave();
			// Clicking into a comment is how it's edited, so it also happens when it was only
			// being read. Leaving the box with nothing changed closes it again; with changes, it
			// stays open until saved or cancelled. A tick later, because focus leaving the box
			// may only be passing to its own buttons.
			box.addEventListener("focusout", () => {
				window.setTimeout(() => {
					if (this.editInput !== input || box.contains(box.ownerDocument.activeElement)) return;
					if (input.value.trim() === comment.body.trim()) this.cancelEdit();
				}, 0);
			});
			window.setTimeout(() => input.focus());
			return;
		}

		const body = item.createDiv({ cls: "nc-panel-body markdown-rendered is-editable" });
		// Rendered like the note itself — images, mermaid, embeds — with links resolved
		// relative to the note the comment is on.
		void MarkdownRenderer.render(this.app, comment.body, body, file.path, scope);
		// Click the text to edit it, as in Google Docs. What has a click of its own inside the
		// comment keeps it, and a click that ends a text selection is someone copying.
		body.addEventListener("click", (evt) => {
			if ((evt.target as HTMLElement | null)?.closest("a, button, input, textarea, select, audio, video, iframe")) return;
			const selection = body.ownerDocument.getSelection();
			if (selection && !selection.isCollapsed && body.contains(selection.anchorNode)) return;
			this.startEdit(file, comment.id);
		});

		const footer = item.createDiv({ cls: "nc-panel-footer" });
		footer.createSpan({
			cls: "nc-panel-meta",
			text: span === null ? "Commented text not found in this note" : formatWhen(comment.updatedAt),
		});
		const actions = footer.createDiv({ cls: "nc-panel-actions" });
		iconButton(actions, "trash-2", "Delete comment", () => deleteWithUndo(this.host.store, file, comment.id));
	}

	/** An edit is open with changes that haven't been saved. */
	hasUnsavedEdit(): boolean {
		if (!this.editingId || !this.editInput || !this.file) return false;
		const comment = this.host.store.get(this.file.path, this.editingId);
		return !!comment && this.editInput.value.trim() !== comment.body.trim();
	}

	private startEdit(file: TFile, id: string): void {
		// An edit with changes in it is never thrown away for another: it keeps the focus
		// until it's saved or cancelled.
		if (this.editingId !== id && this.hasUnsavedEdit()) {
			this.editInput?.focus();
			return;
		}
		this.editingId = id;
		this.focusedId = id;
		this.renderList(file);
	}

	private closeEditBox(): void {
		this.editInput?.destroy();
		this.editInput = null;
	}

	private saveEdit(): void {
		const file = this.file;
		const id = this.editingId;
		const body = this.editInput?.value.trim() ?? "";
		this.editingId = null;
		// Emptying a comment is not how it gets deleted — the bin is right there.
		if (file && id && body) this.host.store.updateBody(file.path, id, body);
		this.render();
	}

	private cancelEdit(): void {
		this.editingId = null;
		this.render();
	}
}

/**
 * A comment has to say something. Saving an empty one is refused rather than quietly turned
 * into a cancel or a no-op, so Save is greyed out and Enter does nothing until there's text.
 */
function hasText(input: CommentInput): boolean {
	return input.value.trim().length > 0;
}
