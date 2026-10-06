import { type App, Keymap, Platform, Scope, setIcon, type WorkspaceLeaf } from "obsidian";

import type { FileHistory } from "./history";
import { NewTabActions } from "./new-tab-actions";
import { openFile, type OpenIn } from "./open";
import { renderItem } from "./rows";
import { type FileItem, type Item, Search } from "./search";

const PAGE_CLASS = "quick-open-page";
/** Rows listed before anything is typed, and at most while searching. */
const RECENT_LIMIT = 30;
const SEARCH_LIMIT = 60;

/**
 * Go to File on Obsidian's empty new tab: a search box with the results under it, one card
 * per file, instead of a blank page with three links at the bottom. The same search as the
 * Cmd/Ctrl+P modal (see search.ts) — files only, since a new tab has no note for `:line` or
 * `@heading` to apply to.
 *
 * Every empty tab gets one, kept for as long as the tab stays empty: the query typed into it
 * survives the list being redrawn when a file is opened elsewhere or another device's list
 * arrives. Opening a file turns the tab into that file (or goes to the tab that already has
 * it); Cmd/Ctrl+Enter, Cmd/Ctrl-click or a middle click opens it in a new tab instead.
 */
export class NewTabSearch {
	private readonly tabs = new Map<WorkspaceLeaf, TabSearch>();
	private readonly search: Search;

	constructor(
		private readonly app: App,
		private readonly history: FileHistory,
	) {
		this.search = new Search(app, history);
	}

	/** Give every empty tab its search, drop those whose tab has since opened something. */
	refresh(): void {
		// Desktop only. A phone's empty tab is left as Obsidian draws it: its navbar already has
		// search and new-note buttons, and the page squeezed between the floating header and
		// navbar never sat right there.
		if (Platform.isMobile) return;
		for (const [leaf, tab] of this.tabs) {
			if (leaf.view.getViewType() !== "empty" || !tab.el.isConnected) {
				tab.destroy();
				this.tabs.delete(leaf);
			}
		}
		this.app.workspace.iterateAllLeaves((leaf) => {
			if (leaf.view.getViewType() !== "empty") return;
			const existing = this.tabs.get(leaf);
			if (existing) {
				existing.update();
				return;
			}
			// Not the box holding Obsidian's title and links: that one is capped at 280px tall.
			const host = leaf.view.containerEl.querySelector<HTMLElement>(".empty-state");
			if (host) this.tabs.set(leaf, new TabSearch(this.app, this.search, this.history, host));
		});
	}

	/** Put the cursor in the search of the tab just switched to, as a browser's new tab does. */
	focus(leaf: WorkspaceLeaf | null): void {
		// Not on mobile: focusing a text box brings the keyboard up over the list.
		if (Platform.isMobile || !leaf) return;
		this.tabs.get(leaf)?.focus();
	}

	detach(): void {
		for (const tab of this.tabs.values()) tab.destroy();
		this.tabs.clear();
	}
}

/** One empty tab's search: its box, its results, and which row is selected. */
class TabSearch {
	readonly el: HTMLElement;
	private readonly input: HTMLInputElement;
	private readonly list: HTMLElement;
	private readonly scope: Scope;
	private readonly actions: NewTabActions | null;
	private items: FileItem[] = [];
	private rows: HTMLElement[] = [];
	private selected = 0;
	private scoped = false;

	constructor(
		private readonly app: App,
		private readonly search: Search,
		private readonly history: FileHistory,
		host: HTMLElement,
	) {
		this.el = host.createDiv({ cls: PAGE_CLASS });
		// Above Obsidian's title and links, which follow wherever the theme puts them.
		host.prepend(this.el);
		const inner = this.el.createDiv({ cls: "quick-open-page-inner" });

		const box = inner.createDiv({ cls: "quick-open-page-search" });
		setIcon(box.createDiv({ cls: "quick-open-page-search-icon" }), "search");
		this.input = box.createEl("input", {
			cls: "quick-open-page-input",
			attr: { type: "text", placeholder: "Search files", spellcheck: "false", autocapitalize: "off" },
		});
		this.list = inner.createDiv({ cls: "quick-open-page-list" });
		// Obsidian's own buttons under it (New note, Go to file…), with their shortcuts.
		const actionList = host.querySelector<HTMLElement>(".empty-state-action-list");
		this.actions = actionList ? new NewTabActions(app, actionList) : null;

		this.input.addEventListener("input", () => {
			this.selected = 0;
			this.update();
		});

		// While the box has focus its keys are the list's, ahead of Obsidian's hotkeys — Mod+Enter
		// is "open link in new tab" there.
		this.scope = new Scope(app.scope);
		this.scope.register([], "ArrowDown", () => {
			this.select(this.selected + 1, true);
			return false;
		});
		this.scope.register([], "ArrowUp", () => {
			this.select(this.selected - 1, true);
			return false;
		});
		this.scope.register([], "Enter", (evt) => this.enter(evt, "current-group"));
		this.scope.register(["Mod"], "Enter", (evt) => this.enter(evt, "new-tab"));
		this.scope.register([], "Escape", () => {
			if (this.input.value) {
				this.input.value = "";
				this.selected = 0;
				this.update();
			} else {
				this.input.blur();
			}
			return false;
		});
		this.input.addEventListener("focus", () => {
			if (this.scoped) return;
			this.app.keymap.pushScope(this.scope);
			this.scoped = true;
		});
		this.input.addEventListener("blur", () => this.popScope());

		this.update();
	}

