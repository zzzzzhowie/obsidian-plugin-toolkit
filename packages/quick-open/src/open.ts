import { type App, MarkdownView, Platform, type TFile, type WorkspaceLeaf, type WorkspaceParent } from "obsidian";

/**
 * Opening a file the way VS Code's Go to File does.
 *
 * - Enter opens it in the active tab group: the tab it's already in if that group has one,
 *   otherwise a new tab — Quick Open never replaces the note you're looking at (VS Code
 *   doesn't use a preview editor for it either). An empty tab is used rather than adding one
 *   beside it.
 * - Open to the side puts it in the group to the right of the active one, creating that
 *   group when there is none.
 * - On a phone, where tabs live behind the tab switcher and a new one per file would pile
 *   up unseen, it goes to the tab that already has it, else into the current tab — as
 *   Obsidian's own switcher does there.
 */
export async function openFile(app: App, file: TFile, toSide: boolean, line?: number, column?: number): Promise<void> {
	const leaf = toSide ? sideLeaf(app, file) : mainLeaf(app, file);
	if (fileOf(leaf) !== file.path) await leaf.openFile(file);
	app.workspace.setActiveLeaf(leaf, { focus: true });
	if (line !== undefined) goToLine(leaf, line, column);
}

/** Put the cursor at `line` (1-based) and bring it into view; out-of-range lines clamp. */
export function goToLine(leaf: WorkspaceLeaf, line: number, column = 1): void {
	const view = leaf.view;
	if (!(view instanceof MarkdownView)) return;
	const editor = view.editor;
	const target = Math.min(Math.max(line, 1), editor.lineCount()) - 1;
	const ch = Math.min(Math.max(column, 1) - 1, editor.getLine(target).length);
	if (view.getMode() === "source") {
		editor.setCursor({ line: target, ch });
		editor.scrollIntoView({ from: { line: target, ch }, to: { line: target, ch } }, true);
	} else {
		view.setEphemeralState({ line: target });
	}
}

function mainLeaf(app: App, file: TFile): WorkspaceLeaf {
	if (Platform.isPhone) {
		const open: WorkspaceLeaf[] = [];
		app.workspace.iterateRootLeaves((leaf) => {
			if (fileOf(leaf) === file.path) open.push(leaf);
		});
		return open[0] ?? app.workspace.getLeaf(false);
	}
	const active = app.workspace.getMostRecentLeaf(app.workspace.rootSplit);
	const group = active?.parent ?? null;
	const existing = group ? leavesIn(app, group).find((leaf) => fileOf(leaf) === file.path) : undefined;
	if (existing) return existing;
	if (active && active.getViewState().type === "empty") return active;
	return app.workspace.getLeaf("tab");
}

function sideLeaf(app: App, file: TFile): WorkspaceLeaf {
	const active = app.workspace.getMostRecentLeaf(app.workspace.rootSplit);
	const group = active ? groupToTheRight(app, active.parent) : null;
	if (!group) return app.workspace.getLeaf("split", "vertical");
	const existing = leavesIn(app, group).find((leaf) => fileOf(leaf) === file.path);
	if (existing) return existing;
	const empty = leavesIn(app, group).find((leaf) => leaf.getViewState().type === "empty");
	if (empty) return empty;
	// Typed for splits, but tab groups are what Obsidian itself passes it.
	return app.workspace.createLeafInParent(group as unknown as Parameters<App["workspace"]["createLeafInParent"]>[0], groupSize(group));
}

/** The nearest tab group whose left edge is at or past `group`'s right edge, overlapping it vertically. */
function groupToTheRight(app: App, group: WorkspaceParent): WorkspaceParent | null {
	const from = elementOf(group)?.getBoundingClientRect();
	if (!from) return null;
	let best: WorkspaceParent | null = null;
	let bestDistance = Infinity;
	for (const candidate of groupsIn(app)) {
		if (candidate === group) continue;
		const rect = elementOf(candidate)?.getBoundingClientRect();
		if (!rect || rect.left < from.right - 1) continue;
		if (rect.bottom <= from.top || rect.top >= from.bottom) continue;
		const distance = rect.left - from.right;
		if (distance < bestDistance) {
			best = candidate;
			bestDistance = distance;
		}
	}
	return best;
}

function groupsIn(app: App): Set<WorkspaceParent> {
	const groups = new Set<WorkspaceParent>();
	app.workspace.iterateRootLeaves((leaf) => {
		groups.add(leaf.parent);
	});
	return groups;
}

function leavesIn(app: App, group: WorkspaceParent): WorkspaceLeaf[] {
	const leaves: WorkspaceLeaf[] = [];
	app.workspace.iterateRootLeaves((leaf) => {
		if (leaf.parent === group) leaves.push(leaf);
	});
	return leaves;
}

/** The file a leaf shows — from its view state, so tabs not yet loaded count too. */
function fileOf(leaf: WorkspaceLeaf): string | undefined {
	const file: unknown = leaf.getViewState().state?.file;
	return typeof file === "string" ? file : undefined;
}

function elementOf(group: WorkspaceParent): HTMLElement | undefined {
	return (group as unknown as { containerEl?: HTMLElement }).containerEl;
}

function groupSize(group: WorkspaceParent): number {
	return (group as unknown as { children?: unknown[] }).children?.length ?? 0;
}
