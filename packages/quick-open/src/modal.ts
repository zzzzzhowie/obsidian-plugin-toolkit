import {
	type App,
	type HeadingCache,
	Keymap,
	MarkdownView,
	parseFrontMatterAliases,
	Platform,
	prepareFuzzySearch,
	renderMatches,
	type SearchMatches,
	setIcon,
	SuggestModal,
	type TFile,
} from "obsidian";

import type { FileHistory } from "./history";
import { goToLine, openFile } from "./open";

/**
 * Go to File, as VS Code's Cmd+P does it.
 *
 * - Nothing typed: recently opened files, most recent first — the note you're in at the top.
 * - Typed: fuzzy match on file names (on the whole path once the query has a `/`). Recently
 *   opened matches come first, then the rest of the vault.
 * - `name:42` or `name:42:7` opens at that line (and column); `:42` goes to a line in the
 *   current note; `@` lists the current note's headings.
 * - Enter opens, Cmd/Ctrl+Enter opens to the side. Each row also has buttons for opening to
 *   the side and, for a recent file, removing it from the list.
 * - Cmd/Ctrl+P again moves down the list; letting go of Cmd/Ctrl then opens what's selected,
 *   so holding Cmd and tapping P switches between recent files in one gesture.
 */

type Item = FileItem | LineItem | HeadingItem;

interface FileItem {
	kind: "file";
	file: TFile;
	recent: boolean;
	/** Over the file name — or over the alias, for an alias row. */
	nameMatches: SearchMatches | null;
	pathMatches: SearchMatches | null;
	/** Set when the query matched one of the note's `aliases` rather than its name. */
	alias?: string;
	line?: number;
	column?: number;
	/** Shown on the right of the first row of a section. */
	label?: string;
}

interface LineItem {
	kind: "line";
	line: number | null;
	column?: number;
}

interface HeadingItem {
	kind: "heading";
	heading: HeadingCache;
	matches: SearchMatches | null;
}

const LABEL_RECENT = "recently opened";
const LABEL_FILES = "file results";
const MOD = Platform.isMacOS ? "⌘" : "Ctrl";
const MOD_KEY = Platform.isMacOS ? "Meta" : "Control";

/** The parts of Obsidian's suggestion list used to drive it directly. */
interface Chooser {
	suggestions: HTMLElement[];
	moveDown(evt: KeyboardEvent): void;
	setSelectedItem(index: number, evt: Event | null): void;
	useSelectedItem(evt: Event): boolean;
}

/** A touch that moved further than this was scrolling the list, not tapping a row. */
const TAP_SLOP_PX = 10;
/** Held longer than this, it's a long-press, not a tap. */
const TAP_MAX_MS = 500;

interface TapStart {
	x: number;
	y: number;
	at: number;
	row: HTMLElement;
}

export class QuickOpenModal extends SuggestModal<Item> {
	/** Cmd/Ctrl+P was pressed while open: releasing Cmd/Ctrl opens the selection. */
	private navigating = false;
	private tapStart: TapStart | null = null;
	private readonly onKeyUp = (evt: KeyboardEvent): void => {
		if (!this.navigating || evt.key !== MOD_KEY) return;
		this.navigating = false;
		this.list.useSelectedItem(evt);
	};

	constructor(
		app: App,
		private readonly history: FileHistory,
	) {
		super(app);
		this.limit = 200;
		this.emptyStateText = "No matching results.";
		this.setPlaceholder("Search files by name (append : to go to line or @ to go to heading)");
		// Keyboard hints mean nothing on a touch screen.
		if (!Platform.isMobile) {
			this.setInstructions([
				{ command: "↑↓", purpose: "to navigate" },
				{ command: "↵", purpose: "to open" },
				{ command: `${MOD} ↵`, purpose: "to open to the side" },
				{ command: `${MOD} P`, purpose: `next — release ${MOD} to open` },
				{ command: "esc", purpose: "to dismiss" },
			]);
		}
		this.modalEl.addClass("quick-open-modal");

		this.scope.register(["Mod"], "Enter", (evt) => {
			if (evt.isComposing) return true;
			this.list.useSelectedItem(evt);
			return false;
		});
		this.scope.register(["Mod"], "P", (evt) => {
			this.navigating = true;
			this.list.moveDown(evt);
			return false;
		});
	}

