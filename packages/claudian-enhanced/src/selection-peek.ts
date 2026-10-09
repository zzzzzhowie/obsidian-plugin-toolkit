import { setIcon } from "obsidian";

/** The selection the composer carries, as far as the peek needs it. */
export interface PeekSelection {
	notePath: string;
	selectedText: string;
	startLine?: number;
	lineCount: number;
}

/** Claudian's chip for the editor 划词 in the composer's context row. */
const CHIP = '.claudian-context-chip[data-context-slot="editor-selection"]';
/** The tag under a sent prompt naming the lines it went with (main.ts, tagSentSelections). */
const TAG = ".claudian-enhanced-selection-tag";
const PEEK_CLS = "claudian-enhanced-peek";
const SHOW_DELAY_MS = 150;
const HIDE_DELAY_MS = 200;
/** How much of a long selection is shown: a glance at it, not the whole of it. */
const MAX_LINES = 8;
const MAX_CHARS = 500;
const MAX_LINE_CHARS = 120;

/**
 * What a hovered "N lines selected" chip is about, the way Claude's apps show a quoted reply:
 * a card with where it's from and the text behind a quote bar. Claudian's chip only repeats its
 * own label as a tooltip, so there was no seeing what would go with the prompt short of going
 * back to the note. A long selection is cut to its first lines with a count of the rest; the
 * card stays open while the pointer is over it, to scroll what is shown.
 *
 * A sent prompt's line tag shows the same card, on hover, for the selection the prompt went
 * with; a click on the tag, or on the card's heading, goes to those lines.
 */
export class SelectionPeek {
	private card: HTMLElement | null = null;
	/** The chip or tag the card is for. */
	private chip: HTMLElement | null = null;
	private showTimer: number | null = null;
	private hideTimer: number | null = null;

	constructor(
		private readonly root: () => HTMLElement | null,
		private readonly selection: () => PeekSelection | null,
		private readonly focusComposer: () => void,
		/** The selection a sent prompt's tag stands for. */
		private readonly tagSelection: (tag: HTMLElement) => PeekSelection | null,
		/** Go to a sent selection's lines in its note. */
		private readonly openSelection: (selection: PeekSelection) => void,
	) {}

	/**
	 * From a capture-phase `mousedown` on the document. A press on the chip or the card sends
	 * focus to the composer instead of letting it drop to <body>. Neither takes focus itself —
	 * the card hangs off <body>, the chip is plain markup — so a click on either left focus in
	 * neither the note nor Claudian, which is where Claudian lets a selection go: the chip
	 * vanished a moment after it or the card was clicked. In the composer the selection is
	 * kept, as it is whenever you've gone there to write the prompt it goes with.
	 */
	onMouseDown(evt: MouseEvent): void {
		const el = evt.target instanceof Element ? evt.target : null;
		if (!el) return;
		// A sent prompt's card is about history, not the composer's selection: nothing to keep.
		if (this.chip?.matches(TAG)) return;
		const onCard = this.card?.contains(el) ?? false;
		const chip = el.closest<HTMLElement>(CHIP);
		if (!onCard && !(chip && this.root()?.contains(chip))) return;
		evt.preventDefault();
		this.focusComposer();
	}

	/** From a capture-phase `pointerover` on the document. */
	onPointerOver(target: EventTarget | null): void {
		const el = target instanceof Element ? target : null;
		if (el && this.card?.contains(el)) {
			this.cancelHide();
			return;
		}
		const chip = this.anchorOf(el);
		if (!chip) {
			if (this.chip || this.card) this.scheduleHide();
			return;
		}
		this.cancelHide();
		if (chip === this.chip && this.card) return;
		// Its own tooltip would only say "1 line selected" over the card. Taken off before
		// Obsidian's tooltip sees the pointer (pointer events come ahead of mouse events);
		// Claudian puts it back whenever it redraws the chip.
		chip.querySelectorAll("[aria-label]").forEach((labelled) => labelled.removeAttribute("aria-label"));
		this.chip = chip;
		this.clearShow();
		this.showTimer = window.setTimeout(() => this.show(chip), SHOW_DELAY_MS);
	}

