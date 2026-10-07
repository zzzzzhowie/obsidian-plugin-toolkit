import { type App, FuzzySuggestModal, MarkdownView, Notice, Platform, Plugin, setIcon, type TFile, WorkspaceLeaf } from "obsidian";

import { askToSave, saveDraftDialog } from "./dialogs";
import { allDrafts, createDraft, DRAFTS_FOLDER, isDraft, suggestName } from "./drafts";

/** Obsidian's own "Save current file", ⌘S by default. In a draft it saves it into the vault. */
const SAVE_COMMAND = "editor:save-file";
const NEW_DRAFT_COMMAND = "yeyan-drafts:new-draft";
/**
 * claudian-enhanced's ⌘N: a new draft, or a fresh Claudian tab with the pointer over Claudian.
 * Obsidian runs only the first command bound to a key, so the two meanings share that one
 * command, and it's the key that reaches a draft when "New draft" has none of its own.
 */
const CLAUDIAN_NEW_COMMAND = "claudian-enhanced:clear-tab";
/** On a draft's view: the hint over an empty draft, no inline title, no folder in the header. */
const DRAFT_CLS = "drafts-is-draft";
const NEW_DRAFT_BUTTON_CLS = "drafts-new-draft";
const DRAFT_TAB_CLS = "drafts-tab-status";

/** Commands, which the public typings leave out of `App`. */
interface AppInternals {
	commands: {
		commands: Record<string, { checkCallback?: (checking: boolean) => boolean | void } | undefined>;
	};
	hotkeyManager?: { printHotkeyForCommand?: (id: string) => string };
	vault: { getConfig?: (key: string) => unknown; setConfig?: (key: string, value: unknown) => void };
}

/**
 * VS Code's untitled files, for Obsidian. "New draft" opens a blank note that isn't anywhere
 * yet — no "Untitled.md" left in the vault for every thought jotted down — and ⌘S asks for a
 * name and a folder and puts it there. Closing a draft with something in it asks first: Save,
 * Don't save, or Cancel. One left open when Obsidian quits is still there next time, as VS
 * Code keeps its untitled editors.
 */
export default class DraftsPlugin extends Plugin {
	/** Drafts some tab showed at the last look, to notice one no tab shows any more. */
	private openDrafts = new Set<string>();
	/** Drafts being closed through the prompt, which decides their fate itself. */
	private readonly settling = new Set<string>();
	/** Tabs whose close prompt is up, so a second ⌘W doesn't stack another. */
	private readonly confirming = new WeakSet<WorkspaceLeaf>();
	/** The last note opened that wasn't a draft: where "Default location for new notes" starts from. */
	private lastNotePath = "";
	private saving = false;
	private unloaded = false;
	private refreshFrame: number | null = null;

	onload(): void {
		this.addCommand({
			id: "new-draft",
			name: "New draft",
			icon: "file-pen",
			callback: () => void this.newDraft(),
		});
		this.addCommand({
			id: "save-draft",
			name: "Save draft to the vault",
			checkCallback: (checking) => {
				const file = this.activeDraft();
				if (!file) return false;
				if (!checking) void this.saveDraft(file);
				return true;
			},
		});
		this.addCommand({
			id: "open-draft",
			name: "Open draft…",
			checkCallback: (checking) => {
				const drafts = allDrafts(this.app);
				if (drafts.length === 0) return false;
				if (!checking) new DraftPicker(this.app, drafts).open();
				return true;
			},
		});

		this.guardClosing();
		this.app.workspace.onLayoutReady(() => {
			this.guardSaveCommand();
			this.excludeFromSearch();
			this.refresh();
			void this.discardBlankLeftovers();
		});
		this.registerEvent(this.app.workspace.on("layout-change", () => this.scheduleRefresh()));
		this.registerEvent(
			this.app.workspace.on("file-open", (file) => {
				if (file && !isDraft(file)) this.lastNotePath = file.path;
				this.scheduleRefresh();
			}),
		);
		// A folder rename reports every file in it; one refresh does for the lot.
		this.registerEvent(this.app.vault.on("rename", () => this.scheduleRefresh()));
	}

