import { type OpenViewState, type PaneType, parseLinktext, Plugin, type WorkspaceLeaf } from "obsidian";

import { activateTab, tabShowing } from "../../../shared/open-tab";

/**
 * Follow a link to a note that's already open by going to its tab, instead of opening it again.
 *
 * The rule of the Chrome extension of the same name, for notes: a link to a file that is
 * already in a tab of this window takes you to that tab — a plain click as much as
 * Cmd/Ctrl-click or a middle click. A plain click would otherwise load the note over the one
 * you're reading, so it ends up open twice and the note you came from is gone from its tab;
 * the new-tab gestures would stack a duplicate. Going to the tab is what either one was
 * after, and the note you clicked from stays where it was.
 *
 * Taken over at `workspace.openLinkText`, the call every link goes through: clicks in the
 * editor and in reading view, Cmd/Ctrl-click and middle click, a link's "Open link" and
 * "Open in new tab", the graph. It runs before any tab is made — in Chrome a tab can only be
 * prevented by cancelling the click — so nothing flashes open and shut.
 *
 * Left to Obsidian:
 * - a split or a new window, which ask for a second copy on purpose;
 * - a link to the note it's written in (`[[#Heading]]`), which scrolls in place;
 * - a link to a note that doesn't exist yet, which creates it;
 * - a note open only in a sidebar or in another window — see `tabShowing`.
 *
 * And, as Chrome does, closing a tab you just opened takes you back to the tab you opened it
 * from — see `followActiveTab`.
 */
export default class TabManagerPlugin extends Plugin {
	/** Tabs that were on show before, so a tab's first showing can be told apart. */
	private readonly shown = new WeakSet<WorkspaceLeaf>();
	/** The main-area tab on show last; sidebars don't count. */
	private lastTab: WorkspaceLeaf | null = null;
	/** A tab just opened and the tab it was opened from, until the reader moves on. */
	private openedFrom: { tab: WorkspaceLeaf; opener: WorkspaceLeaf } | null = null;

	onload(): void {
		this.app.workspace.onLayoutReady(() => {
			this.app.workspace.iterateAllLeaves((leaf) => {
				this.shown.add(leaf);
			});
			this.lastTab = this.mainTab(this.app.workspace.getMostRecentLeaf());
			this.registerEvent(this.app.workspace.on("active-leaf-change", (leaf) => this.followActiveTab(leaf)));
		});

		const workspace = this.app.workspace;
		// eslint-disable-next-line @typescript-eslint/unbound-method -- called with the workspace below
		const original = workspace.openLinkText;
		const openLinkText = (
			linktext: string,
			sourcePath: string,
			newLeaf?: PaneType | boolean,
			openViewState?: OpenViewState,
		): Promise<void> => {
			const tab = this.tabFor(linktext, sourcePath, newLeaf);
			if (!tab) return original.call(workspace, linktext, sourcePath, newLeaf, openViewState);
			return this.goTo(tab, linktext, openViewState);
		};
		workspace.openLinkText = openLinkText;
		this.register(() => {
			if (workspace.openLinkText === openLinkText) workspace.openLinkText = original;
		});
	}

	/**
	 * Remember where a new tab was opened from, and go back there when it's closed. Obsidian
	 * shows the closed tab's neighbour instead — for a tab opened beside the one you were
	 * reading, the tab after that one. Chrome's rule: the way back holds only while you stay
	 * on the new tab; going to any other tab first ends it, and closing then is left to
	 * Obsidian. A tab is new on its first showing, however it was made — a Cmd/Ctrl-click, a
	 * link from Claudian, ⌘T.
	 */
	private followActiveTab(active: WorkspaceLeaf | null): void {
		const leaf = this.mainTab(active);
		if (!leaf) return;
		const relation = this.openedFrom;
		if (relation && relation.tab !== leaf) {
			this.openedFrom = null;
			// Shown because the new tab was closed: the tab it came from instead.
			if (relation.opener !== leaf && !this.isOpen(relation.tab) && this.isOpen(relation.opener)) {
				void activateTab(this.app, relation.opener);
				return;
			}
		}
		if (!this.shown.has(leaf)) {
			this.shown.add(leaf);
			const from = this.lastTab;
			if (from && from !== leaf && from.getContainer() === leaf.getContainer() && this.isOpen(from)) {
				this.openedFrom = { tab: leaf, opener: from };
			}
		}
		this.lastTab = leaf;
	}

	/** `leaf` when it's a tab of the main area (or of a pop-out window), else null. */
	private mainTab(leaf: WorkspaceLeaf | null): WorkspaceLeaf | null {
		if (!leaf) return null;
		const root = leaf.getRoot();
		const { leftSplit, rightSplit } = this.app.workspace;
		return root === leftSplit || root === rightSplit ? null : leaf;
	}

	/** Whether `leaf` is still in the workspace — not closed. */
	private isOpen(leaf: WorkspaceLeaf): boolean {
		let found = false;
		this.app.workspace.iterateAllLeaves((each) => {
			if (each === leaf) found = true;
		});
		return found;
	}

	/** The tab to go to instead of opening the link, or null to let Obsidian open it. */
	private tabFor(linktext: string, sourcePath: string, newLeaf?: PaneType | boolean): WorkspaceLeaf | null {
		if (newLeaf === "split" || newLeaf === "window") return null;
		const { path } = parseLinktext(linktext);
		const file = this.app.metadataCache.getFirstLinkpathDest(path, sourcePath);
		if (!file || file.path === sourcePath) return null;
		return tabShowing(this.app, file.path, activeWindow);
	}

	/**
	 * Go to the tab, then to the heading or block the link names — the part of opening the
	 * link that still applies. Handed over as the tab's ephemeral state, as Obsidian does when
	 * it opens a link in a tab already showing the file: it scrolls without reloading.
	 */
	private async goTo(tab: WorkspaceLeaf, linktext: string, openViewState?: OpenViewState): Promise<void> {
		await activateTab(this.app, tab);
		const { subpath } = parseLinktext(linktext);
		const eState: Record<string, unknown> = { ...openViewState?.eState };
		if (subpath) eState.subpath = subpath;
		if (Object.keys(eState).length > 0) tab.setEphemeralState(eState);
	}
}
