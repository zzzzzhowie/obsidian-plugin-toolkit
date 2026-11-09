import { debounce, MarkdownView, type OpenViewState, type Plugin, type TAbstractFile, type TFile, WorkspaceLeaf } from "obsidian";

/** Where a note was left: the line at the top of its view, and the selection. */
export interface Place {
	scroll: number;
	cursor?: { from: { line: number; ch: number }; to: { line: number; ch: number } };
	/** When it was last left there, to drop the oldest once there are too many. */
	at: number;
}

/** Notes remembered at most; the ones left longest ago go first. */
const MAX_PLACES = 1000;
/** How often the open notes' places are read. */
const SNAPSHOT_MS = 500;
/** How long a tab just put back is left to scroll there before it's read again. */
const SETTLE_MS = 1000;
/** An open asking for a spot in the note: a link's heading or block, a search hit, a line. */
const TARGETS = ["subpath", "line", "startLoc", "match", "scroll", "cursor"];

/**
 * Open a note where it was left, as an editor reopens a file: scrolled to the same place, the
 * cursor where it was. Obsidian keeps that only while the note's tab stays open — closing the
 * tab, or quitting, loses it, and the note opens at the top again. Here each note's place is
 * kept in the plugin's data and put back when the note is opened again, and when Obsidian
 * starts and reloads the tabs it had.
 *
 * An open that asks for a spot — a link to a heading or a block, a search result, a line from
 * another plugin, back and forward — goes there as asked; only a plain open (the file list,
 * Quick Switcher, a link to the note itself) is put back.
 *
 * The places are read from the open notes every half second rather than on each scroll: the
 * editor and reading view scroll different elements, and a tab that's closed is gone before
 * any event about it. A note shown in a tab that is still loading isn't read until it has
 * been put back, or its top would be saved over its place.
 */
export class RememberPlace {
	private places: Record<string, Place> = {};
	/** Tabs to put back once they show the note: a reopened tab, a note just opened in one. */
	private readonly pending = new Map<WorkspaceLeaf, string>();
	/**
	 * Tabs just put back, not read until the scroll has landed: the editor scrolls on its next
	 * frame, and a window in the background draws none, so its tabs wait until it's on show.
	 */
	private readonly settling = new Map<WorkspaceLeaf, number>();
	private readonly save = debounce(() => void this.persist(), 2000, true);

	constructor(
		private readonly plugin: Plugin,
		private readonly load: () => Record<string, Place>,
		private readonly store: (places: Record<string, Place>) => Promise<void>,
	) {}

	start(): void {
		const { app } = this.plugin;
		this.places = this.load();
		app.workspace.onLayoutReady(() => {
			app.workspace.iterateAllLeaves((leaf) => {
				const path = this.pathOf(leaf);
				if (path && this.places[path]) this.pending.set(leaf, path);
			});
			this.restorePending();
			this.plugin.registerEvent(app.workspace.on("active-leaf-change", () => this.restorePending()));
			this.plugin.registerEvent(app.workspace.on("layout-change", () => this.restorePending()));
			this.plugin.registerInterval(window.setInterval(() => this.snapshot(), SNAPSHOT_MS));
		});
		this.plugin.registerEvent(app.workspace.on("quit", () => {
			this.snapshot();
			void this.persist();
		}));
		this.plugin.registerEvent(app.vault.on("rename", (file, oldPath) => this.moved(file, oldPath)));
		this.plugin.registerEvent(app.vault.on("delete", (file) => this.moved(file, null)));
		this.wrapOpenFile();
	}

	/**
	 * Every open of a note in a tab goes through `WorkspaceLeaf.openFile`: the file list, Quick
	 * Switcher, links. Read the note being left first; put the one opened back after, unless the
	 * open asked for a spot in it.
	 */
	private wrapOpenFile(): void {
		const proto = WorkspaceLeaf.prototype;
		// eslint-disable-next-line @typescript-eslint/unbound-method -- called with the leaf below
		const original = proto.openFile;
		const beforeOpen = (leaf: WorkspaceLeaf, file: TFile, openState?: OpenViewState): void => {
			this.snapshotLeaf(leaf);
			const eState: Record<string, unknown> = openState?.eState ?? {};
			const asked = TARGETS.some((key) => eState[key] !== undefined && eState[key] !== null && eState[key] !== "");
			if (asked || !this.places[file.path]) this.pending.delete(leaf);
			else this.pending.set(leaf, file.path);
		};
		const afterOpen = (): void => this.restorePending();
		const openFile = async function (this: WorkspaceLeaf, file: TFile, openState?: OpenViewState): Promise<void> {
			beforeOpen(this, file, openState);
			await original.call(this, file, openState);
			afterOpen();
		};
		proto.openFile = openFile;
		this.plugin.register(() => {
			if (proto.openFile === openFile) proto.openFile = original;
		});
	}

