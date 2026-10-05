import { ItemView, Platform, Plugin, type WorkspaceLeaf } from "obsidian";

/** Obsidian's own "Close current tab", Cmd/Ctrl+W by default. */
const CLOSE_COMMAND = "workspace:close";

/** The one part of a registered command we wrap. */
interface Command {
	checkCallback?: (checking: boolean) => boolean | void;
}

/** `app.commands` is there at runtime but not in the public typings. */
interface AppWithCommands {
	commands: { commands: Record<string, Command | undefined> };
}

/**
 * Keep Cmd/Ctrl+W off the sidebar panels.
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
 * The command is wrapped rather than the key caught, so this follows whatever hotkey
 * "Close current tab" has, and the command palette too.
 */
export default class SidebarGuardPlugin extends Plugin {
	onload(): void {
		this.app.workspace.onLayoutReady(() => this.guardCloseCommand());
	}

	private guardCloseCommand(): void {
		const command = (this.app as unknown as AppWithCommands).commands.commands[CLOSE_COMMAND];
		const original = command?.checkCallback;
		// A build that renamed or reshaped the command keeps its own behaviour.
		if (!command || typeof original !== "function") return;
		const guarded = (checking: boolean): boolean | void => {
			if (!this.activePanel()) return original.call(command, checking);
			const tab = this.app.workspace.getMostRecentLeaf(this.app.workspace.rootSplit);
			// Nothing in the main area to close; the panel stays all the same.
			if (!tab) return false;
			if (!checking) this.closeTab(tab);
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
	 */
	private activePanel(): WorkspaceLeaf | null {
		const view = this.app.workspace.getActiveViewOfType(ItemView);
		if (!view || view.navigation) return null;
		const root = view.leaf.getRoot();
		const { leftSplit, rightSplit } = this.app.workspace;
		return root === leftSplit || root === rightSplit ? view.leaf : null;
	}

	/** Close a tab the way Obsidian's command does: a pinned one is unpinned first. */
	private closeTab(tab: WorkspaceLeaf): void {
		if (!Platform.isPhone && tab.getViewState().pinned) tab.setPinned(false);
		else tab.detach();
	}
}
