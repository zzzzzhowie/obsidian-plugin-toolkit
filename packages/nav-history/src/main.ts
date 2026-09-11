import {
	MarkdownView,
	Notice,
	Plugin,
	TAbstractFile,
	TFile,
	WorkspaceLeaf,
	WorkspaceParent,
	WorkspaceSplit,
} from "obsidian";
import { EditorView } from "@codemirror/view";
import {
	DEFAULT_SETTINGS,
	NavHistorySettingTab,
	NavHistorySettings,
} from "./settings";

/** Where a tab was sitting, so a closed one can be put back the same way. */
interface TabPlacement {
	/** Internal WorkspaceLeaf id, so we can go back into the same tab. */
	leafId: string | null;
	/** Internal id of the tab group holding it. */
	parentId: string | null;
	/** Position within that group, -1 when unknown. */
	tabIndex: number;
}

/** One remembered spot: a file plus the caret position and the tab it was in. */
interface NavLocation extends TabPlacement {
	path: string;
	line: number;
	ch: number;
}

/** `id` exists on every leaf at runtime but is not in the public typings. */
type LeafWithId = WorkspaceLeaf & { id?: string };

/** Same for a tab group's id and its ordered list of tabs. */
type ParentInternals = WorkspaceParent & { id?: string; children?: unknown[] };

const NO_PLACEMENT: TabPlacement = { leafId: null, parentId: null, tabIndex: -1 };

/**
 * Obsidian's built-in `app:go-back` walks a per-leaf history: each tab has its
 * own stack, so it can never take you back to a file you left in a different
 * tab. This plugin keeps ONE stack for the whole workspace — the VS Code model
 * behind Ctrl+- / Ctrl+Shift+-.
 */
export default class NavHistoryPlugin extends Plugin {
	settings: NavHistorySettings = DEFAULT_SETTINGS;

	private backStack: NavLocation[] = [];
	private forwardStack: NavLocation[] = [];
	/** Where we are now. Not on either stack until we navigate away from it. */
	private current: NavLocation | null = null;
	/**
	 * Set while WE are moving the caret, so the file-open and selection
	 * listeners don't record our own replay as fresh user navigation.
	 */
	private navigating = false;
	private navigatingTimer: number | null = null;

	async onload() {
		await this.loadSettings();
		this.addSettingTab(new NavHistorySettingTab(this.app, this));

		// The workspace is still empty during onload — seed the starting
		// location once the initial tabs have been restored.
		this.app.workspace.onLayoutReady(() => {
			this.current = this.snapshotActive();
		});

		this.registerEvent(
			this.app.workspace.on("file-open", (file) => {
				this.onFileOpen(file);
			})
		);

		// Switching to a tab that already shows the current file fires no
		// file-open, but it does change which tab a later "go back" should
		// return to — keep the leaf id fresh.
		this.registerEvent(
			this.app.workspace.on("active-leaf-change", (leaf) => {
				if (this.navigating || !this.current || !leaf) return;
				const view = leaf.view;
				if (view instanceof MarkdownView && view.file?.path === this.current.path) {
					Object.assign(this.current, this.placementOf(leaf));
				}
			})
		);

		// Caret tracking. Every selection change updates the current location in
		// place; only moves past the threshold split off a new history entry.
		this.registerEditorExtension(
			EditorView.updateListener.of((update) => {
				if (update.selectionSet || update.docChanged) {
					this.onSelectionChange();
				}
			})
		);

		this.registerEvent(
			this.app.vault.on("rename", (file, oldPath) => {
				this.onRename(file, oldPath);
			})
		);
		this.registerEvent(
			this.app.vault.on("delete", (file) => {
				this.onDelete(file);
			})
		);

		this.addCommand({
			id: "go-back",
			name: "Go back",
			icon: "arrow-left",
			hotkeys: [{ modifiers: ["Ctrl"], key: "-" }],
			callback: () => {
				void this.goBack();
			},
		});

		this.addCommand({
			id: "go-forward",
			name: "Go forward",
			icon: "arrow-right",
			hotkeys: [{ modifiers: ["Ctrl", "Shift"], key: "-" }],
			callback: () => {
				void this.goForward();
			},
		});

		this.addCommand({
			id: "clear-history",
			name: "Clear navigation history",
			callback: () => {
				this.clearHistory();
			},
		});
	}

	onunload() {
		if (this.navigatingTimer !== null) {
			window.clearTimeout(this.navigatingTimer);
		}
	}

	// ── recording ────────────────────────────────────────────────────────────

	private onFileOpen(file: TFile | null) {
		if (this.navigating || !file) return;

		const placement = this.placementOf(this.activeMarkdownLeaf());
		const previous = this.current;

		// Re-opening the same file (e.g. a second tab on it) is not a jump.
		if (previous && previous.path === file.path) {
			Object.assign(previous, placement);
			return;
		}

		if (previous) this.pushBack(previous);
		// Any fresh navigation invalidates the redo branch, exactly as VS Code
		// (and every browser) does.
		this.forwardStack = [];

		const cursor = this.activeCursor();
		this.current = {
			path: file.path,
			line: cursor?.line ?? 0,
			ch: cursor?.ch ?? 0,
			...placement,
		};
	}