	/**
	 * Obsidian's own `chooser`, typed. Not a getter named `chooser`: SuggestModal assigns that
	 * field in its constructor, and a getter-only property on the subclass makes the
	 * assignment throw.
	 */
	private get list(): Chooser {
		return (this as unknown as { chooser: Chooser }).chooser;
	}

	onOpen(): void {
		void super.onOpen();
		this.modalEl.win.addEventListener("keyup", this.onKeyUp, true);
		if (Platform.isMobile) {
			this.resultContainerEl.addEventListener("touchstart", this.onTouchStart, { passive: true });
			this.resultContainerEl.addEventListener("touchend", this.onTouchEnd, { passive: false });
			this.resultContainerEl.addEventListener("touchcancel", this.onTouchCancel);
		}
	}

	onClose(): void {
		this.modalEl.win.removeEventListener("keyup", this.onKeyUp, true);
		this.resultContainerEl.removeEventListener("touchstart", this.onTouchStart);
		this.resultContainerEl.removeEventListener("touchend", this.onTouchEnd);
		this.resultContainerEl.removeEventListener("touchcancel", this.onTouchCancel);
		super.onClose();
	}

	/*
	 * A tap on a row opens it as the finger lifts, rather than on the click iOS sends a beat
	 * later — a click it holds back while it watches what the tap's simulated hover does to
	 * the list. Cancelling the touchend also stops that click, which would otherwise land on
	 * the note under the closed modal. The row buttons are left to their own click.
	 */
	private readonly onTouchStart = (evt: TouchEvent): void => {
		const touch = evt.touches.length === 1 ? evt.touches[0] : undefined;
		const target = evt.target instanceof HTMLElement ? evt.target : null;
		const row = target?.closest<HTMLElement>(".suggestion-item");
		this.tapStart =
			touch && row && !target?.closest(".quick-open-action")
				? { x: touch.clientX, y: touch.clientY, at: evt.timeStamp, row }
				: null;
	};

	private readonly onTouchEnd = (evt: TouchEvent): void => {
		const start = this.tapStart;
		this.tapStart = null;
		const touch = evt.changedTouches[0];
		if (!start || !touch) return;
		const moved = Math.hypot(touch.clientX - start.x, touch.clientY - start.y) > TAP_SLOP_PX;
		if (moved || evt.timeStamp - start.at > TAP_MAX_MS) return;
		const index = this.list.suggestions.indexOf(start.row);
		if (index < 0) return;
		evt.preventDefault();
		this.list.setSelectedItem(index, null);
		this.list.useSelectedItem(evt);
	};

	private readonly onTouchCancel = (): void => {
		this.tapStart = null;
	};

	/** Re-run the current query — the list underneath it changed. */
	refresh(): void {
		this.inputEl.dispatchEvent(new Event("input"));
	}

	// --- Suggestions -----------------------------------------------------------------------

	getSuggestions(input: string): Item[] {
		const query = input.trim();
		if (query.startsWith("@")) return this.headingItems(query.slice(1).trim());
		if (query.startsWith(":")) return [lineItem(query.slice(1))];

		const at = /^(.*?):(\d+)(?::(\d+))?$/.exec(query);
		const name = (at ? at[1] : query)?.trim() ?? "";
		const line = at?.[2] ? Number(at[2]) : undefined;
		const column = at?.[3] ? Number(at[3]) : undefined;
		if (!name) return this.recentItems();
		return this.searchItems(name).map((item) => ({ ...item, line, column }));
	}

	private recentItems(): FileItem[] {
		return this.history.files().map((file, index) => ({
			kind: "file",
			file,
			recent: true,
			nameMatches: null,
			pathMatches: null,
			label: index === 0 ? LABEL_RECENT : undefined,
		}));
	}

