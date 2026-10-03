import { EditorView } from "@codemirror/view";
import {
	type Editor,
	MarkdownView,
	Notice,
	Platform,
	Plugin,
	TFile,
	type WorkspaceLeaf,
} from "obsidian";

import { type Span, trimSpan } from "./anchor";
import { EditorHost } from "./editor";
import { CommentHover } from "./hover";
import { COMMENTS_VIEW, CommentsPanel, type PanelHost } from "./panel";
import { CommentStore } from "./store";

/** Longer than this and a "comment on this passage" is really a comment on the whole note. */
const MAX_QUOTE = 5000;
/** Positions are hints, so they are written after a quiet spell rather than on every keystroke. */
const IDLE_FLUSH_MS = 30_000;
/**
 * What the sidebar was showing before the panel was brought up, so a click elsewhere can put
 * it back.
 */
interface ReturnTo {
	/** The tab that was showing, or null when there was none to remember. */
	previous: WorkspaceLeaf | null;
	/** The sidebar was collapsed, and showing the panel is what opened it. */
	wasCollapsed: boolean;
}

/** A new comment being written in the panel, for a passage marked in this editor. */
interface Draft {
	view: EditorView;
	file: TFile;
}

export default class NoteCommentsPlugin extends Plugin implements PanelHost {
	store!: CommentStore;
	private host!: EditorHost;
	private returnTo: ReturnTo | null = null;
	/**
	 * The last tab seen showing next to the panel. The fallback for putting the sidebar back
	 * when the panel came up some other way than a click — opened by hand, or restored as the
	 * selected tab on startup — and there is no record of what it replaced.
	 */
	private lastOtherTab: WorkspaceLeaf | null = null;
	private draft: Draft | null = null;
	/**
	 * The comment a press landed on, read on mousedown before CodeMirror sees it. Pressing
	 * into a line that Live Preview had collapsed makes it redraw that line — the markup is
	 * revealed — before the button comes up, so the highlight under the pointer is replaced
	 * and the click that follows arrives on the line instead. Judged by the click alone, the
	 * first click on such a comment looked like a click elsewhere, and it took a second one,
	 * with the line already open, to bring the comment up.
	 */
	private pressedId: string | undefined;