	private onSelectionChange() {
		if (this.navigating) return;

		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		const file = view?.file;
		if (!view || !file) return;

		const cursor = view.editor.getCursor();
		const placement = this.placementOf(view.leaf);
		const previous = this.current;

		// file-open normally gets here first; this is the fallback for the very
		// first editor of the session.
		if (!previous || previous.path !== file.path) {
			this.current = { path: file.path, line: cursor.line, ch: cursor.ch, ...placement };
			return;
		}

		if (Math.abs(cursor.line - previous.line) >= this.settings.jumpThreshold) {
			this.pushBack({ ...previous });
			this.forwardStack = [];
		}

		previous.line = cursor.line;
		previous.ch = cursor.ch;
		Object.assign(previous, placement);
	}

	private pushBack(location: NavLocation) {
		const top = this.backStack[this.backStack.length - 1];
		// Collapse near-duplicates so repeated small hops in one file don't
		// require ten presses to escape.
		if (
			top &&
			top.path === location.path &&
			Math.abs(top.line - location.line) < this.settings.jumpThreshold
		) {
			this.backStack[this.backStack.length - 1] = location;
			return;
		}
		this.backStack.push(location);
		this.trimHistory();
	}

	trimHistory() {
		const overflow = this.backStack.length - this.settings.maxEntries;
		if (overflow > 0) this.backStack.splice(0, overflow);
	}

	clearHistory() {
		this.backStack = [];
		this.forwardStack = [];
		this.current = this.snapshotActive();
		new Notice("Navigation history cleared");
	}

	// ── navigating ───────────────────────────────────────────────────────────

	/**
	 * Both ends of the history are a silent no-op — hitting the bottom of the
	 * stack is the normal way to find out you are at the bottom, and a notice
	 * on every extra keypress is just noise.
	 */
	private async goBack() {
		const target = this.takeResolvable(this.backStack);
		if (!target) return;
		if (this.current) this.forwardStack.push(this.current);
		await this.jumpTo(target.location, target.file);
	}

	private async goForward() {
		const target = this.takeResolvable(this.forwardStack);
		if (!target) return;
		if (this.current) this.backStack.push(this.current);
		await this.jumpTo(target.location, target.file);
	}

	/**
	 * Pop until we hit a location whose file still exists, discarding the dead
	 * ones on the way. Without this, a since-deleted note turns into a keypress
	 * that visibly does nothing.
	 */
	private takeResolvable(
		stack: NavLocation[]
	): { location: NavLocation; file: TFile } | null {
		for (;;) {
			const location = stack.pop();
			if (!location) return null;
			const file = this.app.vault.getFileByPath(location.path);
			if (file) return { location, file };
		}
	}

	private async jumpTo(location: NavLocation, file: TFile) {
		this.beginNavigation();
		try {
			const leaf = this.resolveLeaf(location);
			const cursor = { line: location.line, ch: location.ch };
			const view = leaf.view;
			const alreadyOpen = view instanceof MarkdownView && view.file?.path === location.path;

			if (!alreadyOpen) {
				await leaf.openFile(file, {
					active: true,
					eState: { line: location.line, cursor: { from: cursor, to: cursor } },
				});
			}

			this.app.workspace.setActiveLeaf(leaf, { focus: true });

			const target = leaf.view;
			if (target instanceof MarkdownView) {
				const editor = target.editor;
				// Clamp: the file may have shrunk since we recorded the spot.
				const line = Math.min(location.line, Math.max(editor.lastLine(), 0));
				const ch = Math.min(location.ch, editor.getLine(line)?.length ?? 0);
				editor.setCursor({ line, ch });
				editor.scrollIntoView({ from: { line, ch }, to: { line, ch } }, true);
				editor.focus();
			}

			// Record where we actually ended up: a reopened tab has a brand-new
			// leaf id, and keeping the dead one would spawn another tab on the
			// next press.
			this.current = { ...location, ...this.placementOf(leaf) };
		} finally {
			this.endNavigation();
		}
	}

	/** Which tab to replay a location in. */
	private resolveLeaf(location: NavLocation): WorkspaceLeaf {
		// The user opted out of tab juggling: everything happens right here.
		if (!this.settings.reuseOriginalTab) return this.currentLeaf();

		// Guard the null id: without it, an unidentified leaf would match an
		// unidentified location and we'd hijack an arbitrary tab.
		const original = location.leafId
			? this.findLeaf((leaf) => this.leafId(leaf) === location.leafId)
			: null;
		if (original) return original;

		// The tab is gone. Taking over whichever tab happens to be focused would
		// destroy the thing the user is looking at, so put the closed tab back
		// instead — VS Code reopens the editor you closed.
		if (!this.settings.restoreClosedTabs) return this.currentLeaf();

		// Unless the file picked up another tab in the meantime; a second tab on
		// one note is never what anyone wants.
		const elsewhere = this.findLeaf(
			(leaf) => leaf.view instanceof MarkdownView && leaf.view.file?.path === location.path
		);
		if (elsewhere) return elsewhere;

		return this.reopenTab(location);
	}

