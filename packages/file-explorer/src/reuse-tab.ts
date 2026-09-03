import { App, Keymap, Plugin, WorkspaceLeaf } from "obsidian";

// Click a file that is already open and go to that tab, instead of opening a second copy of
// it. Both ways of asking are covered: a bare click, which would otherwise load the file over
// whatever the current tab was showing, and Mod-click or a middle click, which would open a
// duplicate tab.
//
// Obsidian's own row handler is `onSelfClick`, which ends in
// `workspace.getLeaf(Keymap.isModEvent(e)).openFile(file)` — with the modifier held
// `getLeaf` always builds a new leaf, so the same note can be opened any number of times.
//
// The gesture is taken over rather than the result cleaned up afterwards: opening the tab
// and then closing it flashes a tab, moves focus twice and pushes the closed leaf through
// history. Obsidian attaches that handler twice, once per way of asking for a tab:
//   click    e => 0 !== e.button || e.defaultPrevented || this.onSelfClick(e)
//   auxclick e => 1 !== e.button || e.defaultPrevented || this.onSelfClick(e)
// so a `preventDefault()` from the capture phase is its own documented opt-out — no need to
// stop propagation and silence unrelated listeners. Both are listened for: a middle click
// arrives as `auxclick`, and it opens a tab just as much as Mod-click does.

/** Only rows inside the tree, and only files: folders carry `nav-folder-title`. */
const FILE_ROW = ".nav-file-title";
const FILE_EXPLORER = '.workspace-leaf-content[data-type="file-explorer"]';

export function registerReuseTab(plugin: Plugin): void {
	const onClick = (evt: MouseEvent): void => {
		// Left and middle only: `auxclick` also fires for the right button, and Mod plus
		// a right click would otherwise read as a tab request while the context menu opens.
		if ((evt.button !== 0 && evt.button !== 1) || evt.defaultPrevented) return;
		// `isModEvent` speaks in panes: a middle click and Mod alone are both "tab",
		// Mod+Alt is "split" and Mod+Alt+Shift is "window". Those last two asked for a
		// new pane deliberately, so they are left alone; `false` is a bare click.
		const pane = Keymap.isModEvent(evt);
		if (pane !== "tab" && pane !== false) return;
		// A bare click has to be bare. Alt and Shift are the file explorer's own
		// multi-select gestures and Ctrl-click on macOS opens the context menu — none of
		// them are a request to open anything, so they keep their meaning.
		if (
			pane === false &&
			(evt.altKey || evt.shiftKey || evt.ctrlKey || evt.metaKey)
		) {
			return;
		}

		const row = (evt.target as HTMLElement | null)?.closest(FILE_ROW);
		if (!row?.closest(FILE_EXPLORER)) return;
		// A row being renamed holds an input; swallowing that click would stop the caret
		// from landing where it was clicked. Obsidian bows out of the same case.
		if (row.classList.contains("is-being-renamed")) return;
		const path = row.getAttribute("data-path");
		if (!path) return;

		const open = leafShowing(plugin.app, path);
		// Not open anywhere: leave the gesture alone and let Obsidian open the tab it
		// would have opened.
		if (!open) return;
		// A bare click on the file you are already in is Obsidian's own business — it
		// keeps focus in the tree and moves its keyboard-navigation position to the row.
		// Only a file sitting in some *other* tab is worth diverting, since that is the
		// click that would otherwise end up with the file open twice. Mod-click still
		// diverts either way: there, landing on the current tab is the whole point.
		if (pane === false && open === plugin.app.workspace.getMostRecentLeaf()) {
			return;
		}

		evt.preventDefault();
		activate(plugin.app, open);
	};

	for (const type of ["click", "auxclick"]) {
		plugin.registerDomEvent(document, type as "click", onClick, {
			capture: true,
		});
	}
}

/**
 * Go to the main-area tab already showing `path`; report whether there was one.
 *
 * The rule the file tree follows (above) is worth having at every entry point that can open
 * a tab, not just that one: asking for a new tab for a file that is already in one should
 * take you there instead of stacking a duplicate. The pinned list and the folder-note click
 * open files through their own handlers, which Obsidian's `defaultPrevented` opt-out can't
 * reach, so they consult this directly and skip their own open when it returns true.
 *
 * Only the new-tab gesture is diverted. A plain click still lands in the active tab, which
 * replaces what's there rather than adding anything.
 */
export function goToOpenTab(app: App, path: string): boolean {
	const open = leafShowing(app, path);
	if (!open) return false;
	activate(app, open);
	return true;
}

/**
 * A main-area tab already showing `path`, or null.
 *
 * Main area only — a file open in a sidebar (or in a hover popover) is not a tab the user
 * can be sent to. (`iterateRootLeaves` walks `rootSplit` only, so a popout's tabs are out of
 * reach as well — landing there would yank the user into another window.) The first match
 * wins; with the same file open twice, either is a correct place to land.
 *
 * Read through the leaf's view state, not `leaf.view.file`. Obsidian doesn't build the view
 * of a tab that isn't showing — a background tab holds a placeholder (`leaf.isDeferred`)
 * whose only members are the view type, title and saved state, with no `file` at all. Those
 * are precisely the tabs this gesture is for, so asking the view made the lookup miss every
 * one of them and the click fell through to Obsidian opening yet another tab.
 *
 * The state's `file` is a vault-relative path, and every file-backed view records it — so a
 * PDF, an image or a canvas tab counts too, same as before.
 */
function leafShowing(app: App, path: string): WorkspaceLeaf | null {
	const matches: WorkspaceLeaf[] = [];
	app.workspace.iterateRootLeaves((leaf) => {
		if (leaf.getViewState().state?.file === path) matches.push(leaf);
	});
	return matches[0] ?? null;
}

/**
 * `revealLeaf` brings the tab to the front of its group and its window forward;
 * `setActiveLeaf` is what actually moves focus into it, once the reveal has settled.
 */
function activate(app: App, leaf: WorkspaceLeaf): void {
	void app.workspace.revealLeaf(leaf).then(() => {
		app.workspace.setActiveLeaf(leaf, { focus: true });
	});
}
