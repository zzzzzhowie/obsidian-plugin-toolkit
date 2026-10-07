import type { App, WorkspaceLeaf } from "obsidian";

/**
 * A tab already showing `path` in `win`'s main area, or null — where a request to open the
 * file should land instead of opening it a second time.
 *
 * Main area only: a file open in a sidebar (or in a hover popover) is not a tab you can be
 * sent to. And one window only: with several open they are separate workspaces, and being
 * yanked across to another costs more than the extra tab saves. The first match wins; with
 * the same file open twice, either is a correct place to land.
 *
 * Read through the leaf's view state, not `leaf.view.file`. Obsidian doesn't build the view
 * of a tab that isn't showing — a background tab holds a placeholder (`leaf.isDeferred`)
 * whose only members are the view type, title and saved state, with no `file` at all. Those
 * are precisely the tabs worth finding, so asking the view would miss every one of them.
 * The state's `file` is a vault-relative path, and every file-backed view records it — so a
 * PDF, an image or a canvas tab counts too.
 */
export function tabShowing(app: App, path: string, win: Window): WorkspaceLeaf | null {
	const { leftSplit, rightSplit } = app.workspace;
	const matches: WorkspaceLeaf[] = [];
	app.workspace.iterateAllLeaves((leaf) => {
		const root = leaf.getRoot();
		if (root === leftSplit || root === rightSplit) return;
		if (leaf.getContainer().win !== win) return;
		if (leaf.getViewState().state?.file === path) matches.push(leaf);
	});
	return matches[0] ?? null;
}

/**
 * Go to `leaf`. `revealLeaf` brings the tab to the front of its group (building it, if it
 * was a background tab) and its window forward; `setActiveLeaf` is what actually moves
 * focus into it, once the reveal has settled.
 *
 * Not `async`: compiled for ES6 that needs tslib's helpers, and this folder sits outside
 * every package's node_modules.
 */
export function activateTab(app: App, leaf: WorkspaceLeaf): Promise<void> {
	return app.workspace.revealLeaf(leaf).then(() => {
		app.workspace.setActiveLeaf(leaf, { focus: true });
	});
}