	/** Put back the tabs waiting on it whose note has loaded. */
	private restorePending(): void {
		for (const [leaf, path] of this.pending) {
			const view = leaf.view;
			if (!(view instanceof MarkdownView) || !view.file) continue;
			if (view.file.path !== path) {
				this.pending.delete(leaf);
				continue;
			}
			const place = this.places[path];
			if (!place) {
				this.pending.delete(leaf);
				continue;
			}
			// A tab opened behind another can't scroll yet: it's put back when it's first shown.
			if (!view.containerEl.isShown()) continue;
			// Still loading: its text isn't in yet, and there's nothing to scroll to.
			if (view.getViewData() === "" && view.file.stat.size > 0) continue;
			this.pending.delete(leaf);
			this.settling.set(leaf, Date.now() + SETTLE_MS);
			leaf.setEphemeralState({ scroll: place.scroll, ...(place.cursor ? { cursor: place.cursor } : {}) });
		}
	}

	/** Read where each open note is. */
	private snapshot(): void {
		this.plugin.app.workspace.iterateAllLeaves((leaf) => this.snapshotLeaf(leaf));
	}

	private snapshotLeaf(leaf: WorkspaceLeaf): void {
		if (this.pending.has(leaf)) return;
		const view = leaf.view;
		if (!(view instanceof MarkdownView) || !view.file) return;
		// A tab behind another, or in a window in the background: nothing scrolls there, and a
		// view not on show reads as scrolled to the top.
		if (!view.containerEl.isShown() || view.containerEl.doc.visibilityState === "hidden") {
			if (this.settling.has(leaf)) this.settling.set(leaf, Date.now() + SETTLE_MS);
			return;
		}
		const settled = this.settling.get(leaf);
		if (settled !== undefined) {
			if (Date.now() < settled) return;
			this.settling.delete(leaf);
		}
		// Not yet loaded, or emptied: its top would stand in for its place.
		if (view.getViewData() === "" && view.file.stat.size > 0) return;
		const scroll = view.currentMode.getScroll();
		const { cursor } = view.getEphemeralState() as Pick<Place, "cursor">;
		const path = view.file.path;
		const before = this.places[path];
		const atStart = scroll < 0.5 && (!cursor || (cursor.from.line === 0 && cursor.to.line === 0 && cursor.from.ch === 0 && cursor.to.ch === 0));
		if (atStart) {
			if (!before) return;
			delete this.places[path];
			this.save();
			return;
		}
		if (before && Math.abs(before.scroll - scroll) < 0.01 && JSON.stringify(before.cursor) === JSON.stringify(cursor)) return;
		this.places[path] = { scroll, ...(cursor ? { cursor } : {}), at: Date.now() };
		this.save();
	}

	/** A note renamed keeps its place; one deleted drops it. */
	private moved(file: TAbstractFile, oldPath: string | null): void {
		const from = oldPath ?? file.path;
		const place = this.places[from];
		if (!place) return;
		delete this.places[from];
		if (oldPath) this.places[file.path] = place;
		this.save();
	}

	private async persist(): Promise<void> {
		const paths = Object.keys(this.places);
		if (paths.length > MAX_PLACES) {
			paths.sort((a, b) => (this.places[a]?.at ?? 0) - (this.places[b]?.at ?? 0));
			for (const path of paths.slice(0, paths.length - MAX_PLACES)) delete this.places[path];
		}
		await this.store(this.places);
	}

	private pathOf(leaf: WorkspaceLeaf): string | null {
		const state = leaf.getViewState();
		if (state.type !== "markdown") return null;
		const file = (state.state as { file?: unknown } | undefined)?.file;
		return typeof file === "string" ? file : null;
	}
}
