import { type App, Keymap, Notice, Platform, Scope, setIcon, type WorkspaceLeaf } from "obsidian";

import { type ActiveSuggestions, ComposerSuggest, type SuggestSource } from "./composer-suggest";
import type { FileHistory } from "./history";
import { NewTabActions } from "./new-tab-actions";
import { openFile, type OpenIn } from "./open";
import { renderItem } from "./rows";
import { type FileItem, type Item, Search } from "./search";

const PAGE_CLASS = "quick-open-page";
/** Rows listed before anything is typed, and at most while searching. */
const RECENT_LIMIT = 30;
const SEARCH_LIMIT = 60;
/** Claudian (Enhanced), whose `ask` takes a question from here. */
const CLAUDIAN_ENHANCED = "claudian-enhanced";

/**
 * Go to File on Obsidian's empty new tab: a search box with the results under it, one card
 * per file, instead of a blank page with three links at the bottom. The same search as the
 * Cmd/Ctrl+P modal (see search.ts) — files only, since a new tab has no note for `:line` or
 * `@heading` to apply to.
 *
 * Every empty tab gets one, kept for as long as the tab stays empty: the query typed into it
 * survives the list being redrawn when a file is opened elsewhere or another device's list
 * arrives. Opening a file turns the tab into that file (or goes to the tab that already has
 * it); Shift+Enter, Cmd/Ctrl-click or a middle click opens it in a new tab instead.
 *
 * With Claudian (Enhanced) on, a query can be asked instead of looked up: an "Ask Claudian"
 * row heads the results, chosen like any row — or straight away with Cmd/Ctrl+Enter — and
 * the query goes to Claudian as the empty tab's question (see askClaudian). Without it,
 * Cmd/Ctrl+Enter opens in a new tab, as Shift+Enter does. While a question is typed, `@`
 * and `/` offer what Claudian's composer offers for them — notes and sessions to mention,
 * commands and skills — from Claudian's own sources (see composer-suggest.ts).
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
				// A tab switch brings layout-change, active-leaf-change and the history's own change
				// in one go; the list is drawn once for all of them.
				existing.scheduleUpdate();
				return;
			}
			// Not the box holding Obsidian's title and links: that one is capped at 280px tall.
			const host = leaf.view.containerEl.querySelector<HTMLElement>(".empty-state");
			if (host) this.tabs.set(leaf, new TabSearch(this.app, this.search, this.history, host, leaf));
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
	/** The rows on screen: the "Ask Claudian" row first when there is one, then the files'. */
	private rows: HTMLElement[] = [];
	/** Whether the list leads with the "Ask Claudian" row, which moves the files down one. */
	private asking = false;
	/** Claudian's `@` and `/` menus while a question is typed; see composer-suggest.ts. */
	private readonly suggest: ComposerSuggest;
	/** The menu's rows, by the index of what they offer; null for a note that can't be chosen. */
	private suggestRows: (HTMLElement | null)[] = [];
	private suggestSelected = 0;
	private selected = 0;
	private scoped = false;
	private frame: number | null = null;
	/** What the list last drew, so a redraw that would change nothing is skipped. */
	private drawn = "";
	/** A press is under way in the page; a redraw asked for meanwhile waits for its release. */
	private pressing = false;
	private redrawAfterPress = false;

	constructor(
		private readonly app: App,
		private readonly search: Search,
		private readonly history: FileHistory,
		host: HTMLElement,
		/** The empty tab this search is on: asking Claudian turns it into the conversation. */
		private readonly leaf: WorkspaceLeaf,
	) {
		this.el = host.createDiv({ cls: PAGE_CLASS });
		// Above Obsidian's title and links, which follow wherever the theme puts them.
		host.prepend(this.el);
		// See scheduleUpdate: a redraw waits out a press, then happens.
		this.el.addEventListener(
			"pointerdown",
			() => {
				this.pressing = true;
				const release = (): void => {
					this.el.win.removeEventListener("pointerup", release, true);
					this.el.win.removeEventListener("pointercancel", release, true);
					this.pressing = false;
					if (!this.redrawAfterPress) return;
					this.redrawAfterPress = false;
					this.scheduleUpdate();
				};
				this.el.win.addEventListener("pointerup", release, true);
				this.el.win.addEventListener("pointercancel", release, true);
			},
			true,
		);
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

		this.suggest = new ComposerSuggest(this.input, () => this.claudianSources(), () => this.update());
		// The caret moving can enter or leave an `@` or `/` without any typing.
		const lookUnderCaret = (): void => {
			const was = this.suggest.active !== null;
			if (this.suggest.refresh() || was) this.update();
		};
		this.input.addEventListener("click", lookUnderCaret);
		this.input.addEventListener("keyup", (evt) => {
			if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(evt.key)) lookUnderCaret();
		});
		this.input.addEventListener("input", () => {
			this.suggestSelected = 0;
			if (this.suggest.refresh()) return;
			// The first file, even under the "Ask Claudian" row: Enter keeps opening it.
			this.selected = this.askClaudian() && this.input.value.trim() ? 1 : 0;
			this.update();
		});

		// While the box has focus its keys are the list's, ahead of Obsidian's hotkeys — Mod+Enter
		// is "open link in new tab" there.
		this.scope = new Scope(app.scope);
		this.scope.register([], "ArrowDown", () => {
			if (this.suggest.active) this.stepSuggestion(1);
			else this.select(this.selected + 1, true);
			return false;
		});
		this.scope.register([], "ArrowUp", () => {
			if (this.suggest.active) this.stepSuggestion(-1);
			else this.select(this.selected - 1, true);
			return false;
		});
		this.scope.register([], "Enter", (evt) => {
			if (!this.suggest.active) return this.enter(evt, "current-group");
			if (evt.isComposing) return true;
			this.suggest.choose(this.suggestSelected);
			return false;
		});
		this.scope.register([], "Tab", () => {
			if (!this.suggest.active) return true;
			this.suggest.choose(this.suggestSelected);
			return false;
		});
		this.scope.register(["Mod"], "Enter", (evt) => {
			if (!this.askClaudian()) return this.enter(evt, "new-tab");
			if (evt.isComposing) return true;
			this.ask();
			return false;
		});
		this.scope.register(["Shift"], "Enter", (evt) => this.enter(evt, "new-tab"));
		this.scope.register([], "Escape", () => {
			if (this.suggest.active) {
				this.suggest.dismiss();
				return false;
			}
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

	/**
	 * Update on the next frame; asked again before then, it still updates once. Not while a
	 * press is under way: clicking into a tab that wasn't active makes it active, which asks
	 * for a redraw, and a list rebuilt between the press and the release swallowed the click
	 * (the row pressed was gone) — the row needed a second click. It redraws after the release.
	 */
	scheduleUpdate(): void {
		if (this.pressing) {
			this.redrawAfterPress = true;
			return;
		}
		if (this.frame !== null) return;
		this.frame = this.el.win.requestAnimationFrame(() => {
			this.frame = null;
			this.update();
		});
	}

	/** Re-run the query against the current list, keeping the selection where it can. */
	update(): void {
		const suggestions = this.suggest.active;
		if (suggestions) {
			this.drawSuggestions(suggestions);
			return;
		}
		const query = this.input.value.trim();
		const canAsk = this.askClaudian() !== null;
		// Claudian (Enhanced) can be turned on or off while the tab is open.
		this.input.placeholder = canAsk ? "Search files or ask Claudian" : "Search files";
		const ask = query !== "" && canAsk;
		this.items = this.search
			.suggest(query, { limit: query ? SEARCH_LIMIT : RECENT_LIMIT, filesOnly: true })
			.filter((item: Item): item is FileItem => item.kind === "file");
		const openedAt = new Map(this.history.entries().map((entry) => [entry.file.path, entry.openedAt]));
		const now = Date.now();
		const whens = this.items.map((item) => (item.recent ? since(openedAt.get(item.file.path) ?? 0, now) : ""));
		// The same rows as on screen: keep them, so a row being clicked isn't swapped out.
		const drawing = JSON.stringify([query, ask, this.items.map((item, i) => [item.file.path, item.recent, whens[i]])]);
		if (drawing === this.drawn && this.list.childElementCount > 0) {
			this.select(Math.min(this.selected, this.rows.length - 1), false);
			return;
		}
		this.drawn = drawing;
		this.rows = [];
		this.list.empty();
		this.asking = ask;
		if (ask) this.rows.push(this.askRow(query));
		if (this.items.length === 0) {
			this.list.createDiv({ cls: "quick-open-page-empty", text: query ? "No matching files." : "Nothing opened yet." });
			// Nothing to open: Enter asks.
			this.select(0, false);
			return;
		}

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
			const when = whens[index] ?? "";
			if (when) row.querySelector(".quick-open-aux")?.prepend(createSpanIn(row, "quick-open-page-when", when));
			const at = this.rows.length;
			row.addEventListener("mousemove", () => this.select(at, false));
			row.addEventListener("click", (evt) => {
				if (evt.defaultPrevented) return;
				this.choose(at, Keymap.isModEvent(evt) ? "new-tab" : "current-group");
			});
			row.addEventListener("auxclick", (evt) => {
				if (evt.button === 1) this.choose(at, "new-tab");
			});
			this.rows.push(row);
		});
		this.select(Math.min(this.selected, this.rows.length - 1), false);
	}

	focus(): void {
		if (this.el.doc.activeElement !== this.input) this.input.focus();
	}

	destroy(): void {
		if (this.frame !== null) this.el.win.cancelAnimationFrame(this.frame);
		this.frame = null;
		this.popScope();
		this.suggest.destroy();
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
		if (this.asking && index === 0) {
			this.ask();
			return;
		}
		const item = this.items[index - (this.asking ? 1 : 0)];
		if (item) void openFile(this.app, item.file, where, item.line, item.column);
	}

	/** The row that asks Claudian the query, at the head of the list. */
	private askRow(query: string): HTMLElement {
		this.list.createDiv({ cls: "quick-open-page-section", text: "Claudian" });
		const row = this.list.createDiv({ cls: "quick-open-page-row quick-open-item quick-open-page-ask" });
		setIcon(row.createDiv({ cls: "quick-open-icon" }), "message-square");
		const text = row.createDiv({ cls: "quick-open-text" });
		text.createSpan({ cls: "quick-open-name", text: "Ask Claudian" });
		text.createSpan({ cls: "quick-open-path", text: query });
		const aux = row.createDiv({ cls: "quick-open-aux" });
		aux.createSpan({ cls: "quick-open-page-when", text: Platform.isMacOS ? "⌘↩" : "Ctrl+Enter" });
		row.addEventListener("mousemove", () => this.select(0, false));
		row.addEventListener("click", () => this.ask());
		return row;
	}

	/**
	 * Claudian's menu for the `@` or `/` under the caret, in place of the files. Drawn afresh
	 * each time; the files' list is redrawn once the menu goes (`drawn` is cleared for that).
	 */
	private drawSuggestions(active: ActiveSuggestions): void {
		this.drawn = "";
		this.rows = [];
		this.suggestRows = [];
		this.list.empty();
		this.list.createDiv({
			cls: "quick-open-page-section",
			text: active.match.trigger === "@" ? "Mention in Claudian" : "Claudian commands",
		});
		if (active.items.length === 0) {
			this.list.createDiv({ cls: "quick-open-page-empty", text: "Nothing to offer." });
			return;
		}
		active.items.forEach((item, index) => {
			if (item.kind === "status") {
				this.list.createDiv({ cls: "quick-open-page-empty", text: item.label });
				this.suggestRows.push(null);
				return;
			}
			const row = this.list.createDiv({ cls: "quick-open-page-row quick-open-item" });
			if (item.disabled) row.addClass("is-disabled");
			setIcon(row.createDiv({ cls: "quick-open-icon" }), item.icon ?? (item.kind === "folder" ? "folder" : "file-text"));
			const text = row.createDiv({ cls: "quick-open-text" });
			text.createSpan({ cls: "quick-open-name", text: item.label });
			if (item.detail) text.createSpan({ cls: "quick-open-path", text: item.detail });
			row.addEventListener("mousemove", () => this.selectSuggestion(index, false));
			// Focus stays in the box, where the menu's keys are.
			row.addEventListener("mousedown", (evt) => evt.preventDefault());
			row.addEventListener("click", () => this.suggest.choose(index));
			this.suggestRows.push(item.disabled ? null : row);
		});
		const first = this.suggestRows.findIndex((row) => row !== null);
		const keep = this.suggestRows[this.suggestSelected] ? this.suggestSelected : first;
		if (keep >= 0) this.selectSuggestion(keep, false);
	}

	private selectSuggestion(index: number, scroll: boolean): void {
		const row = this.suggestRows[index];
		if (!row) return;
		this.suggestRows[this.suggestSelected]?.removeClass("is-selected");
		this.suggestSelected = index;
		row.addClass("is-selected");
		if (scroll) row.scrollIntoView({ block: "nearest" });
	}

	/** The next row that can be chosen, `by` one way or the other, wrapping round. */
	private stepSuggestion(by: number): void {
		const count = this.suggestRows.length;
		for (let i = 1; i <= count; i++) {
			const index = (((this.suggestSelected + by * i) % count) + count) % count;
			if (this.suggestRows[index]) {
				this.selectSuggestion(index, true);
				return;
			}
		}
	}

	/** Claudian's composer sources for `@` and `/` (Claudian (Enhanced)), when it has them. */
	private claudianSources(): SuggestSource[] | null {
		if (Platform.isMobile) return null;
		const plugins = (this.app as unknown as { plugins?: { plugins?: Record<string, unknown> } }).plugins?.plugins;
		const plugin = plugins?.[CLAUDIAN_ENHANCED] as { composerSources?: () => unknown[] | null } | undefined;
		const sources = typeof plugin?.composerSources === "function" ? plugin.composerSources() : null;
		return (sources as SuggestSource[] | null) ?? null;
	}

	/** Claudian (Enhanced)'s `ask`, when that plugin is on. */
	private askClaudian(): ((text: string) => Promise<boolean>) | null {
		// Never on mobile, even should the new tab's search come to be drawn there.
		if (Platform.isMobile) return null;
		const plugins = (this.app as unknown as { plugins?: { plugins?: Record<string, unknown> } }).plugins?.plugins;
		const plugin = plugins?.[CLAUDIAN_ENHANCED] as
			| { ask?: (text: string, options?: { leaf?: WorkspaceLeaf }) => Promise<boolean> }
			| undefined;
		const ask = plugin?.ask;
		// In this tab: it becomes the conversation, as ChatGPT's home page does, rather than
		// the question going to the sidebar.
		return typeof ask === "function" ? (text) => ask.call(plugin, text, { leaf: this.leaf }) : null;
	}

	/** Hand the query to Claudian as this empty tab's question; the box empties once it's sent. */
	private ask(): void {
		const query = this.input.value.trim();
		const ask = this.askClaudian();
		if (!query || !ask) return;
		void ask(query).then((sent) => {
			if (!sent) {
				new Notice("Claudian didn't take the question; it's still in the box.");
				return;
			}
			if (this.input.value.trim() !== query) return;
			this.input.value = "";
			this.selected = 0;
			this.update();
		});
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