	onunload(): void {
		// The patched detach and save stay in place if something wrapped them after us; this
		// makes them pass straight through to Obsidian's own.
		this.unloaded = true;
		if (this.refreshFrame !== null) cancelAnimationFrame(this.refreshFrame);
		// Every leaf, so pop-out windows are put back too.
		this.app.workspace.iterateAllLeaves((leaf) => {
			this.markTab(leaf, false);
			leaf.view.containerEl.removeClass(DRAFT_CLS);
			leaf.view.containerEl.style.removeProperty("--drafts-hint");
			leaf.view.containerEl.querySelectorAll(`.${NEW_DRAFT_BUTTON_CLS}`).forEach((el) => el.remove());
		});
	}

	private scheduleRefresh(): void {
		if (this.refreshFrame !== null) return;
		this.refreshFrame = requestAnimationFrame(() => {
			this.refreshFrame = null;
			this.refresh();
		});
	}

	/**
	 * Open a new draft, ready to type into: in a new tab of the main area — Obsidian's own
	 * "tab" fills an empty one there rather than adding another — or in the given one.
	 */
	async newDraft(into?: WorkspaceLeaf): Promise<void> {
		const file = await createDraft(this.app);
		const leaf = into ?? this.app.workspace.getLeaf("tab");
		await leaf.openFile(file, { active: true, state: { mode: "source" } });
		const view = leaf.view;
		if (view instanceof MarkdownView) view.editor.focus();
	}

	private activeDraft(): TFile | null {
		const file = this.app.workspace.getActiveViewOfType(MarkdownView)?.file ?? null;
		return file && isDraft(file) ? file : null;
	}

	/** Ask for a name and folder and move the draft there. The saved note, or null. */
	private async saveDraft(file: TFile): Promise<TFile | null> {
		if (this.saving) return null;
		this.saving = true;
		try {
			const folder = this.app.fileManager.getNewFileParent(this.lastNotePath);
			const usable = folder.path === DRAFTS_FOLDER ? this.app.vault.getRoot() : folder;
			return await saveDraftDialog(this.app, file, suggestName(await this.textOf(file)), usable);
		} finally {
			this.saving = false;
		}
	}

	/** What a draft holds right now: what its tab shows, which may be ahead of the disk. */
	private async textOf(file: TFile): Promise<string> {
		let text: string | null = null;
		this.app.workspace.iterateAllLeaves((leaf) => {
			if (text === null && leaf.view instanceof MarkdownView && leaf.view.file === file) {
				text = leaf.view.getViewData();
			}
		});
		return text ?? (await this.app.vault.read(file));
	}

	/**
	 * ⌘S in a draft saves it into the vault. Obsidian's "Save current file" is wrapped rather
	 * than the key caught, so it keeps whatever hotkey the command has; anywhere but a draft
	 * it does what it always did.
	 */
	private guardSaveCommand(): void {
		const command = (this.app as unknown as AppInternals).commands.commands[SAVE_COMMAND];
		const original = command?.checkCallback;
		if (!command || typeof original !== "function") return;
		const guarded = (checking: boolean): boolean | void => {
			const file = this.unloaded ? null : this.activeDraft();
			if (!file) return original.call(command, checking);
			if (!checking) void this.saveDraft(file);
			return true;
		};
		command.checkCallback = guarded;
		this.register(() => {
			if (command.checkCallback === guarded) command.checkCallback = original;
		});
	}

