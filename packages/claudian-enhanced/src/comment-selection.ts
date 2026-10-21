import type { App } from "obsidian";

/** A comment's rendered body: Note Comments' hover card, or its item in the panel. */
const COMMENT_BODY = ".nc-hover .nc-hover-body, .nc-panel-item .nc-panel-body";
/** The comment around a body, carrying its note and id (see Note Comments' hover and panel). */
const COMMENT = "[data-nc-path][data-nc-id]";
const NOTE_COMMENTS = "note-comments";
const CHIP_ID = "browser-selection";
/** The passage a comment is on, shortened for the prompt's title. */
const QUOTE_CHARS = 80;
/** Selection changes come one per character while dragging; the last one counts. */
const SETTLE_MS = 120;

/** What Claudian's browser channel carries: any text, named by where it came from. */
interface CarriedSelection {
	source: string;
	selectedText: string;
	title?: string;
	url?: string;
}

interface ContextTrayItem {
	id: string;
	kind: "selection";
	label: string;
	icon: string;
	ariaLabel: string;
	onRemove: () => void;
}

/**
 * Claudian's per-tab controller for a selection in a web view. It has the only channel that
 * takes plain text with a source of its own — `<browser_selection source=… title=…>` in the
 * prompt, a chip under the composer — so a comment's text rides in it. Its own poll drops
 * whatever it holds when the front leaf isn't a web view; held back while a comment is in it.
 */
interface BrowserSelectionController {
	storedSelection: CarriedSelection | null;
	poll?: () => Promise<void>;
	updateIndicator?: () => void;
	clear?: () => void;
	onUserSelectionChanged?: (() => void) | null;
	contextTray?: {
		setItems?: (id: string, items: ContextTrayItem[]) => void;
		clearItems?: (id: string) => void;
	};
}

/** A tab's selections: `capture` is what a prompt goes with, read as it is sent. */
interface ComposerSelections {
	browser?: BrowserSelectionController;
	capture?: () => unknown;
}

export interface CommentSelectionTab {
	controllers?: { composerSelections?: ComposerSelections };
}

interface CommentStoreLike {
	get?: (path: string, id: string) => { exact?: string } | undefined;
}

/**
 * Text selected in a note comment goes to Claudian as the 划词 does from a note: a chip
 * under the composer ("N lines from a comment"), the text with the prompt. A comment's card
 * is gone by the time you're in the composer, so the selection is carried, not read live:
 * it stays until it's sent (once, as Claudian's chips go), its chip's × is clicked, Esc is
 * pressed, or something else is selected or clicked outside Claudian and the comments.
 */
export class CommentSelection {
	/** The carried selections, by identity: a controller holding one of these is ours to keep. */
	private readonly carried = new WeakSet<CarriedSelection>();
	/** Controllers given our poll, chip and capture; restored on unload. */
	private readonly patched = new Set<ComposerSelections>();
	private timer: number | null = null;

	constructor(
		private readonly app: App,
		private readonly hooks: {
			/** The active tab of each Claudian view open. */
			tabs: () => CommentSelectionTab[];
			/** Whether an element is in a Claudian view. */
			inClaudian: (el: Element) => boolean;
		},
	) {}

	readonly onSelectionChange = (): void => {
		if (this.timer !== null) window.clearTimeout(this.timer);
		this.timer = window.setTimeout(() => {
			this.timer = null;
			this.read();
		}, SETTLE_MS);
	};

	/** A press anywhere but Claudian and the comments lets go of the carried text. */
	readonly onPointerDown = (evt: PointerEvent): void => {
		const target = evt.target instanceof Element ? evt.target : null;
		if (!target || this.hooks.inClaudian(target) || target.closest(".nc-hover, .nc-panel-item")) return;
		this.release();
	};

	/** Esc lets go of it, as it does of the 划词. */
	readonly onEscape = (evt: KeyboardEvent): void => {
		if (evt.key === "Escape" && !evt.isComposing) this.release();
	};

	destroy(): void {
		if (this.timer !== null) window.clearTimeout(this.timer);
		this.release();
		for (const selections of this.patched) {
			const own = selections as Record<string, unknown>;
			delete own.capture;
			const browser = selections.browser as Record<string, unknown> | undefined;
			delete browser?.poll;
			delete browser?.updateIndicator;
		}
		this.patched.clear();
	}

	/**
	 * The end of a drag: read now. Let go outside the card and Note Comments puts it away
	 * shortly, taking the selection with it — sooner than the settle delay can be relied on.
	 */
	readonly onPointerUp = (): void => {
		if (this.timer !== null) window.clearTimeout(this.timer);
		this.timer = null;
		this.read();
	};

