import type { Plugin, WorkspaceLeaf } from "obsidian";

/**
 * Drawings opened by Excalidraw's CLI stay in the background.
 *
 * Claude draws through Excalidraw's own CLI (`obsidian obsidian-excalidraw-plugin:open/read/
 * apply…`), and an edit needs the drawing open: its `open` makes a tab for it, opens it there
 * as the active tab and reveals it — whoever was reading a note, or the chat, was taken to the
 * drawing mid-reply. While one of its commands runs, the drawing's tab is made but neither made
 * active nor brought forward: it loads as it would, and the CLI goes on with it, behind the tab
 * that was in front. Opening a drawing yourself doesn't go through the CLI and is left alone.
 */

/** The prefix of Excalidraw's CLI commands. */
const EXCALIDRAW_CLI = "obsidian-excalidraw-plugin:";

interface CliEntry {
	handler: (...args: unknown[]) => unknown;
}

interface AppWithCli {
	cli?: { handlers?: Map<string, CliEntry> };
}

type SetActiveLeaf = (leaf: WorkspaceLeaf, ...rest: unknown[]) => void;
type RevealLeaf = (leaf: WorkspaceLeaf) => Promise<void>;

export class CliBackground {
	/** How many of Excalidraw's CLI commands are running now. */
	private running = 0;
	/** The handlers wrapped, with what they were; put back on unload. */
	private readonly wrapped = new Map<CliEntry, CliEntry["handler"]>();

	constructor(private readonly plugin: Plugin) {}

	register(): void {
		const { plugin } = this;
		// What brings the drawing's tab forward, held back while a command runs and only for that
		// tab: the new tab made active as it's made (`getLeaf("tab")`), the drawing revealed, and
		// made active again as Excalidraw focuses its canvas.
		const running = (): boolean => this.running > 0;
		const theDrawing = (leaf: WorkspaceLeaf | null): boolean => {
			const type = leaf?.view?.getViewType();
			return type === "excalidraw" || type === "empty";
		};
		const workspace = plugin.app.workspace as unknown as { setActiveLeaf: SetActiveLeaf; revealLeaf: RevealLeaf };
		const setActiveLeaf = workspace.setActiveLeaf;
		workspace.setActiveLeaf = function (this: unknown, leaf: WorkspaceLeaf, ...rest: unknown[]) {
			if (running() && theDrawing(leaf)) return;
			return setActiveLeaf.call(this, leaf, ...rest);
		};
		const revealLeaf = workspace.revealLeaf;
		workspace.revealLeaf = function (this: unknown, leaf: WorkspaceLeaf) {
			if (running() && theDrawing(leaf)) return Promise.resolve();
			return revealLeaf.call(this, leaf);
		};
		plugin.register(() => {
			if (workspace.setActiveLeaf !== setActiveLeaf) workspace.setActiveLeaf = setActiveLeaf;
			if (workspace.revealLeaf !== revealLeaf) workspace.revealLeaf = revealLeaf;
			for (const [entry, handler] of this.wrapped) entry.handler = handler;
			this.wrapped.clear();
		});
		// Excalidraw registers its commands as it loads, after this maybe, and again if it's
		// reloaded: they're looked for whenever the layout settles.
		plugin.app.workspace.onLayoutReady(() => this.wrap());
		plugin.registerEvent(plugin.app.workspace.on("layout-change", () => this.wrap()));
	}

	/** Wrap each of Excalidraw's CLI handlers not wrapped yet, to count it as running. */
	private wrap(): void {
		const handlers = (this.plugin.app as unknown as AppWithCli).cli?.handlers;
		if (!handlers) return;
		for (const [name, entry] of handlers) {
			if (!name.startsWith(EXCALIDRAW_CLI) || this.wrapped.has(entry)) continue;
			const handler = entry.handler;
			this.wrapped.set(entry, handler);
			entry.handler = async (...args: unknown[]) => {
				this.running++;
				try {
					return await handler(...args);
				} finally {
					this.running--;
				}
			};
		}
	}
}