	/**
	 * Recreate a closed tab where it used to live: same tab group, same slot in
	 * the tab bar. Falls back to a plain new tab once the whole group is gone.
	 */
	private reopenTab(location: NavLocation): WorkspaceLeaf {
		const group = this.findTabGroup(location.parentId);
		if (!group) return this.app.workspace.getLeaf("tab");

		const size = group.children?.length ?? 0;
		const index = location.tabIndex < 0 ? size : Math.min(location.tabIndex, size);
		// WorkspaceTabs is the runtime type here; the signature only names its
		// WorkspaceSplit sibling, which is the same shape as far as this call goes.
		return this.app.workspace.createLeafInParent(group as WorkspaceSplit, index);
	}

	private findLeaf(predicate: (leaf: WorkspaceLeaf) => boolean): WorkspaceLeaf | null {
		const matches: WorkspaceLeaf[] = [];
		this.app.workspace.iterateAllLeaves((leaf) => {
			if (this.isMainAreaLeaf(leaf) && predicate(leaf)) matches.push(leaf);
		});
		return matches[0] ?? null;
	}

	/** A tab group only exists as long as one of its tabs does. */
	private findTabGroup(parentId: string | null): ParentInternals | null {
		if (!parentId) return null;
		const matches: ParentInternals[] = [];
		this.app.workspace.iterateAllLeaves((leaf) => {
			const parent: ParentInternals | undefined = leaf.parent;
			if (parent && parent.id === parentId && this.isMainAreaLeaf(leaf)) {
				matches.push(parent);
			}
		});
		return matches[0] ?? null;
	}

	private currentLeaf(): WorkspaceLeaf {
		return this.activeMarkdownLeaf() ?? this.app.workspace.getLeaf(false);
	}

	private beginNavigation() {
		if (this.navigatingTimer !== null) window.clearTimeout(this.navigatingTimer);
		this.navigating = true;
	}

	/**
	 * The editor mounts asynchronously, so its first selection update lands
	 * after `jumpTo` has already returned — hold the guard open a beat longer.
	 */
	private endNavigation() {
		if (this.navigatingTimer !== null) window.clearTimeout(this.navigatingTimer);
		this.navigatingTimer = window.setTimeout(() => {
			this.navigating = false;
			this.navigatingTimer = null;
		}, 150);
	}

	// ── vault bookkeeping ────────────────────────────────────────────────────

	private onRename(file: TAbstractFile, oldPath: string) {
		for (const location of this.allLocations()) {
			if (location.path === oldPath) {
				location.path = file.path;
			} else if (location.path.startsWith(`${oldPath}/`)) {
				// A renamed folder takes every file under it along.
				location.path = file.path + location.path.slice(oldPath.length);
			}
		}
	}

	private onDelete(file: TAbstractFile) {
		const gone = (path: string) => path === file.path || path.startsWith(`${file.path}/`);
		this.backStack = this.backStack.filter((location) => !gone(location.path));
		this.forwardStack = this.forwardStack.filter((location) => !gone(location.path));
		if (this.current && gone(this.current.path)) this.current = null;
	}

	private allLocations(): NavLocation[] {
		const locations = [...this.backStack, ...this.forwardStack];
		if (this.current) locations.push(this.current);
		return locations;
	}

	// ── helpers ──────────────────────────────────────────────────────────────

	private snapshotActive(): NavLocation | null {
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		const file = view?.file;
		if (!view || !file) return null;
		const cursor = view.editor.getCursor();
		return {
			path: file.path,
			line: cursor.line,
			ch: cursor.ch,
			...this.placementOf(view.leaf),
		};
	}

	private activeMarkdownLeaf(): WorkspaceLeaf | null {
		return this.app.workspace.getActiveViewOfType(MarkdownView)?.leaf ?? null;
	}

	private activeCursor(): { line: number; ch: number } | null {
		return this.app.workspace.getActiveViewOfType(MarkdownView)?.editor.getCursor() ?? null;
	}

	private leafId(leaf: WorkspaceLeaf | null): string | null {
		return (leaf as LeafWithId | null)?.id ?? null;
	}

	/** Snapshot of which tab a leaf is, and where that tab sits. */
	private placementOf(leaf: WorkspaceLeaf | null): TabPlacement {
		if (!leaf) return NO_PLACEMENT;
		const parent: ParentInternals | undefined = leaf.parent;
		return {
			leafId: this.leafId(leaf),
			parentId: parent?.id ?? null,
			tabIndex: parent?.children?.indexOf(leaf) ?? -1,
		};
	}

	/** Sidebar leaves are not somewhere a "go back" should ever land. */
	private isMainAreaLeaf(leaf: WorkspaceLeaf): boolean {
		return leaf.getRoot() === this.app.workspace.rootSplit;
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}
