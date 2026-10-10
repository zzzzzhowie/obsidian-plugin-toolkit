/**
 * Suggests a code block's language while its opening fence is typed: ```mer → mermaid.
 */

import {
	App,
	Editor,
	EditorPosition,
	EditorSuggest,
	EditorSuggestContext,
	EditorSuggestTriggerInfo,
	prepareFuzzySearch,
} from "obsidian";

/** A fence being opened: its quote/indent prefix, its marks, and the language typed so far. */
const OPENING = /^([ \t]*(?:>[ \t]*)*)(`{3,}|~{3,})([\w+#.-]+)$/;
/** Any fence line: its marks, and its info string if any. */
const FENCE = /^[ \t]*(?:>[ \t]*)*(`{3,}|~{3,})[ \t]*([^\s`]*)/;

/** Other names a language goes by, so `ts` finds typescript and `sh` finds bash. */
const ALIASES: Record<string, string[]> = {
	typescript: ["ts"],
	javascript: ["js"],
	python: ["py"],
	bash: ["sh", "zsh"],
	shell: ["sh", "zsh"],
	yaml: ["yml"],
	markdown: ["md"],
	plain: ["txt", "text"],
	text: ["txt", "plain"],
	cpp: ["c++"],
	csharp: ["cs", "c#"],
	golang: ["go"],
	rust: ["rs"],
	kotlin: ["kt"],
	dockerfile: ["docker"],
};

interface Language {
	name: string;
	/** How many code blocks in the vault use it. */
	uses: number;
}

export interface FenceSuggestOptions {
	/** Languages offered whether or not the vault uses them yet, in their default order. */
	languages: string[];
	/** What a new block of a language starts with, by language. */
	templates: Record<string, string>;
}

/**
 * The language list after ``` (or ~~~), filtered as you type and ordered by how often the
 * vault's own code blocks use each one. Picking one (Enter, Tab or a click) writes it, opens a line inside the block
 * — the block Obsidian's auto-pair already closed, or a closing fence added here — and puts
 * the cursor on it, with the language's template if it has one. Only for an opening fence:
 * the fence that closes a block is left alone. Shown from the first letter, so a plain
 * ``` and Enter still makes a block without a language.
 */
export class FenceSuggest extends EditorSuggest<Language> {
	/** Code blocks per language across the vault, counted on first use. */
	private uses: Map<string, number> | null = null;
	private counting: Promise<void> | null = null;

	constructor(
		app: App,
		private readonly opts: FenceSuggestOptions,
	) {
		super(app);
		this.limit = 30;
		// Tab takes the highlighted language too, as completion does in a code editor.
		this.scope.register([], "Tab", (evt) => {
			(this as unknown as { suggestions?: { useSelectedItem(evt: KeyboardEvent): void } }).suggestions?.useSelectedItem(evt);
			return false;
		});
	}

	onTrigger(cursor: EditorPosition, editor: Editor): EditorSuggestTriggerInfo | null {
		const line = editor.getLine(cursor.line);
		if (line.slice(cursor.ch).trim() !== "") return null;
		const match = OPENING.exec(line.slice(0, cursor.ch));
		if (!match || insideCodeBlock(editor, cursor.line)) return null;
		const query = match[3] ?? "";
		return { start: { line: cursor.line, ch: cursor.ch - query.length }, end: cursor, query };
	}

	getSuggestions(context: EditorSuggestContext): Language[] {
		if (!this.uses) void this.countUses();
		const uses = this.uses ?? new Map<string, number>();
		const names = [...new Set([...this.opts.languages, ...[...uses.keys()].filter((name) => (uses.get(name) ?? 0) >= 2)])];
		const order = new Map(names.map((name, i) => [name, i]));
		const byUse = (a: Language, b: Language): number =>
			b.uses - a.uses || (order.get(a.name) ?? 0) - (order.get(b.name) ?? 0);
		const languages = names.map((name) => ({ name, uses: uses.get(name) ?? 0 }));

		const query = context.query.toLowerCase();
		if (!query) return languages.sort(byUse);
		// Exact (name or other name) first, then those it begins, then fuzzy matches; within
		// each, the much-used ahead — `ja` is javascript before java.
		const fuzzy = prepareFuzzySearch(query);
		const ranked: { language: Language; tier: number; score: number }[] = [];
		for (const language of languages) {
			const names = [language.name, ...(ALIASES[language.name] ?? [])];
			let tier = 3;
			let score = -Infinity;
			for (const name of names) {
				if (name === query) tier = Math.min(tier, 0);
				else if (name.startsWith(query)) tier = Math.min(tier, 1);
				const match = fuzzy(name);
				if (match) {
					tier = Math.min(tier, 2);
					score = Math.max(score, match.score);
				}
			}
			if (tier < 3) ranked.push({ language, tier, score });
		}
		return ranked
			.sort((a, b) => a.tier - b.tier || (a.tier < 2 ? byUse(a.language, b.language) : b.score - a.score || byUse(a.language, b.language)))
			.map(({ language }) => language);
	}

	renderSuggestion(language: Language, el: HTMLElement): void {
		el.addClass("blockier-fence-suggestion");
		el.createSpan({ cls: "blockier-fence-suggestion-name", text: language.name });
		const aliases = ALIASES[language.name];
		if (aliases) el.createSpan({ cls: "blockier-fence-suggestion-alias", text: aliases.join(" · ") });
	}

	selectSuggestion(language: Language): void {
		const context = this.context;
		if (!context) return;
		const { editor, start, end } = context;
		const lineText = editor.getLine(start.line);
		const [, prefix = "", marks = "```"] = OPENING.exec(lineText) ?? [];
		const template = this.opts.templates[language.name] ?? "";
		const inside = prefix + template;
		const closing = closingFenceLine(editor, start.line, marks);

		let text = language.name;
		let cursor: EditorPosition = { line: start.line, ch: start.ch + language.name.length };
		if (closing === null) {
			// Not closed yet: close it, with a line inside for the code.
			text += `\n${inside}\n${prefix}${marks}`;
			cursor = { line: start.line + 1, ch: inside.length };
		} else if (closing === start.line + 1) {
			// Closed right below (Obsidian's auto-pair): open a line between.
			text += `\n${inside}`;
			cursor = { line: start.line + 1, ch: inside.length };
		}
		// Otherwise the block already has code: only its language is written.

		// One transaction for the text and the cursor, so the cursor lands where the edit puts
		// it — on its own, a move into a Mermaid block is turned away (Mermaid (Enhanced)).
		editor.transaction({ changes: [{ from: start, to: end, text }], selection: { from: cursor } });
		this.close();
		this.uses?.set(language.name, (this.uses.get(language.name) ?? 0) + 1);
	}

	/** Count the vault's code blocks by language, reading only notes that have code blocks. */
	private countUses(): Promise<void> {
		this.counting ??= (async () => {
			const uses = new Map<string, number>();
			for (const file of this.app.vault.getMarkdownFiles()) {
				if (!this.app.metadataCache.getFileCache(file)?.sections?.some((s) => s.type === "code")) continue;
				for (const name of fenceLanguages(await this.app.vault.cachedRead(file))) {
					uses.set(name, (uses.get(name) ?? 0) + 1);
				}
			}
			this.uses = uses;
		})().catch(() => {
			this.counting = null;
		});
		return this.counting;
	}
}

