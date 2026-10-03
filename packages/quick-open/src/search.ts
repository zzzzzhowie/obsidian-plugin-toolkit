import {
	type App,
	type HeadingCache,
	parseFrontMatterAliases,
	prepareFuzzySearch,
	type SearchMatches,
	type TFile,
} from "obsidian";

import { displayName, folderOf } from "./files";
import type { FileHistory } from "./history";

/**
 * What Go to File finds for a query — shared by the Cmd/Ctrl+P modal and the search on the
 * empty new tab, so both match, rank and label the same way.
 *
 * - Nothing typed: recently opened files, most recent first.
 * - Typed: fuzzy match on file names (on the whole path once the query has a `/`) and on
 *   notes' aliases. Recently opened matches come first, then the rest of the vault.
 * - `name:42` or `name:42:7` opens at that line (and column); `:42` goes to a line in the
 *   current note; `@` lists the current note's headings — unless `filesOnly`, for a place
 *   with no current note.
 */

export type Item = FileItem | LineItem | HeadingItem;

export interface FileItem {
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

export interface LineItem {
	kind: "line";
	line: number | null;
	column?: number;
}

export interface HeadingItem {
	kind: "heading";
	heading: HeadingCache;
	matches: SearchMatches | null;
}

export const LABEL_RECENT = "recently opened";
export const LABEL_FILES = "file results";

export interface SuggestOptions {
	limit: number;
	/** No `:line` or `@heading`: there is no current note to apply them to. */
	filesOnly?: boolean;
}

export class Search {
	constructor(
		private readonly app: App,
		private readonly history: FileHistory,
	) {}

	suggest(input: string, options: SuggestOptions): Item[] {
		const query = input.trim();
		if (!options.filesOnly) {
			if (query.startsWith("@")) return this.headingItems(query.slice(1).trim());
			if (query.startsWith(":")) return [lineItem(query.slice(1))];
		}

		const at = /^(.*?):(\d+)(?::(\d+))?$/.exec(query);
		const name = (at ? at[1] : query)?.trim() ?? "";
		const line = at?.[2] ? Number(at[2]) : undefined;
		const column = at?.[3] ? Number(at[3]) : undefined;
		if (!name) return this.recentItems(options.limit);
		return this.searchItems(name, options.limit).map((item) => ({ ...item, line, column }));
	}

	private recentItems(limit: number): FileItem[] {
		return this.history
			.files()
			.slice(0, limit)
			.map((file, index) => ({
				kind: "file",
				file,
				recent: true,
				nameMatches: null,
				pathMatches: null,
				label: index === 0 ? LABEL_RECENT : undefined,
			}));
	}

	private searchItems(query: string, limit: number): FileItem[] {
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

		const items = [...recent, ...others].slice(0, limit).map((scored) => scored.item);
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

function lineItem(rest: string): LineItem {
	const at = /^(\d+)(?::(\d+))?/.exec(rest.trim());
	return { kind: "line", line: at?.[1] ? Number(at[1]) : null, column: at?.[2] ? Number(at[2]) : undefined };
}
