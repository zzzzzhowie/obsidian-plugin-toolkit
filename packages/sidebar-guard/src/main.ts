import { Platform, Plugin, type TFile, View, type WorkspaceLeaf } from "obsidian";

/** Obsidian's own "Close current tab", Cmd/Ctrl+W by default. */
const CLOSE_COMMAND = "workspace:close";
/** Obsidian's own "Go to next tab" / "Go to previous tab": Ctrl+Tab, Cmd+Shift+] / [ by default. */
const NEXT_TAB_COMMAND = "workspace:next-tab";
const PREVIOUS_TAB_COMMAND = "workspace:previous-tab";

/** The one part of a registered command we wrap. */
interface Command {
	checkCallback?: (checking: boolean) => boolean | void;
}

/** `app.commands` is there at runtime but not in the public typings. */
interface AppWithCommands {
	commands: { commands: Record<string, Command | undefined> };
}

/** A tab group as it is at runtime: its tabs, which one is showing, and how to show another. */
interface TabGroup {
	children: WorkspaceLeaf[];
	currentTab: number;
	selectTabIndex(index: number): void;
}

/** A panel that shows the active note — Outline, Backlinks, Properties — as it is at runtime. */
interface NoteFollower {
	file?: TFile | null;
	isLeafBoundToFile?: boolean;
	onFileOpen?: (file: TFile | null) => void;
}

/** The workspace's own record of the active file, and its way of announcing a new one. */
interface WorkspaceInternals {
	lastActiveFile?: unknown;
	requestActiveLeafEvents?: () => void;
}

/**
 * Keep Cmd/Ctrl+W, and going to the next or previous tab, off the sidebar panels.
 *
 * Obsidian's "Close current tab" closes whichever tab is active, and a sidebar panel —
 * Claudian, Outline, Backlinks — is a tab like any other. Click into one and press Cmd+W
 * meaning the note you're reading, and the panel goes instead; the next panel in that
 * sidebar becomes the active tab, so a few presses empty the whole sidebar. "Undo close
 * tab" brings them back only behind whatever was closed after them, and only the last ten.
 *
 * So, as in VS Code, the key never closes a panel: with one active it closes your tab in
 * the main area instead. A note opened in a sidebar is a document, not a panel, and still
 * closes as before; a panel is still closed from its tab's menu.
 *
 * "Go to next tab" and "Go to previous tab" go round the active tab's group in the same way,
 * so with a panel active they flicked through the sidebar's panels rather than your notes.
 * With a panel active they now go round the tabs in the main area, as Ctrl+Tab does in VS Code.
 *
 * The commands are wrapped rather than the keys caught, so this follows whatever hotkeys
 * they have, and the command palette too.
 */