	async onload(): Promise<void> {
		this.store = new CommentStore(this);
		// Before the editor extension exists: its field reads the store synchronously when an
		// editor opens, and an editor opened before this resolved would anchor against nothing.
		await this.store.load();

		this.host = new EditorHost({ store: this.store });
		this.store.listener = this.host;
		this.registerEditorExtension(this.host.extension());
		this.registerView(COMMENTS_VIEW, (leaf) => new CommentsPanel(leaf, this));

		this.addCommand({
			id: "add-comment",
			name: "Add comment to selection",
			icon: "message-square-plus",
			// The one Google Docs, Feishu and Word on Windows all use for "add comment".
			// Upper-case on purpose: Obsidian matches a hotkey against either the typed
			// character or the key code's letter, and the letter is compared as "M". On a Mac,
			// Option turns the character into "µ", so a lower-case "m" matches neither.
			// eslint-disable-next-line obsidianmd/commands/no-default-hotkeys -- a personal plugin, not published; checked free in this vault and Obsidian's defaults
			hotkeys: [{ modifiers: ["Mod", "Alt"], key: "M" }],
			editorCheckCallback: (checking, editor) => {
				// Available in any editor, with or without a usable selection. A hotkey whose
				// command reports itself unavailable is passed on, and Cmd+Option+M is macOS's
				// Minimize All: pressed with nothing selected, it put every window away.
				if (checking) return true;
				const target = this.commentTarget(editor);
				if (target) void this.startComment(target);
				else new Notice("Select the text to comment on first.");
				return true;
			},
		});

		this.addCommand({
			id: "show-comments",
			name: "Show comments of this note",
			icon: "message-square-text",
			callback: () => void this.openPanel(),
		});

		this.registerEvent(
			this.app.workspace.on("editor-menu", (menu, editor) => {
				// Same eligibility as the command, which also keeps it out of Live Preview table
				// cells: their menu hands over the cell's own editor, whose offsets are local to
				// the cell, and that editor's field is inert.
				const target = this.commentTarget(editor);
				if (!target) return;
				menu.addItem((item) =>
					item
						.setTitle("Add comment")
						.setIcon("message-square-plus")
						.setSection("selection")
						.onClick(() => void this.startComment(target)),
				);
			}),
		);

		this.registerDomEvent(
			document,
			"mousedown",
			(evt) => {
				this.pressedId = evt.button === 0 ? highlightIdOf(evt.target) : undefined;
			},
			{ capture: true },
		);
		// Bubble phase, after CodeMirror has placed the cursor for this click.
		this.registerDomEvent(document, "click", (evt) => this.onEditorClick(evt));

		// Reading a comment without opening the panel: a card while the pointer rests on its
		// text. A touch screen has no hover.
		if (!Platform.isMobile) {
			const hover = new CommentHover(this.app, this.store, this.host);
			this.registerDomEvent(document, "mouseover", (evt) => hover.onMouseOver(evt));
			this.registerDomEvent(document, "mousedown", (evt) => hover.onPress(evt), { capture: true });
			this.registerDomEvent(document, "mouseup", (evt) => hover.onRelease(evt), { capture: true });
			this.registerDomEvent(document, "wheel", (evt) => hover.onWheel(evt), { capture: true, passive: true });
			this.registerEvent(this.app.workspace.on("active-leaf-change", () => hover.hide()));
			this.register(() => hover.hide());
		}
		this.registerEvent(this.app.workspace.on("layout-change", () => this.trackOtherTab()));
		this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.trackOtherTab()));

		// Comments are bound to the TFile inside open editors, so a rename only has to move
		// the stored key. A deleted note's comments are parked, not dropped.
		this.registerEvent(this.app.vault.on("rename", (file, oldPath) => this.store.rename(oldPath, file.path)));
		this.registerEvent(this.app.vault.on("delete", (file) => this.store.trashPath(file.path)));
		// A comments panel left open across a reload of this plugin keeps the view the old
		// instance made — and with it the old, unloaded store, which never writes again.
		// Comments added there then lived only in memory and were gone at the next restart.
		// Rebuild any such panel so it belongs to this instance.
		this.app.workspace.onLayoutReady(() => void this.rebuildForeignPanels());
		this.app.workspace.onLayoutReady(() => {
			// `create` fires for every file while the vault loads; only one appearing after
			// that is a note coming back.
			this.registerEvent(
				this.app.vault.on("create", (file) => {
					if (file instanceof TFile) this.store.restoreFromTrash(file.path);
				}),
			);
		});

		this.registerInterval(
			window.setInterval(() => {
				if (!this.host.dirty) return;
				this.host.reportAll();
				void this.store.save();
			}, IDLE_FLUSH_MS),
		);
		this.registerEvent(
			this.app.workspace.on("quit", (tasks) => {
				this.host.reportAll();
				tasks.add(() => this.store.save());
			}),
		);
	}

	private async rebuildForeignPanels(): Promise<void> {
		for (const leaf of this.app.workspace.getLeavesOfType(COMMENTS_VIEW)) {
			if (leaf.view instanceof CommentsPanel && leaf.view.isFor(this)) continue;
			const state = leaf.getViewState();
			await leaf.setViewState({ type: "empty" });
			await leaf.setViewState({ ...state, type: COMMENTS_VIEW });
		}
	}

	/** Another device wrote data.json (it arrived through iCloud): fold it in, don't replace. */
	async onExternalSettingsChange(): Promise<void> {
		this.store.mergeExternal(await this.loadData());
	}

	onunload(): void {
		// Editors whose extension was removed have already reported — their ViewPlugin was
		// destroyed before this runs. The ones left are those Obsidian never reconfigures:
		// canvas cards and hover previews.
		this.host.reportAll();
		this.store.flushOnUnload();
	}

	// --- PanelHost -------------------------------------------------------------------------

	spanIn(file: TFile, id: string): Span | null | undefined {
		const target = this.editorFor(file);
		return target ? this.host.spanOf(target.view.state, id) : undefined;
	}

	jumpTo(file: TFile, id: string): void {
		const target = this.editorFor(file);
		const span = target ? this.host.spanOf(target.view.state, id) : null;
		if (!target || !span) {
			new Notice(
				target
					? "The commented text can no longer be found in this note."
					: "Open the note to jump to this comment.",
			);
			return;
		}
		target.view.dispatch({
			selection: { anchor: span.from, head: span.to },
			effects: EditorView.scrollIntoView(span.from, { y: "center" }),
		});
		this.app.workspace.setActiveLeaf(target.leaf, { focus: true });
	}

	draftFor(file: TFile): { quote: string } | null {
		const draft = this.liveDraft();
		if (!draft || draft.file !== file) return null;
		const span = this.host.draftSpan(draft.view.state);
		return span ? { quote: draft.view.state.sliceDoc(span.from, span.to) } : null;
	}

	saveDraft(body: string): void {
		const draft = this.liveDraft();
		this.draft = null;
		if (!draft) return;
		const comment = this.host.submit(draft.view, body);
		if (!comment) {
			// Empty text is a cancelled comment, not an error.
			this.host.endDraft(draft.view);
			void this.hidePanel();
			return;
		}
		void this.withPanel((panel) => panel.reveal(draft.file, comment.id));
		this.focusNote(draft.view);
	}

	cancelDraft(): void {
		const draft = this.liveDraft();
		this.draft = null;
		if (!draft) return;
		this.host.endDraft(draft.view);
		void this.hidePanel();
		this.focusNote(draft.view);
	}

	// --- Showing and hiding the panel ------------------------------------------------------

	/**
	 * The panel is only up while it's being used: a comment's text was clicked, or a new one
	 * is being written. A click on any other text in a note puts the sidebar back. Only clicks
	 * in a note's own text count — not the panel, not a table cell, not the gutter.
	 */
	private onEditorClick(evt: MouseEvent): void {
		const pressedId = this.pressedId;
		this.pressedId = undefined;
		if (evt.button !== 0 || evt.defaultPrevented) return;
		if (evt.metaKey || evt.ctrlKey || evt.altKey || evt.shiftKey) return;
		const target = evt.target instanceof HTMLElement ? evt.target : null;
		const content = target?.closest<HTMLElement>(".cm-content");
		const editorEl = content?.closest<HTMLElement>(".cm-editor");
		const view = editorEl ? EditorView.findFromDOM(editorEl) : null;
		const file = view ? this.host.valueOf(view.state)?.file : null;
		if (!view || !file) return;
		// A drag or a double-click that selected text ends in a click too. That is selecting —
		// often to add a comment — not pointing at anything, so it moves nothing.
		if (!view.state.selection.main.empty) return;
		const id = highlightIdOf(target) ?? pressedId;
		if (id && this.store.get(file.path, id)) void this.showComment(file, id);
		else void this.hidePanel();
	}

	private async showComment(file: TFile, id: string): Promise<void> {
		const noteLeaf = this.app.workspace.getMostRecentLeaf();
		const switched = await this.showPanel();
		// The click was into the note; keep the cursor there rather than in the sidebar.
		if (switched) this.keepNoteActive(noteLeaf);
		await this.withPanel((panel) => panel.reveal(file, id));
	}

	private async startComment(target: { view: EditorView; span: Span }): Promise<void> {
		const file = this.host.valueOf(target.view.state)?.file;
		if (!file) return;
		this.host.beginDraft(target.view, target.span);
		this.draft = { view: target.view, file };
		await this.showPanel();
		// Unlike showing a comment, focus is meant to land in the panel here: that is where
		// the comment is typed.
		await this.withPanel((panel) => panel.startDraft(file));
	}

	/** Bring the panel up; returns whether that meant switching the sidebar to it. */
	private async showPanel(): Promise<boolean> {
		const leaf = await this.app.workspace.ensureSideLeaf(COMMENTS_VIEW, "right", {
			active: false,
			reveal: false,
		});
		if (isShown(leaf)) return false;
		// Recorded only on the switch itself: a second comment clicked while the panel is up
		// must not overwrite "what was here before" with the panel.
		this.returnTo = {
			previous: visibleSibling(leaf) ?? this.lastOtherTab,
			wasCollapsed: this.dockOf(leaf)?.collapsed ?? false,
		};
		await this.app.workspace.revealLeaf(leaf);
		return true;
	}

	/** Put back whatever the sidebar showed before the panel came up. */
	private async hidePanel(): Promise<void> {
		// A comment being written is never put away by a stray click, and neither is one being
		// edited. An edit with nothing changed has already closed itself by the time the
		// click arrives (it closes as focus leaves it), so a comment that was only being read
		// doesn't hold the panel up.
		if (this.liveDraft()) return;
		const panel = this.panelLeaf()?.view;
		if (panel instanceof CommentsPanel && panel.hasUnsavedEdit()) return;
		// On a phone the sidebar is a drawer over the note, and it closes itself the moment
		// the note is tapped. Revealing a tab here would open the drawer again instead.
		if (Platform.isMobile) return;
		const leaf = this.panelLeaf();
		const state = this.returnTo;
		this.returnTo = null;
		if (!leaf || !isShown(leaf)) return;
		const noteLeaf = this.app.workspace.getMostRecentLeaf();
		if (state?.wasCollapsed) {
			this.dockOf(leaf)?.collapse();
		} else {
			// Only a tab still in the panel's group — it may have been closed or dragged away,
			// and a closed leaf can keep a stale reference to the group it left.
			const group = siblingsOf(leaf);
			const back = [state?.previous, this.lastOtherTab, firstSibling(leaf)].find(
				(candidate): candidate is WorkspaceLeaf => !!candidate && group.includes(candidate),
			);
			if (back) await this.app.workspace.revealLeaf(back);
		}
		this.keepNoteActive(noteLeaf);
	}

	private trackOtherTab(): void {
		const leaf = this.panelLeaf();
		const other = leaf ? visibleSibling(leaf) : null;
		if (other) this.lastOtherTab = other;
	}

	private async withPanel(fn: (panel: CommentsPanel) => void): Promise<void> {
		const leaf = this.panelLeaf();
		if (!leaf) return;
		await leaf.loadIfDeferred();
		if (leaf.view instanceof CommentsPanel) fn(leaf.view);
	}

	private panelLeaf(): WorkspaceLeaf | null {
		return this.app.workspace.getLeavesOfType(COMMENTS_VIEW)[0] ?? null;
	}

	/**
	 * Revealing a sidebar tab makes it the active leaf, which would pull the cursor out of the
	 * note that was just clicked into. Hand it back. Not on mobile: there the sidebar is a
	 * drawer over the note, and activating the note closes the drawer that was just opened.
	 */
	private keepNoteActive(noteLeaf: WorkspaceLeaf | null): void {
		if (noteLeaf && !Platform.isMobile) this.app.workspace.setActiveLeaf(noteLeaf, { focus: true });
	}

	/** Back to the note after finishing in the panel — again, not over a phone's drawer. */
	private focusNote(view: EditorView): void {
		if (!Platform.isMobile) view.focus();
	}

	/**
	 * The open draft, or null once it can no longer be saved: its editor moved on to another
	 * note (Obsidian replaces the editor state, and the marked passage with it), or the
	 * passage was deleted.
	 */
	private liveDraft(): Draft | null {
		const draft = this.draft;
		if (!draft) return null;
		const stillThere =
			this.host.valueOf(draft.view.state)?.file === draft.file && this.host.draftSpan(draft.view.state) !== null;
		if (!stillThere) this.draft = null;
		return stillThere ? draft : null;
	}

	private async openPanel(): Promise<void> {
		await this.app.workspace.ensureSideLeaf(COMMENTS_VIEW, "right", { active: true, reveal: true });
	}

	// --- Helpers ---------------------------------------------------------------------------

	/**
	 * The editor and range to comment on, or null when the current selection can't take one.
	 * The range is trimmed of surrounding whitespace (a triple-click takes the newline too).
	 */
	private commentTarget(editor: Editor): { view: EditorView; span: Span } | null {
		if (this.store.readOnly) return null;
		const view = cmOf(editor);
		const value = view ? this.host.valueOf(view.state) : null;
		if (!view || !value?.file) return null;
		const { ranges, main } = view.state.selection;
		if (ranges.length !== 1 || main.empty || main.to - main.from > MAX_QUOTE) return null;
		const text = view.state.sliceDoc(main.from, main.to);
		const trimmed = trimSpan(text, 0, text.length);
		if (!trimmed) return null;
		const span = { from: main.from + trimmed.from, to: main.from + trimmed.to };
		// The Properties UI rewrites the whole frontmatter block on any change, so a comment
		// there would be orphaned by the next edit to any property.
		const frontmatter = this.app.metadataCache.getFileCache(value.file)?.frontmatterPosition;
		if (frontmatter && span.from <= frontmatter.end.offset) return null;
		return { view, span };
	}

	/** An open editor showing `file`, preferring the note last worked in. */
	private editorFor(file: TFile): { leaf: WorkspaceLeaf; view: EditorView } | null {
		const recent = this.app.workspace.getMostRecentLeaf();
		const leaves = this.app.workspace.getLeavesOfType("markdown");
		const ordered = recent && leaves.includes(recent) ? [recent, ...leaves.filter((l) => l !== recent)] : leaves;
		for (const leaf of ordered) {
			// A tab Obsidian hasn't built yet has no editor to ask.
			if (!(leaf.view instanceof MarkdownView) || leaf.view.file?.path !== file.path) continue;
			const view = cmOf(leaf.view.editor);
			if (view && this.host.valueOf(view.state)?.file) return { leaf, view };
		}
		return null;
	}

	private dockOf(leaf: WorkspaceLeaf): { collapsed: boolean; collapse(): void } | null {
		const root = leaf.getRoot();
		const { leftSplit, rightSplit } = this.app.workspace;
		if (root === rightSplit) return rightSplit;
		if (root === leftSplit) return leftSplit;
		return null;
	}
}

