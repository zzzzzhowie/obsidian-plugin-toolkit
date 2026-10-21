import { type App, Scope, setIcon } from "obsidian";

import {
	clearHighlights,
	collectDomText,
	findInText,
	highlightApiAvailable,
	paint,
	rangeFor,
} from "../../../shared/dom-find";

const BAR = "claudian-find";
/** This bar's highlights, styled in styles.css. */
const MATCH_HIGHLIGHT = "claudian-find-match";
const CURRENT_HIGHLIGHT = "claudian-find-current";
/** Held off while typing, and while a reply streams in. */
const SEARCH_DELAY_MS = 120;

interface ConversationFindHooks {
	/** The conversation's message list on screen. */
	scroller: () => HTMLElement | null;
	/** Unfold a folded prompt a match sits in. */
	unfold: (prompt: HTMLElement) => void;
	/** Where focus goes when the bar closes. */
	refocus: () => void;
	/** Claudian view's own key scope, which the bar's sits on top of. */
	parentScope: () => Scope | null;
}

/**
 * Find in the conversation, the way Sticky Find finds in a note — the same bar, the same
 * keys. Claudian has no find of its own, and Obsidian's goes to the note. The rendered
 * messages are searched as text and the matches painted with the CSS Custom Highlight API,
 * so nothing in Claudian's DOM changes. Only text you can see counts: a collapsed tool
 * output is left out; a match in a folded long prompt unfolds it when it's the one shown.
 * A reply streaming in is searched again as it grows, staying on the match you were at.
 */
export class ConversationFind {
	private bar: HTMLElement | null = null;
	private input: HTMLInputElement | null = null;
	private counter: HTMLElement | null = null;
	private caseButton: HTMLElement | null = null;
	private caseSensitive = false;
	private ranges: Range[] = [];
	private current = 0;
	private observer: MutationObserver | null = null;
	private timer: number | null = null;
	private composing = false;
	/** Escape's scope while the bar is open; see open. */
	private scope: Scope | null = null;

	constructor(
		private readonly app: App,
		private readonly hooks: ConversationFindHooks,
	) {}

	get isOpen(): boolean {
		return this.bar?.isConnected ?? false;
	}

	/** Whether an event's target is in the bar. */
	contains(target: EventTarget | null): boolean {
		return target instanceof Node && !!this.bar?.contains(target);
	}

	open(seed?: string): void {
		const scroller = this.hooks.scroller();
		const host = scroller?.parentElement;
		if (!scroller || !host) return;
		if (!this.isOpen || this.bar?.parentElement !== host) this.build(host);
		if (seed) this.input!.value = seed;
		this.input!.focus();
		this.input!.select();
		this.watch(scroller);
		this.search(false);
		// Escape closes the bar before anything else hears it. Claudian's view takes Escape
		// through Obsidian's keymap — closing its menus, else stopping a running reply — which
		// answers ahead of any listener on the page; so the bar's Escape is a scope on top of
		// Claudian's, and a reply running is stopped by the next Escape, the bar gone. Keys the
		// bar doesn't take fall through to Claudian's scope.
		if (!this.scope) {
			this.scope = new Scope(this.hooks.parentScope() ?? this.app.scope);
			this.scope.register([], "Escape", () => {
				this.close();
				return false;
			});
			this.app.keymap.pushScope(this.scope);
		}
	}

	close(): void {
		if (this.scope) this.app.keymap.popScope(this.scope);
		this.scope = null;
		if (this.timer !== null) window.clearTimeout(this.timer);
		this.timer = null;
		this.observer?.disconnect();
		this.observer = null;
		this.bar?.remove();
		this.bar = null;
		this.ranges = [];
		clearHighlights(MATCH_HIGHLIGHT, CURRENT_HIGHLIGHT);
		this.hooks.refocus();
	}

