/**
 * The conversation's outline, at the top left of its message list, as Claude's own app marks
 * the chapters of a session: a dash per prompt, the one being read darker and longer. Hovered,
 * it opens into the list of prompts, each by its first words; hovering one shows its turn —
 * the list goes there and everything else in it fades back — and choosing it stays there.
 * Leaving without choosing puts the list back where it was.
 *
 * Claudian has a list of its own (the "Conversation directory" on the right), which only
 * jumps; this one shows where a prompt is before going to it.
 */

const NAV_CLS = "claudian-enhanced-prompt-nav";
const DASH_CLS = `${NAV_CLS}-dash`;
/** On a message list while a prompt in the outline is hovered: all but that turn fade back. */
const SPOTLIGHT_CLS = "claudian-enhanced-spotlight";
/** On the messages of the turn being shown. */
const SPOTLIT_CLS = "claudian-enhanced-spotlit";
/** Dashes in the outline at most: those around the prompt being read, in a long conversation. */
const MAX_DASHES = 8;

const USER_MESSAGE = ".claudian-message-user";

/** What the outline asks of the plugin, which owns the list's scrolling and its following. */
export interface PromptNavHost {
	/** Bring `prompt`'s turn to the top of the list, as the plugin's own move, not the reader's. */
	preview(scroller: HTMLElement, prompt: HTMLElement): void;
	/** Put the list back at `top`, following the stream again if it was. */
	restore(scroller: HTMLElement, top: number, wasFollowing: boolean): void;
	/** The reader chose a prompt: where the list is now is theirs. */
	commit(scroller: HTMLElement): void;
	isFollowing(scroller: HTMLElement): boolean;
}

export class PromptNav {
	readonly el: HTMLElement;
	private readonly rail: HTMLElement;
	private menu: HTMLElement | null = null;
	/** The rail as last drawn: how many prompts, and which was being read. */
	private drawn = "";
	/**
	 * Where the list was when the outline opened, to go back to: the message at the top of the
	 * view and how far into it the view was. Not the scroll offset alone: a reply out of sight
	 * stands in at an estimated height (styles.css), and the turns shown on the way are drawn at
	 * their own, so the same offset no longer lands on the same text.
	 */
	private opened: {
		top: number;
		anchor: HTMLElement | null;
		offset: number;
		following: boolean;
		moved: boolean;
	} | null = null;
	private spotlit: HTMLElement[] = [];

	constructor(
		private readonly scroller: HTMLElement,
		wrapper: HTMLElement,
		private readonly host: PromptNavHost,
	) {
		this.el = wrapper.createDiv({ cls: NAV_CLS });
		this.rail = this.el.createDiv({ cls: `${NAV_CLS}-rail` });
		this.el.addEventListener("mouseenter", () => this.open());
		this.el.addEventListener("mouseleave", () => this.close(false));
	}

	/** Draw the rail for `count` prompts with the one at `current` being read; only on change. */
	sync(count: number, current: number): void {
		const key = `${count}:${current}`;
		if (key === this.drawn) return;
		this.drawn = key;
		this.el.toggleClass("is-shown", count >= 2);
		this.rail.empty();
		const start = Math.max(0, Math.min(current - Math.floor(MAX_DASHES / 2), count - MAX_DASHES));
		for (let i = start; i < Math.min(count, start + MAX_DASHES); i++) {
			this.rail.createDiv({ cls: i === current ? `${DASH_CLS} is-current` : DASH_CLS });
		}
	}

	destroy(): void {
		this.close(false);
		this.el.remove();
	}

	private open(): void {
		if (this.menu) return;
		const prompts = Array.from(this.scroller.querySelectorAll<HTMLElement>(`:scope > ${USER_MESSAGE}`));
		if (prompts.length < 2) return;
		const anchor = this.topMessage();
		this.opened = {
			top: this.scroller.scrollTop,
			anchor,
			offset: anchor ? anchor.getBoundingClientRect().top - this.scroller.getBoundingClientRect().top : 0,
			following: this.host.isFollowing(this.scroller),
			moved: false,
		};
		const current = Number(this.drawn.split(":")[1] ?? 0);
		const menu = this.el.createDiv({ cls: `${NAV_CLS}-menu` });
		// As wide as its longest prompt, within the list.
		menu.setCssProps({ "max-width": `${Math.max(160, (this.el.parentElement?.clientWidth ?? 320) - 24)}px` });
		let currentItem: HTMLElement | null = null;
		prompts.forEach((prompt, i) => {
			const item = menu.createDiv({ cls: `${NAV_CLS}-item`, attr: { role: "button" } });
			item.createDiv({ cls: i === current ? `${DASH_CLS} is-current` : DASH_CLS });
			item.createDiv({ cls: `${NAV_CLS}-item-text`, text: firstWords(prompt) });
			item.addEventListener("mouseenter", () => this.show(prompt));
			item.addEventListener("click", (event) => {
				event.preventDefault();
				this.show(prompt);
				this.close(true);
			});
			if (i === current) currentItem = item;
		});
		this.menu = menu;
		// The prompt being read in the middle of a long list. Set by hand: scrollIntoView would
		// move whatever else around it scrolls too.
		const item = currentItem as HTMLElement | null;
		if (item) menu.scrollTop = item.offsetTop - (menu.clientHeight - item.offsetHeight) / 2;
	}

	/** Show `prompt`'s turn: the list goes there, and the rest of it fades back. */
	private show(prompt: HTMLElement): void {
		if (!prompt.isConnected) return;
		this.clearSpotlight();
		const turn: HTMLElement[] = [prompt];
		for (let el = prompt.nextElementSibling; el && !el.matches(USER_MESSAGE); el = el.nextElementSibling) {
			if (el instanceof HTMLElement) turn.push(el);
		}
		for (const el of turn) el.addClass(SPOTLIT_CLS);
		this.scroller.addClass(SPOTLIGHT_CLS);
		this.spotlit = turn;
		this.host.preview(this.scroller, prompt);
		if (this.opened) this.opened.moved = true;
	}

	private close(chosen: boolean): void {
		this.clearSpotlight();
		this.menu?.remove();
		this.menu = null;
		const opened = this.opened;
		this.opened = null;
		if (!opened?.moved) return;
		if (chosen) this.host.commit(this.scroller);
		else this.host.restore(this.scroller, this.openedTop(opened), opened.following);
	}

	/** The first message reaching into the view, other than a prompt: a stuck one isn't where it lies. */
	private topMessage(): HTMLElement | null {
		const top = this.scroller.getBoundingClientRect().top;
		for (const el of Array.from(this.scroller.children)) {
			if (el instanceof HTMLElement && !el.matches(USER_MESSAGE) && el.getBoundingClientRect().bottom > top) return el;
		}
		return null;
	}

	/** Where the list now has to be for its top message to sit where it did. */
	private openedTop(opened: NonNullable<PromptNav["opened"]>): number {
		const { anchor } = opened;
		if (!anchor?.isConnected) return opened.top;
		const at = anchor.getBoundingClientRect().top - this.scroller.getBoundingClientRect().top;
		return this.scroller.scrollTop + at - opened.offset;
	}

	private clearSpotlight(): void {
		for (const el of this.spotlit) el.removeClass(SPOTLIT_CLS);
		this.spotlit = [];
		this.scroller.removeClass(SPOTLIGHT_CLS);
	}
}

/** A prompt by its first words, as one line. */
function firstWords(prompt: HTMLElement): string {
	const text = prompt.querySelector(".claudian-text-block")?.textContent ?? prompt.textContent ?? "";
	return text.replace(/\s+/g, " ").trim().slice(0, 120);
}