	/**
	 * Ask before a draft with something in it is closed. Every way of closing a tab — its ×,
	 * ⌘W, "Close others" — ends in the tab's `detach`, so that's where this waits for the
	 * answer, and only then closes it (or doesn't). Not asked: a blank draft, which is simply
	 * discarded, one still open in another tab, and one in a pop-out window, whose tabs are
	 * also detached when the window itself closes, when there'd be nothing left to cancel
	 * back to. Those are kept, like a draft left behind any other way.
	 */
	private guardClosing(): void {
		const proto = WorkspaceLeaf.prototype as unknown as { detach: (this: WorkspaceLeaf) => void };
		const original = proto.detach;
		const onDetach = (leaf: WorkspaceLeaf): void => {
			if (this.unloaded) {
				original.call(leaf);
				return;
			}
			if (this.confirming.has(leaf)) return;
			const file = this.draftToConfirm(leaf);
			if (!file) {
				original.call(leaf);
				return;
			}
			void this.confirmClose(leaf, file, () => original.call(leaf));
		};
		const guarded = function (this: WorkspaceLeaf): void {
			onDetach(this);
		};
		proto.detach = guarded;
		this.register(() => {
			if (proto.detach === guarded) proto.detach = original;
		});
	}

	private draftToConfirm(leaf: WorkspaceLeaf): TFile | null {
		const view = leaf.view;
		if (!(view instanceof MarkdownView)) return null;
		const file = view.file;
		if (!file || !isDraft(file)) return null;
		if (view.containerEl.doc !== document) return null;
		if (!view.getViewData().trim()) return null;
		let elsewhere = false;
		this.app.workspace.iterateAllLeaves((other) => {
			if (other !== leaf && other.view instanceof MarkdownView && other.view.file === file) elsewhere = true;
		});
		return elsewhere ? null : file;
	}

	private async confirmClose(leaf: WorkspaceLeaf, file: TFile, close: () => void): Promise<void> {
		this.confirming.add(leaf);
		try {
			const choice = await askToSave(this.app, file.basename);
			if (choice === "save") {
				if (await this.saveDraft(file)) close();
			} else if (choice === "discard") {
				this.settling.add(file.path);
				close();
				await this.app.fileManager.trashFile(file);
			}
		} finally {
			this.confirming.delete(leaf);
			window.setTimeout(() => this.settling.delete(file.path), 1000);
		}
	}

	/**
	 * Keep the draft views and empty tabs dressed, and catch a draft no tab shows any more —
	 * closed while blank, or replaced in its tab by another note. A blank one goes; one with
	 * text stays where it is and says how to get back to it.
	 */
	private refresh(): void {
		const open = new Set<string>();
		this.app.workspace.iterateAllLeaves((leaf) => {
			const view = leaf.view;
			const draft = view instanceof MarkdownView && isDraft(view.file);
			this.markTab(leaf, draft);
			if (view instanceof MarkdownView) {
				view.containerEl.toggleClass(DRAFT_CLS, draft);
				if (draft && view.file) {
					open.add(view.file.path);
					const hint = JSON.stringify(this.hint());
					// Only when it changes: this runs on every layout change and file open.
					if (view.containerEl.style.getPropertyValue("--drafts-hint") !== hint) {
						view.containerEl.style.setProperty("--drafts-hint", hint);
					}
				}
			} else if (view.getViewType() === "empty") {
				this.addNewDraftButton(leaf);
			}
		});
		for (const path of this.openDrafts) {
			if (!open.has(path) && !this.settling.has(path)) void this.leftBehind(path);
		}
		this.openDrafts = open;
	}

	/**
	 * A draft's tab carries a pencil where a pinned tab carries its pin — the tab header's
	 * status icons — so an unsaved draft is told apart from the notes beside it, as VS Code
	 * marks an unsaved editor's tab. It goes once the draft is saved into the vault.
	 */
	private markTab(leaf: WorkspaceLeaf, draft: boolean): void {
		const status = (leaf as unknown as { tabHeaderStatusContainerEl?: HTMLElement }).tabHeaderStatusContainerEl;
		if (!status) return;
		const mark = status.querySelector(`:scope > .${DRAFT_TAB_CLS}`);
		if (!draft) {
			mark?.remove();
			return;
		}
		if (mark) return;
		const icon = status.createDiv({
			cls: `workspace-tab-header-status-icon ${DRAFT_TAB_CLS}`,
			attr: { "aria-label": "Unsaved draft" },
		});
		setIcon(icon, "pencil-line");
	}

