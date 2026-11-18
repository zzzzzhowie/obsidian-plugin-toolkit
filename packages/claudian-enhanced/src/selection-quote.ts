/** A conversation tab, as far as the quote needs it: its composer's context row and its 划词. */
export interface QuoteTab {
	dom?: { contextRowEl?: HTMLElement };
	controllers?: {
		composerSelections?: { editor?: { storedSelection?: { notePath: string; selectedText: string } | null } };
		selectionController?: { storedSelection?: { notePath: string; selectedText: string } | null };
	};
}

/** Claudian's chip for the editor 划词 in the composer's context row. */
const CHIP = '.claudian-context-chip[data-context-slot="editor-selection"]';
export const QUOTE_CLS = "claudian-enhanced-quote";
/** On the context row while the quote stands in for its 划词 chip, which styles.css hides then. */
const QUOTED_CLS = "claudian-enhanced-quoted";
/** How much of the end of the selection stays in sight; the rest of it gives way to an ellipsis. */
const TAIL_CHARS = 8;

/**
 * What the 划词 in the composer says, in place of its "N lines selected" chip: the selected
 * text in quotes behind a dotted bar, on one line — its start and its end, an ellipsis where
 * the middle doesn't fit. Claudian redraws its context row whenever its items change; the chip
 * is kept there, hidden, and the quote put back each time (sync), going with it.
 */
export class SelectionQuote {
	/** The quote shown under each context row, with what it says, so a redraw that changes nothing leaves it be. */
	private readonly cards = new Map<HTMLElement, { card: HTMLElement; key: string }>();

	/** Put each tab's quote where it should be, or take it away: for every conversation tab. */
	sync(tabs: readonly QuoteTab[]): void {
		const rows = new Set<HTMLElement>();
		for (const tab of tabs) {
			const row = tab.dom?.contextRowEl;
			if (!row) continue;
			rows.add(row);
			const selection = tab.controllers?.composerSelections?.editor?.storedSelection ?? tab.controllers?.selectionController?.storedSelection ?? null;
			if (row.querySelector(CHIP) && selection?.selectedText.trim()) this.show(row, selection.notePath, selection.selectedText);
			else this.drop(row);
		}
		for (const row of Array.from(this.cards.keys())) if (!rows.has(row) || !row.isConnected) this.drop(row);
	}

	clear(): void {
		for (const row of Array.from(this.cards.keys())) this.drop(row);
	}

	private show(row: HTMLElement, notePath: string, text: string): void {
		row.addClass(QUOTED_CLS);
		const key = `${notePath}\n${text}`;
		const shown = this.cards.get(row);
		if (shown && shown.key === key && shown.card.isConnected && shown.card.previousElementSibling === row) return;
		shown?.card.remove();
		// On one line: its start, cut with an ellipsis where it runs out of room, then its end.
		const flat = text.replace(/\s+/g, " ").trim();
		const tail = flat.length > TAIL_CHARS * 2 ? flat.slice(-TAIL_CHARS) : "";
		const card = row.doc.createElement("div");
		card.className = QUOTE_CLS;
		card.createSpan({ cls: `${QUOTE_CLS}-start`, text: `“${tail ? flat.slice(0, -TAIL_CHARS) : flat}${tail ? "" : "”"}` });
		if (tail) card.createSpan({ cls: `${QUOTE_CLS}-end`, text: `${tail}”` });
		row.after(card);
		this.cards.set(row, { card, key });
	}

	private drop(row: HTMLElement): void {
		row.removeClass(QUOTED_CLS);
		this.cards.get(row)?.card.remove();
		this.cards.delete(row);
	}
}