	private searchItems(query: string): FileItem[] {
		const match = matcher(query);
		const matchAliases = aliasMatcher(query, (file) => this.aliasesOf(file));
		const recentFiles = this.history.files();
		const order = new Map(recentFiles.map((file, index) => [file.path, index]));
		const otherFiles = this.app.vault.getFiles().filter((file) => !order.has(file.path) && !this.isExcluded(file));

		// An alias row sits in the same section as its note and is ranked with the file rows,
		// as a name match: it is what the note is also called.
		const recent = [...scoreAll(recentFiles, match, true), ...matchAliases(recentFiles, true)].sort(
			(a, b) => compare(a, b) || (order.get(a.item.file.path) ?? 0) - (order.get(b.item.file.path) ?? 0),
		);
		const others = [...scoreAll(otherFiles, match, false), ...matchAliases(otherFiles, false)].sort(compare);

		const items = [...recent, ...others].slice(0, this.limit).map((scored) => scored.item);
		const firstOther = items.findIndex((item) => !item.recent);
		if (items[0]?.recent) items[0].label = LABEL_RECENT;
		if (firstOther >= 0 && items[firstOther]) items[firstOther].label = LABEL_FILES;
		return items;
	}

	/** The note's `aliases` property, as Obsidian reads it (a list or a single value). */
	private aliasesOf(file: TFile): string[] {
		if (file.extension !== "md") return [];
		return parseFrontMatterAliases(this.app.metadataCache.getFileCache(file)?.frontmatter) ?? [];
	}

	/** In Settings → Files and links → Excluded files: kept out of search, as VS Code's files.exclude. */
	private isExcluded(file: TFile): boolean {
		const cache = this.app.metadataCache as unknown as { isUserIgnored?: (path: string) => boolean };
		return cache.isUserIgnored?.(file.path) ?? false;
	}

	private headingItems(query: string): HeadingItem[] {
		const file = this.app.workspace.getActiveFile();
		const headings = file ? (this.app.metadataCache.getFileCache(file)?.headings ?? []) : [];
		if (!query) return headings.map((heading) => ({ kind: "heading", heading, matches: null }));
		const fuzzy = prepareFuzzySearch(query);
		return headings
			.flatMap((heading) => {
				const result = fuzzy(heading.heading);
				return result ? [{ item: { kind: "heading" as const, heading, matches: result.matches }, score: result.score }] : [];
			})
			.sort((a, b) => b.score - a.score)
			.map((scored) => scored.item);
	}

	// --- Rendering ------------------------------------------------------------------------

	renderSuggestion(item: Item, el: HTMLElement): void {
		el.addClass("quick-open-item");
		if (item.kind === "file") this.renderFile(item, el);
		else if (item.kind === "heading") renderHeading(item, el);
		else this.renderLine(item, el);
	}

	private renderFile(item: FileItem, el: HTMLElement): void {
		const { file } = item;
		// A section starts here: rule it off from the one above, as VS Code does.
		if (item.label === LABEL_FILES) el.addClass("is-section-start");
		setIcon(el.createDiv({ cls: "quick-open-icon" }), iconFor(file));

		const text = el.createDiv({ cls: "quick-open-text" });
		const folder = folderOf(file);
		if (item.alias !== undefined) {
			// As Obsidian's switcher shows one: the alias, then the note it stands for.
			renderMatches(text.createSpan({ cls: "quick-open-name" }), item.alias, item.nameMatches);
			if (item.line !== undefined) text.createSpan({ cls: "quick-open-name", text: `:${item.line}` });
			text.createSpan({ cls: "quick-open-path", text: folder ? `${folder}/${displayName(file)}` : displayName(file) });
		} else {
			renderMatches(text.createSpan({ cls: "quick-open-name" }), displayName(file), item.nameMatches);
			if (item.line !== undefined) text.createSpan({ cls: "quick-open-name", text: `:${item.line}` });
			if (folder) renderMatches(text.createSpan({ cls: "quick-open-path" }), folder, item.pathMatches);
		}

		const aux = el.createDiv({ cls: "quick-open-aux" });
		if (item.alias !== undefined) {
			setIcon(aux.createSpan({ cls: "quick-open-flair", attr: { "aria-label": "Alias" } }), "forward");
		}
		if (item.label) aux.createSpan({ cls: "quick-open-label", text: item.label });
		// A phone has no side to open to: one note on screen at a time.
		if (!Platform.isPhone) {
			this.action(aux, "columns-2", "Open to the side", () => {
				this.close();
				void openFile(this.app, file, true, item.line, item.column);
			});
		}
		if (item.recent) {
			this.action(aux, "x", "Remove from recently opened", () => {
				this.history.remove(file.path);
				// Re-run the query so the row goes and the rest close up.
				this.refresh();
			});
		}
	}

