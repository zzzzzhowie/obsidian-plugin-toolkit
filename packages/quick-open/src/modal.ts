import { type App, Keymap, MarkdownView, Platform, SuggestModal } from "obsidian";

import type { FileHistory } from "./history";
import { goToLine, openFile, type OpenIn } from "./open";
import { renderItem } from "./rows";
import { type Item, Search } from "./search";

/**
 * Go to File, as VS Code's Cmd+P does it. What it finds is search.ts's, shared with the
 * new tab's search; this is the modal around it.
 *
 * - Enter opens, Cmd/Ctrl+Enter opens in a new tab (Obsidian's meaning, not VS Code's "to
 *   the side"). Each row also has buttons for opening to the side and, for a recent file,
 *   removing it from the list.
 * - Cmd/Ctrl+P again moves down the list; letting go of Cmd/Ctrl then opens what's selected,
 *   so holding Cmd and tapping P switches between recent files in one gesture.
 */

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

	private readonly search: Search;

	constructor(
		app: App,
		private readonly history: FileHistory,
	) {
		super(app);
		this.search = new Search(app, history);
		this.limit = 200;
		this.emptyStateText = "No matching results.";
		this.setPlaceholder("Search files by name (append : to go to line or @ to go to heading)");
		// Keyboard hints mean nothing on a touch screen.
		if (!Platform.isMobile) {
			this.setInstructions([
				{ command: "↑↓", purpose: "to navigate" },
				{ command: "↵", purpose: "to open" },
				{ command: `${MOD} ↵`, purpose: "to open in new tab" },
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
		return this.search.suggest(input, { limit: this.limit });
	}

	renderSuggestion(item: Item, el: HTMLElement): void {
		renderItem(
			this.app,
			item,
			el,
			{
				openToSide: (row) => {
					this.close();
					void openFile(this.app, row.file, "side", row.line, row.column);
				},
				remove: (row) => {
					this.history.remove(row.file.path);
					// Re-run the query so the row goes and the rest close up.
					this.refresh();
				},
			},
			{ labels: true },
		);
	}

	// --- Choosing --------------------------------------------------------------------------

	onChooseSuggestion(item: Item, evt: MouseEvent | KeyboardEvent): void {
		const where: OpenIn = Keymap.isModifier(evt, "Mod") ? "new-tab" : "current-group";
		// The modal is already closed, but nothing is painted until this task ends — and
		// opening a long note holds the main thread for a moment, which kept the closed modal
		// on screen until the note was ready. Let the close paint first: after the next frame.
		window.requestAnimationFrame(() => window.setTimeout(() => this.choose(item, where), 0));
	}

	private choose(item: Item, where: OpenIn): void {
		if (item.kind === "file") {
			void openFile(this.app, item.file, where, item.line, item.column);
			return;
		}
		const leaf = this.app.workspace.getActiveViewOfType(MarkdownView)?.leaf;
		if (!leaf) return;
		if (item.kind === "heading") goToLine(leaf, item.heading.position.start.line + 1);
		else if (item.line !== null) goToLine(leaf, item.line, item.column);
		this.app.workspace.setActiveLeaf(leaf, { focus: true });
	}
}