	/** Re-run the query against the current list, keeping the selection where it can. */
	update(): void {
		const query = this.input.value.trim();
		this.items = this.search
			.suggest(query, { limit: query ? SEARCH_LIMIT : RECENT_LIMIT, filesOnly: true })
			.filter((item: Item): item is FileItem => item.kind === "file");
		this.rows = [];
		this.list.empty();
		if (this.items.length === 0) {
			this.list.createDiv({ cls: "quick-open-page-empty", text: query ? "No matching files." : "Nothing opened yet." });
			return;
		}

		const openedAt = new Map(this.history.entries().map((entry) => [entry.file.path, entry.openedAt]));
		const now = Date.now();
		let section: boolean | null = null;
		this.items.forEach((item, index) => {
			if (item.recent !== section) {
				section = item.recent;
				this.list.createDiv({ cls: "quick-open-page-section", text: item.recent ? "Recently opened" : "Files" });
			}
			const row = this.list.createDiv({ cls: "quick-open-page-row" });
			renderItem(
				this.app,
				item,
				row,
				{
					openToSide: (target) => void openFile(this.app, target.file, "side", target.line, target.column),
					remove: (target) => this.history.remove(target.file.path),
				},
				{ labels: false },
			);
			const when = item.recent ? since(openedAt.get(item.file.path) ?? 0, now) : "";
			if (when) row.querySelector(".quick-open-aux")?.prepend(createSpanIn(row, "quick-open-page-when", when));
			row.addEventListener("mousemove", () => this.select(index, false));
			row.addEventListener("click", (evt) => {
				if (evt.defaultPrevented) return;
				this.choose(index, Keymap.isModEvent(evt) ? "new-tab" : "current-group");
			});
			row.addEventListener("auxclick", (evt) => {
				if (evt.button === 1) this.choose(index, "new-tab");
			});
			this.rows.push(row);
		});
		this.select(Math.min(this.selected, this.items.length - 1), false);
	}

	focus(): void {
		if (this.el.doc.activeElement !== this.input) this.input.focus();
	}

	destroy(): void {
		this.popScope();
		this.actions?.destroy();
		this.el.remove();
	}

	private enter(evt: KeyboardEvent, where: OpenIn): boolean {
		// An Enter that confirms an input method's candidate belongs to the input method.
		if (evt.isComposing) return true;
		this.choose(this.selected, where);
		return false;
	}

	private select(index: number, scroll: boolean): void {
		const count = this.rows.length;
		if (count === 0) return;
		const next = ((index % count) + count) % count;
		this.rows[this.selected]?.removeClass("is-selected");
		this.selected = next;
		const row = this.rows[next];
		row?.addClass("is-selected");
		if (scroll) row?.scrollIntoView({ block: "nearest" });
	}

	private choose(index: number, where: OpenIn): void {
		const item = this.items[index];
		if (item) void openFile(this.app, item.file, where, item.line, item.column);
	}

	private popScope(): void {
		if (!this.scoped) return;
		this.app.keymap.popScope(this.scope);
		this.scoped = false;
	}
}

/** A span made in `owner`'s document but not yet placed — for prepending. */
function createSpanIn(owner: HTMLElement, cls: string, text: string): HTMLElement {
	const span = owner.doc.createElement("span");
	span.className = cls;
	span.textContent = text;
	return span;
}

/**
 * How long ago, briefly: "now", "5m", "3h", "2d", then the date. Empty for an entry
 * imported from another list, which carries no real time.
 */
function since(at: number, now: number): string {
	// Imported entries are dated in the first moments of 1970 so real opens outrank them.
	if (at < 1_000_000_000_000) return "";
	const minutes = Math.floor((now - at) / 60_000);
	if (minutes < 1) return "now";
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h`;
	const days = Math.floor(hours / 24);
	if (days < 7) return `${days}d`;
	return new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