	private async leftBehind(path: string): Promise<void> {
		const file = this.app.vault.getFileByPath(path);
		if (!file || !isDraft(file)) return; // saved, so it's moved, or gone
		if (!(await this.app.vault.read(file)).trim()) {
			await this.app.fileManager.trashFile(file);
			return;
		}
		new Notice(`Draft “${file.basename}” is kept. “Open draft…” brings it back.`);
	}

	/** Blank drafts no tab shows, left over from an earlier session. */
	private async discardBlankLeftovers(): Promise<void> {
		for (const file of allDrafts(this.app)) {
			if (this.openDrafts.has(file.path)) continue;
			if (!(await this.app.vault.read(file)).trim()) await this.app.fileManager.trashFile(file);
		}
	}

	/** The faint line over an empty draft, as VS Code writes over an untitled file. */
	private hint(): string {
		const save = this.hotkeyOf(SAVE_COMMAND);
		return `Draft — start typing. ${save ? `${save} saves` : "“Save draft to the vault” saves"} it into the vault.`;
	}

	private hotkeyOf(id: string): string {
		return (this.app as unknown as AppInternals).hotkeyManager?.printHotkeyForCommand?.(id) ?? "";
	}

	/**
	 * "New draft" first among an empty tab's actions, as "New File…" heads VS Code's welcome
	 * page — the same pill as Obsidian's own "New note" beside it. Obsidian rebuilds the list
	 * each time the tab is emptied, so it's put back then.
	 */
	private addNewDraftButton(leaf: WorkspaceLeaf): void {
		const list = leaf.view.containerEl.querySelector<HTMLElement>(".empty-state-action-list");
		if (!list || list.querySelector(`.${NEW_DRAFT_BUTTON_CLS}`)) return;
		const button = list.createDiv({
			cls: `text-icon-button tappable mod-pill empty-state-action ${NEW_DRAFT_BUTTON_CLS}`,
			attr: { tabindex: "0", role: "button", "aria-label": "New draft" },
		});
		setIcon(button.createSpan({ cls: "text-button-icon" }), "file-plus");
		button.createSpan({ cls: "text-button-label", text: "New draft" });
		// Its shortcut, written the way Obsidian writes its own buttons' (which Quick Open
		// shows as key caps).
		const hotkey = this.hotkeyOf(NEW_DRAFT_COMMAND) || this.hotkeyOf(CLAUDIAN_NEW_COMMAND);
		if (hotkey && !Platform.isMobile) button.createSpan({ cls: "empty-state-hotkey", text: ` ${hotkey}` });
		list.prepend(button);
		button.addEventListener("click", () => void this.newDraft(leaf));
		button.addEventListener("keydown", (evt) => {
			if (evt.key !== "Enter" && evt.key !== " ") return;
			evt.preventDefault();
			void this.newDraft(leaf);
		});
	}

	/**
	 * Keep drafts out of search, the graph and link suggestions: Settings → Files and links →
	 * Excluded files. A draft still opens and edits like any note.
	 */
	private excludeFromSearch(): void {
		const vault = (this.app as unknown as AppInternals).vault;
		const filters = vault.getConfig?.("userIgnoreFilters");
		const list = Array.isArray(filters) ? filters.filter((f): f is string => typeof f === "string") : [];
		const pattern = `${DRAFTS_FOLDER}/`;
		if (!list.includes(pattern)) vault.setConfig?.("userIgnoreFilters", [...list, pattern]);
	}
}

/** "Open draft…": the drafts kept, most recently changed first. */
class DraftPicker extends FuzzySuggestModal<TFile> {
	constructor(
		app: App,
		private readonly drafts: TFile[],
	) {
		super(app);
		this.setPlaceholder("Open a draft");
	}

	getItems(): TFile[] {
		return this.drafts;
	}

	getItemText(file: TFile): string {
		return file.basename;
	}

	onChooseItem(file: TFile): void {
		void this.app.workspace.getLeaf("tab").openFile(file, { active: true });
	}
}