	private build(host: HTMLElement): void {
		this.bar?.remove();
		const bar = host.createDiv({ cls: `${BAR}-bar` });
		this.input = bar.createEl("input", {
			cls: `${BAR}-input`,
			attr: { type: "text", placeholder: "Find in conversation", spellcheck: "false" },
		});
		this.counter = bar.createSpan({ cls: `${BAR}-counter`, text: "0/0" });
		// clickable-icon, as the arrows: without it Obsidian's button fill made Aa look on while off.
		this.caseButton = bar.createEl("button", {
			cls: `${BAR}-button ${BAR}-case clickable-icon`,
			text: "Aa",
			attr: { "aria-label": "Match case", "aria-pressed": String(this.caseSensitive) },
		});
		this.caseButton.toggleClass("is-active", this.caseSensitive);
		this.caseButton.addEventListener("click", () => {
			this.caseSensitive = !this.caseSensitive;
			this.caseButton?.toggleClass("is-active", this.caseSensitive);
			this.caseButton?.setAttribute("aria-pressed", String(this.caseSensitive));
			this.search(false);
		});
		this.iconButton(bar, "chevron-up", "Previous match", () => this.step(-1));
		this.iconButton(bar, "chevron-down", "Next match", () => this.step(1));
		this.iconButton(bar, "x", "Close", () => this.close());

		// An IME's in-between states aren't the query.
		this.input.addEventListener("compositionstart", () => (this.composing = true));
		this.input.addEventListener("compositionend", () => {
			this.composing = false;
			this.schedule(false);
		});
		this.input.addEventListener("input", () => {
			if (!this.composing) this.schedule(false);
		});
		this.input.addEventListener("keydown", (evt) => {
			if (evt.isComposing) return;
			if (evt.key === "Enter" || evt.key === "ArrowDown" || evt.key === "ArrowUp") {
				evt.preventDefault();
				this.step(evt.key === "ArrowUp" || (evt.key === "Enter" && evt.shiftKey) ? -1 : 1);
			} else if (evt.key === "Escape") {
				evt.preventDefault();
				evt.stopPropagation();
				this.close();
			}
		});
		this.bar = bar;
		if (!highlightApiAvailable()) this.counter.setText("—");
	}

	private iconButton(bar: HTMLElement, icon: string, label: string, onClick: () => void): void {
		const button = bar.createEl("button", { cls: `${BAR}-button clickable-icon`, attr: { "aria-label": label } });
		setIcon(button, icon);
		button.addEventListener("click", onClick);
	}

	/** Search again as the conversation changes — a reply streaming in, a message edited. */
	private watch(scroller: HTMLElement): void {
		this.observer?.disconnect();
		this.observer = new MutationObserver((records) => {
			if (records.every((record) => this.contains(record.target))) return;
			this.schedule(true);
		});
		this.observer.observe(scroller, { childList: true, subtree: true, characterData: true });
	}

	private schedule(keepPlace: boolean): void {
		if (this.timer !== null) window.clearTimeout(this.timer);
		this.timer = window.setTimeout(() => {
			this.timer = null;
			this.search(keepPlace);
		}, SEARCH_DELAY_MS);
	}

	/**
	 * Find the query in what's on screen. Kept on the match you were at when the conversation
	 * changed under you; else the first match from the top of the view.
	 */
	private search(keepPlace: boolean): void {
		const scroller = this.hooks.scroller();
		const query = this.input?.value ?? "";
		if (!scroller || !query) {
			this.ranges = [];
			this.render(false);
			return;
		}
		const was = keepPlace ? this.ranges[this.current]?.getBoundingClientRect().top : undefined;
		const dom = collectDomText(scroller);
		this.ranges = findInText(dom.text, query, this.caseSensitive)
			.map((match) => rangeFor(dom, match.from, match.to))
			.filter((range): range is Range => range !== null && range.getClientRects().length > 0);
		const top = was ?? scroller.getBoundingClientRect().top;
		const near = this.ranges.findIndex((range) => range.getBoundingClientRect().top >= top - 1);
		this.current = near < 0 ? 0 : near;
		this.render(!keepPlace);
	}

	private step(by: number): void {
		const count = this.ranges.length;
		if (count === 0) return;
		this.current = (((this.current + by) % count) + count) % count;
		this.render(true);
	}

	/** Paint the matches and the current one, and bring the current one into view. */
	private render(scroll: boolean): void {
		const count = this.ranges.length;
		const query = this.input?.value ?? "";
		this.bar?.toggleClass("is-empty", query.length > 0 && count === 0);
		this.counter?.setText(`${count === 0 ? 0 : this.current + 1}/${count}`);
		const current = this.ranges[this.current];
		paint(MATCH_HIGHLIGHT, this.ranges.filter((range) => range !== current));
		paint(CURRENT_HIGHLIGHT, current ? [current] : []);
		if (current && scroll) this.reveal(current);
	}

	/** Unfold a folded prompt the match is in, then scroll it to a third of the way down. */
	private reveal(range: Range): void {
		const node = range.startContainer;
		const el = node instanceof Element ? node : node.parentElement;
		const folded = el?.closest<HTMLElement>(".claudian-enhanced-folded");
		if (folded) this.hooks.unfold(folded);
		const scroller = this.hooks.scroller();
		if (!scroller) return;
		const box = scroller.getBoundingClientRect();
		const at = range.getBoundingClientRect();
		if (at.top >= box.top + 40 && at.bottom <= box.bottom - 40) return;
		scroller.scrollTop += at.top - box.top - box.height / 3;
	}
}