/** The comment whose highlight `target` is part of. */
function highlightIdOf(target: EventTarget | null): string | undefined {
	if (!(target instanceof HTMLElement)) return undefined;
	return target.closest<HTMLElement>(".nc-highlight[data-nc-id]")?.dataset.ncId;
}

function cmOf(editor: Editor): EditorView | null {
	return (editor as unknown as { cm?: EditorView }).cm ?? null;
}

/** Whether a leaf is on screen — the visible tab of an expanded sidebar, say. */
function isShown(leaf: WorkspaceLeaf): boolean {
	return leaf.view.containerEl.offsetParent !== null;
}

function siblingsOf(leaf: WorkspaceLeaf): WorkspaceLeaf[] {
	const group = leaf.parent as unknown as { children?: WorkspaceLeaf[] };
	return (group.children ?? []).filter((other) => other !== leaf);
}

/** The tab on screen in the same group as `leaf`; none while the sidebar is collapsed. */
function visibleSibling(leaf: WorkspaceLeaf): WorkspaceLeaf | null {
	return siblingsOf(leaf).find(isShown) ?? null;
}

/** Any other tab in the group — the last resort when nothing was recorded. */
function firstSibling(leaf: WorkspaceLeaf): WorkspaceLeaf | null {
	return siblingsOf(leaf)[0] ?? null;
}
