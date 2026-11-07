import type { App } from "obsidian";

/**
 * A sidebar folded while something wants the window's width, put back as it was once nothing
 * does: a drawing in front (Excalidraw (Enhanced)), a Claudian chat open as a tab (Claudian
 * (Enhanced)). Plugins hold a side by name; the state before the first hold is what the last
 * release puts back. Kept on `window`, not in this module: each plugin bundles its own copy,
 * and two copies each keeping their own "before" undid each other — from a drawing to a chat,
 * one put the sidebar back as the other folded it, and the chat had it open.
 */
type Side = "left" | "right";

interface Hold {
	/** Whether the side was folded before the first hold. */
	before: boolean;
	holders: Set<string>;
}

const KEY = "__yeyanSidebarFold";

function holds(): Record<Side, Hold | null> {
	const host = window as unknown as Record<string, Record<Side, Hold | null> | undefined>;
	return (host[KEY] ??= { left: null, right: null });
}

function splitOf(app: App, side: Side): { collapsed: boolean; collapse(): void; expand(): void } {
	return side === "left" ? app.workspace.leftSplit : app.workspace.rightSplit;
}

/** Fold `side` for `owner`, noting how it was if nobody held it yet. */
export function holdFolded(app: App, side: Side, owner: string): void {
	const split = splitOf(app, side);
	const all = holds();
	const hold = (all[side] ??= { before: split.collapsed, holders: new Set() });
	if (hold.holders.has(owner)) return;
	hold.holders.add(owner);
	if (!split.collapsed) split.collapse();
}

/** Let go of `side` for `owner`; the last one out puts it back as it was. */
export function releaseFolded(app: App, side: Side, owner: string): void {
	const all = holds();
	const hold = all[side];
	if (!hold?.holders.delete(owner) || hold.holders.size > 0) return;
	all[side] = null;
	const split = splitOf(app, side);
	if (hold.before === split.collapsed) return;
	if (hold.before) split.collapse();
	else split.expand();
}