	private renderLine(item: LineItem, el: HTMLElement): void {
		setIcon(el.createDiv({ cls: "quick-open-icon" }), "arrow-right");
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		const text = el.createDiv({ cls: "quick-open-text" });
		if (!view) {
			text.setText("Open a note to go to a line in it.");
		} else if (item.line === null) {
			const cursor = view.editor.getCursor();
			text.setText(
				`Current line: ${cursor.line + 1}, character: ${cursor.ch + 1}. ` +
					`Type a line number between 1 and ${view.editor.lineCount()} to go to.`,
			);
		} else {
			text.setText(item.column ? `Go to line ${item.line}, character ${item.column}.` : `Go to line ${item.line}.`);
		}
	}

	/** A small button on the right of a row that does its own thing instead of opening the row. */
	private action(parent: HTMLElement, icon: string, label: string, run: () => void): void {
		const button = parent.createDiv({ cls: "clickable-icon quick-open-action", attr: { "aria-label": label } });
		setIcon(button, icon);
		// Keep focus in the search box.
		button.addEventListener("mousedown", (evt) => evt.preventDefault());
		button.addEventListener("click", (evt) => {
			// The row's own click handler skips an event already handled.
			evt.preventDefault();
			evt.stopPropagation();
			run();
		});
	}

	// --- Choosing --------------------------------------------------------------------------

	onChooseSuggestion(item: Item, evt: MouseEvent | KeyboardEvent): void {
		const toSide = !Platform.isPhone && Keymap.isModifier(evt, "Mod");
		// The modal is already closed, but nothing is painted until this task ends — and
		// opening a long note holds the main thread for a moment, which kept the closed modal
		// on screen until the note was ready. Let the close paint first: after the next frame.
		window.requestAnimationFrame(() => window.setTimeout(() => this.choose(item, toSide), 0));
	}

	private choose(item: Item, toSide: boolean): void {
		if (item.kind === "file") {
			void openFile(this.app, item.file, toSide, item.line, item.column);
			return;
		}
		const leaf = this.app.workspace.getActiveViewOfType(MarkdownView)?.leaf;
		if (!leaf) return;
		if (item.kind === "heading") goToLine(leaf, item.heading.position.start.line + 1);
		else if (item.line !== null) goToLine(leaf, item.line, item.column);
		this.app.workspace.setActiveLeaf(leaf, { focus: true });
	}
}

// --- Matching -------------------------------------------------------------------------------

interface Match {
	score: number;
	/** Matched on the file name rather than only somewhere in its folders. */
	onName: boolean;
	nameMatches: SearchMatches | null;
	pathMatches: SearchMatches | null;
}

interface Scored {
	item: FileItem;
	match: Match;
}

/**
 * How a file is scored against `query`. A query with a `/` in it is a path and matches the
 * whole path; otherwise the file name is tried first, falling back to the full path so a
 * folder name still finds what's in it.
 */
function matcher(query: string): (file: TFile) => Match | null {
	const fuzzy = prepareFuzzySearch(query);
	const pathOnly = query.includes("/");
	return (file) => {
		const name = displayName(file);
		if (!pathOnly) {
			const onName = fuzzy(name);
			if (onName) return { score: onName.score, onName: true, nameMatches: onName.matches, pathMatches: null };
		}
		const folder = folderOf(file);
		const full = folder ? `${folder}/${name}` : name;
		const onPath = fuzzy(full);
		if (!onPath) return null;
		const cut = folder ? folder.length + 1 : 0;
		return { score: onPath.score, onName: false, ...splitMatches(onPath.matches, folder.length, cut) };
	};
}