export default class SidebarGuardPlugin extends Plugin {
	onload(): void {
		this.app.workspace.onLayoutReady(() => {
			this.guard(CLOSE_COMMAND, (tab) => this.closeTab(tab));
			this.guard(NEXT_TAB_COMMAND, (tab) => this.goToTab(tab, 1));
			this.guard(PREVIOUS_TAB_COMMAND, (tab) => this.goToTab(tab, -1));
			this.syncNoteFollowers();
		});
		this.registerEvent(
			this.app.workspace.on("layout-change", () => {
				this.announceActiveFile();
				this.syncNoteFollowers();
			}),
		);
		this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.syncNoteFollowers()));
	}

	/**
	 * Put a sidebar panel that shows the active note back on it as it comes into view.
	 *
	 * A panel out of sight — Properties behind the Outline tab — isn't loaded, and hears no
	 * `file-open` until it is. Shown again, it comes back with the note it last had, from the
	 * saved layout, and only the next note opened puts it right: Properties showed a note from
	 * days before over an empty tab. Each panel in view that follows the active note is given
	 * the active one (none, for an empty tab) when it shows another. A panel pinned or linked to
	 * a tab follows that instead and is left be, as Obsidian leaves it.
	 */
	private syncNoteFollowers(): void {
		const { workspace } = this.app;
		const active = workspace.getActiveFile();
		workspace.iterateAllLeaves((leaf) => {
			const root = leaf.getRoot();
			if (root !== workspace.leftSplit && root !== workspace.rightSplit) return;
			const view = leaf.view as unknown as NoteFollower;
			if (typeof view.onFileOpen !== "function" || view.isLeafBoundToFile) return;
			if (!leaf.view.containerEl.isShown()) return;
			if ((view.file ?? null) !== active) view.onFileOpen(active);
		});
	}

	/**
	 * Tell the sidebar when the note it shows is closed from under it.
	 *
	 * Obsidian announces a new active file (`file-open`) only when the active tab changes. With a
	 * panel active — clicked into, or the one Cmd+W left active above — closing the note behind
	 * it changes no active tab, so nothing is announced: Outline, Backlinks, Outgoing links and
	 * the word count kept showing the closed note over an empty tab. When the file Obsidian
	 * last announced is no longer the active one, its own announcement is asked for again,
	 * so everything that follows the active file hears it the usual way.
	 */
	private announceActiveFile(): void {
		const workspace = this.app.workspace as unknown as WorkspaceInternals;
		if (!("lastActiveFile" in workspace) || typeof workspace.requestActiveLeafEvents !== "function") return;
		if (workspace.lastActiveFile !== this.app.workspace.getActiveFile()) workspace.requestActiveLeafEvents();
	}

	/**
	 * Wrap a command that acts on the active tab so that, with a panel active, it acts on your
	 * tab in the main area instead — the one you were last in.
	 */
	private guard(id: string, run: (tab: WorkspaceLeaf) => void): void {
		const command = (this.app as unknown as AppWithCommands).commands.commands[id];
		const original = command?.checkCallback;
		// A build that renamed or reshaped the command keeps its own behaviour.
		if (!command || typeof original !== "function") return;
		const guarded = (checking: boolean): boolean | void => {
			if (!this.activePanel()) return original.call(command, checking);
			const tab = this.app.workspace.getMostRecentLeaf(this.app.workspace.rootSplit);
			// Nothing in the main area to act on; the panel is left alone all the same.
			if (!tab) return false;
			if (!checking) run(tab);
			return true;
		};
		command.checkCallback = guarded;
		this.register(() => {
			if (command.checkCallback === guarded) command.checkCallback = original;
		});
	}

	/**
	 * The active tab, when it is a sidebar panel. A panel is a view that isn't for
	 * navigation — Obsidian's own flag for "don't open links over me", set on every panel
	 * (file explorer, search, outline, Claudian…) and on no document.
	 *
	 * Looked up as a View, not an ItemView: since Obsidian 1.14 the file explorer and search
	 * aren't ItemViews, so with either active the guard saw no panel, and going to the next
	 * or previous tab flicked between them instead of the notes.
	 */
	private activePanel(): WorkspaceLeaf | null {
		const view = this.app.workspace.getActiveViewOfType(View);
		if (!view || view.navigation) return null;
		const root = view.leaf.getRoot();
		const { leftSplit, rightSplit } = this.app.workspace;
		return root === leftSplit || root === rightSplit ? view.leaf : null;
	}

	/**
	 * Show the tab `step` along from `tab` in its group, round the ends, and make it active —
	 * what "Go to next tab" / "Go to previous tab" do in the active tab's group.
	 */
	private goToTab(tab: WorkspaceLeaf, step: 1 | -1): void {
		const group = tab.parent as unknown as Partial<TabGroup> | null;
		if (!group || !Array.isArray(group.children) || typeof group.selectTabIndex !== "function") return;
		const count = group.children.length;
		if (count === 0) return;
		const from = typeof group.currentTab === "number" ? group.currentTab : group.children.indexOf(tab);
		const index = (((from + step) % count) + count) % count;
		group.selectTabIndex(index);
		const next = group.children[index];
		if (next) this.app.workspace.setActiveLeaf(next, { focus: true });
	}

	/** Close a tab the way Obsidian's command does: a pinned one is unpinned first. */
	private closeTab(tab: WorkspaceLeaf): void {
		if (!Platform.isPhone && tab.getViewState().pinned) tab.setPinned(false);
		else tab.detach();
	}
}