	private read(): void {
		const selection = document.getSelection();
		if (!selection || selection.isCollapsed || selection.rangeCount === 0) return;
		const range = selection.getRangeAt(0);
		const body = this.commentBodyOf(range.startContainer) ?? this.commentBodyOf(range.endContainer);
		if (!body) {
			// Something else selected — unless it's in Claudian, where the composer is.
			const start = range.startContainer;
			const el = start instanceof Element ? start : start.parentElement;
			if (selection.toString().trim() && (!el || !this.hooks.inClaudian(el))) this.release();
			return;
		}
		// A drag that strays past the comment — onto its date, the card's edge, the note behind
		// it — still means the comment's text: the part of the selection inside it.
		const inside = range.cloneRange();
		if (!body.contains(inside.startContainer)) inside.setStart(body, 0);
		if (!body.contains(inside.endContainer)) inside.setEnd(body, body.childNodes.length);
		const text = inside.toString().trim();
		if (!text) return;
		const comment = body.closest<HTMLElement>(COMMENT);
		const path = comment?.dataset.ncPath ?? "";
		const id = comment?.dataset.ncId ?? "";
		this.carry({
			source: path ? `note-comment:${path}` : "note-comment",
			selectedText: text,
			title: this.titleFor(path, id),
		});
	}

	private commentBodyOf(node: Node | null): HTMLElement | null {
		const el = node instanceof Element ? node : node?.parentElement;
		return el?.closest<HTMLElement>(COMMENT_BODY) ?? null;
	}

	/** What the comment is on: `Comment on "<passage>" in <note>`. */
	private titleFor(path: string, id: string): string {
		const plugins = (this.app as unknown as { plugins?: { plugins?: Record<string, unknown> } }).plugins?.plugins;
		const store = (plugins?.[NOTE_COMMENTS] as { store?: CommentStoreLike } | undefined)?.store;
		const exact = (path && id ? store?.get?.(path, id)?.exact : undefined)?.replace(/\s+/g, " ").trim();
		const quote = exact ? ` on "${exact.length > QUOTE_CHARS ? `${exact.slice(0, QUOTE_CHARS)}…` : exact}"` : "";
		return `Comment${quote}${path ? ` in ${path}` : ""}`;
	}

	private carry(selection: CarriedSelection): void {
		for (const tab of this.hooks.tabs()) {
			const selections = tab.controllers?.composerSelections;
			const browser = selections?.browser;
			if (!selections || !browser || !("storedSelection" in browser)) continue;
			this.patch(selections, browser);
			const held = browser.storedSelection;
			if (held && this.carried.has(held) && held.selectedText === selection.selectedText) continue;
			const copy = { ...selection };
			this.carried.add(copy);
			browser.storedSelection = copy;
			browser.updateIndicator?.();
			browser.onUserSelectionChanged?.();
		}
	}

	private release(): void {
		for (const tab of this.hooks.tabs()) {
			const browser = tab.controllers?.composerSelections?.browser;
			const held = browser?.storedSelection;
			if (!browser || !held || !this.carried.has(held)) continue;
			browser.clear?.();
			browser.onUserSelectionChanged?.();
		}
	}

	/**
	 * Claudian's controller made to keep, show and give up our text — on the instance, so its
	 * own behaviour stays as it was for a web view's selection.
	 */
	private patch(selections: ComposerSelections, browser: BrowserSelectionController): void {
		if (this.patched.has(selections)) return;
		const proto = Object.getPrototypeOf(browser) as BrowserSelectionController;
		const carried = this.carried;
		const poll = proto.poll;
		const indicate = proto.updateIndicator;
		if (typeof poll !== "function" || typeof indicate !== "function") return;
		browser.poll = function (this: BrowserSelectionController) {
			// No web view in front: its poll would drop the comment's text at once.
			if (this.storedSelection && carried.has(this.storedSelection)) return Promise.resolve();
			return poll.call(this);
		};
		browser.updateIndicator = function (this: BrowserSelectionController) {
			const held = this.storedSelection;
			if (!held || !carried.has(held) || typeof this.contextTray?.setItems !== "function") {
				indicate.call(this);
				return;
			}
			const lines = held.selectedText.split(/\r?\n/).length;
			const label = `${lines} ${lines === 1 ? "line" : "lines"} from a comment`;
			this.contextTray.setItems(CHIP_ID, [
				{
					id: CHIP_ID,
					kind: "selection",
					label,
					icon: "message-square",
					ariaLabel: label,
					onRemove: () => {
						this.clear?.();
						this.onUserSelectionChanged?.();
					},
				},
			]);
		};
		const capture = (Object.getPrototypeOf(selections) as ComposerSelections).capture;
		if (typeof capture === "function") {
			selections.capture = function (this: ComposerSelections) {
				const captured = capture.call(this);
				// Gone with the prompt it was sent with, as the comment it came from is.
				const held = this.browser?.storedSelection;
				if (held && carried.has(held)) this.browser?.clear?.();
				return captured;
			};
		}
		this.patched.add(selections);
	}
}