	/** From a capture-phase `click` on the document: a click on a prompt's tag goes to its lines. */
	onClick(evt: MouseEvent): void {
		const el = evt.target instanceof Element ? evt.target : null;
		const tag = el?.closest<HTMLElement>(TAG) ?? null;
		if (!tag || !this.root()?.contains(tag)) return;
		const selection = this.tagSelection(tag);
		if (!selection) return;
		this.hide();
		this.openSelection(selection);
	}

	hide(): void {
		this.clearShow();
		this.cancelHide();
		this.card?.remove();
		this.card = null;
		this.chip = null;
	}

	/** The composer's chip or a prompt's tag `el` is in, inside Claudian's view. */
	private anchorOf(el: Element | null): HTMLElement | null {
		const anchor = el?.closest<HTMLElement>(CHIP) ?? el?.closest<HTMLElement>(TAG) ?? null;
		return anchor && this.root()?.contains(anchor) ? anchor : null;
	}

	private show(chip: HTMLElement): void {
		this.showTimer = null;
		const fromTag = chip.matches(TAG);
		const selection = fromTag ? this.tagSelection(chip) : this.selection();
		if (!selection?.selectedText.trim() || !chip.isConnected) return;
		this.card?.remove();
		const card = chip.doc.body.createDiv({ cls: PEEK_CLS });
		const head = card.createDiv({ cls: `${PEEK_CLS}-head` });
		setIcon(head.createSpan({ cls: `${PEEK_CLS}-icon` }), "text-select");
		const whereEl = head.createSpan({ cls: `${PEEK_CLS}-where`, text: where(selection) });
		if (fromTag) {
			whereEl.addClass("is-link");
			whereEl.addEventListener("click", () => {
				this.hide();
				this.openSelection(selection);
			});
		}
		const { body, more } = condense(selection.selectedText);
		card.createDiv({ cls: `${PEEK_CLS}-quote`, text: body });
		if (more > 0) {
			card.createDiv({ cls: `${PEEK_CLS}-more`, text: more === 1 ? "+1 more line" : `+${more} more lines` });
		}
		this.card = card;
		place(card, chip);
	}

	private scheduleHide(): void {
		if (this.hideTimer !== null) return;
		this.clearShow();
		this.hideTimer = window.setTimeout(() => {
			this.hideTimer = null;
			this.hide();
		}, HIDE_DELAY_MS);
	}

	private cancelHide(): void {
		if (this.hideTimer === null) return;
		window.clearTimeout(this.hideTimer);
		this.hideTimer = null;
	}

	private clearShow(): void {
		if (this.showTimer === null) return;
		window.clearTimeout(this.showTimer);
		this.showTimer = null;
	}
}

/** "Untitled · L25", "Untitled · L76–146". */
function where(selection: PeekSelection): string {
	const note = selection.notePath.split("/").pop()?.replace(/\.md$/, "") ?? selection.notePath;
	if (!selection.startLine) return note;
	const end = selection.startLine + Math.max(1, selection.lineCount) - 1;
	return `${note} · ${end === selection.startLine ? `L${selection.startLine}` : `L${selection.startLine}–${end}`}`;
}

/**
 * The start of a selection, short enough to take in at a glance: its first lines, each cut at
 * a length that still wraps to a few lines, blank runs closed up, and how many lines are left.
 */
function condense(text: string): { body: string; more: number } {
	const lines = text
		.replace(/\r\n?/g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.replace(/^\n+|\n+$/g, "")
		.split("\n");
	const kept: string[] = [];
	let chars = 0;
	for (const line of lines) {
		if (kept.length >= MAX_LINES || chars >= MAX_CHARS) break;
		const room = Math.min(MAX_LINE_CHARS, MAX_CHARS - chars);
		const cut = line.length > room ? `${line.slice(0, room).trimEnd()}…` : line;
		kept.push(cut);
		chars += cut.length;
	}
	return { body: kept.join("\n"), more: lines.length - kept.length };
}

/** Above the chip, its left edges together; below it when there's no room above. */
function place(card: HTMLElement, chip: HTMLElement): void {
	const win = chip.win;
	const gap = 8;
	const anchor = chip.getBoundingClientRect();
	const box = card.getBoundingClientRect();
	const left = Math.max(gap, Math.min(anchor.left, win.innerWidth - box.width - gap));
	const above = anchor.top - box.height - gap;
	const top = above >= gap ? above : Math.min(anchor.bottom + gap, win.innerHeight - box.height - gap);
	card.style.left = `${left}px`;
	card.style.top = `${top}px`;
}
