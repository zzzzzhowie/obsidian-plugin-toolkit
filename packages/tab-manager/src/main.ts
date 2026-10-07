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
 */
export default class TabManagerPlugin extends Plugin {
	onload(): void {
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