/** The languages of a note's code blocks, one per block that names one. */
function fenceLanguages(text: string): string[] {
	const names: string[] = [];
	let open: string | null = null;
	for (const line of text.split("\n")) {
		const fence = FENCE.exec(line);
		if (!fence) continue;
		const marks = fence[1] ?? "";
		const info = fence[2] ?? "";
		if (open === null) {
			open = marks;
			if (info) names.push(info.toLowerCase());
		} else if (closes(marks, info, open)) {
			open = null;
		}
	}
	return names;
}

/** Whether a fence line with these marks and info string closes a block opened with `open`. */
function closes(marks: string, info: string, open: string): boolean {
	return !info && marks[0] === open[0] && marks.length >= open.length;
}

/** Whether line `lineNo` sits inside a code block opened above it. */
function insideCodeBlock(editor: Editor, lineNo: number): boolean {
	let open: string | null = null;
	for (let n = 0; n < lineNo; n++) {
		const fence = FENCE.exec(editor.getLine(n));
		if (!fence) continue;
		const marks = fence[1] ?? "";
		if (open === null) open = marks;
		else if (closes(marks, fence[2] ?? "", open)) open = null;
	}
	return open !== null;
}

/**
 * The line of the fence closing the block opened on `lineNo`, or null when it isn't closed:
 * the first fence below decides — one that can close it does, another opening fence (or none
 * at all) means this block was left open.
 */
function closingFenceLine(editor: Editor, lineNo: number, marks: string): number | null {
	for (let n = lineNo + 1; n < editor.lineCount(); n++) {
		const fence = FENCE.exec(editor.getLine(n));
		if (!fence) continue;
		return closes(fence[1] ?? "", fence[2] ?? "", marks) ? n : null;
	}
	return null;
}
