/**
 * Claudian's `@` and `/` menus, in the new tab's search box.
 *
 * A question typed there for Claudian gets what Claudian's own composer offers: after `@`,
 * notes, folders and sessions to mention; after `/`, commands and skills. Not a copy of those
 * lists — Claudian (Enhanced) hands over the composer's own sources (`composerSources`), each
 * of which reads the text and caret, says whether its trigger is under the caret, lists what to
 * offer and says what choosing one inserts. This drives them against a plain input, as
 * Claudian's dropdown controller drives them against its editor.
 */

/** Where a source's trigger and its query sit in the text. */
export interface TriggerMatch {
	readonly atInputStart: boolean;
	readonly start: number;
	readonly end: number;
	readonly query: string;
	readonly trigger: string;
}

/** One row a source offers: something to insert, a folder to go into, or a note on loading. */
export interface SuggestItem {
	readonly kind: "value" | "folder" | "status";
	readonly id: string;
	readonly label: string;
	readonly detail?: string;
	readonly icon?: string;
	readonly disabled?: boolean;
	readonly replacement?: string;
	/** A folder that narrows the query in the text (`@folder/`). */
	readonly inputPrefix?: string;
	/** A folder that lists its own contents. */
	load?(query: string, signal: AbortSignal): readonly SuggestItem[] | Promise<readonly SuggestItem[]>;
}

type SelectionAction = { kind: "none" } | { kind: "invoke"; onApplied: () => void } | { kind: "replace"; text: string };

/** A source as Claudian's composer has it. */
export interface SuggestSource {
	readonly id: string;
	onOpen?(): void;
	match(input: string, cursor: number): TriggerMatch | null;
	load(match: TriggerMatch, signal: AbortSignal): readonly SuggestItem[] | Promise<readonly SuggestItem[]>;
	select(item: SuggestItem, match: TriggerMatch): SelectionAction;
}

/** What's on offer right now: from which source, for which match, and the rows. */
export interface ActiveSuggestions {
	readonly source: SuggestSource;
	readonly match: TriggerMatch;
	readonly items: readonly SuggestItem[];
}

export class ComposerSuggest {
	private current: ActiveSuggestions | null = null;
	/** A folder chosen without a prefix of its own: its rows replace the source's. */
	private folder: SuggestItem | null = null;
	private loading: AbortController | null = null;
	/** Dismissed with Escape at this match start; it stays closed until the trigger changes. */
	private dismissedAt: number | null = null;

	constructor(
		private readonly input: HTMLInputElement,
		private readonly sources: () => SuggestSource[] | null,
		private readonly changed: () => void,
	) {}

	get active(): ActiveSuggestions | null {
		return this.current;
	}

	/** Look under the caret again; reports whether a menu is open. */
	refresh(): boolean {
		const value = this.input.value;
		const cursor = this.input.selectionStart ?? value.length;
		let found: { source: SuggestSource; match: TriggerMatch } | null = null;
		for (const source of this.sources() ?? []) {
			const match = source.match(value, cursor);
			if (match) {
				found = { source, match };
				break;
			}
		}
		if (!found || found.match.start === this.dismissedAt) {
			if (!found) this.dismissedAt = null;
			this.reset();
			return false;
		}
		const { source, match } = found;
		if (this.current?.source !== source || this.current.match.start !== match.start) {
			this.folder = null;
			source.onOpen?.();
		}
		this.load(source, match);
		return true;
	}

	/** Choose row `index`: insert it, go into a folder, or let the source act. */
	choose(index: number): void {
		const current = this.current;
		const item = current?.items[index];
		if (!current || !item || item.kind === "status" || item.disabled) return;
		const { source, match } = current;
		if (item.kind === "folder") {
			if (item.inputPrefix !== undefined) {
				this.replace(match, `${match.trigger}${item.inputPrefix}`);
				this.refresh();
			} else {
				this.folder = item;
				this.load(source, match);
			}
			return;
		}
		const action = source.select(item, match);
		if (action.kind === "invoke") action.onApplied();
		else if (action.kind === "replace") {
			this.replace(match, action.text);
			this.reset();
			this.changed();
		}
	}

	/** Close the menu for this trigger, leaving the text as it is. */
	dismiss(): void {
		if (!this.current) return;
		this.dismissedAt = this.current.match.start;
		this.reset();
		this.changed();
	}

	destroy(): void {
		this.reset();
	}

	private load(source: SuggestSource, match: TriggerMatch): void {
		this.loading?.abort();
		const loading = new AbortController();
		this.loading = loading;
		const folder = this.folder;
		const listed = folder?.load ? folder.load(match.query, loading.signal) : source.load(match, loading.signal);
		const show = (items: readonly SuggestItem[]): void => {
			if (loading.signal.aborted) return;
			this.current = { source, match, items };
			this.changed();
		};
		if ("then" in listed && typeof listed.then === "function") {
			// Rows already on screen stay until the new ones arrive.
			this.current = { source, match, items: this.current?.source === source ? this.current.items : [] };
			listed.then(show, () => show([]));
		} else show(listed as readonly SuggestItem[]);
	}

	/** Put `text` where the match is, as Claudian's controller does — one space between, not two. */
	private replace(match: TriggerMatch, text: string): void {
		const value = this.input.value;
		const duplicateSpace = /\s$/.test(text) && /^\s/.test(value.slice(match.end));
		const end = match.end + (duplicateSpace ? 1 : 0);
		const before = value.slice(0, match.start);
		this.input.value = before + text + value.slice(end);
		const caret = before.length + text.length;
		this.input.setSelectionRange(caret, caret);
	}

	private reset(): void {
		this.loading?.abort();
		this.loading = null;
		this.current = null;
		this.folder = null;
	}
}