/**
 * Rows for notes whose `aliases` match `query`, one per matching alias. Not for a path
 * query — an alias has no folder to match — and not for an alias that only repeats the
 * note's own name, which its file row already shows.
 */
function aliasMatcher(query: string, aliasesOf: (file: TFile) => string[]): (files: TFile[], recent: boolean) => Scored[] {
	const fuzzy = prepareFuzzySearch(query);
	const pathOnly = query.includes("/");
	return (files, recent) => {
		if (pathOnly) return [];
		const rows: Scored[] = [];
		for (const file of files) {
			const name = displayName(file);
			for (const alias of new Set(aliasesOf(file))) {
				if (alias === name) continue;
				const result = fuzzy(alias);
				if (!result) continue;
				rows.push({
					item: { kind: "file", file, recent, alias, nameMatches: result.matches, pathMatches: null },
					match: { score: result.score, onName: true, nameMatches: result.matches, pathMatches: null },
				});
			}
		}
		return rows;
	};
}

function scoreAll(files: TFile[], match: (file: TFile) => Match | null, recent: boolean): Scored[] {
	return files.flatMap((file) => {
		const result = match(file);
		if (!result) return [];
		return [{ item: { kind: "file" as const, file, recent, nameMatches: result.nameMatches, pathMatches: result.pathMatches }, match: result }];
	});
}

function compare(a: Scored, b: Scored): number {
	if (a.match.onName !== b.match.onName) return a.match.onName ? -1 : 1;
	return b.match.score - a.match.score;
}

/**
 * Split ranges over `folder/name` into the folder's and the name's (offset to start at the
 * name). `folderEnd` is where the folder ends, `nameStart` where the name begins.
 */
function splitMatches(
	matches: SearchMatches,
	folderEnd: number,
	nameStart: number,
): { nameMatches: SearchMatches; pathMatches: SearchMatches } {
	const nameMatches: SearchMatches = [];
	const pathMatches: SearchMatches = [];
	for (const [from, to] of matches) {
		if (from < folderEnd) pathMatches.push([from, Math.min(to, folderEnd)]);
		if (to > nameStart) nameMatches.push([Math.max(from, nameStart) - nameStart, to - nameStart]);
	}
	return { nameMatches, pathMatches };
}

// --- Rows -----------------------------------------------------------------------------------

function lineItem(rest: string): LineItem {
	const at = /^(\d+)(?::(\d+))?/.exec(rest.trim());
	return { kind: "line", line: at?.[1] ? Number(at[1]) : null, column: at?.[2] ? Number(at[2]) : undefined };
}

function renderHeading(item: HeadingItem, el: HTMLElement): void {
	const { heading } = item;
	setIcon(el.createDiv({ cls: "quick-open-icon" }), `heading-${Math.min(Math.max(heading.level, 1), 6)}`);
	const text = el.createDiv({ cls: "quick-open-text" });
	text.style.setProperty("--quick-open-indent", String(heading.level - 1));
	text.addClass("is-indented");
	renderMatches(text.createSpan({ cls: "quick-open-name" }), heading.heading, item.matches);
	text.createSpan({ cls: "quick-open-path", text: `line ${heading.position.start.line + 1}` });
}

/** Notes by their name alone, as everywhere else in Obsidian; other files with their extension. */
function displayName(file: TFile): string {
	return file.extension === "md" ? file.basename : file.name;
}

/** The folder a file is in, or "" at the vault root. */
function folderOf(file: TFile): string {
	const parent = file.parent?.path ?? "/";
	return parent === "/" ? "" : parent;
}

const IMAGE = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "avif"]);
const AUDIO = new Set(["mp3", "wav", "m4a", "ogg", "flac", "webm", "3gp"]);
const VIDEO = new Set(["mp4", "mov", "mkv", "ogv"]);

function iconFor(file: TFile): string {
	const ext = file.extension.toLowerCase();
	if (ext === "md") return "file-text";
	if (ext === "canvas") return "layout-dashboard";
	if (ext === "base") return "table";
	if (ext === "pdf") return "file-type";
	if (IMAGE.has(ext)) return "image";
	if (AUDIO.has(ext)) return "file-audio";
	if (VIDEO.has(ext)) return "file-video";
	return "file";
}
