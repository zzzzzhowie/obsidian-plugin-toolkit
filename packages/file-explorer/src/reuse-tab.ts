import { App, Keymap, Plugin, WorkspaceLeaf } from "obsidian";

// Mod-click a file that is already open and go to that tab, instead of opening a second
// one for the same file.
//
// Obsidian's own row handler is `onSelfClick`, which ends in
// `workspace.getLeaf(Keymap.isModEvent(e)).openFile(file)` — with the modifier held
// `getLeaf` always builds a new leaf, so the same note can be opened any number of times.
//
// The gesture is taken over rather than the result cleaned up afterwards: opening the tab
// and then closing it flashes a tab, moves focus twice and pushes the closed leaf through
// history. Obsidian attaches that handler with
// `addEventListener("click", e => 0 !== e.button || e.defaultPrevented || this.onSelfClick(e))`,
// so a `preventDefault()` from the capture phase is its own documented opt-out — no need
// to stop propagation and silence unrelated listeners.

/** Only rows inside the tree, and only files: folders carry `nav-folder-title`. */
const FILE_ROW = ".nav-file-title";
const FILE_EXPLORER = '.workspace-leaf-content[data-type="file-explorer"]';

export function registerReuseTab(plugin: Plugin): void {
	plugin.registerDomEvent(
		document,
		"click",
		(evt: MouseEvent) => {
			if (evt.button !== 0 || evt.defaultPrevented) return;
			// Exactly the gesture that asks for a new tab. `isModEvent` speaks in panes:
			// Mod alone is "tab", Mod+Alt is "split" and Mod+Alt+Shift is "window" — the
			// latter two asked for a new pane deliberately, so they are left alone. (Its
			// other "tab" case, a middle click, arrives as `auxclick` and never reaches
			// this listener.)
			if (Keymap.isModEvent(evt) !== "tab") return;

			const row = (evt.target as HTMLElement | null)?.closest(FILE_ROW);
			if (!row?.closest(FILE_EXPLORER)) return;
			const path = row.getAttribute("data-path");
			if (!path) return;

			const open = leafShowing(plugin.app, path);
			// Not open anywhere: leave the gesture alone and let Obsidian open the tab it
			// would have opened.
			if (!open) return;

			evt.preventDefault();
			activate(plugin.app, open);
		},
		{ capture: true },
	);
}

/**
 * A main-area tab already showing `path`, or null.
 *
 * Main area only — a file open in a sidebar (or in a hover popover) is not a tab the user
 * can be sent to, and `iterateRootLeaves` covers popout windows as well as this one. The
 * first match wins; with the same file open twice, either is a correct place to land.
 *
 * `view.file` rather than a Markdown-only lookup, so a PDF, an image or a canvas tab
 * counts too.
 */
function leafShowing(app: App, path: string): WorkspaceLeaf | null {
	const matches: WorkspaceLeaf[] = [];
	app.workspace.iterateRootLeaves((leaf) => {
		const file = (leaf.view as unknown as { file?: { path?: string } }).file;
		if (file?.path === path) matches.push(leaf);
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
